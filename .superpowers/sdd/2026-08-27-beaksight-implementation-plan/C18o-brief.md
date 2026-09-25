# C18o 指示書: Interaction の理由の日本語の説明と表示（CC-010 の残りの2）

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。末尾の「一時ディレクトリの扱い」も守ってください。

## サブタスク

- ID: C18o
- 目的: C18n で Evidence に入るようになった Interaction の理由のコードを、HTML レポートで、日本語の説明、コード、詳細として示す。
- 設計書: `doc/design/2026-09-25-beaksight-pre-task-19-cleanup-design.md` の **5.1**（とくに 5.1.2 の「表示」）
- 実装計画: `doc/design/2026-09-25-beaksight-pre-task-19-cleanup-implementation-plan.md` の C18o
- 前のサブタスクの報告: 作業記録置き場の `C18n-report.md`（コードの一覧の最終の形）
- 関係する設計書:
  - UI 追補設計書 `doc/design/2026-09-23-beaksight-ui-ssot-design.md`（表示の owner の分け方、UI Gate）
  - Task 14〜17 の設計書 `doc/design/2026-09-23-beaksight-task-14-17-pipeline-report-cli-design.md` の 6.1.5
  - 作業記録置き場の外にある `.claude/skills/beaksight-dev/references/japanese-writing-guide.md`（説明の文の書き方）
- 共通部品台帳: `doc/design/beaksight-shared-components.md`

これまでの変更は、作業ツリーにそのまま残っています。HEAD に戻す操作は禁止です。

**このサブタスクは、C18m（`tests/integration/` の Guard の付いた page の処理の置き換え）と並行で実行します。**

- 下の「変えてよいファイル」の外は、変更しないでください。
- `npm run verify` と `npm run build` は、実行しないでください。全体の verify は、設計者が行います。
- 担当のテストと `npm run typecheck` は、実行してかまいません。ほかの実装者の作業中のファイルから出たエラーは、そのことを確かめて報告に書いてください。

## 作業

1. **説明を置く**（`src/presentation/messages.ts`）
   - `INTERACTION_REASON_DESCRIPTIONS`（`satisfies Record<InteractionReasonCode, string>`）と、`describeInteractionReason` を加える。
   - lifecycle の理由の分も、同じ形で加える（`INTERACTION_LIFECYCLE_REASON_DESCRIPTIONS`、`describeInteractionLifecycleReason`）。
   - 形は、今の `INCOMPLETE_REASON_DESCRIPTIONS` と `describeIncompleteReason` にそろえる（`deepFreeze`、`as const satisfies`）。
   - 説明の文は、利用者が一度で分かる日本語で書く。1つの文に1つの内容。技術的な詳細（値やエラーの文言）は `reasonDetail` の側にあるので、説明に書かない。
   - 意味の手がかりは、C18n の前に `isolated-auditor.ts` にあった英文（C18n の報告の「旧の値 → 新のコード」の対応）を使う。英文を直訳せず、利用者に分かる言い方にする。
2. **表示用モデル**（`src/report/view-model.ts`）
   - `ReasonView` を、コードの型を引数に取る形に広げる（例: `ReasonView<TCode extends string = IncompleteReasonCode>`）。既存の使い方（未完了の理由）は変えない。
   - Interaction の結果の表示用の型で、理由を `ReasonView<InteractionReasonCode>`（コード、説明、詳細）として渡す。lifecycle の理由を表示用モデルに出している場合は、同じ形にする。出していない場合は、出さないままにする（新しい表示を増やさない）。
   - 説明は `describeInteractionReason` で付ける。表示用モデルの中で文言を作らない。
3. **HTML**（`src/report/html-report.ts`）
   - 今の `reasonList` と `reasonTable` が1つの理由を描く部分（コード、説明、詳細）を、1つの内側の関数にまとめ、Interaction の表の理由の列でも同じ関数を使う。新しい表示の部品を `html-components.ts` に作らない。
   - 表の列の見出しの文言が変わる場合は、`messages.ts` の `HTML_REPORT_TEXT` を直す。
4. **変えないもの**: CLI の出力、ChatGPT 用のバンドルの中身（`page.json` はそのまま入る）、Interaction の件数の集計、ほかの理由の表示。

## TDD の進め方

- まず、REDになるテストを書く:
  - `INTERACTION_REASON_DESCRIPTIONS` のキーが、コードの一覧と過不足なく一致し、凍結されていること（`tests/unit/presentation-messages.test.ts` の、未完了の理由の確かめと同じ形）。lifecycle の分も同じ。
  - 表示用モデルの Interaction の理由が、コード、説明、詳細を持つこと。
  - HTML の Interaction の表に、日本語の説明とコードと詳細が出て、詳細がエスケープされること（詳細に危険な文字列を入れた見本で確かめる。見本は `tests/helpers/audit-run-fixture.ts` の `HOSTILE_STRINGS` を使う）。
- 既存のテストの期待値は、新しい形に合わせて直す。確かめる内容を弱めない。

## 変えてよいファイル

- `src/presentation/messages.ts`
- `src/report/view-model.ts`
- `src/report/html-report.ts`
- 表示のテスト: `tests/unit/presentation-messages.test.ts`、view-model のテスト、html-report のテスト、chatgpt-bundle のテスト（期待値が変わる場合だけ）
- `tests/helpers/audit-run-fixture.ts` は、見本の Interaction の理由の詳細に危険な文字列を入れる必要がある場合だけ、その箇所を変えてよい。
- 上に無いファイルを変える必要が出たら、Blocker として止まる。

## 使うべき共通部品（台帳から）

- `deepFreeze`（`src/core/immutable.ts`）
- `INCOMPLETE_REASON_DESCRIPTIONS`、`describeIncompleteReason` の形（手本）
- `ReasonView`、`reasonList`、`reasonTable`（広げて使う。複製しない）
- `renderCode`、`htmlText`、`joinWithSpace` など、`html-components.ts` のエスケープを通す部品
- 見本: `tests/helpers/audit-run-fixture.ts`（`HOSTILE_STRINGS` を含む）

## C18n の結果（前提）

- コードの一覧: `src/core/evidence-types.ts` の `INTERACTION_REASON_CODES`（69個）、`INTERACTION_REASON_CODES_BY_STATUS`、`INTERACTION_LIFECYCLE_REASON_CODES`（4個）。型は `InteractionReasonCode` と lifecycle の分（名前は実際のコードで確かめる）。
- 表示用モデルの `InteractionView` は、今は `reason`（コード）と `reasonDetail` を別々に持つ。これを `ReasonView<InteractionReasonCode>` の形にまとめる。
- **戻すべき確かめ**: C18n で、`tests/unit/html-report.test.ts:241` の `expect(interactions).toContain(escapeHtml(HOSTILE_TEXT))` を、コードの表示と「生の `<script>` を含まない」の確かめに一時的に替えた（詳細が HTML に出なくなったため）。C18o では、詳細を表示し、`HOSTILE_TEXT`（見本では `reasonDetail` に入っている）がエスケープされて出ることの確かめを戻す。「生の `<script>` を含まない」の確かめも残す。
- 旧の英文の意味: 作業記録置き場の `C18n-report.md` の「経路ごとの対応」と、`C18e-report.md` の第2段階を参照する。旧の英文そのものは、`git diff -- src/interaction/isolated-auditor.ts` の表示で読める（表示だけ。ファイルに書き出したり、作業ツリーを戻したりしない）。

## 受け入れ条件

- `tests/unit/html-report.test.ts` で、Interaction の理由の詳細の `HOSTILE_TEXT` がエスケープされて出ることを、再び確かめている。
- すべての Interaction の理由のコード（と lifecycle の理由のコード）に、日本語の説明がある。型とテストで確かめる。
- HTML の Interaction の表で、理由が、ページの未完了の理由と同じ部品で、説明、コード、詳細として示される。
- 詳細はエスケープされる。
- UI Gate（`tests/architecture/ui-ssot.test.ts`）と ARCH の Gate が PASS する。
- `npm run typecheck` が PASS する。
- 既存のテストのケースを消していない。確かめる内容を弱めていない。

## 厳守事項

- **Chromium は headless だけで起動する。** headed（`headless: false`）で起動してはいけない。
- 本来の監査対象のサイトを含む、実在の外部のサイトにアクセスしない。`config/targets/` と `local/` の実サイトの設定を使わない。
- `git commit`、`git push`、HEAD に戻す操作は禁止。
- 依存パッケージを追加・更新しない。
- Blocker に当たったら、回避策を自分で考えずに止まり、報告する。

## 報告

共通ルールの形式で、日本語で報告してください。説明の文の一覧（コードと説明の表）を、報告に入れてください。
