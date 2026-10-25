// path の型の `{id}` の区切りと、URL の path から登録の ID を取る判定（T40R2-fix で `src/discovery/fingerprint.ts` から移した。純粋な関数だけ）。
// - 発見の候補の識別（`fingerprint.ts`）、保存の確かめ（`scenario-policy.ts`）、IPC（`worker-protocol.ts`）、ワーカー（`write-create-run.ts`）、画面
//   （保存の画面の注意）が使う。画面のブラウザ側のコードは `src/core/` だけを読めるので、ここに置く（`fingerprint.ts` は公開し直す）。

/** path の型の中の、レコードの ID の区切りの印（型にちょうど 1 つ。path の 1 つの区切りの全体。T31b）。 */
export const PATH_TEMPLATE_ID_SEGMENT = '{id}';

/** path の区切り。 */
const PATH_SEPARATOR = '/';

/**
 * 登録の ID を、URL の path を ID の型（`{id}` の区切り。検証の指定の `URL_PATH_PATTERN`）に当てて取る（T40R-fix-B。区切りの数と、ほかの区切りが同じ
 * ときだけ、`{id}` の位置のそのままの値。当たらなければ null）。ワーカーが成功の後の画面から ID を取る判定と、書き込みの画面の path が型に当たるかの
 * 判定（`recordIdPatternMatchesPagePath`）の唯一の部品。ID の形（登録の ID として使える形）は呼び出し側が確かめる。
 */
export const recordIdOfPathPattern = (pathname: string, pattern: string): string | null => {
  const actual = pathname.split(PATH_SEPARATOR);
  const expected = pattern.split(PATH_SEPARATOR);
  if (actual.length !== expected.length) {
    return null;
  }
  let recordId: string | null = null;
  for (const [index, segment] of expected.entries()) {
    const value = actual[index] ?? '';
    if (segment === PATH_TEMPLATE_ID_SEGMENT) {
      recordId = value;
    } else if (segment !== value) {
      return null;
    }
  }
  return recordId;
};

/**
 * 登録の ID の取り方の、path の型の形（検証の指定の `recordId` の部分の形。path の型を持つのは `URL_PATH_PATTERN` の取り方だけ。ほかの取り方と null も
 * 受ける）。
 */
export type RecordIdPathPatternSpec = { readonly source: string; readonly pathPattern?: string } | null;

/**
 * T40R2-fix（Task 40 の設計書 7 章の「T40R2」の行。使える度合い）: 画面から ID を取る型（`URL_PATH_PATTERN` の path の型）に、書き込みの画面の path が
 * 当たるか（当たれば、保存の画面と詳細の画面に注意を出す。保存は拒まない）。path の型を持たない取り方と null は当たらない。
 */
export const recordIdPatternMatchesPagePath = (recordId: RecordIdPathPatternSpec, pagePath: string): boolean =>
  recordId?.pathPattern !== undefined && recordIdOfPathPattern(pagePath, recordId.pathPattern) !== null;
