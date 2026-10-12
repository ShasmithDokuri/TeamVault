const { createHash, randomBytes } = require('node:crypto');

const SESSION_TTL_SECONDS = 15 * 60;

function createSessionToken() {
  const token = randomBytes(32).toString('base64url');
  return {
    token,
    tokenHash: hashSessionToken(token),
    expiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1000),
  };
}

function hashSessionToken(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

module.exports = { SESSION_TTL_SECONDS, createSessionToken, hashSessionToken };
