import { describe, expect, it } from 'vitest';
import { REDACTED } from '../../src/core/redaction.js';
import { redactUrlCredentials } from '../../src/crawl/normalize-url.js';
import { redactHeaders } from '../../src/safety/redact.js';

describe('redactHeaders', () => {
  it('redacts standard sensitive names case-insensitively without leaking values', () => {
    const headers = {
      Authorization: 'Bearer authorization-secret',
      COOKIE: 'cookie-secret=1',
      'Set-Cookie': 'session=setter-secret',
      'X-API-KEY': 'api-key-secret',
      'content-type': 'application/json',
    };

    const result = redactHeaders(headers);

    expect(result).toEqual({
      Authorization: '[REDACTED]',
      COOKIE: '[REDACTED]',
      'Set-Cookie': '[REDACTED]',
      'X-API-KEY': '[REDACTED]',
      'content-type': 'application/json',
    });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(headers.Authorization).toBe('Bearer authorization-secret');
  });

  it.each([
    'x-auth-token',
    'X-Refresh-Token',
    'session-id',
    'X_SESSION_KEY',
    'api_key',
    'xApiKey',
    'Proxy-Authorization',
    'Ocp-Apim-Subscription-Key',
    'ocp_apim_subscription_key',
    'X-Auth-Key',
    'x_auth_key',
    'X-API-Secret',
    'x_api_secret',
  ])('redacts a sensitive candidate header name %s', (name) => {
    expect(redactHeaders({ [name]: 'must-not-leak' })).toEqual({ [name]: '[REDACTED]' });
  });

  it('preserves non-sensitive headers without mutating the input', () => {
    const headers = { Accept: 'text/html', 'Content-Type': 'text/plain', 'Cache-Control': 'no-cache' };

    expect(redactHeaders(headers)).toEqual(headers);
    expect(redactHeaders(headers)).not.toBe(headers);
  });

  it('uses the single shared redaction marker for header values and URL credentials', () => {
    expect(REDACTED).toBe('[REDACTED]');
    expect(redactHeaders({ Authorization: 'Bearer secret' })).toEqual({ Authorization: REDACTED });
    expect(redactUrlCredentials('https://user:secret@host.test/path')).toBe(`https://${REDACTED}@host.test/path`);
  });
});
