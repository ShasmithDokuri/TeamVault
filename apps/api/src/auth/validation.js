const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const PASSWORD_MIN_LENGTH = 12;
const PASSWORD_MAX_LENGTH = 128;

function validateCredentials(body, { registration = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'A JSON object is required.' };
  }

  if (typeof body.email !== 'string') return { error: 'A valid email and password are required.' };
  if (typeof body.password !== 'string') return { error: 'A valid email and password are required.' };

  const email = body.email.trim().normalize('NFKC').toLowerCase();
  const emailLength = Buffer.byteLength(email, 'utf8');
  const passwordLength = [...body.password].length;

  if (emailLength > 254 || !EMAIL_PATTERN.test(email)) {
    return { error: 'A valid email and password are required.' };
  }
  if (passwordLength < PASSWORD_MIN_LENGTH || passwordLength > PASSWORD_MAX_LENGTH) {
    return { error: `Password must be ${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters.` };
  }

  if (registration && body.displayName !== undefined) {
    if (typeof body.displayName !== 'string' || [...body.displayName.trim()].length > 100) {
      return { error: 'Display name must be a string of at most 100 characters.' };
    }
  }

  return {
    value: {
      email,
      password: body.password,
      ...(registration ? { displayName: body.displayName?.trim() || null } : {}),
    },
  };
}

module.exports = { validateCredentials };
