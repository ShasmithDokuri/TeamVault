const { validateGoogleOAuthConfig } = require('../src/config');

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
