# F20b 指示書: F20 の Blocker の解消と、長い class の fail-closed

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## サブタスク

- ID: F20b
- 目的: F20 の Blocker を解消し、F20 の発見事項（長い class）を直す。
- 設計書: `doc/design/2026-09-23-beaksight-foundation-corrections-design.md` の 4.4.1（「長い class」）
- 前の報告: 作業記録置き場の `F20-report.md`

F20 の変更は、作業ツリーにそのまま残っています。HEAD に戻す操作は禁止です。

このサブタスクは単独で実行します。

## 変更してよいファイル

- `tests/integration/passive-request-guard.test.ts`（偽の handle の修正に限る）
- `src/safety/interaction-policy.ts`（`INTERACTION_CANDIDATE_LIMITS` に、class 専用の上限を加えることに限る）
- `src/interaction/discover-candidates.ts`
- `src/evidence/interaction-collector.ts`
- テスト: `tests/integration/isolated-interaction.test.ts`、`tests/unit/interaction-policy.test.ts`
- `fixtures/site/non-evidence-attribute-buttons.html` への追記

## 修正する内容

1. **Blocker の解消**
   - `passive-request-guard.test.ts` の偽の handle（1830行目付近）の `evaluate` が、`attributes: { complete: true, entries: [] }` も返すようにする。
   - 本物の `inspectInteractionCandidateHandle` と同じ形の記録を返すためであり、テストの期待値は変えない。
   - ほかにも同じ形の偽の handle があれば、同じように直し、報告する。
2. **長い class**
   - `INTERACTION_CANDIDATE_LIMITS` に、class 専用の上限（例: `maxClassAttributeLength: 4096`）を加える。
   - 属性の記録では、class の値だけを、この上限まで記録する。ほかの属性は、これまでどおり `maxAttributeLength` とする。
   - class 専用の上限でも切り詰められた可能性がある場合は、class の変化を根拠にしない（fail-closed）。
   - 記録の検証（`discover-candidates.ts` の953行目付近の長さの確認など）も、class 専用の上限に合わせる。
   - 回帰テスト（修正前は RED になること）:
     - class が600文字程度の何もしないボタンで、focus で `focus-visible` の class が付き、pointerdown で外れる場合: NOT_VERIFIABLE になる（修正前は VERIFIED）。
     - class が600文字程度で、click で `is-open` の class を切り替えるトグル: VERIFIED になる。
     - class が4096文字を超えるトグル: ARIA の状態がなければ、NOT_VERIFIABLE になる（fail-closed）。
     - class が4096文字を超え、ARIA の状態が変わるトグル: VERIFIED になる。

## 受け入れ条件

- 各項目で、修正前に RED、修正後に GREEN になる。項目1は、修正前に2件失敗していることを RED とする。
- 既存のテストは、すべて PASS する。
- `tests/integration/isolated-interaction.test.ts` を2回続けて実行し、2回ともすべて PASS する。
- `npm run verify` が PASS する。このサブタスクでは build を実行してよい。

## 報告

共通ルールの形式で、日本語で報告してください。
