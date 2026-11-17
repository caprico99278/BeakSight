// AUD-9a（設計書 `2026-11-09-beaksight-audit-precision-triage.md` の AUD-9a）: Finding に残す「まとめの鍵」（`groupingKeys`）の唯一の決まり。
// Rule の下書きの同一性の要素（`identityFields`。fingerprint の入力）のうち、selector の類と Rule の識別だけを、同じ値で Finding に残す。
// - fingerprint の入力とは別のものである（欄の名前を分けたのは、同じものと誤解させないため。設計者の判断。2026-11-09）。fingerprint は今のまま。
// - URL・href・title・入力欄の名前・例外の文言と stack は残さない（値や秘密が入りうるため）。
// - 許可した欄でも、属性の値を書いた selector（`[name="…"]` の形）と、秘密に見える文字（`isSecretLikeText`）を含む値は残さない。
// Rule が使う欄の名前は、すべて `GROUPING_KEY_FIELD_NAMES` か `NON_GROUPING_IDENTITY_FIELD_NAMES` のどちらかに分ける（`tests/unit/finding-grouping-keys.test.ts`
// が src/audit の名前を調べ、どちらにもない名前が出たら失敗する）。
import type { FindingFingerprintIdentityField } from '../core/ids.js';
import { isSecretLikeText } from '../core/secret-like-text.js';

/** Finding に残す欄の名前（selector の類と Rule の識別）。 */
export const GROUPING_KEY_FIELD_NAMES = Object.freeze([
  // selector の類（layout の collector の selector は `#id` か `tag:nth-of-type(n)` の連なり。axe の target は axe の selector の JSON）。
  'selector',
  'firstSelector',
  'secondSelector',
  'overlaySelector',
  'target',
  'shiftTarget',
  'elementId',
  // Rule の識別（数と digest）。
  'stressWidth',
  'notificationFrame',
  'formIndex',
] as const);

/** Finding に残さない欄の名前（fingerprint にだけ使う）。 */
export const NON_GROUPING_IDENTITY_FIELD_NAMES = Object.freeze([
  'url',
  'href',
  'targetUrl',
  'canonicalUrl',
  'title',
  'field',
  'errorName',
  'errorMessage',
  'stack',
] as const);

const GROUPING_KEY_FIELD_NAME_SET: ReadonlySet<string> = new Set(GROUPING_KEY_FIELD_NAMES);

/** 属性の値を書いた selector（`[attr=value]`・`[attr^="…"]` など）。 */
const ATTRIBUTE_VALUE_SELECTOR = /\[[^\]]*=/u;

/** Finding に残すまとめの鍵の 1 つ。名前と値は、fingerprint の入力の同じ欄と同じ。 */
export type FindingGroupingKey = FindingFingerprintIdentityField;

/** 同一性の要素から、Finding に残すまとめの鍵を選ぶ（順は下書きのまま）。 */
export const groupingKeysOf = (identityFields: readonly FindingFingerprintIdentityField[]): readonly FindingGroupingKey[] =>
  identityFields
    .filter(({ name, value }) =>
      GROUPING_KEY_FIELD_NAME_SET.has(name)
      && !ATTRIBUTE_VALUE_SELECTOR.test(value)
      && !isSecretLikeText(value))
    .map(({ name, value }) => ({ name, value }));
