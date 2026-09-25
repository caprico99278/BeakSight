# F17b 指示書: Interaction の時間の定数の置き場所と、スキーマの下限の一致

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## サブタスク

- ID: F17b
- 目的:
  - F17 で `src/config/validate-config.ts` に置いた Interaction の時間の定数を、`src/core/limits.ts` に移す。いまは `src/interaction` が設定の検証のモジュールを参照しているが、それをなくすためである。
  - 設定のスキーマの下限を、定数と一致させる。
- 背景: F17 の実装報告の発見事項1と3。設計者が指示書の「変更してよいファイル」に `src/core/limits.ts` を入れていなかったため、F17 では置き場所を選べなかった。

このサブタスクは単独で実行します。

## 変更してよいファイル

- `src/core/limits.ts`
- `src/config/validate-config.ts`
- `src/interaction/isolated-auditor.ts`（import の変更に限る）
- `schemas/run.schema.json`
- テスト: `tests/unit/config.test.ts`、`tests/unit/limits.test.ts`、`tests/unit/schema-validator.test.ts`

## 修正する内容

1. 次の定数を `src/core/limits.ts` に移す。値は変えない。
   - `INTERACTION_STABILITY_WINDOW_MS`
   - `INTERACTION_PERSISTENCE_WINDOW_MS`
   - `MIN_INTERACTION_TIMEOUT_EXCLUSIVE_MS`
2. `validate-config.ts` と `isolated-auditor.ts` は、`src/core/limits.ts` から参照する。`src/interaction` から `src/config/validate-config.ts` への import がなくなったことを、`grep` で確かめて報告する。
3. `schemas/run.schema.json` の設定の `interactionTimeoutMs` の `minimum` を、`MIN_INTERACTION_TIMEOUT_EXCLUSIVE_MS + 1` にそろえる。スキーマに `exclusiveMinimum` を使ってもよい。
4. スキーマの下限と定数が一致することを確かめるテストを加える。テストでは、定数を実行時に読んでスキーマの値と比べる。

## 受け入れ条件

- スキーマのテストで、下限より小さい値を拒否し、下限の値を受け付けることを確かめる。修正前に RED、修正後に GREEN になること。
- `npm run verify` が PASS する（このサブタスクでは build を実行してよい）。

## 報告

共通ルールの形式で報告してください。
