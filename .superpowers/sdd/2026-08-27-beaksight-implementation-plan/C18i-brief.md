# C18i 指示書: 別のプロセスの iframe（OOPIF）の横取り（RC18b の N1）と、幅の走査の理由（N2）

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。末尾の「一時ディレクトリの扱い」も守ってください。

## サブタスク

- ID: C18i
- 目的:
  - 別のプロセスで動く iframe（OOPIF）にも、Guard の CDP の横取り（Document の Request と Response の段階）を付ける。
  - そのうえで、OOPIF の中の、外部スキームへのサーバのリダイレクトを、止めて記録する。
  - 幅の走査の中で違反が起きたときの理由を直す。
- 設計書: `doc/design/2026-09-25-beaksight-pre-task-19-cleanup-design.md` の 4.2、4.2.1（OOPIF の制約）、4.5
- 実装計画: `doc/design/2026-09-25-beaksight-pre-task-19-cleanup-implementation-plan.md` の C18i
- レビューの結果: 作業記録置き場の `RC18b-review-result.md`
- 再現の記録: `C:\Users\ocean\AppData\Local\Temp\claude\C--Develop-github-repo-BeakSight\c7d3723a-f7c4-4979-913c-ece0b3289778\scratchpad\rc18b\`（読むだけにする。`--site-per-process` での実験がある）
- 前の報告: 作業記録置き場の `C18g-report.md`、`C18h-report.md`、`C18f-report.md`
- 共通部品台帳: `doc/design/beaksight-shared-components.md`

これまでの変更は、作業ツリーにそのまま残っています。HEAD に戻す操作は禁止です。

このサブタスクは単独で実行します。

## 変更してよいファイル

- `src/safety/passive-request-guard.ts`（OOPIF への CDP の session の付与と、同じ横取りの適用に限る。既存の判定と違反の扱いは、変えない）
- `src/orchestration/page-auditor.ts`、`src/evidence/layout-collector.ts`（N2 の理由に限る）
- テスト:
  - `tests/integration/passive-request-guard.test.ts`
  - `tests/integration/external-scheme-navigation.test.ts`
  - `tests/integration/safety-gates.test.ts`（GATE-S03 に OOPIF の経路を加えることに限る）
  - `tests/integration/gate-fixtures.test.ts`（対照の確認に限る）
  - `tests/integration/page-auditor.test.ts`（N2 に限る）
  - 新規のテスト（例: `tests/integration/oopif-guard.test.ts`）
- `fixtures/server.ts`、`fixtures/site/`（別のサイトの iframe を作るのに必要な場合に限る。既存の経路は変えない）
  - 別のサイトにするには、`127.0.0.1` と `localhost` など、同じサーバの別のホスト名を使ってよい。インターネット上のサイトは使わない。

## 作るもの

1. **OOPIF にも横取りを付ける**
   - Guard は、Context の中に別のプロセスの iframe ができたときに、その iframe の target にも CDP の session を作り、page と同じ横取りを付ける。
     - 横取りは、Document の Request の段階と Response の段階（`Fetch.enable` の同じパターン）である。
     - 方法は、実装者が決めて報告する。例えば、次のものがある。
       - Playwright の `browserContext.newCDPSession(frame)`（frame が OOPIF の場合に使える）
       - page の session での `Target.setAutoAttach`（`waitForDebuggerOnStart`、`flatten`）
     - 付けるまでの間に、その iframe の移動が進まないようにする方法があれば、使う。
       - 例: `waitForDebuggerOnStart` で止めてから `Fetch.enable` し、`Runtime.runIfWaitingForDebugger` で進める。
       - 使えない場合は、残る時間の窓を、報告に書く。
   - OOPIF の session での事象の扱いは、page の session と同じにする。
     - リダイレクトの対応付け、`expectedCdpFailures`、外部スキームへのリダイレクトの判定、閉じる途中と凍結の後の扱い
     - 同じ判定の処理を、2つに複製しない。session を引数に取る形にするなどして、1つにする。
   - **fail-closed**: OOPIF に session を付けられなかった場合は、違反として記録し、Context を閉じる。
     - 例: 新しい違反のコード `OOPIF_GUARD_ATTACH_FAILED`
     - 対象は、session の作成の失敗と、`Fetch.enable` の失敗である。
   - 入れ子の OOPIF にも、付ける。
   - OOPIF が閉じたときに、その session と登録を消す。
   - **サイトの分離を無効にする起動の引数（`--disable-site-isolation-trials`、`--disable-features=IsolateOrigins,site-per-process` など）は、使わない。** ブラウザの安全の仕組みを弱めるためである。
     - OOPIF への付与が、どうしてもできない場合は、この方法を採らずに、止まって報告する。
2. **N2 幅の走査の理由**
   - 幅の走査のセッションの中で違反が起き、Guard がそのセッションの Context を閉じた場合を扱う。
   - このとき、理由を `stress-layout:SAFETY_VIOLATION_ABORT`（または、Guard が閉じたことが分かる理由）にする。
   - 今は、`stress-layout:EVALUATION_FAILED` になる。
   - 新しい理由のコードは、加えない。既存のコードの detail で表す。

## テスト

- OOPIF の経路は、`--site-per-process` の起動の引数を付けた headless の Chromium で確かめる。標準の headless は、OOPIF を作らないためである。
  - まず、テストの中で、iframe が実際に別のプロセス（OOPIF）になっていることを確かめる。
    - 例: Playwright で frame の `page` と CDP の target の数を見る。または、`Target.getTargets` で `iframe` の種類の target があることを見る。
  - 別のサイトの iframe が、自分で `/__external-scheme-redirect?to=...` に移動する場合に、次のことを確かめる。
    - `EXTERNAL_SCHEME_REDIRECT_BLOCKED` の記録があり、違反がない（headless と、headed の注入の両方）。
    - 元のリクエストが、Guard が止めた失敗（`net::ERR_BLOCKED_BY_CLIENT`）になる。
  - 入れ子の OOPIF でも確かめる。
  - OOPIF の中の遅いリダイレクト（`/__slow-redirect`）で、偽の違反が出ないこと。
  - OOPIF の中の、許可 Origin の外への移動や、変更系のメソッドが、今までどおり止まること。これは、既存の `context.route` の判定である。
  - fail-closed: session を付けられない場合（偽の失敗を注入する）に、違反になり、Context が閉じること。
  - 修正の前に RED になること。RC18b の再現では、記録が0件、違反が0件だった。
- GATE-S03 に、`--site-per-process` の OOPIF のリダイレクトの経路を、1件以上加える。
- N2: 幅の走査のセッションの中で違反が起きた場合に、理由が `stress-layout:SAFETY_VIOLATION_ABORT` になること。修正の前に RED になること。
- 既存のすべてのテストと Gate が、PASS すること。

## 厳守事項（このサブタスクに固有のもの）

- **Chromium は headless だけで起動する。** headed（`headless: false`）で起動してはいけない。この PC で、電話や通話やメールのアプリが実際に起動するおそれがあるためである。`--site-per-process` などの引数を付けることは、かまわない。
- 外部スキームの URL には、実在する宛先を使わない。

## 受け入れ条件

- 各テストが、修正前に RED、修正後に GREEN になる。
- 既存のテストのケースと期待値を、弱めない。既存の違反の扱いを、緩めない。
- `npm run typecheck` が PASS する。
- `npm run verify` が PASS する。

## 報告

共通ルールの形式で、日本語で報告してください。報告には、次のものを入れてください。

- OOPIF への付与の方法と、その場所（ファイル:行）
- 付けるまでの時間の窓の有無
- fail-closed の違反のコード
- OOPIF が実際にできていることの確かめ方

これらは、Guard の確認のレビュー（RC18c）で使います。
