# DEF-001b 指示書: accessibility の Evidence に、検査の範囲の制約を記録する

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## サブタスク

- ID: DEF-001b
- 目的: DEF-001 で axe をレガシーの方式に切り替えた。この方式では、別Originの iframe の中は検査されない。そのため、accessibility の Evidence に「検査の範囲は、同じOriginの文書に限られる」ことを記録する。
- 背景: 作業記録置き場の `DEF-001-report.md`。設計書 `doc/design/2026-09-23-beaksight-foundation-corrections-design.md` の 8.1 の2。

このサブタスクは単独で実行します。

## 変更してよいファイル

- `src/core/evidence-types.ts`（`AccessibilityEvidence` の型に項目を1つ加えるだけ）
- `schemas/page.schema.json`（`accessibilityEvidence` に項目を1つ加えるだけ）
- `src/evidence/accessibility-collector.ts`
- テスト: `tests/component/accessibility-collector.test.ts`、`tests/unit/schema-validator.test.ts`、`tests/unit/core-contracts.test.ts`、および見本の修正が必要なテスト

## 修正する内容

- `AccessibilityEvidence` の COMPLETE と PARTIAL の両方の形に、必須の項目 `frameScope: 'SAME_ORIGIN_ONLY'` を加える（リテラル型）。
- スキーマでは、`"frameScope": { "const": "SAME_ORIGIN_ONLY" }` を加え、`required` に含める。
- collector は、常にこの値を入れる。

## 受け入れ条件

- 修正前は、`frameScope` がないことで RED になるテストを書き、修正後に GREEN になる。
- `frameScope` がない Evidence を、スキーマが拒否する。
- `npm run verify` が PASS する（このサブタスクでは build を実行してよい）。

## 報告

共通ルールの形式で報告してください。

## 追加の指示（F05 の報告を受けて）

- `src/safety/interaction-policy.ts:109` 付近には、href の種類の値の一覧 `['NONE', 'SAME_ORIGIN_HTTP', 'EXTERNAL_ORIGIN_HTTP', 'SPECIAL_SCHEME', 'MALFORMED']` が、実行時の配列としてもう一度書かれている。これを次のように直す。
  - `src/core/evidence-types.ts` に、frozen の定数 `INTERACTION_HREF_KINDS` を置く。
  - 型 `InteractionHrefKindEvidence` は、その定数から導く。
  - `interaction-policy.ts` は、その定数を使う。
- 振る舞いは変えない。
- 変更してよいファイルに、`src/safety/interaction-policy.ts` と `tests/unit/interaction-policy.test.ts` を加える。
