# BeakSight Task 27 READ の検証と、副作用のない操作の候補の発見 設計書

作成日: 2026-10-11
状態: ユーザー承認済み（2026-10-11。10 章の 4 点を含む）。G27 承認済み（2026-10-13）
対象範囲: テスト環境（`TEST_AUTH_PASSIVE`）の管理画面で、ログインの後に、(1) 画面を読むだけでフォームと操作の候補を見つけて分類し、(2) 人が決めた READ の確かめ（一覧・詳細・検索の GET）を実行して、期待と照らす。書き込みは一切しない

## 1. 目的

Task 28 以降（シナリオの承認、CREATE・UPDATE の実行）の前に、管理画面に「どんな操作があるか」を副作用なく洗い出し、「読む操作（READ）」だけは実際に行って結果を確かめられるようにする。

- **候補の発見**: 管理画面のフォーム、入力の欄の型と制約、選択肢、送信先、ボタンを、画面を読むだけで集め、READ・CREATE・UPDATE・実行できないもの（削除など）・送信先が決まらないもの（`NEEDS_BINDING`）・扱えない読み取り（`UNSUPPORTED_READ_TRANSPORT`）に分ける。発見の間に、サーバへの書き込みの要求は 0。
- **READ の確かめ**: 人が、READ の候補ごとに「送る値」と「期待」を決めて保存し、BeakSight が GET で読み、結果を構造にして期待と照らす（一致・不一致・判定できない）。

## 2. 根拠となる文書と、ロードマップからの読み替え

- 従う文書: ロードマップ `2026-10-09-beaksight-task-22-32-roadmap.md` の Task 27、3 章（I01〜I16）、5 章、6.3、6.4、6.5、7 章、8 章、11 章、12 章、ADR-005・006・009・011・013。Task 25・26 の設計書（ログインの段、認証つきの監査、自動ログイン）。
- 調査: 作業記録 `progress.md` の「T27 調査」の行。
- 読み替え:
  - ロードマップの `src/control/discovery/*` と `src/control/actions/read-executor.ts` は置き場所の例と読む。ブラウザの中の読み取りは監査の本体の側（`src/discovery/`）、管理データと表示は `src/control/` と画面に置く（4 章）。
  - ロードマップの「GET/HEAD の READ」は、GET だけと読む（HEAD は本文がなく照らせないので使わない）。
  - 「同一画面の同一候補を安定した指紋」は、4.4 の 2 つの digest と読む。path の中の ID の型（`/items/123` を `/items/{id}` にする）は、この Task では行わない（Task 28 で必要なら足す）。
- 引き続き守る不変条件: 公開監査の不変（I02）、Guard の Read-Only（I08、I09）、ログインの段の守り（Task 25・26。送信の窓、許可 Origin の外へ送らない）、秘密を出さない（I11）、サイトへの負荷の決まり（ページの読み込みの間隔と上限は設定のファイルの値）。

## 3. 採用する設計

- **新しいジョブの種類を 2 つ**: `DISCOVERY`（候補の発見）と `READ_CHECK`（READ の確かめ）。どちらも `TEST_AUTH_PASSIVE` のプロファイルで、手動か自動のログインの後に、新しい Guard つきの読み取りだけの Context で行う（Task 25・26 のログインの段と状態の受け渡しをそのまま使う）。今の監査（`AUDIT`）の流れ（`page-auditor.ts`）には手を入れない（公開監査と認証つきの監査の出力を変えないため）。
- **発見は読むだけ**: ページを開いて落ち着くのを待ち、Interaction の凍結（`activateInteractionFreeze`）をかけてから、1 回の `page.evaluate` で DOM を読む（標準の prototype の getter とメソッドで読む。DEF-069〜073 と同じ）。入力の値は読まない（値があるかの真偽だけ）。JS の結び付きは CDP の `DOMDebugger.getEventListeners` で、ページを動かさずに読む。発見のコードは click・fill・press・dispatchEvent・submit を呼ばない（Gate で確かめる）。
- **READ は URL を組み立てて GET で読む**: GET のフォームから、人が決めた値で URL を組み立て、送信せずに、Guard の付いた Context で `goto` する。送る前に、要求の判定の owner（`classifyPassiveRequest`。認証つきの Run の除外を含む）で判定する。フォームの送信は使わない（CSRF のトークンや readonly の値まで送られ、ページの JS も動くため）。
- **結果は Run の成果物と、管理データの索引**: 発見の事実（候補の一覧）と READ の証拠は、Run のディレクトリの成果物（`discovery.json`、`read-evidence.json`）に置く。管理データ（版 5）には、候補の索引（指紋、分類、画面の path、最後に見たジョブと時刻だけ）と、人が決めた READ の確かめの定義を置く。値や label の文言は索引に持たない。

採らなかった案:
- 発見を今の監査の巡回に足す案（読み込みは増えないが、`page-auditor.ts` の流れと公開監査の出力に手が入る）。
- READ をフォームの送信で行う案（上の理由）。
- 候補の分類に LLM や意味の判断を使う案（ロードマップの決まりにより使わない。規則だけ）。

## 4. 詳細設計

### 4.1 候補の契約（`src/discovery/` と `schemas/control/candidate.schema.json`）

- 候補 1 件: 画面（Origin と path）、種類（`FORM`、`BUTTON`）、method（form の実際の method。`formmethod` と `_method` の hidden を含む）、送信先（Origin と path。query は名前だけ）、enctype、target、入力の欄の一覧（name、tag、type、required、readonly、disabled（fieldset を含む）、hidden（`type=hidden` か見えない）、pattern・min・max・step・minlength・maxlength・autocomplete、select の選択肢（値だけ。上限 50 件。label の文言は持たない）、値があるか）、送信ボタンの文言（危険な語の判定に使い、成果物には持つが索引には持たない）、JS の結び付き（form、ボタン、document、window の listener の種類）、分類、分類の理由のコード、2 つの digest（4.4）。
- 値は持たない: 入力の値、CSRF のトークン、hidden の値、選択肢の label。`_method` は閉じた一覧（`PUT`、`PATCH`、`DELETE`）の値だけ。

### 4.2 発見（`src/discovery/probe.ts`、`listeners.ts`、`settle.ts`）

- ページの範囲: 認証の設定の読む範囲（`auditPathPrefixes`）と読まないパス・既定の危険な語（Task 25）を、そのまま使う。巡回の上限（`crawl.maxPages`）と読み込みの間隔は、設定のファイルの値（今の監査と同じ）。
- 落ち着くまでの待ち（SPA）: 「進行中の要求が 0 の状態が 500 ms 続く」かつ「2 回続けて同じ候補の集合」になるまで待つ。上限 5 秒（名前つきの定数）を超えたら、その画面の候補を「不完全」（`INCOMPLETE_SETTLE_TIMEOUT`）として記録する。
- 凍結: 落ち着いた後、読む前に、そのページに Interaction の凍結をかける（凍結の後は、ページの JS による送信も止まる）。1 つの画面ごとに新しい Context を使う（凍結は戻せないため）。
- JS の結び付き: document か root に click・submit の委譲の listener があれば、その画面のすべてのボタンとフォームを `NEEDS_BINDING` にする。
- 対象の外: closed な shadow root と iframe の中は読まず、その画面を「不完全」（`INCOMPLETE_FRAME_OR_CLOSED_SHADOW`）として記録する。open な shadow root は読む。
- 書き込み 0 の保証（重ねる）: (1) 発見のコードは入力の操作を呼ばない（Gate）。(2) 凍結の後に読む。(3) fixture のサーバの要求の記録が 0 件であることをテストで確かめる。(4) ページ自身が出した送信（beacon の POST など）は、Guard が今までどおり止めて記録する（発見の操作と区別して数える）。

### 4.3 分類（`src/discovery/classify.ts`。表で駆動する純粋な関数）

次の順で、最初に当たったものに決める。

1. 送信先が許可 Origin の外 → `BLOCKED_EXTERNAL`。
2. 実際の method が DELETE、または危険な語（ボタンの文言、送信先の path、query の名前）に当たる → `NOT_EXECUTABLE`（理由 `DESTRUCTIVE`）。危険な語は、Task 25 の既定の危険な語の英語に、日本語（削除、取り消、取消、一括、無効、解約、退会、アーカイブ、廃止、停止など。閉じた一覧）を足した **発見の分類のための別の一覧**（Task 25 の `DEFAULT_EXCLUDED_URL_WORDS` は変えない。認証つきの Run の設定の digest を変えないため）。
3. GET → `READ`。ただし JS の結び付きがあれば `NEEDS_BINDING`。password の欄を持つ GET、multipart の GET は `UNSUPPORTED_READ_TRANSPORT`。
4. POST で、検索の語（検索、search、絞り込み、filter など）がある → `UNSUPPORTED_READ_TRANSPORT`（POST で読む画面は、この Task では実行しない）。`/graphql` への POST も同じ。
5. JS の結び付きがある → `NEEDS_BINDING`。
6. PATCH・PUT、または更新の語（更新、保存、編集、変更、update、save、edit）→ `UPDATE`（表示だけ。実行は Task 28 以降）。
7. 登録の語（登録、追加、作成、新規、create、add、new、register）→ `CREATE`（表示だけ）。
8. それ以外 → `DISPLAY_ONLY`（分類できない。候補として表示するだけ）。

- `active`・`status`・`deleted` などの名前の欄を持つ候補には、「状態の欄」の印を付ける（Task 31 の削除相当の判断に使う）。
- `NEEDS_BINDING` と `DISPLAY_ONLY` と `NOT_EXECUTABLE` は、どの Task でも実行の権限を持たない（推測だけで承認できる形にしない）。

### 4.4 指紋（`src/discovery/fingerprint.ts`。`createSha256Fingerprint` を使う）

- **識別の digest**: 画面の Origin と path、method、送信先の Origin と path、入力の欄の `name|tag|type` を並べたもの、送信ボタンの文言。
- **入力規則の digest**（識別とは別）: required・readonly・disabled・hidden・制約・選択肢の値。
- 入れないもの: 入力の値、トークン、label の文言。
- 同じ画面の同じ候補は、読み込み直してトークンが変わっても同じ識別の digest になる。欄を 1 つ足すと、識別も規則も変わる。同じ form の 2 つの送信ボタンは違う候補。
- ドリフト: 前の発見と今の発見を、識別の digest で突き合わせ、新しく現れた・消えた・規則が変わった候補を示す（画面と成果物）。

### 4.5 READ の確かめ（`src/discovery/read-executor.ts`、管理データ）

- **定義**（人が画面で作り、管理データに保存する）: 対象の READ の候補（識別の digest）、送る値（候補の、見えていて readonly でも disabled でもない入力の欄だけ。名前 → 値）、期待（閉じた一覧: `ROW_COUNT_EQUALS`、`ROW_COUNT_AT_LEAST`、`TEXT_CONTAINS`、`DETAIL_FIELD_EQUALS`）。
  - 秘密に見える名前（Task 26 の伏せ字の一覧に当たる名前。`state`、`code`、`key` など）の欄に値を送る定義は、保存のときに理由のコード（`READ_PARAMETER_SECRET_LIKE`）で拒む（黙って落とさない）。この Task では送らない。
  - 値はテスト環境のテスト用の値だけ（手順書に書く）。値は管理データに平文で保存する（資格情報ではないため）。画面と成果物には出してよいが、秘密に見える名前は上のとおり拒む。
- **実行**（`READ_CHECK` のジョブ）: 定義ごとに、候補の送信先と送る値で URL を組み立てる（巡回の正規化は通さない。送るのは定義の欄の名前だけ。`crawl.allowedQueryParameters` には足さない）→ `classifyPassiveRequest` で判定（読まないパス、危険な語、許可 Origin。BLOCK なら実行せず `READ_BLOCKED_BY_POLICY`）→ 読み込みの間隔を守って `goto` → 落ち着くのを待つ → 結果を構造にする（表の行、詳細の `dl`、一覧の行を、汎用の規則で取る）→ 期待と照らす（`MATCHED`、`NOT_MATCHED`、`UNDETERMINED`（構造が取れない））。
  - 送る前に、候補の今の識別の digest が定義のものと同じかを確かめる（画面が変わっていれば実行せず `READ_CANDIDATE_DRIFTED`）。
  - 成果物（`read-evidence.json`）: 定義の ID、URL（Task 25 の伏せ字を通す）、HTTP の状態、構造にした結果の要約（件数と、照らした項目だけ。表の全体の写しは持たない）、照らした結果。スクリーンショットは今の監査と同じ扱い。
- 1 回のジョブの READ の数の上限（名前つきの定数。例 20）。読み込みの間隔は設定のファイルの値。

### 4.6 ジョブと管理データ（版 5）

- ジョブの種類に `DISCOVERY` と `READ_CHECK` を足す（版 5 でジョブの表を作り直す。**版 4 の CHECK の値の一覧を、版 4 を公開した時点の写しで先に固定する**（T26c と同じ教訓。版 4 の DDL が今の定数を参照しているため）。版 1〜4 の文の SHA-256 をテストで固定する）。
- 新しい表: `discovery_candidates`（プロファイルの ID、識別の digest、規則の digest、分類、理由のコード、画面の path、送信先の path、method、状態の欄の印、最初に見たジョブと時刻、最後に見たジョブと時刻）、`read_checks`（定義。送る値と期待は JSON。版つき）、`read_check_results`（ジョブ、定義、結果、時刻）。値の label、入力の値、トークンは持たない。
- 開始の確かめ: Task 25・26 と同じ（プロファイル、認証の設定、自動ログインなら資格情報と上限）。
- ワーカー: `START` に種類を足す。ログインの段は Task 25・26 のまま。

### 4.7 画面（`apps/local-ui/`）

- プロファイルの詳細から「操作の候補を探す」（`DISCOVERY` を始める）と「READ の確かめ」（定義の一覧、作成・編集・削除、`READ_CHECK` を始める）。
- 候補の一覧: 画面ごと、分類ごとに、欄の型と制約、送信先、分類の理由、ドリフト（新しい・消えた・変わった）を出す。`NOT_EXECUTABLE`・`NEEDS_BINDING`・`DISPLAY_ONLY` は「実行できない」と明示する。
- READ の確かめの結果: 定義ごとの照らした結果と、期待と取れた値の要約。
- 表示はカタログと文言の owner を通す。

### 4.8 秘密と個人情報

- 候補と索引に、入力の値・トークン・選択肢の label を持たない。成果物の URL は Task 25 の伏せ字を通す。Guard の Ledger の生の URL（CSRF のトークンを含みうる）も、成果物に書くときに伏せる（今の ArtifactWriter の 1 か所）。
- READ の結果の構造の要約は件数と照らした項目だけにし、表の全体（テスト環境の実データ）を写さない。

## 5. SSOT と安全性への影響

| 項目 | owner | この設計での扱い |
| --- | --- | --- |
| 要求の判定 | `src/safety/request-policy.ts` | 利用のみ（READ の URL の事前の判定） |
| 凍結 | `src/safety/passive-request-guard.ts` の `activateInteractionFreeze` | 利用のみ |
| ログインの段と状態の受け渡し | Task 25・26 の部品 | 利用のみ |
| 秘密の伏せ字 | `src/safety/redact.ts` | 利用のみ |
| 指紋 | `src/core/ids.ts` の `createSha256Fingerprint` | 利用のみ |
| 候補の契約・発見・分類・指紋・READ の実行 | `src/discovery/` | 新設 |
| 候補の索引と READ の定義 | `src/control/` と管理データの版 5 | 新設 |
| 発見の分類の危険な語 | `src/discovery/classify.ts` | 新設（Task 25 の一覧とは別。理由は 4.3） |

- 公開監査（`PUBLIC_PASSIVE`）と認証つきの監査（`AUDIT`）の流れと出力は変えない。
- `src/**` に対象のサイトの名前・ドメイン・セレクタを書かない。

## 6. テスト設計（fixture。127.0.0.1 だけ）

- fixture: 一覧、詳細、GET の検索フォーム、POST の登録フォーム、PATCH（`_method`）の更新フォーム、削除のボタン、JS で送るボタン（要素の listener、document の委譲）、SPA（後から描画）、readonly・disabled・hidden・select、open な shadow root、iframe、DOM clobbering のあるフォーム。
- 発見: 候補と分類が表のとおり、発見の間のサーバへの要求 0（2 つの Chromium）、凍結の後のページの送信は Guard が止める、SPA の待ち、不完全の記録、値とトークンが候補に出ない。
- 指紋: トークンが変わっても同じ、欄を足すと変わる、2 つの送信ボタンは別、ドリフトの表示。
- READ: URL の組み立て、事前の判定で止まる場合（読まないパス、危険な語、秘密に見える名前の定義の拒否）、照らした結果の 3 つ、候補のドリフトで止まる、要求は GET だけで、定義の数の上限と読み込みの間隔を守る。
- 版 5 の移行と、版 1〜4 の文の固定。
- 画面（候補の一覧、定義の作成と編集、結果）、目印の検査（トークンと値が索引と画面に出ない）。
- 公開監査と認証つきの監査の不変（golden、`cli-output-parity`、`cli-ui-parity`、Safety Gate）。
- Gate: 発見のコードが入力の操作を呼ばない、`src/discovery/` の境界。

## 7. 対象外

- CREATE・UPDATE の実行、シナリオの承認（Task 28 以降）。
- POST で読む画面の READ、HEAD。
- path の中の ID の型（テンプレート化）。
- closed な shadow root と iframe の中の候補（不完全として記録）。
- 公開監査のプロファイルでの発見。
- 実テスト環境での確かめ（ADR-013。ロードマップの終わりの方）。

## 8. 完了条件（G27）

- [ ] fixture で、発見の間のサーバへの書き込みの要求 0（2 つの Chromium）、分類が表のとおり、未確定の候補（`NEEDS_BINDING` など）に実行の権限がない、削除相当がすべて実行できない。
- [ ] READ の確かめの取得と照合が PASS、事前の判定で止まる場合が PASS。
- [ ] 公開監査と認証つきの監査が変わらない。
- [ ] `npm run verify:all` が通しで PASS（扱いは G27 のときにユーザーに確かめる）。独立レビューで Critical 0、Important 0。

## 9. 実装計画の分け方（概要。承認の後に実装計画を書く）

T27a 契約・スキーマ・理由のコード・指紋・分類（表で駆動）→ T27b 発見の probe・listener・落ち着きの待ち・凍結と、書き込み 0 の fixture と Gate → T27c 管理データの版 5（版 4 の固定を先に）と索引と READ の定義 → T27d `DISCOVERY` のジョブ（ワーカー、成果物、ドリフト）→ T27e READ の実行と `READ_CHECK` のジョブ → T27f 画面 → T27g 目印の検査・回帰・手順書 → T27R 独立レビュー。

## 10. ユーザーの承認が要る点

1. **範囲**: READ の確かめの定義（送る値と期待）を作る画面と保存を、この Task に含める（含めない場合は、発見と、送る値なしの READ の取得だけにする）。
2. **新しいジョブの種類と、サイトへの読み込み**: `DISCOVERY` と `READ_CHECK` は、今の監査とは別に管理画面を読み込む（読み込みの間隔と上限は設定のファイルの値。READ は 1 回のジョブで最大 20）。
3. **発見の分類のための危険な語に、日本語を足す**（Task 25 の読まない語の一覧は変えない）。
4. **READ の送る値を管理データに平文で保存する**（テスト環境のテスト用の値だけ。秘密に見える名前の欄は拒む）。

## 11. 設計変更履歴

| 日付 | 契機 | 変更内容 | 影響範囲 |
| --- | --- | --- | --- |
| 2026-10-11 | 初版（T27 調査） | 発見は読むだけ（凍結の後の 1 回の evaluate、CDP の listener）、READ は URL を組み立てて GET、分類は表で駆動、2 つの digest の指紋、結果は成果物と版 5 の索引、新しいジョブの種類 2 つ | Task 27 |
| 2026-10-11 | T27a の報告 | 実装者の判断を受け入れる（どれも実行の権限を持たない向き）: (1) 表に `NO_KNOWN_ACTION`（listener のない form の外のボタン）、`DIALOG_METHOD`、`METHOD_OVERRIDE_UNRECOGNIZED`（閉じた一覧の外の `_method`。fail-closed）を足す。更新と登録の語は、書き込みの method の form だけで見る。(2) 3 段の中では、扱えない読み取り（password、multipart）を JS の結び付きより先に判定する。(3) 委譲として数える listener は、document・window・祖先の押す・送る種類（click、submit、formdata、pointer、mouse、touch の系統）だけ。form と送信ボタンの listener は種類を問わず結び付き。(4) 識別の digest に query の名前（並べたもの。値は入れない）も入れる。(5) 危険な語は、Task 25 の既定の 8 語を `src/discovery/classification-words.ts` に同じ文字列で持つ（`src/discovery/` は `src/control/` を import できない。8 語をすべて含むことをテストで固定）。(6) READ を実行する前には、識別の digest が同じことに加えて、今の分類が `READ` であることも確かめる（JS の結び付き・enctype・target は識別に入れないため） | T27a、T27e |
| 2026-10-11 | Blocker: T27c（秘密に見える名前の判定 `src/safety/redact.ts` を `src/control/` から import できない、ジョブの種類の一覧の本体がワーカーの契約にある） | (1) 秘密に見える名前の一覧と判定（`SECRET_URL_QUERY_PARAMETER_NAMES`、`isSecretUrlQueryParameterName`、比べる形への直し）を `src/core/secret-query-names.ts` に移し、`redact.ts` はそこから import して今の名前のまま公開し直す（owner を 1 つに保つ。振る舞いは変えない）。(2) ジョブの種類は今までどおり 1 か所（`worker-protocol.ts` の `WORKER_JOB_KINDS`）に定義し、`DISCOVERY` と `READ_CHECK` をそこに足す（スキーマの enum も）。ワーカーは、対応する前の種類（T27c の時点では `DISCOVERY`・`READ_CHECK`）の `START` を監査として扱わず、明示に拒む（fail-closed。T27d・T27e で対応を足す）。(3) READ の確かめの契約（期待の種類、結果の種類、1 回のジョブの READ の上限 20、定義の数の上限、値の長さの上限）は、純粋な `src/discovery/read-check-contracts.ts` に置く（`src/control/` とワーカーの両方から使える）。(4) READ の定義の検証は候補（`DiscoveryCandidate`）を引数で受ける。保存の口（T27f）が成果物 `discovery.json` から候補を読んで渡す | T27c、T27d、T27e、T27f |
| 2026-10-11 | T27b・T27c の報告と T27d の前の判断 | (1) form の中の送信ボタンでないボタンも `BUTTON` の候補にする（見落とさない向き。実行の権限はない）。(2) 索引に `last_changed_job_id`、method は `form_method` と `method_override` の 2 列（実際の method の判定の owner は分類の部品のまま）。READ の結果に `READ_CANDIDATE_NOT_READ` を足す。(3) 発見のジョブの結果は、ワーカーが Run のディレクトリに `discovery.json`（画面の記録の一覧）を書き、親（ジョブの管理）がジョブの終わりにそれを読んでスキーマで確かめ、索引を 1 つのトランザクションで更新する（IPC に候補を載せない）。発見のジョブは再開しない（中断したら、もう一度始める）。(4) 同じジョブの中で、同じ識別の digest で中身（規則の digest・分類）の違う候補は、1 件にまとめ、分類を `DISPLAY_ONLY`・新しい理由 `DUPLICATE_IDENTITY_CONFLICT` にする（READ の対象にしない）。(5) ドリフト: 今回のジョブで読んだ画面にあった候補だけを `MISSING` にし、読まなかった画面（巡回の上限など）の候補は新しい `NOT_REVISITED` にする | T27b、T27c、T27d |
| 2026-10-11 | Blocker: T27d（ArtifactWriter に発見の成果物を書く口がない、`NOT_REVISITED` と候補 0 件のジョブを索引の読み出しで出す保存の形がない） | (1) 成果物の owner を 1 つに保つ: `src/core/artifact-layout.ts` に `discovery.json` の名前を足し、`src/report/artifact-writer.ts` に発見の成果物を書く関数を 1 つ足す（URL の伏せ字は今の `#outgoing` を通す）。成果物のスキーマ `schemas/discovery.schema.json` を足し、`src/core/schema-validator.ts` で確かめる（候補の形は `candidate.schema.json` を参照し、書き写さない）。発見のジョブは、監査と同じく出力先の開始のロックと Run のロックを取る（CLI の監査から動いている Run が見える）。`discovery.json` が読めない・スキーマに合わないときのジョブの失敗の理由 `DISCOVERY_RESULT_INVALID` を足す。(2) 版 5（未公開）に `discovery_jobs` の表（ジョブの ID を主キー、プロファイル、記録した時刻、読んだ画面の path の一覧（JSON））を足す。同じジョブの 2 回目の記録は主キーで拒む。最後のジョブと読んだ画面はこの表で決め、読んだ画面にあって今回ない候補を `MISSING`、それ以外の今回ない候補を `NOT_REVISITED` にする。候補 0 件のジョブも、この表の行で分かる。索引の記録は、ジョブを終わりにする書き込みの前に、別のトランザクションで行う（途中で落ちたら、索引は記録済みでジョブは中断になる。読み出しは索引の記録を正とする） | T27d |
| 2026-10-12 | T27g の報告（発見事項 1） | READ の送る値（テスト用の値。秘密に見える名前の欄は保存の前に拒む）が出てよい場所に、親からワーカーへの `START` の通信を加える。ワーカーは送る値を受け取らないと READ を行えないため（T27e の設計どおり、定義の一覧を `START` に載せる）。製品は IPC を保存しない（テストの記録だけ）。出てよい場所は、定義の画面、管理データ、`read-evidence.json`（URL は伏せ字の後）、`START` の通信の 4 つ。秘密の目印（Cookie、資格情報、CSRF のトークン、hidden の値、入力の欄の今の値、選択肢の label、表の行の中身）は、`START` を含むどこにも出さない（変わらない）。 | T27g のテスト（`discovery-secret-markers`）と `doc/spec/discovery-and-read-check.md` はこの扱いで書かれている。製品のコードは変えない。 |
| 2026-10-12 | T27R の指摘（C2 = DEF-086、M2・M5 = DEF-088、M3、M4） | (1) 4.1 を改める: 候補は送信ボタンの文言を持たない。文言は分類の閉じた一覧の語（`DISCOVERY_SUBMITTER_WORDS`）のうち当たるものだけ（`submitterWords`）に変えて捨てる（4.1 と 4.8 の矛盾の解消）。識別の digest の版を 2 に上げる。(2) GET の form の欄の名前も危険な語の比べの対象にし、型を問わず `_method` の欄がある GET の form は `NOT_EXECUTABLE`。(3) READ で送る名前と値に発見の分類の危険な語（日本語を含む）の判定をかけ、保存のときは `READ_PARAMETER_DANGEROUS_WORD` で拒み、実行の前は `READ_BLOCKED_BY_POLICY`（`detail` は `PARAMETER_DANGEROUS_WORD`）。(4) 欄の名前の英語の語は、語の単位（`_`・`-`・大文字の切れ目で分けた語と一致）で比べる（部分一致だと `include_disabled` などの絞り込みの欄で誤って止めるため。日本語は区切りがないので部分一致のまま）。(5) READ の送る値が出てよい場所に、ワーカーから親への `AUTH_STATE` の `SESSION_LOST` の URL（管理データに記録される）を加える。(6) Gate `discovery-boundary` の (w) の対象に page を受け取るワーカーの 3 ファイルを加える。 | 管理データの版は変えない（理由のコードは今の閉じた一覧から選ぶ）。修正の前に記録した候補と定義は、次の発見で新しい識別になる（版 5 は未公開）。 |
| 2026-10-12 | T27R の指摘（C1 = DEF-085、C3 = DEF-087） | (1) DEF-087: probe と READ の結果の構造の読み取りを、CDP の isolated world（`Page.createIsolatedWorld` と `Runtime.callFunctionOn`）で動かす（ページの JS が読み取りを偽れない）。listener の取得は main world の objectId のまま。(2) DEF-085（ユーザーの判断 2026-10-12「A 中継を全部に」）: すべての Guard の Context に出口の中継を付け、Guard が Context を閉じる直前に中継を凍結する（Context の破棄の途中に始まったポップアップの最初のナビゲーションを、中継が拒んで記録する）。実装の前に、公開監査の結果（golden、計測値）が変わるかを fixture で測り、変わるなら報告してから進める。 | 公開監査と認証つきの監査の通信の経路が変わる（中継を通る）。 |
| 2026-10-12 | DEF-085 の手順 0 の測定とユーザーの判断 | 中継を通すと、公開監査の fixture で時間の計測値（TTFB で +2.9〜+5.9 ms、読み込みの完了や資源の応答の終わりで 10 ms 前後）が、同じ条件の 5 回の揺れの幅を超えて遅く出た。Finding、HTTP の状態、資源の数と大きさ、サーバに届いた要求、Safety Ledger、CLI の出力は同じ。実サイトでは DNS を中継が引き、HTTP/3 を使わなくなる見込み（推測）。ユーザーの判断（2026-10-12）「A を続ける」: すべての Guard の Context に中継を付ける。計測値が中継を通した値であることを手順書（`doc/spec/`）に書く。 | 公開監査と認証つきの監査の時間の計測値が、中継の分だけ遅く出る。 |
