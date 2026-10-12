const express = require('express');
const { createRequireAuth } = require('../middleware/require-auth');
const { createFileService, FileStorageUnavailableError } = require('../services/files');
const { isUuid } = require('../projects/validation');
const { validateUpload } = require('../files/validation');

function createFilesRouter(authService, fileService = createFileService(), { maxFileBytes, maxConcurrentUploads = 4 } = {}) {
  const router = express.Router();
  router.use(createRequireAuth(authService));
  const rawParser = express.raw({ type: () => true, limit: maxFileBytes ?? 10 * 1024 * 1024 });
  const rawUpload = createBoundedUploadParser(rawParser, maxConcurrentUploads);

  router.post('/:workspaceId/projects/:projectId/files', preauthorizeUpload(fileService, null), rawUpload,
    withUploadSlot((request, response, next) => uploadFile(request, response, next, fileService, null, maxFileBytes)));
  router.get('/:workspaceId/projects/:projectId/files',
    (request, response, next) => listFiles(request, response, next, fileService, null));
  router.get('/:workspaceId/projects/:projectId/files/:fileId',
    (request, response, next) => downloadFile(request, response, next, fileService, null));
  router.delete('/:workspaceId/projects/:projectId/files/:fileId',
    (request, response, next) => deleteFile(request, response, next, fileService, null));
  router.put('/:workspaceId/projects/:projectId/files/:fileId/content', preauthorizeUpload(fileService, null, true), rawUpload,
    withUploadSlot((request, response, next) => retryFile(request, response, next, fileService, null, maxFileBytes)));

  router.post('/:workspaceId/projects/:projectId/tasks/:taskId/files', preauthorizeUpload(fileService, (request) => request.params.taskId), rawUpload,
    withUploadSlot((request, response, next) => uploadFile(request, response, next, fileService, request.params.taskId, maxFileBytes)));
  router.get('/:workspaceId/projects/:projectId/tasks/:taskId/files',
    (request, response, next) => listFiles(request, response, next, fileService, request.params.taskId));
  router.get('/:workspaceId/projects/:projectId/tasks/:taskId/files/:fileId',
    (request, response, next) => downloadFile(request, response, next, fileService, request.params.taskId));
  router.delete('/:workspaceId/projects/:projectId/tasks/:taskId/files/:fileId',
    (request, response, next) => deleteFile(request, response, next, fileService, request.params.taskId));
  router.put('/:workspaceId/projects/:projectId/tasks/:taskId/files/:fileId/content', preauthorizeUpload(fileService, (request) => request.params.taskId, true), rawUpload,
    withUploadSlot((request, response, next) => retryFile(request, response, next, fileService, request.params.taskId, maxFileBytes)));

  return router;
}

function preauthorizeUpload(service, getTaskId, retry = false) {
  return async (request, response, next) => {
    const taskId = getTaskId ? getTaskId(request) : null;
    if (!validIds(request, taskId, retry)) return notFound(response);
    const input = {
      workspaceId: request.params.workspaceId,
      projectId: request.params.projectId,
      taskId,
      fileId: request.params.fileId,
      actorId: request.auth.user.id,
    };
    try {
      const allowed = retry
        ? await service.canRetryFileUpload(input)
        : await service.canUploadToResource(input);
      if (!allowed) return notFound(response);
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

function createBoundedUploadParser(parser, maxConcurrentUploads) {
  let activeUploads = 0;
  return (request, response, next) => {
    if (activeUploads >= maxConcurrentUploads) {
      response.set('Retry-After', '1').status(503).json({ error: 'File upload capacity is temporarily full.' });
      return;
    }
    activeUploads += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      activeUploads -= 1;
    };
    request.releaseFileUploadSlot = release;
    response.once('close', release);
    parser(request, response, (error) => {
      if (error) {
        release();
        next(error);
        return;
      }
      next();
    });
  };
}

function withUploadSlot(handler) {
  return (request, response, next) => Promise.resolve(handler(request, response, next))
    .finally(() => request.releaseFileUploadSlot?.());
}

async function uploadFile(request, response, next, service, taskId, maxFileBytes) {
  if (!validIds(request, taskId)) return notFound(response);
  const upload = validateUpload({
    body: request.body,
    contentType: request.get('content-type'),
    originalName: request.get('x-file-name'),
    maxFileBytes: maxFileBytes ?? 10 * 1024 * 1024,
  });
  if (!upload) return invalid(response);
  try {
    const result = await service.createFile({
      workspaceId: request.params.workspaceId, projectId: request.params.projectId,
      taskId, actorId: request.auth.user.id, ...upload,
    });
    if (result.kind === 'not_found') return notFound(response);
    if (result.kind === 'created') return response.status(201).json({ file: publicFile(result.file) });
    return response.status(503).json({
      error: result.kind === 'consistency_error' ? 'File upload needs to be retried.' : 'File storage is unavailable.',
      fileId: result.fileId,
    });
  } catch (error) { return handleError(error, response, next); }
}

async function retryFile(request, response, next, service, taskId, maxFileBytes) {
  if (!validIds(request, taskId, true)) return notFound(response);
  const upload = validateUpload({
    body: request.body,
    contentType: request.get('content-type'),
    originalName: request.get('x-file-name'),
    maxFileBytes: maxFileBytes ?? 10 * 1024 * 1024,
  });
  if (!upload) return invalid(response);
  try {
    const result = await service.retryFileUpload({
      workspaceId: request.params.workspaceId, projectId: request.params.projectId,
      taskId, fileId: request.params.fileId, actorId: request.auth.user.id, ...upload,
    });
    if (result.kind === 'not_found') return notFound(response);
    if (result.kind === 'invalid_upload') return invalid(response);
    if (result.kind === 'created') return response.status(200).json({ file: publicFile(result.file) });
    return response.status(503).json({ error: 'File upload needs to be retried.', fileId: result.fileId });
  } catch (error) { return handleError(error, response, next); }
}

async function listFiles(request, response, next, service, taskId) {
  if (!validIds(request, taskId)) return notFound(response);
  try {
    const result = await service.listFilesForMember({
      workspaceId: request.params.workspaceId, projectId: request.params.projectId,
      taskId, actorId: request.auth.user.id,
    });
    return result.authorized
      ? response.status(200).json({ files: result.files.map(publicFile) })
      : notFound(response);
  } catch (error) { return next(error); }
}

async function downloadFile(request, response, next, service, taskId) {
  if (!validIds(request, taskId, true)) return notFound(response);
  try {
    const result = await service.getFileForMember({
      workspaceId: request.params.workspaceId, projectId: request.params.projectId,
      taskId, fileId: request.params.fileId, actorId: request.auth.user.id,
    });
    if (!result) return notFound(response);
    response.set({
      'Content-Type': result.file.contentType,
      'Content-Length': String(result.file.sizeBytes),
      'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${encodeRFC5987(result.file.originalName)}`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    result.body.once('error', () => response.destroy());
    result.body.pipe(response);
    return undefined;
  } catch (error) { return handleError(error, response, next); }
}

async function deleteFile(request, response, next, service, taskId) {
  if (!validIds(request, taskId, true)) return notFound(response);
  try {
    const result = await service.deleteFile({
      workspaceId: request.params.workspaceId, projectId: request.params.projectId,
      taskId, fileId: request.params.fileId, actorId: request.auth.user.id,
    });
    if (result.kind === 'not_found') return notFound(response);
    if (result.kind === 'storage_unavailable') {
      return response.status(503).json({ error: 'File deletion needs to be retried.' });
    }
    if (result.kind === 'consistency_error') {
      return response.status(503).json({ error: 'File deletion needs to be retried.' });
    }
    return response.status(204).end();
  } catch (error) { return handleError(error, response, next); }
}

function publicFile(file) {
  const { objectKey: _objectKey, ...metadata } = file;
  return metadata;
}

function validIds(request, taskId, fileIdRequired = false) {
  return isUuid(request.params.workspaceId) && isUuid(request.params.projectId)
    && (taskId === null || isUuid(taskId))
    && (!fileIdRequired || isUuid(request.params.fileId));
}

function encodeRFC5987(value) {
  return encodeURIComponent(value).replace(/[!'()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function handleError(error, response, next) {
  if (error instanceof FileStorageUnavailableError) {
    return response.status(503).json({ error: 'File storage is unavailable.' });
  }
  return next(error);
}

function invalid(response) { return response.status(400).json({ error: 'Invalid file upload.' }); }
function notFound(response) { return response.status(404).json({ error: 'File, project, task, or workspace not found.' }); }

module.exports = { createBoundedUploadParser, createFilesRouter, encodeRFC5987, preauthorizeUpload, publicFile };
