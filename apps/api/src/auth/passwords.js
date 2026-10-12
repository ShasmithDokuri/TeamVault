const { promisify } = require('node:util');
const { randomBytes, scrypt: scryptCallback, timingSafeEqual } = require('node:crypto');

const scrypt = promisify(scryptCallback);
const PARAMETERS = Object.freeze({ N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
const KEY_LENGTH = 64;

async function hashPassword(password) {
  const salt = randomBytes(16);
  const derivedKey = await scrypt(password, salt, KEY_LENGTH, PARAMETERS);

  return [
    'scrypt',
    PARAMETERS.N,
    PARAMETERS.r,
    PARAMETERS.p,
    salt.toString('base64url'),
    derivedKey.toString('base64url'),
  ].join('$');
}

async function verifyPassword(password, encodedHash) {
  if (typeof encodedHash !== 'string') return false;
  const [algorithm, cost, blockSize, parallelization, saltText, keyText, extra] = encodedHash.split('$');
  const salt = Buffer.from(saltText ?? '', 'base64url');
  const expectedKey = Buffer.from(keyText ?? '', 'base64url');

  if (
    extra !== undefined
    || algorithm !== 'scrypt'
    || Number(cost) !== PARAMETERS.N
    || Number(blockSize) !== PARAMETERS.r
    || Number(parallelization) !== PARAMETERS.p
    || salt.length !== 16
    || expectedKey.length !== KEY_LENGTH
  ) {
    return false;
  }

  const actualKey = await scrypt(password, salt, KEY_LENGTH, PARAMETERS);
  return timingSafeEqual(actualKey, expectedKey);
}

module.exports = { hashPassword, verifyPassword };
