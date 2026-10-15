# BeakSight Task 24 既存の公開監査を管理画面から動かす 実装計画

作成日: 2026-10-09
状態: 承認済み（2026-10-09 のユーザーの指示による）
設計書: `2026-10-09-beaksight-task-24-ui-public-audit-design.md`

## サブタスク

| ID | 内容 | 依存 | 状態 |
| --- | --- | --- | --- |
| T24a | 監査の中核の切り出し（設計書 4.1）。`runAuditCommand` を型つきの中核と CLI の表示に分ける。観測の口。例外から終了コードへの変換の共用。CLI の出力を 1 文字も変えない | G23 | 完了 |
| T24b | DEF-056（`isPortableRelativeArtifactPath` の強化）と、リンクをたどらない成果物の読み取りの部品（`src/core/`）（設計書 4.5、4.7） | G23 | 完了 |
| T24c | DEF-057（開始のロック）（設計書 4.6） | T24a | 完了 |
| T24d | IPC の契約とスキーマ（`src/control/worker-protocol.ts`、`schemas/control/worker-message.schema.json`）、ワーカー（`src/worker/audit-worker.ts`）、Gate（設計書 4.2、4.3） | T24a | 完了 |
| T24e | ジョブの管理（`src/control/job/`、管理データの版 2、今実行できるモードの owner の移動、開始・停止・見張り・起動のときの直し）（設計書 4.4） | T24d | 完了 |
| T24f | 画面（開始、進捗、停止、一覧、詳細、成果物の Server Routes）、画面のサーバの終わりの処理、`ui` のスクリプト（設計書 4.5、4.8、4.9） | T24b、T24e | 完了 |
| T24g | CLI と画面の比べの結合テスト、落ちたときの再開の結合テスト、負荷の確かめ、文書（`local-ui.md`、`cli.md`）（設計書 7 章） | T24c、T24f | 完了 |
| T24R | 独立レビュー（読み取り専用。ワーカーと IPC の信頼の境界、同時に 1 ジョブ、成果物の取り出し、CLI の不変、負荷） | T24g | 完了 |

- T24a と T24b は変更するファイルが重ならないので並行してよい。T24c と T24d は、どちらも T24a の後で、T24c は開始の段（`src/cli/` か `src/orchestration/`）、T24d は `src/worker/`・`src/control/worker-protocol.ts` を変える。重なる場合は順に行う。

## 検証の決まり

- 全体の `npm run verify:all` は設計者が実行する。
- 実サイトへは接続しない。テストは 127.0.0.1 の fixture のサーバだけ。Chromium は headless だけ。安全に関わる変更（ワーカー、CLI の中核、開始のロック）は、テストの既定の Chromium と CLI の起動の設定の両方で確かめる。
- リポジトリの `local-data/` と、リポジトリの出力先（`artifacts/` など）に書かない。テストは一時の root と一時の出力先だけを使う。
