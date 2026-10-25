// CC-096 の B: 要求の本文の部品（CDP の `postDataEntries`。各部品の `bytes` は base64）の読み方を固定する。
// - 読み口は 3 つ: Guard の書き込みの送信の本文（`writeSubmissionBodyOf`。照合で通した承認の POST にだけ使う）、Guard の API の書き込みの照合の
//   本文（`apiWriteBodyOf`）、ログインの資格情報の守りの本文の文字列（`requestBodyTextOf`）。
// - 本文があるか・部品が読めるかの確かめは、読み口ごとに違う（そのまま残す）。部品の decode とつなぎ方は同じ: 部品ごとに base64 を寛容に
//   decode して（Node の `Buffer.from(…, 'base64')`。base64 でない文字は飛ばし、`=` の後は読まない）、bytes をつなぐ。文字列にするのは、
//   つないだ後（部品の境で文字が分かれても、1 つの文字として読む）。読み口は、本文の大きさの上限を持たない（上限は照合の owner が見る）。
// 例の値は、匿名の値だけを使う。
import { describe, expect, it } from 'vitest';
import { requestBodyTextOf, type RequestBodyText } from '../../src/safety/login-credential-guard.js';
import { apiWriteBodyOf, writeSubmissionBodyOf } from '../../src/safety/passive-request-guard.js';
import { decodeBase64BodyParts } from '../../src/safety/request-body.js';
import { MAX_WRITE_PAYLOAD_BYTES } from '../../src/safety/write-payload-policy.js';

type PausedEvent = Parameters<typeof apiWriteBodyOf>[0];
type Part = { readonly bytes?: string };

const eventOf = (hasPostData: boolean | undefined, postDataEntries: readonly Part[] | undefined): PausedEvent => ({
  requestId: 'request-1',
  frameId: 'frame-1',
  request: {
    method: 'POST',
    url: 'https://app.example.invalid/items',
    ...(hasPostData === undefined ? {} : { hasPostData }),
    ...(postDataEntries === undefined ? {} : { postDataEntries }),
  },
});
const partsOf = (...hexes: readonly string[]): readonly Part[] =>
  hexes.map((hex) => ({ bytes: Buffer.from(hex, 'hex').toString('base64') }));
const hexOf = (body: Buffer | null): string | null => (body === null ? null : body.toString('hex'));
const NONE: RequestBodyText = { kind: 'NONE' };
const UNREADABLE: RequestBodyText = { kind: 'UNREADABLE' };
const text = (value: string): RequestBodyText => ({ kind: 'TEXT', text: value });
const REPLACEMENT_CHARACTER = String.fromCodePoint(0xfffd);
const BYTE_ORDER_MARK = String.fromCodePoint(0xfeff);

/** 3 つの読み口の結果（Guard の 2 つは bytes の 16 進、ログインの守りは本文の文字列）。 */
const readAll = (hasPostData: boolean | undefined, parts: readonly Part[] | undefined) => ({
  writeSubmission: hexOf(writeSubmissionBodyOf(eventOf(hasPostData, parts))),
  apiWrite: hexOf(apiWriteBodyOf(eventOf(hasPostData, parts))),
  loginText: requestBodyTextOf(hasPostData, parts),
});

describe('CC-096: the readers of the request body parts (the current behavior is fixed)', () => {
  it('reads no body: the API write is null and the login text is NONE; the write submission is empty', () => {
    expect(readAll(false, partsOf('61'))).toEqual({ writeSubmission: '61', apiWrite: null, loginText: NONE });
    expect(readAll(undefined, undefined)).toEqual({ writeSubmission: '', apiWrite: null, loginText: NONE });
  });

  it('marks a body without parts, with no parts, or with a part without bytes unreadable; the write submission reads them as empty', () => {
    expect(readAll(true, undefined)).toEqual({ writeSubmission: '', apiWrite: null, loginText: UNREADABLE });
    expect(readAll(true, [])).toEqual({ writeSubmission: '', apiWrite: null, loginText: UNREADABLE });
    expect(readAll(true, [...partsOf('61'), {}])).toEqual({ writeSubmission: '61', apiWrite: null, loginText: UNREADABLE });
  });

  it('reads an empty part as no bytes (not unreadable)', () => {
    expect(readAll(true, [{ bytes: '' }])).toEqual({ writeSubmission: '', apiWrite: '', loginText: text('') });
    expect(readAll(true, [{ bytes: '' }, ...partsOf('61'), { bytes: '' }])).toEqual({ writeSubmission: '61', apiWrite: '61', loginText: text('a') });
  });

  it.each<readonly [string, string, string]>([
    ['a character outside base64 is skipped', 'YW*Jj', '616263'],
    ['a part without the padding', 'YWI', '6162'],
    ['a part with a space and a line break', 'Y W\nI=', '6162'],
    ['the bytes after a padding in the middle of a part are not read', 'YQ==Yg==', '61'],
    ['a part that starts with the padding', '=YQ==', ''],
    ['a single character', 'Y', ''],
    ['the URL safe alphabet', '-_8', 'fbff'],
  ])('decodes a broken base64 part leniently: %s', (_name, bytes, hex) => {
    const read = readAll(true, [{ bytes }]);
    expect(read.writeSubmission).toBe(hex);
    expect(read.apiWrite).toBe(hex);
    expect(read.loginText).toEqual(text(Buffer.from(hex, 'hex').toString('utf8')));
  });

  it('decodes each part on its own and joins the bytes in order (a padding in a middle part does not stop the next part)', () => {
    expect(readAll(true, [{ bytes: 'YQ==' }, { bytes: 'Yg==' }, { bytes: 'Yw' }])).toEqual({
      writeSubmission: '616263', apiWrite: '616263', loginText: text('abc'),
    });
    expect(readAll(true, partsOf('63', '62', '61')).loginText).toEqual(text('cba'));
  });

  it('turns the joined bytes into text after joining (a character split over parts is one character), and keeps the raw bytes for the Guard', () => {
    // あ（E3 81 82）を部品の境で分ける。U+1F600（F0 9F 98 80）を 1 byte ずつ 4 つの部品に分ける。
    expect(readAll(true, partsOf('e3', '8182'))).toEqual({ writeSubmission: 'e38182', apiWrite: 'e38182', loginText: text('あ') });
    expect(readAll(true, partsOf('f0', '9f', '98', '80')).loginText).toEqual(text(String.fromCodePoint(0x1f600)));
    // UTF-8 として読めない bytes は、置き換え文字になる（Guard の bytes はそのまま）。BOM と NUL は残る。
    expect(readAll(true, partsOf('ff', '61'))).toEqual({ writeSubmission: 'ff61', apiWrite: 'ff61', loginText: text(`${REPLACEMENT_CHARACTER}a`) });
    expect(readAll(true, partsOf('e9')).loginText).toEqual(text(REPLACEMENT_CHARACTER));
    expect(readAll(true, partsOf('e381')).loginText).toEqual(text(REPLACEMENT_CHARACTER));
    expect(readAll(true, partsOf('efbbbf', '6100')).loginText).toEqual(text(`${BYTE_ORDER_MARK}a\u0000`));
  });

  it.each<readonly [string, number]>([
    ['at the write payload limit', MAX_WRITE_PAYLOAD_BYTES],
    ['over the write payload limit', MAX_WRITE_PAYLOAD_BYTES + 1],
  ])('does not cut the body %s (the limit is checked by the payload owner)', (_name, size) => {
    const body = Buffer.alloc(size, 0x61);
    const parts = [{ bytes: body.subarray(0, 1000).toString('base64') }, { bytes: body.subarray(1000).toString('base64') }];
    expect(writeSubmissionBodyOf(eventOf(true, parts)).length).toBe(size);
    expect(apiWriteBodyOf(eventOf(true, parts))?.length).toBe(size);
    const loginText = requestBodyTextOf(true, parts);
    expect(loginText.kind === 'TEXT' ? loginText.text.length : null).toBe(size);
  });

  it('has no limit on the number of parts', () => {
    const parts = Array.from({ length: 4096 }, () => ({ bytes: 'YQ==' }));
    expect(writeSubmissionBodyOf(eventOf(true, parts)).length).toBe(4096);
    expect(apiWriteBodyOf(eventOf(true, parts))?.length).toBe(4096);
    expect(requestBodyTextOf(true, parts)).toEqual(text('a'.repeat(4096)));
  });

  it('marks a null part unreadable for the login text; the Guard readers throw on it (the CDP type has no null part)', () => {
    const parts = [null] as unknown as readonly Part[];
    expect(requestBodyTextOf(true, parts)).toEqual(UNREADABLE);
    expect(requestBodyTextOf(true, 'YQ==' as unknown as readonly Part[])).toEqual(UNREADABLE);
    expect(() => apiWriteBodyOf(eventOf(true, parts))).toThrow(TypeError);
    expect(() => writeSubmissionBodyOf(eventOf(true, parts))).toThrow(TypeError);
  });
});

describe('CC-096: the one decode of the body parts (decodeBase64BodyParts)', () => {
  it('reads no parts and empty parts as no bytes, and a part without bytes as empty', () => {
    expect(decodeBase64BodyParts([]).length).toBe(0);
    expect(hexOf(decodeBase64BodyParts([{ bytes: '' }, {}, { bytes: undefined }]))).toBe('');
    expect(hexOf(decodeBase64BodyParts([...partsOf('61'), {}, ...partsOf('62')]))).toBe('6162');
  });

  it('decodes each part leniently on its own and joins the raw bytes in order', () => {
    expect(hexOf(decodeBase64BodyParts([{ bytes: 'YW*Jj' }, { bytes: 'YQ==Yg==' }, { bytes: '=YQ==' }, { bytes: '-_8' }]))).toBe('61626361fbff');
    expect(hexOf(decodeBase64BodyParts([{ bytes: 'YQ==' }, { bytes: 'Yg==' }, { bytes: 'Yw' }]))).toBe('616263');
    expect(hexOf(decodeBase64BodyParts(partsOf('e3', '8182', 'ff', 'efbbbf', '00')))).toBe('e38182ffefbbbf00');
  });

  it('does not cut a body over the write payload limit, and has no limit on the number of parts', () => {
    const body = Buffer.alloc(MAX_WRITE_PAYLOAD_BYTES + 1, 0x62);
    expect(decodeBase64BodyParts([{ bytes: body.toString('base64') }]).equals(body)).toBe(true);
    expect(decodeBase64BodyParts(Array.from({ length: 4096 }, () => ({ bytes: 'Yg==' }))).equals(Buffer.alloc(4096, 0x62))).toBe(true);
  });
});
