# BeakSight Task 24 既存の公開監査を管理画面から動かす 設計書

作成日: 2026-10-09
状態: 承認済み（2026-10-09 のユーザーの指示「このロードマップ上の開発作業は全て承認済として進めて」による）。G24 完了（2026-10-10。同じ指示により承認済みとして閉じた）
対象範囲: CLI と同じ公開監査（`PUBLIC_PASSIVE`）を、ローカルの管理画面から開始・進捗の表示・停止・結果の閲覧ができるようにする。ジョブの管理、ワーカーのプロセス、型つきの IPC、成果物の安全な取り出し

## 1. 目的

- ロードマップの Task 24 を実現する。G24: 「Task 21 の公開監査を CLI でも UI でも実行でき、挙動と安全性が保持されている」。この段階で、UI つきの公開監査の道具として使える。認証と書き込みは引き続き拒否する。
- 根拠の事実: 作業記録の「T24 調査」の行（`progress.md`）。

## 2. 根拠となる文書と優先順位

- ロードマップ（4 章、13 章、15 章、Task 24 の章）、Task 22・23 の設計書、負荷の制御の設計（`NavigationPacer`、`crawl.minNavigationIntervalMs`）、再開の設計（ロック、保存、`decideRunResumption`）。
- **ロードマップの置き場所の読み替え**: ロードマップ 4.2 は `src/control/worker-entry.ts` を挙げるが、`src/control/` は Playwright と `src/orchestration/` に届いてはいけない（Task 22 の Gate `control-boundary.test.ts` の (b)）。ワーカーは Playwright を使う監査を動かすので、`src/worker/`（新設）に置く。`src/control/` は、ワーカーのファイルのパスで子のプロセスを起動するだけで、ワーカーを import しない。
- 守る不変条件: I02（公開監査の挙動を変えない）、I08（画面の操作は権限の十分条件ではない。開始の直前にサーバで検証し直す）、I15（Run の状態を都合よく書き換えない）、I16（実サイトに接続しない。テストは 127.0.0.1 の fixture だけ）、負荷の決まり（ユーザー: 短時間に大量の要求を送らない）。

## 3. 採用する設計

```text
[画面（ブラウザ）] --127.0.0.1--> [画面のサーバ（Node。apps/local-ui）]
                                     └ Server Functions（開始・停止・一覧・詳細）、成果物の Server Routes（GET）
                                         └ ジョブの管理（src/control/job/。SQLite の表。同時に 1 つだけ）
                                              └ child_process.fork（IPC。detached にしない）
                                                   └ ワーカー（src/worker/audit-worker.ts。dist から動かす）
                                                        └ 監査の中核（src/cli/ から切り出した型つきの関数）
                                                             └ 既存の RunCoordinator、Guard、ArtifactWriter（変更なし）
```

- **同時に動かすジョブは、全体で 1 つだけ**（負荷の決まり。2 つ並べると pacer が別々になり、負荷が 2 倍になるため）。SQLite のトランザクション（`withWriteTransaction`）で原子的に確かめて予約する。
- **画面から変えられるのは「新しく始めるか（`--new` に当たる）」だけ**。設定の上書き（とくに `crawl` の間隔と上限）は受けない。ワーカーは、CLI の `--headless` に当たる上書きだけを常に付ける（画面のサーバからブラウザのウィンドウを開かない）。
- **ワーカーは detached にしない**。画面のサーバが落ちたら、ワーカーも終わる（Windows の既定の振る舞い。調査で確かめた）。残った保存とロックは、既存の仕組みで古いものと判定され、次の開始で再開される。画面のサーバは、起動のときに、終わっていないジョブの行を「中断」に直す（4.4）。

### 採用しなかった案

- **detached のワーカー（サーバが落ちても続く）**: IPC が切れ、状態を DB とファイルからしか戻せない。止める手段と後始末が複雑になる。ロードマップの「サーバ自身が落ちた場合は中断・ロック・再開可否を正確に判定」は、既存の再開の仕組みで満たせる。
- **画面のサーバの process の中で監査を動かす**: Playwright と監査の部品を画面のサーバに読み込むことになり、Task 23 の Gate（画面は Playwright と `src/orchestration` に届かない）に反する。長い処理で画面のサーバを止める。

## 4. 詳細設計

### 4.1 監査の中核の切り出し（`src/cli/`）

- `runAuditCommand` を、次の 2 つに分ける。
  - **中核**（例 `executeAuditRun(config, dependencies, options, observer)`）: 今の ①〜⑥ の段（実行中の Run の確かめ、再開する Run の選択、保存のセッション、`RunCoordinator`、最後の書き出し、保存の終わり方）を行い、**型つきの結果**を返す。結果の例: `{ kind（RAN / RUN_ACTIVE / RESUME_UNAVAILABLE / CONFIG_MISMATCH / VERSION_MISMATCH など、今の分岐の閉じた一覧）, runId, runDirectory, runStatus, exitCode, resumeDecision }`。観測の口 `observer`: `onRunStarted(runId, runDirectory, resumeDecision)`、`onProgress(RunProgressReport)`、`onNotice(RunNotice)`、`onFinished(result)`。
  - **CLI の表示**: 中核を呼び、今の日本語の行を、今と同じ順と内容で出す。**CLI の標準出力・標準エラー・終了コードは、1 文字も変えない**（既存のテストと、新しい比べるテストで確かめる）。
- 例外から終了コードへの変換（`main.ts` の `ConfigError` → 4、`ArtifactWriteError` と予期しない例外 → 1）を、中核と CLI とワーカーで共用できる 1 つの関数にする。
- `loadConfig` と出力先の `resolve` が `process.cwd()` に依存する点は変えない。ワーカーは cwd をリポジトリの root にして起動する。

### 4.2 ワーカー（`src/worker/`、新設）

- `src/worker/audit-worker.ts`（入口。`dist/worker/audit-worker.js` で動かす）: 親から IPC で `START` を受け、設定を `loadConfig`（`--headless` に当たる上書きだけ）で読み、中核を呼ぶ。観測の口の値を IPC で親へ送る。`STOP` を受けたら、中核に渡した `AbortController` の `abort()` を呼ぶ（CLI の Ctrl+C の 1 回目と同じ止まり方）。2 回目の `STOP`（強制）は、CLI の 2 回目と同じく終了コード 5 で終える。
- Windows のコンソールの Ctrl+C（同じコンソールの子も受ける）: ワーカーは、CLI と同じシグナルの受け手（`createInterruptHandler`）を登録する（1 回目は止める印、2 回目は終了コード 5）。
- 生きている合図（`HEARTBEAT`）を、名前つきの間隔で親へ送る。
- 標準出力と標準エラーは、画面では読まない（文の解析をしない）。ワーカーは CLI の表示を使わない。
- 親が IPC を切ったら（画面のサーバが終わった）、止める印を立てて終える。

### 4.3 IPC の契約（`src/control/worker-protocol.ts`、`schemas/control/worker-message.schema.json`）

- 版つき（`beaksight-worker-message/1`）。親 → 子: `START`（`jobId`、設定ファイルのパス（`isAcceptedTargetConfigPath` を通ったもの）、`startNew`）、`STOP`（`force` の真偽）。子 → 親: `READY`、`RUN_STARTED`（`runId`、出力先の中の Run のディレクトリの相対パス、再開の判断）、`PROGRESS`（`RunProgressReport` と同じ項目）、`NOTICE`（`RunNotice` と同じ項目）、`HEARTBEAT`、`FINISHED`（中核の結果）、`FAILED`（理由の値と、利用者に見せない英語の詳細）。
- 双方とも、受けた値をスキーマで検証してから使う。形の違う値を受けたら、その相手を信用しない（親は子を止めてジョブを失敗にする。子は止める）。
- **Gate の例外**: `src/worker/` は、`src/control/worker-protocol.ts`、`src/control/control-schema-validator.ts`、`src/control/contracts.ts`（と、それらが届く `src/core/`）だけを import してよい。`src/control/store/`、`src/control/job/` には届かない。`src/control/` は `src/worker/` を import しない（ファイルのパスの文字列で起動するだけ）。`control-boundary.test.ts` と新しい Gate で確かめる。

### 4.4 ジョブの管理（`src/control/job/`、新設）

- **表（管理データの版 2 の移行）**: `jobs`（`job_id`、`profile_id`、`profile_revision`、`state`（`STARTING` / `RUNNING` / `STOPPING` / `FINISHED` / `FAILED` / `INTERRUPTED`）、`start_new`、`run_id`、`run_directory`（出力先の中の相対）、`exit_code`、`run_status`、`end_kind`、`last_progress`（JSON）、`worker_pid`、`created_at`、`started_at`、`finished_at`、`last_heartbeat_at`、`failure_reason`）。版 1 は公開済み（Task 23）なので変えず、版 2 を足す。
- **開始**（`startAuditJob(profileId, expectedRevision, startNew)`）:
  1. プロファイルを読み、`ACTIVE`、改訂の一致、**今実行できるモード**（`PUBLIC_PASSIVE` だけ。一覧の owner を `src/control/` に置き、画面の表示の部品から移す。T23R の M5）を確かめる。ターゲット設定を読み直して `validateSiteProfile` を通す（I08）。
  2. `withWriteTransaction` の中で、終わっていないジョブ（`STARTING` / `RUNNING` / `STOPPING`）がないことを確かめ、新しいジョブを `STARTING` で作る（同時に 1 つ。2 つ目は理由の値で拒否）。
  3. ワーカーを `fork` する（`dist/worker/audit-worker.js`、cwd はリポジトリの root、`execArgv` は既定、`detached: false`、標準入出力は捨てるか、ログのファイルにだけ書く）。`START` を送る。
- **IPC の処理**: `RUN_STARTED` で `run_id` と `run_directory` と `RUNNING` を記録する。`PROGRESS` は最後の値だけを記録する（書き込みの回数を抑えるため、名前つきの最短の間隔で間引いてよい）。`FINISHED` で結果を記録し `FINISHED`（終了コードと `runStatus` は中核の結果をそのまま。I15）。子が `FAILED` を送るか、`FINISHED` の前に終わったら `FAILED` か `INTERRUPTED`（理由の値つき）。
- **停止**（`stopAuditJob(jobId)`）: `STOP` を送り、`STOPPING` にする。名前つきの時間の後も終わらなければ、画面に「強制的に止める」を出し、利用者の 2 回目の操作で `STOP`（`force`）を送る。さらに名前つきの時間の後も終わらなければ、子を kill する（Chromium は子と一緒に消える。調査で確かめた）。
- **見張り**: `HEARTBEAT` が名前つきの時間より長く来なければ、子を止めて `INTERRUPTED`（`WORKER_UNRESPONSIVE`）。
- **画面のサーバの起動のとき**: 終わっていないジョブの行を `INTERRUPTED`（`SERVER_RESTARTED`）に直す（前の画面のサーバが落ち、子も終わっているため）。その Run の保存とロックは既存の仕組みに任せ、画面は「同じプロファイルをもう一度開始すると、続きから再開します」と案内する。
- **画面のサーバの終わり（Ctrl+C）**: 動いているジョブがあれば `STOP` を送り、名前つきの時間だけ終わりを待ってから終える（コンソールの Ctrl+C は子にも届くので、子は自分でも止まり始める）。2 回目の Ctrl+C で待たずに終える。
- **CLI との同時の実行**: CLI と画面のジョブが同じ出力先に同時に始めると、既存の `findActiveRun` の隙間（DEF-057）で 2 つの Run が並びうる。4.6 で直す。

### 4.5 成果物の取り出し（Server Routes、GET）

- 対象は、ジョブの行に記録した Run のディレクトリの中の、**許可の一覧のファイルだけ**: `run.json`、`audit.json`、`report.html`、バンドルの ZIP（`isBundleFileName`）、`run.json` と `audit.json` が参照するスクリーンショットなどの相対パス。それ以外は 404。
- パスは、強めた `isPortableRelativeArtifactPath`（4.7、DEF-056）を通し、`lstat` でリンク（symlink、junction）を拒み、実際のパスが Run のディレクトリの中にあることを確かめてから読む（リンクをたどらない読み取りの部品を `src/core/` に 1 つ作る。既存の非公開の `listRealDirectory` などと同じ意味なら、共用の形にする）。
- `report.html` は、画面の CSP とは別の、**script を動かさない CSP**（`sandbox`、`default-src 'none'`、`img-src 'self' data:`、レポートが要る `style-src`）と `X-Content-Type-Options: nosniff` で返す。ZIP と JSON は `Content-Disposition: attachment`。
- 守りの部品（Host、`localAddress`、cookie）はそのまま掛かる。CSRF は GET なので掛からないが、読むだけ。

### 4.6 DEF-057 開始の隙間（既存の不具合の修正）

- 今: `findActiveRun` で実行中の Run がないことを確かめてから、`RunCoordinator` が Run のディレクトリとロックを作るまでの間に、2 つ目が確かめを通れる（秒が違えば 2 つの Run が並ぶ）。
- 直し: 出力先ごとの「開始のロック」（出力先の中の決まった名前のファイルを `wx` で作り、開始の段（確かめ〜Run のディレクトリとロックの作成）の間だけ持つ）を足す。持てなければ、今の「実行中の Run がある」と同じ扱い（CLI は同じ終了コードと文）。古い開始のロック（持ち主の process が死んでいる、名前つきの時間を過ぎた）は、既存の `judgeRunLock` と同じ考えで判定する。CLI の標準出力・終了コードは、二重の起動の場面以外では変わらない。

### 4.7 DEF-056 `isPortableRelativeArtifactPath` の強化（既存の不具合の修正）

- Windows で別の意味になる名前を拒む: `:` を含む（代替データストリーム）、末尾の点と空白、デバイス名（`CON`、`PRN`、`AUX`、`NUL`、`COM1`〜`COM9`、`LPT1`〜`LPT9`。拡張子つきも）、制御文字。これは共通部品（`src/core/artifact-layout.ts`）の 1 か所で直す。BeakSight が書く名前（Run の ID、ページの ID、決まったファイル名）は、どれも当たらないことをテストで確かめる。

### 4.8 画面（`apps/local-ui/`）

| 画面 | 内容 |
| --- | --- |
| プロファイルの一覧 | 「最後の Run」の欄に、最後のジョブの状態と Run の状態。実行できるプロファイルに「監査を始める」 |
| 監査の開始 | プロファイル、ターゲット設定の要点（開始の URL、ページの上限、時間の上限、ページの間隔（`crawl.minNavigationIntervalMs`）。読むだけで、変えられない）、「前回の続きから再開する／新しく始める」の選択、開始のボタン。実行できないモードや取り消したプロファイルは、理由を出して開始できない |
| 進捗 | 状態、終えたページ数／見つけたページ数／上限、経過の時間、要求の数と 1 分あたりの最大（既存の書式 `formatRequestsWithPeak` など）、知らせ（サイトの不調の確かめ直し、減速）、停止のボタン（確認のダイアログ）、強制的に止めるボタン（停止の後、名前つきの時間が過ぎたら） |
| ジョブの一覧と詳細 | 状態、Run の ID、Run の状態（COMPLETE / PARTIAL / FAILED など。表示は既存のカタログ）、終わり方、開始と終わりの日時、成果物（レポートを開く、JSON、ZIP のダウンロード） |

- 進捗の取得は TanStack Query のポーリング（名前つきの間隔。既定 2 秒）。監査対象には何も送らない。画面を閉じてもジョブは続き、開き直すと同じ状態が出る。
- 表示の語と文言は `src/presentation/` に足す。Run の状態などのラベルは既存のカタログ（`RUN_STATUS_CATALOG` など）を使う。結果の集計を画面で作り直さない（`run.json` の値をそのまま出し、詳しくはレポートを開く）。

### 4.9 スクリプト

- `npm run ui` は、`npm run build`（監査の本体の `dist`。ワーカーが使う）と `npm run build:ui` の後に起動する（今は `build:ui` だけで、`dist` が古い危険がある）。

## 5. SSOT と安全性への影響

| 項目 | owner | 扱い |
| --- | --- | --- |
| 監査の実行 | `RunCoordinator` と、切り出した中核（`src/cli/`） | 中核を CLI とワーカーで共用。新しい実行の経路を作らない |
| 負荷（間隔、上限） | 設定と `NavigationPacer` | 変更なし。画面から変えられない。同時に 1 ジョブ |
| 止める印 | `AbortController`、`createInterruptHandler` | 共用 |
| ロックと再開 | `run-checkpoint.ts` | 変更なし（DEF-057 の開始のロックを足す） |
| 今実行できるモード | `src/control/`（新しい置き場所） | 画面の表示の部品から移す |
| IPC の契約 | `src/control/worker-protocol.ts` | 新設。唯一の owner |
| ジョブ | `src/control/job/` | 新設。唯一の owner |
| 成果物のパス | `src/core/artifact-layout.ts` | 強化（DEF-056）。リンクをたどらない読み取りの部品を足す |

## 6. 共通部品

- 新設: 監査の中核（`src/cli/` の中）、例外から終了コードへの変換、ワーカー、IPC の契約とスキーマ、ジョブの管理、リンクをたどらない成果物の読み取り、開始のロック。
- 後の Task で使う見込み: ジョブの管理とワーカーは、Task 25 以降の認証つきの監査と、Task 27 以降の ActionRun でも使う（ActionRun は別の状態機械だが、ジョブの起動と IPC の部品は共用する）。

## 7. テスト設計

- 中核の切り出し: 既存の CLI のテスト（`cli-*`、`fixture-full-crawl`、再開）が変えずに PASS する。fixture の監査を、切り出す前と後で CLI の標準出力・終了コード・成果物の形で比べる。
- ワーカーと IPC: 契約のスキーマと型の一致、形の違う値の拒否、`STOP` で止まる（PARTIAL、`STOPPED_BY_SIGNAL`）、強制の `STOP`、親の切断で止まる、見張り。
- ジョブ: 同時に 1 つ（2 つの開始を同時に送って、片方だけが成功）、開始の直前の検証し直し（取り消したプロファイル、改訂の不一致、実行できないモード、ターゲット設定の変化）、起動のときの中断への直し。
- **CLI と画面の比べ**: 同じ fixture のサイトと設定で、CLI と画面のジョブの両方で監査し、`run.json`・`audit.json` のスキーマの検証、Run の状態、ページの結果、Safety Ledger（違反 0、サーバに届いた要求が GET と HEAD だけ）が同じであることを確かめる（時刻などの値は除く）。
- 画面を閉じてもジョブが続き、開き直すと状態が出る。画面のサーバを強制終了 → ワーカーと Chromium が残らない → 起動し直すとジョブが `INTERRUPTED` → もう一度開始すると続きから再開する。
- 成果物: 許可の一覧の外は 404、`..`・符号化・リンク・Windows の別名・デバイス名の拒否、`report.html` の CSP（script が動かない）。
- DEF-056、DEF-057 の RED と GREEN。
- 画面: 開始、進捗、停止、一覧、詳細、成果物（Playwright headless、127.0.0.1、外部への要求 0、CSP の違反 0）。
- 負荷: 画面のポーリングの間も、fixture のサーバに届く要求の間隔が設定の間隔以上である（既存の pacing のテストの考え方）。

## 8. 対象ファイル

`src/cli/run-command.ts`・`main.ts`（中核の切り出し）、`src/worker/**`（新規）、`src/control/worker-protocol.ts`・`job/**`（新規）、`src/control/store/migrations.ts`（版 2）、`schemas/control/worker-message.schema.json`、`src/core/artifact-layout.ts`（DEF-056 とリンクをたどらない読み取り）、`src/orchestration/` または `src/cli/`（DEF-057 の開始のロック。置き場所は実装で owner に合わせる）、`src/presentation/`、`apps/local-ui/**`、`tests/**`、`package.json`（`ui` のスクリプト）、`doc/spec/local-ui.md`、`doc/spec/cli.md`（二重の起動の扱いが変わる場合）。

## 9. 対象外

- CLI で始めた Run の一覧の画面（出力先のディレクトリの走査）。この Task ではジョブとして始めたものだけを出す。
- 認証つきの監査（Task 25 以降）、書き込み（Task 27 以降）。
- detached のワーカー、複数のジョブの同時の実行、画面からの設定の上書き。
- 予約の実行、通知（ロードマップにない）。

## 10. 完了条件（G24）

- [ ] 画面から公開監査を開始・進捗の表示・停止・結果の閲覧ができる。CLI の振る舞い（標準出力、終了コード、成果物）は変わらない。
- [ ] CLI と画面で、同じ入力に同じスキーマの結果が出て、Safety Ledger の違反が 0。
- [ ] 同時に 1 ジョブ、二重の起動の拒否、画面のサーバが落ちたときの中断と再開、止める・強制的に止める・見張り。
- [ ] 成果物は許可の一覧とリンクをたどらない読み取りだけで取り出す。
- [ ] DEF-056、DEF-057 が直っている。
- [ ] `npm run verify:all` が通しで PASS。独立レビューで Critical 0、Important 0。
- [ ] 実サイトへの接続なし。認証と書き込みは拒否のまま。

## 11. 設計変更履歴

| 日付 | 契機 | 変更内容 | 影響範囲 |
| --- | --- | --- | --- |
| 2026-10-09 | 初版（Task 24。T24 調査） | ワーカーの置き場所を `src/worker/` にする（ロードマップ 4.2 の読み替え）、同時に 1 ジョブ、detached にしない、DEF-056 と DEF-057 を含める | Task 24 |
| 2026-10-09 | T24a の報告 | 4.1 を実装に合わせる: 中核は `src/cli/audit-run.ts` の `executeAuditRun`。結果の種類は `RAN`・`RUN_ACTIVE`・`VERSION_MISMATCH`・`RUN_DIRECTORY_UNAVAILABLE`・`RESUME_UNAVAILABLE`（設定の違いは結果にせず、開始の知らせ `CONFIG_DIFFERS`）。観測の口は `onRunStarting`・`onRunStarted`・`onProgress`・`onNotice`（`onFinished` は作らない）。例外から終了コードへの変換は `src/cli/failure.ts` の `classifyCliFailure` | T24c、T24d |
| 2026-10-09 | T24d の報告 | 4.3 の Gate の例外に足す: ワーカーの入口（`src/worker/audit-worker.ts`、`audit-worker-session.ts`）は、CLI と同じく設定を読む入口なので、GATE-ARCH02（`loadConfig` を呼べるのは入口だけ）の例外とする。契約の `FINISHED.outcome.runId` が `null` でよいのは `RUN_ACTIVE`（T24c の開始のロックで、実行中の Run の ID がない場合）のときだけ。`src/control/` は `src/cli/` を読めないので、結果の種類などの一覧の写しを契約の側に持ち、ずれは型とテストで検出する | T24e |
| 2026-10-09 | T24e の報告 | 4.4 を実装に合わせる: `jobs` に `last_notice`、`stop_requested_at` を足し、一意の部分索引で終わっていないジョブを全体で 1 行までにする。ワーカーの標準入出力は捨てる（ログのファイルは作らない）。`execArgv` は空（画面のサーバの引数を引き継がない）。読むだけの入口 `withReadTransaction` を管理データの部品（`transaction.ts`）に足し、ジョブの読み取りはそれを使う（`PRAGMA query_only` で書き込みを止める） | T24e round 1、T24f |
| 2026-10-09 | T24f の報告 | 4.5 の成果物の CSP を `sandbox allow-same-origin; default-src 'none'; img-src 'self' data:; style-src 'sha256-<レポートの style>'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'` にする（`sandbox` だけでは文書の origin が null になり、`SameSite=Strict` の cookie が相対のリンクに付かない。`allow-scripts` は付けないので script は動かない。両方の Chromium で確かめた）。許可の一覧に、レポートがリンクする `audit.json` のページの `page.json` と `visible-text.txt` を含める | T24g、T24R |
| 2026-10-09 | T24R の C1（DEF-061）と T24h-3 の申し送り | 画面のサーバ（ジョブの管理）は同時に 1 つだけ。管理のロックは、管理データ（SQLite）の版 2 の表の 1 行（持ち主の PID、OS の起動の時刻、取った時刻、ハートビート。`RunLock` と同じ項目）で持ち、`createAuditJobManager` の中で、`recoverInterruptedJobs` の前に `withWriteTransaction` の中で取る（古さの判定は `src/core/process-lock.ts` の `judgeRunLock`）。取れなければ管理を作らず、画面のサーバは日本語の説明で起動を止める。ロックの判定と原子的な取り直しの部品は `src/core/` へ移した（T24h-3） | T24h-4 |
