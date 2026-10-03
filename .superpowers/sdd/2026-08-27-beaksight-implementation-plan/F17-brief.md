# F17 指示書: Interaction の期限の下限と、変わった属性の名前の切り捨ての記録

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## サブタスク

- ID: F17
- 目的: F16 の報告の発見事項5と7を直す。
- 背景: 作業記録置き場の `F16-report.md`

このサブタスクは単独で実行します。

## 変更してよいファイル

- `src/config/validate-config.ts`
- `src/interaction/isolated-auditor.ts`（期限の下限の定数を公開する必要がある場合に限る）
- `src/evidence/interaction-collector.ts`
- `src/core/evidence-types.ts`、`schemas/page.schema.json`
- テスト: `tests/unit/config.test.ts`、`tests/integration/isolated-interaction.test.ts`、`tests/unit/schema-validator.test.ts`、`tests/unit/core-contracts.test.ts`

## 修正する内容

1. **Interaction の期限の下限（発見事項5）**
   - `interactionTimeoutMs` が、下準備（hover、focus、落ち着くのを待つ時間、安定性の確認）と持続の確認を行える長さより短い場合は、設定のエラーにする。
   - 下限の値は、isolated-auditor の時間の定数（`STABILITY_WINDOW_MS`、`PERSISTENCE_WINDOW_MS` など）から導き、一か所で定義する。定義の置き場所は、設定の検証から参照できる場所にする。`src/config` が `src/interaction` に依存するのは避ける。たとえば、時間の定数を `src/core/limits.ts` か、`src/safety/interaction-policy.ts` の `INTERACTION_CANDIDATE_LIMITS` に移す。移したら、isolated-auditor もそこから参照する。値は変えない。
   - 下限より短い値が拒否され、既定値（3,000ms）が受け付けられることを、テストで確かめる。
2. **切り捨ての記録（発見事項7）**
   - `changedAttributes` を上限（`MAX_CHANGED_ATTRIBUTE_NAMES`）で切り詰めた場合は、切り詰めたことを Evidence に残す（例: `changedAttributesTruncated: boolean`）。
   - 型、スキーマ、テストを直す。
   - 33個以上の属性が変わる場合に、印が立つことを確かめる。

## 受け入れ条件

- 各項目で、修正前に RED、修正後に GREEN になる。
- `npm run verify` が PASS する（このサブタスクでは build を実行してよい）。

## 報告

共通ルールの形式で報告してください。
