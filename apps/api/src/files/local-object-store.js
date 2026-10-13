const fs = require('node:fs/promises');
const path = require('node:path');
const { createReadStream, constants } = require('node:fs');

function createLocalObjectStore({ directory }) {
  if (!directory) {
    throw new Error('FILE_STORAGE_PATH is required for local file storage.');
  }

  const root = path.resolve(directory);

  function resolveKey(key) {
    if (
      typeof key !== 'string' ||
      key.length === 0 ||
      key.includes('\\') ||
      path.posix.isAbsolute(key) ||
      key.split('/').some(
        (part) => !part || part === '.' || part === '..'
      )
    ) {
      throw new Error('Invalid private file key.');
    }

    const target = path.resolve(root, ...key.split('/'));

    if (
      target === root ||
      !target.startsWith(`${root}${path.sep}`)
    ) {
      throw new Error('Invalid private file key.');
    }

    return target;
  }

  async function assertSafePath(key, createParents = false) {
    const target = resolveKey(key);
    const parts = key.split('/');
    let current = root;

    for (let i = 0; i < parts.length; i += 1) {
      current = path.join(current, parts[i]);

      let stats;

      try {
        stats = await fs.lstat(current);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;

        const isParent = i < parts.length - 1;

        if (!createParents || !isParent) return target;

        try {
          await fs.mkdir(current, { mode: 0o700 });
        } catch (mkdirError) {
          if (mkdirError.code !== 'EEXIST') throw mkdirError;
        }

        stats = await fs.lstat(current);
      }

      if (stats.isSymbolicLink()) {
        throw new Error('Invalid private file key.');
      }

      if (i < parts.length - 1 && !stats.isDirectory()) {
        throw new Error('Invalid private file key.');
      }
    }

    return target;
  }

  return Object.freeze({
    async put({ key, body }) {
      await fs.mkdir(root, { recursive: true, mode: 0o700 });

      const target = await assertSafePath(key, true);

      const handle = await fs.open(
        target,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          (constants.O_NOFOLLOW || 0),
        0o600
      );

      try {
        await handle.writeFile(body);
      } catch (error) {
        await handle.close();
        await fs.rm(target, { force: true }).catch(() => {});
        throw error;
      }

      await handle.close();
    },

    async get({ key }) {
      const target = await assertSafePath(key);

      return {
        Body: createReadStream(target, {
          flags: constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
        }),
      };
    },

    async delete({ key }) {
      const target = await assertSafePath(key);
      await fs.rm(target, { force: true });
    },
  });
}

module.exports = { createLocalObjectStore };
