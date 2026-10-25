// T39c（Task 39 の設計書 3.4、Task 40 の D3 の口）: API の書き込みの応答の本文から、登録の ID の取り方（`RESPONSE_BODY_KEY`）の鍵で ID を取り出す口
// （`src/control/actions/api-record-id.ts` の `apiRecordIdOfResponseBody`）。メモリの中だけで扱い、使える形の ID（`isUsableRecordId`）だけを返す。
import { describe, expect, it } from 'vitest';
import { MAX_SAFE_RECORD_ID_LENGTH } from '../../src/control/actions/action-outcome.js';
import {
  MAX_API_RECORD_ID_BODY_BYTES,
  apiRecordIdOfResponseBody,
  apiResponseBodyShapeOf,
  apiResponseListLength,
  type ApiResponseBodyShape,
} from '../../src/control/actions/api-record-id.js';

const bodyOf = (value: unknown): Buffer => Buffer.from(JSON.stringify(value), 'utf8');

describe('T39c: the record id from the response body of an API write', () => {
  it.each<[string, Buffer, string, string | null]>([
    ['a string id of an object', bodyOf({ id: 'rec_1-a', name: 'x' }), 'id', 'rec_1-a'],
    ['an integer id of an object', bodyOf({ id: 1001 }), 'id', '1001'],
    ['the id of the only object of an array (the representation)', bodyOf([{ id: 7, name: 'x' }]), 'id', '7'],
    ['another key', bodyOf({ member_id: 'm-9', id: 'x' }), 'member_id', 'm-9'],
    ['no such key', bodyOf({ name: 'x' }), 'id', null],
    ['an inherited key', bodyOf({ name: 'x' }), 'constructor', null],
    ['an array of two objects', bodyOf([{ id: 1 }, { id: 2 }]), 'id', null],
    ['an empty array', bodyOf([]), 'id', null],
    ['a nested id', bodyOf({ data: { id: 1 } }), 'id', null],
    ['an id with a slash', bodyOf({ id: 'a/b' }), 'id', null],
    ['an id with a dot', bodyOf({ id: '..' }), 'id', null],
    ['an id with a space', bodyOf({ id: 'a b' }), 'id', null],
    ['an empty id', bodyOf({ id: '' }), 'id', null],
    ['a too long id', bodyOf({ id: 'a'.repeat(MAX_SAFE_RECORD_ID_LENGTH + 1) }), 'id', null],
    ['a negative number', bodyOf({ id: -1 }), 'id', null],
    ['a fraction', bodyOf({ id: 1.5 }), 'id', null],
    ['an unsafe integer', Buffer.from('{"id":12345678901234567890}', 'utf8'), 'id', null],
    ['a boolean', bodyOf({ id: true }), 'id', null],
    ['null', bodyOf({ id: null }), 'id', null],
    ['not JSON', Buffer.from('<h1>ok</h1>', 'utf8'), 'id', null],
    ['not UTF-8', Buffer.from([0x7b, 0x22, 0x69, 0x64, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]), 'id', null],
    ['an empty key', bodyOf({ '': 'x' }), '', null],
  ])('%s', (_label, body, key, expected) => {
    expect(apiRecordIdOfResponseBody(body, key)).toBe(expected);
  });

  it('does not read a body over the limit', () => {
    const padding = ' '.repeat(MAX_API_RECORD_ID_BODY_BYTES);
    expect(apiRecordIdOfResponseBody(Buffer.from(`{"id":"rec"}${padding}`, 'utf8'), 'id')).toBeNull();
  });

  it('never throws on a wrong input', () => {
    expect(apiRecordIdOfResponseBody(null as unknown as Buffer, 'id')).toBeNull();
    expect(apiRecordIdOfResponseBody(bodyOf({ id: 'x' }), null as unknown as string)).toBeNull();
  });
});

// CC-104（T41R2-fix の発見事項 1）: 応答の本文の解読（上限、UTF-8、JSON）の唯一の部品（`apiResponseBodyShapeOf`）。一覧の要素の数（`apiResponseListLength`）、
// 読めない本文（ワーカーの `isUnreadableApiResponseBody`）、登録の ID（`apiRecordIdOfResponseBody`）は、どれもこの上に載る。
describe('CC-104: the shape of the response body of an API write (apiResponseBodyShapeOf)', () => {
  it.each<[string, Uint8Array, ApiResponseBodyShape]>([
    ['an empty body (204)', Buffer.alloc(0), { kind: 'NONE' }],
    ['an empty list', bodyOf([]), { kind: 'LIST', length: 0 }],
    ['a list of two rows', bodyOf([{ id: 12 }, { id: 13 }]), { kind: 'LIST', length: 2 }],
    ['an object', bodyOf({ id: 1 }), { kind: 'OTHER' }],
    ['a JSON scalar', bodyOf(true), { kind: 'OTHER' }],
    ['spaces only', Buffer.from('  ', 'utf8'), { kind: 'UNREADABLE' }],
    ['not JSON', Buffer.from('updated', 'utf8'), { kind: 'UNREADABLE' }],
    ['not UTF-8', Buffer.from([0x5b, 0xff, 0x5d]), { kind: 'UNREADABLE' }],
    ['over the limit', Buffer.alloc(MAX_API_RECORD_ID_BODY_BYTES + 1, 0x20), { kind: 'UNREADABLE' }],
    ['not bytes', null as unknown as Uint8Array, { kind: 'UNREADABLE' }],
  ])('%s', (_label, body, expected) => {
    expect(apiResponseBodyShapeOf(body)).toEqual(expected);
  });

  it('gives the number of the rows of a list only (apiResponseListLength)', () => {
    expect(apiResponseListLength(bodyOf([{ id: 1 }, { id: 2 }]))).toBe(2);
    expect(apiResponseListLength(bodyOf([]))).toBe(0);
    expect(apiResponseListLength(bodyOf({ id: 1 }))).toBeNull();
    expect(apiResponseListLength(Buffer.alloc(0))).toBeNull();
    expect(apiResponseListLength(Buffer.from('updated', 'utf8'))).toBeNull();
  });
});
