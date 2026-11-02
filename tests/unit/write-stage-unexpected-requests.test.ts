// OP-M: 書き込みの段で止めた、承認した送信のほかの要求の一覧（`src/safety/write-stage-unexpected-requests.ts`）の単体テスト。
// - 行は、送り方・送り先の区分・path の形・種類・時点・理由・目印の真偽・本文の種類・回数だけ（Origin・query・本文・値を持たない）。
// - 目印（入れた値）は、本文に含まれるかの真偽だけを残し、path に入っても区切りを伏せる（OP-N: JSON の入れ子の値と form の符号化も照らす）。
// - 同じ形は回数を足し、上限（`MAX_WRITE_STAGE_UNEXPECTED_REQUESTS`）を超えた新しい行は数だけ（`unlisted`）。
import { describe, expect, it } from 'vitest';
import { REDACTED } from '../../src/core/redaction.js';
import {
  MAX_WRITE_STAGE_UNEXPECTED_REQUESTS,
  requestCarriesMarker,
  WriteStageUnexpectedRequestList,
  type WriteStageUnexpectedRequestFacts,
} from '../../src/safety/write-stage-unexpected-requests.js';

const MARKER = 'op-m-marker-value-7f3a';
const OUTSIDE_ORIGIN = 'https://outside.example.invalid';

const facts = (overrides: Partial<WriteStageUnexpectedRequestFacts> = {}): WriteStageUnexpectedRequestFacts => ({
  method: 'POST',
  url: 'https://backend.example.invalid/rest/v1/rpc/check_email?select=id',
  resourceType: 'fetch',
  destination: 'APPROVED_SERVICE_ORIGIN',
  timing: 'AFTER_FILL',
  reason: 'NON_READ_METHOD',
  body: () => ({ kind: 'TEXT', text: JSON.stringify({ email: MARKER }) }),
  ...overrides,
});

describe('OP-M: the list of the requests other than the approved send in the write stage', () => {
  it('keeps the shape of a request and whether the typed value was in the body, without the origin, the query or the value', () => {
    const list = new WriteStageUnexpectedRequestList([MARKER]);
    list.record(facts());
    list.record(facts({
      url: `${OUTSIDE_ORIGIN}/collect?event=input`, method: 'get', resourceType: 'ping', destination: 'OUTSIDE_ALLOWED_ORIGINS', reason: 'SUBMISSION_WINDOW',
      body: () => ({ kind: 'NONE' }),
    }));
    const snapshot = list.snapshot();
    expect(snapshot).toEqual({
      requests: [
        {
          method: 'POST', destination: 'APPROVED_SERVICE_ORIGIN', pathShape: '/rest/v1/rpc/check_email', resourceType: 'fetch', timing: 'AFTER_FILL',
          reason: 'NON_READ_METHOD', markerInBody: true, bodyKind: 'OBJECT', count: 1,
        },
        {
          method: 'GET', destination: 'OUTSIDE_ALLOWED_ORIGINS', pathShape: '/collect', resourceType: 'ping', timing: 'AFTER_FILL',
          reason: 'SUBMISSION_WINDOW', markerInBody: false, bodyKind: 'NONE', count: 1,
        },
      ],
      unlisted: 0,
    });
    const text = JSON.stringify(snapshot);
    expect(text).not.toContain(MARKER);
    expect(text).not.toContain(OUTSIDE_ORIGIN);
    expect(text).not.toContain('select');
    expect(Object.isFrozen(snapshot.requests[0])).toBe(true);
  });

  it('hides the path segment that carries the typed value or looks like a value', () => {
    const list = new WriteStageUnexpectedRequestList([MARKER]);
    list.record(facts({ url: `https://backend.example.invalid/check/${MARKER}`, body: () => ({ kind: 'NONE' }) }));
    const [row] = list.snapshot().requests;
    expect(row?.pathShape).toBe(`/check/${REDACTED}`);
    expect(row?.markerInBody).toBe(false);
  });

  // OP-N（設計書 4.1.7 の N1。OP-M の発見）: 前は JSON の最上位の値だけを照らした。form の符号化の本文と、入れ子の値も照らす（読めない本文は偽のまま、本文の種類で読む）。
  it('says true for the typed value in a form encoded body and in a nested JSON value, and false with the body kind for an unreadable body', () => {
    const list = new WriteStageUnexpectedRequestList([MARKER]);
    list.record(facts({ body: () => ({ kind: 'TEXT', text: `email=${encodeURIComponent(MARKER).toUpperCase()}&x=1` }) }));
    list.record(facts({ body: () => ({ kind: 'TEXT', text: JSON.stringify({ draft: { fields: [{ value: MARKER }] } }) }) }));
    list.record(facts({ body: () => ({ kind: 'UNREADABLE' }) }));
    list.record(facts({ body: () => ({ kind: 'TEXT', text: 'email=other' }) }));
    expect(list.snapshot().requests.map(({ markerInBody, bodyKind }) => [markerInBody, bodyKind])).toEqual([
      [true, 'NOT_JSON'], [true, 'OBJECT'], [false, 'UNREADABLE'], [false, 'NOT_JSON'],
    ]);
  });

  it('adds up the same shape, and counts the new shapes over the limit only as a number', () => {
    const list = new WriteStageUnexpectedRequestList([MARKER]);
    list.record(facts());
    list.record(facts());
    for (let index = 0; index < MAX_WRITE_STAGE_UNEXPECTED_REQUESTS + 2; index += 1) {
      list.record(facts({ url: `https://backend.example.invalid/p${String(index)}`, body: () => ({ kind: 'NONE' }) }));
    }
    const snapshot = list.snapshot();
    expect(snapshot.requests).toHaveLength(MAX_WRITE_STAGE_UNEXPECTED_REQUESTS);
    expect(snapshot.requests[0]?.count).toBe(2);
    expect(snapshot.unlisted).toBe(3);
  });

  it('keeps a row apart by the timing and the destination', () => {
    const list = new WriteStageUnexpectedRequestList([]);
    list.record(facts({ timing: 'BEFORE_FILL' }));
    list.record(facts({ timing: 'AFTER_PRESS' }));
    list.record(facts({ destination: 'TEST_ORIGIN' }));
    expect(list.snapshot().requests.map(({ timing, destination, markerInBody }) => [timing, destination, markerInBody])).toEqual([
      ['BEFORE_FILL', 'APPROVED_SERVICE_ORIGIN', false],
      ['AFTER_PRESS', 'APPROVED_SERVICE_ORIGIN', false],
      ['AFTER_FILL', 'TEST_ORIGIN', false],
    ]);
  });
});

// OP-N（設計書 4.1.7 の N1・N2）: 目印の照らし（Guard が、値を入れた後に止めた読み取りを取りやめに数えるか、押した後に送信の扱いで通すかを決める）。
describe('OP-N: whether a request carries a typed value (the marker)', () => {
  const NONE = (): { readonly kind: 'NONE' } => ({ kind: 'NONE' });
  const text = (value: string) => (): { readonly kind: 'TEXT'; readonly text: string } => ({ kind: 'TEXT', text: value });
  const MULTIBYTE = 'マーカー値';

  it('finds the value in the URL path and query, raw, percent encoded, form encoded, and in another letter case', () => {
    const list = new WriteStageUnexpectedRequestList(['t40b name 3', 'op-n@example.invalid']);
    expect(list.carriesMarker({ url: 'https://example.com/check?q=T40b+name+3', body: NONE })).toBe(true);
    expect(list.carriesMarker({ url: 'https://example.com/check?q=t40b%20NAME%203', body: NONE })).toBe(true);
    expect(list.carriesMarker({ url: 'https://example.com/check?email=op-n%40example.invalid', body: NONE })).toBe(true);
    expect(list.carriesMarker({ url: 'https://example.com/u/op-n@example.invalid/x', body: NONE })).toBe(true);
    expect(list.carriesMarker({ url: 'https://example.com/check?event=input', body: NONE })).toBe(false);
  });

  it('finds the value in a form encoded, a nested JSON (with escaped letters) and a multipart body', () => {
    const list = new WriteStageUnexpectedRequestList([MULTIBYTE]);
    const url = 'https://example.com/save';
    expect(list.carriesMarker({ url, body: text(`a=1&v=${encodeURIComponent(MULTIBYTE)}`) })).toBe(true);
    const escaped = JSON.stringify({ a: { b: [MULTIBYTE] } }).replace(/[^\x20-\x7e]/gu, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
    expect(escaped).not.toContain(MULTIBYTE);
    expect(list.carriesMarker({ url, body: text(escaped) })).toBe(true);
    expect(list.carriesMarker({ url, body: text(`--b\r\nContent-Disposition: form-data; name="v"\r\n\r\n${MULTIBYTE}\r\n--b--`) })).toBe(true);
    expect(list.carriesMarker({ url, body: text(JSON.stringify({ event: 'open' })) })).toBe(false);
  });

  it('treats an unreadable body and a body that cannot be read as carrying the value (the safe side), and says false without markers', () => {
    const list = new WriteStageUnexpectedRequestList([MARKER]);
    const url = 'https://example.com/save';
    expect(list.carriesMarker({ url, body: () => ({ kind: 'UNREADABLE' }) })).toBe(true);
    expect(list.carriesMarker({ url, body: () => { throw new Error('no body'); } })).toBe(true);
    expect(new WriteStageUnexpectedRequestList(['', '']).carriesMarker({ url: `https://example.com/${MARKER}`, body: () => ({ kind: 'UNREADABLE' }) })).toBe(false);
    expect(requestCarriesMarker([MARKER], { url: `https://example.com/?v=${MARKER}`, body: NONE })).toBe(true);
    expect(requestCarriesMarker([MARKER], { url: 'https://example.com/', body: NONE })).toBe(false);
  });

  it('checks every marker, beyond the number that the shape keeps', () => {
    const markers = Array.from({ length: 40 }, (_unused, index) => `marker-${String(index).padStart(3, '0')}-value`);
    const list = new WriteStageUnexpectedRequestList(markers);
    expect(list.carriesMarker({ url: `https://example.com/?v=${markers[39] ?? ''}`, body: NONE })).toBe(true);
  });
});
