# BeakSight Task 27 READ の検証と、副作用のない操作の候補の発見 実装計画

作成日: 2026-10-11
状態: ユーザー承認済み（2026-10-11。設計書の承認に含む）
設計書: `2026-10-11-beaksight-task-27-read-and-discovery-design.md`

## サブタスク

| ID | 内容 | 依存 | 状態 |
| --- | --- | --- | --- |
| T27a | 候補の契約（型、理由のコードと分類の閉じた一覧）、JSON Schema（`candidate.schema.json`）、指紋（識別と入力規則の 2 つの digest）、分類（表で駆動する純粋な関数。発見の分類の危険な語の一覧（英語と日本語））（設計書 4.1、4.3、4.4） | G26 | 未着手 |
| T27b | 発見の probe（1 回の `page.evaluate`、標準の prototype の getter）、JS の結び付き（CDP の `DOMDebugger.getEventListeners`）、落ち着きの待ち（SPA）、凍結、不完全の記録、書き込み 0 の fixture（2 つの Chromium）、Gate（発見のコードが入力の操作を呼ばない、`src/discovery/` の境界）（設計書 4.2） | T27a | 未着手 |
| T27c | 管理データの版 5（先に版 4 の CHECK の一覧を写しで固定し、版 1〜4 の文の SHA-256 を固定）、ジョブの種類 `DISCOVERY`・`READ_CHECK`、`discovery_candidates`・`read_checks`・`read_check_results`、READ の定義の検証（秘密に見える名前の拒否、送る欄の決まり、期待の閉じた一覧）（設計書 4.5、4.6） | T27a | 未着手 |
| T27d | `DISCOVERY` のジョブ（ワーカー、ログインの段の後の巡回の範囲、成果物 `discovery.json`、索引の更新、ドリフト）（設計書 4.2、4.4、4.6） | T27b、T27c | 未着手 |
| T27e | READ の実行（URL の組み立て、事前の判定、候補のドリフトの確かめ、読み込みの間隔、構造化、照合、伏せ字、成果物 `read-evidence.json`）と `READ_CHECK` のジョブ（設計書 4.5） | T27d | 未着手 |
| T27f | 画面（候補の一覧とドリフト、READ の定義の作成・編集・削除、結果、ジョブの開始と進捗）、文言とカタログ（設計書 4.7） | T27e | 未着手 |
| T27g | 目印の検査（値・トークン・label が索引と画面に出ない）、公開監査と認証つきの監査の回帰、手順書（`doc/spec/`）（設計書 4.8） | T27f | 未着手 |
| T27R | 独立レビュー（読み取り専用。発見の書き込み 0、分類と実行の権限、READ の要求、秘密、公開監査の不変） | T27g | 未着手 |

- T27b（`src/discovery/` のブラウザの部品）と T27c（`src/control/` と管理データ）は、変更するファイルが重ならないので並行してよい。

## 検証の決まり

- 全体の `npm run verify:all` は設計者が実行する。
- 実サイト・実テスト環境へは接続しない。テストは 127.0.0.1 の fixture だけ。Chromium は headless だけ。
- 安全に関わる変更（T27b、T27d、T27e）は、テストの既定の Chromium と CLI の起動の設定の両方で確かめる。
- リポジトリの `local-data/`、`local/`、出力先に書かない。
