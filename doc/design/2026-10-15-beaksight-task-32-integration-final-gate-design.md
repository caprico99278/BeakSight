# BeakSight Task 32 全体統合・最終 Completion Gate 設計書

作成日: 2026-10-15
状態: ユーザー承認済み（2026-10-15。10 章の 5 点を含む）。G32 のうち fixture の部分を承認済み（2026-10-15）。G32 を締めた（2026-10-16。実テスト環境のログインが要る段は未検証）
対象範囲: ロードマップ Task 22〜31 で作った 3 つのモード（公開サイトの読み取りだけの監査、テスト環境の認証つきの監査、承認された書き込み）を、1 つの製品として通しで確かめる。書き込みの報告を作り、残りの共通化と不具合を片付け、利用者の文書と検証の証拠をまとめ、最後に実テスト環境で低負荷の確かめを行い、G32 の判定を受ける。

## 1. 目的

Task 31 までで、各モードの機能は Gate ごとに fixture で確かめた。ただし次が残っている。

- 画面だけで「候補の発見 → 承認 → 生成 → CREATE → READ → UPDATE → READ → 報告」を通す確かめがない（各段のテストはあるが、画面からの CREATE は偽のワーカー）。
- 書き込みの報告は、画面の結果の表示と作業のフォルダの `action-run.json` だけで、ロードマップ 13 章の報告（`action-evidence.json`、`approval-summary.json`、HTML、ZIP、監査済みデータの台帳）がない。
- 利用者の文書に古い記述（「開発中」「書き込みはしない」「画面の手順は後で足す」）が残り、導入・通しの使い方・匿名化・リスクの一覧がない。
- 全 Task の検証の証拠と残りのリスクのまとめがない。
- 実テスト環境での確かめ（ADR-013）をまだ行っていない。

この Task でこれらを片付け、ロードマップの最終成功条件（公開サイトを従来どおり安全に監査できる、テスト環境を正規の認証で読み取りだけで監査できる、承認の意味と有効性が画面とワーカーで一致する、許可された CREATE・UPDATE だけを証拠つきで実行できる、削除・無断の通知・本番の書き込み・秘密の漏れ・偽の完了が起きない）を判定できる状態にする。

## 2. 根拠となる文書とユーザーの判断

- 従う文書: ロードマップ `2026-10-09-beaksight-task-22-32-roadmap.md` の Task 32、11 章（RF1〜RF5）、12 章（横断テストマトリクス）、13 章（成果物・機密情報・履歴）、14 章（ADR-012・013）、15 章（引渡条件）。Task 22〜31 の各設計書。
- 調査: 作業記録 `progress.md` の T32-research（棚卸し）、T32-research-2（書き込みの報告）、T32-research-3（CC-050・CC-068）、DEF-110-research。
- ユーザーの判断（2026-10-15。言葉どおり）:
  1. 実テスト環境: 「使える。Task 32 の中で行う」。fixture の確かめをすべて終えた最後に、ユーザーが起動しログインする形で、承認済みの低負荷（`crawl.maxPages: 3`、`crawl.minNavigationIntervalMs: 10000`）から始める。書き込み（CREATE・UPDATE）まで行うかは、その時に改めて諮る。
  2. 揺らぎ: 「G26〜G31 と同じ扱い」。全体の検証の揺らぎは記録し、単独の再実行で PASS なら可とする。全体の検証は流し直さない。ただし種類の分からない違反（DEF-110）は調べる（調べた結果、製品の誤った判定と分かったので直す。4.6）。
  3. 書き込みの報告: 「ロードマップどおりに作る」（`approval-summary.json`・`action-evidence.json`・HTML の報告・ZIP）。
  4. 認証つきの監査の成果物（ZIP に管理画面の文とスクリーンショットが入る）: 「今のまま、手順書だけ足す」。
  5. 安全の境界に関わる共通化（CC-050・CC-068）: 「入れる」。
  6. 人の値（UPDATE の変えた欄の前の値、照合の READ で読んだ画面の文字）: 「どこにでも入れ、注意を明示」。
  7. 報告の対象: 「ワーカーが終わりまで進んだ回すべて」（`BLOCKED` を含む。ワーカーが異常終了した回は画面の結果の表示だけ）。
- 読み替え:
  - ロードマップの「UI Playwright E2E」は、今ある画面のテスト（ビルドした画面を headless の Chromium で操作する `apps/local-ui/tests/*-flows`・`*-markers`）の作りで、通しのテストを 1 本足すことと読む。
  - 「新しいモードは別番号の acceptance suite で管理」は、テストのファイルを組み替えず、Gate とテストの対応表（4.8）で管理すると読む（組み替えは既存のテストの期待を変える危険があるため）。
  - 「CLI 互換は Task 21 と比較可能な golden fixture、diff」は、今ある golden（`cli-output-parity`、`public-passive-golden`）で満たすと読む。
- 引き続き守る不変条件: SSOT Owner Matrix、Safety Invariants、Target Isolation、承認と実行の許可の SSOT（Task 28）、書き込みの照合の owner（`src/safety/write-payload-policy.ts`）、成果物を書けるのは ArtifactWriter だけ（ARCH08）、`src/control/` は `src/safety/` を読み込まない（`control-boundary` (b)）、画面は `src/report/` を読み込まない（`local-ui-boundary` (g)）、文言はカタログだけ（UI Gate）。

## 3. 採用する設計（全体）

Task 32 を次の 9 つの作業に分ける。各作業の詳細は 4 章、順序は実装計画。

| 作業 | 内容 | 依存 |
| --- | --- | --- |
| A 不具合 | DEF-110（偽の `ABORTED_BY_SAFETY`）を直す | なし（進行中） |
| B 小さい共通化 | CC-039、CC-087 の後半、CC-080 (b)(c)（CCX-29） | なし（進行中） |
| C 書き込みの報告 | `action-evidence.json`・`approval-summary.json`・`action-report.html`・ZIP、画面での配布、監査済みデータの台帳の画面 | なし |
| D 通しの E2E | 画面だけで 3 つのモードと書き込みの全段を通し、成果物を開く | C |
| E 認証の対比 | 手動のセッションと自動ログインを 1 つの fixture で並べ、権限の違いを確かめる | なし |
| F 安全の境界の共通化 | CC-050・CC-068（調査の結果で方式を決める） | A |
| G 文書 | README、`doc/spec/` の古い記述、新しい文書（導入、通しの使い方、匿名化、リスクと監査ログ、実テスト環境の手順） | C・E の後に仕上げ |
| H 証拠のまとめ | Gate とテストの対応表、検証の記録、未解決の不具合と残りのリスク、最後の `verify:all`、独立レビュー T32R | A〜G |
| I 実テスト環境 | 手順書に沿って、ユーザーが起動しログインして行う低負荷の確かめ | H、ユーザーの承認 |

## 4. 詳細設計

### 4.1 書き込みの報告（作業 C。ユーザーの判断 3・6・7）

**書く人と時点**: ワーカーが、Run の終わり（`endWorkerRun` の前。結果の判定と照合の READ の後）に、ArtifactWriter で Run のディレクトリに書く。親（`src/control/`）は ArtifactWriter を使えず（`control-boundary` (b)）、画面のサーバは `src/report/` を使えない（`local-ui-boundary` (g)）ため、境界を動かさずに作れるのはワーカーだけである。親が締めた後に確定する値（予約の最終の状態、締めた後の累計）は、報告には「開始の時点の値」として書き、確定の値は画面（結果の表示と台帳）で示す。

**承認の要約の受け渡し**: 親が、実行の許可を発行して START を送るときに、`write.approvalFacts`（秘密を含まない承認の要約。下の `approval-summary.json` の中身）を足す。ワーカーはそれを照らさずに書き写すだけで、承認の判断はしない（承認の SSOT は親のまま）。IPC の契約とスキーマ（`worker-protocol.ts`、`schemas/control/worker-message.schema.json`）を広げる。

**成果物**（名前は `src/core/artifact-layout.ts` に足す。スキーマは `schemas/` に足し、`schema-validator.ts` と `schema-enum-consistency` の表に登録する）:

| 成果物 | 中身（秘密は持たない） |
| --- | --- |
| `action-evidence.json`（`action-evidence-schema/1.0`） | jobId・runId、書く前の確かめの結果（候補の digest の一致）、送った欄の名前と値、応答（HTTP の状態、判定、時刻）、登録の ID、UPDATE の欄ごとの前後の値と一致、照合の READ の証拠の全体（`ReadCheckExecutedEvidence`。URL は伏せ字を通す。構造の要約、期待ごとの結果、`observedValue`）、Guard の数の要約（止めた数の理由ごと、応答を返せなかった印）、`containsHumanEnteredValues`（人の値が入りうる項目があるときに真） |
| `approval-summary.json`（`approval-summary-schema/1.0`） | シナリオの ID・版・種類、承認の記録（receiptId、approvedAt、expiresAt、approvalDigest、bound、approver）、開始の時点の撤回の有無、入力の規則の参照と digest、limits、approvalTtlDays、副作用の確認、実行の許可（発行、期限、消費）、予約（件数、予約の時刻）、開始の時点の累計、「人が決めたこと」と「自動で行うこと」の閉じた一覧 |
| `action-report.html` | 結果のバッジ、理由、`UNKNOWN`・`PARTIAL` の目立つお知らせ、送った値、前後の差分、照合の READ、承認の要約。先頭に「人が入れた値が入りうる」の注意（`containsHumanEnteredValues` が真のとき） |
| `beaksight-action-bundle_YYYYMMDDHHmmss.zip` | 目録（各ファイルの sha256、人の値が入りうるの注意）、`action-run.json`、`action-evidence.json`、`approval-summary.json`、`action-report.html` |

- **人の値**（ユーザーの判断 6）: UPDATE の変えた欄の前の値と、照合の READ の `observedValue` は、JSON・HTML・ZIP のすべてに入れる。HTML の先頭と ZIP の目録に、人の値が入りうることを書く（文言はカタログ）。認証つきの監査の ZIP と同じ扱い。秘密（資格情報、Cookie、CSRF、hidden・readonly・保つ欄の値、`lock_version`）は今までどおり読むだけで記録しないので、どの成果物にも入らない。
- **報告の対象**（ユーザーの判断 7）: ワーカーが Run の終わりまで進んだ回はすべて（`VERIFIED`・`PARTIAL`・`UNKNOWN`・`FAILED`・`BLOCKED`）。送らずに止めた回は、止めた理由と確かめの結果を書く（送った値・応答・READ の項目は空）。ワーカーが異常終了した回は成果物がなく、画面の結果の表示だけになる。
- **1 回だけ組み立てる**: `action-run.json`（版は変えない）と `action-evidence.json` は同じメモリの事実から組み立て、重なる値が一致することをテストで確かめる。表示用モデル（`src/report/action-view-model.ts`）を 1 回だけ組み立て、HTML はそれを描くだけにする。部品は `html-components.ts`（`renderDocument`、`renderTable`、`renderKeyValueList`、`renderBadge`）、CSS は `html-tokens.ts`、表示の値はカタログ（`ACTION_RESULT_CATALOG` など既存）、文言は `messages.ts` の `ACTION_REPORT_TEXT`（新設）。
- **決定論の ZIP**: `src/report/chatgpt-bundle.ts` の ZIP の組み立て（時刻の固定、目録の sha256）を共通の部品 `src/report/deterministic-zip.ts` に出し、監査のバンドルと書き込みのバンドルが使う（共通化）。
- **approver**: 今の定数 `LOCAL_OPERATOR` のまま（人の名前は個人の情報になるので持たない）。設計者の判断。
- **親の確かめと画面の配布**: 親は締めのときに、新しい 3 つのファイルと ZIP を `action-run.json` と同じ形で確かめる（スキーマ、ジョブ、Run、許可の一致）。確かめに通らないか、ジョブが `WRITE_RESULT_INVALID` で締まった場合、画面は報告を配らず、その旨を出す。画面の成果物の許可の一覧（`artifact-files.ts` の `JOB_ARTIFACT_KINDS`）に書き込みのジョブの 4 つを足し、style の hash の header を付ける HTML を、名前の閉じた一覧（`report.html`、`action-report.html`）に広げる（`launcher/request-guard.ts` の CSP を弱めない）。
- **報告の確かめの記録**（T32g の Blocker への設計者の判断）: 親の確かめの結果は、管理データの版 10 で `jobs` に足す列（例 `write_report_check`。`VALID` か理由のコード。書き込みのジョブだけ）に、書き込みの結果の締めと同じ時点で記録する。版 9 は G31 で公開になったので、版 9 の写しを固定してから版 10 を作る（T31e の版 8 と同じ作り）。`write_results` ではなく `jobs` に置くので、`write_results` に書く owner（`scenario-store.ts`。Gate `control-store-boundary` (l)(m)）は変えない。画面はこの列で報告を配るかを決める。START の `approvalFacts` との一致は締めの時点（メモリに START の指定がある間）にしか照らせないので、締めで照らした結果だけを残す。
- **監査済みデータの台帳**（ロードマップ 13.4）: 画面に、プロファイルごとの台帳（新しいルート）を足す。列は CREATE の登録の ID、シナリオと版、seedRecord（ID と digest だけ）、ジョブと Run、照合の状態、その ID への UPDATE の回数と最後の結果、累計の件数と上限。「BeakSight は削除も復元もしない」の注記。読み出しの口は `src/control/actions/write-result-facts.ts` に 1 つ足す。台帳の書き出し（ファイル）は作らない（画面だけ。設計者の判断）。

### 4.2 通しの E2E（作業 D）

- 新しい画面のテスト 1 本（例 `apps/local-ui/tests/full-flow.test.ts`）。ビルドした画面を headless の Chromium で操作し、127.0.0.1 の書き込みの fixture（`tests/helpers/write-site-fixture.ts`）に対して、本物のワーカー（CLI の起動の設定の Chromium）で次を通す: プロファイルの作成 → 公開の監査（PUBLIC_PASSIVE）→ 認証つきの監査（TEST_AUTH_PASSIVE）→ 候補の発見 → READ の定義と確かめ → CREATE のシナリオの作成と承認 → 入力の規則 → CREATE の開始と結果 → UPDATE のシナリオの作成と承認 → UPDATE の開始と結果 → 台帳の画面 → 成果物（`report.html`、監査の ZIP、`action-report.html`、書き込みの ZIP）を落とす。
- 落とした ZIP を開き、中の JSON をスキーマ（`run-schema/1.0`、`action-run-schema/1.0`、新しい 2 つ）で確かめる。HTML は本物のブラウザで開き、主な見出しと結果の値があることを確かめる。
- サーバの記録で、書き込みの POST が CREATE 1・UPDATE 1 だけ、ほかの読み取りでない要求が 0 であることを確かめる。目印の検査（資格情報・Cookie・CSRF・hidden・保つ欄の値が画面・管理データ・成果物に出ない。人の値は決まった場所だけ）。
- 画面の操作の補助は CCX-16 の補助（`scenario-marker-flow.ts` など）を使い、同じ名前の関数を定義し直さない（`ui-test-helper-reuse`）。
- 人が成果物を開いて確かめる項目の表（G の文書に置く）。

### 4.3 認証の対比（作業 E）

- 新しい結合のテスト 1 本（例 `tests/integration/auth-mode-contrast.test.ts`）。1 つの fixture（ログインの画面を持つ）に対して、手動のセッションの引き継ぎのプロファイルと、自動ログインのプロファイルの 2 つで監査を行い、次を並べて確かめる: ログインの POST の数（手動 0、自動はログインの段の 1）、監査の段で読み取りでない要求 0、Interaction の送信 0、資格情報が成果物・管理データ・IPC に出ない、ログインの段の許可を監査の段に引き継がない、自動ログインに失敗しても手動のログインを開かない。両方の Chromium。
- 既存の個別のテストは変えず、対応表（4.8）に載せる。

### 4.4 安全の境界の共通化（作業 F。ユーザーの判断 5）

- 調査 T32-research-3（実験は両方の Chromium）の事実:
  - CC-050: PASSIVE の page・Worker・iframe の要求は、CDP の横取りがすべて先に止め、route が止めた要求は 0。route が唯一の網になるのは、CDP の付いていない page（PASSIVE のポップアップの最初の要求、凍結の段のポップアップ）。route を薄くする・キャッシュだけにする・なくす変種では、ポップアップの要求が記録なしで届いた。PASSIVE のポップアップを止めている理由は、route の中の `request.frame()` の失敗（`FRAME_CLASSIFICATION_FAILED`）で、明示の方針がない（DEF-113）。今のテストは凍結の段の route の分岐を外しても検出しない（出口の中継が覆う）。
  - CC-068: ページの中で読む関数 15 個（11 ファイル）に、標準の prototype の getter とメソッドで読む同じ 4 行の部品がある。main world で読む限り、部品を共有しても、ページの JS の偽り（DEF-087）への強さは変わらない。isolated world で読む形（今の `readInIsolatedWorld`）だけが、偽りの 10 条件すべてで正しく読め、読む間にページの JS が走らなかった。
- ユーザーの判断（2026-10-15。言葉どおり）: CC-050 は「判定を 1 つの関数にまとめる（推奨）」、DEF-113 は「入れる（推奨）」、CC-068 は「isolated world への移行まで入れる」。
- **CC-050 の設計**: 「段階（PASSIVE、凍結、閉じる途中、書き込みの段など）と要求の判定から、動作（通す・止める・無効化）と記録（Ledger の理由、違反）を決める」純粋な関数を Guard の中に 1 つ作り、CDP の 2 か所（`handlePausedRequest` など）と route の処理が使う。判定（`classifyPassiveRequest`）は今のまま 1 か所。route は残し、役割を「CDP の付いていない page の網と、キャッシュの返し（`resourceDelivery`）」とコードと設計書に明記する。止める数と記録は変えない。
- **DEF-113 の設計**: route に来た要求のうち、CDP の付いていない page（Guard が CDP の session を付けた印のない page）のものは、frame の判定の成否に頼らず、明示の理由で止めて記録する（読み取りの GET を通すか止めるかは、今の段階の方針に従い、今の結果（届いた 0）を変えない。新しい理由のコードが要るときは閉じた一覧に足す）。回帰のテスト: PASSIVE のポップアップと凍結の段のポップアップで、route の分岐を外すと落ちること（中継あり・なし、両方の Chromium）。
- **CC-068 の設計**:
  1. ページの中で読む部品（標準の getter とメソッドで読む関数）と、型つきの組み立て（`composeInPage<I, O>` の形。入力と出力の型を保つ）を 1 つのモジュールに作り、15 関数の重複を置き換える。Architecture Gate で「ページの中の関数は自分で `getOwnPropertyDescriptor` を書かない」を確かめる（1 秒以内）。
  2. ログインの form の事前の確かめ（`login-form-submitter.ts`）と候補の発見の読み取り（`discover-candidates.ts`）を、isolated world（`readInIsolatedWorld`）へ移す。両者は ElementHandle を使うので、要素の橋渡し（CDP の同じ session で、main world の要素を backendNodeId で isolated world に取り直す形。調査の M5）の設計を、実装の前に調査担当が実機で確かめる（設計書に追補する）。
     - 調査 T32j-3 の結果（両方の Chromium。偽り・CSP・Guard との干渉を確かめた）による設計:
       - ログインの事前の確かめ: isolated world の中で、設定のセレクタから document と open な shadow root ごとに要素を探し直して読む（3 命令）。Playwright の `count()` と数が合わなければ止める（fail-closed）。入力と送信は今の Locator のまま。ElementHandle を使わなくなる。
       - ユーザーの判断（2026-10-15）「設定の検証で拒む（推奨）」: 標準の CSS として isolated world で読めないセレクタ（Playwright 独自の書き方 `:has-text()`・`:visible`・`>>`・`:nth-match` など、shadow root をまたぐ書き方）は、認証の設定を保存するときに理由つきで拒む。保存済みの設定は、実行のときに「form を読めない」として止まる。
       - 候補の発見: DISCOVER は `readInIsolatedWorld` で読む。RESOLVE・INSPECT は要素を backendNodeId で持ち（CDP の session をまたげる）、isolated world の文脈で解決して読む。操作は `xpath=` の Locator で得た ElementHandle で行い（Playwright の操作の前の確かめと時間の扱いを保つ）、得た後に isolated world で同じ backendNodeId を指すことを確かめ直す。
       - 橋（xpath の作り、handle の取り方、同じ要素の確かめ）は 1 か所の部品にし、`write-form-submitter.ts` もそれを使う。これで、main world で偽れる今の同じ要素の確かめ（DEF-114）を直す。
       - 読み取りの CDP の session は、今の Gate の決まりどおり読むたびに開く（1 回あたり約 2ms の代償を受ける）。CDP の命令の失敗（ページが移った、要素が消えた）は、今の evaluate の例外と同じ扱いにし、結果を変えない。
  3. 証拠の collector（`dom-collector`・`color-collector`・`layout-collector`）、scroll、settling、links は main world のまま（監査の結果を変えないため。DEF-089 の残りとして記録）。
  4. 移した後も、監査の結果（golden、`cli-output-parity`）、発見の結果、ログインの結果が変わらないこと。ページの JS の偽り（`Function.prototype.call`、`getOwnPropertyDescriptor`、prototype の getter の書き換え、`bind`、戻り値の直列化を狙う偽り、DOM clobbering）で、移した 2 つが正しく読むこと（両方の Chromium、CSP あり・なし）。
- 守る条件: 止められる要求の数が減らない（読み取りでない要求・記録されない要求がサーバへ届く回数 0。両方の Chromium）、Safety Ledger の記録が減らない、監査の結果（Finding、Evidence）が変わらない。独立レビューで実機の実験を求める。

### 4.5 文書（作業 G）

- README: 3 つのモードの簡易な説明と起動の手順だけ（詳細は `doc/spec/`）。
- `doc/spec/README.md`: 一覧に、Task 22〜31 の文書（profiles、authenticated-audit、automated-login、discovery-and-read-check、scenario-approval、data-rules、approved-create、approved-update）と新しい文書を載せる。
- 古い記述の直し: 「開発中」の注記、`local-ui.md` の「まだできないこと」、`scenario-approval.md`・`data-rules.md` の「書き込みはしない」、`approved-create/update.md` の「画面の手順は後で足す」（画面の手順を書く）、`profiles.md` の索引。
- 新しい文書: 導入（必要なもの、初期設定、最初の監査）、3 つのモードの通しの使い方、匿名化（成果物を外へ渡す前の確かめ。認証つきの ZIP と書き込みの報告に人の値と管理画面の文が入ること。ユーザーの判断 4・6）、リスクと監査ログ（承認の履歴と書き込みの台帳の読み方、未解決の不具合、受け入れた限界の一覧）、実テスト環境の手順（4.9）。
- 匿名の設定の例: TEST 環境のプロファイル、`approvedTestOrigins`、`environmentEvidenceRef`、認証の設定を合わせた例を `config/targets/` に足す（本来の監査対象のサイトの名前・domain は書かない）。

### 4.6 不具合（作業 A）

- DEF-110: Guard の `ensureCloseAttempt` が、期限で見捨てた Context の close の失敗（Browser を閉じた後の reject）を違反に数える。Context がもう存在しないことを文言に頼らずに確かめられたときだけ、閉じたとみなして違反にしない（Run は閉じる処理の失敗として `PARTIAL`）。確かめられないとき、ほかの理由の失敗は今のまま違反（fail-closed）。指示書 `DEF-110-fix-brief.md`。
- ほかの揺らぎ（DEF-093・095・097・104・105・109・111 など）は、ユーザーの判断 2 により記録だけ。G32 の `verify:all` で出たら、単独で流し直して分ける。

### 4.7 小さい共通化（作業 B）

CCX-29（CC-039、CC-087 の後半、CC-080 (b)(c)）。ほかに、`closePassivePage`・`closePassiveGuardedPage`（本番で使っていない。DEF-038）を消すか残すかを決める（テストの 2 ファイルだけが使う。消すなら Gate `semantic-ownership` の許可も外す）。CC-072・CC-081 の残り（テストの補助）は、作業 D・E で同じ補助を新しく書かないことで増やさず、余力があれば片付ける。

### 4.8 証拠のまとめ（作業 H）

- Gate とテストの対応表: G22〜G32 の各条件と、ロードマップ 12 章の各行ごとに、証拠のテスト（ファイルと describe）。否定のテスト（意図しない本番アクセス、DELETE、再試行の二重書き込み、期限切れの承認、ネットワークの脱出、未知の副作用、秘密の漏れ）の所在。
- 検証の記録: 各 Gate の `verify:all` の日時、終了コード、件数、揺らぎの扱い（`progress.md` から写す）。`NOT_RUN` は PASS とみなさない。
- 未解決の不具合と残りのリスクの一覧（利用者向けは `doc/spec/` のリスクの文書、開発の記録は作業記録）。
- 最後に `verify:all` を 1 回流し、独立レビュー T32R（通しの安全と、作業 C・F の安全）を受ける。

### 4.9 実テスト環境（作業 I。ユーザーの判断 1、ADR-012・013）

- 手順書（`doc/spec/` に置く。本来の監査対象のサイトの名前は書かない）: 事前の確かめ（Gate、設定、隔離の証跡）→ ユーザーが `npm run ui` を起動 → TEST 環境のプロファイル → 手動のセッションでの認証つきの監査（`maxPages: 3`、間隔 10,000 ms）→ 自動ログイン → 候補の発見と READ → ここで止めて、書き込み（CREATE・UPDATE）まで行うかをユーザーに諮る。
- 設計者は見張りと記録をし、Run の起動とログインはユーザーが行う（Run の起動と再開はユーザーの判断）。負荷の上限は設計書と手順書に明記する。
- 事前にユーザーに確かめること: ログインの方式（外部の IdP・MFA・JS で送るログインは未対応）。ユーザーの答え（2026-10-15）: 同じ Origin のフォームの送信。
- 証明書と隔離（ユーザーの指摘と判断。2026-10-15「その形で手順書を直して」）: HTTPS の証明書と隔離の証跡は、運用者には事前に分からない。隔離を確かめることもこの確かめの目的に含まれる。そこで次のとおり読み替える（ADR-012 の「操作者入力で証明」を、読み取りの段では「未確認と記録して観察する」に読み替える）。
  - 証明書は事前に確かめない。最初の低負荷の Run で分かる（信頼しない証明書はネットワークの層の失敗として記録され、Run は止まる。fail-closed）。書き込みまで進む場合だけ、書き込みの送り手（Node）が同じ証明書を信頼できるかを、その時点で確かめる。
  - 読み取りの段（手動のセッションの監査、自動ログイン、候補の発見と READ）は、隔離が未確認でも始めてよい（ログインの POST のほかは読み取りだけ）。プロファイルの `environmentEvidenceRef` には、未確認であることが分かる参照（例 `isolation-unverified-<日付>`）を入れる。
  - 読み取りの段で、ページが別の Origin へ出した要求の記録（許可 Origin の外への GET は止めずに送るので、ネットワークの Evidence と `run.json` の `load.requests.otherOrigins`）と、Guard が止めた要求の記録（読み取りでない要求、外への移動、ポップアップ、WebSocket）から、テスト環境の画面がつながる外部のサービスを観察する。サーバの裏側の隔離（データベース、登録・更新のときのメール・SMS・外部の API への通知）は BeakSight では観察できないので「未検証」と区分する。
  - 書き込みに進むかを諮るときに、観察した外部のつながりを材料として示し、裏側の隔離の扱いをユーザーが判断する。
- 行えなかった部分は「未検証」と区分し、「完成・本番検証済み」と書かない。

## 5. SSOT と安全性への影響

| 項目 | owner | この設計での扱い |
| --- | --- | --- |
| 書き込みの結果の契約 | `src/control/actions/action-contracts.ts` | 拡張（報告の契約。enum は既存の配列から導く） |
| 承認・許可の判断 | `src/control/approval/` | 利用のみ（親が要約を START に入れる。ワーカーは書き写すだけ） |
| 成果物の書き手 | `src/report/artifact-writer.ts` | 拡張（新しい 3 つと ZIP） |
| 成果物の名前 | `src/core/artifact-layout.ts` | 拡張 |
| 表示 | `src/presentation/`（カタログ・文言）、`src/report/html-components.ts` | 利用と拡張（`ACTION_REPORT_TEXT`） |
| 画面の成果物の配布 | `apps/local-ui/src/server/artifact-files.ts` | 拡張（許可の一覧に足す。CSP は弱めない） |
| Guard の close | `src/safety/passive-request-guard.ts` | 修正（DEF-110） |
| 要求の判定 | `classifyPassiveRequest`（CC-050） | 調査の結果で決める |

- 第二の owner を作らない: 報告の値は既存の事実から組み立て、判定（結果、承認の有効性）をやり直さない。
- target 固有の情報を `src/**` に入れない。実テスト環境の設定は `local/`（Git の外）に置き、例は匿名にする。

## 6. 共通部品と共通仕様

| 区分 | 名前 | 置き場所 | 扱い |
| --- | --- | --- | --- |
| 利用する既存の部品 | `renderDocument`・`renderTable`・`renderBadge`、`escapeHtml` | `src/report/html-components.ts` | 利用のみ |
| 利用する既存の部品 | `ACTION_RESULT_CATALOG` ほか書き込みの表示のカタログ | `src/presentation/catalog.ts` | 利用のみ |
| 利用する既存の部品 | 画面の操作の補助（CCX-16） | `apps/local-ui/tests/helpers/` | 利用のみ |
| 新しく作る共通部品 | 決定論の ZIP | `src/report/deterministic-zip.ts` | 新設（監査と書き込みのバンドルが使う）。台帳に追記 |
| 新しく作る共通部品 | 書き込みの報告の表示用モデル | `src/report/action-view-model.ts` | 新設。台帳に追記 |

- 変更容易性: 書き込みの結果や理由を 1 つ足すとき、変えるのは契約の配列、スキーマの enum、カタログの 3 か所だけで、報告の HTML・ZIP のコードは変えない（完了条件）。

## 7. テスト設計

- 書き込みの報告: スキーマのテスト（enum の一致を含む）、ワーカーの流れのテスト（`write-create-run`・`write-update-run`。成功・`UNKNOWN`・`PARTIAL`・`BLOCKED` で 4 つの成果物ができる、`action-run.json` と重なる値の一致、人の値の注意の印）、HTML の描画（エスケープ、注意、バッジ）、ZIP（決定論、目録の sha256、監査のバンドルが前と同じバイト列）、親の確かめ（食い違うファイルを配らない）、画面の配布（許可の一覧、CSP、パストラバーサル）、台帳の画面（CSRF、表示）、目印の検査。
- 通しの E2E（4.2）と認証の対比（4.3）。安全の項目は両方の Chromium。
- DEF-110: Guard の component のテストで RED（違反 1）→ GREEN（違反 0、閉じる処理の失敗の記録あり）、生きている Context の close の失敗は違反のまま。
- CC-050・CC-068: 調査の結果で追補する。
- 既存の Gate とテストの期待を変えて PASS に見せない。

## 8. 完了条件（G32）

- [ ] 既存の Task 21 の機能が変わらない（`cli-output-parity`・`public-passive-golden`・`safety-gates` が PASS）。
- [ ] 3 つのモードの必要なテストが PASS（Gate とテストの対応表の全行に証拠がある）。
- [ ] 通しの E2E が PASS し、書き込みの POST は CREATE 1・UPDATE 1 だけ、ほかの読み取りでない要求 0。
- [ ] 書き込みの報告（4 つの成果物）がスキーマに合い、画面から落として開ける。秘密が入らず、人の値の注意が出る。
- [ ] 認証の対比が PASS（両方の Chromium）。
- [ ] DEF-110 が直り、CC-050・CC-068 の共通化で止める数・記録が減らない。
- [ ] 文書が実際と合う（独立レビューで確かめる）。
- [ ] `npm run verify:all` を 1 回流し、失敗は単独の再実行で分けて記録する（ユーザーの判断 2）。
- [ ] 独立レビュー T32R で Critical 0・Important 0。
- [ ] 実テスト環境の確かめを手順書どおりに行い、行えなかった部分を「未検証」と区分する。「完成・本番検証済み」と表現しない。
- [ ] ユーザーが G32 を承認する。

## 9. 対象外

- 削除（DELETE）・初期化・復元の機能（ADR-007）。
- 外部の IdP・MFA・JS で送るログインへの対応（未対応のまま。手順書に書く）。
- 認証つきの監査の ZIP の伏せ字の追加（ユーザーの判断 4。手順書だけ）。
- 台帳の書き出しのファイル（画面だけ）。
- テストのファイルの acceptance suite への組み替え（対応表で管理する）。
- 揺らぎの根の対策（DEF-110 を除く。記録だけ）。

## 10. ユーザーの承認が要る点

1. 書き込みの報告をワーカーが Run の終わりに書き、締めの後の確定の値は画面で示すこと（4.1）。
2. 台帳は画面だけで、書き出しのファイルを作らないこと（4.1）。
3. CC-050・DEF-113・CC-068 の設計（4.4。方式はユーザーの判断で決まった。要素の橋渡しは実装の前に調査して追補する）。
4. 通しの E2E の範囲（4.2）。
5. 実テスト環境の手順の段と、書き込みの前で止めて諮ること（4.9）。

## 11. 設計変更履歴

| 日付 | 契機 | 変更内容 | 影響範囲 |
| --- | --- | --- | --- |
| 2026-10-15 | 初版 | T32-research・T32-research-2・DEF-110-research とユーザーの判断 1〜7 から作成。CC-050・CC-068 は調査の結果で追補する。 | Task 32 の全体 |
| 2026-10-15 | T32-research-3 とユーザーの判断 | 4.4 に CC-050（判定と記録を 1 つの関数に。route は残し役割を明記）、DEF-113（CDP の付いていない page の要求を明示の理由で止める。回帰のテスト）、CC-068（共通の部品と型つきの組み立てで 15 関数を置き換え、ログインの form と候補の発見を isolated world へ移す。要素の橋渡しは実装の前に調査）を書いた。 | 作業 F |
| 2026-10-15 | T32a（DEF-110-fix）の報告 | 4.6 の「Context がもう存在しないことの確かめ」は、Guard がその Context の `close` の事象を見たこと（`isGuardedContextGone`）とした。Browser の接続は Browser 全体の状態で Context ごとの証しとして間接的なため使わない。headless shell だけの別の形の reject（DEF-112）は記録だけ。 | `src/safety/passive-request-guard.ts` |
| 2026-10-15 | ユーザーの承認 | 「Task 32の設計を承認する」。 | Task 32 |
| 2026-10-15 | T32j-3 の報告とユーザーの判断 11 | 4.4 の CC-068 の 2 に、要素の橋渡しの設計（ログインは isolated world で探し直す、候補は backendNodeId と xpath の Locator、橋を 1 か所にして DEF-114 を直す）と、読めないセレクタを設定の検証で拒むことを書いた。 | T32j-4 |
| 2026-10-15 | T32j-1 の報告 | CC-050 は `decideGuardRequest`（層 CDP_REQUEST・CDP_DOCUMENT・ROUTE と段階から、動作と記録を決める）と `recordGuardVerdictBeforeBlock` にした。route の役割は「CDP の付いていない page の網と、キャッシュの返し」。DEF-113 の明示の理由は既存の違反 `PASSIVE_GUARD_PAGE_NOT_READY`（新しいコードは足さない）。取り付けの途中の段階の誤りで Document の層も Context を無効にする（fail-closed の側）。 | `src/safety/passive-request-guard.ts` |
| 2026-10-15 | T32g の Blocker（報告の確かめの結果の置き場所がない） | 4.1 に、管理データの版 10 で `jobs` に確かめの結果の列を足すことを書いた（案 A）。版 9 の写しを固定してから作る。 | `src/control/store/migrations.ts`、`src/control/job/` |
| 2026-10-15 | T32k の Blocker（`closePassivePage`・`closePassiveGuardedPage` を約 30 件のテストが使い、`closePassiveGuardedPage` は Guard の `ownerClosingPages` の唯一の書き手） | 4.7 の「消すか残すか」は、残す（案 B）と決めた。本番から呼ばないことは今の Gate `semantic-ownership` が守る。消すと Guard の分岐の削除と約 30 件のテストの書き換えが要り、最後の判定の前に安全の境界を広く動かす危険が大きい。 | なし |
| 2026-10-15 | T32R・T32R2 と直し | I-1: 要素の橋の確かめを合図の事象の方式にした（`src/browser/element-path-engine.ts`、`isolated-read.ts` の `withSignaledElements`）。キーボードの入力は focus のある要素に入る既知の限界を `safety.md` に。M-2: 親は書き込みのバンドルを組み立て直してバイト列で照らす（組み立ての部品は `src/core/deterministic-zip.ts`・`action-bundle-bytes.ts`・`artifact-json.ts` に移した。4.1 の `src/report/deterministic-zip.ts` は読み替える）。台帳の UPDATE の回数は送った回だけ。 | `src/browser/`、`src/discovery/`、`src/core/`、`src/control/job/write-report-check.ts` |
| 2026-10-15 | G32 の fixture の部分 | T32R3 承認、`verify:all` 1 回（揺らぎ 1、後退 4 は直して単独で PASS）の後、ユーザーが「承認するが、実環境は後日」。実テスト環境のログインは同じ Origin のフォームの送信。 | 作業 I は後日 |
| 2026-10-15 | ユーザーの指摘（証明書と隔離の証跡は事前に分からない、隔離を確かめるための監査でもある） | 4.9 を読み替えた（証明書は最初の Run で分かる、読み取りの段は隔離が未確認でも始め、未確認の参照を記録し、外部のつながりを観察する。裏側の隔離は未検証、書き込みの前に判断）。手順書を直す。 | `doc/spec/real-test-environment.md` |
| 2026-10-16 | 実テスト環境の確かめと G32 の締め | 本来の監査対象のサイトのテスト環境のログインは、画面の中のスクリプトが外部の認証のサービスの token の送信先へ送る形で、BeakSight のログインの段（登録した送信先へのフォームの送信だけを通す）が扱わない。Guard が止め、サイトへは届かなかった。ユーザーの判断「A。一旦G32を締めよう」により、ログインが要る段（認証つきの監査、自動ログイン、発見と READ、書き込み、裏側の隔離）を「未検証」として G32 を締めた。スクリプトで送るログインへの対応（と API で書き込むサイトへの対応）は、ロードマップの外の次の開発の候補。 | なし |
