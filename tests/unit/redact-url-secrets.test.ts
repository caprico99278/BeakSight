// T25f（Task 25 の設計書 `2026-10-10-beaksight-task-25-manual-login-session-design.md` 4.6）: 認証つきの Run の成果物に書く URL の、秘密に
// 見える query の値の伏せ字の部品（`src/safety/redact.ts`）。名前の閉じた一覧と比べ方、値の置き換え、fragment を触らないこと、userinfo の伏せ字
// （`redactUrlCredentials`）と合わせること、文の中の URL、値の木の写しを固定する。
import { describe, expect, it } from 'vitest';
import { REDACTED } from '../../src/core/redaction.js';
import { redactUrlCredentials } from '../../src/crawl/normalize-url.js';
import {
  SECRET_URL_QUERY_PARAMETER_NAMES,
  isSecretUrlQueryParameterName,
  redactUrlSecrets,
  redactUrlSecretsInText,
  redactUrlSecretsInValue,
} from '../../src/safety/redact.js';

/** 秘密の値の例（テストの中だけの仮の値）。 */
const SECRET = 's3cr3t-value';

describe('SECRET_URL_QUERY_PARAMETER_NAMES and isSecretUrlQueryParameterName', () => {
  it('is the named closed list (frozen)', () => {
    expect(SECRET_URL_QUERY_PARAMETER_NAMES).toEqual([
      'token',
      'access_token',
      'id_token',
      'refresh_token',
      'auth_token',
      'session_token',
      'csrf_token',
      'xsrf_token',
      'authenticity_token',
      'jwt',
      'ticket',
      'session',
      'sessionid',
      'sid',
      'phpsessid',
      'jsessionid',
      'auth',
      'authorization',
      'key',
      'apikey',
      'api_key',
      'access_key',
      'secret',
      'client_secret',
      'password',
      'passwd',
      'pwd',
      'pass',
      'otp',
      'code',
      'state',
      'nonce',
      'csrf',
      'xsrf',
      'signature',
      'sig',
      'x-amz-signature',
      'x-amz-credential',
      'x-amz-security-token',
      'samlrequest',
      'samlresponse',
      'relaystate',
      'credential',
      'credentials',
    ]);
    expect(Object.isFrozen(SECRET_URL_QUERY_PARAMETER_NAMES)).toBe(true);
  });

  it.each([...SECRET_URL_QUERY_PARAMETER_NAMES])('matches the listed name %s', (name) => {
    expect(isSecretUrlQueryParameterName(name)).toBe(true);
    expect(isSecretUrlQueryParameterName(name.toUpperCase())).toBe(true);
  });

  it.each([
    ['Access-Token'],
    ['ACCESSTOKEN'],
    ['accessToken'],
    ['api-key'],
    ['apiKey'],
    ['API.KEY'],
    ['Session_Id'],
    ['SAMLResponse'],
    ['RelayState'],
    ['X-Amz-Signature'],
    ['_csrf'],
    ['access+token'],
  ])('matches %s regardless of case and of the separators "-", "_", "." and space', (name) => {
    expect(isSecretUrlQueryParameterName(name)).toBe(true);
  });

  it.each([['%74oken'], ['to%6Ben'], ['%54%4F%4B%45%4E'], ['%73id'], ['access%5Ftoken']])(
    'decodes the percent-encoded name %s before comparing',
    (name) => {
      expect(isSecretUrlQueryParameterName(name)).toBe(true);
    },
  );

  it.each([['page'], ['q'], ['tokens'], ['keyword'], ['author'], ['stateful'], ['postcode'], ['id'], [''], ['%zz'], ['to%6']])(
    'does not match the name %s (the comparison is the exact name, not a part of it)',
    (name) => {
      expect(isSecretUrlQueryParameterName(name)).toBe(false);
    },
  );
});

describe('redactUrlSecrets', () => {
  it.each([
    [`https://site.test/a?token=${SECRET}&page=2`, `https://site.test/a?token=${REDACTED}&page=2`],
    [`https://site.test/a?page=2&ACCESS_TOKEN=${SECRET}`, `https://site.test/a?page=2&ACCESS_TOKEN=${REDACTED}`],
    [`https://site.test/a?code=${SECRET}&state=${SECRET}`, `https://site.test/a?code=${REDACTED}&state=${REDACTED}`],
    [`/admin/report?sid=${SECRET}`, `/admin/report?sid=${REDACTED}`],
    [`?apiKey=${SECRET}`, `?apiKey=${REDACTED}`],
    [`report?password=${SECRET}`, `report?password=${REDACTED}`],
  ])('replaces the value of a secret query parameter in %s', (url, expected) => {
    expect(redactUrlSecrets(url)).toBe(expected);
  });

  it('replaces every value of a repeated name', () => {
    expect(redactUrlSecrets(`https://site.test/?token=${SECRET}&x=1&TOKEN=${SECRET}2&token=${SECRET}3`))
      .toBe(`https://site.test/?token=${REDACTED}&x=1&TOKEN=${REDACTED}&token=${REDACTED}`);
  });

  it('keeps an empty value and a name without "=" as they are (nothing to hide)', () => {
    expect(redactUrlSecrets('https://site.test/?token=&code&state=')).toBe('https://site.test/?token=&code&state=');
  });

  it('keeps the percent-encoded name as written and replaces its value', () => {
    expect(redactUrlSecrets(`https://site.test/?%74oken=${SECRET}&to%6Ben=${SECRET}`))
      .toBe(`https://site.test/?%74oken=${REDACTED}&to%6Ben=${REDACTED}`);
  });

  it('replaces the whole value up to the next separator (a value with "=", ";" and a nested "?" as separators)', () => {
    expect(redactUrlSecrets(`https://site.test/?token=${SECRET}=x`)).toBe(`https://site.test/?token=${REDACTED}`);
    expect(redactUrlSecrets(`https://site.test/?a=1;sid=${SECRET};b=2`)).toBe(`https://site.test/?a=1;sid=${REDACTED};b=2`);
    expect(redactUrlSecrets(`https://site.test/?next=/x?token=${SECRET}&y=1`)).toBe(`https://site.test/?next=/x?token=${REDACTED}&y=1`);
  });

  it('does not touch the fragment (including a query-like fragment and a "?" inside the fragment)', () => {
    expect(redactUrlSecrets(`https://site.test/a?page=1#access_token=${SECRET}`)).toBe(`https://site.test/a?page=1#access_token=${SECRET}`);
    expect(redactUrlSecrets(`https://site.test/#/route?token=${SECRET}`)).toBe(`https://site.test/#/route?token=${SECRET}`);
    expect(redactUrlSecrets(`https://site.test/a?token=${SECRET}#token=${SECRET}`))
      .toBe(`https://site.test/a?token=${REDACTED}#token=${SECRET}`);
  });

  it('keeps the other bytes of the URL as written (no re-encoding, no reordering)', () => {
    const url = `HTTPS://Site.test/%7Euser/a%20b?q=%E3%81%82&Z=1&a=+&token=${SECRET}&q=2`;
    expect(redactUrlSecrets(url)).toBe(`HTTPS://Site.test/%7Euser/a%20b?q=%E3%81%82&Z=1&a=+&token=${REDACTED}&q=2`);
  });

  it.each([
    ['https://site.test/a?page=1'],
    ['https://site.test/'],
    ['/relative/path'],
    ['not a url'],
    [''],
    ['https://site.test/a?'],
  ])('returns %s unchanged when it has no secret', (url) => {
    expect(redactUrlSecrets(url)).toBe(url);
  });

  it.each([
    ['https://user:pass@site.test/private'],
    ['https://user@site.test/'],
    ['//user:secret@site.test/scheme-relative'],
    ['http://user:secret@bad host/'],
    ['ftp://user:secret@site.test/file'],
    ['https://site.test/a@b'],
  ])('redacts the userinfo of %s in the same way as redactUrlCredentials', (url) => {
    expect(redactUrlSecrets(url)).toBe(redactUrlCredentials(url));
  });

  it('redacts both the userinfo and the secret query', () => {
    expect(redactUrlSecrets(`https://user:pass@site.test/?token=${SECRET}`)).toBe(`https://${REDACTED}@site.test/?token=${REDACTED}`);
  });

  it('is idempotent', () => {
    const once = redactUrlSecrets(`https://user:pass@site.test/?token=${SECRET}&page=1`);
    expect(redactUrlSecrets(once)).toBe(once);
  });
});

describe('redactUrlSecretsInText', () => {
  it('redacts the URLs inside a text and keeps the rest of the text', () => {
    expect(redactUrlSecretsInText(`page.goto: net::ERR_ABORTED at https://site.test/a?token=${SECRET} (desktop)`))
      .toBe(`page.goto: net::ERR_ABORTED at https://site.test/a?token=${REDACTED} (desktop)`);
    expect(redactUrlSecretsInText(`<a href="/a?sid=${SECRET}">x</a> and '?code=${SECRET}'`))
      .toBe(`<a href="/a?sid=${REDACTED}">x</a> and '?code=${REDACTED}'`);
    expect(redactUrlSecretsInText('see http://user:pass@site.test/ now')).toBe(`see http://${REDACTED}@site.test/ now`);
  });

  it('keeps a text without a URL query or userinfo unchanged', () => {
    for (const text of ['Why? token=abc', 'mail user@example.test today', 'a=1&token=2', '見出し\n本文', '']) {
      expect(redactUrlSecretsInText(text)).toBe(text);
    }
  });
});

describe('redactUrlSecretsInValue', () => {
  it('returns a redacted copy of the tree of plain objects and arrays, without changing the input or the keys', () => {
    const input = Object.freeze({
      pageUrl: `https://site.test/a?token=${SECRET}`,
      count: 3,
      flag: true,
      nothing: null,
      nested: Object.freeze({
        events: Object.freeze([Object.freeze({ url: `/b?code=${SECRET}`, method: 'GET' }), `text https://site.test/?sid=${SECRET}`]),
      }),
      [`key?token=${SECRET}`]: 'value',
    });

    const result = redactUrlSecretsInValue(input);

    expect(result).toEqual({
      pageUrl: `https://site.test/a?token=${REDACTED}`,
      count: 3,
      flag: true,
      nothing: null,
      nested: { events: [{ url: `/b?code=${REDACTED}`, method: 'GET' }, `text https://site.test/?sid=${REDACTED}`] },
      // 名前（キー）は URL ではないので、変えない。
      [`key?token=${SECRET}`]: 'value',
    });
    expect(result).not.toBe(input);
    expect(input.pageUrl).toBe(`https://site.test/a?token=${SECRET}`);
    expect(input.nested.events[0]).toEqual({ url: `/b?code=${SECRET}`, method: 'GET' });
  });

  it('keeps the values other than strings, arrays and plain objects as they are', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const date = new Date(0);
    expect(redactUrlSecretsInValue(bytes)).toBe(bytes);
    expect(redactUrlSecretsInValue(date)).toBe(date);
    expect(redactUrlSecretsInValue(42)).toBe(42);
    expect(redactUrlSecretsInValue(undefined)).toBeUndefined();
  });
});
