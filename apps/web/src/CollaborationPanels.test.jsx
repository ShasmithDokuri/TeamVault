import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const apiMocks = vi.hoisted(() => ({ listFiles: vi.fn() }));
vi.mock('./api.js', () => ({
  api: { files: { list: apiMocks.listFiles } },
}));

import { FilePanel } from './CollaborationPanels.jsx';

describe('file collaboration panel', () => {
  it('offers downloads for files returned by the available-files list contract', async () => {
    apiMocks.listFiles.mockResolvedValue({ files: [{
      id: 'file-1', originalName: 'private-report.pdf', sizeBytes: 1024, uploadedBy: 'user-1',
    }] });

    render(<FilePanel
      workspaceId="workspace-1"
      projectId="project-1"
      user={{ id: 'user-1' }}
    />);

    expect(await screen.findByRole('button', { name: 'Download' })).toBeInTheDocument();
    expect(screen.getByText('1.0 KiB')).toBeInTheDocument();
  });
});
