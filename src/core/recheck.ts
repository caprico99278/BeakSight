// AUD-2d（整理の文書 `doc/design/2026-11-09-beaksight-audit-precision-triage.md` の AUD-2d）: 落ち着いた後の確かめ直しの印の、唯一の決め方。
// 1 回目の項目と確かめ直しの項目を、同じ鍵で比べる。両方にあれば `PERSISTENT`、1 回目だけなら `INITIAL_ONLY`、確かめ直しだけなら `LATE`。
// 並びは、1 回目の順（`PERSISTENT`・`INITIAL_ONLY`）の後に、確かめ直しの順（`LATE`）。同じ鍵の項目が 1 回目に 2 つあれば、どちらも同じ印にする。
// 純粋な関数だけのファイル（import は core の型だけ）。
import type { RecheckState } from './contracts.js';

/** 印を付けた項目。 */
export interface RecheckedItem<T> {
  readonly item: T;
  readonly state: RecheckState;
}

/** 1 回目（`first`）と確かめ直し（`rechecked`）の項目に、鍵（`keyOf`）で印を付ける。 */
export function recheckStatesOf<T>(first: readonly T[], rechecked: readonly T[], keyOf: (item: T) => string): readonly RecheckedItem<T>[] {
  const firstKeys = new Set(first.map(keyOf));
  const recheckedKeys = new Set(rechecked.map(keyOf));
  const lateKeys = new Set<string>();
  const late: RecheckedItem<T>[] = [];
  for (const item of rechecked) {
    const key = keyOf(item);
    if (!firstKeys.has(key) && !lateKeys.has(key)) {
      lateKeys.add(key);
      late.push(Object.freeze({ item, state: 'LATE' }));
    }
  }
  return Object.freeze([
    ...first.map((item): RecheckedItem<T> => Object.freeze({ item, state: recheckedKeys.has(keyOf(item)) ? 'PERSISTENT' : 'INITIAL_ONLY' })),
    ...late,
  ]);
}
