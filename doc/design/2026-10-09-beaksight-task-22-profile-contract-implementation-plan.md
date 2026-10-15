# BeakSight Task 22 監査プロファイルと互換性の Control 契約 実装計画

- 設計書: `2026-10-09-beaksight-task-22-profile-contract-design.md`
- ロードマップ: `2026-10-09-beaksight-task-22-32-roadmap.md` の Task 22

## 全体の制約

- Git の commit・push と、HEAD に戻す操作は禁止。報告は日本語。依存を変えない。実サイトにアクセスしない。`src/control/` 以外の production のファイルは変えない（例外は計画に書いたものだけ）。
- 実装者・調査担当・レビュー担当は Opus で起動する。

## サブタスク一覧

| ID | 内容 | 依存 | 状態 |
| --- | --- | --- | --- |
| T22a | 契約（`contracts.ts`）、スキーマ（`schemas/control/profile.schema.json`）、Control のスキーマの検証（`control-schema-validator.ts`）、一覧とスキーマの一致のテスト、`schema-enum-consistency.test.ts` の対応表 | なし | 完了（2026-10-09。fix-round-1 を含む） |
| T22b | 判定（`profile-policy.ts`。検証、旧 JSON の解決、改訂の単調増加）とテスト（組み合わせの表、旧 JSON の互換） | T22a | 完了（2026-10-09。Blocker 1 回を含む） |
| T22c | golden 回帰（Guard の判定の表、成果物のスキーマの版）、Architecture Gate（`src/control/` の import の向き）、`doc/spec/profiles.md` | T22b | 完了（2026-10-09） |
| T22R | 独立レビュー（読み取り専用。安全: SSOT、fail-closed、未監視の経路） | T22c | 完了（T22R で Important 2 件 → T22d で修正 → T22R2 で承認。Critical 0、Important 0） |

T22a〜T22c は同じテストの補助を触る可能性があるので、順に行う。

## T22a: 契約とスキーマ

- 新設: `src/control/contracts.ts`（設計書 4.1、4.4）、`schemas/control/profile.schema.json`（`$id` は `urn:beaksight:schema:control:profile:1`。`additionalProperties: false`）、`src/control/control-schema-validator.ts`（Ajv の設定は既存の `src/core/schema-validator.ts` に合わせる。`dist` からも `schemas/control/` を読めること）。
- テスト: `tests/unit/control-contracts.test.ts`（一覧とスキーマの enum の一致、受ける例と拒む例）、`tests/unit/schema-enum-consistency.test.ts`（対応表に Control の enum を追加。既存の行は変えない）。
- 受け入れ条件: RED → GREEN、`npm run build` の後に `dist/schemas/control/profile.schema.json` があること（ビルドの手順の変更が要るなら Blocker）。

## T22b: 判定

- 新設: `src/control/profile-policy.ts`（設計書 4.2、4.3）。
- テスト: `tests/unit/control-profile-policy.test.ts`、`tests/unit/control-legacy-profile.test.ts`（設計書 7）。
- 受け入れ条件: 組み合わせの表の受ける行と拒む行がすべてテストにある。旧 JSON の解決が `PUBLIC_PASSIVE`・`NONE`・空。ターゲット JSON にモードの鍵を書くと拒まれる。

## T22c: 互換の固定と文書

- テスト: `tests/unit/public-passive-golden.test.ts`（設計書 4.5）、`tests/architecture/` の Gate（違反を作って落ちることを一時の変更で確かめて戻す）。
- 文書: `doc/spec/profiles.md`（プロファイルの形、組み合わせの表、旧 JSON は `PUBLIC_PASSIVE`、まだ UI から使えない「開発中」）と、`doc/spec/README.md` の索引に 1 行。README には書かない。
- 受け入れ条件: `npm run verify` が通しで PASS（設計者が確かめる）。

## T22R: 独立レビュー

- 観点: 設計書 10 の完了条件、fail-closed（表にない組み合わせ、境界の値）、SSOT（判定が 1 か所、契約とスキーマの一致）、既存の公開監査の不変（Guard、CLI、出力）、Architecture Gate の抜け道、匿名化（実ドメイン・顧客名がない）。
- Critical 0・Important 0 で完了。その後にユーザーの承認（G22）。
