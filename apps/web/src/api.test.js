import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api.js';

afterEach(() => vi.unstubAllGlobals());

describe('browser API client', () => {
  it('uses same-origin credentials and asks the API for an HttpOnly cookie session', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200, ok: true, headers: { get: () => 'application/json' },
      json: async () => ({ user: { id: 'u-1' }, expiresAt: '2030-01-01T00:15:00Z' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    await api.auth.login({ email: 'person@example.com', password: 'long password' });
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/auth/login');
    expect(options.credentials).toBe('same-origin');
    expect(options.headers['X-TeamVault-Auth-Mode']).toBe('cookie');
    expect(options.headers.Authorization).toBeUndefined();
    expect(options.body).toBe(JSON.stringify({ email: 'person@example.com', password: 'long password' }));
  });

  it('signals the auth context when an established browser session is expired', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 401, ok: false, headers: { get: () => 'application/json' },
      json: async () => ({ error: 'Authentication required.' }),
    });
    const expired = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    window.addEventListener('teamvault:session-expired', expired);
    await expect(api.workspaces.list()).rejects.toMatchObject({ status: 401 });
    expect(expired).toHaveBeenCalledTimes(1);
    window.removeEventListener('teamvault:session-expired', expired);
  });
});
