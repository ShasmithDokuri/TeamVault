import { useCallback, useEffect, useState } from 'react';
import { BrowserRouter, Link, Navigate, Outlet, Route, Routes, useLocation, useNavigate, useOutletContext, useParams } from 'react-router-dom';
import { AuthProvider, useAuth } from './AuthContext.jsx';
import { api } from './api.js';
import { ActivityFeed, CommentPanel, FilePanel } from './CollaborationPanels.jsx';
import { useWorkspaceRealtime } from './useWorkspaceRealtime.js';

export default function App() { return <AuthProvider><BrowserRouter><AppRoutes /></BrowserRouter></AuthProvider>; }

function AppRoutes() {
  const auth = useAuth();
  return <Routes>
    <Route path="/login" element={<GuestRoute><AuthPage mode="login" /></GuestRoute>} />
    <Route path="/register" element={<GuestRoute><AuthPage mode="register" /></GuestRoute>} />
    <Route path="/app" element={<ProtectedRoute auth={auth}><AppShell /></ProtectedRoute>}>
      <Route index element={<Dashboard />} />
      <Route path="workspaces/:workspaceId" element={<WorkspacePage />} />
      <Route path="workspaces/:workspaceId/projects/:projectId" element={<ProjectPage />} />
    </Route>
    <Route path="*" element={<Navigate to={auth.status === 'authenticated' ? '/app' : '/login'} replace />} />
  </Routes>;
}

function ProtectedRoute({ auth, children }) {
  const location = useLocation();
  if (auth.status === 'checking') return <CenteredState>Checking your session…</CenteredState>;
  if (auth.status === 'error') return <CenteredState><Notice role="alert">{auth.error}</Notice></CenteredState>;
  return auth.status === 'authenticated' ? children : <Navigate to="/login" state={{ from: location.pathname }} replace />;
}

function GuestRoute({ children }) {
  const { status } = useAuth();
  if (status === 'checking') return <CenteredState>Checking your session…</CenteredState>;
  return status === 'authenticated' ? <Navigate to="/app" replace /> : children;
}

function AuthPage({ mode }) {
  const { login, register } = useAuth(); const navigate = useNavigate(); const location = useLocation();
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const registering = mode === 'register';
  async function submit(event) {
    event.preventDefault(); setError(''); setBusy(true);
    const form = new FormData(event.currentTarget);
    const credentials = { email: String(form.get('email') || '').trim(), password: String(form.get('password') || ''), ...(registering ? { displayName: String(form.get('displayName') || '').trim() } : {}) };
    try { if (registering) await register(credentials); else await login(credentials); navigate(location.state?.from || '/app', { replace: true }); }
    catch (cause) { setError(cause.message || 'Unable to sign in. Please try again.'); }
    finally { setBusy(false); }
  }
  return <main className="auth-layout"><section className="auth-card" aria-labelledby="auth-title">
    <Link className="brand" to="/login"><span className="brand-icon">TV</span>TeamVault</Link>
    <p className="eyebrow">Your team, in one place</p><h1 id="auth-title">{registering ? 'Create your account' : 'Welcome back'}</h1>
    <p className="muted">{registering ? 'Start a workspace and bring your projects together.' : 'Sign in to continue to your workspace.'}</p>
    <form onSubmit={submit} className="form-stack">
      {registering && <Field label="Name" name="displayName" autoComplete="name" maxLength={100} />}
      <Field label="Email" name="email" type="email" autoComplete="email" required maxLength={254} />
      <Field label="Password" name="password" type="password" autoComplete={registering ? 'new-password' : 'current-password'} required minLength={registering ? 12 : 1} maxLength={128} />
      {error && <Notice role="alert">{error}</Notice>}
      <button className="button primary wide" disabled={busy}>{busy ? 'Please wait…' : registering ? 'Create account' : 'Sign in'}</button>
    </form>
    <p className="switch-auth">{registering ? 'Already have an account?' : 'New to TeamVault?'} <Link to={registering ? '/login' : '/register'}>{registering ? 'Sign in' : 'Create an account'}</Link></p>
    <p className="microcopy">Your session uses a short-lived, protected browser cookie.</p>
  </section></main>;
}

function AppShell() {
  const { user, logout } = useAuth(); const { pathname } = useLocation();
  const workspaceId = pathname.match(/^\/app\/workspaces\/([0-9a-f-]{36})(?:\/|$)/iu)?.[1];
  const [workspaces, setWorkspaces] = useState([]); const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [refreshKey, setRefreshKey] = useState(0); const [resourceRefreshKey, setResourceRefreshKey] = useState(0); const navigate = useNavigate();
  const onResourceChanged = useCallback(() => setResourceRefreshKey((value) => value + 1), []);
  const realtimeStatus = useWorkspaceRealtime(workspaceId, onResourceChanged);
  useEffect(() => { let active = true; api.workspaces.list().then(({ workspaces: rows }) => { if (active) { setWorkspaces(rows); setError(''); } }).catch((cause) => { if (active) setError(cause.message); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, [refreshKey]);
  async function signOut() { try { await logout(); } finally { navigate('/login', { replace: true }); } }
  const refreshWorkspaces = () => setRefreshKey((value) => value + 1);
  return <div className="app-frame"><aside className="sidebar">
    <Link className="brand sidebar-brand" to="/app"><span className="brand-icon">TV</span>TeamVault</Link>
    <nav aria-label="Main navigation" className="side-nav"><Link className="nav-link" to="/app"><span aria-hidden="true">⌂</span> Overview</Link><div className="nav-heading">WORKSPACES</div>
      {loading && <span className="nav-muted">Loading…</span>}{!loading && workspaces.map((workspace) => <Link className="nav-link workspace-link" key={workspace.id} to={`/app/workspaces/${workspace.id}`}><span className="workspace-avatar">{workspace.name.slice(0, 1).toUpperCase()}</span><span className="truncate">{workspace.name}</span></Link>)}{!loading && !workspaces.length && <span className="nav-muted">No workspaces yet</span>}
    </nav>
    <div className="sidebar-footer"><span className="avatar">{initials(user.displayName || user.email)}</span><span className="user-label"><strong>{user.displayName || user.email.split('@')[0]}</strong><small>{user.email}</small></span><button className="icon-button" aria-label="Sign out" title="Sign out" onClick={signOut}>↗</button></div>
  </aside><main className="main-panel"><header className="topbar"><div><span className="topbar-label">TEAMVAULT</span><span className="topbar-caption">Workspace collaboration</span></div><button className="button secondary small" onClick={signOut}>Sign out</button></header><section className="content-area">{error && <Notice role="alert">{error}</Notice>}<Outlet context={{ workspaces, refreshWorkspaces, resourceRefreshKey, realtimeStatus }} /></section></main></div>;
}

function Dashboard() {
  const { workspaces, refreshWorkspaces } = useOutletContext(); const [name, setName] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  async function createWorkspace(event) { event.preventDefault(); setBusy(true); setError(''); try { await api.workspaces.create({ name }); setName(''); refreshWorkspaces(); } catch (cause) { setError(cause.message); } finally { setBusy(false); } }
  return <><PageHeading eyebrow="YOUR TEAM SPACE" title="Overview" description="Choose a workspace to see its projects and tasks, or create a new one." />
    <section className="section-card"><div className="section-header"><div><h2>Your workspaces</h2><p className="muted">Each workspace has its own members, roles, projects, and tasks.</p></div><span className="count-pill">{workspaces.length}</span></div>
      {workspaces.length ? <div className="workspace-grid">{workspaces.map((workspace) => <Link className="workspace-card" key={workspace.id} to={`/app/workspaces/${workspace.id}`}><span className="workspace-avatar large">{workspace.name.slice(0, 1).toUpperCase()}</span><div className="workspace-card-copy"><strong>{workspace.name}</strong><small>{workspace.role}</small></div><span className="card-arrow" aria-hidden="true">→</span></Link>)}</div> : <EmptyState title="Your first workspace starts here" text="Create a private space for a team, project, or initiative." />}
    </section>
    <section className="section-card create-card"><div><h2>Create a workspace</h2><p className="muted">You will be its owner and can manage members and roles.</p></div><form className="inline-form" onSubmit={createWorkspace}><Field label="Workspace name" name="workspaceName" value={name} onChange={(event) => setName(event.target.value)} maxLength={100} required placeholder="e.g. Product team" /><button className="button primary" disabled={busy || !name.trim()}>{busy ? 'Creating…' : 'Create workspace'}</button></form>{error && <Notice role="alert">{error}</Notice>}</section>
  </>;
}

function WorkspacePage() {
  const { workspaceId } = useParams(); const { refreshWorkspaces, resourceRefreshKey, realtimeStatus } = useOutletContext();
  const [workspace, setWorkspace] = useState(null); const [members, setMembers] = useState([]); const [projects, setProjects] = useState([]); const [loading, setLoading] = useState(true); const [error, setError] = useState('');
  async function reload() { const [w, m, p] = await Promise.all([api.workspaces.get(workspaceId), api.workspaces.members(workspaceId), api.projects.list(workspaceId)]); setWorkspace(w.workspace); setMembers(m.members); setProjects(p.projects); }
  useEffect(() => { let active = true; Promise.all([api.workspaces.get(workspaceId), api.workspaces.members(workspaceId), api.projects.list(workspaceId)]).then(([w,m,p]) => { if (active) { setWorkspace(w.workspace); setMembers(m.members); setProjects(p.projects); } }).catch((cause) => { if (active) setError(cause.message); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, [workspaceId, resourceRefreshKey]);
  async function action(work) { setError(''); try { const value = await work(); await reload(); refreshWorkspaces(); return value; } catch (cause) { setError(cause.message); throw cause; } }
  if (loading) return <CenteredState>Loading workspace…</CenteredState>;
  if (!workspace) return <><PageHeading eyebrow="WORKSPACE" title="Workspace unavailable" description={error || 'You may not have access to this workspace.'} /><Link className="button secondary" to="/app">Back to overview</Link></>;
  const manager = ['owner', 'admin'].includes(workspace.role); const owner = workspace.role === 'owner';
  return <><RealtimeStatus status={realtimeStatus} /><PageHeading eyebrow={`WORKSPACE · ${workspace.role.toUpperCase()}`} title={workspace.name} description="Manage this workspace’s members, projects, and shared work." />{error && <Notice role="alert">{error}</Notice>}
    <section className="section-card"><div className="section-header"><div><h2>Projects</h2><p className="muted">Tasks and project details are visible to workspace members.</p></div><span className="count-pill">{projects.length}</span></div>
      {projects.length ? <div className="project-grid">{projects.map((project) => <Link key={project.id} className="project-card" to={`/app/workspaces/${workspaceId}/projects/${project.id}`}><span className="project-icon">▦</span><strong>{project.name}</strong><p>{project.description || 'A shared project workspace.'}</p><span className="project-open">Open project →</span></Link>)}</div> : <EmptyState title="No projects yet" text="Create the first project to start organizing work." />}
      {manager && <ProjectCreate workspaceId={workspaceId} onCreated={reload} />}
    </section>
    <section className="section-card"><div className="section-header"><div><h2>Members</h2><p className="muted">Owner, admin, and member access is enforced by the API.</p></div><span className="count-pill">{members.length}</span></div>
      <MemberList members={members} workspaceId={workspaceId} requesterRole={workspace.role} onChange={action} />{manager && <MemberCreate workspaceId={workspaceId} requesterRole={workspace.role} onCreated={reload} />}
    </section>
    {manager && <WorkspaceSettings workspace={workspace} owner={owner} onChange={action} onDeleted={refreshWorkspaces} />}
    <ActivityFeed workspaceId={workspaceId} refreshKey={resourceRefreshKey} />
  </>;
}

function ProjectCreate({ workspaceId, onCreated }) {
  const [name, setName] = useState(''); const [description, setDescription] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  async function submit(event) { event.preventDefault(); setBusy(true); setError(''); try { await api.projects.create(workspaceId, { name, description: description || null }); setName(''); setDescription(''); await onCreated(); } catch (cause) { setError(cause.message); } finally { setBusy(false); } }
  return <form className="create-subform" onSubmit={submit}><h3>New project</h3><div className="form-row"><Field label="Project name" name="projectName" value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} /><Field label="Description (optional)" name="projectDescription" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} /></div>{error && <Notice role="alert">{error}</Notice>}<button className="button primary" disabled={busy || !name.trim()}>{busy ? 'Creating…' : 'Create project'}</button></form>;
}

function MemberCreate({ workspaceId, requesterRole, onCreated }) {
  const [email, setEmail] = useState(''); const [role, setRole] = useState('member'); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  async function submit(event) { event.preventDefault(); setBusy(true); setError(''); try { await api.workspaces.addMember(workspaceId, { email, role }); setEmail(''); setRole('member'); await onCreated(); } catch (cause) { setError(cause.status === 404 ? 'User not found, or you do not have permission to add them.' : cause.message); } finally { setBusy(false); } }
  return <form className="create-subform" onSubmit={submit}><h3>Add a registered user</h3><p className="microcopy">The person must already have a TeamVault account. No invitation email is sent.</p><div className="form-row"><Field label="Member email" name="memberEmail" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required maxLength={254} /><label className="field"><span>Role</span><select value={role} onChange={(e) => setRole(e.target.value)}><option value="member">Member</option>{requesterRole === 'owner' && <option value="admin">Admin</option>}</select></label></div>{error && <Notice role="alert">{error}</Notice>}<button className="button secondary" disabled={busy || !email.trim()}>{busy ? 'Adding…' : 'Add member'}</button></form>;
}

function MemberList({ members, workspaceId, requesterRole, onChange }) {
  return <div className="member-list">{members.map((member) => {
    const mayManage = requesterRole === 'owner' ? member.role !== 'owner' : requesterRole === 'admin' && member.role === 'member';
    return <div className="member-row" key={member.user_id}><span className="avatar">{initials(member.display_name || member.email)}</span><span className="member-info"><strong>{member.display_name || member.email.split('@')[0]}</strong><small>{member.email}</small></span><span className={`role-badge role-${member.role}`}>{member.role}</span><div className="member-actions">{mayManage && requesterRole === 'owner' && <label className="sr-only" htmlFor={`role-${member.user_id}`}>Change role for {member.email}</label>}{mayManage && requesterRole === 'owner' && <select id={`role-${member.user_id}`} aria-label={`Role for ${member.email}`} value={member.role} onChange={(e) => onChange(() => api.workspaces.updateMember(workspaceId, member.user_id, { role: e.target.value }))}><option value="member">Member</option><option value="admin">Admin</option></select>}{mayManage && <button className="button danger subtle small" onClick={() => onChange(() => api.workspaces.removeMember(workspaceId, member.user_id))}>Remove</button>}</div></div>;
  })}</div>;
}

function WorkspaceSettings({ workspace, owner, onChange, onDeleted }) {
  const [name, setName] = useState(workspace.name); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const navigate = useNavigate();
  async function rename(event) { event.preventDefault(); setBusy(true); setError(''); try { await onChange(() => api.workspaces.rename(workspace.id, { name })); } catch (cause) { setError(cause.message); } finally { setBusy(false); } }
  async function remove() { if (!window.confirm('Delete this workspace? This cannot be undone.')) return; setError(''); try { await api.workspaces.remove(workspace.id); onDeleted(); navigate('/app'); } catch (cause) { setError(cause.message); } }
  return <section className="section-card settings-card"><div><h2>Workspace settings</h2><p className="muted">Only owners and admins can rename this workspace.</p></div><form className="inline-form" onSubmit={rename}><Field label="Workspace name" name="renameWorkspace" value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} /><button className="button secondary" disabled={busy || name.trim() === workspace.name}>{busy ? 'Saving…' : 'Save name'}</button></form>{owner && <div className="danger-zone"><div><strong>Delete workspace</strong><small>Deletion may be blocked while files or owned resources remain.</small></div><button className="button danger" onClick={remove}>Delete workspace</button></div>}{error && <Notice role="alert">{error}</Notice>}</section>;
}

function ProjectPage() {
  const { workspaceId, projectId } = useParams(); const { workspaces, resourceRefreshKey, realtimeStatus } = useOutletContext(); const { user } = useAuth(); const workspace = workspaces.find((item) => item.id === workspaceId);
  const [project, setProject] = useState(null); const [tasks, setTasks] = useState([]); const [members, setMembers] = useState([]); const [loading, setLoading] = useState(true); const [error, setError] = useState('');
  async function reload() { const [p,t,m] = await Promise.all([api.projects.get(workspaceId, projectId), api.projects.tasks(workspaceId, projectId), api.workspaces.members(workspaceId)]); setProject(p.project); setTasks(t.tasks); setMembers(m.members); }
  useEffect(() => { let active = true; Promise.all([api.projects.get(workspaceId, projectId), api.projects.tasks(workspaceId, projectId), api.workspaces.members(workspaceId)]).then(([p,t,m]) => { if (active) { setProject(p.project); setTasks(t.tasks); setMembers(m.members); } }).catch((cause) => { if (active) setError(cause.message); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, [workspaceId, projectId, resourceRefreshKey]);
  async function action(work) { setError(''); try { const value = await work(); await reload(); return value; } catch (cause) { setError(cause.message); if (cause.status === 409) { try { await reload(); } catch {} } throw cause; } }
  if (loading) return <CenteredState>Loading project…</CenteredState>;
  if (!project) return <><PageHeading eyebrow="PROJECT" title="Project unavailable" description={error || 'This project may have been removed or is outside your workspace.'} /><Link className="button secondary" to={`/app/workspaces/${workspaceId}`}>Back to workspace</Link></>;
  const manager = ['owner', 'admin'].includes(workspace?.role);
  return <><RealtimeStatus status={realtimeStatus} /><nav className="breadcrumbs" aria-label="Breadcrumb"><Link to="/app">Overview</Link><span>/</span><Link to={`/app/workspaces/${workspaceId}`}>{workspace?.name || 'Workspace'}</Link><span>/</span><span>{project.name}</span></nav><PageHeading eyebrow="PROJECT" title={project.name} description={project.description || 'Plan work and track progress with your team.'} />{error && <Notice role="alert">{error}</Notice>}
    <section className="section-card"><div className="section-header"><div><h2>Tasks</h2><p className="muted">Task updates use version checks to protect concurrent edits.</p></div><span className="count-pill">{tasks.length}</span></div>{tasks.length ? <div className="task-list">{tasks.map((task) => <article className="task-block" key={task.id}><TaskRow task={task} members={members} workspaceId={workspaceId} projectId={projectId} manager={manager} onChange={action} /><details className="task-collaboration"><summary>Comments and files for this task</summary><CommentPanel workspaceId={workspaceId} projectId={projectId} taskId={task.id} user={user} manager={manager} refreshKey={resourceRefreshKey} /><FilePanel workspaceId={workspaceId} projectId={projectId} taskId={task.id} user={user} manager={manager} refreshKey={resourceRefreshKey} /></details></article>)}</div> : <EmptyState title="No tasks yet" text="Create a task to start tracking this project." />}<TaskCreate workspaceId={workspaceId} projectId={projectId} members={members} onCreated={reload} /></section>
    <section className="section-card"><h2>Project discussion and files</h2><div className="collaboration-grid"><CommentPanel workspaceId={workspaceId} projectId={projectId} user={user} manager={manager} refreshKey={resourceRefreshKey} /><FilePanel workspaceId={workspaceId} projectId={projectId} user={user} manager={manager} refreshKey={resourceRefreshKey} /></div></section>
    {manager && <ProjectSettings project={project} workspaceId={workspaceId} onChange={action} />}
  </>;
}

function TaskCreate({ workspaceId, projectId, members, onCreated }) {
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  async function submit(event) { event.preventDefault(); const form = event.currentTarget; const data = new FormData(form); setBusy(true); setError(''); try { await api.projects.createTask(workspaceId, projectId, { title: data.get('title'), description: data.get('description') || null, status: data.get('status'), priority: data.get('priority'), assigneeId: data.get('assigneeId') || null, dueDate: data.get('dueDate') || null }); form.reset(); await onCreated(); } catch (cause) { setError(cause.message); } finally { setBusy(false); } }
  return <form className="create-subform task-form" onSubmit={submit}><h3>New task</h3><div className="form-row"><Field label="Title" name="title" required maxLength={200} /><Field label="Due date" name="dueDate" type="date" /></div><label className="field"><span>Description</span><textarea name="description" rows="2" maxLength={5000} /></label><div className="form-row"><SelectField label="Status" name="status" defaultValue="todo" options={['todo','in_progress','done']} /><SelectField label="Priority" name="priority" defaultValue="medium" options={['low','medium','high','urgent']} /><label className="field"><span>Assignee</span><select name="assigneeId" defaultValue=""><option value="">Unassigned</option>{members.map((member) => <option key={member.user_id} value={member.user_id}>{member.display_name || member.email}</option>)}</select></label></div>{error && <Notice role="alert">{error}</Notice>}<button className="button primary" disabled={busy}>{busy ? 'Creating…' : 'Create task'}</button></form>;
}

function TaskRow({ task, members, workspaceId, projectId, manager, onChange }) {
  const [title, setTitle] = useState(task.title); const [description, setDescription] = useState(task.description || ''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function save(event) { event.preventDefault(); const data = new FormData(event.currentTarget); setBusy(true); setError(''); try { await onChange(() => api.projects.updateTask(workspaceId, projectId, task.id, { version: task.version, title, description: description || null, status: data.get('status'), priority: data.get('priority'), assigneeId: data.get('assigneeId') || null, dueDate: data.get('dueDate') || null })); } catch (cause) { setError(cause.message); } finally { setBusy(false); } }
  async function remove() { if (!window.confirm(`Delete task “${task.title}”?`)) return; try { await onChange(() => api.projects.removeTask(workspaceId, projectId, task.id)); } catch (cause) { setError(cause.message); } }
  return <form className="task-row" onSubmit={save}><div className="task-title-row"><Field label="Task title" name={`title-${task.id}`} value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} /><span className={`status-badge status-${task.status}`}>{task.status.replace('_',' ')}</span></div><label className="field"><span>Description</span><textarea value={description} onChange={(e) => setDescription(e.target.value)} rows="2" maxLength={5000} /></label><div className="form-row"><SelectField label="Status" name="status" defaultValue={task.status} options={['todo','in_progress','done']} /><SelectField label="Priority" name="priority" defaultValue={task.priority} options={['low','medium','high','urgent']} /><label className="field"><span>Assignee</span><select name="assigneeId" defaultValue={task.assigneeId || ''}><option value="">Unassigned</option>{members.map((member) => <option key={member.user_id} value={member.user_id}>{member.display_name || member.email}</option>)}</select></label><Field label="Due date" name="dueDate" type="date" defaultValue={task.dueDate || ''} /></div><div className="task-actions"><span className="microcopy">Version {task.version}</span><div><button className="button secondary small" disabled={busy}>{busy ? 'Saving…' : 'Save task'}</button>{manager && <button type="button" className="button danger subtle small" onClick={remove}>Delete</button>}</div></div>{error && <Notice role="alert">{error}</Notice>}</form>;
}

function ProjectSettings({ project, workspaceId, onChange }) {
  const [name, setName] = useState(project.name); const [description, setDescription] = useState(project.description || ''); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const navigate = useNavigate();
  async function save(event) { event.preventDefault(); setBusy(true); setError(''); try { await onChange(() => api.projects.update(workspaceId, project.id, { name, description: description || null })); } catch (cause) { setError(cause.message); } finally { setBusy(false); } }
  async function remove() { if (!window.confirm(`Delete project “${project.name}” and its tasks?`)) return; try { await api.projects.remove(workspaceId, project.id); navigate(`/app/workspaces/${workspaceId}`); } catch (cause) { setError(cause.message); } }
  return <section className="section-card settings-card"><h2>Project settings</h2><form className="form-stack" onSubmit={save}><Field label="Project name" name="editProjectName" value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} /><label className="field"><span>Description</span><textarea value={description} onChange={(e) => setDescription(e.target.value)} rows="3" maxLength={2000} /></label><div className="button-row"><button className="button secondary" disabled={busy}>{busy ? 'Saving…' : 'Save project'}</button><button type="button" className="button danger" onClick={remove}>Delete project</button></div></form>{error && <Notice role="alert">{error}</Notice>}</section>;
}

function PageHeading({ eyebrow, title, description }) { return <header className="page-heading"><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{description}</p></header>; }
function EmptyState({ title, text }) { return <div className="empty-state"><span aria-hidden="true">✳</span><strong>{title}</strong><p>{text}</p></div>; }
function Notice({ children, role = 'status' }) { return <div className="notice" role={role}>{children}</div>; }
function CenteredState({ children }) { return <main className="centered-state" role="status">{children}</main>; }
function Field({ label, ...props }) { return <label className="field"><span>{label}</span><input {...props} /></label>; }
function SelectField({ label, name, options, ...props }) { return <label className="field"><span>{label}</span><select name={name} {...props}>{options.map((option) => <option key={option} value={option}>{option.replace('_',' ')}</option>)}</select></label>; }
function initials(name) { return name.split(/[\s@.]+/u).filter(Boolean).slice(0,2).map((part) => part[0].toUpperCase()).join(''); }
function RealtimeStatus({ status }) {
  if (!status || status === 'disconnected') return null;
  const label = status === 'connected' ? 'Live updates connected'
    : status === 'reconnecting' || status === 'connecting' ? 'Reconnecting to live updates…'
      : 'Live updates unavailable; refresh to see changes';
  return <p className={`realtime-status realtime-${status}`} role="status">{label}</p>;
}
