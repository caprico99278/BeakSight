// T30b（Task 30 の設計書 `2026-10-13-beaksight-task-30-approved-create-design.md` 3 章の「送る中身の照合」、10 章の 2）: 書き込みの段の
// 送る中身の照合（`checkWritePayload`。`src/safety/write-payload-policy.ts`。純粋な関数）。
// - (a) method・Origin・path の完全な一致（Task 26 と同じ比べ方。query と fragment があれば止める）と、main frame のナビゲーション。
// - (b) enctype は `application/x-www-form-urlencoded` と `multipart/form-data` だけ（`text/plain` などは止める）。承認の enctype と同じもの。
// - (c) 本文の欄の名前は、送る欄と、承認した候補の hidden・readonly の欄（と、空の file の欄）だけ。同じ名前の重複も止める。
// - (d) 送る欄の値は、生成した値と完全に一致（urlencoded の decode、multipart の部品の解釈。値は UTF-8 の bytes で比べる）。
// - (e) file の部品は空（ファイル名も中身もない）。
// - (f) 文書の文字コードが UTF-8 でなければ止める（得られなければ止める）。
// - (g) 本文が取れない・切れている・上限を超える、は止める。
// - hidden・readonly の欄の値（CSRF のトークンを含む）は、結果に出ない（目印の値で確かめる）。
// 例の値は、匿名の値（`example.com`、`example.invalid`）だけを使う。
import { describe, expect, it } from 'vitest';
import {
  MAX_WRITE_PAYLOAD_BYTES,
  WRITE_FORM_ENCTYPES,
  WRITE_METHOD_OVERRIDES,
  WRITE_PAYLOAD_DECISIONS,
  checkWritePayload,
  type WritePayloadDecision,
  type WritePayloadExpectation,
  type WriteRequestFacts,
} from '../../src/safety/write-payload-policy.js';

const ORIGIN = 'https://example.com';
const ENDPOINT_URL = `${ORIGIN}/items`;
/** CSRF のトークンの目印の値（結果と例外の文に出ないことを確かめる）。 */
const CSRF_MARKER = 'CSRF-MARKER-7f3a9c';
const READONLY_MARKER = 'READONLY-MARKER-51be';
const BOUNDARY = '----WebKitFormBoundaryAbC123xyz';
const MULTIPART_CONTENT_TYPE = `multipart/form-data; boundary=${BOUNDARY}`;
const URLENCODED = 'application/x-www-form-urlencoded';
const MULTIPART = 'multipart/form-data';

const expectationOf = (enctype: WritePayloadExpectation['request']['enctype'], extra: Partial<WritePayloadExpectation> = {}): WritePayloadExpectation => ({
  request: { origin: ORIGIN, path: '/items', enctype },
  submittedFields: [
    { name: 'customer_name', value: '山田 太郎' },
    { name: 'memo', value: 'a&b=c+d%e' },
  ],
  passthroughFieldNames: ['csrf_token', 'code'],
  emptyFileFieldNames: [],
  ...extra,
});

const base64 = (text: string, encoding: BufferEncoding = 'utf8'): string => Buffer.from(text, encoding).toString('base64');

const factsOf = (contentType: string | null, body: string | null, extra: Partial<WriteRequestFacts> = {}): WriteRequestFacts => ({
  method: 'POST',
  url: ENDPOINT_URL,
  isMainFrameNavigation: true,
  contentType,
  hasPostData: body !== null,
  postDataEntries: body === null ? null : [{ bytes: base64(body, 'latin1') }],
  documentCharset: 'UTF-8',
  ...extra,
});

/** ブラウザの urlencoded の形（UTF-8 の percent-encode、空白は `+`）。 */
const urlencodedBody = (pairs: readonly (readonly [string, string])[]): string => pairs
  .map(([name, value]) => `${encodeForm(name)}=${encodeForm(value)}`)
  .join('&');
const encodeForm = (text: string): string => encodeURIComponent(text).split('%20').join('+');

const VALID_URLENCODED_PAIRS: readonly (readonly [string, string])[] = [
  ['csrf_token', CSRF_MARKER],
  ['customer_name', '山田 太郎'],
  ['memo', 'a&b=c+d%e'],
  ['code', READONLY_MARKER],
];

/** ブラウザの multipart の形（latin1 の文字列で bytes を表す）。 */
const multipartBody = (parts: readonly { readonly header: string; readonly content: string }[], closing = true): string =>
  `${parts.map((part) => `--${BOUNDARY}\r\n${part.header}\r\n\r\n${part.content}\r\n`).join('')}${closing ? `--${BOUNDARY}--\r\n` : ''}`;
const utf8AsLatin1 = (text: string): string => Buffer.from(text, 'utf8').toString('latin1');
const textPart = (name: string, value: string): { readonly header: string; readonly content: string } => ({
  header: `Content-Disposition: form-data; name="${utf8AsLatin1(name)}"`,
  content: utf8AsLatin1(value),
});
const filePart = (name: string, filename: string, content: string): { readonly header: string; readonly content: string } => ({
  header: `Content-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: application/octet-stream`,
  content,
});
const VALID_MULTIPART_PARTS = [
  textPart('csrf_token', CSRF_MARKER),
  textPart('customer_name', '山田 太郎'),
  textPart('memo', 'a&b=c+d%e'),
  textPart('code', READONLY_MARKER),
];

const check = (expectation: WritePayloadExpectation, facts: WriteRequestFacts): WritePayloadDecision => checkWritePayload(expectation, facts);

describe('T30b: the closed lists of the write payload check', () => {
  it('closes the decisions and the allowed enctypes, and names the body limit', () => {
    expect(WRITE_PAYLOAD_DECISIONS).toEqual([
      'ALLOW',
      'EXPECTATION_INVALID',
      'NOT_POST',
      'NOT_MAIN_FRAME_NAVIGATION',
      'QUERY_OR_FRAGMENT_PRESENT',
      'ENDPOINT_MISMATCH',
      'DOCUMENT_CHARSET_UNKNOWN',
      'DOCUMENT_CHARSET_NOT_UTF8',
      'ENCTYPE_NOT_ALLOWED',
      'ENCTYPE_MISMATCH',
      'BODY_UNAVAILABLE',
      'BODY_INCOMPLETE',
      'BODY_TOO_LARGE',
      'BODY_MALFORMED',
      'UNKNOWN_FIELD',
      'DUPLICATE_FIELD',
      'SUBMITTED_FIELD_MISSING',
      'VALUE_MISMATCH',
      'FILE_NOT_EMPTY',
      'METHOD_OVERRIDE_MISMATCH',
      // T31c: UPDATE の画面の照合（`tests/unit/write-payload-update.test.ts`）。
      'UNEXPECTED_FIELD_PRESENT',
      'PASSTHROUGH_VALUE_MISMATCH',
      'CHECKBOX_PAIR_MISMATCH',
    ]);
    expect(WRITE_METHOD_OVERRIDES).toEqual(['PUT', 'PATCH']);
    expect(WRITE_FORM_ENCTYPES).toEqual([URLENCODED, MULTIPART]);
    expect(MAX_WRITE_PAYLOAD_BYTES).toBe(1_048_576);
  });
});

describe('T30b: the approved urlencoded and multipart bodies', () => {
  it('allows the urlencoded body of the approved fields (the hidden and readonly values are not compared)', () => {
    expect(check(expectationOf(URLENCODED), factsOf(URLENCODED, urlencodedBody(VALID_URLENCODED_PAIRS)))).toBe('ALLOW');
  });

  it('allows the multipart body of the approved fields', () => {
    expect(check(expectationOf(MULTIPART), factsOf(MULTIPART_CONTENT_TYPE, multipartBody(VALID_MULTIPART_PARTS)))).toBe('ALLOW');
  });

  it('allows a quoted boundary, a lowercase content type and lowercase percent-encode', () => {
    expect(check(expectationOf(MULTIPART), factsOf(`Multipart/Form-Data; boundary="${BOUNDARY}"`, multipartBody(VALID_MULTIPART_PARTS))))
      .toBe('ALLOW');
    const lower = urlencodedBody(VALID_URLENCODED_PAIRS).replaceAll(/%[0-9A-F]{2}/gu, (escape) => escape.toLowerCase());
    expect(check(expectationOf(URLENCODED), factsOf(URLENCODED, lower))).toBe('ALLOW');
  });

  it('reads a space written as %20 the same as +, and a body split into several entries', () => {
    const body = urlencodedBody(VALID_URLENCODED_PAIRS).replace('+', '%20');
    expect(check(expectationOf(URLENCODED), factsOf(URLENCODED, body))).toBe('ALLOW');
    const whole = urlencodedBody(VALID_URLENCODED_PAIRS);
    const split = { ...factsOf(URLENCODED, whole), postDataEntries: [{ bytes: base64(whole.slice(0, 7)) }, { bytes: base64(whole.slice(7)) }] };
    expect(check(expectationOf(URLENCODED), split)).toBe('ALLOW');
  });

  it('compares the generated value with the line breaks that the browser sends (CR LF)', () => {
    const expectation = expectationOf(URLENCODED, { submittedFields: [{ name: 'memo', value: 'line1\nline2\rline3' }] });
    expect(check(expectation, factsOf(URLENCODED, `memo=line1%0D%0Aline2%0D%0Aline3&csrf_token=${CSRF_MARKER}`))).toBe('ALLOW');
    expect(check(expectation, factsOf(URLENCODED, `memo=line1%0Aline2%0Dline3&csrf_token=${CSRF_MARKER}`))).toBe('VALUE_MISMATCH');
  });

  it('allows a hidden or readonly field to be missing from the body', () => {
    const pairs = VALID_URLENCODED_PAIRS.filter(([name]) => name !== 'code');
    expect(check(expectationOf(URLENCODED), factsOf(URLENCODED, urlencodedBody(pairs)))).toBe('ALLOW');
  });
});

describe('T30b: (a) the request shape', () => {
  const body = urlencodedBody(VALID_URLENCODED_PAIRS);
  it.each<[string, Partial<WriteRequestFacts>, WritePayloadDecision]>([
    ['GET', { method: 'GET' }, 'NOT_POST'],
    ['lowercase post', { method: 'post' }, 'NOT_POST'],
    ['PUT', { method: 'PUT' }, 'NOT_POST'],
    ['a sub frame or a sub resource', { isMainFrameNavigation: false }, 'NOT_MAIN_FRAME_NAVIGATION'],
    ['a query', { url: `${ENDPOINT_URL}?x=1` }, 'QUERY_OR_FRAGMENT_PRESENT'],
    ['an empty query', { url: `${ENDPOINT_URL}?` }, 'QUERY_OR_FRAGMENT_PRESENT'],
    ['a fragment', { url: `${ENDPOINT_URL}#x` }, 'QUERY_OR_FRAGMENT_PRESENT'],
    ['another path', { url: `${ORIGIN}/items/new` }, 'ENDPOINT_MISMATCH'],
    ['a trailing slash', { url: `${ORIGIN}/items/` }, 'ENDPOINT_MISMATCH'],
    ['another case of the path', { url: `${ORIGIN}/Items` }, 'ENDPOINT_MISMATCH'],
    ['a percent-encoded path', { url: `${ORIGIN}/it%65ms` }, 'ENDPOINT_MISMATCH'],
    ['another origin', { url: 'https://example.invalid/items' }, 'ENDPOINT_MISMATCH'],
    ['another scheme', { url: 'http://example.com/items' }, 'ENDPOINT_MISMATCH'],
    ['another port', { url: 'https://example.com:8443/items' }, 'ENDPOINT_MISMATCH'],
    ['credentials in the URL', { url: 'https://user:pass@example.com/items' }, 'ENDPOINT_MISMATCH'],
    ['an unparsable URL', { url: 'not a url' }, 'ENDPOINT_MISMATCH'],
  ])('blocks %s', (_name, extra, expected) => {
    expect(check(expectationOf(URLENCODED), factsOf(URLENCODED, body, extra))).toBe(expected);
  });

  it('compares the path after the URL parser resolves dot segments (the same as the login stage)', () => {
    expect(check(expectationOf(URLENCODED), factsOf(URLENCODED, body, { url: `${ORIGIN}/a/../items` }))).toBe('ALLOW');
  });
});

describe('T30b: (b) the enctype', () => {
  const urlencoded = urlencodedBody(VALID_URLENCODED_PAIRS);
  it.each<[string, string | null]>([
    ['text/plain', 'text/plain'],
    ['text/plain with a charset', 'text/plain;charset=UTF-8'],
    ['no content type', null],
    ['application/json', 'application/json'],
    ['urlencoded with a parameter', `${URLENCODED}; charset=UTF-8`],
    ['multipart without a boundary', MULTIPART],
    ['multipart with another parameter', `${MULTIPART}; boundary=${BOUNDARY}; charset=UTF-8`],
  ])('blocks %s', (_name, contentType) => {
    const expectation = expectationOf(contentType?.startsWith('multipart') === true ? MULTIPART : URLENCODED);
    expect(check(expectation, factsOf(contentType, urlencoded))).toBe('ENCTYPE_NOT_ALLOWED');
  });

  it('blocks an allowed enctype that is not the approved one', () => {
    expect(check(expectationOf(URLENCODED), factsOf(MULTIPART_CONTENT_TYPE, multipartBody(VALID_MULTIPART_PARTS)))).toBe('ENCTYPE_MISMATCH');
    expect(check(expectationOf(MULTIPART), factsOf(URLENCODED, urlencoded))).toBe('ENCTYPE_MISMATCH');
  });
});

describe('T30b: (c) the field names', () => {
  it('blocks an unknown field (urlencoded and multipart)', () => {
    const pairs = [...VALID_URLENCODED_PAIRS, ['extra', 'x'] as const];
    expect(check(expectationOf(URLENCODED), factsOf(URLENCODED, urlencodedBody(pairs)))).toBe('UNKNOWN_FIELD');
    const parts = [...VALID_MULTIPART_PARTS, textPart('extra', 'x')];
    expect(check(expectationOf(MULTIPART), factsOf(MULTIPART_CONTENT_TYPE, multipartBody(parts)))).toBe('UNKNOWN_FIELD');
  });

  it('blocks a duplicated submitted, hidden or file field', () => {
    for (const duplicate of ['customer_name', 'csrf_token']) {
      const pairs = [...VALID_URLENCODED_PAIRS, [duplicate, duplicate === 'csrf_token' ? CSRF_MARKER : '山田 太郎'] as const];
      expect(check(expectationOf(URLENCODED), factsOf(URLENCODED, urlencodedBody(pairs)))).toBe('DUPLICATE_FIELD');
      const parts = [...VALID_MULTIPART_PARTS, textPart(duplicate, 'x')];
      expect(check(expectationOf(MULTIPART), factsOf(MULTIPART_CONTENT_TYPE, multipartBody(parts)))).toBe('DUPLICATE_FIELD');
    }
    const withFile = expectationOf(MULTIPART, { emptyFileFieldNames: ['att'] });
    const parts = [...VALID_MULTIPART_PARTS, filePart('att', '', ''), filePart('att', '', '')];
    expect(check(withFile, factsOf(MULTIPART_CONTENT_TYPE, multipartBody(parts)))).toBe('DUPLICATE_FIELD');
  });

  it('blocks a missing submitted field', () => {
    const pairs = VALID_URLENCODED_PAIRS.filter(([name]) => name !== 'memo');
    expect(check(expectationOf(URLENCODED), factsOf(URLENCODED, urlencodedBody(pairs)))).toBe('SUBMITTED_FIELD_MISSING');
  });

  it('compares the escaped name of multipart exactly (a quote is sent as %22)', () => {
    const expectation = expectationOf(MULTIPART, { submittedFields: [{ name: 'a"b', value: 'v' }], passthroughFieldNames: [] });
    expect(check(expectation, factsOf(MULTIPART_CONTENT_TYPE, multipartBody([textPart('a%22b', 'v')])))).toBe('ALLOW');
    const literal = expectationOf(MULTIPART, { submittedFields: [{ name: 'a%22b', value: 'v' }], passthroughFieldNames: [] });
    expect(check(literal, factsOf(MULTIPART_CONTENT_TYPE, multipartBody([textPart('a%22b', 'v')])))).toBe('ALLOW');
    expect(check(expectation, factsOf(MULTIPART_CONTENT_TYPE, multipartBody([textPart('ab', 'v')])))).toBe('UNKNOWN_FIELD');
  });
});

describe('T30b: (d) the values', () => {
  const replaceMemo = (encoded: string): string => urlencodedBody(VALID_URLENCODED_PAIRS)
    .replace(`memo=${encodeForm('a&b=c+d%e')}`, `memo=${encoded}`);
  it.each<[string, string]>([
    ['another value', 'other'],
    ['a literal plus read as a space', 'a%26b%3Dc+d%25e'],
    ['an empty value', ''],
    ['a value with a trailing space', `${encodeForm('a&b=c+d%e')}+`],
  ])('blocks %s', (_name, encoded) => {
    expect(check(expectationOf(URLENCODED), factsOf(URLENCODED, replaceMemo(encoded)))).toBe('VALUE_MISMATCH');
  });

  it('blocks the value encoded in another character set (Shift_JIS bytes are not the UTF-8 of the value)', () => {
    const sjis = urlencodedBody(VALID_URLENCODED_PAIRS).replace(encodeForm('山田 太郎'), '%8ER%93c+%91%BE%98Y');
    expect(check(expectationOf(URLENCODED), factsOf(URLENCODED, sjis))).toBe('VALUE_MISMATCH');
    const parts = VALID_MULTIPART_PARTS.map((part) => (part.header.includes('"customer_name"')
      ? { ...part, content: Buffer.from([0x8e, 0x52, 0x93, 0x63]).toString('latin1') }
      : part));
    expect(check(expectationOf(MULTIPART), factsOf(MULTIPART_CONTENT_TYPE, multipartBody(parts)))).toBe('VALUE_MISMATCH');
  });

  it('blocks a multipart value that differs', () => {
    const parts = VALID_MULTIPART_PARTS.map((part) => (part.header.includes('"memo"') ? textPart('memo', 'other') : part));
    expect(check(expectationOf(MULTIPART), factsOf(MULTIPART_CONTENT_TYPE, multipartBody(parts)))).toBe('VALUE_MISMATCH');
  });
});

describe('T30b: (e) the file parts', () => {
  const withFile = expectationOf(MULTIPART, { emptyFileFieldNames: ['att'] });
  it('allows an empty file part of an approved file field', () => {
    const parts = [...VALID_MULTIPART_PARTS, filePart('att', '', '')];
    expect(check(withFile, factsOf(MULTIPART_CONTENT_TYPE, multipartBody(parts)))).toBe('ALLOW');
  });

  it.each<[string, string, string]>([
    ['a file name', 'note.txt', ''],
    ['content', '', 'FILE-CONTENT'],
  ])('blocks a file part with %s', (_name, filename, content) => {
    const parts = [...VALID_MULTIPART_PARTS, filePart('att', filename, content)];
    expect(check(withFile, factsOf(MULTIPART_CONTENT_TYPE, multipartBody(parts)))).toBe('FILE_NOT_EMPTY');
  });

  it('blocks a file part of a submitted field, and a text part of a file field', () => {
    const parts = [...VALID_MULTIPART_PARTS.filter((part) => !part.header.includes('"memo"')), filePart('memo', '', '')];
    expect(check(withFile, factsOf(MULTIPART_CONTENT_TYPE, multipartBody(parts)))).toBe('FILE_NOT_EMPTY');
    const text = [...VALID_MULTIPART_PARTS, textPart('att', '')];
    expect(check(withFile, factsOf(MULTIPART_CONTENT_TYPE, multipartBody(text)))).toBe('FILE_NOT_EMPTY');
  });

  it('allows the empty urlencoded value of a file field, and blocks a file name', () => {
    const expectation = expectationOf(URLENCODED, { emptyFileFieldNames: ['att'] });
    expect(check(expectation, factsOf(URLENCODED, `${urlencodedBody(VALID_URLENCODED_PAIRS)}&att=`))).toBe('ALLOW');
    expect(check(expectation, factsOf(URLENCODED, `${urlencodedBody(VALID_URLENCODED_PAIRS)}&att=note.txt`))).toBe('FILE_NOT_EMPTY');
  });
});

describe('T30b: (f) the character set of the document', () => {
  const body = urlencodedBody(VALID_URLENCODED_PAIRS);
  it('blocks when the character set is unknown or is not UTF-8', () => {
    expect(check(expectationOf(URLENCODED), factsOf(URLENCODED, body, { documentCharset: null }))).toBe('DOCUMENT_CHARSET_UNKNOWN');
    expect(check(expectationOf(URLENCODED), factsOf(URLENCODED, body, { documentCharset: 'Shift_JIS' }))).toBe('DOCUMENT_CHARSET_NOT_UTF8');
    expect(check(expectationOf(URLENCODED), factsOf(URLENCODED, body, { documentCharset: 'windows-1252' }))).toBe('DOCUMENT_CHARSET_NOT_UTF8');
    expect(check(expectationOf(URLENCODED), factsOf(URLENCODED, body, { documentCharset: 'utf-8' }))).toBe('ALLOW');
  });
});

describe('T30b: (g) the body', () => {
  const body = urlencodedBody(VALID_URLENCODED_PAIRS);
  it('blocks a request without a body, or without the entries', () => {
    expect(check(expectationOf(URLENCODED), factsOf(URLENCODED, null))).toBe('BODY_UNAVAILABLE');
    expect(check(expectationOf(URLENCODED), { ...factsOf(URLENCODED, body), postDataEntries: null })).toBe('BODY_UNAVAILABLE');
    expect(check(expectationOf(URLENCODED), { ...factsOf(URLENCODED, body), postDataEntries: [] })).toBe('BODY_UNAVAILABLE');
    expect(check(expectationOf(URLENCODED), { ...factsOf(URLENCODED, body), hasPostData: false })).toBe('BODY_UNAVAILABLE');
  });

  it('blocks a body with an entry whose bytes are not given (a file or a blob)', () => {
    const facts = { ...factsOf(URLENCODED, body), postDataEntries: [{ bytes: base64(body) }, {}] };
    expect(check(expectationOf(URLENCODED), facts)).toBe('BODY_INCOMPLETE');
  });

  it('blocks a multipart body without the closing boundary', () => {
    expect(check(expectationOf(MULTIPART), factsOf(MULTIPART_CONTENT_TYPE, multipartBody(VALID_MULTIPART_PARTS, false)))).toBe('BODY_INCOMPLETE');
  });

  it('blocks a body over the limit before decoding it', () => {
    const large = `${body}&${'x'.repeat(MAX_WRITE_PAYLOAD_BYTES)}`;
    expect(check(expectationOf(URLENCODED), factsOf(URLENCODED, large))).toBe('BODY_TOO_LARGE');
  });

  it.each<[string, string]>([
    ['a broken percent-encode', `${body}&memo2=%G1`],
    ['a pair without =', `${body}&lonely`],
    ['an empty pair', `${body}&&code=1`],
    ['a non-ASCII byte', `${body}&x=é`],
  ])('blocks a urlencoded body with %s', (_name, malformed) => {
    expect(check(expectationOf(URLENCODED), factsOf(URLENCODED, malformed))).toBe('BODY_MALFORMED');
  });

  it.each<[string, string]>([
    ['a body that does not start with the boundary', `x${multipartBody(VALID_MULTIPART_PARTS)}`],
    ['a part without a disposition', `--${BOUNDARY}\r\nContent-Type: text/plain\r\n\r\nv\r\n--${BOUNDARY}--\r\n`],
    ['an unknown part header', `--${BOUNDARY}\r\nContent-Disposition: form-data; name="memo"\r\nX-Extra: 1\r\n\r\nv\r\n--${BOUNDARY}--\r\n`],
    ['a disposition that is not form-data', `--${BOUNDARY}\r\nContent-Disposition: attachment; name="memo"\r\n\r\nv\r\n--${BOUNDARY}--\r\n`],
    ['bytes after the closing boundary', `${multipartBody(VALID_MULTIPART_PARTS)}tail`],
  ])('blocks a multipart body with %s', (_name, malformed) => {
    expect(check(expectationOf(MULTIPART), factsOf(MULTIPART_CONTENT_TYPE, malformed))).toBe('BODY_MALFORMED');
  });

  it('blocks entries that are not base64', () => {
    const facts = { ...factsOf(URLENCODED, body), postDataEntries: [{ bytes: '***' }] };
    expect(check(expectationOf(URLENCODED), facts)).toBe('BODY_MALFORMED');
  });
});

describe('T30b: the expectation itself', () => {
  const body = urlencodedBody(VALID_URLENCODED_PAIRS);
  it.each<[string, WritePayloadExpectation]>([
    ['a text/plain enctype', { ...expectationOf(URLENCODED), request: { origin: ORIGIN, path: '/items', enctype: 'text/plain' as never } }],
    ['no submitted field', expectationOf(URLENCODED, { submittedFields: [] })],
    ['a name both submitted and passed through', expectationOf(URLENCODED, { passthroughFieldNames: ['customer_name'] })],
    ['a duplicated submitted name', expectationOf(URLENCODED, { submittedFields: [{ name: 'memo', value: 'a' }, { name: 'memo', value: 'b' }] })],
    ['an empty name', expectationOf(URLENCODED, { passthroughFieldNames: [''] })],
    ['a lone surrogate in a value', expectationOf(URLENCODED, { submittedFields: [{ name: 'memo', value: '\ud800' }] })],
    ['a non-string value', expectationOf(URLENCODED, { submittedFields: [{ name: 'memo', value: 1 as never }] })],
  ])('treats %s as an invalid expectation (fail closed)', (_name, expectation) => {
    expect(check(expectation, factsOf(URLENCODED, body))).toBe('EXPECTATION_INVALID');
  });
});

// T30b fix round 1（T31 の調査で見つかった穴）: `_method` の hidden の欄は、名前だけでなく値を照らす。承認した候補の method の上書き
// （`methodOverride`。`PUT`・`PATCH`）と、Task 27 の判定と同じ畳み込み（`foldNfkcCase`）で一致しなければ止める。上書きのない候補では、本文に
// `_method`（畳み込みで当たる名前）があれば止める。上書きのある候補で、本文にないときも止める。
describe('T30b fix round 1: the method override field is checked by value', () => {
  const urlencoded = urlencodedBody(VALID_URLENCODED_PAIRS);
  const withOverride = (override: 'PUT' | 'PATCH' | null): WritePayloadExpectation => expectationOf(URLENCODED, { methodOverride: override });
  it.each<[string, 'PUT' | 'PATCH' | null, string, WritePayloadDecision]>([
    ['the approved PUT', 'PUT', '_method=PUT', 'ALLOW'],
    ['the approved PATCH', 'PATCH', '_method=PATCH', 'ALLOW'],
    ['a lowercase value (folded)', 'PUT', '_method=put', 'ALLOW'],
    ['an uppercase name (folded)', 'PUT', '_METHOD=PUT', 'ALLOW'],
    ['a fullwidth name (NFKC folded)', 'PUT', `${encodeForm('＿method')}=PUT`, 'ALLOW'],
    ['DELETE instead of PUT', 'PUT', '_method=DELETE', 'METHOD_OVERRIDE_MISMATCH'],
    ['PATCH instead of PUT', 'PUT', '_method=PATCH', 'METHOD_OVERRIDE_MISMATCH'],
    ['a value with a space', 'PUT', '_method=PUT+', 'METHOD_OVERRIDE_MISMATCH'],
    ['an empty value', 'PUT', '_method=', 'METHOD_OVERRIDE_MISMATCH'],
    ['two override fields', 'PUT', '_method=PUT&_METHOD=PUT', 'METHOD_OVERRIDE_MISMATCH'],
    ['DELETE without an approved override', null, '_method=DELETE', 'METHOD_OVERRIDE_MISMATCH'],
    ['PUT without an approved override', null, '_method=PUT', 'METHOD_OVERRIDE_MISMATCH'],
    ['a folded name without an approved override', null, '_Method=DELETE', 'METHOD_OVERRIDE_MISMATCH'],
  ])('%s', (_name, override, overridePair, expected) => {
    expect(check(withOverride(override), factsOf(URLENCODED, `${urlencoded}&${overridePair}`))).toBe(expected);
  });

  it('blocks a body without the approved override field, and allows a body without it when no override is approved', () => {
    expect(check(withOverride('PUT'), factsOf(URLENCODED, urlencoded))).toBe('METHOD_OVERRIDE_MISMATCH');
    expect(check(withOverride(null), factsOf(URLENCODED, urlencoded))).toBe('ALLOW');
    expect(check(expectationOf(URLENCODED), factsOf(URLENCODED, `${urlencoded}&_method=DELETE`))).toBe('METHOD_OVERRIDE_MISMATCH');
  });

  it('checks the multipart override part by value, and blocks a file part named _method', () => {
    const parts = (value: string): string => multipartBody([...VALID_MULTIPART_PARTS, textPart('_method', value)]);
    const multipart = (override: 'PUT' | null): WritePayloadExpectation => expectationOf(MULTIPART, { methodOverride: override });
    expect(check(multipart('PUT'), factsOf(MULTIPART_CONTENT_TYPE, parts('PUT')))).toBe('ALLOW');
    expect(check(multipart('PUT'), factsOf(MULTIPART_CONTENT_TYPE, parts('DELETE')))).toBe('METHOD_OVERRIDE_MISMATCH');
    expect(check(multipart(null), factsOf(MULTIPART_CONTENT_TYPE, parts('DELETE')))).toBe('METHOD_OVERRIDE_MISMATCH');
    const file = multipartBody([...VALID_MULTIPART_PARTS, filePart('_method', '', '')]);
    expect(check(multipart('PUT'), factsOf(MULTIPART_CONTENT_TYPE, file))).toBe('METHOD_OVERRIDE_MISMATCH');
  });

  it('treats the override field in a name list, and an override that is not PUT or PATCH, as an invalid expectation', () => {
    for (const expectation of [
      expectationOf(URLENCODED, { passthroughFieldNames: ['csrf_token', '_method'] }),
      expectationOf(URLENCODED, { passthroughFieldNames: ['csrf_token', '_METHOD'] }),
      expectationOf(URLENCODED, { emptyFileFieldNames: ['_method'] }),
      expectationOf(URLENCODED, { submittedFields: [{ name: '_method', value: 'PUT' }] }),
      expectationOf(URLENCODED, { methodOverride: 'DELETE' as never }),
      expectationOf(URLENCODED, { methodOverride: 'put' as never }),
    ]) {
      expect(check(expectation, factsOf(URLENCODED, `${urlencoded}&_method=PUT`))).toBe('EXPECTATION_INVALID');
    }
  });
});

describe('T30b: the hidden and readonly values do not appear', () => {
  it('returns only a decision word, for every case that contains the markers', () => {
    const urlencoded = urlencodedBody(VALID_URLENCODED_PAIRS);
    const multipart = multipartBody(VALID_MULTIPART_PARTS);
    const cases: readonly [WritePayloadExpectation, WriteRequestFacts][] = [
      [expectationOf(URLENCODED), factsOf(URLENCODED, urlencoded)],
      [expectationOf(URLENCODED), factsOf(URLENCODED, `${urlencoded}&extra=${CSRF_MARKER}`)],
      [expectationOf(URLENCODED), factsOf(URLENCODED, `${urlencoded}&csrf_token=${CSRF_MARKER}`)],
      [expectationOf(URLENCODED), factsOf(URLENCODED, `${urlencoded}&${CSRF_MARKER}=1`)],
      [expectationOf(URLENCODED), factsOf(URLENCODED, `${urlencoded}%`)],
      [expectationOf(MULTIPART), factsOf(MULTIPART_CONTENT_TYPE, multipart)],
      [expectationOf(MULTIPART), factsOf(MULTIPART_CONTENT_TYPE, `${multipart}${CSRF_MARKER}`)],
      [expectationOf(MULTIPART), factsOf(MULTIPART_CONTENT_TYPE, multipartBody([...VALID_MULTIPART_PARTS, textPart(CSRF_MARKER, READONLY_MARKER)]))],
    ];
    for (const [expectation, facts] of cases) {
      const decision = check(expectation, facts);
      expect(WRITE_PAYLOAD_DECISIONS).toContain(decision);
      expect(JSON.stringify(decision)).not.toContain(CSRF_MARKER);
      expect(JSON.stringify(decision)).not.toContain(READONLY_MARKER);
    }
  });

  it('does not throw for hostile facts (the value never reaches an error message)', () => {
    const hostile = [
      { ...factsOf(URLENCODED, null), postDataEntries: [{ bytes: 1 as never }] },
      { ...factsOf(URLENCODED, null), postDataEntries: 'x' as never, hasPostData: true },
      { ...factsOf(URLENCODED, null), url: 1 as never },
      { ...factsOf(null, null), method: undefined as never },
    ];
    for (const facts of hostile) {
      expect(() => check(expectationOf(URLENCODED), facts)).not.toThrow();
    }
  });
});
