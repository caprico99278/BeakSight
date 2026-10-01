# BeakSight 中断した Run の再開 設計書

作成日: 2026-10-01
状態: ユーザー承認済み（2026-10-01。自動の再開、1回の起動ごとの時間の上限、Ctrl+C の振る舞い）
対象範囲: 監査（Run）が途中で中断した場合に、再び起動したとき、最初からではなく途中から続けられるようにする仕組み。

## 1. 目的

### 1.1 ユーザーの指示（2026-10-01）

> 監査途中で中断した場合、再起動時は監査の最初からではなく、途中から再開できるようにすること

負荷の制御（`2026-10-01-beaksight-site-load-control-design.md`）の後は、ページの読み込みの間隔が5秒以上になり、1ページの監査に2分以上かかることがある。本来の監査対象のサイトの full audit は、何時間もかかる。途中で止まった場合に最初からやり直すと、同じページを再び読み込み、サイトに余計な負荷をかける。

### 1.2 今の作り（読み取り専用の調査で確かめた事実）

- Run の途中で書くファイルは、スクリーンショットだけである。`page.json`、`run.json`、`audit.json`、`report.html`、バンドルは、Run の最後にまとめて書く（`src/report/artifact-writer.ts:293-301, 325-332`）。中断した Run には、読み戻せるページの結果がない。
- 途中の状態の多くはメモリにしかない。
  - 巡回の待ち行列と URL ごとの記録（`src/orchestration/crawl-frontier.ts`。Map と、`CrawlQueue` の配列と Set）。状態を戻す口がない。
  - ID の採番器（`src/orchestration/id-allocator.ts`。ページ、Evidence、Finding の非公開の連番）。連番を設定する口がない。
  - Safety Ledger（Context ごと。クラスの非公開の項目）。`snapshot()` の結果は JSON にできる（`src/safety/safety-ledger.ts:263-292`）。
  - `RunProgress` の理由、再試行の記録、各フラグ（違反の検出など）と、`#crawl` のローカル変数の `pagesStarted`・`limitReason`（`src/orchestration/run-coordinator.ts:206-246, 511-512`）。
  - Run の ID、開始の時刻、環境の記録（`run-coordinator.ts:341-344, 404-419`）。
- Run のディレクトリは排他的に作る。すでにあれば Run を始めない（DEF-009。`src/core/artifact-layout.ts:106-109`）。
- シグナルを扱う処理は `src/` にない。Playwright が既定で SIGINT・SIGTERM・SIGHUP の処理を登録し、SIGINT では Browser を閉じて `process.exit(130)` で終える。このとき最後の処理（出力の書き出し）は行われない。
- ファイルを書けるのは `ArtifactWriter` だけである（ARCH08。例外はスクリーンショットと PREFLIGHT）。`validateArtifact` を呼べるのは PREFLIGHT、Run Coordinator、ArtifactWriter だけである。スキーマの名前は4つに閉じている（`src/core/schema-validator.ts:4`）。

### 1.3 この設計で解決すること

- ページの監査が1つ終わるたびに、続きから再開するために必要な状態を、Run のディレクトリに保存する。
- 中断した Run は、同じ設定で起動し直すと、自動で続きから監査する。終わったページは監査し直さない。
- 端末（PC）の再起動、停電、端末のウィンドウを閉じた場合の中断にも対応する。保存は電源が切れても壊れにくい書き方にし、古いロックを確実に見分ける。
- 再開した Run の最終の出力は、中断しなかった場合と同じになる（時刻と、実行の記録を除く）。
- Ctrl+C などで止めた場合は、今のページを終えてから止まり、その時点の結果をレポートとして書き出す。

### 1.4 ユーザーの判断（2026-10-01）

- 再開の始め方: 「端末を再起動した場合の中断にも対応できるなら自動で再開がいい」。端末の再起動への対応（4.3、4.4）を前提に、自動で再開する（4.7）。新しく始める場合は `--new` を付ける。
- 実行時間の上限: 1回の起動ごと（4.6）。
- Ctrl+C: 1回目は今のページを終えてから止めてレポートを書く。2回目はすぐに止める（終了コード 5）。

## 2. 根拠となる文書と優先順位

- 従う文書: `2026-08-27-beaksight-implementation-tasks.md`、`2026-08-27-beaksight-implementation-plan.md`、`2026-08-27-beaksight-web-audit-design.md`、`2026-09-23-beaksight-task-14-17-pipeline-report-cli-design.md`（5.6 Run の流れ、DEF-009 の追補）、`2026-09-23-beaksight-ui-ssot-design.md`、`2026-10-01-beaksight-site-load-control-design.md`。
- この設計書が拡張・置き換える箇所:
  - Task 14〜17 の設計書 5.6 の「Run のディレクトリを排他的に作る」は、新しい Run では今のまま守る。再開のときは、既存のディレクトリを、ロックのファイル（4.4）で排他的に使う。
  - `crawl.maxRuntimeMs` の意味を、「Run 全体の実行時間の上限」から「1回の実行（起動）ごとの上限」に変える（4.6）。
  - CLI の終了コードの表（`src/cli/exit-codes.ts`）に、5（中断。最後の処理をしていない）を加える（4.7）。
  - スキーマの名前の閉じた一覧に、`checkpoint` を加える（4.2）。
- 引き続き守る不変条件:
  - 違反の後は、新しい監査を始めない（Task 19 の前の整理の設計書 4.5）。再開でも同じ。
  - 完了の正直さ。中断した Run を `COMPLETE` にしない。監査しなかった URL は、理由付きの SKIPPED にする。
  - ファイルを書くのは `ArtifactWriter` だけ（ARCH08）。
  - Run Status を決めるのは `deriveRunStatus` だけ（ARCH05）。
  - Target Isolation。

## 3. 採用する設計

### 3.1 全体の流れ

```text
新しい Run:   run --config <設定>
  開始 → PREFLIGHT → 環境 → robots/sitemap → [保存] → ページ1 → [保存] → ページ2 → [保存] → … → 最後の処理 → 出力
                                                                    ↑ ここで中断（プロセスの終了、Ctrl+C）

再開:         run --config <設定>        （同じ設定の途中の Run が出力先にあれば、自動で再開する）
  保存を読む → 設定と版を確かめる → 環境 → 途中のページから続ける → [保存] → … → 最後の処理 → 出力（全ページ）

新しく始める: run --config <設定> --new  （途中の Run があっても、新しい Run を始める）
```

- 保存（チェックポイント）は、ページの監査が1つ終わるたびに行う。保存の単位は「終わったページ」である。監査の途中のページは保存しない。再開のときは、そのページを最初から監査し直す。
- 再開は、Run の ID と Run のディレクトリをそのまま使う。最後の処理（Cross-page rule、Run Status、出力の書き出し）は、保存したページと、再開の後に監査したページの全部で行う。

### 3.2 再開できる場合とできない場合

| 前の回の終わり方 | 保存の状態 | 起動し直したときの扱い |
| --- | --- | --- |
| プロセスが途中で終わった（強制終了、停電、2回目の Ctrl+C など） | `IN_PROGRESS` | 続きから監査する |
| Ctrl+C などで止めた（今のページを終えてから止まった） | `STOPPED` | 続きから監査する。理由 `RUN_INTERRUPTED` の SKIPPED の URL を、監査の待ち行列に戻す |
| 実行時間の上限（1回の実行ごと）に達した | `STOPPED` | 続きから監査する。理由 `MAX_RUNTIME_REACHED` の SKIPPED の URL を、監査の待ち行列に戻す |
| 違反を検出した | `FINISHED` または `IN_PROGRESS` | 新しいページを始めない。`IN_PROGRESS` なら、最後の処理だけを行い、`ABORTED_BY_SAFETY` の出力を書く。`FINISHED` なら、何もせずに終える |
| `COMPLETE`、ページ数・深さの上限による `PARTIAL`、`FAILED` で終わった | `FINISHED` | 再開の対象にしない（新しい Run を始める） |

- ページ数の上限（`maxPages`）による `PARTIAL` は、利用者が選んだ範囲で終わったので、再開の対象にしない。範囲を広げたい場合は、新しい Run を始める。
- 次の2つの場合は、保存の状態を変えない（`state.json` は、最後に書けた保存のまま残り、次の起動で、そこから再開する。4.3.2）。
  - 実行の途中で、保存に失敗した（`CHECKPOINT_WRITE_FAILED`）。
  - 再開した実行で、PREFLIGHT に失敗した（サイトに一時的につながらないなどで、それまでの監査を失わないため）。
- ただし、違反を検出した Run は、上の2つの場合も含めて、必ず `FINISHED` にする（5章）。

### 3.3 採らなかった案

- **出力（`page.json` など）を途中で書き、それを読み戻す案**: 出力には、深さ、待ち行列の順、Ledger、各フラグ、再試行の前の Evidence の対応などが含まれていない。出力の形を変えずに、再開の材料を別に保存する。
- **`--resume` を明示したときだけ再開する案**: 利用者が新しい Run を始めたつもりで古い Run を続けてしまうことは防げるが、端末の再起動の後に同じコマンドを実行すると、最初からやり直しになり、サイトに余計な負荷をかける。ユーザーの判断（1.4）により、自動で再開する。再開するときは、その旨と、新しく始める方法（`--new`）を必ず示す。
- **再開のときに設定の変更を許す案**: 途中で設定が変わると、ページごとの結果の比べ方が崩れる。設定は完全に同じでなければ再開しない。

## 4. 詳細設計

### 4.1 保存するもの

保存の場所は `<Run のディレクトリ>/checkpoint/` とする。

| ファイル | 中身 | 書く時期 |
| --- | --- | --- |
| `checkpoint/state.json` | 下の「Run の状態」 | robots/sitemap の取得の後と、ページの監査が1つ終わるたびに、置き換える |
| `checkpoint/state.prev.json` | 1つ前の `state.json` | `state.json` を置き換える前に、今の `state.json` をこの名前に移す |
| `checkpoint/pages/<pageId>.json` | そのページの結果（最終の試行の結果と、再試行の前の試行の Evidence の対応） | そのページの監査が終わったときに1回だけ |
| `checkpoint/run.lock` | ロック（4.4） | Run の開始と再開のとき。1分ごとに時刻を更新する |

Run の状態（`state.json`）:

- 保存の形式の版（`checkpoint-schema/1.0`）、保存の状態（`IN_PROGRESS`、`STOPPED`、`FINISHED`）
- Run の ID、BeakSight の版、最初の実行の開始の時刻
- 保存の時刻（`savedAt`。その `state.json` を作った時刻。プロセスが途中で終わった実行の、終わりの時刻に使う。4.8）
- 実効の設定（`effectiveConfig` の全体）
- 実行の記録の一覧（4.8）。各実行の開始と終わりの時刻、終わり方、環境（Node、Playwright、Chromium の版、User-Agent）
- 巡回の記録: 発見の順の URL ごとの記録（URL、深さ、ページの ID、状態、SKIPPED の理由）と、待ち行列の順
- 採番器の次の連番（ページ、Evidence、Finding）
- `RunProgress` の理由、再試行の記録、各フラグ（違反の検出、違反による停止、未処理の失敗の件数、Guard の有無、PREFLIGHT の失敗）、`pagesStarted`
- ページの外の Safety Ledger の snapshot の一覧（PREFLIGHT、環境の記録、robots/sitemap の取得）。ページの中で作った Ledger（Passive、幅の走査、Interaction、再試行の前の試行）の snapshot は、そのページの保存に入れる。`state.json` に全部を持たせると、保存のたびに書く量がページの数に比例して増え、1ページで最大25の Context を作るため、500ページでは1回の保存が数MBになる（R4a の報告の発見事項4。2026-10-01 設計者の判断）。再開のときは、ページの外の Ledger、終わったページの Ledger（ページの終わった順）の順に並べ直す（Ledger を作った順と同じになる）。
- robots/sitemap の Evidence と、その理由
- 負荷の記録（`NavigationPacer` の回数と待ちの合計と、最後の読み込みの開始の時刻。`LoadMeter` の状態）
- 終わったページの ID の一覧（`checkpoint/pages/` のファイルとの対応）

保存しないもの:

- Playwright のオブジェクト、Run 全体のリソースのキャッシュ（再開のときは空から始める）、`pageLedgerStart`（プロセスの中の番号）。
- 監査の途中のページの結果。

### 4.2 保存の形式と検証

- スキーマ: `schemas/checkpoint.schema.json`（`state.json`）と `schemas/checkpoint-page.schema.json`（ページの保存）を新設する。`additionalProperties: false`。ページの結果の部分は、`page.schema.json` の定義を `$ref` で使う（形を二重に定義しない）。
- `src/core/schema-validator.ts` のスキーマの名前の一覧に `checkpoint` と `checkpoint-page` を加える（JSON Schema validation の owner の拡張）。
- 書くときと読むときの両方で、スキーマで検証する。スキーマの検証（`validateArtifact`）は、保存のファイルの読み書きを行う `ArtifactWriter` が行う（ARCH08 の Gate で、`validateArtifact` を呼べる場所は PREFLIGHT、Run Coordinator、ArtifactWriter に限られているため。R2 の Blocker B1）。`run-checkpoint.ts` は、検証の済んだ値の、スキーマでは確かめられない整合の確かめと、判定だけを行う。
- 保存の状態（`IN_PROGRESS`、`STOPPED`、`FINISHED`）と実行の終わり方（4.8）の閉じた一覧は、`src/core/contracts.ts` に置く。巡回の記録の状態の一覧 `CRAWL_URL_STATES` も `src/core/` に移し、`crawl-frontier.ts` は同じ名前で export し直す（スキーマの enum の値の一覧は `src/core/` に置く決まり。共通部品台帳 2.2。R2 の Blocker B2）。
- robots/sitemap は、`metadata` の Evidence（2件）だけを保存する（sitemap は Evidence から作り直せる。ほかの値は Run Coordinator が使っていない。R2 の報告）。
- 保存を読むときは、スキーマの確かめの後に、`state.json`（または `state.prev.json`）の `runId` が、Run のディレクトリの名前と同じことを確かめる。違えば、その保存は使えないものとして扱う（ディレクトリの名前を変えて写した場合に、出力と保存が別のディレクトリに分かれないようにするため。R5a の報告。確かめは ArtifactWriter の保存を読む処理の1か所）。
- 保存の「違反の検出」のフラグは、各保存の前に、Ledger を調べてから書く。robots.txt と sitemap.xml の取得の後の保存の前は、Run の初めからのすべての Ledger（この実行の PREFLIGHT と環境の記録のものと、保存した snapshot を含む。どれも閉じている）を調べ、各ページの保存の前は、そのページで作った Ledger を調べる（それより前の Ledger は、ページを始める前の確かめで調べた。R4a2b-fix-round-2 の報告）（違反の検出の処理は、Run Coordinator の1か所のまま。「止めた」ことの記録は、実際に監査を始めなかったときだけに行う今の決まりを変えない）。これにより、違反のあったページの保存の直後にプロセスが終わっても、保存のフラグが正しく、再開の判定（`decideRunResumption`）が `FINALIZE_ONLY` になり、CLI の知らせが実際の動きと合う（R5a-fix-round-1 の報告）。保存のフラグが偽で、保存した snapshot に違反がある場合に止める作り（R4a2b）は、守りとして残す。
- JSON にできない状態（frontier、採番器、Ledger）には、それぞれの owner のファイルに、状態を取り出す関数と、取り出した状態から作り直す関数を加える。
  - `CrawlFrontier`（`src/orchestration/crawl-frontier.ts`）と `CrawlQueue`（`src/crawl/crawl-queue.ts`）: 記録と待ち行列の順の取り出しと、作り直し。作り直すときに、3.2 の「待ち行列に戻す」SKIPPED の URL を `QUEUED` に戻す。`AUDITING` の URL も `QUEUED` に戻す（待ち行列の先頭に、元の順で戻す）。
  - `IdAllocator`（`src/orchestration/id-allocator.ts`）: 3つの連番の取り出しと、作り直し。作り直しは、新しい採番器を作るときにだけ行える（使っている採番器の連番を戻す口は作らない）。
  - Safety Ledger: Ledger は作り直さない。保存した snapshot を、最後の処理の Safety の集計に、生きている Ledger の snapshot と同じ形で渡す（`RunProgress` の Ledger の一覧を、「Ledger か、保存した snapshot」の一覧にする）。
- 書き出し: `ArtifactWriter` に、保存の書き出し（一時ファイルに書いてから名前を変える。今の書き出しと同じ方法）を加える。ARCH08 の例外は増やさない。
- UI Gate は `src/report/**` から `src/orchestration/**` への import（型だけのものも）を禁じているので、`ArtifactWriter` は `run-checkpoint.ts` を import しない。保存とロックの型は `run-checkpoint.ts` に残す（型の一部が orchestration・crawl・safety の型でできていて、core に移すと依存の向きが逆になるため。R3 の Blocker）。`ArtifactWriter` の保存の読み書きの関数は総称にし、保存の中身について知るのは、core の型だけで書ける最小の形（`state.json` の `completedPageIds`、ページの保存の `pageId`）だけにする。中身の検証はスキーマで行い、整合の確かめの関数は、呼び出し側（Run Coordinator）が読み込みの引数で渡す。ロックの中身も、呼び出し側が作って渡す。

### 4.3 保存の時期と書き方

- Run Coordinator が、robots/sitemap の取得の後と、各ページの `frontier.markFinished` と Link からの発見の後に、`ArtifactWriter` に保存を頼む。
- 先に `checkpoint/pages/<pageId>.json` を書き、次に `state.json` を置き換える。`state.json` に載ったページだけを、終わったページとして扱う（途中で止まっても、矛盾しない）。
- 電源が切れても壊れにくくするため、保存のファイルは次の順で書く。
  1. 一時ファイルに書き、`fsync` でディスクへの書き込みを確定する。
  2. 今の `state.json` を `state.prev.json` に名前を変える（`state.json` を置き換えるときだけ）。
  3. 一時ファイルの名前を本来の名前に変える。
  4. 書き込みを確定できる環境では、ディレクトリにも `fsync` を行う（Windows ではディレクトリの `fsync` ができないので、行わない）。
- 読むときは、`state.json` を検証し、壊れていれば（読めない、JSON でない、スキーマに合わない、載っているページのファイルがない・壊れている）、`state.prev.json` を同じように検証して使う。どちらも使えなければ、再開しない（4.7）。`state.prev.json` から再開した場合は、その後に終わったページを、もう1度監査する。
- 保存に失敗した場合は、Run を続けず、新しいページを始めない。理由 `CHECKPOINT_WRITE_FAILED` で、残りの URL を SKIPPED にし、最後の処理を行う（再開の材料がないまま監査を続けると、止まったときに最初からやり直しになるため）。

### 4.3.1 保存のセッション（`RunCheckpointSession`）と、保存の状態を終わりにする時期

- 保存、ロック、ハートビートは、1つの部品にまとめる（置き場所は `src/orchestration/run-checkpoint-session.ts`。新設）。Run Coordinator が Run の初めに作り、ページの後などで保存を頼む。ファイルの読み書きは、注入された保存の書き手（`ArtifactWriter` が形の上で満たす interface。`run-checkpoint.ts` に置く）に任せる。
- 保存の状態は、CLI が最後の出力（`run.json`、`report.html`、バンドル）を書き終えるまで `IN_PROGRESS` のままにする。Run Coordinator は、最後の状態（`FINISHED` か `STOPPED`）を書かずに、セッションを Run の結果と一緒に返す。CLI は、最後の出力を書き終えた後に、セッションに最後の状態を書かせ、ロックを外させる。
- こうすると、最後の出力を書く前にプロセスが終わった場合も、保存の状態は `IN_PROGRESS` で、すべてのページが終わっている。再開すると、新しいページを始めずに最後の処理だけを行い、出力を作る（3.2 の `IN_PROGRESS` の行のとおり）。
- ハートビートのタイマーは、セッションが持つ。時刻とタイマーは注入する（テストのため）。タイマーは、プロセスの終わりを妨げない（`unref`）。ハートビートの書き出しの失敗は、Run を止めない（次の回で書き直す）。

### 4.3.2 保存の終わり方（R4b の設計。2026-10-01）

- Run Coordinator は、`run()` が終わった後に、CLI が行う保存の終わり方を返す（`checkpointConclusion()`）。閉じた一覧は次の3つとする。
  - `FINISH`: 最後の状態の保存（`RunCheckpoint`）を持つ。CLI は、最後の出力を書き終えた後に、セッションの `finish` にそれを渡す。
  - `ABANDON`: 保存の状態を変えない。CLI は、最後の出力を書き終えた後に、セッションの `abandon` を呼ぶ（ロックは、プロセスが終われば古いと判定される）。
  - `NONE`: セッションを渡されていない、またはセッションを始めなかった（Run のディレクトリを作れなかった、ロックがすでにあった）。CLI は何もしない。
- `run()` が終わる前に呼ぶと、例外を投げる（呼び出し側の誤り）。
- 終わり方と保存の状態は、次の表の上から順に、最初に当てはまる行で決める。

| 条件 | 終わり方 | 保存の状態 |
| --- | --- | --- |
| セッションがない、または始めなかった | `NONE` | - |
| Run Status が `ABORTED_BY_SAFETY` | `FINISH`。この実行で保存に失敗していれば、最後に書けた保存（この実行のもの、なければ再開の入力のもの）の中身を使う。書けた保存がなければ `ABANDON` | `FINISHED` |
| この実行で、保存に失敗した | `ABANDON` | 変えない |
| 再開した実行で、PREFLIGHT に失敗した | `ABANDON` | 変えない |
| 理由 `MAX_RUNTIME_REACHED` の SKIPPED がある | `FINISH` | `STOPPED` |
| 理由 `RUN_INTERRUPTED` の SKIPPED がある | `FINISH` | `STOPPED` |
| それ以外 | `FINISH` | `FINISHED` |

- 最後の状態の保存の中身は、巡回の終わり（残りの URL を SKIPPED にした後、Browser を閉じる前）の値とする。Browser を閉じる処理と最後の処理（Cross-page rule、スキーマの検証）で加わる理由、未処理の失敗の件数、Finding の ID の採番は含めない。これらは、再開した実行の最後の処理で、もう一度行われる。含めると、再開した Run の理由が重なり、Finding の ID が中断しなかった場合とずれる。
- 巡回を始めなかった場合（新しい Run の PREFLIGHT の失敗など）は、巡回の記録と終わったページの一覧を空にし、採番器を初めの値にした保存を書く（`FINISHED`。次の起動で、壊れた保存として知らせないため）。
- 最後の状態の保存の、この実行の記録の終わりの時刻は、`run.json` の `finishedAt` と同じ値にする。保存の時刻（`savedAt`）も同じ値にする。

### 4.4 二重の起動を防ぐ（ロック）

- 新しい Run は、今のとおり Run のディレクトリを排他的に作る（DEF-009）。その直後に、ロックのファイル `<Run のディレクトリ>/checkpoint/run.lock` を排他的に作る（`wx`）。
- ロックの中身: プロセスの ID、OS の起動の時刻（`Date.now() - os.uptime() * 1000`）、ロックを取った時刻、最後に更新した時刻（ハートビート）。
- ハートビート: Run の間、1分ごとに、ロックの「最後に更新した時刻」を書き換える（タイマーで行う。ページの監査の長さに関係なく更新する）。
- ロックが「動いている Run のもの」とみなすのは、次のすべてを満たす場合だけとする。
  - OS の起動の時刻が、今の OS の起動の時刻と同じ（誤差 120秒以内）。端末を再起動した後は、ここで「古い」と分かる（プロセスの ID が別のプロセスに使い回されていても、誤らない）。
  - そのプロセスの ID が動いている（`process.kill(pid, 0)` が成功する）。
  - 最後に更新した時刻が、5分以内である。
- 再開のときは、ロックのファイルを確かめる。
  - ない場合: 排他的に作る。
  - 動いている Run のものなら、「別のプロセスが、この Run を実行しています」と示して終える（終了コード 4）。同じ対象の Run を2つ同時に動かすと、サイトへの負荷が倍になるためである。
  - 動いている Run のものでなければ、前の回が途中で終わった印とみなし、ロックを作り直す。
  - 作り直した後に、ロックを読み直す。中身が自分のもの（プロセスの ID とロックを取った時刻）でなければ、別のプロセスが同時に作り直したとみなし、再開しない（終了コード 4）。2つのプロセスが同時に古いロックと判定した場合に、両方が動かないようにするためである（R3 の報告）。
- 制約（R4a2a の報告）: 2つのプロセスを、同じ Run に対してほぼ同時に起動し、どちらも古いロックと判定した場合は、書き換えと読み直しの順によっては、両方が「自分のもの」と判断して進みうる。同じ Run を同時に2回起動しないことを、README に書く。完全に防ぐには、ロックの作り直しの仕組みが大きく複雑になるので、行わない（ふつうの使い方では起きない）。
- 再開のときの後始末（4.5）は、ロックを取った後、ハートビートのタイマーと保存の書き出しを始める前に行う（後始末は、書き出しの途中の一時ファイルを消すため。R3 の報告）。
- 再開のときに、セッションを始められなかった場合（動いている Run がある、別のプロセスが同時に作り直した、書けなかった）は、Run Coordinator は PREFLIGHT も Browser の起動もせず、出力も作らずに、専用の例外で reject する。Run のディレクトリを作れなかった場合（DEF-009）と同じ扱いで、CLI は文言と終了コード 4 を示す（R5）。
- Run の終わりに、ロックのファイルを消す。ロックの作成、更新、削除は `ArtifactWriter` が行う。ロックの判定（上の3つの条件）は `run-checkpoint.ts` が行う。

### 4.5 再開のときの後始末

- 監査の途中だったページのディレクトリ（`pages/<pageId>/`。終わったページの一覧にない ID のもの）を消してから、そのページを監査し直す。古いスクリーンショットや `retry-<n>/` が残らないようにする。
- Run のディレクトリに残った書き出しの途中の一時ファイル（`.<名前>.<UUID>.tmp`）と、PREFLIGHT の一時ファイルを消す。
- 最後の書き出しは、前の回の出力（`STOPPED` の回の `run.json` など）が残っていても、中断しなかった場合と同じファイルの集まりになるようにする。今回書かないファイル（例: 可視テキストのない場合の `visible-text.txt`）が前の回から残っていれば消す。
- 消すのは、Run のディレクトリの中の、上のものだけとする。消す前に、パスが Run のディレクトリの中にあることを確かめる。消す処理は `ArtifactWriter`（または `src/core/artifact-layout.ts`）に置く。

### 4.6 実行時間の上限（1回の実行ごと）

- `crawl.maxRuntimeMs` は、1回の実行（起動）の上限とする。再開した実行は、その実行の開始の時刻から数える。中断していた時間は数えない。
- 上限に達したら、今までどおり新しいページを始めず、残りの URL を理由 `MAX_RUNTIME_REACHED` の SKIPPED にして、最後の処理を行い、`PARTIAL` の出力を書く。保存の状態は `STOPPED` にする（再開できる）。
- `run.json` の `crawlLimits.maxRuntimeReached` は、最後の実行で上限に達したかを示す。

### 4.6.1 止める印（R4b の設計。2026-10-01）

- 止める印は、Run Coordinator に、標準の `AbortSignal` で渡す（`stopSignal`。省略できる）。CLI は、1回目のシグナルで `AbortController` の `abort()` を呼ぶ（R5）。
- Run Coordinator は、次のページを始める前にだけ、印を確かめる。確かめる順は、違反、保存の失敗、ページ数、実行時間、止める印とする（同時に当てはまる場合は、前のものの理由にする）。
- 今のページは、再試行を含めて最後まで行う（ページの期限と再試行の回数の上限で、必ず終わる）。robots.txt と sitemap.xml の取得は止めない（2件だけで、短いため）。
- 印が付いた後の URL は、理由 `RUN_INTERRUPTED`（`detail` は `null`）の SKIPPED にする。Run の理由にも、`RUN_INTERRUPTED` を1件残す（実行時間の上限と同じく、SKIPPED の URL から、最後の処理で導く。再開で URL を待ち行列に戻すと、理由も消える）。Run Status は、SKIPPED の URL があるので `PARTIAL` になる（`deriveRunStatus` は変えない）。
- 印が付いた時点で、残りの URL がなければ、そのまま最後まで行った Run になる（`COMPLETE` にもなりうる）。

### 4.7 CLI

- `run --config <設定>` を起動すると、Run を始める前に、出力先（`output.directory`、または `--output`）の中から、次のすべてを満たす Run を探す。
  - 同じ対象（`target.id`）である。
  - 実効の設定が、今回の実効の設定と完全に同じである（`--headed`・`--headless` による上書きを含む）。ただし、出力先（`output.directory`。`--output` の上書きを含む）は比べない。出力先は途中の Run を探す場所そのものなので、書き方が違っても（例: 相対のパスと、同じ場所の絶対のパス）、同じ出力先の途中の Run を再開できるようにする（R5b の報告）。比べない項目の一覧は、保存の owner（`run-checkpoint.ts`）の名前付きの定数に置く。
  - 再開できる（3.2 の `IN_PROGRESS` か、再開できる `STOPPED`）。
- 見つかった場合（複数なら、最初の実行の開始が最も新しいもの）:
  - ロック（4.4）が動いている Run のものなら、「同じ対象の Run が実行中です」と示して終える（終了コード 4）。新しい Run も始めない（同時に2つ動かすと、サイトへの負荷が倍になるため）。
  - BeakSight、Playwright、Chromium の版が、保存したものと違う場合は、再開しない。「版が違うので再開できません。最初から始めるには --new を付けてください」と示して終える（終了コード 4）。結果の比べ方が崩れるためである。
  - それ以外なら、「途中の Run（<Run の ID>、監査済み <n> ページ）を、続きから再開します。最初から始めるには --new を付けてください。」と示して、再開する。
- 見つからない場合は、新しい Run を始める。設定が違うために再開の対象にならなかった途中の Run があれば、その旨を1行で知らせる（どの項目が違うかを示す）。
- `run` に、値を取らないオプション `--new` を加える。付けると、途中の Run を探さずに、新しい Run を始める。ただし、同じ対象の Run が実行中（ロックが動いている Run のもの）なら、新しい Run も始めない（終了コード 4）。
- 保存が壊れていて（`state.json` と `state.prev.json` の両方が使えない）再開できない Run は、再開の対象にしない。その旨を1行で知らせ、新しい Run を始める。
- シグナル:
  - Playwright の既定のシグナルの処理を止める（`chromium.launch` の `handleSIGINT`、`handleSIGTERM`、`handleSIGHUP` を `false` にする）。
  - BeakSight が、SIGINT、SIGTERM、SIGHUP を受ける。1回目は、「中断を受け付けました。今のページの監査を終えてから止めます。すぐに止めるには、もう一度押してください。」と示し、止める印を付ける。今のページの監査は最後まで行う（ページの期限で必ず終わる）。新しいページは始めない。残りの URL を理由 `RUN_INTERRUPTED` の SKIPPED にし、最後の処理を行い、`PARTIAL` の出力を書く。保存の状態は `STOPPED` にする。終了コードは、Run Status のとおり（2）。
  - 2回目は、Browser を閉じて、すぐに終える。保存は、最後に終わったページまでのものが残る（状態は `IN_PROGRESS`）。終了コードは 5（中断。最後の処理をしていない）。
- 終了コードの表に 5 を加え、README とレポートの説明に書く。
- 利用者向けの文言は `src/presentation/messages.ts` に置く。

### 4.7.1 CLI の詳細（R5 の設計。2026-10-01）

- **実行中の Run の確かめ**: 起動したら、まず、出力先のすべての Run のディレクトリ（名前が Run の ID の形のもの）のロックを読み、どれかが動いている Run のもの（4.4 の判定）なら、再開も新しい Run もせずに終える（終了コード 4）。`--new` を付けても同じ。
  - ロックには対象の ID がないので、対象を問わない。同じ出力先では、同時に1つの Run だけを動かす（README に書く）。
  - 最初の保存（robots.txt と sitemap.xml の取得の後）の前の Run も、ロックはあるので、この確かめで見つかる。2つを短い間に起動した場合に、両方が動かないようにするためである。
- **途中の Run を探す読み方**: 各 Run の `state.json`（読めなければ `state.prev.json`）だけを読み、スキーマで確かめて、対象・再開できるか（`decideRunResumption`）・設定で絞り込む。ページの保存まで読むのは、再開すると決めた Run だけとする（終わった Run が出力先に増えても、起動が遅くならないようにするため）。ページの保存まで読んで使えなかった場合は、壊れた保存として知らせ、新しい Run を始める。
- **選び方**: 同じ対象の Run（`state.json` を読めたもの。終わった Run も含む）のうち、最初の実行の開始が最も新しいもの1つだけを候補にする。それが再開でき（`decideRunResumption` が `RESUME` か `FINALIZE_ONLY`）、実効の設定が同じなら、再開する。設定が違えば、知らせて新しい Run を始める。終わっていれば、何も示さずに新しい Run を始める。選び方は、保存の owner（`run-checkpoint.ts`）の関数で行い、CLI は読んだ値を渡すだけにする。
  - 最も新しいものだけにするのは、古い途中の Run を、後で思いがけず再開しないためである（例: 1日目の Run を止め、2日目に `--new` で最後まで監査した後、3日目に起動すると、1日目の Run を再開してしまう）。
  - 4.7 の「複数なら、最初の実行の開始が最も新しいもの」を、この決まりで置き換える。
- **版の確かめ**: 起動の前に比べるのは、BeakSight と Playwright の版とする（`RUN_VERSION_FIELDS` から Chromium を外す）。BeakSight は、Playwright に同梱の Chromium だけを使い（`chromium.launch` に `channel` も実行ファイルのパスも渡さない）、Chromium の版は Playwright の版で決まるためである。各実行の Chromium の版は、保存の実行の記録に残る。
- **知らせ**: 再開するとき（`RESUME`）、最後の処理だけを行うとき（`FINALIZE_ONLY`。違反を検出した後なので、新しいページを始めないことを示す）、設定が違うので再開しない途中の Run があるとき（違う項目のパスを、最大 5 件と残りの件数で示す）、壊れた保存のとき、のそれぞれに1行の文言を示す。
- **Run の後**: 出力（`finishAuditRun`）を書き終えた後に、Run Coordinator の `checkpointConclusion()` に従う。`FINISH` ならセッションの `finish` に最後の状態を渡し、`ABANDON` なら `abandon` を呼び、`NONE` なら何もしない。
  - 最後の状態が `FINISHED` なら、`finish` の後に、ページの保存（`checkpoint/pages/`）と `state.prev.json` を消し、`state.json` だけを残す（`ArtifactWriter` が行う。Run のディレクトリの外に及ばない）。ページの保存は出力の `page.json` とほぼ同じ中身で、終わった Run では使わないため、ディスクを2倍使わないようにする。`state.json` は、上の「選び方」で、同じ対象の最も新しい Run を知るために残す。消せなかった場合は、警告の1行を示す（終了コードは変えない）。出力の書き出しが失敗した場合は、`abandon` を呼んでから、今のとおり失敗として扱う。`finish` が失敗した場合は、警告の1行（次の起動で最後の処理をやり直すこと）を示し、終了コードは Run Status のとおりにする。
- **再開を始められなかった場合**（`RunResumeUnavailableError`）は、理由ごとの文言を示し、出力を作らずに終える（終了コード 4）。
- **終了コード**: 4 に「Run を始められない（実行中の Run がある、版が違う、ロックを同時に作り直された、保存を始められない）」を加える（結果の名前を `RUN_UNAVAILABLE` とし、値は 4）。5 は「中断（2回目のシグナル。最後の処理をしていない）」（結果の名前を `INTERRUPTED` とする）。

### 4.8 実行の記録（`run.json` の `executions`）

- `run.json` に、必須の項目 `executions` を加える。各実行の、開始と終わりの時刻と、終わり方を、実行の順に並べる（1件以上）。環境は、`run.json` では最初の実行のもの（`environment`）だけを持ち、各実行の環境は保存（`state.json`）に残す（2026-10-01 R4b の設計。表示の項目を増やさないため）。

```json
"executions": [
  { "startedAt": "...", "finishedAt": "...", "endReason": "INTERRUPTED_ABNORMALLY" },
  { "startedAt": "...", "finishedAt": "...", "endReason": "COMPLETED" }
]
```

- 終わり方の閉じた一覧: `COMPLETED`（最後の処理まで行った）、`STOPPED_BY_RUNTIME_LIMIT`、`STOPPED_BY_SIGNAL`、`STOPPED_BY_SAFETY_VIOLATION`、`INTERRUPTED_ABNORMALLY`（プロセスが途中で終わった。終わりの時刻は、最後の保存の時刻とする）。
- `run.json` の `startedAt` は最初の実行の開始、`finishedAt` は最後の実行の終わりとする。`environment` は最初の実行のものとする（版が同じでなければ再開しないので、主な値は変わらない）。
- この実行の終わり方は、次の順で決める（R4b の設計）: Run Status が `ABORTED_BY_SAFETY` なら `STOPPED_BY_SAFETY_VIOLATION`、理由 `MAX_RUNTIME_REACHED` の SKIPPED があれば `STOPPED_BY_RUNTIME_LIMIT`、理由 `RUN_INTERRUPTED` の SKIPPED があれば `STOPPED_BY_SIGNAL`、それ以外は `COMPLETED`。保存のセッションがない Run（テストなど）も、この1件の実行の記録を持つ。
- 再開のときは、保存の実行の記録のうち、終わり方が `null` のもの（前の回のプロセスが途中で終わった）を `INTERRUPTED_ABNORMALLY` にし、終わりの時刻を、その保存の時刻（`savedAt`）にする。その後に、この実行の分を加える。
- 保存の実行の記録は、最後のもの以外は、終わり方と終わりの時刻を持つ。最後のものは、保存の状態が `IN_PROGRESS` のときだけ、終わり方と終わりの時刻が `null` である（保存の整合の確かめで確かめる）。
- 終わり方の値の一覧は、`run.schema.json`（`null` なし）と `checkpoint.schema.json`（`null` あり）の両方にあり、どちらも `RUN_EXECUTION_END_REASONS` との一致をテストで確かめる。
- 表示（UI 追補設計書に従う）: 表示用モデルで1回だけ組み立てる。HTML の要約に「実行の回数」と実行の一覧、CLI の結果に1行（例: `実行: 3回、再開 2回`。実行が1回でも示す。R6 で、CLI の既存の行の組み立て方に揃えた）、`summary.json` に同じ値を出す。

### 4.9 負荷の制御との関係

- `NavigationPacer` は、保存した回数、待ちの合計、最後の読み込みの開始の時刻を `initial` として受け取る。再開の直後の最初の読み込みも、前の回の最後の読み込みから最小間隔以上空ける（実際の時刻で比べる）。
- `LoadMeter` は、保存した状態から作り直す。1分あたりの最大は、前の回と今回の大きい方とする。
- 負荷の制御の設計書 4.1 の `initial` に、最後の読み込みの開始の時刻（エポックからのミリ秒、または null）を加える。

## 5. SSOTと安全性への影響

| 項目 | owner | この設計での扱い |
| --- | --- | --- |
| Crawl queue authority | `src/crawl/crawl-queue.ts` | 拡張（状態の取り出しと作り直し） |
| URL ごとの巡回の記録 | `src/orchestration/crawl-frontier.ts` | 拡張（同上） |
| IDs | `src/core/ids.ts`、`src/orchestration/id-allocator.ts` | 拡張（連番の取り出しと、新しい採番器の作り直し） |
| Final Run status | `src/core/status.ts` | 利用のみ（新しい SKIPPED の理由 `RUN_INTERRUPTED`、`CHECKPOINT_WRITE_FAILED` は、既存の SKIPPED と同じく PARTIAL にする。理由の一覧の owner に加える） |
| JSON Schema validation | `src/core/schema-validator.ts` | 拡張（`checkpoint`） |
| Final artifact serialization | `src/report/artifact-writer.ts` | 拡張（保存、ロック、後始末） |
| 保存の作成と読み込み、再開の判定 | `src/orchestration/run-checkpoint.ts`（新設） | 新設。Owner Matrix に加える。Run の状態から保存の内容を作り、保存の内容から再開の状態を作る。ファイルは書かない（書くのは ArtifactWriter） |
| Safety Ledger | `src/safety/safety-ledger.ts` | 変更なし（snapshot を使うだけ） |

- 違反の後に新しい監査を始めない決まりは、保存した「違反の検出」のフラグと Ledger の snapshot で、再開の後も守る。
- 違反を検出した Run は、保存に失敗した実行でも、最後に書けた保存を `FINISHED` にする（4.3.2）。最後の状態の保存も書けなかった場合は、次の起動で再開しうる（残る制約）。その場合も、再開の後の違反の確かめと Guard は、同じく働く。
- 保存と後始末は、Run のディレクトリの外に書いたり消したりしない。

## 6. 共通部品と共通仕様

| 区分 | 名前 | 置き場所 | この設計での扱い |
| --- | --- | --- | --- |
| 利用する既存の部品 | `createRunArtifactDirectory` などの Run のディレクトリの部品 | `src/core/artifact-layout.ts` | 利用のみ |
| 利用する既存の部品 | 一時ファイルに書いてから名前を変える書き出し | `src/report/artifact-writer.ts:145-159` | 利用のみ（保存にも使う） |
| 利用する既存の部品 | `validateArtifact` | `src/core/schema-validator.ts` | 利用のみ |
| 新しく作る共通部品 | 保存の作成と読み込み | `src/orchestration/run-checkpoint.ts` | 新設。共通部品台帳に追記する |
| 新しく作る共通部品 | 状態の取り出しと作り直しの関数 | 各 owner のファイル | 新設。共通部品台帳に追記する |

- 変更容易性: Run の状態に項目を1つ加えるときは、`run-checkpoint.ts` と `checkpoint.schema.json` を変える。保存を忘れた項目は、4.10 の「中断しなかった場合と同じ」のテストで見つかる。

## 7. テスト設計

- 状態の取り出しと作り直し（単体）: frontier、待ち行列、採番器のそれぞれで、取り出した状態から作り直したものが、元と同じ振る舞いをする。SKIPPED（`RUN_INTERRUPTED`、`MAX_RUNTIME_REACHED`）と `AUDITING` が `QUEUED` に戻り、元の順に並ぶ。
- 保存の形式（単体）: スキーマの検証。壊れた保存を拒む。
- ロック（単体と結合）: 動いている Run のロックがあれば、再開も新しい Run もしない。次のどれかなら古いロックとみなし、作り直して再開する: OS の起動の時刻が違う（端末の再起動を模す。プロセスの ID が動いているプロセスと同じでも古いとみなす）、プロセスの ID が動いていない、ハートビートが5分より前。ハートビートが1分ごとに更新される（時刻とタイマーを注入して確かめる）。
- 電源断への備え（単体と結合）: `state.json` が壊れている（途中で切れた JSON、スキーマに合わない、載っているページのファイルがない）場合に、`state.prev.json` から再開する。両方が壊れていれば再開せず、新しい Run を始め、その旨を知らせる。書き出しで `fsync` を呼ぶ（注入した書き出しの部品で確かめる）。
- **中断しなかった場合と同じ（結合。中核の受け入れ条件）**: ローカルの fixture のサイト（`fixtures/site/full-crawl/` など、数ページ）で、次の2つを比べる。
  - A: 中断しない Run。
  - B: k ページ目の監査の後で中断し（テストでは、注入した印で、保存の後にプロセスを終える形と、止める印を付ける形の両方）、同じ設定で起動し直して自動で再開した Run。
  - 比べるもの: ページの一覧と ID、Evidence の ID と種類、Finding の ID・ruleId・fingerprint、Run Status、SKIPPED の理由、Safety の集計。時刻、実行の記録、時刻を含む Evidence の値は比べない。
- 監査の途中のページ（結合）: ページの途中で止めた場合、再開のときにそのページのディレクトリが消され、最初から監査し直される。古いスクリーンショットが残らない。
- 違反の後（結合）: 違反を記録した後に止めた Run を再開すると、新しいページを始めず、`ABORTED_BY_SAFETY` の出力を書く。
- 実行時間の上限（結合）: 上限で `STOPPED` になった Run を再開すると、`MAX_RUNTIME_REACHED` の URL から続ける。
- シグナル（結合。CLI を別のプロセスで動かす）: 1回目の SIGINT で、今のページを終えてから止まり、`PARTIAL` の出力と `STOPPED` の保存を書き、終了コード 2。2回目ですぐに終わり、終了コード 5。Windows では、子のプロセスへの SIGINT の送り方に制約があるので、送れない場合は、止める印を注入する単体のテストで確かめ、シグナルの配線は別に確かめる（実装者が確かめて報告する）。
- CLI（単体と結合）: 同じ設定の途中の Run があれば自動で再開し、その旨と `--new` を示す。`--new` で新しい Run を始める。実行中の Run があれば、どちらも始めない（終了コード 4）。版の違いでは再開せず終了コード 4。設定が違う途中の Run は再開の対象にせず、知らせて新しい Run を始める。
- 表示（単体）: `executions` が HTML、CLI、`summary.json` に同じ値で出る。UI Gate。
- 既存のテスト: Run Coordinator、ArtifactWriter、CLI、Gate のテストが、変更の後も PASS する。

## 8. 対象ファイル

| パス | 責務 | 変更の種類 |
| --- | --- | --- |
| `src/orchestration/run-checkpoint.ts` | 保存の作成と読み込み、再開の判定 | 新規 |
| `schemas/checkpoint.schema.json` | 保存の形式 | 新規 |
| `src/core/schema-validator.ts` | スキーマの名前に `checkpoint` | 変更 |
| `src/crawl/crawl-queue.ts`、`src/orchestration/crawl-frontier.ts` | 状態の取り出しと作り直し | 変更 |
| `src/orchestration/id-allocator.ts` | 連番の取り出しと作り直し | 変更 |
| `src/orchestration/run-coordinator.ts` | 保存の時期、再開の流れ、止める印、1回の実行ごとの時間の上限、`executions` | 変更 |
| `src/report/artifact-writer.ts`、`src/core/artifact-layout.ts` | 保存の書き出し、ロック、後始末、残った古いファイルの削除 | 変更 |
| `src/core/contracts.ts`、`schemas/run.schema.json` | 新しい理由のコード、`executions` | 変更 |
| `src/cli/arguments.ts`、`src/cli/main.ts`、`src/cli/run-command.ts`、`src/cli/exit-codes.ts`、`src/cli/index.ts` | 自動の再開、`--new`、シグナル、終了コード 5、途中の Run の知らせ | 変更 |
| Browser の起動の箇所（`src/cli/run-command.ts` など） | Playwright の既定のシグナルの処理を止める | 変更 |
| 表示用モデル、HTML、CLI の結果、`summary.json`、`src/presentation/messages.ts` | `executions` と新しい理由・文言の表示 | 変更 |
| `README.md` | 再開の方法、Ctrl+C の振る舞い、終了コード 5、`maxRuntimeMs` の意味の変更 | 変更 |
| `doc/design/beaksight-shared-components.md` | 共通部品台帳 | 変更（設計者） |

## 9. 対象外

- **別の PC での再開**: 保存のファイルは Run のディレクトリの中にあるので、ディレクトリを移せば読める。ただし、版の確かめ（4.7）を通る必要がある。それ以上の対応はしない。
- **設定を変えての再開**（3.3 のとおり）。
- **監査の途中のページの、途中からの再開**: ページの中の段階（Passive、幅の走査、Interaction の候補）の途中から続ける仕組みは作らない。ページは最初から監査し直す（そのページの分だけ、サイトへの読み込みが重なる）。
- **保存の世代の管理**: 保存は、最新と1つ前の2つだけを持つ。
- **端末の起動のときに、BeakSight を自動で起動すること**: 再開は、利用者が同じコマンドを実行したときに行う。端末の起動のたびに自動で続けたい場合は、OS の機能（Windows のタスク スケジューラなど）で、同じコマンドを登録する。README に例を書く。

## 10. 完了条件

- [ ] 第7章のテストが、RED を確かめた後に PASS する。とくに「中断しなかった場合と同じ」の結合テスト。
- [ ] `npm run verify` が PASS する。
- [ ] `npx vitest run tests/integration/safety-gates.test.ts tests/integration/auditor-gates.test.ts tests/architecture` が PASS する。
- [ ] ローカルの fixture のサイトで、CLI の Run を Ctrl+C で止め、同じコマンドで自動で再開し、最後まで終えられる。端末の再起動を模したロック（OS の起動の時刻が違う）でも再開できる（設計者が手で確かめる）。
- [ ] 独立レビューで、Critical 0件、Important 0件。

## 11. 設計変更履歴

| 日付 | 契機 | 変更内容 | 影響範囲 |
| --- | --- | --- | --- |
| 2026-10-01 | 初版（ユーザーの指示「監査途中で中断した場合、再起動時は監査の最初からではなく、途中から再開できるようにすること」） | - | Task 21、負荷の制御の設計（4.9） |
| 2026-10-01 | ユーザーの判断（自動の再開、1回の起動ごとの時間の上限、Ctrl+C の振る舞い） | `--resume` を明示する形をやめ、自動の再開と `--new` にした（3.3、4.7）。端末の再起動と電源断に備え、ロックに OS の起動の時刻とハートビートを加え（4.4）、保存の `fsync` と1つ前の保存（`state.prev.json`）を加えた（4.1、4.3） | 再開の実装の全体 |
| 2026-10-01 | R2 の指示書の作成 | 保存のスキーマを、`state.json` 用とページの保存用の2つにした（4.2） | R2 |
| 2026-10-01 | Blocker: R2 の報告 | スキーマの検証は ArtifactWriter が行い、`run-checkpoint.ts` は整合の確かめと判定だけにした（ARCH08）。保存の状態と実行の終わり方の一覧を `src/core/contracts.ts` に置き、`CRAWL_URL_STATES` を core に移す（台帳 2.2）。robots/sitemap は Evidence だけを保存する（4.2） | R2、R3 |
| 2026-10-01 | R3 の指示書の作成 | 保存とロックの型を `src/core/contracts.ts` に移し、整合の確かめは呼び出し側が ArtifactWriter に渡す形にした（UI Gate の依存の向き。4.2） | R3、R4a |
| 2026-10-01 | Blocker: R3 の報告 | 保存の型を core に移すのをやめ、`run-checkpoint.ts` に残す。ArtifactWriter の保存の関数を総称にし、core の型だけで書ける最小の形だけを知るようにした（4.2） | R3、R4a |
| 2026-10-01 | R3 の報告 | ロックを作り直した後に読み直し、自分のものでなければ再開しない決まりと、後始末の時期を 4.4 に加えた | R4a、R5 |
| 2026-10-01 | R4a の設計 | 4.3.1（保存のセッションと、保存の状態を終わりにする時期）を加えた。最後の状態は、CLI が最後の出力を書き終えた後に書く | R4a、R4b、R5 |
| 2026-10-01 | Blocker: R4a の報告 | ページの中の Ledger の snapshot をページの保存に入れ、`state.json` にはページの外の Ledger だけを持たせる（4.1）。ロックを作れなかった新しい Run は FAILED にする | R4a、R4a2 |
| 2026-10-01 | R4a2b の指示書の作成 | 再開のときにセッションを始められなかった場合の扱い（出力を作らずに専用の例外）を 4.4 に加えた。進み具合の `pagesFinished` は再開の前の分を含める（RL の Minor-7） | R4a2b、R5 |
| 2026-10-01 | R4a2a の報告 | 同時の起動の制約を 4.4 に加えた | R5（README） |
| 2026-10-01 | R4b の設計 | 保存の終わり方（`FINISH`・`ABANDON`・`NONE`）と保存の状態の決め方、最後の状態の中身を巡回の終わりの値にすること（4.3.2）、止める印を `AbortSignal` で渡し、ページの間でだけ確かめること（4.6.1）、保存の時刻 `savedAt`（4.1）、実行の終わり方の決め方と、`run.json` の実行の記録に環境を含めないこと（4.8）、保存に失敗した実行と再開した実行の PREFLIGHT の失敗では保存の状態を変えないこと（3.2）、違反の Run は必ず `FINISHED` にすること（5章）を加えた。R4b を R4b1 と R4b2 に分けた | R4b1、R4b2、R5 |
| 2026-10-01 | R5 の設計 | 4.7.1（出力先の実行中の Run の確かめ、`state.json` だけで絞り込む読み方、選び方の owner、起動の前の版の確かめを BeakSight と Playwright にすること、知らせ、Run の後の `finish`・`abandon`、終了コード 4 と 5 の結果の名前）を加えた | R5 |
| 2026-10-01 | R5a の指示書の作成 | 再開の候補を、同じ対象の最も新しい Run だけにした（4.7 の「複数なら最も新しいもの」を置き換え）。終わった Run の保存は `state.json` だけを残すことにした（4.7.1） | R5a、README |
| 2026-10-01 | Blocker: R5a の報告 | 一覧を短くする書式は既存の `truncatedListText` を使う。終了コード 4 は `CONFIG_ERROR` と `RUN_UNAVAILABLE` の2つの結果が同じ値を持つ（終了コードのテストの例外として明示する）。使い方の表示の終了コードの表に「Run を始められない」の行を加える。再開の知らせのページの数は、進み具合の行と同じ書き方（`監査を終えたページ <件数>`）にする | R5a、R5b |
| 2026-10-02 | R5a と R5a-fix-round-1 の報告 | 保存を読むときの Run の ID とディレクトリの名前の確かめ、保存の違反のフラグを各ページの保存の前に調べてから書くことを 4.2 に加えた | R5a-fix-round-1、R4a2b-fix-round-1 |
| 2026-10-02 | R5b と R4a2b-fix-round-2 の報告 | 再開の設定の比べ方から出力先を外した（4.7）。robots.txt と sitemap.xml の取得の後の保存の前は、Run の初めからのすべての Ledger を調べることにした（4.2） | R5-fix-round-1、README |
