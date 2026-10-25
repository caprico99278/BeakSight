// 外部到達の語の一覧の唯一の owner（Task 29 の設計書 3 章、5 章。T29a）。比べ方もここに置く。
// - 外部到達の欄: 値が人の宛先に届きうる欄（メール、電話）、通知・SMS・配信を求める欄、住所の欄。入力の規則の判定（T29c）が、メールは
//   `example.invalid` の宛先だけ、電話は `090-0XXX-XXXX` の形だけ、通知の欄は「送らない」側だけ、住所は人の値だけにするために使う。辞書の
//   固定のテスト（T29b）も、この一覧に当たらないことを確かめる。
// - 判定の材料: 欄の型（`email`・`tel`）、autocomplete の値（HTML の autofill の欄の名前。空白で分けた語のどれかが一覧の値と一致する）、欄の
//   名前の語。
// - 欄の名前の語の比べ方（発見の分類の GET の form の欄の名前の危険な語と同じ語の単位。`src/discovery/classify.ts` の
//   `fieldNameHasListedWord` を使い、書き写さない。T29c。CC-082）: 英語の語（ASCII だけの語）は、欄の名前を分けた語の並びに、一覧の語を同じ
//   関数で分けた語の並びがそのまま現れるときだけ当たる（`hotel` は `tel` に当たらず、`telNumber`・`tel_1` は当たる）。複数形は一覧に書く（語幹
//   では当てない）。日本語の語は、畳み込んだ欄の名前（と区切りを除いた形）に部分一致で当てる（`電話番号` は `電話` に当たる）。
// - 通知・配信の欄の「送らない」側の選択肢の値（`NOTIFICATION_OPT_OUT_OPTION_WORDS`。T29c）もここに置く。
// - どの一覧も、比べる形（Unicode の正規化 NFKC と大文字小文字の畳み込みの後）で書く（`tests/unit/external-delivery-words.test.ts`）。
// - 語の一覧は照らすためのデータで、利用者に見せる文言ではない（表示の文言は表示のカタログ。GATE-UI06 の除外の理由）。
// - 一覧の語を、このファイルの外に書かない（`tests/architecture/data-rules-boundary.test.ts` の (b)）。
// 純粋な定義と関数だけのファイル。
import { foldNfkcCase } from '../../core/text.js';
import type { CandidateField, CandidateFieldType } from '../../discovery/candidate-contracts.js';
import { fieldNameHasListedWord, isAsciiWord } from '../../discovery/classify.js';

/**
 * 外部到達の種類（閉じた一覧。判定の結果は、この順に並ぶ）。
 * - `EMAIL`: メールアドレスの欄。`PHONE`: 電話・FAX の欄。`NOTIFICATION`: 通知・SMS・配信・購読を求める欄。`ADDRESS`: 住所の欄。
 * 1 つの欄が 2 つ以上に当たることがある（`email_address` はメールと住所、`mail_notify` はメールと通知）。どれを優先するかは判定（T29c）が決める。
 */
export const EXTERNAL_DELIVERY_KINDS = Object.freeze(['EMAIL', 'PHONE', 'NOTIFICATION', 'ADDRESS'] as const);
export type ExternalDeliveryKind = (typeof EXTERNAL_DELIVERY_KINDS)[number];

/** 欄の名前の語（種類ごと。比べる形で書く。どの語も 1 つの種類だけに載る）。 */
export const EXTERNAL_DELIVERY_NAME_WORDS = Object.freeze({
  EMAIL: Object.freeze([
    'mail',
    'mails',
    'email',
    'emails',
    'mailaddress',
    'emailaddress',
    // T29R-fix-1（M-7）: 区切りなしでつないだ名前（語の単位の比べでは、つないだ形のままでないと当たらない）。
    'mailaddr',
    'emailaddr',
    'contactemail',
    'contactmail',
    'usermail',
    'useremail',
    'メール',
    'メアド',
  ] as const),
  PHONE: Object.freeze([
    'tel',
    'phone',
    'phones',
    'telephone',
    'phonenumber',
    'telno',
    'cellphone',
    'mobile',
    'fax',
    // T29R-fix-1（M-7）: 区切りなしでつないだ名前。
    'telnumber',
    'phoneno',
    'mobilephone',
    'mobileno',
    'homephone',
    'faxno',
    'faxnumber',
    'keitai',
    'denwa',
    '電話',
    '携帯',
    'ファクス',
    'ファックス',
  ] as const),
  NOTIFICATION: Object.freeze([
    'notify',
    'notification',
    'notifications',
    'sms',
    'newsletter',
    'newsletters',
    'subscribe',
    'dm',
    // T29R-fix-1（I-2）: 販促・案内・同意の語（閉じた一覧）。
    'magazine',
    'magazines',
    'mailmagazine',
    'optin',
    'opt_in',
    'consent',
    'promotion',
    'promotions',
    'promo',
    'marketing',
    'campaign',
    'campaigns',
    'ads',
    '通知',
    '配信',
    'メルマガ',
    'お知らせ',
    '購読',
    '案内',
    'キャンペーン',
    '広告',
    '連絡を希望',
    '受け取る',
  ] as const),
  ADDRESS: Object.freeze([
    'address',
    'addresses',
    'addr',
    'zip',
    'zipcode',
    'postal',
    'postcode',
    'prefecture',
    'city',
    'street',
    '住所',
    '郵便',
    '都道府県',
    '市区町村',
    '番地',
  ] as const),
} as const satisfies Readonly<Record<ExternalDeliveryKind, readonly string[]>>);

/** 欄の型（種類ごと）。 */
export const EXTERNAL_DELIVERY_FIELD_TYPES = Object.freeze({
  EMAIL: Object.freeze(['email'] as const),
  PHONE: Object.freeze(['tel'] as const),
  NOTIFICATION: Object.freeze([] as const),
  ADDRESS: Object.freeze([] as const),
} as const satisfies Readonly<Record<ExternalDeliveryKind, readonly CandidateFieldType[]>>);

/**
 * autocomplete の値（HTML の autofill の欄の名前。種類ごと）。電話は `tel` で始まる値のすべて、住所は住所の値のすべて（国を含む）。
 * `home`・`work`・`mobile`・`fax` などの連絡先の種類、`shipping`・`billing`、`section-*` は、欄の名前の前に付く語なので一覧に入れない。
 */
export const EXTERNAL_DELIVERY_AUTOCOMPLETE_TOKENS = Object.freeze({
  EMAIL: Object.freeze(['email'] as const),
  PHONE: Object.freeze([
    'tel',
    'tel-country-code',
    'tel-national',
    'tel-area-code',
    'tel-local',
    'tel-local-prefix',
    'tel-local-suffix',
    'tel-extension',
  ] as const),
  NOTIFICATION: Object.freeze([] as const),
  ADDRESS: Object.freeze([
    'street-address',
    'address-line1',
    'address-line2',
    'address-line3',
    'address-level1',
    'address-level2',
    'address-level3',
    'address-level4',
    'country',
    'country-name',
    'postal-code',
  ] as const),
} as const satisfies Readonly<Record<ExternalDeliveryKind, readonly string[]>>);

/** 欄の名前の語に当たる外部到達の種類（一覧の順。凍結）。比べ方は発見の分類の `fieldNameHasListedWord`（書き写さない。CC-082）。 */
export const externalDeliveryKindsOfName = (name: string): readonly ExternalDeliveryKind[] =>
  Object.freeze(EXTERNAL_DELIVERY_KINDS.filter((kind) => fieldNameHasListedWord(name, EXTERNAL_DELIVERY_NAME_WORDS[kind])));

/**
 * 通知・配信を求める欄の「送らない」側の選択肢の値（比べる形。T29c）。select・radio の選択肢の値を畳み込み、前後の空白を除いた値が、英語の語は
 * 一覧の語と完全に一致するとき、日本語の語は一覧の語を含むときに「送らない」側とみなす。
 */
export const NOTIFICATION_OPT_OUT_OPTION_WORDS = Object.freeze([
  '0',
  'no',
  'n',
  'false',
  'off',
  'none',
  'never',
  'optout',
  'opt-out',
  'opt_out',
  '不要',
  'いいえ',
  'しない',
  'なし',
  '受け取らない',
  '希望しない',
  '受信しない',
  '配信しない',
  '送らない',
] as const);

/**
 * 通知・配信を求める欄の名前の、否定の語（比べる形。T29c fix round 1）。名前に否定の語がある欄（`no_newsletter`・`メール配信不要` など）は、
 * チェックしない側・「いいえ」の側が「送らない」とは限らないので、人の固定の値がない限り止める（`NOTIFICATION_OPT_OUT_UNAVAILABLE`）。比べ方は
 * 欄の名前の語と同じ（`fieldNameHasListedWord`。英語は語の単位、日本語は部分一致）。
 */
export const NOTIFICATION_NEGATION_WORDS = Object.freeze([
  'no',
  'not',
  'non',
  'never',
  'opt_out',
  'optout',
  'unsubscribe',
  'stop',
  'refuse',
  'reject',
  'deny',
  'disable',
  '不要',
  'しない',
  '受け取らない',
  '停止',
  '拒否',
  '不可',
  '希望しない',
  'いらない',
] as const);

/** 通知・配信を求める欄の名前に、否定の語があるか（`NOTIFICATION_NEGATION_WORDS`）。 */
export const notificationFieldNameIsNegated = (name: string): boolean => fieldNameHasListedWord(name, NOTIFICATION_NEGATION_WORDS);

/** 選択肢の値が、通知・配信の「送らない」側の値か（`NOTIFICATION_OPT_OUT_OPTION_WORDS`）。 */
export const isNotificationOptOutValue = (value: string): boolean => {
  const folded = foldNfkcCase(value).trim();
  return (NOTIFICATION_OPT_OUT_OPTION_WORDS as readonly string[]).some((word) =>
    (isAsciiWord(word) ? folded === word : folded.includes(word)));
};

/** autocomplete の値を、空白で分けて畳み込んだ語の一覧（値がなければ空）。 */
const autocompleteTokensOf = (autocomplete: string | null): readonly string[] =>
  autocomplete === null ? [] : foldNfkcCase(autocomplete).split(/\s+/u).filter((token) => token.length > 0);

/** 欄（名前・型・autocomplete）が当たる外部到達の種類（一覧の順。凍結）。型、autocomplete、名前の語のどれかで当たれば、その種類。 */
export const externalDeliveryKindsOf = (
  field: Pick<CandidateField, 'name' | 'type'> & { readonly constraints: Pick<CandidateField['constraints'], 'autocomplete'> },
): readonly ExternalDeliveryKind[] => {
  const byName = new Set(externalDeliveryKindsOfName(field.name));
  const tokens = autocompleteTokensOf(field.constraints.autocomplete);
  return Object.freeze(EXTERNAL_DELIVERY_KINDS.filter((kind) => byName.has(kind)
    || (EXTERNAL_DELIVERY_FIELD_TYPES[kind] as readonly CandidateFieldType[]).includes(field.type)
    || (EXTERNAL_DELIVERY_AUTOCOMPLETE_TOKENS[kind] as readonly string[]).some((token) => tokens.includes(token))));
};
