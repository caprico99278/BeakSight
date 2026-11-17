// path の型の `{id}` の区切りと、URL の path から登録の ID を取る判定（T40R2-fix で `src/discovery/fingerprint.ts` から移した。純粋な関数だけ）。
// - 発見の候補の識別（`fingerprint.ts`）、保存の確かめ（`scenario-policy.ts`）、IPC（`worker-protocol.ts`）、ワーカー（`write-create-run.ts`）が
//   使う。画面のブラウザ側のコードは `src/core/` だけを読めるので、ここに置く（`fingerprint.ts` は公開し直す）。

/** path の型の中の、レコードの ID の区切りの印（型にちょうど 1 つ。path の 1 つの区切りの全体。T31b）。 */
export const PATH_TEMPLATE_ID_SEGMENT = '{id}';

/** path の区切り。 */
const PATH_SEPARATOR = '/';

// L12b（設計書 `2026-11-09-beaksight-remove-limits-design.md` 6.2。S18 と L12b の設計者の判断 1・2）: 登録の ID の長さの上限（前は 64 文字、その後
// 256 文字の `MAX_SAFE_RECORD_ID_LENGTH`）は撤廃した。管理データの ID の列（`target_record_id`・`record_id`）も、版 19 で長さの上限を外した。
// 使える文字の決まり（下の `SAFE_RECORD_ID_PATTERN`）は今のまま。

/**
 * 登録の ID として使える文字（T30f。英数字・`_`・`-` だけ。path の区切り・`.`・percent-encode・空白・非 ASCII を含まない）。CCX-28: スキーマの
 * 対象のレコードの ID の `pattern`（`source`）がこの値と同じことを、`schema-enum-consistency.test.ts` が確かめるので公開する（`g`・`y` を持たないので
 * `test` は状態を持たない）。
 */
export const SAFE_RECORD_ID_PATTERN = /^[A-Za-z0-9_-]+$/u;

/**
 * 登録の ID として使える値か（T30f で狭めた。Task 31 と共用する唯一の判定）: path の 1 区切りに入れて安全な閉じた形（英数字・`_`・`-`、1 文字以上。
 * L12b: 長さは見ない）。使えなければ、ID なしとして扱う。LU-5: 書き込みの段の照合（path の形の更新の台帳の ID）も使う。
 */
export const isUsableRecordId = (recordId: string | null): recordId is string =>
  recordId !== null && SAFE_RECORD_ID_PATTERN.test(recordId);

/**
 * 登録の ID を、URL の path を ID の型（`{id}` の区切り。検証の指定の `URL_PATH_PATTERN`）に当てて取る（T40R-fix-B。区切りの数と、ほかの区切りが同じ
 * ときだけ、`{id}` の位置のそのままの値。当たらなければ null）。ワーカーが成功の後の画面から ID を取る判定の唯一の部品（SPEC-4: 書き込みの画面の
 * path が型に当たるかの注意の判定は、使う画面がなくなったので捨てた）。ID の形（登録の ID として使える形）は呼び出し側が確かめる。
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
