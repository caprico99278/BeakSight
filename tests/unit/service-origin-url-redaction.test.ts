// T35c（Task 35 の設計書 3.6）: 成果物に書く、承認したサービスの Origin の URL の伏せ方（`src/core/url-redaction.ts` の `redactServiceOriginUrl`、
// `src/safety/redact.ts` の `redactUrlSecretsInText`・`redactUrlSecretsInValue` の `serviceOrigins`）。
// - サービスの Origin の URL: query の値をすべて伏せ（名前は残す）、path の値に見える区切り（メールアドレス、長い base64url、16 進、JWT の形）を伏せる。
// - ほかの Origin の URL: 今どおり、秘密に見える名前の値と userinfo だけを伏せる（`serviceOrigins` を渡さなければ、今と同じ）。
// - Origin の後に別の文字が続く（`https://api.example.test.evil`）URL は、サービスの Origin として扱わない。
// - T35R-fix（T35R の I-1・M-2・M-3）: 文の中の候補のうち、`http(s)://`・`ws(s)://` で始まる部分ごとに Origin を判定する（前置き `url=`・`(`・`[`・
//   `{url:`・`x,` の後の URL と、許可 Origin の URL の query に入ったサービスの Origin の URL も伏せる）。サービスのホストへの `ws://`・`wss://` の URL も
//   サービスの Origin の URL として伏せる（スキームを http(s) に読み替えてホストとポートで比べる）。fragment の値も伏せる（T35c の `#top` を残す期待は、
//   意図して直した）。
// 例の値は、匿名の値（`example.test`、`example.invalid`）だけを使う。
import { describe, expect, it } from 'vitest';
import { REDACTED } from '../../src/core/redaction.js';
import { redactServiceOriginUrl, redactUrlQueryValues } from '../../src/core/url-redaction.js';
import { redactUrlSecrets, redactUrlSecretsInText, redactUrlSecretsInValue } from '../../src/safety/redact.js';

const SERVICE_ORIGIN = 'https://api.example.test';
const APP_ORIGIN = 'https://app.example.test';
const OPTIONS = Object.freeze({ serviceOrigins: [SERVICE_ORIGIN] });
const EMAIL = 'member1@example.invalid';
const LONG_ID = 'AbCdEfGhIjKlMnOpQrStUv12';

describe('T35c: the service origin URLs in the artifacts', () => {
  it('redacts every query value and the value-like path segments of a service origin URL, keeping the names', () => {
    expect(redactServiceOriginUrl(`${SERVICE_ORIGIN}/rest/v1/members?select=*&email=eq.${EMAIL}&id=eq.1`))
      .toBe(`${SERVICE_ORIGIN}/rest/v1/members?select=${REDACTED}&email=${REDACTED}&id=${REDACTED}`);
    expect(redactServiceOriginUrl(`${SERVICE_ORIGIN}/rest/v1/members/${EMAIL}/${LONG_ID}#top`))
      .toBe(`${SERVICE_ORIGIN}/rest/v1/members/${REDACTED}/${REDACTED}#${REDACTED}`);
    expect(redactServiceOriginUrl(`${SERVICE_ORIGIN}/rest/v1/rpc/list_members_with_details_v2`))
      .toBe(`${SERVICE_ORIGIN}/rest/v1/rpc/list_members_with_details_v2`);
    expect(redactServiceOriginUrl(`${SERVICE_ORIGIN}?q=1`)).toBe(`${SERVICE_ORIGIN}?q=${REDACTED}`);
  });

  it('keeps the query walker of the secret-like names (moved to core) unchanged', () => {
    expect(redactUrlQueryValues('/x?token=abc&page=2#t', (name) => name === 'token')).toBe(`/x?token=${REDACTED}&page=2#t`);
    expect(redactUrlSecrets(`${APP_ORIGIN}/admin?access_token=abc&page=2`)).toBe(`${APP_ORIGIN}/admin?access_token=${REDACTED}&page=2`);
  });

  it('redacts the service origin URLs in a text and in a value only with the service origins', () => {
    const text = `GET ${SERVICE_ORIGIN}/rest/v1/members?email=eq.${EMAIL} and ${APP_ORIGIN}/admin?page=2 and ${SERVICE_ORIGIN}/users/${EMAIL}`;
    expect(redactUrlSecretsInText(text, OPTIONS)).toBe(
      `GET ${SERVICE_ORIGIN}/rest/v1/members?email=${REDACTED} and ${APP_ORIGIN}/admin?page=2 and ${SERVICE_ORIGIN}/users/${REDACTED}`,
    );
    expect(redactUrlSecretsInText(text)).toBe(text);
    expect(redactUrlSecretsInValue({ url: `${SERVICE_ORIGIN}/rest/v1/members?select=*`, n: 1 }, OPTIONS))
      .toEqual({ url: `${SERVICE_ORIGIN}/rest/v1/members?select=${REDACTED}`, n: 1 });
  });

  it('does not treat another origin that starts with the service origin as the service origin', () => {
    const other = `${SERVICE_ORIGIN}.evil/x?select=*`;
    expect(redactUrlSecretsInText(other, OPTIONS)).toBe(other);
    expect(redactUrlSecretsInText(`${SERVICE_ORIGIN}:8443/x?select=*`, OPTIONS)).toBe(`${SERVICE_ORIGIN}:8443/x?select=*`);
  });

  it('gives the same value when applied twice', () => {
    const once = redactUrlSecretsInText(`${SERVICE_ORIGIN}/a/${EMAIL}?x=1`, OPTIONS);
    expect(redactUrlSecretsInText(once, OPTIONS)).toBe(once);
  });
});

describe('T35R-fix: the service origin URLs after a prefix, in another URL, of a WebSocket, and with a fragment', () => {
  const query = `email=eq.${EMAIL}`;

  it.each([
    ['url=', ''],
    ['next=', ''],
    ['(', ')'],
    ['[', ']'],
    ['{url:', '}'],
    ['x,', ''],
    ['fetch failed (', ')'],
  ])('redacts the query value of a service origin URL after the prefix %s', (prefix, suffix) => {
    const text = `${prefix}${SERVICE_ORIGIN}/rest/v1/a?${query}${suffix}`;
    const redacted = redactUrlSecretsInText(text, OPTIONS);
    expect(redacted).not.toContain(EMAIL);
    expect(redacted.startsWith(`${prefix}${SERVICE_ORIGIN}/rest/v1/a?email=${REDACTED}`)).toBe(true);
    expect(redactUrlSecretsInText(text)).toContain(EMAIL);
  });

  // T35R2-fix（T35R2 の I-1）: サービスの Origin の URL は、区切る前に、その URL の全体（query の値に入った別の絶対形の URL を含めて、候補の終わり
  // まで）を伏せる。レビュー担当の実験（T35R2 の `redact2.t35r.test.ts`）の形。
  it.each([
    ['another URL with a query in the query', `${SERVICE_ORIGIN}/rest?next=${APP_ORIGIN}/admin?email=${EMAIL}`, `${SERVICE_ORIGIN}/rest?next=${REDACTED}?email=${REDACTED}`],
    ['another URL after a value', `${SERVICE_ORIGIN}/rest?email=${EMAIL}&next=${APP_ORIGIN}/admin`, `${SERVICE_ORIGIN}/rest?email=${REDACTED}&next=${REDACTED}`],
    ['an origin in the query', `${SERVICE_ORIGIN}/rest?q=${APP_ORIGIN}`, `${SERVICE_ORIGIN}/rest?q=${REDACTED}`],
    ['a third origin URL with a query in the query', `${SERVICE_ORIGIN}/rest?ref=https://cdn.example.invalid/a?email=${EMAIL}`,
      `${SERVICE_ORIGIN}/rest?ref=${REDACTED}?email=${REDACTED}`],
  ])('redacts the whole service origin URL with %s', (_name, text, expected) => {
    expect(redactUrlSecretsInText(text, OPTIONS)).toBe(expected);
    expect(redactUrlSecretsInText(`url=${text}`, OPTIONS)).toBe(`url=${expected}`);
  });

  it('redacts a service origin URL in the query of an allowed origin URL, keeping the allowed origin URL', () => {
    const text = `${APP_ORIGIN}/admin?next=${SERVICE_ORIGIN}/rest/v1/b?${query}`;
    expect(redactUrlSecretsInText(text, OPTIONS)).toBe(`${APP_ORIGIN}/admin?next=${SERVICE_ORIGIN}/rest/v1/b?email=${REDACTED}`);
  });

  it('redacts the WebSocket URLs to the service host, but not to another host', () => {
    const ws = `ws://api.example.test:80/realtime/v1/websocket?tenant=t1`;
    expect(redactUrlSecretsInText(`wss://api.example.test/realtime/v1/websocket?apikey=k&tenant=t1`, OPTIONS))
      .toBe(`wss://api.example.test/realtime/v1/websocket?apikey=${REDACTED}&tenant=${REDACTED}`);
    expect(redactUrlSecretsInText(`open wss://api.example.test.evil/x?tenant=t1`, OPTIONS)).toBe('open wss://api.example.test.evil/x?tenant=t1');
    // `ws://` のホストとポートは、`http://` の Origin と比べる（`https://api.example.test` の 443 とは違う）。
    expect(redactUrlSecretsInText(ws, OPTIONS)).toBe(ws);
    expect(redactUrlSecretsInText(ws, { serviceOrigins: ['http://api.example.test'] }))
      .toBe(`ws://api.example.test:80/realtime/v1/websocket?tenant=${REDACTED}`);
  });

  it('redacts the fragment values of a service origin URL, keeping the names', () => {
    expect(redactServiceOriginUrl(`${SERVICE_ORIGIN}/rest/v1/q#x=${EMAIL}&y=1`)).toBe(`${SERVICE_ORIGIN}/rest/v1/q#x=${REDACTED}&y=${REDACTED}`);
    expect(redactServiceOriginUrl(`${SERVICE_ORIGIN}/rest/v1/q?a=1#${EMAIL}`)).toBe(`${SERVICE_ORIGIN}/rest/v1/q?a=${REDACTED}#${REDACTED}`);
    expect(redactServiceOriginUrl(`${SERVICE_ORIGIN}/rest/v1/q#`)).toBe(`${SERVICE_ORIGIN}/rest/v1/q#`);
    const once = redactServiceOriginUrl(`${SERVICE_ORIGIN}/q#x=${EMAIL}`);
    expect(redactServiceOriginUrl(once)).toBe(once);
  });
});
