const { randomUUID } = require('node:crypto');
const { readFileStorageConfig } = require('../files/config');
const { createS3ObjectStore } = require('../files/object-store');
const fileRepository = require('../files/repository');

class FileStorageUnavailableError extends Error {
  constructor() {
    super('File storage is unavailable.');
    this.name = 'FileStorageUnavailableError';
  }
}

function createFileService({
  repository = fileRepository,
  objectStore,
  config = readFileStorageConfig(),
} = {}) {
  const storage = objectStore ?? createS3ObjectStore({ bucket: config.bucket, region: config.region });

  return Object.freeze({
    canUploadToResource: (input) => repository.canUploadToResource(input),
    canRetryFileUpload: (input) => repository.canRetryFileUpload(input),

    async createFile(input) {
      if (!config.enabled) {
        if (!await repository.canUploadToResource(input)) return { kind: 'not_found' };
        throw new FileStorageUnavailableError();
      }
      const fileId = randomUUID();
      const uploadToken = randomUUID();
      const objectKey = `private/${input.workspaceId}/${fileId}/${randomUUID()}`;
      const file = await repository.createPendingFile({ ...input, id: fileId, uploadToken, objectKey });
      if (!file) return { kind: 'not_found' };
      return storePendingFile({ file, body: input.body, repository, storage });
    },

    async retryFileUpload(input) {
      if (!config.enabled) {
        if (!await repository.canRetryFileUpload(input)) return { kind: 'not_found' };
        throw new FileStorageUnavailableError();
      }
      const uploadToken = randomUUID();
      const objectKey = `private/${input.workspaceId}/${input.fileId}/${randomUUID()}`;
      const file = await repository.prepareFileRetry({ ...input, uploadToken, objectKey });
      if (!file) return { kind: 'not_found' };
      if (file.previousObjectKey) {
        try { await storage.delete({ key: file.previousObjectKey }); } catch { /* Old attempts are unreferenced and retried through their own key. */ }
      }
      if (file.contentType !== input.contentType || file.sizeBytes !== input.sizeBytes) {
        await repository.markFileFailed({ workspaceId: input.workspaceId, fileId: file.id, uploadToken: file.uploadToken });
        return { kind: 'invalid_upload' };
      }
      return storePendingFile({ file, body: input.body, repository, storage });
    },

    listFilesForMember: (input) => repository.listFilesForMember(input),

    async getFileForMember(input) {
      const file = await repository.getFileForMember(input);
      if (!file) return null;
      if (!config.enabled) throw new FileStorageUnavailableError();
      try {
        const object = await storage.get({ key: file.objectKey });
        return { file, body: object.Body };
      } catch {
        throw new FileStorageUnavailableError();
      }
    },

    async deleteFile(input) {
      if (!config.enabled) {
        if (!await repository.canDeleteFile(input)) return { kind: 'not_found' };
        throw new FileStorageUnavailableError();
      }
      const file = await repository.beginFileDelete(input);
      if (!file) return { kind: 'not_found' };
      try {
        await storage.delete({ key: file.objectKey });
      } catch {
        try {
          await repository.restoreFileAfterDeleteFailure({ workspaceId: input.workspaceId, fileId: file.id });
        } catch { /* Leave a visible deleting row if storage and database recovery both fail. */ }
        return { kind: 'storage_unavailable' };
      }
      try {
        if (await repository.finishFileDelete({ workspaceId: input.workspaceId, fileId: file.id })) {
          return { kind: 'deleted' };
        }
        return { kind: 'consistency_error' };
      } catch {
        return { kind: 'consistency_error' };
      }
    },
  });
}

async function storePendingFile({ file, body, repository, storage }) {
  const lease = await startUploadLease(repository, file);
  if (!lease) return { kind: 'consistency_error', fileId: file.id };

  try {
    await storage.put({ key: file.objectKey, body, contentType: file.contentType });
  } catch {
    const stillOwned = await lease.stop();
    try { await storage.delete({ key: file.objectKey }); } catch { /* This attempt's private key is not reused by later retries. */ }
    if (!stillOwned) return { kind: 'consistency_error', fileId: file.id };
    try {
      await repository.markFileFailed({
        workspaceId: file.workspaceId, fileId: file.id, uploadToken: file.uploadToken,
      });
    } catch { /* A pending row remains retryable if PostgreSQL is also unavailable. */ }
    return { kind: 'storage_unavailable', fileId: file.id };
  }

  if (!await lease.stop()) {
    try { await storage.delete({ key: file.objectKey }); } catch { /* This attempt's unique key is not referenced by the current row. */ }
    return { kind: 'consistency_error', fileId: file.id };
  }

  try {
    const available = await repository.markFileAvailable({
      workspaceId: file.workspaceId, fileId: file.id, uploadToken: file.uploadToken,
    });
    if (available) return { kind: 'created', file: available };
  } catch {
    // Try to remove the object; if that fails, the pending row still identifies it for retry/reconciliation.
  }

  try {
    await storage.delete({ key: file.objectKey });
  } catch {
    // The pending row stays visible; a retry receives a fresh key so this object is never served.
  }
  try {
    await repository.markFileFailed({ workspaceId: file.workspaceId, fileId: file.id, uploadToken: file.uploadToken });
  } catch { /* A pending row can be reclaimed after its upload lease expires. */ }
  return { kind: 'consistency_error', fileId: file.id };
}

async function startUploadLease(repository, file) {
  const input = { workspaceId: file.workspaceId, fileId: file.id, uploadToken: file.uploadToken };
  try {
    if (!await repository.renewPendingFileUpload(input)) return null;
  } catch {
    return null;
  }
  let active = true;
  let lost = false;
  let renewalInFlight = null;
  const interval = setInterval(() => {
    if (!active || renewalInFlight) return;
    renewalInFlight = repository.renewPendingFileUpload(input)
      .then((renewed) => { if (!renewed) lost = true; })
      .catch(() => { lost = true; })
      .finally(() => { renewalInFlight = null; });
  }, 60_000);
  return {
    async stop() {
      active = false;
      clearInterval(interval);
      if (renewalInFlight) await renewalInFlight;
      return !lost;
    },
  };
}

module.exports = { FileStorageUnavailableError, createFileService };
