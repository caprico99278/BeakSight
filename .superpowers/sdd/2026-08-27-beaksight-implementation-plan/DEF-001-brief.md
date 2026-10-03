# DEF-001 指示書: axe の実行で Passive Context が安全違反として閉じられる不具合の修正

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## サブタスク

- ID: DEF-001（既存の不具合の修正）
- 目的: Guard の付いた Passive Context で axe を実行しても、Safety Ledger に不変条件の違反が記録されず、page が閉じられないようにする。
- 不具合の記録: 作業記録置き場の `defects.md` の DEF-001
- 設計書: `doc/design/2026-09-23-beaksight-foundation-corrections-design.md` 第8.1節
- 発見の経緯: 作業記録置き場の `C8-report.md` の発見事項1（C8 の実装者が、fixture の実際の Evidence をスキーマで検証するテストを書いていたとき、`index.html` で `collectAccessibilityEvidence` を実行すると、Safety Ledger に `CDP_SESSION_DETACHED`（「Document interception session detached while its page remained active」）が1件記録され、page が閉じられた）

同時に、ほかの実装者が F05（型の定義元の整理。`src/core/evidence-types.ts`、`src/core/contracts.ts`、`src/core/status.ts`、`src/crawl/normalize-url.ts`、`src/crawl/admission-policy.ts`、`src/safety/interaction-policy.ts`、`src/config/types.ts`）を行っています。これらのファイルは変更しないでください。

## 変更してよいファイル

- `src/evidence/accessibility-collector.ts`
- テスト: `tests/component/accessibility-collector.test.ts`、`tests/integration/accessibility-evidence.test.ts`、および新規のテストファイル
- `src/safety/passive-request-guard.ts` と `src/browser/context-factory.ts` は、**原則として変更しない**。変更が必要だと分かった場合は、変更せずに止まって報告する（Guard の不変条件の判定を緩めて回避しないこと）。

## 手順

1. **原因を確かめる**
   - Guard の付いた Passive Context で fixture のページ（例: `fixtures/site/index.html`）を開き、`collectAccessibilityEvidence` を実行する。
   - `CDP_SESSION_DETACHED` が記録されることを、テストで再現する（これが RED になる）。
   - あわせて、axe の実行の中で何が起きているかを確かめる。例えば、Context の `page` イベントで別の page が開かれるか、どの CDP のセッションが切り離されるか。
2. **原因が「AxeBuilder が同じ Context に別の page を開くこと」の場合**
   - `AxeBuilder` をレガシーの方式（`setLegacyMode(true)`。対象の page の中だけで実行する）で使うように直す。
   - この方式では、別Originの iframe は検査されない。その制約を Evidence に記録する（例: 検査の範囲が、同じOriginの文書に限られることを表す項目）。項目の形は報告する。別Originの iframe は Passive Context の許可Originの外なので、もともと監査の対象外である。
   - 手順1のテストが GREEN になることを確かめる。
3. **原因がほかにある場合**
   - 修正せずに止まり、確かめた事実を Blocker として報告する。

## 受け入れ条件

- Guard の付いた Passive Context で axe を実行した後に、Safety Ledger の `invariantViolations` が0件で、page が開いたままである。
- 既存の accessibility のテスト（`tests/component/accessibility-collector.test.ts`、`tests/integration/accessibility-evidence.test.ts`、`tests/integration/layout-accessibility.test.ts`）がすべて PASS する。
- `npm run typecheck` の担当範囲が PASS する。

## 報告

共通ルールの形式で報告してください。原因として確かめた事実も書いてください。
