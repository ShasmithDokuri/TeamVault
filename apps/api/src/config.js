const port = Number(process.env.PORT ?? 3001);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535.');
}

const webOrigin = process.env.WEB_ORIGIN ?? 'http://localhost:5173';
const cookieSecure = process.env.COOKIE_SECURE === undefined
  ? process.env.NODE_ENV === 'production'
  : process.env.COOKIE_SECURE === 'true';
if (process.env.COOKIE_SECURE !== undefined && !['true', 'false'].includes(process.env.COOKIE_SECURE)) {
  throw new Error('COOKIE_SECURE must be true or false.');
}
const databaseUrl = process.env.DATABASE_URL;
const trustProxyHops = readTrustProxyHops(process.env);

const googleOAuth = {
  clientId: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  redirectUri: process.env.GOOGLE_REDIRECT_URI,
};
const googleOAuthValues = Object.values(googleOAuth);

if (googleOAuthValues.some(Boolean) && !googleOAuthValues.every(Boolean)) {
  throw new Error('Google OAuth requires client ID, client secret, and redirect URI.');
}

function validateGoogleOAuthConfig(config) {
  const values = Object.values(config);
  if (!values.some(Boolean)) return;
  if (!values.every((value) => typeof value === 'string' && value.trim())) {
    throw new Error('Google OAuth requires client ID, client secret, and redirect URI.');
  }

  let redirect;
  try {
    redirect = new URL(config.redirectUri);
  } catch {
    throw new Error('GOOGLE_REDIRECT_URI must be an HTTPS callback URL.');
  }
  const localHttp = redirect.protocol === 'http:'
    && ['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname);
  if (
    (redirect.protocol !== 'https:' && !localHttp)
    || redirect.username
    || redirect.password
    || /[\s?#]/u.test(config.redirectUri)
    || redirect.search
    || redirect.hash
    || redirect.pathname !== '/api/auth/google/callback'
  ) {
    throw new Error('GOOGLE_REDIRECT_URI must be an HTTPS callback URL (HTTP is allowed only on localhost).');
  }
}

validateGoogleOAuthConfig(googleOAuth);

function readTrustProxyHops(env) {
  const hops = env.TRUST_PROXY_HOPS === undefined ? 0 : Number(env.TRUST_PROXY_HOPS);
  if (!Number.isInteger(hops) || hops < 0 || hops > 5) {
    throw new Error('TRUST_PROXY_HOPS must be an integer between 0 and 5.');
  }
  return hops;
}

module.exports = { cookieSecure, databaseUrl, googleOAuth, port, readTrustProxyHops, trustProxyHops, validateGoogleOAuthConfig, webOrigin };
