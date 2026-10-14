const { Readable } = require('node:stream');
const express = require('express');
const request = require('supertest');
const { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const errorHandler = require('../src/middleware/error-handler');
const { createFilesRouter } = require('../src/routes/files');
const { readFileStorageConfig, MAX_FILE_BYTES } = require('../src/files/config');
const { createS3ObjectStore } = require('../src/files/object-store');
const { validateUpload } = require('../src/files/validation');
const { createFileService } = require('../src/services/files');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/2ioAAAAASUVORK5CYII=', 'base64');
const workspaceId = '11111111-1111-4111-8111-111111111111';
const fileId = '22222222-2222-4222-8222-222222222222';
const file = {
  id: fileId, workspaceId, projectId: '33333333-3333-4333-8333-333333333333', taskId: null,
  uploadedBy: '44444444-4444-4444-8444-444444444444', objectKey: `private/${workspaceId}/${fileId}/random`,
  uploadToken: '55555555-5555-4555-8555-555555555555',
  originalName: 'picture.png', contentType: 'image/png', sizeBytes: png.length, status: 'pending',
};

describe('private file storage', () => {
  test('validates storage configuration without requiring credentials in environment variables', () => {
    expect(readFileStorageConfig({})).toMatchObject({ enabled: false, maxFileBytes: MAX_FILE_BYTES });
    expect(readFileStorageConfig({ S3_BUCKET: 'private-bucket', AWS_REGION: 'us-east-1' }))
      .toMatchObject({ enabled: true, bucket: 'private-bucket', region: 'us-east-1' });
    expect(readFileStorageConfig({ AWS_REGION: 'us-east-1' })).toMatchObject({ enabled: false });
    expect(() => readFileStorageConfig({ S3_BUCKET: 'private-bucket' })).toThrow('AWS_REGION');
    expect(() => readFileStorageConfig({ FILE_MAX_BYTES: String(MAX_FILE_BYTES + 1) })).toThrow('FILE_MAX_BYTES');
    expect(readFileStorageConfig({}).maxConcurrentUploads).toBe(4);
    expect(() => readFileStorageConfig({ FILE_MAX_CONCURRENT_UPLOADS: '9' })).toThrow('FILE_MAX_CONCURRENT_UPLOADS');
  });

  test('checks content type, magic bytes, size, and safe basename', () => {
    expect(validateUpload({ body: png, contentType: 'image/png', originalName: 'image.png', maxFileBytes: 100 }))
      .toMatchObject({ contentType: 'image/png', originalName: 'image.png', sizeBytes: png.length });
    expect(validateUpload({ body: png, contentType: 'application/pdf', originalName: 'image.pdf', maxFileBytes: 100 }))
      .toBeNull();
    expect(validateUpload({ body: png, contentType: 'image/png', originalName: '../secret.png', maxFileBytes: 100 }))
      .toBeNull();
    expect(validateUpload({ body: Buffer.alloc(101), contentType: 'image/png', originalName: 'big.png', maxFileBytes: 100 }))
      .toBeNull();
    expect(validateUpload({ body: png.subarray(0, 20), contentType: 'image/png', originalName: 'truncated.png', maxFileBytes: 100 }))
      .toBeNull();
    expect(validateUpload({ body: Buffer.from('%PDF-1.7'), contentType: 'application/pdf', originalName: 'short.pdf', maxFileBytes: 100 }))
      .toBeNull();
  });

  test('uses private encrypted PutObject settings and never requests a public ACL', async () => {
    const client = { send: jest.fn(async (command) => command instanceof GetObjectCommand
      ? { Body: Readable.from([png]) } : {}) };
    const store = createS3ObjectStore({ bucket: 'private-bucket', region: 'us-east-1', client });
    await store.put({ key: file.objectKey, body: png, contentType: 'image/png' });
    await store.get({ key: file.objectKey });
    await store.delete({ key: file.objectKey });

    const put = client.send.mock.calls[0][0];
    expect(put).toBeInstanceOf(PutObjectCommand);
    expect(put.input).toMatchObject({
      Bucket: 'private-bucket', Key: file.objectKey, ContentLength: png.length,
      ContentType: 'image/png', CacheControl: 'private, no-store',
    });
    expect(put.input).not.toHaveProperty('ACL');
    expect(client.send.mock.calls[1][0]).toBeInstanceOf(GetObjectCommand);
    expect(client.send.mock.calls[2][0]).toBeInstanceOf(DeleteObjectCommand);
  });

  test('keeps a recoverable pending row and reuses its private key after metadata finalization fails', async () => {
    const repository = {
      createPendingFile: jest.fn(async () => file),
      renewPendingFileUpload: jest.fn().mockResolvedValue(true),
      markFileAvailable: jest.fn().mockRejectedValueOnce(new Error('database unavailable')).mockResolvedValueOnce(file),
      markFileFailed: jest.fn().mockResolvedValue(false),
      prepareFileRetry: jest.fn(async () => file),
    };
    const objectStore = { put: jest.fn().mockResolvedValue(undefined), delete: jest.fn().mockRejectedValue(new Error('delete unavailable')) };
    const service = createFileService({ repository, objectStore, config: { enabled: true } });
    const input = {
      workspaceId, projectId: file.projectId, taskId: null, actorId: file.uploadedBy,
      originalName: file.originalName, contentType: file.contentType, sizeBytes: png.length, body: png,
    };

    const first = await service.createFile(input);
    expect(first).toEqual({ kind: 'consistency_error', fileId: file.id });
    expect(objectStore.put).toHaveBeenCalledWith({ key: file.objectKey, body: png, contentType: 'image/png' });
    expect(objectStore.delete).toHaveBeenCalledWith({ key: file.objectKey });

    objectStore.delete.mockResolvedValue(undefined);
    await expect(service.retryFileUpload({ ...input, fileId: file.id })).resolves.toMatchObject({ kind: 'created' });
    expect(repository.prepareFileRetry).toHaveBeenCalledWith(expect.objectContaining({ fileId: file.id }));
    expect(objectStore.put).toHaveBeenCalledTimes(2);
  });

  test('marks upload failures retryable and restores metadata if S3 deletion fails', async () => {
    const repository = {
      createPendingFile: jest.fn(async () => file),
      renewPendingFileUpload: jest.fn().mockResolvedValue(true),
      markFileFailed: jest.fn().mockResolvedValue(true),
      beginFileDelete: jest.fn(async () => ({ id: fileId, workspaceId, objectKey: file.objectKey })),
      restoreFileAfterDeleteFailure: jest.fn().mockResolvedValue(true),
    };
    const objectStore = {
      put: jest.fn().mockRejectedValue(new Error('private S3 failure')),
      delete: jest.fn().mockRejectedValue(new Error('private S3 failure')),
    };
    const service = createFileService({ repository, objectStore, config: { enabled: true } });
    const input = {
      workspaceId, projectId: file.projectId, taskId: null, actorId: file.uploadedBy,
      originalName: file.originalName, contentType: file.contentType, sizeBytes: png.length, body: png,
    };

    await expect(service.createFile(input)).resolves.toMatchObject({ kind: 'storage_unavailable', fileId });
    expect(repository.markFileFailed).toHaveBeenCalledWith({ workspaceId, fileId, uploadToken: file.uploadToken });
    await expect(service.deleteFile({ ...input, fileId })).resolves.toEqual({ kind: 'storage_unavailable' });
    expect(repository.restoreFileAfterDeleteFailure).toHaveBeenCalledWith({ workspaceId, fileId });
  });

  test('retries a failed upload under a fresh object key and removes the unreferenced previous key', async () => {
    const retryFile = {
      ...file,
      objectKey: `private/${workspaceId}/${fileId}/new-attempt`,
      previousObjectKey: file.objectKey,
    };
    const repository = {
      prepareFileRetry: jest.fn(async () => retryFile),
      renewPendingFileUpload: jest.fn().mockResolvedValue(true),
      markFileAvailable: jest.fn(async () => ({ id: fileId, status: 'available' })),
    };
    const objectStore = { delete: jest.fn(), put: jest.fn() };
    const service = createFileService({ repository, objectStore, config: { enabled: true } });
    const result = await service.retryFileUpload({
      workspaceId, projectId: file.projectId, taskId: null, fileId, actorId: file.uploadedBy,
      originalName: file.originalName, contentType: file.contentType, sizeBytes: png.length, body: png,
    });

    expect(result.kind).toBe('created');
    expect(repository.prepareFileRetry).toHaveBeenCalledWith(expect.objectContaining({
      objectKey: expect.stringMatching(new RegExp(`^private/${workspaceId}/${fileId}/`)),
    }));
    const attemptKey = repository.prepareFileRetry.mock.calls[0][0].objectKey;
    expect(attemptKey).not.toBe(file.objectKey);
    expect(objectStore.delete).toHaveBeenCalledWith({ key: file.objectKey });
    expect(objectStore.put).toHaveBeenCalledWith({ key: retryFile.objectKey, body: png, contentType: 'image/png' });
  });

  test('does not publish an object when the upload lease has been reclaimed', async () => {
    const repository = {
      createPendingFile: jest.fn(async () => file),
      renewPendingFileUpload: jest.fn().mockResolvedValue(false),
    };
    const objectStore = { put: jest.fn(), delete: jest.fn() };
    const service = createFileService({ repository, objectStore, config: { enabled: true } });

    await expect(service.createFile({
      workspaceId, projectId: file.projectId, taskId: null, actorId: file.uploadedBy,
      originalName: file.originalName, contentType: file.contentType, sizeBytes: png.length, body: png,
    })).resolves.toMatchObject({ kind: 'consistency_error' });
    expect(objectStore.put).not.toHaveBeenCalled();
  });

  test('caps concurrent upload body buffers per router and releases capacity after completion', async () => {
    let enteredUpload;
    const entered = new Promise((resolve) => { enteredUpload = resolve; });
    let finishUpload;
    const finish = new Promise((resolve) => { finishUpload = resolve; });
    const service = {
      canUploadToResource: jest.fn().mockResolvedValue(true),
      createFile: jest.fn(async () => {
        enteredUpload();
        await finish;
        return { kind: 'created', file: { ...file, status: 'available' } };
      }),
    };
    const app = express();
    app.use('/api/workspaces', createFilesRouter(
      { authenticate: async () => ({ id: file.uploadedBy }) }, service,
      { maxFileBytes: 1000, maxConcurrentUploads: 1 },
    ));
    app.use(errorHandler);
    const path = `/api/workspaces/${workspaceId}/projects/${file.projectId}/files`;
    const firstRequest = request(app).post(path).set('Authorization', `Bearer ${'a'.repeat(43)}`)
      .set('Content-Type', 'image/png').set('X-File-Name', 'one.png').send(png);
    const firstResponse = firstRequest.then((response) => response);
    const firstOutcome = await Promise.race([
      entered.then(() => ({ entered: true })),
      firstResponse.then((response) => ({ response })),
    ]);
    expect(firstOutcome.entered).toBe(true);
    const rejected = await request(app).post(path).set('Authorization', `Bearer ${'a'.repeat(43)}`)
      .set('Content-Type', 'image/png').set('X-File-Name', 'two.png').send(png);
    expect(rejected.status).toBe(503);
    expect(rejected.headers['retry-after']).toBe('1');
    finishUpload();
    expect((await firstResponse).status).toBe(201);

    const afterRelease = await request(app).post(path).set('Authorization', `Bearer ${'a'.repeat(43)}`)
      .set('Content-Type', 'image/png').set('X-File-Name', 'three.png').send(png);
    expect(afterRelease.status).toBe(201);
    expect(service.createFile).toHaveBeenCalledTimes(2);
  });

  test('checks workspace/resource authorization before buffering upload bodies', async () => {
    const service = {
      canUploadToResource: jest.fn().mockResolvedValue(false),
      createFile: jest.fn(),
    };
    const app = express();
    app.use('/api/workspaces', createFilesRouter(
      { authenticate: async () => ({ id: file.uploadedBy }) }, service,
      { maxFileBytes: 1000, maxConcurrentUploads: 1 },
    ));
    app.use(errorHandler);
    const path = `/api/workspaces/${workspaceId}/projects/${file.projectId}/files`;
    const response = await request(app).post(path).set('Authorization', `Bearer ${'a'.repeat(43)}`)
      .set('Content-Type', 'image/png').set('X-File-Name', 'unauthorized.png').send(Buffer.alloc(1001));
    expect(response.status).toBe(404);
    expect(service.canUploadToResource).toHaveBeenCalledTimes(1);
    expect(service.createFile).not.toHaveBeenCalled();
  });
});
