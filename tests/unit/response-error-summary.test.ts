// AUD-7: 4xx・5xx の応答の本文の要旨の切り方と、秘密に見える値の検査（ブラウザを使わない）。
// - JSON は、許した最上位の鍵（code・error・error_code・message・detail・title・status・type）だけを、値の型と、200 文字までの値で残す。
// - text/plain は先頭の 200 文字、HTML は `<title>` だけ。値は全部 `isSecretLikeText` に通し、当たれば値を残さず印だけを残す。
// - 本文を読めない応答は、要旨なしとして理由を残す。
import { describe, expect, it } from 'vitest';
import {
  RESPONSE_SUMMARY_JSON_KEYS,
  RESPONSE_SUMMARY_TEXT_LENGTH,
  summarizeErrorResponseBody,
  unreadableErrorResponseBody,
} from '../../src/evidence/response-error-summary.js';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('AUD-7: the summary of an error response body', () => {
  it('keeps only the allowed top level keys of JSON, with the value type', () => {
    expect(RESPONSE_SUMMARY_JSON_KEYS).toEqual(['code', 'error', 'error_code', 'message', 'detail', 'title', 'status', 'type']);
    const body = JSON.stringify({
      code: 'NO_DATA', status: 406, message: 'データはありません', detail: null, error: { nested: true }, type: ['a'],
      access_token: 'abcdef0123456789', user: 'someone',
    });
    expect(summarizeErrorResponseBody(bytes(body), 'application/json; charset=utf-8')).toEqual({
      status: 'OBSERVED',
      format: 'JSON',
      fields: [
        { key: 'code', valueType: 'string', value: 'NO_DATA', secretLike: false, truncated: false },
        { key: 'error', valueType: 'object', value: '{"nested":true}', secretLike: false, truncated: false },
        { key: 'message', valueType: 'string', value: 'データはありません', secretLike: false, truncated: false },
        { key: 'detail', valueType: 'null', value: 'null', secretLike: false, truncated: false },
        { key: 'status', valueType: 'number', value: '406', secretLike: false, truncated: false },
        { key: 'type', valueType: 'array', value: '["a"]', secretLike: false, truncated: false },
      ],
    });
  });

  it('keeps a mark instead of a secret-like value', () => {
    const body = JSON.stringify({ message: 'expired: access_token=abcdef0123456789', detail: 'Bearer eyJhbGciOiJIUzI1NiJ9.e30.x1' });
    const summary = summarizeErrorResponseBody(bytes(body), 'application/problem+json');
    expect(summary).toEqual({
      status: 'OBSERVED',
      format: 'JSON',
      fields: [
        { key: 'message', valueType: 'string', value: null, secretLike: true, truncated: false },
        { key: 'detail', valueType: 'string', value: null, secretLike: true, truncated: false },
      ],
    });
    expect(JSON.stringify(summary)).not.toContain('abcdef0123456789');
  });

  it('cuts the values to 200 characters', () => {
    expect(RESPONSE_SUMMARY_TEXT_LENGTH).toBe(200);
    const long = 'あ'.repeat(250);
    expect(summarizeErrorResponseBody(bytes(JSON.stringify({ message: long })), 'application/json')).toEqual({
      status: 'OBSERVED', format: 'JSON', fields: [{ key: 'message', valueType: 'string', value: 'あ'.repeat(200), secretLike: false, truncated: true }],
    });
    expect(summarizeErrorResponseBody(bytes(long), 'text/plain')).toEqual({
      status: 'OBSERVED', format: 'TEXT', fields: [{ key: 'text', valueType: 'string', value: 'あ'.repeat(200), secretLike: false, truncated: true }],
    });
  });

  it('keeps only the title of HTML', () => {
    const html = '<!doctype html><html><head><title> 404  Not Found </title></head><body><p>token=abcdef0123456789</p></body></html>';
    expect(summarizeErrorResponseBody(bytes(html), 'text/html; charset=utf-8')).toEqual({
      status: 'OBSERVED', format: 'HTML', fields: [{ key: 'title', valueType: 'string', value: '404 Not Found', secretLike: false, truncated: false }],
    });
    expect(summarizeErrorResponseBody(bytes('<html><body>no title</body></html>'), 'text/html')).toEqual({ status: 'OBSERVED', format: 'HTML', fields: [] });
  });

  it('leaves no summary with a reason when the body cannot be summarized', () => {
    expect(summarizeErrorResponseBody(bytes(''), 'application/json')).toEqual({ status: 'NONE', reason: 'EMPTY_BODY', errorText: null });
    expect(summarizeErrorResponseBody(bytes('{oops'), 'application/json')).toEqual({ status: 'NONE', reason: 'UNPARSABLE_JSON', errorText: null });
    expect(summarizeErrorResponseBody(bytes('[1,2]'), 'application/json')).toEqual({ status: 'OBSERVED', format: 'JSON', fields: [] });
    expect(summarizeErrorResponseBody(bytes('GIF89a'), 'image/gif')).toEqual({ status: 'NONE', reason: 'UNSUPPORTED_CONTENT_TYPE', errorText: null });
    expect(summarizeErrorResponseBody(bytes('plain'), null)).toEqual({ status: 'NONE', reason: 'UNSUPPORTED_CONTENT_TYPE', errorText: null });
    expect(unreadableErrorResponseBody(new Error('Response body is unavailable for redirect responses'))).toEqual({
      status: 'NONE', reason: 'UNREADABLE', errorText: 'Response body is unavailable for redirect responses',
    });
  });
});
