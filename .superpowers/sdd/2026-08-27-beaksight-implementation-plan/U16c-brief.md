# U16c 指示書: HTML レポート

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。末尾の「一時ディレクトリの扱い」も守ってください。

## サブタスク

- ID: U16c
- 目的: 表示用モデルから、日本語の静的な HTML レポートを描く。
- 設計書:
  - `doc/design/2026-09-23-beaksight-task-14-17-pipeline-report-cli-design.md` の 6.1.3、6.1.4、6.1.5、6.1.6、6.1.8、6.1.9（とくに 6.1.9 の HTML レポート）
  - UI追補設計書 `doc/design/2026-09-23-beaksight-ui-ssot-design.md` の第3章、第4章、第6章
- 実装計画:
  - `doc/design/2026-09-24-beaksight-task-16-17-implementation-plan.md` の U16c
  - 上位の計画 `doc/design/2026-08-27-beaksight-implementation-plan.md` の Task 16 の Step 3 と Step 4
- スキルの参照: `.claude/skills/beaksight-dev/references/ui-ux-ssot.md`
- 前の報告: 作業記録置き場の次の4つ
  - `U16a-report.md`（部品とカタログ）
  - `U16b-report.md`（表示用モデルの型）
  - `C16a-report.md`（配置）
  - `C16b-report.md`（テストの見本の補助）
- 共通部品台帳: `doc/design/beaksight-shared-components.md`

これまでの変更は、作業ツリーにそのまま残っています。HEAD に戻す操作は禁止です。

**このサブタスクは、U16d（ChatGPT 用バンドル）と並行で実行します。** U16d の実装者は、`src/report/chatgpt-bundle.ts`、`tests/unit/chatgpt-bundle.test.ts`、`src/core/ids.ts`、`tests/unit/core-contracts.test.ts` を変更します。

- 下の「変更してよいファイル」の外は、変更しないでください。
- `npm run verify` と `npm run build` は、実行しないでください。U16d の作業と干渉するためです。全体の verify は、設計者が行います。
- 担当のテストと `npm run typecheck` は、実行してかまいません。
  - 型のエラーが U16d の作業中のファイルから出ている場合は、自分のファイルのエラーでないことを確かめてください。そのうえで、報告に書いてください。

## 変更してよいファイル

- 新規: `src/report/html-report.ts`、`tests/unit/html-report.test.ts`
- `src/report/html-components.ts`（部品を加えることに限る。既存の部品の振る舞いは、変えない）
- `src/report/html-tokens.ts`（スタイルを加えることに限る）
- `src/presentation/messages.ts`（HTML レポートの日本語の文言を加えることに限る）
- `tests/unit/report-html-components.test.ts` など、上の各ファイルに対応する既存の単体テスト
- `tests/helpers/audit-run-fixture.ts`（見本を加えることに限る。既存の関数の振る舞いは、変えない）

次のファイルは、変更しません。

- `src/report/view-model.ts`
- `src/report/artifact-writer.ts`
- `src/presentation/catalog.ts`
- `src/core/**`

表示用モデルやカタログが足りない場合は、止まって Blocker として報告してください。

## 作るもの

1. **`renderHtmlReport(viewModel: ReportViewModel): string`**
   - 入力は、表示用モデルだけにする。判定や集計は、しない（UI04）。件数は、表示用モデルの値を使う。
   - 節と順は、設計書 6.1.4 のとおりにする。
     1. 要約
     2. 重大な指摘
     3. category ごとの節
     4. Interaction
     5. Safety
     6. ページの一覧
   - 日本語のラベルは、カタログで引く。日本語の文言は、`messages.ts` に置く。
   - 未観測の値は、`formatNotObserved` などの書式を使う。0 や空文字にしない。
   - Finding の行には、次のものを示す。
     - severity
     - ルールの ID と版
     - メッセージ（Rule が作った文言をそのまま使う。作り直さない）
     - ページ（アンカーへのリンク）
     - ビューポート
     - Evidence の参照（`page.json` への相対リンクと `pointer`）
     - スクリーンショットの参照（相対リンク）
   - ページの一覧には、次のものを示す。
     - ページのアンカー
     - ページとビューポートの状態
     - 未完了の理由（コード、detail、説明）
     - スクリーンショット
     - 再試行の前の記録（別の小見出し）
   - URL は、`renderUrl`（設計書 6.1.6）で示す。許可 Origin は、`summary.allowedOrigins` から取る。
   - タグは書かない。部品を組み合わせるだけにする（UI03）。
     - 部品が足りない場合は、`html-components.ts` に加える。
     - 加える部品も、受け取った文字列を必ずエスケープする。
   - 色の値は書かない（UI02）。状態の値の文字列リテラルも書かない（UI01）。
2. **テスト（`tests/unit/html-report.test.ts`）**。見本は、C16b の補助（`tests/helpers/audit-run-fixture.ts`）で作る。
   - `mailto:` と `tel:` の URL が、文字として示され、`href="mailto:` と `href="tel:` が出ない（上位の計画の Step 3）。
   - Evidence の値の `<script>`、`"onerror=`、`javascript:` が、エスケープされる。`<script` のタグが、出力にない。
   - Run Status、ページの網羅、ERROR・WARN・INFO・SAFETY の件数、category の節、ページの一覧、Evidence の ID、ビューポート、ルールの ID と版、スクリーンショットの参照がある（上位の計画の Step 4）。
   - 節の順が、設計書 6.1.4 のとおりである。
   - アンカーが安全な文字だけで、リンクの先のアンカーが文書の中にある。
   - 未観測の値が、「未観測」と示される。
   - 再試行の前の記録が、別に示される。
   - `<html lang="ja">` と、唯一のスタイルシートがある。`style=""` の属性がない。
   - 同じ入力から、同じ文字列ができる（決定論）。

## 受け入れ条件

- 各テストが、修正前に RED、修正後に GREEN になる。
- UI Gate（`tests/architecture/ui-ssot.test.ts`）が PASS し、1秒以内に終わる。
- 担当のテストと、`npm run typecheck`（自分のファイルについて）が PASS する。
- `npm run verify` は実行しない（並行作業のため）。

## 報告

共通ルールの形式で、日本語で報告してください。加えた部品と文言の一覧を書いてください。U17a の実装者が、CLI から `renderHtmlReport` を呼ぶときに使います。
