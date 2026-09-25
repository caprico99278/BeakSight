import { describe, expect, it } from 'vitest';
import { URL_REJECTION_REASONS } from '../../src/core/evidence-types.js';
import { MAX_URL_LENGTH } from '../../src/core/limits.js';
import { classifyUrl } from '../../src/crawl/admission-policy.js';
import {
  canonicalizeAllowedOrigins,
  hasUrlCredentials,
  isHttpProtocol,
  normalizeUrl,
  redactUrlCredentials,
} from '../../src/crawl/normalize-url.js';

describe('normalizeUrl', () => {
  it('drops tracking parameters and fragments', () => {
    expect(normalizeUrl(
      '/pricing?utm_source=x&page=2#top',
      'https://example.test/',
      new Set(['page']),
    )).toEqual({ ok: true, url: 'https://example.test/pricing?page=2' });
  });

  it('keeps only allowed query keys in code-unit sorted order', () => {
    expect(normalizeUrl(
      '/search?z=last&utm_campaign=spring&a=first&fbclid=ignored&a=second&gclid=ignored&page=2',
      'https://example.test/',
      new Set(['z', 'a', 'page']),
    )).toEqual({ ok: true, url: 'https://example.test/search?a=first&a=second&page=2&z=last' });
  });

  it('normalizes a default port without collapsing duplicate path slashes', () => {
    expect(normalizeUrl(
      'https://example.test:443/catalog//summer/',
      'https://unused.test/',
      new Set(),
    )).toEqual({ ok: true, url: 'https://example.test/catalog//summer/' });
  });

  it('decodes percent-encoded unreserved path octets into one canonical visited key', () => {
    const allowedQueryParameters = new Set<string>();

    expect(normalizeUrl('/%7eprofile', 'https://example.test/', allowedQueryParameters)).toEqual({
      ok: true,
      url: 'https://example.test/~profile',
    });
    expect(normalizeUrl('/%7Eprofile', 'https://example.test/', allowedQueryParameters)).toEqual({
      ok: true,
      url: 'https://example.test/~profile',
    });
    expect(normalizeUrl('/~profile', 'https://example.test/', allowedQueryParameters)).toEqual({
      ok: true,
      url: 'https://example.test/~profile',
    });
  });

  it('keeps reserved encoded path delimiters escaped with uppercase hexadecimal', () => {
    expect(normalizeUrl('/catalog%2farchive', 'https://example.test/', new Set())).toEqual({
      ok: true,
      url: 'https://example.test/catalog%2Farchive',
    });
  });

  it.each(['mailto:help@example.test', 'tel:+81-3-0000-0000'])('rejects %s as a navigable URL', (rawUrl) => {
    expect(normalizeUrl(rawUrl, 'https://example.test/', new Set())).toEqual({
      ok: false,
      rawUrl,
      reason: 'UNSUPPORTED_SCHEME',
    });
  });

  it.each([
    ['https://user:secret@example.test/private', 'https://[REDACTED]@example.test/private'],
    ['https://user@example.test/', 'https://[REDACTED]@example.test/'],
    ['https://:secret@example.test/', 'https://[REDACTED]@example.test/'],
    ['//user:secret@example.test/scheme-relative', '//[REDACTED]@example.test/scheme-relative'],
    ['HTTP://user:secret@EXAMPLE.TEST/upper', 'HTTP://[REDACTED]@EXAMPLE.TEST/upper'],
  ])('does not accept the credential-bearing URL %s and redacts it in the rejection', (rawUrl, redactedUrl) => {
    expect(normalizeUrl(rawUrl, 'https://example.test/', new Set())).toEqual({
      ok: false,
      rawUrl: redactedUrl,
      reason: 'CREDENTIALS_NOT_ALLOWED',
    });
  });

  it('does not accept a relative URL that inherits credentials from its base, and keeps the raw text', () => {
    expect(normalizeUrl('/relative', 'https://user:secret@example.test/', new Set())).toEqual({
      ok: false,
      rawUrl: '/relative',
      reason: 'CREDENTIALS_NOT_ALLOWED',
    });
  });

  it('redacts credentials in the raw URL of other rejections', () => {
    expect(normalizeUrl('ftp://user:secret@example.test/file', 'https://example.test/', new Set())).toEqual({
      ok: false,
      rawUrl: 'ftp://[REDACTED]@example.test/file',
      reason: 'UNSUPPORTED_SCHEME',
    });
    expect(normalizeUrl('http://user:secret@bad host/', 'https://example.test/', new Set())).toEqual({
      ok: false,
      rawUrl: 'http://[REDACTED]@bad host/',
      reason: 'INVALID_URL',
    });
  });

  it('accepts a normalized URL of exactly MAX_URL_LENGTH code units', () => {
    const origin = 'https://example.test';
    const path = `/${'a'.repeat(MAX_URL_LENGTH - origin.length - 1)}`;

    expect(normalizeUrl(path, `${origin}/`, new Set())).toEqual({ ok: true, url: `${origin}${path}` });
  });

  it('does not accept a URL whose normalized form is longer than MAX_URL_LENGTH', () => {
    const origin = 'https://example.test';
    const path = `/${'a'.repeat(MAX_URL_LENGTH - origin.length)}`;

    expect(normalizeUrl(path, `${origin}/`, new Set())).toEqual({ ok: false, rawUrl: path, reason: 'URL_TOO_LONG' });
  });

  it('measures the length after normalization, so a short relative URL with a long base is not accepted', () => {
    const base = `https://example.test/${'b'.repeat(MAX_URL_LENGTH)}/`;

    expect(normalizeUrl('next', base, new Set())).toEqual({ ok: false, rawUrl: 'next', reason: 'URL_TOO_LONG' });
  });

  it('uses only the closed rejection reason codes', () => {
    const rejections = [
      normalizeUrl('mailto:help@example.test', 'https://example.test/', new Set()),
      normalizeUrl('http://[::1', 'https://example.test/', new Set()),
      normalizeUrl('https://user@example.test/', 'https://example.test/', new Set()),
      normalizeUrl(`/${'a'.repeat(MAX_URL_LENGTH)}`, 'https://example.test/', new Set()),
    ];

    const reasons = rejections.map((result) => (result.ok ? null : result.reason));
    expect(reasons).toEqual(['UNSUPPORTED_SCHEME', 'INVALID_URL', 'CREDENTIALS_NOT_ALLOWED', 'URL_TOO_LONG']);
    expect(new Set(reasons)).toEqual(new Set(URL_REJECTION_REASONS));
  });
});

describe('hasUrlCredentials', () => {
  it.each([
    ['https://user:secret@example.test/', true],
    ['https://user@example.test/', true],
    ['https://:secret@example.test/', true],
    ['https://example.test/', false],
    ['https://example.test/path@with-at', false],
  ])('reports whether %s carries credentials', (url, expected) => {
    expect(hasUrlCredentials(new URL(url))).toBe(expected);
  });
});

describe('redactUrlCredentials', () => {
  const baseUrl = 'https://example.test/current/';

  it.each([
    '/relative?query=1#top',
    'relative-offer',
    'https://example.test/path@with-at',
    'mailto:help@example.test',
    'tel:+81-3-0000-0000',
    'javascript:void(0)',
    'http://[::1',
    '',
  ])('returns the credential-free raw URL %j unchanged', (rawUrl) => {
    expect(redactUrlCredentials(rawUrl, baseUrl)).toBe(rawUrl);
  });

  it.each([
    ['https://user:secret@example.test/a@b?q=1#h', 'https://[REDACTED]@example.test/a@b?q=1#h'],
    ['  https://user:secret@example.test/', '  https://[REDACTED]@example.test/'],
    ['https://us@er:se@cret@example.test/', 'https://[REDACTED]@example.test/'],
    ['https:\\\\user:secret@example.test/', 'https:\\\\[REDACTED]@example.test/'],
    ['//user:secret@example.test/', '//[REDACTED]@example.test/'],
    ['ftp://user:secret@example.test/file', 'ftp://[REDACTED]@example.test/file'],
    ['http://user:secret@bad host/', 'http://[REDACTED]@bad host/'],
    ['https://ユーザー:秘密@example.test/', 'https://[REDACTED]@example.test/'],
  ])('redacts the credentials in %j', (rawUrl, expected) => {
    expect(redactUrlCredentials(rawUrl, baseUrl)).toBe(expected);
  });

  it('does not rewrite a raw URL whose only credentials come from the base URL', () => {
    expect(redactUrlCredentials('/relative', 'https://user:secret@example.test/')).toBe('/relative');
  });

  it('falls back to a rebuilt URL without the credentials when the raw text cannot be redacted in place', () => {
    const redacted = redactUrlCredentials('ht\ttps://user:secret@example.test/path?q=1#h', baseUrl);

    expect(redacted).toBe('https://[REDACTED]@example.test/path?q=1#h');
  });

  it('never returns the secret for any credential-bearing input', () => {
    for (const rawUrl of [
      'https://user:secret@example.test/',
      'ht\ttps://user:secret@example.test/',
      'https://user:secret@example.test:8443/',
      'https://user:secret@例え.example.test/',
      '\u0000https://user:secret@example.test/',
    ]) {
      const redacted = redactUrlCredentials(rawUrl, baseUrl);
      expect(redacted, rawUrl).not.toContain('secret');
      expect(redacted, rawUrl).not.toContain('user');
    }
  });
});

describe('isHttpProtocol', () => {
  it.each(['http:', 'https:'])('accepts %s', (protocol) => {
    expect(isHttpProtocol(protocol)).toBe(true);
  });

  it.each(['HTTP:', 'https', 'http', 'ftp:', 'file:', 'mailto:', 'tel:', 'javascript:', 'data:', 'blob:', 'ws:', 'wss:', ''])(
    'rejects %s',
    (protocol) => {
      expect(isHttpProtocol(protocol)).toBe(false);
    },
  );

  it('agrees with the protocol that URL parsing reports', () => {
    expect(isHttpProtocol(new URL('HTTPS://EXAMPLE.TEST/').protocol)).toBe(true);
    expect(isHttpProtocol(new URL('mailto:help@example.test').protocol)).toBe(false);
  });
});

describe('canonicalizeAllowedOrigins', () => {
  const policyEntries = [
    'https://example.test',
    'https://example.test/',
    'HTTPS://EXAMPLE.TEST:443/path?query=1#fragment',
    'http://example.test:80',
    'http://example.test:8080/',
    'https://sub.example.test',
    'https://user@example.test',
    'https://user:secret@example.test',
    'https://:secret@example.test',
    'ftp://example.test',
    'file:///tmp/example',
    'data:text/plain,example',
    'javascript:alert(1)',
    'mailto:help@example.test',
    'ws://example.test',
    'blob:https://example.test/uuid',
    'null',
    '',
    'not a url',
    'https://',
    '  https://padded.example.test  ',
    'https://[::1]:8443',
    'https://127.0.0.1',
    'https://xn--r8jz45g.example.test',
    'https://例え.example.test',
  ];

  it('keeps only credential-free HTTP(S) origins in their canonical serialization', () => {
    expect([...canonicalizeAllowedOrigins(new Set([
      'HTTPS://EXAMPLE.TEST:443/path',
      'http://example.test:80',
      'https://user:secret@example.test',
      'ftp://example.test',
      'not a url',
    ]))]).toEqual(['https://example.test', 'http://example.test']);
  });

  it.each<[string, readonly string[]]>([
    ['https://example.test', ['https://example.test']],
    ['https://example.test/', ['https://example.test']],
    ['HTTPS://EXAMPLE.TEST:443/path?query=1#fragment', ['https://example.test']],
    ['http://example.test:80', ['http://example.test']],
    ['http://example.test:8080/', ['http://example.test:8080']],
    ['https://sub.example.test', ['https://sub.example.test']],
    ['https://user@example.test', []],
    ['https://user:secret@example.test', []],
    ['https://:secret@example.test', []],
    ['ftp://example.test', []],
    ['file:///tmp/example', []],
    ['data:text/plain,example', []],
    ['javascript:alert(1)', []],
    ['mailto:help@example.test', []],
    ['ws://example.test', []],
    ['blob:https://example.test/uuid', []],
    ['null', []],
    ['', []],
    ['not a url', []],
    ['https://', []],
    ['  https://padded.example.test  ', ['https://padded.example.test']],
    ['https://[::1]:8443', ['https://[::1]:8443']],
    ['https://127.0.0.1', ['https://127.0.0.1']],
    ['https://xn--r8jz45g.example.test', ['https://xn--r8jz45g.example.test']],
    ['https://例え.example.test', ['https://xn--r8jz45g.example.test']],
  ])('canonicalizes the policy entry %j to the fixed origin set %j', (entry, expected) => {
    expect([...canonicalizeAllowedOrigins(new Set([entry]))]).toEqual(expected);
  });

  it('canonicalizes the whole representative policy to a fixed, de-duplicated origin set', () => {
    expect(new Set(canonicalizeAllowedOrigins(new Set(policyEntries)))).toEqual(new Set([
      'https://example.test',
      'http://example.test',
      'http://example.test:8080',
      'https://sub.example.test',
      'https://padded.example.test',
      'https://[::1]:8443',
      'https://127.0.0.1',
      'https://xn--r8jz45g.example.test',
    ]));
  });

  it.each<[string, readonly string[], string, string]>([
    ['an equivalent spelling of the allowed origin', ['https://example.test'], 'HTTPS://EXAMPLE.TEST:443/probe', 'INTERNAL_NAVIGABLE'],
    ['an allowed origin written with path, query and fragment', ['HTTPS://EXAMPLE.TEST:443/path?query=1#fragment'], 'https://example.test/probe', 'INTERNAL_NAVIGABLE'],
    ['an allowed origin written with its default port', ['http://example.test:80'], 'http://example.test/probe', 'INTERNAL_NAVIGABLE'],
    ['a padded allowed origin', ['  https://padded.example.test  '], 'https://padded.example.test/probe', 'INTERNAL_NAVIGABLE'],
    ['an IPv6 allowed origin', ['https://[::1]:8443'], 'https://[::1]:8443/probe', 'INTERNAL_NAVIGABLE'],
    ['an IDN allowed origin against its punycode form', ['https://例え.example.test'], 'https://xn--r8jz45g.example.test/probe', 'INTERNAL_NAVIGABLE'],
    ['the other scheme of an allowed origin', ['https://example.test'], 'http://example.test/probe', 'EXTERNAL_RECORD_ONLY'],
    ['a non-default port of an allowed origin', ['http://example.test'], 'http://example.test:8080/probe', 'EXTERNAL_RECORD_ONLY'],
    ['a subdomain of an allowed origin', ['https://example.test'], 'https://sub.example.test/probe', 'EXTERNAL_RECORD_ONLY'],
    ['an unlisted origin', ['https://example.test'], 'https://unlisted.example.test/probe', 'EXTERNAL_RECORD_ONLY'],
    ['an allowed-origin entry carrying a username', ['https://user@example.test'], 'https://example.test/probe', 'EXTERNAL_RECORD_ONLY'],
    ['an allowed-origin entry carrying a password', ['https://:secret@example.test'], 'https://example.test/probe', 'EXTERNAL_RECORD_ONLY'],
    ['a non-HTTP(S) allowed-origin entry', ['ftp://example.test', 'ws://example.test'], 'https://example.test/probe', 'EXTERNAL_RECORD_ONLY'],
    ['a blob allowed-origin entry', ['blob:https://example.test/uuid'], 'https://example.test/probe', 'EXTERNAL_RECORD_ONLY'],
    ['unparsable allowed-origin entries', ['not a url', '', 'null', 'https://'], 'https://example.test/probe', 'EXTERNAL_RECORD_ONLY'],
    ['the whole representative policy', policyEntries, 'https://sub.example.test/probe', 'INTERNAL_NAVIGABLE'],
    ['the whole representative policy against an unlisted origin', policyEntries, 'https://unlisted.example.test/probe', 'EXTERNAL_RECORD_ONLY'],
  ])('lets the crawl admission policy classify %s to a fixed kind', (_case, allowedOrigins, url, expectedKind) => {
    expect(classifyUrl(new URL(url), { allowedOrigins: new Set(allowedOrigins) }).kind).toBe(expectedKind);
  });
});
