// AUD-9a（設計書 `2026-11-09-beaksight-audit-precision-triage.md` の AUD-9a）: Finding に残す「まとめの鍵」（`groupingKeys`）の唯一の決まり。
// Rule の下書きの同一性の要素（`identityFields`。fingerprint の入力）のうち、selector の類と Rule の識別だけを、同じ値で Finding に残す。
// - fingerprint の入力とは別のものである（欄の名前を分けたのは、同じものと誤解させないため。設計者の判断。2026-11-09）。fingerprint は今のまま。
// - URL・href・title・入力欄の名前・例外の文言と stack は残さない（値や秘密が入りうるため）。
// - 許可した欄でも、属性の値を書いた selector（`[name="…"]` の形）と、秘密に見える文字（`isSecretLikeText`）を含む値は残さない。
// Rule が使う欄の名前は、すべて `GROUPING_KEY_FIELD_NAMES` か `NON_GROUPING_IDENTITY_FIELD_NAMES` のどちらかに分ける（`tests/unit/finding-grouping-keys.test.ts`
// が src/audit の名前を調べ、どちらにもない名前が出たら失敗する）。
import type { AccessibilityTargetSelector } from '../core/evidence-types.js';
import { createSha256Fingerprint, type FindingFingerprintIdentityField } from '../core/ids.js';
import { isSecretLikeText } from '../core/secret-like-text.js';
import { isRenderOrderId } from '../discovery/entry-check-selectors.js';

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

/**
 * REV-AUD3 の I-2: 指摘と Evidence の項目を結ぶだけの鍵の名前（Rule の下書きの `linkKeys`。Finding の `groupingKeys` の後ろに残すが、fingerprint と候補群の鍵には
 * 入れない）。`focusItem` はフォーカスの確かめの項目の番号（`src/core/focus-check-items.ts` の `FOCUS_ITEM_LINK_KEY_NAME`）。
 */
export const LINK_KEY_FIELD_NAMES = Object.freeze(['focusItem'] as const);

/** 結びだけの鍵の名前か。 */
export const isLinkKeyFieldName = (name: string): boolean => (LINK_KEY_FIELD_NAMES as readonly string[]).includes(name);

/**
 * AUD-5（設計書 `2026-11-19-beaksight-audit-result-review-fixes-design.md` 8 章）: fingerprint に入れず、候補群の鍵には入れる「区分」の鍵の名前（Rule の下書きの
 * `linkKeys` で渡す。Finding の `groupingKeys` の後ろに残る）。
 * - `findingClass`: 確信度を下げる指摘の区分（`LOWERED_FINDING_CLASSES`）。区分の違う指摘を同じ群にしない。
 * - `labelClass`: 名前の不一致の区分（`src/audit/label-in-name.ts` の `LABEL_IN_NAME_CLASSES`。確信度は表示用モデルの `verification.labelInName` で決める）。
 * - `sameTemplate`: 同じ作りの画面どうしの題名の重なりの、作りの鍵と題名の digest（同じ作りの画面の指摘を 1 つの群にまとめる。値は digest だけ）。
 * - `roundedTarget`: DEF-297: axe の指摘の対象の selector を丸めた形（`roundedSelectorOf`）の digest（共通の枠の同じ部品の指摘を、ページをまたいで 1 つの群に
 *   まとめる。属性の値を書いた selector も入るので、値は digest だけ）。候補群の鍵では、丸める前の `target` の代わりに使う（`groupKeyFieldsOf`）。
 * - `sameTitle`: DEF-305: 違う画面どうしの題名の重なりの、題名の digest（同じ題名の指摘を 1 つの群にまとめる。題名の文字は残さない）。
 */
export const GROUP_CLASS_KEY_FIELD_NAMES = Object.freeze(['findingClass', 'labelClass', 'sameTemplate', 'roundedTarget', 'sameTitle'] as const);
export type GroupClassKeyFieldName = (typeof GROUP_CLASS_KEY_FIELD_NAMES)[number];

/**
 * AUD-5: 確信度を 1 段下げる指摘の区分の閉じた一覧（`INTENDED_PLACEMENT` は画像の上に意図して置いた部品の候補、`SAME_TEMPLATE` は同じ画面の別のデータ）。
 * AUD-6（S-11）: `SINGLE_MEASUREMENT` は性能の 1 回だけの測り（測り直さない）。RVP-5: `UNREFERENCED_ID` は、参照する要素のない重なった id。
 */
export const LOWERED_FINDING_CLASSES = Object.freeze(['INTENDED_PLACEMENT', 'SAME_TEMPLATE', 'SINGLE_MEASUREMENT', 'UNREFERENCED_ID'] as const);
export type LoweredFindingClass = (typeof LOWERED_FINDING_CLASSES)[number];

/** AUD-5: 下書きの `linkKeys` に置ける名前か（結びだけの鍵か、区分の鍵）。 */
export const isFingerprintFreeKeyFieldName = (name: string): boolean =>
  isLinkKeyFieldName(name) || (GROUP_CLASS_KEY_FIELD_NAMES as readonly string[]).includes(name);

/** AUD-5: 指摘の区分の鍵の名前。 */
const FINDING_CLASS_KEY_NAME: GroupClassKeyFieldName = 'findingClass';
/** AUD-5: 同じ作りの画面の鍵の名前。 */
const SAME_TEMPLATE_KEY_NAME: GroupClassKeyFieldName = 'sameTemplate';

/** AUD-5: 指摘の区分の鍵（下書きの `linkKeys` に足す 1 つ）。 */
export const findingClassKeyOf = (findingClass: LoweredFindingClass): { readonly name: GroupClassKeyFieldName; readonly value: string } =>
  ({ name: FINDING_CLASS_KEY_NAME, value: findingClass });

/** AUD-5: 名前の不一致の区分の鍵の名前。 */
const LABEL_CLASS_KEY_NAME: GroupClassKeyFieldName = 'labelClass';

/** AUD-5: 名前の不一致の区分の鍵（値は `LABEL_IN_NAME_CLASSES` の 1 つ）。 */
export const labelClassKeyOf = (labelClass: string): { readonly name: GroupClassKeyFieldName; readonly value: string } =>
  ({ name: LABEL_CLASS_KEY_NAME, value: labelClass });

/** APS-2: Finding の鍵の、名前の不一致の区分の値（なければ `undefined`。名前の文脈を読めない指摘は、鍵だけが区分を持つ）。 */
export const labelClassOfKeys = (keys: readonly { readonly name: string; readonly value: string }[]): string | undefined =>
  keys.find(({ name }) => name === LABEL_CLASS_KEY_NAME)?.value;

/**
 * AUD-5: 同じ作りの画面どうしの題名の重なりのまとめの鍵（値は作りの鍵と題名の digest。題名の文字は残さない）。`screenKey` は作りの鍵（DEF-305: データを
 * 除いた path が同じ画面どうしは、重なりの相手にしない）。
 */
export const sameTemplateKeyOf = (screenKey: string, title: string): { readonly name: GroupClassKeyFieldName; readonly value: string } =>
  ({ name: SAME_TEMPLATE_KEY_NAME, value: createSha256Fingerprint(JSON.stringify([screenKey, title])) });

/** DEF-305: 題名の重なりの鍵の名前。 */
const SAME_TITLE_KEY_NAME: GroupClassKeyFieldName = 'sameTitle';

/** DEF-305: 違う画面どうしの題名の重なりのまとめの鍵（値は題名の digest。題名の文字は残さない）。 */
export const sameTitleKeyOf = (title: string): { readonly name: GroupClassKeyFieldName; readonly value: string } =>
  ({ name: SAME_TITLE_KEY_NAME, value: createSha256Fingerprint(JSON.stringify([title])) });

/** selector の番号（`:nth-of-type(<数>)`・`:nth-child(<数>)`）。 */
const SELECTOR_NUMBER = /:(nth-of-type|nth-child)\(\s*\d+\s*\)/gu;

/** selector の番号を `n` に丸める（候補群の鍵だけに使う。AUD-9b の作りの印のある群と、DEF-297 の `roundedTarget`）。 */
export const roundSelectorNumbers = (value: string): string => value.replace(SELECTOR_NUMBER, (_whole, kind: string) => `:${kind}(n)`);

/** selector の `#id` の部分（CSS の識別子の escape を含む）。 */
const SELECTOR_ID = /#((?:\\[0-9A-Fa-f]{1,6}[ \t\n]?|\\[^\n0-9A-Fa-f]|[A-Za-z0-9_\u0080-\u{10FFFF}-])+)/gu;
/** CSS の識別子の escape（16 進のコードか、1 文字）。 */
const CSS_ESCAPE = /\\([0-9A-Fa-f]{1,6})[ \t\n]?|\\(.)/gu;
/** 描画の順で替わる id を丸めた形。 */
const ROUNDED_RENDER_ORDER_ID = '#(id)';

/**
 * DEF-297: 候補群の鍵に使う selector の丸め（番号 `roundSelectorNumbers` と、描画の順で替わる id。id の判定は WBF の `isRenderOrderId` の 1 か所）。
 */
export const roundedSelectorOf = (value: string): string =>
  roundSelectorNumbers(value).replace(SELECTOR_ID, (whole, escaped: string) => {
    const id = escaped.replace(CSS_ESCAPE, (_escape, hex: string | undefined, char: string | undefined) =>
      (hex === undefined ? char ?? '' : String.fromCodePoint(Number.parseInt(hex, 16))));
    return isRenderOrderId(id) ? ROUNDED_RENDER_ORDER_ID : whole;
  });

/** DEF-297: 丸めた対象の鍵の名前。 */
const ROUNDED_TARGET_KEY_NAME: GroupClassKeyFieldName = 'roundedTarget';
/** 丸めた対象の鍵が代わりになる、丸める前の鍵の名前（axe の target）。 */
const RAW_TARGET_KEY_NAME = 'target';

/** DEF-297: axe の指摘の対象の selector を丸めた形の鍵（下書きの `linkKeys` に足す 1 つ。値は digest）。 */
export const roundedTargetKeyOf = (
  targetSelectors: readonly AccessibilityTargetSelector[],
): { readonly name: GroupClassKeyFieldName; readonly value: string } => ({
  name: ROUNDED_TARGET_KEY_NAME,
  value: createSha256Fingerprint(JSON.stringify(targetSelectors.map((selector) =>
    (typeof selector === 'string' ? roundedSelectorOf(selector) : selector.map(roundedSelectorOf))))),
});

/**
 * 候補群の鍵に入れる Finding の鍵（唯一の決まり）。結びだけの鍵（`isLinkKeyFieldName`）は入れない。DEF-297: 丸めた対象の鍵（`roundedTarget`）があれば、丸める前の
 * `target` は入れない（描画の順の id だけ違う同じ部品を、同じ群にする）。順は Finding のまま。
 */
export const groupKeyFieldsOf = (keys: readonly { readonly name: string; readonly value: string }[]): readonly { readonly name: string; readonly value: string }[] => {
  const rounded = keys.some(({ name }) => name === ROUNDED_TARGET_KEY_NAME);
  return keys.filter(({ name }) => !isLinkKeyFieldName(name) && !(rounded && name === RAW_TARGET_KEY_NAME)).map(({ name, value }) => ({ name, value }));
};

/** AUD-5: Finding の鍵に、確信度を下げる区分（`LOWERED_FINDING_CLASSES`）があるか。 */
export const hasLoweredFindingClass = (keys: readonly { readonly name: string; readonly value: string }[]): boolean =>
  keys.some(({ name, value }) => name === FINDING_CLASS_KEY_NAME && (LOWERED_FINDING_CLASSES as readonly string[]).includes(value));

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
