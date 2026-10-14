import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ io: vi.fn(), realtimeTicket: vi.fn() }));
vi.mock('socket.io-client', () => ({ io: mocks.io }));
vi.mock('./api.js', () => ({
  API_BASE_URL: '',
  api: { auth: { realtimeTicket: mocks.realtimeTicket } },
}));
import { useWorkspaceRealtime } from './useWorkspaceRealtime.js';

describe('workspace realtime browser connection', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

  it('uses a short-lived ticket and an Origin-bearing WebSocket handshake, then subscribes to the authorized workspace', async () => {
    const workspaceId = '11111111-1111-4111-8111-111111111111';
    const changed = vi.fn();
    const handlers = new Map();
    const socket = {
      on: vi.fn((event, callback) => { handlers.set(event, callback); }),
      emit: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
      removeAllListeners: vi.fn(),
    };
    mocks.realtimeTicket.mockResolvedValue({ ticket: 't'.repeat(43) });
    mocks.io.mockReturnValue(socket);

    const { result, unmount } = renderHook(() => useWorkspaceRealtime(workspaceId, changed));
    await waitFor(() => expect(mocks.io).toHaveBeenCalledTimes(1));
    const [url, options] = mocks.io.mock.calls[0];
    expect(url).toBe(window.location.origin);
    expect(options).toMatchObject({
      path: '/socket.io',
      transports: ['websocket'],
      auth: { ticket: 't'.repeat(43) },
      autoConnect: false,
      reconnection: false,
    });
    expect(mocks.realtimeTicket).toHaveBeenCalledTimes(1);
    expect(socket.connect).toHaveBeenCalledTimes(1);

    act(() => handlers.get('connect')());
    expect(result.current).toBe('connected');
    expect(socket.emit).toHaveBeenCalledWith('workspace:subscribe', { workspaceId }, expect.any(Function));
    act(() => handlers.get('workspace:event')({ workspaceId, resourceType: 'task', action: 'updated' }));
    expect(changed).toHaveBeenCalledTimes(1);

    unmount();
    expect(socket.disconnect).toHaveBeenCalledTimes(1);
  });
});
