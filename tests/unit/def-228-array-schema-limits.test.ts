// DEF-228（SREV-ARR の M1・SREV-ARR2 の M3）: 一覧の形の値の上限が、schema（`schemas/control/candidate.schema.json`・`scenario.schema.json`）に直に
// 書かれていた。L13 fix round 1 で上限を撤廃したので、schema に残っていないことを確かめる。速さのため、スキーマのファイルは 1 回だけ読み、JSON pointer で値を引く。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const schemaOf = (name: string): unknown => JSON.parse(readFileSync(resolve(process.cwd(), 'schemas', 'control', `${name}.schema.json`), 'utf8')) as unknown;
const SCHEMAS: Readonly<Record<string, unknown>> = { candidate: schemaOf('candidate'), scenario: schemaOf('scenario') };

/** JSON pointer（RFC 6901）で値を引く（なければ undefined）。 */
const valueAt = (document: unknown, pointer: string): unknown => pointer.split('/').slice(1)
  .map((token) => token.split('~1').join('/').split('~0').join('~'))
  .reduce<unknown>((current, token) => (current !== null && typeof current === 'object' ? (current as Record<string, unknown>)[token] : undefined), document);

const POSITIONS = '/$defs/apiRequestBody/properties/keys/items/properties/elements/properties/positions';
const INNER_KEYS = `${POSITIONS}/items/properties/keys`;

/**
 * `[schema, JSON pointer]`。L13 fix round 1: 一覧の要素の数（前は 20）と行の中の鍵の数（前は 16）の上限は撤廃した（schema にも書かない）。
 * L13（N25）: 目印の数と名前の長さの上限も撤廃した（`submission-probe-artifact.test.ts`）。
 */
const FORMER_LIMITS: readonly (readonly [string, string])[] = [
  // 型の記録（candidate）: 位置の情報（ARR-3）、行の中の鍵（ARR-5）。
  ['candidate', `${POSITIONS}/maxItems`],
  ['candidate', `${INNER_KEYS}/maxItems`],
  // 承認の内容（scenario）: ページが決める一覧の数（ARR-2）、位置の役（ARR-3）、要素の位置（ARR-4）、行の役（ARR-5）。
  ['scenario', '/$defs/api/properties/pageKeys/items/properties/elements/properties/count/maximum'],
  ['scenario', '/$defs/apiKeyField/properties/positions/maxItems'],
  ['scenario', '/$defs/apiKeyField/properties/element/properties/index/maximum'],
  ['scenario', '/$defs/apiKeyField/properties/rows/maxItems'],
  ['scenario', '/$defs/apiKeyField/properties/rows/items/maxItems'],
];

describe('DEF-228: the array values in the control schemas have no limit (L13 fix round 1)', () => {
  it.each(FORMER_LIMITS)('has no %s#%s', (schema, pointer) => {
    expect(valueAt(SCHEMAS[schema], pointer)).toBeUndefined();
  });
});
