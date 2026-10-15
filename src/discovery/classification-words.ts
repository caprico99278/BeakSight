// 発見の候補の分類のための語の閉じた一覧（Task 27 の設計書 4.3、10 章の 3。T27a）。比べ方は `classify.ts`。
// - どの一覧も、比べる形（Unicode の正規化 NFKC と大文字小文字の畳み込みの後）で書く（`tests/unit/discovery-classify.test.ts` で確かめる）。
// - 危険な語は、Task 25 の既定の危険な語（`src/control/auth/auth-setup-contracts.ts` の `DEFAULT_EXCLUDED_URL_WORDS`。変えない。認証つきの
//   Run の設定の digest を変えないため）の英語をすべて含み、日本語と英語の語を足した、発見の分類のための別の一覧。含むことはテストで
//   固定する（発見の部品は `src/control/` を import しない。`tests/architecture/discovery-boundary.test.ts`）。
// - 語の一覧は照らすためのデータで、利用者に見せる文言ではない（表示の文言は表示のカタログ。GATE-UI06 の除外の理由）。
// 純粋な定義だけのファイル（import なし）。

/**
 * 危険な語（削除・取り消し・無効化・一括・アーカイブ・ログアウトなど）。ボタンの文言、送信先の path、query の名前、GET の form の欄の名前
 * （T27R-fix-1。DEF-088）に、部分一致で当たれば実行できないもの（`NOT_EXECUTABLE`）にする（fail-closed）。READ の確かめで送る値の名前と値
 * にも、同じ比べ方で当てる（DEF-088）。
 */
export const DISCOVERY_DESTRUCTIVE_WORDS = Object.freeze([
  // Task 25 の既定の危険な語（`DEFAULT_EXCLUDED_URL_WORDS`）と同じ語。
  'logout',
  'signout',
  'sign-out',
  'log-out',
  'delete',
  'remove',
  'destroy',
  'cancel',
  // 発見の分類のために足した英語。
  'archive',
  'deactivate',
  'disable',
  'revoke',
  'purge',
  'withdraw',
  'unsubscribe',
  'terminate',
  'suspend',
  'discard',
  'erase',
  'wipe',
  'truncate',
  'bulk',
  'batch',
  'reset',
  // 日本語（設計書 4.3 の一覧と、同じ意味の語）。
  '削除',
  '取り消',
  '取消',
  '一括',
  '無効',
  '解約',
  '退会',
  'アーカイブ',
  '廃止',
  '停止',
  'キャンセル',
  '破棄',
  '消去',
  '抹消',
  '中止',
  'ログアウト',
] as const);

/** 検索の語。POST の候補の、ボタンの文言か送信先の path に当たれば、扱えない読み取り（`UNSUPPORTED_READ_TRANSPORT`）にする。 */
export const DISCOVERY_SEARCH_WORDS = Object.freeze([
  'search',
  'filter',
  'find',
  'query',
  'lookup',
  '検索',
  '絞り込',
  '絞込',
  '探す',
] as const);

/** GraphQL の送信先の path の語（path の語の 1 つと一致すれば、扱えない読み取り）。 */
export const DISCOVERY_GRAPHQL_PATH_WORDS = Object.freeze(['graphql'] as const);

/** 更新の語（表示だけの `UPDATE`）。 */
export const DISCOVERY_UPDATE_WORDS = Object.freeze([
  'update',
  'save',
  'edit',
  'change',
  'modify',
  '更新',
  '保存',
  '編集',
  '変更',
  '修正',
] as const);

/** 登録の語（表示だけの `CREATE`）。 */
export const DISCOVERY_CREATE_WORDS = Object.freeze([
  'create',
  'add',
  'new',
  'register',
  'insert',
  '登録',
  '追加',
  '作成',
  '新規',
] as const);

/**
 * 送信ボタンの語の閉じた一覧（T27R-fix-1。DEF-086）: 危険な語、検索の語、更新の語、登録の語を、この順に並べたもの。候補は送信ボタンの文言を持たず、
 * 文言が当たったこの一覧の語だけを持つ（`classify.ts` の `submitterWordsOf`）。4 つの一覧は重ならない（語ごとに、どの一覧の語かが決まる。
 * `tests/unit/discovery-classify.test.ts` で確かめる）。成果物の候補のスキーマ（`schemas/control/candidate.schema.json` の `submitterWords`）の
 * enum は、この配列と一致する（`tests/unit/schema-enum-consistency.test.ts`）。
 */
export const DISCOVERY_SUBMITTER_WORDS = Object.freeze([
  ...DISCOVERY_DESTRUCTIVE_WORDS,
  ...DISCOVERY_SEARCH_WORDS,
  ...DISCOVERY_UPDATE_WORDS,
  ...DISCOVERY_CREATE_WORDS,
] as const);

/**
 * 削除の語（欄の名前のためだけの閉じた一覧。T31R-fix-1 の I-1。Task 31 の設計書 3 章の「削除にあたる変更の遮断」、11 章の T31R の行）。危険な語
 * （`DISCOVERY_DESTRUCTIVE_WORDS`）とあわせて、欄の名前の比べ（`classify.ts` の `fieldNameHasRemovalWord`。英語の語は語の単位の並び）に使い、
 * 当たる欄は UPDATE で保つだけにする。危険な語の一覧には足さない（危険な語は、ボタンの文言・送信先の path に部分一致で当てる分類の一覧で、候補の
 * スキーマの `submitterWords` の enum でもある。`locked` のような語を部分一致で当てると `blocked` にも当たる）。状態の欄の語（`deleted`・
 * `archived`・`suspended` など）は、状態の欄の判定が保つだけにするので、ここには重ねない。どれも、削除・取り消し・無効化・停止・締め出しの済んだ
 * 形（過去分詞・形容詞）と名詞。T31R2-fix-1 の M-1 で、掲載の取り下げ・期限切れ・凍結・ミュート・締め出しの語と、基の形（`lock`・`block`・`ban`・
 * `drop`・`kill`）、日本語を足した。基の形で `lock_version`・`block_size` も保つだけになるのは、止める側として受ける（設計者の判断）。
 */
export const DISCOVERY_REMOVAL_FIELD_WORDS = Object.freeze([
  'removed',
  'purged',
  'trash',
  'trashed',
  'withdrawn',
  'void',
  'voided',
  'unsubscribed',
  'locked',
  'banned',
  'blocked',
  'destroyed',
  'erased',
  'discarded',
  'terminated',
  'revoked',
  'deactivated',
  'wiped',
  // T31R2-fix-1 の M-1。
  'unpublished',
  'unpublish',
  'unlisted',
  'delisted',
  'expired',
  'retired',
  'obsolete',
  'frozen',
  'freeze',
  'muted',
  'drop',
  'dropped',
  'kill',
  'ban',
  'lock',
  'block',
  'unregistered',
  'deregistered',
  'opt_out',
  '凍結',
  'ロック',
  '廃棄',
  '非掲載',
  '掲載終了',
  'ブロック',
] as const);

/**
 * 状態の欄の名前の語（欄の名前に当たれば、候補に状態の欄の印を付ける。Task 31 の削除相当の判断に使う）。比べ方は `classify.ts` の
 * `fieldNameHasStateWord`（英語の語は語の単位、日本語の語は部分一致）。T31a（Task 31 の設計書 3 章の「削除にあたる変更の遮断」）で、表示・
 * フラグ・閉じ・取り消し・停止の語を足した（短い語 `del`・`show`・`flag`・`stop` などは語の単位で比べるので、`model`・`showroom`・`flagship`・
 * `stopwatch` には当たらない）。区切りなしでつないだ削除のフラグの名前（`delflg` など）は、語の単位の比べではつないだ形のままでないと当たらない
 * ので、その形を書く。
 */
export const DISCOVERY_STATE_FIELD_WORDS = Object.freeze([
  'active',
  'inactive',
  'enabled',
  'disabled',
  'status',
  'state',
  'deleted',
  'archived',
  'visible',
  'visibility',
  'published',
  '有効',
  '無効',
  '状態',
  '公開',
  '削除',
  // T31a: 表示・非表示の語。
  'hidden',
  'hide',
  'show',
  'shown',
  'display',
  'displayed',
  // T31a: フラグと削除のフラグの語。
  'flag',
  'flg',
  'del',
  'delflg',
  'delflag',
  'deleteflg',
  'deleteflag',
  // T31a: 閉じ・取り消し・停止の語。
  'closed',
  'cancel',
  'cancelled',
  'canceled',
  'suspend',
  'suspended',
  'stop',
  'stopped',
  // T31a: 日本語。
  '表示',
  '非表示',
  'ステータス',
  '停止',
  '取消',
  '取り消',
  'キャンセル',
  '休止',
  '中止',
  '非公開',
  '退会',
] as const);

/**
 * 状態の欄の語のうち、名前・順・ラベルの語（`DISCOVERY_STATE_FIELD_LABEL_WORDS`）がすぐ後に続く形では当てない語（T31a。閉じた例外の一覧）。
 * `display_name`・`displayName`・`show_order`・`表示名`・`表示順` は、表示に使う名前や並びの欄で、状態の欄ではない（T31a fix round 1 で `show` を
 * 足した）。
 */
export const DISCOVERY_STATE_FIELD_LABELED_WORDS = Object.freeze(['display', 'show', '表示'] as const);

/** 名前・順・ラベルの語（T31a。`DISCOVERY_STATE_FIELD_LABELED_WORDS` の例外を決める、閉じた一覧）。 */
export const DISCOVERY_STATE_FIELD_LABEL_WORDS = Object.freeze(['name', 'order', 'label', 'title', '名', '順', '名称'] as const);

/**
 * 無効化の語（T31a。Task 31 の設計書 3 章の「削除にあたる変更の遮断」）。入力の規則の生成は、値がこの語に当たる選択肢を選ばない
 * （`src/control/data-rules/generic-values.ts` の `usableOptionValues`。危険な語の選択肢と同じく除く。CREATE の生成にも効く）。人の固定の値も、
 * 危険な語と同じく拒む。比べ方は欄の名前の語の比べ（`classify.ts` の `fieldNameHasListedWord`。英語の語は語の単位で、`stopwatch` は `stop` に
 * 当たらない。日本語の語は部分一致）。`0`・`false`・`off` は入れない（数量などの普通の選択肢を壊すため。状態の欄は Task 31 で保つだけにして守る）。
 */
export const DISCOVERY_DISABLING_WORDS = Object.freeze([
  'inactive',
  'hidden',
  'hide',
  'closed',
  'cancel',
  'cancelled',
  'canceled',
  'suspend',
  'suspended',
  'stop',
  'stopped',
  'unpublished',
  '非表示',
  '無効',
  '停止',
  '取消',
  '取り消',
  'キャンセル',
  '中止',
  '休止',
  '解約',
  '退会',
  '非公開',
] as const);
