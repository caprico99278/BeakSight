# BeakSight 次期開発 正式ロードマップ — Task 22〜32

> **For agentic workers:** 本書は設計・実装・レビューの共通入力仕様である。各Taskは個別に `[REQ] → 設計 → レビュー → 実装 → 証拠付き検証 → 完了判定` を行う。未承認の実サイト接続・Git commit/push・スコープ拡張は禁止。

**文書版:** 1.0 / 2026-10-09  
**基準実装:** `BeakSight-20261009_005544.zip`（ユーザー申告によりTask 21完了版）  
**Goal:** Task 21までの公開サイトRead-Only監査を壊さず、サイト別モード管理、TanStack Start製ローカルUI、テスト環境に限定した認証付き監査、および人間が承認したシナリオに基づくREAD/CREATE/UPDATE検証を段階的に完成させる。  
**Architecture:** 既存監査エンジンと安全制御を単一の実行基盤として保持する。ローカルUIは監査の選択・実行管理・証拠閲覧・承認操作を受け持つが、通信可否と書き込み権限の最終判定は独立したサーバー／実行ワーカーのポリシーで強制する。  
**Tech Stack:** Node.js 24系、TypeScript、Playwright、Vitest、React/TSX、TanStack Start（Router・Server Functions・Server Routes）、必要部分にTanStack Query/Form、SQLite（ローカル管理情報用）。  
**Spec:** 本書第1〜9章の確定要件・契約・安全性仕様を正とし、第10章のTask実装計画がこれを実現する。別途作成する詳細設計はこの契約を変更してはならない。  
**位置づけ:** 正式な次期「要求・アーキテクチャ・実装ロードマップ」入力。具体的なコードはまだ作成しない。数値の提案既定値と操作者が対象サイトごとに入力する値を明確に区分する。

---

## 1. 出発点と確認できた事実

### 1.1 現行ソースで確認した範囲

基準ZIPには `src/`・`config/targets/example.json`・`schemas/`・`package.json`・`package-lock.json`・TypeScript設定が含まれる。**テストソース・全体設計書・Git履歴はこのZIPには含まれない。** よってTask 21完了はユーザーの確定事項として扱い、ZIPだけから未収録テストのPASS件数やGit状態を捏造しない。Task 22着手時は完全な作業リポジトリの既存テスト・設計書を必ず再確認する。

| 現行SSOT／入口 | 役割・現行契約 | 次期での扱い |
|---|---|---|
| `src/cli/index.ts` / `src/cli/main.ts` | CLI `run` / `validate-config`、従来終了コード | 互換維持。UI専用処理で既定のCLI契約を変えない |
| `src/cli/run-command.ts` | Run開始・再開・成果物確定 | 公開監査は同一経路を利用。結果確定処理を複製しない |
| `src/config/types.ts` / `src/core/evidence-types.ts` | `AuditConfig` = `EffectiveAuditConfig` | 既存型と`run-schema/1.0`を維持。モード情報は別管理契約に置く |
| `src/config/defaults.ts` / `src/config/load-config.ts` / `src/config/validate-config.ts` | CLI設定の既定・読み込み・検証 | 従来ターゲットJSONの形を維持する |
| `src/orchestration/run-coordinator.ts` | Run、進捗、停止、再開・状態意味論のSSOT | CLI/UIとも同じ結果意味論を用いる |
| `src/browser/context-factory.ts` | Browser/Context生成とGuard取付のowner | 将来の認証／許可モードでも無防備なContextを作らせない |
| `src/safety/request-policy.ts` / `src/safety/passive-request-guard.ts` | 従来モードのGET/HEAD限定・危険な通信等の遮断 | **PUBLIC_PASSIVEでは変更禁止の基準動作**。認証や書き込みのためにグローバル緩和しない |
| `src/safety/safety-ledger.ts` | 安全に関する実績記録 | 既存を残し、追加モード専用の許可／拒否証跡を追加する |
| `src/core/artifact-layout.ts` / `src/report/artifact-writer.ts` | Run成果物名・配置・出力owner | 既存の成果物契約を維持。操作検証用成果物は別スキーマにする |
| `schemas/run.schema.json` 等 | 既存監査の成果物契約 | 非破壊で維持。新しい契約は`schemas/control/`に分離する |

`package.json`で確認した環境は、Node `>=24 <25`、TypeScript `7.0.2`、Playwright `1.62.1`、Vitest `4.1.10`。現行`npm run verify`は`typecheck → test → build`。これらを基準に追加UIのビルド手順を設計する。UI依存導入時は対応するNodeバージョン・lockfile・Windows環境での起動検証を実施し、互換性に影響する更新を独断で行わない。

現行の主な既定値は`maxPages=500`、`maxDepth=20`、`maxRuntimeMs=3,600,000`、`minNavigationIntervalMs=5,000`、`maxInteractionsPerPage=20`、同時実行は従来の一件ずつの前提。**5秒の間隔はページ本体のナビゲーション開始に対するもので、サブリソース要求全体のレート制御ではない。** 次期で意味を勝手に変更しない。

### 1.2 ユーザーが確定した要求（変更不可の基準）

| ID | 要求 | 成功判定 |
|---|---|---|
| R01 | Task 21以前の公開サイト監査を存続 | ログインなし・CRUDなし・Read-OnlyでCLI/UIから実行可能 |
| R02 | **サイトごと、必要なら同じサイトの環境ごと**に監査方式を選ぶ | プロファイル保存と切替に成功し、別プロファイルの権限が混ざらない |
| R03 | 新しい認証付き監査とデータ操作は**テスト環境限定** | 本番・不明な環境では認証自動化と書き込みが開始できない |
| R04 | 認証は手動ログイン済みセッション引継ぎを先行、次に自動ログイン | 双方がテスト環境で独立に動作する |
| R05 | ローカルWeb管理UIを実装 | UIからサイト・実行・結果・承認を操作でき、従来CLIも存続 |
| R06 | TypeScript / React / **TanStack Start**を採用 | 実行可能なローカルUIを提供。不要な機能は導入しない |
| R07 | 画面から登録・更新操作の候補を自動発見 | 発見だけでは副作用が起きず、候補と根拠を提示できる |
| R08 | **人間は業務操作シナリオ単位で承認** | 対象・操作・入力規則・送信先・副作用・上限を一括承認できる |
| R09 | 承認済みシナリオは保存・条件付きで再利用 | 承認条件不変なら毎Run再承認不要。変更時は再承認 |
| R10 | 対象操作はREAD/CREATE/UPDATE。**DELETEは除外** | HTTP DELETEだけでなく論理削除や削除相当の副作用も禁止 |
| R11 | テスト環境はあるが、**データ初期化・復元機構なし** | ロールバック依存の検証手順を採らない |
| R12 | CREATEは毎Runで新しいテストデータを生成 | 登録結果をREADで照合。重複・蓄積を制限 |
| R13 | 自然で業務に合った合成データを生成 | 項目間に整合性があり、ダミーと識別でき、実個人情報を流用しない |
| R14 | **データ生成にLLMを使わない** | 固定ルール・業務テンプレート・人間の補完のみで決定論的に生成 |
| R15 | 人間が実行内容を理解して承認できるUI | シナリオ差分、ルール、入力例、危険性、実行上限を提示 |
| R16 | 顧客名・実サイトドメイン等を汎用リポジトリ文書へ直書きしない | 設計・fixtureは架空・匿名化情報のみ |
| R17 | Git管理は維持するが、**設計者／実装者はcommit・pushしない** | 読み取り調査や差分確認は可能。書き込みGit操作はしない |
| R18 | 既存のSafety Gate、誠実なPARTIAL/FAILED判定を継承 | 偽のCOMPLETE、危険操作、無断サイト実行がない |

### 1.3 本書の設計上の採用値（ユーザー確定事項とは区別）

以下は、実装の空白を残さないための**提案初期値**であり、人間が正式設計レビューで変更可能。ただし無制限に緩和せず、変更理由とテストを記録する。

| 設定 | 提案初期値・ルール |
|---|---|
| CREATE回数上限 | 1シナリオあたり1 Runで最大1件、累積20件。数値変更は明示的なシナリオ再承認 |
| 書き込み同時実行 | 全プロセスを通じ1件。重複起動不可 |
| シナリオ承認の有効期間 | 初回は30日。失効・撤回・対象変更で再承認 |
| 再試行 | CREATE/UPDATEを**送信した可能性がある場合**は自動再試行0回 |
| テスト環境のHTTP | 原則HTTPS。`localhost`のHTTPのみ個別に明示許可可能 |
| SQLite | Node 24.15以降の`node:sqlite`を候補として固定し、Task 23で正式採用可否を互換試験。実行不能時は別DBへ黙って切替えず設計レビューに戻す |
| サイト固有の未確定値 | 既定推定・勝手な登録はせず、入力不足としてUIに表示し停止 |

## 2. スコープと非スコープ

**対象:** 公開サイトRead-Only監査の継承、サイト／環境別設定、TanStack StartローカルUI、CLI/UI共通実行管理、テスト環境での合法的なログイン・認証セッション・監査、READ/CREATE/UPDATE候補の発見・承認・実行・証拠化、シナリオ永続化、ルールベースデータ生成、最終回帰。

**明示的対象外:** 本番環境への自動ログイン・認証付き監査・書き込み、DELETEおよび論理削除、DB初期化／バックアップ復元／ロールバックの自動化、LLM、外部クラウドUI公開、複数人向け権限管理、汎用RPAや無承認の自己判断実行、認証回避・CAPTCHA/MFA回避・アクセス制御突破、公開リポジトリへの顧客データ登録、全業界・全フォームの完全自動化保証。

**補足:** HTTP POSTはログインにも使われるため、`ログイン通信の最小例外`と`業務データへの書き込み`を完全に別許可として扱う。ログインPOSTを許すことが任意のPOSTを許すことにはならない。

## 3. 三つの監査モードと安全不変条件

### 3.1 プロファイルモード

| モードID（契約値） | 対象 | 認証 | 業務操作 | ネットワーク権限 |
|---|---|---|---|---|
| `PUBLIC_PASSIVE` | 公開サイト／一般の既存ターゲット | 不要・自動ログインなし | 従来のRead-Only監査のみ | **従来のPassive Guardを変更せず使用** |
| `TEST_AUTH_PASSIVE` | 明示登録されたテスト環境のみ | 手動または自動、正規認証 | 認証後はRead-Only監査 | 認証準備時だけ許可された認証通信。監査時はPassive Guard |
| `TEST_APPROVED_WRITE` | 明示登録されたテスト環境のみ | 承認された認証方式 | READ/CREATE/UPDATEの承認済みシナリオ | 当該シナリオの許可要求だけ通信可。既定拒否 |

**プロファイルはサイト識別子だけでなく環境識別子を持つ。** 同じサービスの本番公開ページとテスト管理画面を同一設定に混ぜない。モードをUIで変更しても実行時のサーバー側検証・承認照合を省略しない。

### 3.2 絶対不変条件（I01〜I16）

1. **I01:** 無指定・旧ターゲットJSONは必ず`PUBLIC_PASSIVE`に解決。既定で権限が増えない。
2. **I02:** `PUBLIC_PASSIVE`は従来のリクエスト分類、Guard、URL処理、停止・再開、出力スキーマを保持。
3. **I03:** 対象URLの文字列や「staging」という名前だけでテスト環境と見なさない。人間の環境登録・テスト隔離確認・検証済みOrigin/接続先照合が必須。
4. **I04:** 本番・未承認Origin・DNS/リダイレクト先不一致・不明な環境で認証通信や業務書き込みを許可しない。
5. **I05:** 認証操作は対象とログイン経路を許可した**正規の資格情報・セッションのみ**。突破・回避・総当たりをしない。
6. **I06:** シナリオ候補の探索・事前表示ではネットワーク上の副作用を起こさない。
7. **I07:** 承認対象は操作名だけでなく、対象プロファイルの改訂版、フォーム／操作識別、method、Origin、エンドポイント／入力規則／許容副作用／上限を固定。
8. **I08:** UI承認は権限の十分条件ではない。実行ワーカーの境界で要求ごとに再照合し、非許可要求を送出前に遮断。
9. **I09:** DELETE、論理削除、キャンセル、無効化、一括削除等の**実質的な破壊的変更**は認めない。HTTPメソッドだけで判定しない。
10. **I10:** 承認があるCREATE/UPDATEでも、未確認の通知・課金・外部連携・メール/SMS送信等の副作用を許可しない。外部接続遮断・テスト用sinkの証拠がなければ停止。
11. **I11:** 監査中のCookie、セッショントークン、パスワード等はUI・ログ・通常ZIPに出さず、可能な限りメモリのみ。保管例外は別設計承認を要する。
12. **I12:** 作成データを追跡し、成功・失敗・不明を正確に記録。送信済みの可能性があるCREATE/UPDATEは盲目的にリトライしない。
13. **I13:** 削除・環境初期化がないため、件数上限・登録台帳・データ所有マーカー・対象限定UPDATEを必須とする。
14. **I14:** 実装されていない入力規則、未知のエンドポイント、曖昧な作用、環境識別失敗は`BLOCKED/NEEDS_REVIEW`で止める。適当な推定値で通さない。
15. **I15:** 新しい`ActionRun`の成功／部分成功を、既存の監査`RunStatus`へ都合よく書き換えない。必要な証拠が無い場合はCOMPLETEにしない。
16. **I16:** 実サイト接続は所有者の明示承認ゲートを通す。Task 22〜32の通常検証はローカルfixture主体で進める。

## 4. アーキテクチャと実行境界

```text
[ローカルブラウザ]
    |
    v
[apps/local-ui : TanStack Start / React]
  Router: サイト・プロファイル・Run・レポート・承認
  Query : 非同期Runの進捗と再取得
  Form  : 動的なシナリオ／規則編集
    |
    | Server Functions / Server Routes（Origin・CSRF・セッション照合）
    v
[Control Plane : Node/TypeScriptサーバー専用]
  ProfileRegistry / ApprovalStore / QuotaLedger (SQLite)
  EnvironmentPreflight / ScenarioCompiler / JobManager
    |
    | 版付きIPC、型・スキーマ検証、プロセス境界
    v
[BeakSight Worker]
  PUBLIC_PASSIVE --------> 既存runAuditCommand + 既存Passive Guard
  TEST_AUTH_PASSIVE -----> 認証準備 → 既存Guard付き監査Context
  TEST_APPROVED_WRITE --> 既存のContext生成ownerを経由し、
                           承認・送信先・操作内容を厳密に照合する独立許可ポリシー
    |
    v
[既存Run成果物 / ActionRun専用成果物 / 安全台帳]
```

### 4.1 責務のownerと変更規則

- **UI:** 表示・人間の意思決定・依頼送信のみ。書き込み許可ロジックをブラウザJavaScriptに置かない。
- **Control Plane:** プロファイル、承認、取り消し、上限、永続履歴、Job開始・停止のowner。すべてのサーバー関数・ルートは独立して要求認可。
- **実行ワーカー:** Playwrightを保持。UIサーバーのHTTPリクエストを監査終了まで占有しない。`RunCoordinator`の進捗・結果を構造化IPCで返す。
- **安全な通信許可:** Browser/Context作成ownerを増やさず、開始前にモード別のガードを取り付ける。未監視のブラウザ・iframe・popup・worker・Service Worker・WebSocket・redirect経路を作らない。
- **既存監査結果:** 既存`RunCoordinator`・`ArtifactWriter`を最終ownerとして使用。結果算出・帳票組立をUI側で再実装しない。
- **操作データ:** `ActionRun`の検証結果は専用スキーマで出力し、従来`audit.json/run.json`の`schemaVersion`や既定意味論を壊さない。

### 4.2 ディレクトリ案（採用する境界。既存の`src/`は大規模移動しない）

```text
src/                        # 既存エンジン: 公開監査のSSOTを保持
  control/                   # 新設・Node専用: profile/approval/job/worker/policy
    contracts.ts             # 管理データの型のSSOT
    profile-policy.ts        # 環境と監査モードの判定owner
    worker-entry.ts          # プロセス起動側から受ける最小IPC入口
    ...                      # owner単位に分割。巨大ファイル化禁止
apps/local-ui/               # 新設 TanStack Start アプリ
  src/routes/                # Routerの画面とServer Routes
  src/server/                # Server Functions/管理UIサーバー専用処理
  src/components/            # React UI部品
  src/contracts/             # schemas/control由来の生成型・検証コード
schemas/control/             # 新設: profile/approval/job/action-run/IPC等
config/targets/              # 既存の公開サイト設定JSONを維持
artifacts/                   # 既存監査結果（Git管理外）
local-data/                  # SQLite・秘密でない内部状態（Git管理外）
```

契約を二重定義しない。`src/control/contracts.ts`と`schemas/control/`の対応は生成または契約一致テストで保証する。UIはワーカーの標準出力にある日本語文言をパースせず、型付きIPCメッセージで状態取得する。

**段階的統合:** Task 24のPUBLIC_PASSIVEは既存`runAuditCommand`へ橋渡しする。認証・業務操作は後続Taskで独立した実行経路を追加し、既存CLIの`run`や`validate-config`を壊さない。ワーカー通信は子プロセスIPCを第一候補とし、開始・終了・キャンセル・異常終了をジョブ管理層で扱う。外部公開APIは作らない。

### 4.3 TanStack Startの採用範囲

| 採用 | 用途 | 禁止・注意 |
|---|---|---|
| TanStack Router | サイト／環境／シナリオ／Run／結果の画面遷移 | route loaderや`beforeLoad`を権限判定の最終境界にしない |
| Server Functions (`createServerFn`) | プロファイル保存、Run要求、承認・失効などの短時間RPC | Run全体をHTTPリクエスト内でawaitしない。全入力をサーバーで再検証 |
| Server Routes | 認可したレポートやZIP・画像をストリーミング配信 | ファイル名を任意パスとして受け取らない。外部公開しない |
| Request middleware/CSRF | セッション照合、同一Origin、Origin/Host、CSRF、防御ログ | デフォルトのCSRF設定を無効化しない。機能側の承認チェックを省略しない |
| TanStack Query | Job状態のポーリング、エラー、再取得 | 進捗表示を権威情報にしない。サーバー／IPCの状態をSSOTにする |
| TanStack Form | 発見した項目・生成ルール・承認条件の編集 | フロント側検証は補助。保存前・実行前にサーバー再検証 |

**初期不採用:** クラウドホスティング、SEO目的のSSR最適化、RSC、複雑なストリーミング・マイクロサービス分割、LLM/RAG。開発時に必要性と便益を証明できない拡張は行わない。

**ローカル保護:** `127.0.0.1`にのみbind（必要なIPv6ループバックを別途検証）。LAN公開・`0.0.0.0`バインド禁止。Host/Origin/CSRF、短期のローカルセッションtoken、HTTP-only SameSite cookie、応答の`no-store`・CSPを採用。ユーザー操作を伴う機能は全Server Function/Routeで認証・認可し、ルート遷移ガードだけに頼らない。

### 4.4 永続化の責務

- 承認・プロファイル・Run管理情報・件数予約・実行結果はSQLiteで永続化。書き込み予約と件数計上は原子的なトランザクションを使う。
- DB配置はローカルの非Git領域。プロファイルに顧客名・秘密値を入れず、ローカルの識別値・URL等もエクスポート時に匿名化する。
- `node:sqlite`はNode 24でrelease candidate段階のため、Task 23にて対応API、Windows、WAL、トランザクション、並行アクセス、クラッシュ復帰の実験を必須とする。不合格ならそのTaskを止めて代替案（例: 安定したSQLiteドライバ）を設計レビューに提出する。
- パスワード・トークン・Cookie・`storageState`を通常DBへ保存しない。認証状態はまず同一実行のメモリで受け渡す。再起動後の再認証は許容する。

## 5. 設計対象となる契約（TypeScriptの規範的な形）

これらは**次期実装で新設するインターフェース案**であり、現行ZIPに存在する型ではない。実装者は同等の型・JSON Schemaを1つのSSOTから導出する。名前や列挙値を独断で変更する場合はADRレビューを要する。

```ts
type AuditMode = 'PUBLIC_PASSIVE' | 'TEST_AUTH_PASSIVE' | 'TEST_APPROVED_WRITE';
type EnvironmentKind = 'PUBLIC' | 'TEST';
type AuthStrategy = 'NONE' | 'MANUAL_SESSION' | 'AUTOMATED_LOGIN';
type ActionKind = 'READ' | 'CREATE' | 'UPDATE';
type ApprovalState = 'DRAFT' | 'APPROVED' | 'REVOKED' | 'EXPIRED';
type ActionResult = 'VERIFIED' | 'PARTIAL' | 'BLOCKED' | 'UNKNOWN' | 'FAILED';

interface SiteProfile {
  schemaVersion: 'beaksight-profile/1';
  profileId: string;
  revision: number;                 // 単調増加。不正な改訂は拒否
  targetConfigPath: string;         // 既存監査JSONへの参照。任意パスは禁止
  environment: EnvironmentKind;
  mode: AuditMode;
  auth: AuthStrategy;
  approvedTestOrigins: readonly string[]; // TESTモード限定、事前検証済み
  environmentEvidenceRef: string | null;   // 環境隔離確認の非秘密参照
}

interface ApprovedActionScenario {
  schemaVersion: 'beaksight-scenario/1';
  scenarioId: string;
  revision: number;
  profileId: string;
  profileRevision: number;
  state: ApprovalState;
  kind: 'CREATE' | 'UPDATE';
  pageAndFormFingerprint: string;
  allowedRequests: readonly ApprovedRequestShape[]; // method+origin+path+入力制約
  approvedInputRuleHash: string;
  approvedSideEffects: readonly string[];
  maxCreatesPerRun: number;
  maxCumulativeCreates: number;
  approvedAt: string | null;
  expiresAt: string | null;
}

interface ApprovedRequestShape {
  method: string;
  origin: string;
  path: string;
  expectedPayloadSchemaId: string;
  allowedQueryKeys: readonly string[];
}
```

**追加の必須DTO:** `DiscoveredActionCandidate`（発見事実＋未確定項目）、`ScenarioDraft`（承認前プレビュー）、`ApprovalReceipt`（誰が・何を・どの版で承認／撤回）、`ExecutionGrant`（Run/シナリオ/環境/期限/1回性に束縛）、`WriteReservation`（上限予約）、`ActionRunSummary`（遷移・前後比較・UNKNOWN）、`WorkerMessage`（進捗/停止/結果）。**契約の具体的な全フィールドとスキーマは、それを所有するTaskで確定する。** 未確定フィールドを安全な既定値とみなさない。

### 5.1 絶対に曖昧にしてはいけない区別

- **サイト**と**環境**: 本番とテストは別profileId・別認可。名称やURL部分一致で扱わない。
- **発見**と**承認**: 発見は情報。承認済みでない候補は絶対に実行しない。
- **承認**と**実行時権限**: 保存された承認は1つの入力。Run直前・通信直前の再検証が必須。
- **ログイン通信**と**業務更新通信**: 用途が違う権限。Auth段階のPOST許可を任意の業務POSTへ拡大しない。
- **送信前失敗**と**送信済み可能性あり**: 後者はUNKNOWNとして上限を保守的に消費・自動リトライ禁止。
- **自然さ**と**業務妥当性**: 人間らしい名前や文章だけでは正当性を保証しない。項目間制約の照合が別途必要。
- **業務UPDATE**と**削除相当の状態遷移**: `isDeleted=true`、`status=cancelled`、`active=false`等の危険な意味はルールで排除。未知は承認不可。

## 6. 認証・操作検証の実行モデル

### 6.1 Stage 1: 手動ログイン済みセッション

1. 対象の`TEST_AUTH_PASSIVE`または`TEST_APPROVED_WRITE`プロファイルを選択。
2. テスト環境隔離／対象Origin／認証方式／権限範囲をサーバー側で検証。
3. BeakSight管理下の**隔離したheaded Chromium**で正規ログイン画面を開く。認証のための最小の許可済み経路だけで人間が操作する。ログインと無関係な業務書き込みは遮断。
4. 認証に成功したことを読み取り可能な画面・セッション状態で確認。資格情報の内容は収集しない。
5. 認証済み状態をメモリ内で**新しいGuard付き監査Context**へ受け渡す。監査Contextの起動後はRead-Onlyの制限に戻す。
6. セッション期限切れ・追加認証が必要・サードパーティSSOの遷移が未承認の場合は`AUTH_SETUP_REQUIRED`等で停止し、無条件のPOST許可はしない。

**技術上の留意:** Playwrightの`storageState`だけでは一部の`sessionStorage`・外部IdP等を再現できない。対象アプリに必要な最小状態を調べ、扱えない場合は`UNSUPPORTED_AUTH_STATE`として明示する。セッション奪取や無断接続はしない。

### 6.2 Stage 2: 自動ログイン

- ユーザーが許可したテスト用アカウントのみ。資格情報は実行時にOS側の安全な入力経路／秘匿ストアから受け渡し、ソース・DB・成果物に平文保存しない。
- 認証URL、正規のIdP、method/path、想定されるCookie、試行回数をプロファイルで事前承認。
- 成功、資格情報不一致、期限切れ、セッション失効、MFAで人間操作が必要な場合を区別する。総当たり・CAPTCHA迂回は対象外。
- 自動ログインを行えることと業務CRUDを行えることは独立。`TEST_AUTH_PASSIVE`では業務書き込み禁止。

### 6.3 候補発見 → 承認 → 実行

1. **DISCOVER:** DOM、ラベル、型、必要条件、表示選択肢、フォーム構造からREAD/CREATE/UPDATE候補を収集。発見のための保存・更新・送信操作はしない。JavaScriptによる送信先が不明なら`NEEDS_BINDING`を明示。
2. **CLASSIFY:** 操作の意味と予想副作用を保守的に分類。Delete/キャンセル/無効化/一括更新は除外。断定不可は候補としての表示のみ。
3. **DRAFT:** 承認画面に対象環境、画面・フォーム、method/Origin/path、入力項目ごとの生成ルール、ダミー入力例、外部副作用、READでの照合方法、Run上限・累積上限を表示。
4. **APPROVE:** 人間が**シナリオ単位**で承認。保存されたリビジョンと承認ハッシュを以後の照合に使う。次Runで承認済みなら無操作再利用。
5. **PREPARE:** Runで生成する入力データを決定論的に生成し、型・範囲・項目間制約・テスト用連絡先の安全性を再検証。
6. **RESERVE:** DBトランザクションで1回の許可およびCREATE件数の枠を予約。既に使われたgrantは無効。
7. **EXECUTE:** ワーカーが通信要求のmethod/Origin/path/payloadの構造と、現場のフォーム指紋を毎回照合。許可範囲外は送信前拒否。
8. **VERIFY:** サーバ応答だけでなく、利用できるREAD画面／一覧／詳細から登録ID・主要値・変更前後を照合。証拠不足はUNKNOWN/PARTIAL。
9. **RECORD:** 安全台帳と件数台帳、匿名化したActionRun証拠を保存。取消可能な承認でも、過去の実行記録は消さない。

**重大な注意:** SPAで送信先が実クリックまで確定しない場合、未承認要求は送信前に遮断し、候補の不足情報として提示する。**実サイトにPOSTして送信先を探る方法は不可。** HTTPメソッドがPUT/PATCH/POSTのどれであっても、業務操作の許可はendpointとpayloadまで一致させる。

### 6.4 READの検証範囲（Task 27で実装）

- READは**業務画面を通した取得・検索・一覧／詳細表示**であり、テスト環境のデータベースへ直接接続して読み取る機能ではない。
- 最初の対応範囲は、GET/HEADで安全に取得できるページ、一覧、詳細、GET検索フォームと、その表示・入力パラメータの検証。取得内容を構造化証拠として保存し、必要に応じ期待値と照合する。
- POST経由のGraphQL queryや、GETでも副作用が疑われる画面操作は、読み取りと断定して**自動許可しない**。最初の版では`UNSUPPORTED_READ_TRANSPORT`として報告し、未監視POST許可の追加は別の設計審査を要する。
- READにはCREATE/UPDATE承認を求めないが、テスト環境の認証、サイト・Origin、公開／テストの権限は必ず強制する。既存`PUBLIC_PASSIVE`は従来の読み取り監査挙動を継続。

### 6.5 再利用時に再承認する条件

プロファイルrevision、対象Origin、画面／フォーム指紋、操作種別、許可メソッド・パス、入力規則、認可された副作用、出力先、作成件数上限、対象権限のいずれかが**意味的に変更**されたら再承認。名前・日時等が承認済み規則内で変化するだけなら不要。承認期限切れ／撤回／ユーザーが不明な更新対象は拒否する。

### 6.6 CREATE/UPDATEの成否・リトライ

- CREATE: 追跡用の一意なテストIDまたは既知の識別フィールドを使用。業務画面に合法的な識別手段がなければ自動CREATEを実行しない。登録直後にREADで照合。
- UPDATE: 原則、BeakSightが作成し識別できるテストデータのみを対象。更新前の値、変更項目、変更後の値を比較。既存の任意レコードを無差別に選ばない。
- 初期化・削除・復元には頼らない。通知や課金などの副作用はテスト側で無効化／sink化した事実をオペレーターが確認する。
- `NOT_SENT`かつ上限が未使用と証明できる場合のみ新規実行を検討可能。`POSSIBLY_SENT`/`SENT`/ネットワーク断・処理中断後は自動再実行しない。
- `Run`再開機能をActionRunへそのまま流用しない。ActionRunは別の「一度だけ実行」の状態機械を持つ。事故時にUNKNOWNをCOMPLETEへ昇格しない。

## 7. 合成テストデータの決定論的生成仕様

**LLM禁止。** `GenericRuleCatalog`（文字列・数値・日付・メール等）、`BusinessTemplateCatalog`（予約・顧客・商品等の汎用業務カテゴリ）、`OperatorRuleOverrides`（サイト別の人手補完）を優先順位付きで照合する。テンプレートにサイト固有URL、顧客固有マスタ値、実個人情報を直書きしない。

| 例 | 生成規則と制限 |
|---|---|
| 氏名 | 合成済みの日本語氏名辞書から自然に組み合わせる。実顧客一覧を素材にしない |
| メール | `.invalid`等の非配送用ドメイン、通知機構の停止確認。外部送信が必要なら実行不可 |
| 電話番号 | 通知・発信が隔離されていなければ生成して登録しない。実在番号の推定利用禁止 |
| 日時 | 営業時間・予約枠・サービス時間をREADで取得できる場合のみ制約付き生成 |
| 担当者・メニュー | テスト環境で選択可能な項目をREADから参照。未確認の選択値を作らない |
| 単価・数量・終了時刻 | 金額計算、`終了 > 開始`、在庫や枠の業務制約をルール検証 |
| 備考 | 人間らしい架空業務文例のテンプレート。実個人情報や識別子を含めない |

生成結果は`seed = stableHash(profileId, scenarioRevision, runId)`に基づいて再現可能にする。**再現可能であることと再送信可能であることは別**で、同じRunのCREATEを事故後に二重送信しない。曖昧なフィールドや衝突した生成値は`NEEDS_RULE_INPUT`として人間の規則補完を待つ。

## 8. 管理UIの画面と人間の操作負担

### 8.1 必須画面（最初に構造を決める）

| 画面 | 必須表示／操作 |
|---|---|
| サイト・環境一覧 | サイト名、公開／テスト、監査モード、最終Run状態、危険操作可能性の明示 |
| プロファイル編集 | ターゲットJSON参照、Origin、許可モード、認証方法、隔離確認、設定検証 |
| Run開始・進捗 | 実行範囲・上限・対象環境、ジョブ開始、停止、既存進捗、部分失敗、終了理由 |
| Run一覧・詳細 | COMPLETE/PARTIAL/FAILED、実行履歴、負荷、Findings、Evidence |
| 成果物閲覧 | HTMLレポート、画像、JSON、ZIPの安全なプレビュー／ダウンロード |
| 認証セットアップ | 手動ログインの操作案内、状態判定、期限切れ／未対応IdPの表示 |
| 操作候補一覧 | READ/CREATE/UPDATE候補、根拠、送信先既知／不明、危険度、承認可否 |
| シナリオ承認 | 操作概要、送信先、入力規則、自然なデータ例、副作用、作成上限、差分、承認・却下 |
| 承認済みシナリオ一覧 | 承認・失効・撤回・更新履歴、累積CREATE数、再実行資格 |
| ActionRun結果 | 作成／更新ID、前後値差分、VERIFY結果、送信済み不明、拒否理由 |

### 8.2 承認の粒度

- 原則**業務操作シナリオ1件につき1承認**（例:「顧客登録」と「顧客住所更新」は別件）。入力項目ごと・毎Runごとの反復承認はしない。
- 初回承認時にフォーム全項目をレビューでき、未対応項目だけ個別補完。補完は規則の一部として保存。
- UIに「この承認で次回から何が自動実行されるか」を自然言語とmachine-readable diffの両方で示す。
- 承認期限・撤回・変化に対する再承認・件数上限の履歴をUIで一目で確認可能。
- 大きな画面より機能検証を優先するが、最低限のキーボード操作、読みやすい状態・エラー、確認ダイアログ、誤操作防止を実装する。

## 9. サイトごとに操作者が準備する入力情報

**これは空欄を設計者が推定して埋める表ではない。未確認なら該当機能は停止する。** サイト登録時にUIで収集・検証する。値はローカル保存し、リポジトリへの直書きや外部プラグインへの送信をしない。

| 入力カテゴリ | 必須内容 | 必須になるモード | 未入力時の動作 |
|---|---|---|---|
| 公開監査の基準 | target ID、開始URL、allowedOrigins、クロール上限、出力先 | 全モード | 登録不可 |
| モード選択 | `PUBLIC_PASSIVE` / `TEST_AUTH_PASSIVE` / `TEST_APPROVED_WRITE` | 全モード | `PUBLIC_PASSIVE`のみ（旧設定は互換維持） |
| テスト環境証明 | 所有者の接続許可、テスト専用Origin、バックエンド／通知・課金・外部APIの分離確認 | TEST系 | AUTH/WRITE不可 |
| 認証方式 | 手動／自動、ログイン開始URL、許可認証endpoint、許可IdP、終了／失効条件 | AUTH系 | 認証開始不可 |
| 認証秘密 | テスト用資格情報の安全な実行時提供先。値自体を設定ファイルに記録しない | AUTOログイン | ログイン開始不可 |
| 操作範囲 | 発見した候補、対象画面、許可する業務作用、通信先の正確な条件 | WRITE | 候補表示のみ |
| 入力規則 | 必須項目、整合制約、業務テンプレート、連絡先の送信安全性 | CREATE/UPDATE | `NEEDS_RULE_INPUT`で停止 |
| 同意条件 | シナリオ版・フォーム指紋・要求条件・副作用・有効期限・上限 | CREATE/UPDATE | 実行不可 |
| 検証条件 | 作成IDの取得方法、READでの結果照合方法、更新対象の識別方法 | CREATE/UPDATE | 実行不可 |
| 運用許容 | 上限件数、監査Run最大時間、負荷上限、テストデータの累積を許容する旨 | WRITE | 実行不可 |

**プロファイル記入例（匿名の抽象値のみ）:** `profileId=test-admin-01`, `environment=TEST`, `mode=TEST_AUTH_PASSIVE`, `targetConfigPath=config/targets/example.json`, `approvedTestOrigins=[https://staging.example.invalid]`。これは例であり、動作するテスト環境URLを示すものではない。

---

## 10. 正式Taskロードマップ（依存関係付き）

**全Task共通の実施方法:** ①対象仕様を読み切る → ②失敗する回帰／受入テストを先に記述 → ③失敗原因を確認 → ④最小実装 → ⑤テストPASS → ⑥従来の`npm run verify`と当該Taskの検証を実行 → ⑦証拠・未実施一覧を提出 → ⑧設計者／レビュアーの承認。設計者・実装者のGit commit/pushは禁止。テスト未実施をPASSとして報告しない。

### Program A: 基盤互換性・UI（Task 22〜24）

#### Task 22: 監査プロファイルと互換性のControl契約

**入力:** Task 21ソース・完全リポジトリ、既存設定・`RunCoordinator`・Guard・schemas、要件R01〜R03/R16〜R18、本書のモード型。  
**主に調査／変更する箇所:** `src/config/*`、`src/core/evidence-types.ts`、`src/safety/request-policy.ts`（現行挙動固定）、`src/control/contracts.ts`・`src/control/profile-policy.ts`（新規）、`schemas/control/profile.schema.json`。  
**実装成果:** 旧JSONのまま動く`PUBLIC_PASSIVE`解決器、公開／テストのprofile識別とrevision、旧モードにauth/writeが混入しない検証、テスト環境の登録ポリシー。

- [ ] 旧ターゲットJSON→`PUBLIC_PASSIVE`の受入テストを作成、既定が昇格しないことを確認。
- [ ] 3モードの組み合わせ表をテスト化。`PUBLIC + AUTH/WRITE`、`TEST + 無証明`、unknown mode、改訂不一致は拒否。
- [ ] 旧CLIの`run`/`validate-config`・既存schema・既存GET/HEAD Guardのgolden回帰を追加。
- [ ] 既存公開監査ではファイル名・出力・状態・終了コードが不変である証拠を作成。
- [ ] 認証／書き込みを許可する処理を追加する前に、安全レビュー（SSOT・fail-closed・未監視経路）を実施。

**Exit Gate G22:** `npm run verify` PASS、既存公開監査互換PASS、profile不正値がすべて拒否、Safety invariant violation 0。実サイトアクセスなし。

#### Task 23: TanStack StartローカルUI基盤・状態ストア

**依存:** G22。  
**主に新設:** `apps/local-ui/`、`src/control/store/*`、`schemas/control/`、UI package/builder/verify scripts。  
**実装成果:** React/TanStack StartのローカルUI、サイト一覧・編集、型安全なServer Functions、localhost保護、SQLite永続化、プロファイルrev管理。

- [ ] 対応バージョンのTanStack Start/Router/React/Nodeをlockfileに固定し、Windowsで開発・ビルド・Node起動テスト。
- [ ] `127.0.0.1`以外で起動不能、外部Host・不正Origin・CSRF・未認可のServer Function/Routeを拒否するテスト。
- [ ] SQLiteの新規作成・migration・WAL・再起動・書込競合・トランザクション復旧を検証。
- [ ] サイトの追加／更新／モード切替／取消／一覧と、設定検証結果のUI表示を実装。
- [ ] 既存`npm run verify`を壊さず、UI専用`npm run verify:ui`と全体`npm run verify:all`を定義。

**Exit Gate G23:** UI起動・設定保存・再起動復元・不正Origin/CSRF拒否・`verify:all` PASS。認証機能・書き込み機能はまだ有効化しない。

#### Task 24: 既存Read-Only監査のUI統合

**依存:** G23。  
**主に新設／拡張:** `src/control/job/*`、`src/control/worker-entry.ts`、`schemas/control/worker-message.schema.json`、`apps/local-ui/src/routes/`。  
**実装成果:** CLIと同じ公開監査の開始・進捗・停止・結果閲覧、ジョブID、孤児プロセス処理、成果物ダウンロード。

- [ ] UI→ワーカーの型付きIPCで`RunCoordinator`の進捗と終了結果を受け取る。日本語stdoutの文字列パース禁止。
- [ ] `runAuditCommand`の最終処理を共用。旧CLIとUIで同じ入力に対して同一スキーマの結果を得るテスト。
- [ ] ブラウザを閉じてもジョブが継続し、UIを開き直せば状態復帰する。サーバー自身が落ちた場合は中断・ロック・再開可否を正確に判定。
- [ ] 同一ジョブ二重起動・同時ロック・キャンセル・タイムアウト・PARTIALを検証。
- [ ] 成果物は既存の安全な相対パスAPIでのみ取り出し、path traversal・秘密ファイル公開を拒否。
- [ ] ローカルfixtureで公開サイト監査の成果物（run/audit/report/ZIP）とSafetyLedgerの比較を行う。

**Exit Gate G24（重要レビュー）:** **Task 21公開監査をCLIでもUIでも実行でき、挙動と安全性が保持されている。** この段階だけでも利用可能なUI付き公開監査ツールが完成。認証・書き込みは依然拒否。

### Program B: 認証付きRead-Only監査（Task 25〜26）

#### Task 25: 手動ログイン済みセッション引継ぎ

**依存:** G24。  
**主に新設／拡張:** `src/control/auth/*`、`src/control/policy/auth-transport.ts`、`src/browser/context-factory.ts`（安全な注入入口のみ）、`apps/local-ui`認証セットアップ画面、`schemas/control/auth-state.schema.json`（秘密を含まない状態報告のみ）。  
**実装成果:** テスト環境のheadedログイン→セッションをメモリ内で引継ぎ→新しいPassive Guard付き監査Contextで管理画面を監査。

- [ ] テスト環境以外、未承認認証Origin、ログイン以外のPOST・外部scheme・MFA回避を遮断するfixtureを作成。
- [ ] ログイン前／認証中／認証成功／移譲後で送信権限が増えない状態機械を実装。
- [ ] Cookie/storageStateが成果物・CLI・UI・ログへ流出しないテスト。セッション切断と期限切れを検証。
- [ ] iframe/popup/Service Worker/IdP/予期しないredirectはガード付きで監視。対応不可は明示的な停止。
- [ ] 認証後の管理画面監査は従来のRead-Only制御へ戻ることを証明。

**Exit Gate G25:** fixtureの正規ログイン成功・失敗／移譲後監査・秘密非漏出・無関係POST遮断PASS。実テスト環境のログインは明示承認後の小規模smokeのみ。

#### Task 26: テスト環境の自動ログイン検証

**依存:** G25。  
**主に新設:** `src/control/auth/automated-login.ts`、`apps/local-ui`ログイン検証画面、認証成功/失敗の証拠スキーマ。  
**実装成果:** テスト用資格情報によるログイン成功・不正資格情報・セッション失効・MFA要人手介入の検証。Read-Only監査と独立して動作。

- [ ] テスト用資格情報は実行時の安全な参照から取得。パスワード平文のDB/URL/ログ/ZIP出力は禁止。
- [ ] 成功／失敗／期限切れ／レート制限／アカウントロック懸念を区分。ロックを誘発する連続試行を行わない。
- [ ] 許可されていない認証endpoint・パスワード変更・認証以外の業務POSTは遮断。
- [ ] 失敗時に`AUTH_FAILED`等として停止し、認証成功を偽装しない。手動方式への意図しない自動フォールバックは禁止。
- [ ] 認証成功後も`TEST_AUTH_PASSIVE`の業務書き込み禁止が維持される回帰。

**Exit Gate G26（重要レビュー）:** 正規認証とRead-Only境界を再現可能なfixtureで検証。秘密の出力0、非認証副作用0、G24公開監査回帰PASS。

### Program C: 操作発見・人間承認・READ/CREATE/UPDATE（Task 27〜32）

#### Task 27: READ検証と副作用のない操作候補の自動発見

**依存:** G26。  
**主に新設:** `src/control/discovery/*`、`src/control/actions/read-executor.ts`、`schemas/control/candidate.schema.json`、READ証拠契約、UI候補一覧。  
**実装成果:** 管理画面でGET/HEADのREAD（一覧・詳細・検索）を実行・照合でき、フォーム・入力制約・選択肢・CREATE/UPDATE候補を副作用なく抽出し、`UNSUPPORTED/NEEDS_BINDING`と根拠を提示。

- [ ] GET/HEADの一覧／詳細／検索フォームをfixtureでREAD実行し、期待値と取得内容の一致、秘密値の除外を検証。
- [ ] POST型読み取り・GET型副作用の疑いを`UNSUPPORTED_READ_TRANSPORT`として停止し、通常のPOST許可へ拡張しない。
- [ ] DOM探索中にsubmit/clickによる実書き込みが0となるfixture。
- [ ] `type=submit`、JSイベントによる未知送信先、disabled、hidden、readonly、dynamic SPAの判定。
- [ ] 破壊的な言葉・状態遷移・POST利用の論理DELETE候補は実行不能として表示。
- [ ] URL・path・payloadが確定できない候補は`NEEDS_BINDING`。推測だけで承認可能にしない。
- [ ] 同一画面の同一候補を安定した指紋として扱い、画面変更時のドリフトを再現。

**Exit Gate G27:** GET/HEADのREAD取得・照合PASS、発見処理でmutating request 0、未確定候補の実行権限0、削除相当が全て実行不能。

#### Task 28: シナリオ承認UI・永続化・再承認

**依存:** G27。  
**主に新設:** `src/control/approval/*`、`schemas/control/scenario.schema.json`、`schemas/control/approval-receipt.schema.json`、UI詳細／承認／撤回画面。  
**実装成果:** 業務操作シナリオ単位で対象・送信条件・自然データの規則・副作用・上限を一括レビューして承認し、再起動後も保存・再利用・撤回できる。

- [ ] 初回承認、期限切れ、撤回、フォーム変更、profile revision変更、送信先変更、input rule変更で再承認を要求。
- [ ] 承認操作が単なる画面表示ではなく、サーバーの不可変receiptと現在のscenario revisionを照合するテスト。
- [ ] 期限付きの1回性ExecutionGrant、再利用不可能な消費記録、偽造grant・期限超過の拒否。
- [ ] 差分プレビューと発見根拠がUIで確認できる。例示データは送信されず、承認だけでは書き込みが始まらない。
- [ ] SQLiteトランザクションで複数Runからの同一quota予約と撤回競合を検証。

**Exit Gate G28（重要レビュー）:** `承認なし・rev違い・撤回済み・期限切れ・grant再利用`の全実行が拒否。承認保存はできるが実サイト書き込みはまだ不可。

#### Task 29: LLMなしの自然な業務データ生成

**依存:** G28。  
**主に新設:** `src/control/data-rules/*`、`schemas/control/data-rule.schema.json`、UI未確定項目の補完画面。  
**実装成果:** 型・選択肢・業務テンプレート・項目間依存に従う合成データ。安定seedで再現でき、毎Runで新しい値を作る。

- [ ] 汎用文字列／日時／数量／選択肢／日本語氏名／架空備考等の正規データを生成・検証。
- [ ] 顧客・予約・商品など少数の**汎用業務テンプレート**で項目間の関係を検証。全業界対応を前提にしない。
- [ ] メール・電話・通知などの外部到達リスクは許可されるsinkが無ければ生成・実行を拒否。
- [ ] 未知項目は`NEEDS_RULE_INPUT`、業務ルール衝突は`RULE_CONFLICT`。勝手な値の挿入禁止。
- [ ] 同seed→同データ、別Run→一意データ、ルール版変更→再承認を検証。LLM SDK/API等の依存0。

**Exit Gate G29:** 型と業務制約のfixture全PASS、非配送ダミーデータ、意図しない外部送信0、LLM依存0。

#### Task 30: 承認されたCREATEと登録結果照合

**依存:** G29。  
**主に新設／拡張:** `src/control/actions/create-executor.ts`、`src/control/policy/approved-write-guard.ts`、`src/control/quota/*`、`schemas/control/action-run.schema.json`。  
**実装成果:** 承認済みシナリオに限定した登録、ネットワーク要求の厳格照合、識別子取得、READ照合、累積件数管理、事故時UNKNOWN記録。

- [ ] ワーカー開始前のguard装着、実行直前・要求送出前のmethod/origin/path/payload再照合。
- [ ] `1 Run 1件・累積20件`の提案既定値、連続Run上限、上限変更で再承認、同時予約の原子性。
- [ ] 応答前タイムアウト・接続断・プロセス異常終了時、送信済み可能性がある場合`UNKNOWN`としてquotaを保守的に消費、自動再試行なし。
- [ ] CREATE後のREADによる登録IDと主要項目の照合ができなければCOMPLETE不可。
- [ ] DELETE/無関係POST/redirect先変更/追加送信/通知/未知フィールドを遮断。Service Worker・iframe・popupからの抜け道も防ぐ。
- [ ] test-only fixtureで認可された1件だけが永続化され、既存PUBLIC_PASSIVEとの差がないことを検証。

**Exit Gate G30（重要レビュー）:** 承認範囲外の実書き込み0、意図したCREATE1件、照合一致、二重登録0、上限超過0、未知結果の偽成功0。

#### Task 31: 承認されたUPDATEと前後差分の照合

**依存:** G30。  
**主に新設:** `src/control/actions/update-executor.ts`、UPDATE差分検証器とUI。  
**実装成果:** 管理対象テストレコードだけを承認済みフィールドで更新。更新前READ、限定UPDATE、更新後READ、期待との差分を表示。

- [ ] 更新対象がBeakSight登録台帳の管理レコードであることを検証。不明なレコードは不可。
- [ ] 更新項目のallowlist、期待する旧値／版の照合、競合や別Runでの変更を拒否。
- [ ] `deleted=true`、非表示・無効化・キャンセル・一括削除等の削除相当をブロック。
- [ ] 許可外フィールドの変更・サーバーによる追加副作用・前後不一致ではUNKNOWN/PARTIALを返す。
- [ ] 操作開始後の通信断で自動再試行なし。二重UPDATEが発生しないことをfixtureで確認。
- [ ] CREATE/UPDATEとも証拠に認証秘密や不用意な個人情報が混入しない。

**Exit Gate G31（重要レビュー）:** 認可対象の指定した差分のみ変更、削除相当の作用0、予期しない副作用0、G24〜G30の安全回帰PASS。

#### Task 32: 全体統合・最終Completion Gate

**依存:** G31。  
**主に実施:** `npm run verify:all`、UI Playwright E2E、CLI互換・schema・認証・承認・ActionRunの統合、使用手順／匿名化マニュアル。  
**実装成果:** 管理UIを持つ3モードの検証済み初版、実行条件と未対応範囲が分かる導入手順、監査ログとリスク一覧。

- [ ] 公開サイト向けCLI/ローカルUIで同一Passive監査を実施（まずローカルfixture）。
- [ ] テストサイトで手動セッション認証と自動ログインが異なる権限として成立。
- [ ] 候補発見→承認→生成→CREATE→READ→UPDATE→READ→レポートのフローを隔離fixtureで検証。
- [ ] 意図しない本番アクセス、DELETE、再試行二重書込、期限切れ承認、ネットワーク脱出、未知の副作用、秘密情報流出の否定テスト。
- [ ] ZIP/HTML/JSON成果物を実際に開く。既存`run-schema/1.0`と新`ActionRun`スキーマの両方を検証。
- [ ] 全Taskの検証証拠（コマンド・時刻・終了コード・PASS件数・未実施理由）と残余リスクをまとめる。`NOT_RUN`はPASSとみなさない。
- [ ] 実テスト環境smokeは対象所有者の承認がある場合だけ、1件・単独Run・低負荷から開始。実施不可なら未検証として正直に区分する。

**Exit Gate G32:** 既存Task 21機能不変、3モードの必要テストPASS、操作承認・隔離・秘密保護・レポート整合性PASS。実環境未実施の部分を「完成・本番検証済み」と表現しない。

---

## 11. レビュー重点5点（境界ケースと所有Task）

| ID | 危険な入力・条件 | 必須の期待結果 | テストowner |
|---|---|---|---|
| RF1 | 旧ターゲットJSONやUI編集だけで`WRITE`権限へ昇格 | 旧設定はPUBLIC_PASSIVEのまま／無証明TEST拒否 | Task 22・23 |
| RF2 | 認証中の外部IdPへredirect、未知POST、MFA、セッション失効 | 無関係POSTを遮断、認証不能なら停止。監査時はRead-Onlyへ復帰 | Task 25・26 |
| RF3 | 過去の承認を、変更後のフォーム／異なる環境・送信先で再利用 | revision/fingerprint/Origin/endpoint不一致で拒否・再承認 | Task 27・28 |
| RF4 | CREATE送信直後に応答喪失し、Runを再起動する | `UNKNOWN`、quota保守的消費、自動再送0、必要に応じREAD確認 | Task 30 |
| RF5 | `POST /archive`や`PATCH {active:false}`などの論理削除、未知外部通知 | HTTPメソッドに依存せず破壊的作用を拒否、送信0 | Task 27・30・31 |

## 12. 横断テストマトリクス（最小セット）

| 領域 | 受入ケース | 最終的な証拠 |
|---|---|---|
| CLI互換 | 旧config、`run`、`validate-config`、既存exit code、出力schema | Task 21と比較可能なgolden fixture、diff |
| 権限 | PUBLIC監査の非GET/HEAD拒否、TEST以外のauth/write拒否 | SafetyLedger / 送信0 |
| 認証 | 手動移譲、自動ログイン成功／失敗、期限切れ、未知IdP/MFA | 認証状態・拒否理由（秘密なし） |
| Profile | 環境別切替、revision変更、未登録Origin、異なるtarget | プロファイル判定ログ |
| 発見 | 非送信で候補抽出、未知JS submit、DELETE候補 | 候補schemaと送信0 |
| 承認 | 初回・再利用・撤回・失効・版変更・偽造grant | approval receiptと拒否証拠 |
| データ | 安定seed・新規Run値・項目間整合・未知項目・外部到達防止 | 生成fixtureとRule結果 |
| CREATE | 1件・READ照合・累積上限・並行競合・断線後UNKNOWN | ActionRun / quota ledger / DB state |
| UPDATE | 所有レコード限定・前後比較・削除相当拒否・競合 | Before/After Evidence |
| UI | CSRF/Origin/Host制約・Job再接続・ZIPパストラバーサル・認可 | UI E2E / server-route拒否 |
| Fail-closed | iframe/popup/service-worker/redirect/WebSocket/予期しないメソッド | 全ネットワーク経路テストとLedger |
| 情報保護 | Cookie/認証情報/個人データを通常ログ・ZIPに含めない | 人手確認と機械的redaction試験 |

`PUBLIC_PASSIVE`のSafety Gates/ Auditor Gatesは既存の正式テストと併走。新モードは新しいControl/Safety acceptance suiteとして別番号で管理する。旧ゲートの期待値を変更して新ゲートをPASSに見せることは禁止。

## 13. 成果物・機密情報・履歴

1. **既存監査:** `run.json`、`audit.json`、`report.html`、`pages/`下の証拠・スクリーンショット、既存の日時付き`beaksight-audit-bundle_YYYYMMDDHHmmss.zip`を維持。
2. **操作検証:** 別スキーマの`action-run.json`、`action-evidence.json`、`approval-summary.json`等を新設。認証セッションや実資格情報を混ぜない。
3. **承認履歴:** 誰が何を許可し、何が自動化されるか、revision・生成ルールhash・期限・上限・撤回の履歴をローカルDBに保持。
4. **監査済みデータ台帳:** CREATE毎の識別子、生成seed、実行Run、照合状態、総数。DELETE不可／復元不可の現実を反映。
5. **情報漏洩対策:** 管理画面の可視テキスト・スクリーンショット・HAR・URLのquery・ヘッダ・bodyには秘密／実データがあり得る。適切に秘匿できない成果物は生成・エクスポート自体を禁止し、ローカル証拠と公開可能なバンドルを分離する。
6. **外部送信:** 成果物の外部自動アップロードは禁止。プラグインへ渡す場合も公開情報＋匿名化されたUIのみ。ソースや顧客データを無断送信しない。

## 14. 管理・設計レビュー用Decision Ledger

| 決定ID | 決定 | 状態 |
|---|---|---|
| ADR-001 | 公開サイトRead-Only監査は独立モードとして存続 | 確定 |
| ADR-002 | 認証付き監査と書き込み検証はテスト環境のみ | 確定 |
| ADR-003 | 手動認証状態引継ぎ→自動ログインの順 | 確定 |
| ADR-004 | ローカルWeb UIにTanStack Start/React/TypeScriptを使用 | 確定 |
| ADR-005 | 操作候補は自動発見、人間がシナリオ単位で承認 | 確定 |
| ADR-006 | 承認済みシナリオは版・条件一致時に再利用 | 確定 |
| ADR-007 | CREATEは毎Run新規合成データ、DELETE/初期化なし | 確定 |
| ADR-008 | 自然なデータはLLMなしの規則ベース | 確定 |
| ADR-009 | Control Plane・実行ワーカー分離、既存Passive Guard維持 | 本ロードマップでの設計採用案／詳細レビュー必須 |
| ADR-010 | SQLite `node:sqlite`、件数初期値、承認有効期間 | 提案既定値／Task 23・28で検証後確定 |
| ADR-011 | HTTP/POSTの認証例外とApprovedWrite権限を分離 | 必須安全設計 |
| ADR-012 | 実テストサイトと外部連携の隔離を操作者入力で証明 | 必須実行条件 |
| ADR-013 | 実テスト環境での確かめ（G25 の小規模smokeを含む）は、ロードマップの終わりの方にまとめて行う（2026-10-10 ユーザー指示: 実際の監査先のテスト環境は今回はまだ使用できない）。それまでの各GateはfixtureのPASSで閉じる。smokeの負荷は `crawl.maxPages: 3`、`crawl.minNavigationIntervalMs: 10000` で承認済み。実行はユーザーの承認の後、ユーザーが起動しログインする | 確定（2026-10-10） |

設計者が追加判断を要するのは**対象サイト固有の情報**、`node:sqlite`互換性の実証、不明な認証プロバイダ、明確に観測できない業務副作用、シナリオ規則が扱えない入力に限定する。判断不能時は仕様の推測追加で解決せず、`BLOCKED`と理由を出して設計者へ返す。

## 15. 設計者・実装者への指示と引渡条件

- **着手前:** 完全リポジトリで現行の関連設計とテストを照合。基準ZIPのソースと差がある場合は差分一覧を先に提出。顧客名・本番URLは汎用文書とテストから匿名化。
- **Taskごと:** 具体的な入口・入力DTO・出力DTO・失敗理由・SSOT・期限・テストを明記した設計を提出し、承認後に実装。前TaskのPASSを次Taskの仮定にしない。
- **既存の思想:** 推測による本番動作変更、独立した権限判定の重複、キャッシュや進捗数字の二重計算、fake completionを禁止。未知の機能を実装済みと扱わない。
- **必須検証:** 元の`npm run verify`、新しい`npm run verify:ui`・`npm run verify:all`、ローカル安全fixture、schema検証、UI E2E、コンパイル、ビルドを実施し、コマンド・exit code・日時・テスト集計を証拠化。
- **Run/Job停止:** 中断・タイムアウト・クラッシュでプロセス／Browser/Contextが残らず、行った可能性のある副作用を正確にUNKNOWNへ記録。
- **実サイト:** 明示的に許可されない限りテスト用fixtureのみ。外部smokeを行う場合、短いスコープ・1件・低負荷・公開／テストの区別と監査結果を記録。
- **Git:** リポジトリはGit管理下。設計者・実装者によるcommit、push、履歴書き換え等のGit書き込みを禁止する。差分確認は許可。
- **完了表明:** Taskごとに`PASS / PARTIAL / BLOCKED / NOT_RUN`を区分し、未検証を成功扱いしない。G32の承認後に限り次期開発の完成を宣言する。

---

## 16. 技術情報の公式参照先（2026-10-09時点の設計入力）

TanStackのAPIは変更される可能性があるため、各Task開始時に公式仕様とlockfileを突き合わせる。以下は参考情報であり、本書の安全要件や既存SSOTより優先しない。

- [TanStack Start — Server Functions](https://tanstack.com/start/latest/docs/framework/react/guide/server-functions) — サーバー専用処理、入力バリデーション、CSRF保護。
- [TanStack Start — Server Routes](https://tanstack.com/start/latest/docs/framework/react/guide/server-routes) — raw HTTP、成果物配信とルート単位middleware。
- [TanStack Start — Hosting / Node.js](https://tanstack.com/start/latest/docs/framework/react/guide/hosting) — Nodeベースの配布・起動構成。
- [TanStack Start — Authentication](https://tanstack.com/start/latest/docs/framework/react/guide/authentication) — データ境界での認可とroute guardの区別。
- [TanStack Router — Data Loading](https://tanstack.com/router/latest/docs/guide/data-loading) — Routerによるデータ取得・キャッシュの役割。
- [TanStack Form — Validation](https://tanstack.com/form/latest/docs/framework/react/guides/validation) — 動的フォームと検証。
- [Node.js 24 — SQLite](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html) — `node:sqlite`のrelease candidate状態とAPI。

**このロードマップの最終成功条件:** 公開サイトを従来どおり安全に監査できること、テスト環境管理画面を正規認証でRead-Only監査できること、シナリオ承認の意味・有効性がUIと実行ワーカーで一致すること、許可されたCREATE/UPDATEのみ証拠付きで実行できること、削除・無断通知・本番書き込み・秘密漏洩・偽完了が起きないこと。
