# BeakSight Task 25 手動ログイン済みセッションの引き継ぎ 実装計画

作成日: 2026-10-10
状態: ユーザー承認済み（2026-10-10）
設計書: `2026-10-10-beaksight-task-25-manual-login-session-design.md`

## サブタスク

| ID | 内容 | 依存 | 状態 |
| --- | --- | --- | --- |
| T25a | 認証の設定の契約・スキーマ・検証（`src/control/auth/`、`schemas/control/auth-setup.schema.json`）、状態の絞り込みの純粋な部品、管理データの版 3（`auth_setups`）と保存の部品（設計書 4.1、4.3 の絞り込み） | G24 | 未着手 |
| T25b | 要求の判定の口（ログインの段の POST、監査の段の除外）と Guard の取り付けの指定（`request-policy.ts`、`passive-request-guard.ts`）。公開監査の golden を変えない（設計書 4.2） | G24 | 未着手 |
| T25c | 状態の注入の入口、Context ごとの順の受け継ぎ、セッションの切れの検出と Run の止め方（`context-factory.ts`、Run の流れ）、認証つきの Run では Interaction を行わない（設計書 4.3、4.7） | T25a、T25b | 未着手 |
| T25d | ワーカーの流れ（ログイン用の Browser、成功の判定、状態の取り出し、監査）と IPC（`START` の項目、`AUTH_STATE`）、ジョブの管理の開始の確かめ（設計書 4.4） | T25c | 未着手 |
| T25e | 画面（認証の設定、ログインの案内と状態）、今実行できるモードの拡張、文言（設計書 4.5） | T25d | 未着手 |
| T25f | 目印の検査（秘密の出力 0）、認証つきの Run の URL の query の伏せ字（`redact.ts`）、手順書（`doc/spec/`）（設計書 4.6） | T25e | 未着手 |
| T25R | 独立レビュー（読み取り専用。ログインの段の通信、移した後の Read-Only、秘密、公開監査の不変） | T25f | 未着手 |

- T25a（`src/control/`、`schemas/control/`）と T25b（`src/safety/`）は、変更するファイルが重ならないので並行してよい。

## 検証の決まり

- 全体の `npm run verify:all` は設計者が実行する。
- 実サイト・実テスト環境へは接続しない。テストは 127.0.0.1 の fixture だけ。Chromium は headless だけ（ログイン用の headed の Browser は、テストでは headless で代える）。
- 安全に関わる変更（T25b、T25c、T25d）は、テストの既定の Chromium と CLI の起動の設定の両方で確かめる。
- リポジトリの `local-data/` と出力先に書かない。
