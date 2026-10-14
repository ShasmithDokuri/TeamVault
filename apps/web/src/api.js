export const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '');

export class ApiError extends Error {
  constructor(message, status, details = {}) { super(message); this.name = 'ApiError'; this.status = status; Object.assign(this, details); }
}

export async function apiRequest(path, { method = 'GET', body, browserSession = false, headers = {} } = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
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

async function fileRequest(path, options = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, { credentials: 'include', ...options });
  if (response.status === 401 && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('teamvault:session-expired'));
  }
  if (!response.ok) {
    const result = response.headers.get('content-type')?.includes('application/json')
      ? await response.json() : null;
    throw new ApiError(result?.error || `Request failed (${response.status}).`, response.status, { fileId: result?.fileId });
  }
  return response;
}

const json = (method, body) => ({ method, body });
const workspacePath = (workspaceId) => `/api/workspaces/${encodeURIComponent(workspaceId)}`;

export const api = Object.freeze({
  auth: Object.freeze({
    me: () => apiRequest('/api/auth/me'),
    login: (body) => apiRequest('/api/auth/login', { ...json('POST', body), browserSession: true }),
    register: (body) => apiRequest('/api/auth/register', { ...json('POST', body), browserSession: true }),
    logout: () => apiRequest('/api/auth/logout', { method: 'POST' }),
    realtimeTicket: () => apiRequest('/api/auth/realtime-ticket', { method: 'POST' }),
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
    comments: (workspaceId, projectId, taskId = null) => apiRequest(
      `${workspacePath(workspaceId)}/projects/${encodeURIComponent(projectId)}${taskId ? `/tasks/${encodeURIComponent(taskId)}` : ''}/comments`,
    ),
    createComment: (workspaceId, projectId, content, taskId = null) => apiRequest(
      `${workspacePath(workspaceId)}/projects/${encodeURIComponent(projectId)}${taskId ? `/tasks/${encodeURIComponent(taskId)}` : ''}/comments`,
      json('POST', { content }),
    ),
    updateComment: (workspaceId, projectId, commentId, body, taskId = null) => apiRequest(
      `${workspacePath(workspaceId)}/projects/${encodeURIComponent(projectId)}${taskId ? `/tasks/${encodeURIComponent(taskId)}` : ''}/comments/${encodeURIComponent(commentId)}`,
      json('PATCH', body),
    ),
    removeComment: (workspaceId, projectId, commentId, taskId = null) => apiRequest(
      `${workspacePath(workspaceId)}/projects/${encodeURIComponent(projectId)}${taskId ? `/tasks/${encodeURIComponent(taskId)}` : ''}/comments/${encodeURIComponent(commentId)}`,
      { method: 'DELETE' },
    ),
  }),
  activity: Object.freeze({
    list: (workspaceId, { limit = 50, before } = {}) => {
      const query = new URLSearchParams({ limit: String(limit) });
      if (before !== undefined) query.set('before', String(before));
      return apiRequest(`${workspacePath(workspaceId)}/activity?${query}`);
    },
  }),
  files: Object.freeze({
    list: (workspaceId, projectId, taskId = null) => apiRequest(
      `${workspacePath(workspaceId)}/projects/${encodeURIComponent(projectId)}${taskId ? `/tasks/${encodeURIComponent(taskId)}` : ''}/files`,
    ),
    upload: async (workspaceId, projectId, file, taskId = null) => {
      const path = `${workspacePath(workspaceId)}/projects/${encodeURIComponent(projectId)}${taskId ? `/tasks/${encodeURIComponent(taskId)}` : ''}/files`;
      const response = await fileRequest(path, {
        method: 'POST', body: file,
        headers: { 'Content-Type': file.type, 'X-File-Name': encodeURIComponent(file.name), 'X-File-Name-Encoding': 'percent-utf8' },
      });
      return response.json();
    },
    retry: async (workspaceId, projectId, fileId, file, taskId = null) => {
      const path = `${workspacePath(workspaceId)}/projects/${encodeURIComponent(projectId)}${taskId ? `/tasks/${encodeURIComponent(taskId)}` : ''}/files/${encodeURIComponent(fileId)}/content`;
      const response = await fileRequest(path, {
        method: 'PUT', body: file,
        headers: { 'Content-Type': file.type, 'X-File-Name': encodeURIComponent(file.name), 'X-File-Name-Encoding': 'percent-utf8' },
      });
      return response.json();
    },
    download: async (workspaceId, projectId, fileId, taskId = null) => {
      const path = `${workspacePath(workspaceId)}/projects/${encodeURIComponent(projectId)}${taskId ? `/tasks/${encodeURIComponent(taskId)}` : ''}/files/${encodeURIComponent(fileId)}`;
      const response = await fileRequest(path, { headers: { Accept: 'application/octet-stream' } });
      return { blob: await response.blob(), name: parseDownloadName(response.headers.get('content-disposition')) };
    },
    remove: (workspaceId, projectId, fileId, taskId = null) => apiRequest(
      `${workspacePath(workspaceId)}/projects/${encodeURIComponent(projectId)}${taskId ? `/tasks/${encodeURIComponent(taskId)}` : ''}/files/${encodeURIComponent(fileId)}`,
      { method: 'DELETE' },
    ),
  }),
});

function parseDownloadName(disposition = '') {
  const match = /filename\*=UTF-8''([^;]+)/iu.exec(disposition);
  if (!match) return 'download';
  try { return decodeURIComponent(match[1]); } catch { return 'download'; }
}
