const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  createLocalObjectStore,
} = require('../src/files/local-object-store');

describe('local private object store', () => {
  let directory;
  let store;

  beforeEach(async () => {
    directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'teamvault-files-test-')
    );

    store = createLocalObjectStore({ directory });
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  test('stores and reads file contents', async () => {
    const key = 'private/workspace-1/file-1/object-1';
    const body = Buffer.from('TeamVault private file');

    await store.put({ key, body });

    const result = await store.get({ key });
    const chunks = [];

    for await (const chunk of result.Body) {
      chunks.push(chunk);
    }

    expect(Buffer.concat(chunks)).toEqual(body);
  });

  test('deletes a stored file', async () => {
    const key = 'private/workspace-1/file-2/object-2';

    await store.put({
      key,
      body: Buffer.from('temporary'),
    });

    await store.delete({ key });

    await expect(
      fs.access(path.join(directory, key))
    ).rejects.toThrow();
  });

  test('rejects invalid and traversal keys', async () => {
    const invalidKeys = [
      '',
      '../outside.txt',
      'private/../outside.txt',
      '/tmp/outside.txt',
      'private\\outside.txt',
      'private//file.txt',
      'private/./file.txt',
    ];

    for (const key of invalidKeys) {
      await expect(
        store.put({
          key,
          body: Buffer.from('test'),
        })
      ).rejects.toThrow('Invalid private file key.');
    }
  });

  test('does not overwrite an existing file', async () => {
    const key = 'private/workspace-1/file-3/object-3';
    const original = Buffer.from('original');

    await store.put({ key, body: original });

    await expect(
      store.put({
        key,
        body: Buffer.from('replacement'),
      })
    ).rejects.toThrow();

    const result = await store.get({ key });
    const chunks = [];

    for await (const chunk of result.Body) {
      chunks.push(chunk);
    }

    expect(Buffer.concat(chunks)).toEqual(original);
  });

  test('creates stored files with private permissions', async () => {
    const key = 'private/workspace-1/file-4/object-4';

    await store.put({
      key,
      body: Buffer.from('private'),
    });

    const stats = await fs.stat(path.join(directory, key));

    if (process.platform !== 'win32') {
      expect(stats.mode & 0o777).toBe(0o600);
    }
  });

  test('rejects symlink traversal outside the storage directory', async () => {
    const outsideDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'teamvault-outside-test-')
    );

    try {
      const linkedDirectory = path.join(
        directory,
        'private',
        'linked'
      );

      await fs.mkdir(path.dirname(linkedDirectory), {
        recursive: true,
      });

      await fs.symlink(outsideDirectory, linkedDirectory, 'dir');

      const key = 'private/linked/important.txt';
      const outsideFile = path.join(
        outsideDirectory,
        'important.txt'
      );

      await expect(
        store.put({
          key,
          body: Buffer.from('changed'),
        })
      ).rejects.toThrow();

      await expect(fs.access(outsideFile)).rejects.toThrow();

      await fs.writeFile(outsideFile, 'outside data');

      await expect(store.get({ key })).rejects.toThrow();
      await expect(store.delete({ key })).rejects.toThrow();

      await expect(
        fs.readFile(outsideFile, 'utf8')
      ).resolves.toBe('outside data');
    } finally {
      await fs.rm(outsideDirectory, {
        recursive: true,
        force: true,
      });
    }
  });

  test('requires a storage directory', () => {
    expect(() => createLocalObjectStore({})).toThrow(
      'FILE_STORAGE_PATH is required for local file storage.'
    );
  });
});