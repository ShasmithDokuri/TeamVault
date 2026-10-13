const { readTrustProxyHops, validateGoogleOAuthConfig } = require('../src/config');

describe('reverse proxy configuration', () => {
  test('defaults to not trusting forwarded headers', () => {
    expect(readTrustProxyHops({})).toBe(0);
  });

  test('accepts a bounded, explicit proxy hop count', () => {
    expect(readTrustProxyHops({ TRUST_PROXY_HOPS: '2' })).toBe(2);
  });

  test.each(['-1', '6', '1.5', 'true'])('rejects unsafe proxy hop value %s', (value) => {
    expect(() => readTrustProxyHops({ TRUST_PROXY_HOPS: value })).toThrow();
  });
});

describe('Google OAuth configuration', () => {
  const base = {
    clientId: 'client-id',
    clientSecret: 'client-secret',
  };

  test('allows HTTPS callbacks and localhost HTTP callbacks only', () => {
    expect(() => validateGoogleOAuthConfig({
      ...base, redirectUri: 'https://app.example/api/auth/google/callback',
    })).not.toThrow();
    expect(() => validateGoogleOAuthConfig({
      ...base, redirectUri: 'http://localhost:3001/api/auth/google/callback',
    })).not.toThrow();
  });

  test.each([
    'http://app.example/api/auth/google/callback',
    'http://localhost.attacker.example/api/auth/google/callback',
    'https://app.example/other',
    'https://user:password@app.example/api/auth/google/callback',
    'https://app.example/api/auth/google/callback?next=https://attacker.example',
  ])('rejects unsafe or unexpected callback URL %s', (redirectUri) => {
    expect(() => validateGoogleOAuthConfig({ ...base, redirectUri })).toThrow();
  });

  test('rejects partial credential configuration', () => {
    expect(() => validateGoogleOAuthConfig({ ...base, redirectUri: '' })).toThrow();
  });
});
