// T41R2-fix-B・T41R3-fix-B（Task 41 の設計書 8 章の「T41R2」の C-2 (1)、「T41R3」の C-3 (1) とユーザーの判断「API の更新だけ台帳と比べる」）: 対象のレコード
// について、保つ鍵ごとに最後に分かっている値（空を含む）を、台帳の登録で送った値と、その後の照合済みの更新で変えた値から求める。`START` の API の更新の
// 指定の `update.knownKeptValues`（`{ key, value }` の一覧。値は BeakSight が作ったテストの値で、`values` と同じ扱い）。T41R3-fix-B で、空でない鍵の名前だけを
// 返す `knownFilledKeysOf`（`knownFilledKeptKeys`）をこれに置き換えた（同じ意味を 2 つ持たない）。
// - 求め方（`knownKeptValuesOf`）: 対象の ID の照合済みの登録の値に、同じ ID の照合済みの更新の値を、送った時刻の順に重ねる。台帳が知らない鍵（登録で
//   送らなかった鍵）は入れない。空の値も入れる。照合済みでない更新（`UNKNOWN` など）は使わない。
// - 開始の指定（`writeStartSpecOf`）が台帳の書き込みの値の履歴から一覧を求めて入れ、IPC（手書きの確かめと Schema）は、保つ鍵の一部・鍵の重なりなし・上限・
//   値の長さで縛る。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_SUBMITTED_VALUE_LENGTH } from '../../src/control/actions/action-contracts.js';
import { knownKeptValuesOf, type RecordValueWrite } from '../../src/control/actions/write-result-facts.js';
import { MAX_SCENARIO_API_KEYS } from '../../src/control/approval/scenario-contracts.js';

const SCHEMA = JSON.parse(readFileSync(resolve(process.cwd(), 'schemas', 'control', 'worker-message.schema.json'), 'utf8')) as {
  readonly $defs: Record<string, { readonly properties: Record<string, Record<string, unknown>> }>;
};

const KEPT = ['email', 'note', 'score'] as const;

const registration = (recordId: string, values: Record<string, string>, overrides: Partial<RecordValueWrite> = {}): RecordValueWrite => ({
  writeKind: 'CREATE', recordId, targetRecordId: null, result: 'VERIFIED', submittedValues: values, submittedAt: '20261018000000', recordedAt: '20261018000000',
  ...overrides,
});
const updateOf = (targetRecordId: string, values: Record<string, string>, at: string, overrides: Partial<RecordValueWrite> = {}): RecordValueWrite => ({
  writeKind: 'UPDATE', recordId: targetRecordId, targetRecordId, result: 'VERIFIED', submittedValues: values, submittedAt: at, recordedAt: at, ...overrides,
});

describe('T41R3-fix-B: the last known values of the kept keys (knownKeptValuesOf)', () => {
  it.each<readonly [string, readonly RecordValueWrite[], readonly { readonly key: string; readonly value: string }[]]>([
    ['the registration only', [registration('7', { name: 'a', email: 'e@example.invalid', note: 'n', score: '1' })],
      [{ key: 'email', value: 'e@example.invalid' }, { key: 'note', value: 'n' }, { key: 'score', value: '1' }]],
    ['an empty value in the registration (kept as empty)', [registration('7', { name: 'a', email: '', note: 'n', score: '1' })],
      [{ key: 'email', value: '' }, { key: 'note', value: 'n' }, { key: 'score', value: '1' }]],
    ['a key the registration did not send (unknown to the ledger)', [registration('7', { name: 'a', email: 'e@example.invalid' })],
      [{ key: 'email', value: 'e@example.invalid' }]],
    ['a verified update that emptied a key, and one that filled a key', [
      registration('7', { name: 'a', email: 'e@example.invalid', note: '' }),
      updateOf('7', { email: '' }, '20261018001000'),
      updateOf('7', { note: 'later' }, '20261018002000'),
    ], [{ key: 'email', value: '' }, { key: 'note', value: 'later' }]],
    ['the later of two verified updates of the same key', [
      registration('7', { email: 'e@example.invalid' }),
      updateOf('7', { email: 'x@example.invalid' }, '20261018002000'),
      updateOf('7', { email: '' }, '20261018001000'),
    ], [{ key: 'email', value: 'x@example.invalid' }]],
    ['an UNKNOWN or BLOCKED update (not used)', [
      registration('7', { email: 'e@example.invalid', score: '1' }),
      updateOf('7', { email: '' }, '20261018001000', { result: 'UNKNOWN' }),
      updateOf('7', { score: '' }, '20261018002000', { result: 'BLOCKED' }),
    ], [{ key: 'email', value: 'e@example.invalid' }, { key: 'score', value: '1' }]],
    ['the registration and the updates of another record', [
      registration('8', { email: 'e@example.invalid' }),
      updateOf('8', { score: '2' }, '20261018001000'),
    ], []],
    ['a registration that is not verified', [registration('7', { email: 'e@example.invalid' }, { result: 'PARTIAL' })], []],
    ['no write', [], []],
  ])('gives the kept values for %s', (_label, writes, values) => {
    expect(knownKeptValuesOf(writes, '7', KEPT)).toEqual(values);
  });

  it('gives the values in the order of the kept keys, frozen', () => {
    const values = knownKeptValuesOf([registration('7', { score: '1', email: 'e@example.invalid' })], '7', KEPT);
    expect(values.map(({ key }) => key)).toEqual(['email', 'score']);
    expect(Object.isFrozen(values)).toBe(true);
  });
});

describe('T41R3-fix-B: the schema of the known kept values', () => {
  it('has the list of the key and the value in the update block of the API write (required, within the limits), and no list of the names only', () => {
    const update = SCHEMA.$defs['startApiWrite']?.properties['update'] as Record<string, unknown>;
    expect(update['required']).toEqual(['targetRecordId', 'knownKeptValues']);
    const properties = update['properties'] as Record<string, unknown>;
    expect(Object.keys(properties).sort()).toEqual(['knownKeptValues', 'targetRecordId']);
    expect(properties['knownKeptValues']).toMatchObject({
      type: 'array',
      maxItems: MAX_SCENARIO_API_KEYS,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'value'],
        properties: {
          key: { $ref: 'urn:beaksight:schema:control:scenario:1#/$defs/apiKey' },
          value: { type: 'string', maxLength: MAX_SUBMITTED_VALUE_LENGTH },
        },
      },
    });
  });
});
