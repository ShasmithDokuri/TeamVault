export class ApiError extends Error {
  constructor(message, status) { super(message); this.name = 'ApiError'; this.status = status; }
}

export async function apiRequest(path, { method = 'GET', body, browserSession = false, headers = {} } = {}) {
  const response = await fetch(path, {
    method, credentials: 'same-origin',
    headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(browserSession ? { 'X-TeamVault-Auth-Mode': 'cookie' } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.status === 204) return null;
  const result = response.headers.get('content-type')?.includes('application/json') ? await response.json() : null;
  if (!response.ok) {
    if (response.status === 401 && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('teamvault:session-expired'));
    }
    throw new ApiError(result?.error || `Request failed (${response.status}).`, response.status);
  }
  return result;
}

const json = (method, body) => ({ method, body });
const workspacePath = (workspaceId) => `/api/workspaces/${encodeURIComponent(workspaceId)}`;

export const api = Object.freeze({
  auth: Object.freeze({
    me: () => apiRequest('/api/auth/me'),
    login: (body) => apiRequest('/api/auth/login', { ...json('POST', body), browserSession: true }),
    register: (body) => apiRequest('/api/auth/register', { ...json('POST', body), browserSession: true }),
    logout: () => apiRequest('/api/auth/logout', { method: 'POST' }),
  }),
  workspaces: Object.freeze({
    list: () => apiRequest('/api/workspaces'), create: (body) => apiRequest('/api/workspaces', json('POST', body)),
    get: (id) => apiRequest(workspacePath(id)), rename: (id, body) => apiRequest(workspacePath(id), json('PATCH', body)),
    remove: (id) => apiRequest(workspacePath(id), { method: 'DELETE' }),
    members: (id) => apiRequest(`${workspacePath(id)}/members`),
    addMember: (id, body) => apiRequest(`${workspacePath(id)}/members`, json('POST', body)),
    updateMember: (id, userId, body) => apiRequest(`${workspacePath(id)}/members/${encodeURIComponent(userId)}`, json('PATCH', body)),
    removeMember: (id, userId) => apiRequest(`${workspacePath(id)}/members/${encodeURIComponent(userId)}`, { method: 'DELETE' }),
  }),
  projects: Object.freeze({
    list: (workspaceId) => apiRequest(`${workspacePath(workspaceId)}/projects`),
    create: (workspaceId, body) => apiRequest(`${workspacePath(workspaceId)}/projects`, json('POST', body)),
    get: (workspaceId, projectId) => apiRequest(`${workspacePath(workspaceId)}/projects/${encodeURIComponent(projectId)}`),
    update: (workspaceId, projectId, body) => apiRequest(`${workspacePath(workspaceId)}/projects/${encodeURIComponent(projectId)}`, json('PATCH', body)),
    remove: (workspaceId, projectId) => apiRequest(`${workspacePath(workspaceId)}/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' }),
    tasks: (workspaceId, projectId) => apiRequest(`${workspacePath(workspaceId)}/projects/${encodeURIComponent(projectId)}/tasks`),
    createTask: (workspaceId, projectId, body) => apiRequest(`${workspacePath(workspaceId)}/projects/${encodeURIComponent(projectId)}/tasks`, json('POST', body)),
    updateTask: (workspaceId, projectId, taskId, body) => apiRequest(`${workspacePath(workspaceId)}/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`, json('PATCH', body)),
    removeTask: (workspaceId, projectId, taskId) => apiRequest(`${workspacePath(workspaceId)}/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`, { method: 'DELETE' }),
  }),
});
