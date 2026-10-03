# F12 実装報告（要約。設計者が保存）

## 結論

完了した。

- スキーマの enum の59件すべてを、`src/core/` の `as const` の凍結した配列に対応づけた。TypeScript の型は、その配列から導く形にした。
- 一致の確認は、`tests/unit/schema-enum-consistency.test.ts` の1つのファイルでまとめて行う。確認は両方向である（表にない enum がないこと、スキーマにない行がないこと）。所要時間は約243ms。
- scroll の Evidence に、`targetSwitchCount` を加えた。修正前に RED、修正後に GREEN になることを確かめた。
- `npm run verify` の終了コードは0だった（40ファイル・1275件が PASS した）。

## core に新しく置いた配列（29個）

- `contracts.ts`（5個）
  - `RUN_STATUSES`、`PAGE_AUDIT_STATUSES`、`SEVERITIES`、`INTERACTION_STATUSES`、`EVIDENCE_TYPES`
- `evidence-types.ts`（24個）
  - scroll: `SCROLL_TARGETS`、`SCROLL_RESTORATION_FAILURE_REASONS`
  - console: `CONSOLE_MESSAGE_TYPES`
  - DOM: `SEMANTIC_REGION_KINDS`、`VISIBLE_TEXT_SOURCES`、`SUBMIT_CONTROL_TYPES`
  - layout: `FIXED_ELEMENT_POSITIONS`、`LAYOUT_INCOMPLETE_REASONS`、`STRESS_LAYOUT_FAILURE_STAGES`、`STRESS_LAYOUT_FAILURE_REASONS`
  - color: `COLOR_UNAVAILABLE_REASONS`
  - performance: `UNOBSERVED_WEB_VITAL_STATUSES`、`WEB_VITAL_NAVIGATION_TYPES`、`INP_INTERACTION_TYPES`、`SERVER_TIMING_SOURCES`、`RESOURCE_CATEGORIES`、`RESOURCE_CATEGORY_BASES`、`TELEMETRY_HEADER_DIRECTIONS`、`TELEMETRY_MATCHING_BASES`、`PERFORMANCE_INCOMPLETE_REASONS`
  - accessibility: `ACCESSIBILITY_IMPACTS`、`ACCESSIBILITY_INCOMPLETE_REASONS`
  - interaction: `INTERACTION_IDENTITY_STATUSES`
  - screenshot: `SCREENSHOT_CAPTURE_TYPES`

## 発見事項と、設計者の判断

1. `dom-collector.ts:554` の「入力欄として扱わない input の type」は、`SUBMIT_CONTROL_TYPES` とは別の概念である。→ 承認する。
2. `isolated-auditor.ts:149` は、型の値の一部だけを使っている。値の一覧を写したものではない。→ 承認する。
3. 共通部品台帳への登録。→ 設計者が行う。
4. `targetSwitchCount` の上限は、スキーマに書いていない。数値を定義元の外に書かないためである。→ 承認する。
