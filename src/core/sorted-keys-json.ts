// 鍵を並べた JSON の唯一の owner（CC-078 の後半。CCX-12）。純粋な関数。
// - 同じ内容の文書から、鍵の順によらず、同じ JSON の文字列を作る（digest の入力にする）。ワーカーの `START` の認証の SHA-256
//   （`src/control/worker-protocol.ts`）と、承認に縛る認証の設定の digest（`src/control/auth/auth-setup-digest.ts`）が共用する。
// - オブジェクト（`isRecord`）の鍵を UTF-16 のコード単位の順（`compareCodeUnits`）に並べる（入れ子も）。配列の順は変えない。ほかの値はそのまま
//   `JSON.stringify` に渡す（`undefined` の項目は JSON から落ちる）。与えた値は変えない。
// - 鍵を並べる処理は、このファイルの外に書かない（`tests/architecture/core-small-parts-ownership.test.ts` の (e)）。
import { isRecord } from './guards.js';
import { compareCodeUnits } from './text.js';

/** 鍵を UTF-16 のコード単位の順に並べた値（配列の順は変えない）。 */
const withSortedKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(withSortedKeys);
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.keys(value).sort(compareCodeUnits).map((key) => [key, withSortedKeys(value[key])]));
  }
  return value;
};

/** 鍵を並べた JSON の文字列（`JSON.stringify` の結果。値が JSON にならない場合（`undefined` など）の扱いも `JSON.stringify` と同じ）。 */
export const sortedKeysJsonOf = (value: unknown): string => JSON.stringify(withSortedKeys(value));
