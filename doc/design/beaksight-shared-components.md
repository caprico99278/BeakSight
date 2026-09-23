# BeakSight 共通部品台帳

最終更新: 2026-09-23

この台帳は、BeakSightで「同じ意味のものは1か所で定義し、ほかの場所はそれを使う」ための一覧です。
新しい関数、定数、型、文言を作る前に、同じ意味のものがここにないかを確認してください。
設計書で新しい共通部品を決めたときは、この台帳に追記します。

## 1. この台帳に載せないもの

主要な意味のowner（URL正規化、URL受け入れ判定、Link抽出、Crawl queue、Passive HTTPの安全判定、Interactionの受け入れ判定、ID・fingerprint、Run Status、Rule登録、Cross-page評価、Schema検証、最終artifactの書き出し）は、次の文書が定めています。この台帳には書き写しません。書き写すと、台帳と元の文書の内容がずれる原因になるためです。

- `doc/design/2026-08-27-beaksight-implementation-tasks.md` 第5章「SSOT Owner Matrix」
- `doc/design/2026-09-23-beaksight-ui-ssot-design.md` 第4章「追加するowner」（表示用語彙、書式、文言、表示用モデル、HTML部品、表示トークン、終了コード）

## 2. 既存の共通部品

2026-09-23時点で `src/`・`fixtures/` にあり、複数のモジュールから使われているもの、または使われるべきものです。

| 区分 | 名前 | 置き場所 | 責務 | 使ってよい場所 | 備考 |
| --- | --- | --- | --- | --- | --- |
| 型 | `RunStatus`、`PageAuditStatus`、`Severity`、`InteractionStatus` | `src/core/contracts.ts` | 状態と重大度の値の定義 | すべて | 表示のしかたは `src/presentation/catalog.ts`（Task 16で作成） |
| 型 | `EvidenceRecord`、`EvidenceType`、`Finding`、`PageAuditResult`、`RunSummary` | `src/core/contracts.ts` | Evidence・Finding・結果の契約 | すべて | `Finding.category` と `incompleteReasons` は `string`（UI追補設計書 4.3） |
| 型 | ブランド型のID（`RunId`、`PageId`、`EvidenceId`、`FindingId`） | `src/core/contracts.ts` | IDの取り違え防止 | すべて | 採番は `src/core/ids.ts` |
| 型 | `Viewport`、`AuditConfig`、`AuditConfigOverrides` | `src/config/types.ts` | 設定の型 | すべて | 設定の値は `loadConfig()` が決める |
| 定数 | `DEFAULT_CONFIG` | `src/config/defaults.ts` | 対象に依存しない既定の設定 | `src/config/**` と、テストでの設定の生成 | 実装タスク指示では `DEFAULT_POLICY` と呼ばれている |
| 定数 | `INTERACTION_CANDIDATE_LIMITS` | `src/safety/interaction-policy.ts` | Interaction候補の上限（`maxDomWork = 16_384` を含む） | interaction と、その collector | この値を別の場所で定義し直さない |
| 関数 | `freezeInteractionCandidate` | `src/safety/interaction-policy.ts` | Interaction候補の不変化 | interaction と、その collector | |
| 関数 | `isReadMethod` | `src/safety/request-policy.ts` | 読み取り専用のHTTPメソッドかの判定 | すべて | `GET` / `HEAD` の判定を別に書かない |
| 関数 | `redactHeaders` | `src/safety/redact.ts` | 機微なヘッダ値の伏せ字化 | Evidenceを記録するすべての場所 | |
| 関数 | `createCollectorHandle` | `src/evidence/collector-handle.ts` | collectorの開始・停止・結果取得の共通の形 | `src/evidence/**` | 現在は network と console が使用 |
| クラス | `SafetyLedger` | `src/safety/safety-ledger.ts` | ブロックした操作と不変条件違反の記録 | 安全判定を行うすべての場所 | 記録を別の場所に持たない |
| テスト補助 | `startFixtureServer` | `fixtures/server.ts` | ローカルfixtureサーバの起動と、サーバ側の変更系リクエストの計数 | `tests/**` | |

## 3. 決定済みで、まだ作られていない共通部品

| 区分 | 名前 | 置き場所 | 責務 | 作るTask | 根拠 |
| --- | --- | --- | --- | --- | --- |
| 表示 | 表示カタログ | `src/presentation/catalog.ts` | 表示用語彙 | Task 16 | UI追補設計書 第4章 |
| 表示 | 書式関数 | `src/presentation/format.ts` | 表示用の書式 | Task 16 | 同上 |
| 表示 | 文言カタログ | `src/presentation/messages.ts` | 利用者向けの日本語の文言 | Task 16、17 | 同上 |
| 表示 | 表示用モデル | `src/report/view-model.ts` | 表示用モデルと集計 | Task 16 | 同上 |
| 表示 | HTML部品 | `src/report/html-components.ts` | HTMLエスケープと部品 | Task 16 | 同上 |
| 表示 | 表示トークン | `src/report/html-tokens.ts` | CSSトークンとスタイルシート | Task 16 | 同上 |
| CLI | 終了コード表 | `src/cli/exit-codes.ts` | Run Statusから終了コードへの対応 | Task 17 | 同上 |
| 検査 | UI Gate | `tests/architecture/ui-ssot.test.ts` | 表示の共通化が崩れていないかの検査（1秒以内） | Task 16、17 | UI追補設計書 第6章 |

## 4. 共通化の候補（保留中）

既存コードで見つかった重複は、作業記録置き場の `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/commonization-candidates.md` に CC-001〜CC-012 として記録しています。
2026-09-23のユーザーの指示により、これらは**別途、開発指示があるまで保留**です。
新しいコードでは、これらの重複をさらに増やさないでください。例えば、期限付き待機、エラーの文字列化、`isRecord`、上限値を新しく書く必要が出たら、設計者に報告して置き場所の判断を仰いでください。

## 5. 更新履歴

| 日付 | 内容 |
| --- | --- |
| 2026-09-23 | 初版。既存の共通部品と、UI追補設計書で決めたownerを登録 |
