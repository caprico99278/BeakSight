# C18g 指示書: 外部スキームへのサーバのリダイレクトを、たどる前に止めて記録する（RC18a の指摘1・3・4）

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。末尾の「一時ディレクトリの扱い」も守ってください。

## サブタスク

- ID: C18g
- 目的:
  - サーバのリダイレクト（3xx の `Location` が外部スキーム）を、Guard がたどる前に止め、記録する。
  - GATE-S03 に、この経路を加える。
- 設計書: `doc/design/2026-09-25-beaksight-pre-task-19-cleanup-design.md` の 4.1.1、4.2（「サーバのリダイレクトは、たどる前に止める」）、4.2.1
- 実装計画: `doc/design/2026-09-25-beaksight-pre-task-19-cleanup-implementation-plan.md` の C18g
- レビューの結果: 作業記録置き場の `RC18a-review-result.md`
- 前の報告: 作業記録置き場の `C18a-report.md`、`C18b-report.md`
- 再現の記録: `C:\Users\ocean\AppData\Local\Temp\claude\C--Develop-github-repo-BeakSight\c7d3723a-f7c4-4979-913c-ece0b3289778\scratchpad\rc18a\`（`probe2.log`、`probe3-frame.log` など。読むだけにする）
- 共通部品台帳: `doc/design/beaksight-shared-components.md`

これまでの変更は、作業ツリーにそのまま残っています。HEAD に戻す操作は禁止です。

**このサブタスクは、C18f（違反の後は監査を続けない）と並行で実行します。** C18f が変えるファイルは、次のとおりです。

- `src/orchestration/run-coordinator.ts`、`page-auditor.ts`
- `src/interaction/isolated-auditor.ts`
- `src/core/contracts.ts`、`src/presentation/messages.ts`
- スキーマの理由のコードの一覧

守ってほしいことは、次のとおりです。

- 下の「変更してよいファイル」の外は、変更しないでください。
- `schemas/page.schema.json` は、C18f も変える可能性があります。
  - あなたが変えてよいのは、外部スキームへの移動の事象の定義（`externalSchemeNavigationEvent` など）の部分だけです。
  - 編集の前に、必ずファイルを読み直してください。
- `npm run verify` と `npm run build` は、実行しないでください。全体の verify は、設計者が行います。
- 担当のテストと `npm run typecheck` は、実行してかまいません。ほかの実装者の作業中のファイルから出たエラーは、そのことを確かめて報告に書いてください。

## 変更してよいファイル

- `src/safety/passive-request-guard.ts`（リダイレクトの検出と、止める処理に限る。既存の判定と違反の扱いは、変えない）
- `src/safety/safety-ledger.ts`（記録の形を広げる場合に限る）
- `src/core/evidence-types.ts`（外部スキームへの移動の事象の理由を加える場合に限る）
- `schemas/page.schema.json`（上のとおり、事象の定義の部分に限る）
- `src/presentation/catalog.ts`（事象のラベルと説明に限る）
- `src/audit/safety-rules.ts`（新しい理由の Finding の扱いに限る）
- `fixtures/server.ts`（外部スキームへリダイレクトする経路を加えることに限る。既存の振る舞いは変えない）
- `fixtures/site/`（リダイレクトの元を iframe で読むページを加えることに限る）
- テスト:
  - `tests/integration/external-scheme-navigation.test.ts`
  - `tests/integration/passive-request-guard.test.ts`（リダイレクトの分）
  - `tests/integration/safety-gates.test.ts`（GATE-S03 のリダイレクトの分と、RC18a の指摘4のコメントに限る）
  - `tests/integration/gate-fixtures.test.ts`（対照の確認に限る）
  - `tests/integration/fixture-server.test.ts`（サーバを変えた場合に限る）
  - Ledger、スキーマ、カタログ、Safety の Rule の、対応する既存のテスト

## 作るもの

1. **リダイレクトを止める**（設計書 4.2）
   - Guard は、Document のリクエスト（main frame と subframe）の応答の段階で、3xx の `Location` を調べる。
     - `Location` が外部スキーム（`NON_EXTERNAL_NAVIGATION_SCHEMES` にないもの）なら、リダイレクトをたどる前に、リクエストを失敗させる。
     - `Location` は、相対の URL も、元のリクエストの URL を基準に解決する。
     - 解析できない `Location` は、Guard の既存の fail-closed の扱いに合わせる。
   - 横取りの方法は、実装者が決めて報告する。例えば、CDP の `Fetch` の Response の段階である。
     - 今の Guard は、Document の Request の段階を横取りしている（`passive-request-guard.ts:1117` 付近）。
     - 応答の段階の横取りを加えることで、既存の判定（許可 Origin、メソッドなど）が変わらないこと。
   - 対象の段階: Passive の段階と、Interaction の段階（凍結の前と後）。
     - 凍結の後は、今もリダイレクトの経路が `INTERACTION_FROZEN` で止まる（RC18a の確認）。この扱いは、変えない。
2. **記録**
   - 止めたリダイレクトは、`externalSchemeNavigations` に記録する。
   - スクリプトによる移動の試み（止められない経路）と区別できるようにする。
     - 例: 理由を `EXTERNAL_SCHEME_REDIRECT_BLOCKED` にする。
     - 例: frame の種類と段階を、今と同じ形で持つ。
   - headed でも、違反にしない。この経路は、止めて防げるためである（設計書 4.2.1）。
   - 表示のラベルと説明を、カタログに加える（止めた事象であることが分かる文言）。
3. **main frame のリダイレクト**（RC18a の指摘3）
   - main frame のリダイレクトを止めた場合も、同じく記録する。
   - そのときに、既存の `HTTP_MAIN_FRAME_DELIVERY_FAILED` の違反が出るかどうかを確かめて、報告する。
   - **既存の違反を緩める変更は、しない。** 緩めるかどうかは、報告を見て、設計者が決める。
4. **fixture**
   - fixture のサーバに、外部スキームへリダイレクトする経路を加える。
     - 例: `/__external-scheme-redirect?to=<宛先の名前>` が `302 Location: <外部スキーム>` を返す。
     - 宛先は、サーバの中の固定の一覧（実在しないもの）に限る。
   - それを iframe で読むページと、main frame で開くページ（または、開始の URL にする経路）を置く。
   - 対照の確認: Guard のない Context で、外部スキームへの `request` の事象（`redirectedFrom` 付き）が来ることを確かめる。
5. **Gate**（GATE-S03 に加える）
   - Passive の段階で、iframe と main frame のリダイレクトを確かめる。
     - `externalSchemeNavigations` に、止めた記録がある。
     - 違反がない（headless）。
     - headed を注入しても、この経路では違反にならない。
     - サーバには、リダイレクトの元のリクエストが届き、外部スキームへの移動は起きない。
   - Run の段階（同じプロセスの中の `runCli`、headless）で、iframe のリダイレクトを持つページを監査する。
     - artifact に記録が残ることを確かめる。
     - RC18a の再現（`probe3-frame.log`）では記録が0件だったので、その状態が直ったことを示す。
6. **RC18a の指摘4**
   - `safety-gates.test.ts:441-444` 付近の「サーバには GET だけ」と「URL が変わらない」の確認に、コメントを加える。
     - 内容: Guard がなくても同じ結果になる補助の確認であること。見分けているのは、Ledger の記録の確認であること。
   - 確認そのものは、変えない。

## 厳守事項（このサブタスクに固有のもの）

- **Chromium は headless だけで起動する。** headed（`headless: false`）で起動してはいけない。この PC で、電話や通話やメールのアプリが実際に起動するおそれがあるためである。
- 外部スキームの URL には、実在する宛先を使わない。

## 受け入れ条件

- 各テストが、修正前に RED、修正後に GREEN になる。
  - RC18a の再現の状態（記録が0件）が、RED にあたる。
- 既存のテストのケースと期待値を、弱めない。既存の違反の扱いを、緩めない。
- すべての Gate（S、A、ARCH、UI）が PASS する。
- `npm run typecheck` が PASS する。
- `npm run verify` は実行しない（並行作業のため）。

## 報告

共通ルールの形式で、日本語で報告してください。報告には、次のものを入れてください。

- 横取りの方法と、その場所（ファイル:行）
- 新しい理由
- main frame の場合の既存の違反の有無（指摘3）
- Guard の独立レビュー（RC18b）で確かめてほしい点
