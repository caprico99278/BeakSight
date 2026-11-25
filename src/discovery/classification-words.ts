// 発見の候補の分類のための語の閉じた一覧（Task 27 の設計書 4.3、10 章の 3。T27a）。比べ方は `classify.ts`。
// - どの一覧も、比べる形（Unicode の正規化 NFKC と大文字小文字の畳み込みの後）で書く（`tests/unit/discovery-classify.test.ts` で確かめる）。
// - 危険な語は、Task 25 の既定の危険な語（`src/core/default-excluded-url-words.ts` の `DEFAULT_EXCLUDED_URL_WORDS`。変えない。認証つきの
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
  // DEF-210（通知の枠の設計書 3.2.1 の 5。SREV-1106 の I-2）: ログオフ・サインアウト・sign off（区切りを除いた形でも比べる）。
  'signoff',
  'sign-off',
  'ログオフ',
  'サインアウト',
] as const);

/**
 * SD-1（設計書 `2026-11-16-beaksight-action-based-delete-guard-design.md` 2.2。設計者の判断 2026-11-16）: 巡回の移る先の URL の path と query に、既定の除外の語
 * （`DEFAULT_EXCLUDED_URL_WORDS`）に足して当てる語（区切りが `_` のログアウトの語。URL は区切りを除かずにも比べるので書く）。操作の前の判定の足す語
 * （`DESTRUCTIVE_ACTION_EXTRA_WORDS`）の一部。
 */
export const DESTRUCTIVE_ACTION_URL_EXTRA_WORDS = Object.freeze(['sign_out', 'log_out'] as const);

/**
 * REV-SD2 の I-2・M-5（設計者の判断 2026-11-16）: ログオフ・サインオフの英語の形（語の境界で比べる）。巡回の移る先の URL・リンクの文字・ボタンの操作の前の判定に
 * 当てる。監査の段の送信の扱いの危険な語（`DESTRUCTIVE_ACTION_URL_EXTRA_WORDS` を使う `src/orchestration/audit-send-options.ts`）には入れない（通信の層の一覧を
 * 変えない）。
 */
export const DESTRUCTIVE_ACTION_LOGOFF_WORDS = Object.freeze([
  'logoff',
  'log-off',
  'log_off',
  'log off',
  'signoff',
  'sign-off',
  'sign_off',
  'sign off',
] as const);

/**
 * REV-SD2 の M-7: 巡回の移る先の URL の path と query にだけ足す、削除・取り消しの名詞（語の境界で比べると `cancel`・`delete`・`remove` に当たらない形）。
 * ボタンとリンクの文字には当てない（「Cancellation policy」などを止めない）。
 */
export const CRAWL_URL_EXTRA_NOUN_WORDS = Object.freeze(['cancellation', 'deletion', 'removal'] as const);

/**
 * REV-EV12 の M-3（設計者の判断 2026-11-16）: 巡回の URL の名詞（`CRAWL_URL_EXTRA_NOUN_WORDS`）の直後の語（同じ区切りの中か、次の区切り）がこの案内の語なら当てない
 * （`/help/cancellation-policy`・`/deletion/faq` の案内の画面へは移る）。リンクの文字の名詞の続く語（`DESTRUCTIVE_WORD_NOUN_SUFFIXES`）と同じ考え方。
 */
export const CRAWL_URL_NOUN_GUIDE_WORDS = Object.freeze([
  'policy', 'policies', 'guide', 'guides', 'faq', 'faqs', 'help', 'about', 'terms', 'info', 'information', 'howto',
] as const);

/**
 * SD-1（設計書 2.2。設計者の判断 2026-11-16）: 操作の前の判定（`src/discovery/destructive-action.ts`）だけが、危険な語（`DISCOVERY_DESTRUCTIVE_WORDS`）に足して
 * 当てる語（ゴミ箱・空にする・クリア・リセット・初期化・取り下げと、`DESTRUCTIVE_ACTION_URL_EXTRA_WORDS`）。危険な語の一覧は変えない（READ の送る値の確かめ・
 * 欄の名前の判定・候補の `submitterWords` と識別の digest は、今までどおり危険な語の一覧だけを使う）。比べ方は危険な語と同じ。
 */
export const DESTRUCTIVE_ACTION_EXTRA_WORDS = Object.freeze([
  'clear',
  'trash',
  ...DESTRUCTIVE_ACTION_URL_EXTRA_WORDS,
  ...DESTRUCTIVE_ACTION_LOGOFF_WORDS,
  'ゴミ箱',
  '空にする',
  'クリア',
  'リセット',
  '初期化',
  '取り下げ',
  '取下',
  // REV-SD の I-3（設計者の判断 2026-11-16）: 非表示・撤回・解除・退出と、英語の unfollow・unlink・disconnect・close account（deactivate・unsubscribe は
  // 危険な語にある）。英語の hide と日本語の「止め」は、止めすぎになるので入れない。
  '非表示',
  '撤回',
  '解除',
  '退出',
  'unfollow',
  'unlink',
  'disconnect',
  'close account',
  // REV-SD2 の M-5（設計者の判断 2026-11-16）: 消す・脱退・unregister・uninstall・opt out・サインオフ（ログオフ・log off・logoff・sign off は上の URL の語と
  // 危険な語にある）。「外す」「Leave」「抜ける」「さくじょ」は入れない（止めすぎ・まれ）。
  '消す',
  '脱退',
  'unregister',
  'uninstall',
  'opt out',
  'サインオフ',
] as const);

/**
 * AIW（ユーザーの判断 2026-11-20）: 操作の前の判定（`src/discovery/destructive-action.ts` の `isAiAction`）が、押す要素の名前に当てる AI の語。押すとサイトの
 * AI の生成を起こしうるので押さない。英語の語は語の境界つき（MAIL・DETAIL の中の ai には当てない）。全角の ＡＩ は比べる前の畳み込み（NFKC）で ai になる。
 * 「生成」などの広い語は入れない（QR コードの生成・報告の生成を押せなくなる）。キラキラの絵文字（✨）も名前の印にする。
 */
export const AI_ACTION_WORDS = Object.freeze(['ai', '人工知能', '✨'] as const);

/** AIW の 2: ボタンの中のアイコン（svg などの class・data 属性・aria-label）のキラキラの印の語（よくある部品の名前）。 */
export const AI_ICON_WORDS = Object.freeze(['sparkle', 'sparkles', 'magic', 'wand'] as const);

/** AIW の 3: AI の枠（ボタンの入った枠の見出しかラベル）の語（AI の語と、自動で作る語）。 */
export const AI_REGION_WORDS = Object.freeze([...AI_ACTION_WORDS, '自動作成', '自動生成'] as const);

/** AIW の 3: AI の枠の中で押さないボタンの語（枠の中でも、保存・閉じる・キャンセル・タブの切り替えなどは押す）。 */
export const AI_REGION_RUN_WORDS = Object.freeze(['生成', '作成', '実行'] as const);

/** AIW の 4: 押下で出た送信の行き先の path の区切りの AI の語（語の境界つき）。 */
export const AI_REQUEST_PATH_WORDS = Object.freeze(['ai', 'generate', 'generation', 'assist', 'completion', 'completions', 'llm', 'coach'] as const);

/**
 * REV-SD の M-2（設計者の判断 2026-11-16）: リンクの文字に当てる日本語の動きの語（英語は、巡回の URL と同じ狭い一覧）。アーカイブ・ゴミ箱・キャンセルのような
 * 名詞は入れない（読むだけの一覧の画面へのリンクが多いため）。
 */
export const DESTRUCTIVE_LINK_TEXT_JA_WORDS = Object.freeze([
  '削除', '消去', '退会', '解約', 'ログアウト', 'サインアウト', '取り消', '取消',
  // REV-SD2 の I-2。
  'ログオフ', 'サインオフ',
] as const);

/**
 * REV-SD の M-2: リンクの文字で、日本語の語の直後がこの語なら当てない（「削除済みの項目」「キャンセル一覧」「取り消し履歴」「停止中のユーザー」「キャンセルポリシー」。
 * 語の直後の送り仮名「し」は飛ばして見る）。
 */
export const DESTRUCTIVE_WORD_NOUN_SUFFIXES = Object.freeze([
  '済', '一覧', '履歴', '中', 'ポリシー',
  // REV-SD2 の M-6: 「削除の手順の説明」「退会について」「解約の方法」「ログアウトできない場合」「削除依頼について」。
  'の', 'について', '方法', 'できない', '依頼',
] as const);

/** REV-SD の M-2: 日本語の語の直後で、名詞の続く語を見る前に飛ばす送り仮名（「取り消し履歴」の「し」）。 */
export const DESTRUCTIVE_WORD_SKIPPED_OKURIGANA = 'し';

/**
 * SD-1（設計書 2.2 の「キャンセル」）: 名前がこの語だけのボタンは、枠（dialog・region）の閉じる場所にあり、枠の名前が壊す操作の目的語（予約・注文など。
 * `NOTIFICATION_CLOSE_DESTRUCTIVE_OBJECT_WORDS`）でも削除の語でもないときだけ、枠を閉じる操作とみなす（判定は `src/discovery/destructive-action.ts`）。
 * どの語も危険な語（`DISCOVERY_DESTRUCTIVE_WORDS`）に含まれる。
 */
export const DESTRUCTIVE_CLOSE_CANCEL_WORDS = Object.freeze(['cancel', 'キャンセル'] as const);

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

/**
 * DEF-186（設計書 `2026-11-02-beaksight-list-row-update-design.md` 4.0.1 の K2、5.1 の 4）: 開き手の語（一覧の行の「編集」など、押すと入力の窓を開くボタンの語）。
 * どれも更新の語（`DISCOVERY_UPDATE_WORDS`）でもあり、候補の `submitterWords` に載る（送信ボタンの語の閉じた一覧には重ねて足さない）。登録の語がなく
 * この語だけを持つ候補の押下が登録の形（`API_CREATE`）を出したら、開くとサイトが自動で送る要求として登録にしない（`submission-probe-contracts.ts` の
 * `isOpenerOnlySubmitter`）。削除の語のある候補は開き手にしない。語を足すときは、この 1 か所に足す。
 */
export const DISCOVERY_OPENER_WORDS = Object.freeze(['編集', '修正', 'edit'] as const);

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
 * OP-I（I2。設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1.5）: 操作さがしの段で、先に読む登録の画面らしいリンクの語（登録の語と、
 * 「新しく」）。リンクの文字・`aria-label`・`title`・アドレスの path の語に当てる（比べ方は登録の語と同じ。`classify.ts` の `isCreatePageLink`）。読む順だけに
 * 使う（候補の分類・`submitterWords`・識別の digest・成果物のスキーマには入れない。読むかどうかの判定は今の除外の判定のまま）。
 */
export const DISCOVERY_CREATE_PAGE_LINK_WORDS = Object.freeze([
  ...DISCOVERY_CREATE_WORDS,
  '新しく',
] as const);

/**
 * DEF-208-2（設計書 `2026-11-05-beaksight-discovery-coverage-design.md` 3.2）: 行を足す語（「追加」「新規」など、押すと行や入力の窓を足すだけのことが多いボタンの
 * 語）。どれも登録の語（`DISCOVERY_CREATE_WORDS`）でもある部分集合で、候補の `submitterWords` に載る（送信ボタンの語の閉じた一覧には重ねて足さない。開き手の語
 * `DISCOVERY_OPENER_WORDS` が更新の語の部分集合であるのと同じ作り）。使うのは、送らずに観察する probe の押す順（`submission-probe-contracts.ts` の
 * `pressRankOf`。確定の語を先に押す）だけ。語を足すときは、この 1 か所に足す。
 */
export const DISCOVERY_ROW_ADD_WORDS = Object.freeze(['add', 'new', 'create', '追加', '新規', '作成'] as const satisfies readonly (typeof DISCOVERY_CREATE_WORDS)[number][]);

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
 * T44c（Task 44 の設計書 P1-3。設計者の判断）: 送らずに観察する probe の押す順だけに使う、送信の語（登録・更新の語の次の段）。送信ボタンの語の閉じた一覧
 * （`DISCOVERY_SUBMITTER_WORDS`）には入れない（候補の `submitterWords`・識別の digest・規則・成果物のスキーマに響かない）。比べ方は更新・登録の語と同じ
 * （`classify.ts` の `submitterTextHasSubmitWord`）。
 */
export const DISCOVERY_SUBMIT_PRESS_WORDS = Object.freeze([
  'submit',
  '送信',
  '確定',
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
 * DEF-147（設計書 `2026-10-21-beaksight-api-state-keys-design.md` 2 章）: 論理削除の語（API の要求の本文の鍵の名前に当たれば、その型は論理削除にあたる鍵を
 * 持つとして実行しない。`api-shape-classification.ts` の `isApiSoftDeleteKeyName`）。状態の欄の語（`DISCOVERY_STATE_FIELD_WORDS`）のうち「消す・捨てる」の
 * 意味の語と、欄の名前のための削除の語（`DISCOVERY_REMOVAL_FIELD_WORDS`）のうち同じ意味の語。比べ方は `classify.ts` の `fieldNameHasListedWord`（英語の語は
 * 語の単位、日本語の語は部分一致）。フォームの送信の分類（状態の欄の印）には使わない。
 */
export const DISCOVERY_SOFT_DELETE_FIELD_WORDS = Object.freeze([
  'deleted',
  'delete',
  'del',
  'delflg',
  'delflag',
  'deleteflg',
  'deleteflag',
  'archived',
  'archive',
  'removed',
  'trash',
  'trashed',
  'purged',
  'discarded',
  'destroyed',
  'erased',
  '削除',
  '退会',
] as const);

/**
 * DEF-147: 公開の状態の語（API の要求の本文の鍵の名前が、状態の欄の語にはこの語でだけ当たるなら、公開の状態の鍵として論理削除にしない。値は入力の規則で
 * 利用者が決める）。比べ方は `fieldNameHasListedWord`。承認の画面の注意の印と、API の更新の保つ欄の既定の知らせにも使う（`isPublicationStateKeyName`）。
 */
export const DISCOVERY_PUBLICATION_STATE_FIELD_WORDS = Object.freeze([
  'status',
  'state',
  'published',
  'unpublished',
  'publish',
  'visible',
  'visibility',
  '公開',
  '非公開',
  '状態',
  'ステータス',
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

/**
 * T43d（Task 43 の設計書 4.4）: ログアウトの語（閉じた一覧）。成功の画面のセレクタの案で、ログインの後の画面の見えるリンクやボタンの文字・`aria-label`・
 * `title`・`href` に含まれていれば、ログアウトの要素の候補にする（押さない。要素の文字は記録せず、当たった語だけを記録する）。英語の語は、既定で読まない
 * 危険な語（`DEFAULT_EXCLUDED_URL_WORDS`）のログアウトの語と同じで、どの語も危険な語（`DISCOVERY_DESTRUCTIVE_WORDS`）に含まれる（テストで固定する）。
 * 日本語の語を照らすデータなので、日本語の語の一覧を持てるこのファイルに置く（GATE-UI06 の除外の理由と同じ）。
 */
export const DISCOVERY_LOGOUT_WORDS = Object.freeze(['logout', 'signout', 'sign-out', 'log-out', 'ログアウト'] as const);

/**
 * ML-a-fix-3（設計書 `2026-10-19-beaksight-manual-login-pass-through-design.md` 6 章の ML-R2 の行の M-2）: 手続きの呼び出しの名前の、書き込みの語のうち、
 * 危険な語・更新の語・登録の語（`DISCOVERY_DESTRUCTIVE_WORDS`・`DISCOVERY_UPDATE_WORDS`・`DISCOVERY_CREATE_WORDS`）にない語（閉じた一覧。重ねない）。
 * 判定は `classify.ts` の `procedureNameHasWriteWord`（4 つの一覧を、語の単位で比べる）。
 */
export const DISCOVERY_PROCEDURE_WRITE_WORDS = Object.freeze(['upsert', 'set', 'write', 'put', 'patch'] as const);

/**
 * T43R-fix の C-1 (b)（Task 43 の設計書 7 章の T43R の行）: 成功の画面のセレクタの案に使う属性の値（id・name・href）で、ログアウトの語のほかに含んでよい
 * 一般の語（閉じた一覧。小文字）。属性の値からログアウトの語を除いた残りが、この語と区切り（`.`・`:`・`_`・`/`・`-`・空白）だけのときだけ案にする（利用者の
 * 名前や ID が入りうる値を案にしない）。
 */
export const DISCOVERY_LOGOUT_GENERAL_WORDS = Object.freeze([
  'button',
  'btn',
  'link',
  'menu',
  'nav',
  'navbar',
  'header',
  'action',
  'icon',
  'item',
  'global',
  'main',
  'top',
  'side',
  'dropdown',
  'admin',
  'app',
] as const);

/**
 * 通知の枠の閉じる語（設計書 `2026-11-06-beaksight-notification-overlay-design.md` 3.1 の 3）。押せる要素の名前（見える文字・`aria-label`・`title`）が
 * この語に当たれば、閉じるボタンとみなす（比べ方は `src/interaction/notification-overlay.ts` の `isNotificationCloseName`。英語の語は語の境界、
 * 日本語の語は部分一致）。どのサイトにも当てはまる一般の語だけを置き、サイトの文言は入れない。語を足すときは、この 1 か所に足す。
 */
export const NOTIFICATION_CLOSE_WORDS = Object.freeze(['閉じる', 'とじる', 'close', 'dismiss'] as const);

/** 通知の枠の閉じる記号（設計書 3.1 の 3）。名前が、空白を除いてこの記号だけのとき、閉じるボタンとみなす。 */
export const NOTIFICATION_CLOSE_SYMBOLS = Object.freeze(['×', '✕', '✖'] as const);

/**
 * 通知の枠の閉じる語の、汎用の目的語の閉じた一覧（設計書 3.2.1 の 5。「〈目的語〉を閉じる」「Close 〈目的語〉」の目的語）。どのサイトにも当てはまる一般の語だけを
 * 置き、サイトの文言は入れない。比べ方は `src/interaction/notification-overlay.ts` の `isNotificationCloseName`（日本語は語そのもの、英語は語か複数形）。
 */
/**
 * fix round 3（通知の枠の設計書 3.2.2 の 3）: 壊す操作の目的語の閉じた一覧（「アカウントを閉じる」「Close account」の目的語）。枠の名前と同じ目的語でも、この一覧に当たれば
 * 閉じる語として当てない。英語は語か複数形、日本語は部分一致で比べる。サイトの文言は入れない。
 */
export const NOTIFICATION_CLOSE_DESTRUCTIVE_OBJECT_PAIRS = Object.freeze([
  // fix round 4（通知の枠の設計書 3.2.3 の 2）: 日本語と英語の対で持つ（対が揃うことは、単体のテストで確かめる）。
  Object.freeze(['アカウント', 'account'] as const),
  Object.freeze(['口座', 'account'] as const),
  Object.freeze(['契約', 'contract'] as const),
  Object.freeze(['会員', 'membership'] as const),
  Object.freeze(['サブスクリプション', 'subscription'] as const),
  Object.freeze(['チケット', 'ticket'] as const),
  Object.freeze(['注文', 'order'] as const),
  Object.freeze(['申込', 'application'] as const),
  Object.freeze(['申し込み', 'application'] as const),
  Object.freeze(['予約', 'booking'] as const),
  Object.freeze(['プラン', 'plan'] as const),
  Object.freeze(['ワークスペース', 'workspace'] as const),
  Object.freeze(['プロジェクト', 'project'] as const),
  Object.freeze(['案件', 'case'] as const),
  Object.freeze(['ルーム', 'room'] as const),
  Object.freeze(['チャンネル', 'channel'] as const),
] as const);

/** 壊す操作の目的語の平らな一覧（対の語を、重ねずに並べたもの）。 */
export const NOTIFICATION_CLOSE_DESTRUCTIVE_OBJECT_WORDS: readonly string[] = Object.freeze([...new Set(NOTIFICATION_CLOSE_DESTRUCTIVE_OBJECT_PAIRS.flat())]);

/** 通知の枠の閉じる語の、目的語の後の助詞（「〈目的語〉を閉じる」の「を」。除いて比べる）。 */
export const NOTIFICATION_CLOSE_OBJECT_PARTICLES = Object.freeze(['を'] as const);

/** 通知の枠の閉じる語の、目的語の前の丁寧の接頭語（「ご案内」の「ご」。除いた形でも比べる）。 */
export const NOTIFICATION_CLOSE_HONORIFIC_PREFIXES = Object.freeze(['ご', 'お'] as const);

export const NOTIFICATION_CLOSE_OBJECT_WORDS = Object.freeze([
  '通知',
  'お知らせ',
  '案内',
  'ダイアログ',
  'メニュー',
  'パネル',
  'ウィンドウ',
  'バナー',
  'メッセージ',
  'notification',
  'notice',
  'dialog',
  'modal',
  'popup',
  'banner',
  'panel',
  'message',
  'menu',
  'window',
] as const);

/**
 * COV-2（網羅の設計書 `2026-11-09-beaksight-coverage-by-state-design.md` 3.1 の 2）: 状態の語の閉じた一覧。画面の見える文字（小文字にした形）に
 * この語があるかだけを、状態の構造の鍵に入れる（`src/discovery/state-keys.ts` の `STATE_WORDS`。文字の値そのものは入れない）。同じ作りの画面でも、状態
 * （取り消し済み・確定など）でボタンが変わる画面を、別の状態として見分けるための語。
 */
export const DISCOVERY_STATE_WORDS = Object.freeze([
  '取り消し済み',
  'キャンセル済み',
  '取消済',
  '確定',
  '確定済み',
  '未確定',
  '完了',
  '未完了',
  '承認済み',
  '承認待ち',
  '却下',
  '保留',
  '下書き',
  '公開中',
  '非公開',
  '受付中',
  '受付終了',
  '満席',
  '空きあり',
  '期限切れ',
  '支払い済み',
  '未払い',
  '処理中',
  '停止中',
  '無効',
  '有効',
  'エラー',
  '該当なし',
  'データがありません',
  'canceled',
  'cancelled',
  'confirmed',
  'completed',
  'pending',
  'approved',
  'rejected',
  'draft',
  'published',
  'expired',
  'paid',
  'unpaid',
  'error',
  'no results',
] as const);
