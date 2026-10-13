import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App.jsx';

const realtime = vi.hoisted(() => ({ useWorkspaceRealtime: vi.fn(() => 'disconnected') }));
vi.mock('./useWorkspaceRealtime.js', () => realtime);

const ids = {
  workspace: '11111111-1111-4111-8111-111111111111',
  project: '22222222-2222-4222-8222-222222222222',
  owner: '33333333-3333-4333-8333-333333333333',
  member: '44444444-4444-4444-8444-444444444444',
  task: '55555555-5555-4555-8555-555555555555',
};

function reply(status, body = null) {
  return { status, ok: status >= 200 && status < 300, headers: { get: () => 'application/json' }, json: async () => body };
}

function installBackend() {
  const state = {
    authenticated: false,
    workspaces: [],
    members: [{ user_id: ids.owner, email: 'owner@example.com', display_name: 'Owner', role: 'owner' }],
    projects: [], tasks: [], comments: [], files: [],
  };
  const fetchMock = vi.fn(async (url, options = {}) => {
    const path = String(url); const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : null;
    if (path === '/api/auth/me') return state.authenticated ? reply(200, { user: { id: ids.owner, email: 'owner@example.com', displayName: 'Owner' } }) : reply(401, { error: 'Authentication required.' });
    if (path === '/api/auth/login' && method === 'POST') { state.authenticated = true; return reply(200, { user: { id: ids.owner, email: 'owner@example.com', displayName: 'Owner' } }); }
    if (path === '/api/auth/logout' && method === 'POST') { state.authenticated = false; return reply(204); }
    if (!state.authenticated) return reply(401, { error: 'Authentication required.' });
    if (path === '/api/workspaces' && method === 'GET') return reply(200, { workspaces: state.workspaces });
    if (path === '/api/workspaces' && method === 'POST') {
      const workspace = { id: ids.workspace, name: body.name, role: 'owner' }; state.workspaces = [workspace];
      return reply(201, { workspace });
    }
    if (path === `/api/workspaces/${ids.workspace}` && method === 'GET') return reply(200, { workspace: { ...state.workspaces[0], createdAt: '2026-01-01', role: 'owner' } });
    if (path === `/api/workspaces/${ids.workspace}/members` && method === 'GET') return reply(200, { members: state.members });
    if (path === `/api/workspaces/${ids.workspace}/members` && method === 'POST') {
      fetchMock.memberBody = body;
      state.members.push({ user_id: ids.member, email: body.email.toLowerCase(), display_name: 'Member', role: body.role });
      return reply(201, { member: state.members.at(-1) });
    }
    if (path === `/api/workspaces/${ids.workspace}/projects` && method === 'GET') return reply(200, { projects: state.projects });
    if (path === `/api/workspaces/${ids.workspace}/projects` && method === 'POST') {
      const project = { id: ids.project, workspaceId: ids.workspace, name: body.name, description: body.description };
      state.projects.push(project); return reply(201, { project });
    }
    if (path === `/api/workspaces/${ids.workspace}/projects/${ids.project}` && method === 'GET') return reply(200, { project: state.projects[0] });
    if (path === `/api/workspaces/${ids.workspace}/projects/${ids.project}/tasks` && method === 'GET') { fetchMock.taskList = [...state.tasks]; return reply(200, { tasks: state.tasks }); }
    if (path === `/api/workspaces/${ids.workspace}/projects/${ids.project}/tasks` && method === 'POST') {
      const task = { id: ids.task, projectId: ids.project, workspaceId: ids.workspace, version: 1, ...body };
      state.tasks.push(task); fetchMock.taskBody = body; return reply(201, { task });
    }
    if (path.includes('/activity?')) return reply(200, { events: [] });
    if (path.includes('/comments')) {
      if (method === 'GET') return reply(200, { comments: state.comments });
      if (method === 'POST') {
        const comment = { id: `comment-${state.comments.length + 1}`, authorId: ids.owner, version: 1, createdAt: '2026-01-01T00:00:00.000Z', content: body.content };
        state.comments.push(comment); return reply(201, { comment });
      }
    }
    if (path.includes('/files') && method === 'GET') return reply(200, { files: state.files });
    return reply(404, { error: 'Not found' });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState({}, '', '/'); });

describe('TeamVault browser workflows', () => {
  it('protects application navigation and lets a user log in and out', async () => {
    const user = userEvent.setup(); installBackend(); window.history.pushState({}, '', '/app');
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Email'), 'owner@example.com');
    await user.type(screen.getByLabelText('Password'), 'password that is long enough');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { name: 'Overview' })).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'Sign out' })[0]);
    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
  });

  it('creates a workspace and calls the existing membership, project, and task APIs', async () => {
    const user = userEvent.setup(); const fetchMock = installBackend(); window.history.pushState({}, '', '/login');
    render(<App />);
    await user.type(await screen.findByLabelText('Email'), 'owner@example.com');
    await user.type(screen.getByLabelText('Password'), 'password that is long enough');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByRole('heading', { name: 'Overview' });
    await user.type(screen.getByLabelText('Workspace name'), 'Design team');
    await user.click(screen.getByRole('button', { name: 'Create workspace' }));
    const workspaceLinks = await screen.findAllByRole('link', { name: /Design team/ });
    const workspaceLink = workspaceLinks.find((link) => link.classList.contains('workspace-card'));
    await user.click(workspaceLink);
    await screen.findByRole('heading', { name: 'Design team' });
    await waitFor(() => expect(realtime.useWorkspaceRealtime).toHaveBeenLastCalledWith(ids.workspace, expect.any(Function)));

    await user.type(screen.getByLabelText('Member email'), 'new.person@example.com');
    await user.selectOptions(screen.getByLabelText('Role'), 'admin');
    await user.click(screen.getByRole('button', { name: 'Add member' }));
    expect(await screen.findByText('new.person@example.com')).toBeInTheDocument();
    expect(fetchMock.memberBody).toEqual({ email: 'new.person@example.com', role: 'admin' });

    await user.type(screen.getByLabelText('Project name'), 'Website launch');
    await user.type(screen.getByLabelText('Description (optional)'), 'Deliver the public site');
    await user.click(screen.getByRole('button', { name: 'Create project' }));
    const projectLink = await screen.findByRole('link', { name: /Website launch/ });
    await user.click(projectLink);
    await screen.findByRole('heading', { name: 'Website launch' });
    await user.type(screen.getByLabelText('Title'), 'Build the landing page');
    await user.selectOptions(screen.getByLabelText('Status'), 'in_progress');
    await user.selectOptions(screen.getByLabelText('Priority'), 'high');
    await user.selectOptions(screen.getByLabelText('Assignee'), ids.member);
    await act(async () => {
      await user.click(screen.getByRole('button', { name: 'Create task' }));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`/api/workspaces/${ids.workspace}/projects/${ids.project}/tasks`, expect.objectContaining({ method: 'POST' })));
    });
    expect(fetchMock.taskBody).toMatchObject({ title: 'Build the landing page', status: 'in_progress', priority: 'high', assigneeId: ids.member });
    await waitFor(() => expect(fetchMock.taskList).toHaveLength(1));
    expect(fetchMock.taskList[0]).toMatchObject({ title: 'Build the landing page', status: 'in_progress', priority: 'high' });
  });
});
