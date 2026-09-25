# C8 指示書: 型とスキーマの整備

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## サブタスク

- ID: C8
- 目的: Task 12〜16 が使う型とスキーマを、collector の実際の出力に合わせて整える（レビュー指摘 R4、CC-009 の残り）。
- 設計書: `doc/design/2026-09-23-beaksight-foundation-corrections-design.md` の 第7章
- 実装計画: `doc/design/2026-09-23-beaksight-foundation-corrections-implementation-plan.md` の C8
- レビュー記録（指摘の詳細と再現条件）: 作業記録置き場（`.superpowers/sdd/2026-08-27-beaksight-implementation-plan/`）の `task-01-05-review-2026-09-23.md`（R4）
- 共通部品: `doc/design/beaksight-shared-components.md`、`src/core/`（deadline・errors・guards・immutable・text・limits）、`src/evidence/visibility.ts`
- これまでの修正の報告: 作業記録置き場の `F01-report.md`、`F02a-report.md`、`F02b-report.md`、`F02c-report.md`、および `C1-report.md`〜`C7-report.md`（各 collector の Evidence の形の変更の一覧）

このサブタスクは単独で実行します。

## 変更してよいファイル

- `src/core/contracts.ts`
- `src/core/evidence-types.ts`（新規。Evidence の payload の型を置く）
- `src/core/ids.ts`（`formatSequence` の検査を `isNonNegativeSafeInteger` に置き換えることだけ。F02c の発見事項1）
- `src/core/schema-validator.ts`
- `schemas/*.json`
- 各 collector（`src/evidence/*.ts`、`src/crawl/discover-links.ts`、`src/browser/controlled-scroll.ts`、`src/browser/page-settling.ts`、`src/interaction/isolated-auditor.ts`）: 型の定義を `src/core/evidence-types.ts` への import に置き換えることだけ。処理は変えない。
- テスト: `tests/unit/core-contracts.test.ts`、`tests/unit/schema-validator.test.ts`、および型の import の変更に伴う最小限の修正

## 修正する内容

- **Evidence の型の置き場**: 各 collector が独自に定義している Evidence の型（例: `LayoutEvidence`、`LinkEvidence`、color・performance・network・console・dom・accessibility・screenshot・interaction の Evidence の型）を、`src/core/evidence-types.ts` に移す。collector はそこから import する。`src/core/contracts.ts` の `EvidencePayloadByType` は、これらの型を参照する形にする。依存の向きは、`src/core` から `src/evidence` などへ依存しない形を保つ（`src/core` は、ほかのディレクトリを import しない）。
- **Evidence の種類**: Link と Color の Evidence の種類を加える。
- **観測状態**: `ObservationStatus`（`OBSERVED | NOT_OBSERVED | UNSUPPORTED`）を使う。
- **ページの結果**: `PageAuditResult` に、Desktop と Mobile それぞれの状態を持たせる（設計書 §9.3）。
- **run.json**: `RunSummary` と `schemas/run.schema.json` に、設計書 §18.1 と第35章の項目を加える。対象は、`startUrl`、`allowedOrigins`、`target.id`、environment、実効の設定、Safety Ledger の要約（ブロックした操作の件数、不変条件の違反の件数、記録が不完全かどうか）、未検証の Interaction の件数、クロールの上限の状態、toolVersion。
- **未完了の理由**: `incompleteReasons` を、理由コードと補足からなる構造の配列にする。理由コードは `as const` の配列から導出する閉じた union 型にする。値は、既存の `deriveRunStatus()` の入力と、各 collector の部分失敗の理由を網羅する。
- **Finding の category**: `Finding.category` を閉じた union 型にするための枠（型の名前と、値の配列の置き場所）を用意する。値は Task 12 で埋めるので、C8 では現在の `string` から変えなくてよい。型の名前と置き場所だけを決め、報告する。
- **スキーマ**: `schemas/*.json` を、上の型と一致させる。版は `*-schema/1.0` のまま（設計書 第7章）。`validateArtifact()` が、新しい形のサンプルを受け付け、必須項目が欠けたものを拒否することをテストで確かめる。
- **ids.ts**: `formatSequence` の検査を `isNonNegativeSafeInteger` に置き換える（振る舞いは変わらない）。

## 受け入れ条件

- 上の各項目について、修正前に RED になるテストを先に書き、修正後に GREEN になる。レビュー記録の「実測」の条件を、テストの入力に使う。
- 担当範囲の既存のテストと、`npm run typecheck` が PASS する。
- `npm run verify` が PASS する（このサブタスクでは build を実行してよい）。
- 型とスキーマの対応表（型の名前、スキーマのファイルと位置）を報告する。

## 報告

共通ルールの形式で報告してください。各項目（例: Q1、V4）ごとに、RED と GREEN の結果を示してください。

## 追加の指示（C4 の報告を受けて）

- controlled scroll の部分失敗の理由（`SCROLL_TARGET_UNRESOLVED`、`SCROLL_NOT_ADVANCED`、C4b で加わる理由）と、page-settling の `DOM_READINESS_FAILED` を、`incompleteReasons` の理由コードに含める。
- layout・color・screenshot の Evidence の型に、`scrollPosition` を反映する（作業記録置き場の `C4-report.md`）。

## 追加の指示（C7 の報告を受けて）

- C7 で変わった Evidence の形（console・network・accessibility・performance）は、作業記録置き場の `C7-report.md` にある。型はこれに合わせる。
- 理由コードには、performance の `RESOURCE_LIMIT_REACHED` と `INVALID_BROWSER_DATA`、accessibility の PARTIAL の理由（`DEADLINE_EXCEEDED`、`EVALUATION_FAILED`）を含める。

## 追加の指示（Task 12・13 の設計の確定を受けて）

- `Finding.category` の値は、`doc/design/2026-09-23-beaksight-task-12-13-rules-design.md` 第4章で決まった。`src/core/contracts.ts` に、`FINDING_CATEGORIES = ['HTTP','LINK','RESOURCE','JAVASCRIPT','DOM','FORM','ACCESSIBILITY','LAYOUT','PERFORMANCE','CROSS_PAGE','SAFETY'] as const` と、型 `FindingCategory` を定義し、`Finding.category` をこの型にする。`schemas/finding.schema.json` の category も enum にする。

## 追加の指示（C4b の報告を受けて）

- controlled scroll の理由のコード `INNER_SCROLL_CONTAINER_NOT_TRAVERSED`、`INNER_SCROLL_SCAN_LIMIT_REACHED` も、理由コードに含める。

## 追加の指示（C5・C5b・C6 の報告を受けて）

- dom・color の Evidence の形は `C5-report.md`、layout の形（戻り値の `status`、stress の幅ごとの結果、重なりと固定要素、`truncation`）は `C6-report.md` にある。型はこれに合わせる。
- 理由コードに `NAVIGATION_FAILED`（遷移の失敗）を加える。layout の stress の `stage:'NAVIGATION'` の失敗には、このコードを使うように `layout-collector.ts` の該当箇所を直す（型の import の置き換えと、この1点だけ）。

## 追加の指示（F04 の報告を受けて）

- `src/browser/page-settling.ts:105` 付近の `page.isClosed() ? 'PAGE_CLOSED' : 'EVALUATION_FAILED'` を、`src/browser/page-failure.ts` の `pageFailureReason` に置き換える（変更してよいファイルに `page-settling.ts` のこの箇所を含める）。
- `tests/integration/isolated-interaction.test.ts:4402` 付近の「does not verify an inert offscreen button ...」は、実行の時刻によって、期限切れの理由の文言が `No observable change before interaction deadline` と `Interaction deadline expired during post-condition observation` のどちらかになり、5回に2回失敗する。このテストの目的は、画面外の無反応なボタンを VERIFIED にしないことなので、次の形に直す。
  - 状態が `NOT_VERIFIABLE` であること。
  - VERIFIED でないこと。
  - 理由が、期限切れを表す理由のどれかであること。
  直した後、このファイルを5回続けて実行し、すべて PASS することを確かめる。
