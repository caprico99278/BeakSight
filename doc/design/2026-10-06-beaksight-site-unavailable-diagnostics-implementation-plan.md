# BeakSight サイトの不調で止めたときの診断の記録 実装計画

設計書: `doc/design/2026-10-06-beaksight-site-unavailable-diagnostics-design.md`
目標: サイトの不調で捨てたページの監査の記録と、ページ本体の要求がネットワークへ送られたかの観察を、`diagnostics/` に残す。
作業記録置き場: `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/`

## 全体の制約

- 実装者は Git の commit・push をしない。HEAD に戻す操作も禁止。表示だけの Git のコマンドは使ってよい。
- 依存パッケージの追加・更新をしない。実在の外部のサイト（本来の監査対象のサイトを含む）にアクセスしない。`local/` と `artifacts/` を読まない。検証はローカルの fixture で行う。
- テストの Chromium は headless だけで起動する。
- Guard（`src/safety/**`）は変えない。

## サブタスク一覧

| ID | 内容 | 依存 | 状態 |
| --- | --- | --- | --- |
| D1 | 観察の部品（`src/browser/navigation-diagnostics.ts`）。Page Auditor の Passive の読み込みで観察し、`PageAuditOutcome` に持たせる | なし | 完了（2026-10-06） |
| D2 | 診断のファイル（スキーマ、置き場所、ArtifactWriter の書き出し、Run Coordinator の呼び出し）と README。結合テスト | D1 | 完了（2026-10-06） |
| D3 | 観察を幅の走査と Interaction の候補の読み込みに広げる（設計書 2.2 の 2026-10-07 改訂）。スキーマと診断のファイルに幅ごと・候補ごとの観察を加える。production の振る舞いは変えない | D2 | 完了（2026-10-07） |
| D3R | D3 の独立レビュー（読み取り専用） | D3 | 承認（2026-10-07。修正 1 回の後、Important 0） |
| DR | 独立レビュー（読み取り専用。PC1 と合わせて行ってよい） | D2 | 完了（2026-10-06。PC1 と合わせて。修正1回の後に承認） |
