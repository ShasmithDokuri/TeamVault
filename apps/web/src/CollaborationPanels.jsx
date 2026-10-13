import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';

export function CommentPanel({ workspaceId, projectId, taskId = null, user, manager = false, refreshKey = 0 }) {
  const [comments, setComments] = useState([]);
  const [content, setContent] = useState('');
  const [editing, setEditing] = useState(null);
  const [editContent, setEditContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const targetLabel = taskId ? 'task' : 'project';

  const reload = useCallback(async () => {
    const result = await api.projects.comments(workspaceId, projectId, taskId);
    setComments(result.comments);
  }, [workspaceId, projectId, taskId]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    api.projects.comments(workspaceId, projectId, taskId)
      .then((result) => { if (active) { setComments(result.comments); setError(''); } })
      .catch((cause) => { if (active) setError(cause.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [workspaceId, projectId, taskId, refreshKey]);

  async function submit(event) {
    event.preventDefault();
    setBusy(true); setError('');
    try { await api.projects.createComment(workspaceId, projectId, content, taskId); setContent(''); await reload(); }
    catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  }

  async function saveEdit(event) {
    event.preventDefault();
    setBusy(true); setError('');
    try {
      await api.projects.updateComment(workspaceId, projectId, editing.id,
        { content: editContent, version: editing.version }, taskId);
      setEditing(null); await reload();
    } catch (cause) { setError(cause.status === 409 ? 'This comment changed elsewhere. Reloading the latest version.' : cause.message); await reload().catch(() => {}); }
    finally { setBusy(false); }
  }

  async function remove(comment) {
    if (!window.confirm('Delete this comment?')) return;
    setBusy(true); setError('');
    try { await api.projects.removeComment(workspaceId, projectId, comment.id, taskId); await reload(); }
    catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  }

  return <section className="collaboration-panel" aria-label={`${targetLabel} comments`}>
    <div className="collaboration-heading"><h3>Comments</h3><span>{comments.length}</span></div>
    {loading ? <p className="panel-state" role="status">Loading comments…</p>
      : comments.length === 0 ? <p className="panel-state">No comments yet.</p>
        : <ul className="comment-list">{comments.map((comment) => {
          const own = comment.authorId === user?.id;
          const canDelete = own || manager;
          return <li className="comment-item" key={comment.id}>
            {editing?.id === comment.id ? <form onSubmit={saveEdit} className="panel-form">
              <label className="field"><span>Edit comment</span><textarea value={editContent} onChange={(event) => setEditContent(event.target.value)} maxLength={5000} required rows="3" /></label>
              <div className="button-row"><button className="button secondary small" disabled={busy || !editContent.trim()}>Save edit</button><button type="button" className="button subtle small" onClick={() => setEditing(null)}>Cancel</button></div>
            </form> : <>
              <p className="comment-content">{comment.content}</p>
              <div className="comment-meta"><span>{own ? 'You' : 'Workspace member'} · {new Date(comment.createdAt).toLocaleString()}</span>
                <div>{own && <button className="text-button" disabled={busy} onClick={() => { setEditing(comment); setEditContent(comment.content); }}>Edit</button>}
                  {canDelete && <button className="text-button danger-text" disabled={busy} onClick={() => remove(comment)}>Delete</button>}</div>
              </div>
            </>}
          </li>;
        })}</ul>}
    <form onSubmit={submit} className="panel-form">
      <label className="field"><span>Add a comment</span><textarea value={content} onChange={(event) => setContent(event.target.value)} maxLength={5000} required rows="3" placeholder="Write a comment…" /></label>
      <button className="button secondary small" disabled={busy || !content.trim()}>{busy ? 'Saving…' : 'Post comment'}</button>
    </form>
    {error && <div className="panel-error" role="alert">{error}</div>}
  </section>;
}

export function ActivityFeed({ workspaceId, refreshKey = 0 }) {
  const [events, setEvents] = useState([]);
  const [before, setBefore] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const result = await api.activity.list(workspaceId, { limit: 50 });
      setEvents(result.events); setHasMore(result.events.length === 50);
      setBefore(result.events.at(-1)?.id ?? null);
    } catch (cause) { setError(cause.message); }
    finally { setLoading(false); }
  }, [workspaceId, refreshKey]);

  useEffect(() => { reload(); }, [reload]);

  async function loadMore() {
    if (!before || loadingMore) return;
    setLoadingMore(true); setError('');
    try {
      const result = await api.activity.list(workspaceId, { limit: 50, before });
      setEvents((current) => [...current, ...result.events]); setHasMore(result.events.length === 50);
      setBefore(result.events.at(-1)?.id ?? null);
    } catch (cause) { setError(cause.message); }
    finally { setLoadingMore(false); }
  }

  return <section className="section-card activity-card">
    <div className="section-header"><div><h2>Activity</h2><p className="muted">Recent changes in this workspace.</p></div><button className="button subtle small" onClick={reload} disabled={loading}>Refresh</button></div>
    {loading ? <p role="status" className="panel-state">Loading activity…</p>
      : events.length === 0 ? <p className="panel-state">No activity yet.</p>
        : <ol className="activity-list">{events.map((event) => <li key={event.id}>
          <span className="activity-dot" aria-hidden="true" />
          <div><strong>{activityLabel(event.eventType)}</strong><small>{new Date(event.createdAt).toLocaleString()}</small></div>
        </li>)}</ol>}
    {hasMore && <button className="button secondary small" onClick={loadMore} disabled={loadingMore}>{loadingMore ? 'Loading…' : 'Load more activity'}</button>}
    {error && <div className="panel-error" role="alert">{error}</div>}
  </section>;
}

export function FilePanel({ workspaceId, projectId, taskId = null, user, manager = false, refreshKey = 0 }) {
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(null);

  const reload = useCallback(async () => {
    const result = await api.files.list(workspaceId, projectId, taskId);
    setFiles(result.files);
  }, [workspaceId, projectId, taskId]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    api.files.list(workspaceId, projectId, taskId)
      .then((result) => { if (active) { setFiles(result.files); setError(''); } })
      .catch((cause) => { if (active) setError(cause.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [workspaceId, projectId, taskId, refreshKey]);

  async function upload(file) {
    if (!file) return;
    setBusy(true); setError(''); setRetry(null);
    try { await api.files.upload(workspaceId, projectId, file, taskId); await reload(); }
    catch (cause) { setError(cause.message); if (cause.fileId) setRetry({ fileId: cause.fileId, file }); }
    finally { setBusy(false); }
  }

  async function retryUpload() {
    if (!retry) return;
    setBusy(true); setError('');
    try { await api.files.retry(workspaceId, projectId, retry.fileId, retry.file, taskId); setRetry(null); await reload(); }
    catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  }

  async function download(file) {
    setBusy(true); setError('');
    try {
      const result = await api.files.download(workspaceId, projectId, file.id, taskId);
      const url = URL.createObjectURL(result.blob);
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = result.name; anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  }

  async function remove(file) {
    if (!window.confirm(`Delete “${file.originalName}”?`)) return;
    setBusy(true); setError('');
    try { await api.files.remove(workspaceId, projectId, file.id, taskId); await reload(); }
    catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  }

  return <section className="collaboration-panel" aria-label="Files">
    <div className="collaboration-heading"><h3>Files</h3><span>{files.length}</span></div>
    <label className="file-picker"><span>{busy ? 'Working…' : 'Upload a file'}</span>
      <input type="file" accept=".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp" disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; void upload(file); }} />
    </label>
    <p className="microcopy">PDF, JPEG, PNG, or WebP · up to 10 MiB. Files stay private and downloads use this API.</p>
    {loading ? <p role="status" className="panel-state">Loading files…</p>
      : files.length === 0 ? <p className="panel-state">No files attached.</p>
        : <ul className="file-list">{files.map((file) => {
          const canDelete = manager || file.uploadedBy === user?.id;
          return <li key={file.id}>
            <span className="file-name"><strong>{file.originalName}</strong><small>{formatBytes(file.sizeBytes)}{file.status ? ` · ${file.status}` : ''}</small></span>
            <div className="file-actions">
              {/* The list API includes only available files and omits status. */}
              <button className="text-button" disabled={busy} onClick={() => download(file)}>Download</button>
              {canDelete && <button className="text-button danger-text" disabled={busy} onClick={() => remove(file)}>Delete</button>}
            </div>
          </li>;
        })}</ul>}
    {retry && <button className="button secondary small" disabled={busy} onClick={retryUpload}>Retry upload</button>}
    {error && <div className="panel-error" role="alert">{error}</div>}
  </section>;
}

function activityLabel(type = '') {
  const labels = {
    project_created: 'Project created', project_updated: 'Project updated', project_deleted: 'Project deleted',
    task_created: 'Task created', task_updated: 'Task updated', task_deleted: 'Task deleted',
    comment_created: 'Comment added', comment_updated: 'Comment edited', comment_deleted: 'Comment deleted',
  };
  return labels[type] || 'Workspace updated';
}

function formatBytes(value) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}
