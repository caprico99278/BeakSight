import { describe, expect, it } from 'vitest';
import { classifyUrl } from '../../src/crawl/admission-policy.js';

const policy = { allowedOrigins: new Set(['https://example.test']) };

describe('classifyUrl', () => {
  it('admits an HTTP(S) URL only when its origin is allowed', () => {
    expect(classifyUrl(new URL('https://example.test/catalog'), policy)).toEqual({
      kind: 'INTERNAL_NAVIGABLE',
      url: 'https://example.test/catalog',
    });
  });

  it('records an HTTP(S) URL outside the allowed origins without admitting it', () => {
    expect(classifyUrl(new URL('https://external.test/catalog'), policy)).toEqual({
      kind: 'EXTERNAL_RECORD_ONLY',
      url: 'https://external.test/catalog',
    });
  });

  it('records a non-HTTP(S) URL as special-scheme evidence', () => {
    expect(classifyUrl(new URL('mailto:help@example.test'), policy)).toEqual({
      kind: 'SPECIAL_SCHEME_RECORD_ONLY',
      rawUrl: 'mailto:help@example.test',
      scheme: 'mailto',
    });
  });

  it('rejects an HTTP(S) URL carrying credentials even when its origin is allowed', () => {
    expect(classifyUrl(new URL('https://user:secret@example.test/private'), policy)).toEqual({
      kind: 'REJECTED_INVALID',
      rawUrl: 'https://user:secret@example.test/private',
      reason: 'credential-bearing HTTP(S) URL',
    });
  });

  it('canonicalizes equivalent allowed-origin spellings and ignores invalid policy entries', () => {
    const policyWithEquivalentOrigin = {
      allowedOrigins: new Set([
        'HTTPS://EXAMPLE.TEST:443/a/path/',
        'not a URL',
        'mailto:help@example.test',
      ]),
    };

    expect(classifyUrl(new URL('https://example.test/catalog'), policyWithEquivalentOrigin)).toEqual({
      kind: 'INTERNAL_NAVIGABLE',
      url: 'https://example.test/catalog',
    });
    expect(classifyUrl(new URL('https://other.test/catalog'), policyWithEquivalentOrigin)).toEqual({
      kind: 'EXTERNAL_RECORD_ONLY',
      url: 'https://other.test/catalog',
    });
  });
});
