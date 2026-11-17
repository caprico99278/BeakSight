// COV-6（設計書 `2026-11-09-beaksight-coverage-by-state-design.md` 3.3 の「Evidence・リンク…の件数の上限」）: 件数の上限で打ち切らずに、読み取りを
// 部分に分けて続きの位置から読み直す、唯一の繰り返しの部品。1 回の読み取りの大きさ（部分の件数）は、呼び出し側が名前つきの定数（自分の処理の上限 C）で決める。
// サイトへの読み込みは増やさない（同じページの中の読み取りを分けるだけ）。回数の上限は持たない（読み取りが次の位置を返さなくなったら終わる）。

/** 1 回の読み取りの結果: 読んだ部分と、次に読む位置（終わりは `null`）。 */
export interface PartRead<C, P> {
  readonly part: P;
  readonly next: C | null;
}

/** `first` の位置から、次の位置がなくなるまで `readPart` を順に呼び、読んだ部分を読んだ順に返す（凍結）。 */
export const readInParts = async <C, P>(first: C, readPart: (cursor: C) => Promise<PartRead<C, P>>): Promise<readonly P[]> => {
  const parts: P[] = [];
  let cursor: C | null = first;
  while (cursor !== null) {
    // 部分は前の部分の次の位置から読むので、順に待つ。
    const read: PartRead<C, P> = await readPart(cursor);
    parts.push(read.part);
    cursor = read.next;
  }
  return Object.freeze(parts);
};
