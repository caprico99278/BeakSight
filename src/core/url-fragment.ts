/**
 * URL の文字列が fragment（`#` から後ろ）を持つかの判定の唯一の owner（T43b fix round 1。共通化）。純粋な関数だけ（画面のブラウザ側も読む）。
 * - 入力の決まりで「fragment を持たない」とする URL（開始の URL: `src/config/target-config-draft.ts`、認証の設定の URL:
 *   `src/control/auth/auth-setup-policy.ts`）が使う。解析の前の文字列で判定するので、空の fragment（末尾の `#`）も持つとみなす
 *   （`URL.hash` は空の fragment を `''` にするため使わない）。
 */

/** fragment の区切り。 */
const FRAGMENT_SEPARATOR = '#';

/** URL の文字列が fragment を持つか（`#` を含むか。空の fragment を含む）。 */
export const hasUrlFragment = (value: string): boolean => value.includes(FRAGMENT_SEPARATOR);
