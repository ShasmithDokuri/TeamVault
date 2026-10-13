const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const WORKSPACE_ROLES = new Set(['admin', 'member']);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

function validateWorkspaceName(value) {
  if (typeof value !== 'string') return null;
  const name = value.normalize('NFKC').trim();
  if ([...name].length < 1 || [...name].length > 100 || /[\u0000-\u001f\u007f]/u.test(name)) return null;
  return name;
}

function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isAssignableRole(value) {
  return WORKSPACE_ROLES.has(value);
}

function validateMemberEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().normalize('NFKC').toLowerCase();
  return Buffer.byteLength(email, 'utf8') <= 254 && EMAIL_PATTERN.test(email) ? email : null;
}

module.exports = { isAssignableRole, isUuid, validateMemberEmail, validateWorkspaceName };
