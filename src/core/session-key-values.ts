// DEF-233（設計書 `doc/design/2026-11-09-beaksight-discovery-token-refresh-design.md` 2.1・2.2。fix round 2 の SREV-233 の C-1・C-3）: ログインの成功の鍵（session key）の
// 値の比べの唯一の部品。純粋な関数だけ（ブラウザの部品を import しない。要求の判定の owner `src/safety/request-policy.ts` と、Context の作り手
// `src/browser/context-factory.ts` が共用する）。値は比べるだけで、記録しない。
// - `stringLeavesOf`: 文字列の中の文字列の値（JSON として読めれば入れ子の中のすべての文字列。読めなければ文字列そのもの 1 つ）。
// - fix round 3（SREV-233 の確かめ直しの N-1）: `refreshBodyShapeOf`・`topLevelStringsOf`・`isReferencedRefreshBody`。凍結の段で通す更新の本文は、凍結の前に
//   通して確かめた更新の本文の形（鍵の名前の並び）と同じで、値は今の鍵（BeakSight が渡した状態か、Guard が通した更新の応答）の同じ道の文字列だけ。
// - `sessionKeyValueRebuiltFrom`（DEF-251）: 次の画面へ渡す鍵の値を、押す前の値の構造に、凍結の段に通した最後の更新の応答の値を同じ道で当てはめて作る
//   （ページが閉じる前に書いた値は使わない。C-3・N-3・I-1 の守りを、比べでなく作り方で保つ）。

/** 文字列の値を取り出す深さの上限（読んだ JSON の入れ子がこれより深い所は見ない）。 */
const MAX_JSON_DEPTH = 8;

/** JSON として読む（読めなければ `undefined`。投げない）。 */
const parsedJsonOf = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

/** 素の object か（配列と null でない）。 */
const isPlainObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** 文字列の中の文字列の値（JSON として読めれば、入れ子の中のすべての文字列。読めなければ、文字列そのもの 1 つ）。投げない。 */
export function stringLeavesOf(text: string): readonly string[] {
  const parsed = parsedJsonOf(text);
  if (parsed === undefined) {
    return [text];
  }
  const leaves: string[] = [];
  const walk = (value: unknown, depth: number): void => {
    if (typeof value === 'string') {
      leaves.push(value);
    } else if (depth < MAX_JSON_DEPTH && Array.isArray(value)) {
      value.forEach((item) => walk(item, depth + 1));
    } else if (depth < MAX_JSON_DEPTH && isPlainObject(value)) {
      Object.values(value).forEach((item) => walk(item, depth + 1));
    }
  };
  walk(parsed, 0);
  return leaves;
}

/**
 * fix round 3（N-1）: 更新の本文の形（JSON の素の object で、値がどれも文字列のときの、鍵の名前を並べたもの）。それ以外（JSON でない・object でない・文字列でない
 * 値がある・空）は null。
 */
export function refreshBodyShapeOf(text: string): readonly string[] | null {
  const parsed = parsedJsonOf(text);
  if (!isPlainObject(parsed)) {
    return null;
  }
  const entries = Object.entries(parsed);
  return entries.length > 0 && entries.every(([, value]) => typeof value === 'string') ? Object.freeze(entries.map(([name]) => name).sort()) : null;
}

/** fix round 3（N-1）: JSON の素の object の、根の文字列の値（名前ごと）。JSON の object でなければ空。 */
export function topLevelStringsOf(text: string): ReadonlyMap<string, string> {
  const parsed = parsedJsonOf(text);
  const strings = new Map<string, string>();
  if (isPlainObject(parsed)) {
    for (const [name, value] of Object.entries(parsed)) {
      if (typeof value === 'string') strings.set(name, value);
    }
  }
  return strings;
}

/**
 * fix round 3（SREV-233 の確かめ直しの N-1）: 凍結の段で通す更新の比べの相手（factory が Run と Context の記録から作る）。
 * - `bodyShape`: 凍結の前に通して確かめた更新の本文の形（`refreshBodyShapeOf`）。
 * - `current`: 今の鍵の、根の文字列の値（BeakSight が渡した状態か、その後に Guard が通した最も新しい更新の応答。ページが書いた状態は使わない）。
 * - `headers`: 凍結の前に通して確かめた更新の要求の header（小文字の名前ごとに値 1 つ）。
 */
export interface FrozenRefreshReference {
  readonly bodyShape: readonly string[];
  readonly current: ReadonlyMap<string, string>;
  readonly headers: ReadonlyMap<string, string>;
}

/**
 * fix round 3（N-1）: 凍結の段で通す更新の本文か。形が `bodyShape` と同じで、どの値も `current` の同じ名前の値と同じときだけ真（名前と値の組み替え・位置の名前に
 * 文字を置く形・符号表の値は通さない）。
 */
export function isReferencedRefreshBody(text: string, reference: FrozenRefreshReference): boolean {
  const shape = refreshBodyShapeOf(text);
  if (shape === null || shape.length !== reference.bodyShape.length || !shape.every((name, index) => name === reference.bodyShape[index])) {
    return false;
  }
  return [...topLevelStringsOf(text).entries()].every(([name, value]) => reference.current.get(name) === value);
}

/**
 * fix round 2（SREV-233 の C-3 と、Blocker 2 の後の設計者の判断）: 凍結の段に A1 で通した更新の応答の値（A2 の重ねの比べの相手）。
 * - `strings`: 応答の本文の中のすべての文字列の値。
 * - `scalars`: 応答の本文の中の、文字列でない値（数・真偽・null）を、道（根からの鍵の名前と配列の位置の並び。`pathKeyOf`）ごとに。
 */
export interface IssuedSessionValues {
  /** 応答の本文の中の、文字列・数・真偽・null の値を、道（根からの鍵の名前と配列の位置の並び。`pathKeyOf`）ごとに（JSON でない応答は、根の道に本文そのもの）。 */
  readonly byPath: ReadonlyMap<string, readonly unknown[]>;
}

/** 道の比べる形。 */
const pathKeyOf = (path: readonly (string | number)[]): string => JSON.stringify(path);

/**
 * 更新の応答の本文の一覧から、比べの相手を作る。fix round 4（3 回目の確かめ直しの I-1）: A2 の重ねでは、凍結の段に通した最後の 1 つの応答だけを渡す（全部の道を同じ
 * 応答にそろえ、2 回以上の更新のどちらの応答の値を置くかで運ばせない。呼ぶ側は `context-factory.ts` の `#tokenRefreshIssuedValuesOf`）。
 */
export function issuedSessionValuesOf(texts: readonly string[]): IssuedSessionValues {
  const byPath = new Map<string, unknown[]>();
  const add = (path: readonly (string | number)[], value: unknown): void => {
    const key = pathKeyOf(path);
    byPath.set(key, [...(byPath.get(key) ?? []), value]);
  };
  const walk = (value: unknown, path: readonly (string | number)[]): void => {
    if (path.length > MAX_JSON_DEPTH) return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, [...path, index]));
    } else if (isPlainObject(value)) {
      for (const [name, item] of Object.entries(value)) walk(item, [...path, name]);
    } else {
      add(path, value);
    }
  };
  for (const text of texts) {
    const parsed = parsedJsonOf(text);
    walk(parsed === undefined ? text : parsed, []);
  }
  return Object.freeze({ byPath });
}

/**
 * DEF-251（案 1。DEF-233 の A2 の重ねの後継）: 次の画面へ渡す成功の鍵の値を、押す前の値（`before`）の構造に、サイトの token の更新の応答（`issued`。その Context で
 * 凍結の段に通した最後の 1 つの応答。`issuedSessionValuesOf`）の値を、同じ道で当てはめて作る。ページが閉じる前に書いた値は使わない（押下で書き足した鍵の名前・欄・
 * 値は入らない。値の出どころは、押す前の値と応答だけ）。
 * - 当てはめるのは、押す前の値の葉（文字列・数・真偽）のうち、応答の同じ道に、同じ型の値がちょうど 1 つあるものだけ。null・型の違う値・応答にない道は押す前のまま。
 *   押す前の値にない道は足さない（構造は押す前の値のまま）。同じ道に 2 つ以上の値（2 つの応答）があれば当てはめない（I-1。どちらの応答の値を置くかで運ばせない）。
 * - 文字列が 1 つも変わらなければ（応答の道と押す前の値の道が違う形・入れ子・JSON の object や配列でない値・応答がない）null（押す前の値のまま）。投げない。
 */
export function sessionKeyValueRebuiltFrom(before: string, issued: IssuedSessionValues): string | null {
  const parsed = parsedJsonOf(before);
  if (!isPlainObject(parsed) && !Array.isArray(parsed)) {
    return null;
  }
  let changedStrings = 0;
  const rebuild = (value: unknown, path: readonly (string | number)[]): unknown => {
    if (path.length > MAX_JSON_DEPTH) {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map((item, index) => rebuild(item, [...path, index]));
    }
    if (isPlainObject(value)) {
      return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, rebuild(item, [...path, name])]));
    }
    const values = issued.byPath.get(pathKeyOf(path)) ?? [];
    const [issuedValue] = values;
    const scalar = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
    if (values.length !== 1 || !scalar || typeof issuedValue !== typeof value) {
      return value;
    }
    if (typeof value === 'string' && issuedValue !== value) {
      changedStrings += 1;
    }
    return issuedValue;
  };
  const rebuilt = rebuild(parsed, []);
  return changedStrings > 0 ? JSON.stringify(rebuilt) : null;
}
