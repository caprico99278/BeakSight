# BeakSight Task 22 監査プロファイルと互換性の Control 契約 設計書

作成日: 2026-10-09
状態: ユーザー承認済み（2026-10-09）
対象範囲: 監査モードを持つ「サイト・環境のプロファイル」の契約と判定の owner を新設し、旧ターゲット JSON がつねに `PUBLIC_PASSIVE` に解決されることと、Task 21 までの公開監査の振る舞いが変わらないことを、テストで固定する。

## 1. 目的

Task 23 以降で、ローカル UI、認証付き監査、承認済みの書き込みを段階的に加える。その前に、次の 2 点を確かな土台にする。

- サイトごと・環境ごとに監査モード（`PUBLIC_PASSIVE`、`TEST_AUTH_PASSIVE`、`TEST_APPROVED_WRITE`）を選べる契約（プロファイル）を、型とスキーマの 1 つの SSOT として定める。
- プロファイルがない（旧ターゲット JSON だけの）場合と、プロファイルの値が不正・矛盾している場合に、権限が増えないこと（fail-closed）を判定の 1 か所で保証する。

Task 22 では、認証・書き込みの機能は一切作らない。判定は「許可しない」側だけを確かにする。

## 2. 根拠となる文書と優先順位

- 従う文書: `2026-10-09-beaksight-task-22-32-roadmap.md`（以下、ロードマップ）の第 1〜5 章、第 10 章の Task 22、第 11 章の RF1、第 12 章の CLI 互換・権限・Profile。
- 文書の優先順位: Task 22〜32 については、ロードマップを `2026-08-27-beaksight-implementation-plan.md`（Task 1〜21 の計画）と同じ位置の上位の文書として扱う。実装タスク指示（`2026-08-27-beaksight-implementation-tasks.md`）の SSOT Owner Matrix、Safety Invariants、禁止事項は引き続き最上位である。
- この設計書が置き換える箇所: なし（新設）。
- 引き続き守る不変条件: ロードマップの I01（旧 JSON は `PUBLIC_PASSIVE`）、I02（`PUBLIC_PASSIVE` は従来の Guard・URL 処理・停止と再開・出力スキーマを保持）、I03（URL の文字列や名前だけでテスト環境と見なさない）、I04（不明な環境で認証・書き込みを許可しない）、I14（未確定は止める）、R16（顧客名・実ドメインを文書・fixture に書かない）、R17（commit・push しない）。

## 3. 採用する設計

### 3.1 構造

- 新設 `src/control/`（Node 専用。Playwright とブラウザを import しない）に、契約と判定を置く。
  - `src/control/contracts.ts`: プロファイルの型と、モード・環境・認証方式の閉じた一覧（SSOT）。
  - `src/control/profile-policy.ts`: プロファイルの検証と解決の唯一の owner（環境と監査モードの判定）。
- 新設 `schemas/control/profile.schema.json`: プロファイルの JSON Schema。閉じた一覧は `contracts.ts` の定数とテストで一致させる（既存の `schema-enum-consistency.test.ts` と同じ方式）。
- 既存の監査エンジン（`src/` の `control/` 以外）は、`src/control/` を import しない（Architecture Gate で固定）。Task 22 では CLI も既存のエンジンも変えない。旧ターゲット JSON をそのまま使う CLI の `run` と `validate-config` は、プロファイルを読まずに、従来どおり動く。
- 旧ターゲット JSON は未知の鍵を拒む（`validateConfig` の `unknown configuration key`）ので、モードの情報をターゲット JSON に書き足す方式は採らない（ロードマップ 1.1 の「モード情報は別管理契約に置く」）。この性質そのものを、I01 を守る仕組みの 1 つとしてテストで固定する（ターゲット JSON に `mode` などを書くと、設定のエラー）。

### 3.2 採用しなかった案

- ターゲット JSON に `mode` を足す: 既存の `effectiveConfig` と `run.schema.json`（`run-schema/1.0`）を変えることになり、I02 に反する。
- Task 22 で CLI にプロファイルの読み込みを加える: CLI の契約と出力を変える理由がない。プロファイルを使うのは Task 23 以降の Control Plane で、CLI は従来の `PUBLIC_PASSIVE` の入口のまま残す。

## 4. 詳細設計

### 4.1 契約（`src/control/contracts.ts`）

```ts
export const AUDIT_MODES = ['PUBLIC_PASSIVE', 'TEST_AUTH_PASSIVE', 'TEST_APPROVED_WRITE'] as const;
export const ENVIRONMENT_KINDS = ['PUBLIC', 'TEST'] as const;
export const AUTH_STRATEGIES = ['NONE', 'MANUAL_SESSION', 'AUTOMATED_LOGIN'] as const;
export const SITE_PROFILE_SCHEMA_VERSION = 'beaksight-profile/1';

export interface SiteProfile {
  readonly schemaVersion: typeof SITE_PROFILE_SCHEMA_VERSION;
  readonly profileId: string;               // 下の 4.3 の形
  readonly revision: number;                // 1 以上の安全な整数
  readonly targetConfigPath: string;        // 下の 4.3 の形（相対パスだけ）
  readonly environment: EnvironmentKind;
  readonly mode: AuditMode;
  readonly auth: AuthStrategy;
  readonly approvedTestOrigins: readonly string[];
  readonly environmentEvidenceRef: string | null;
}
```

- ロードマップ第 5 章の `SiteProfile` の形を、そのまま採る（フィールドの追加・改名はしない）。
- `ActionKind`、`ApprovalState`、`ActionResult`、そのほかの DTO は、それを所有する Task（27〜31）で定める。Task 22 では定義しない（未確定を安全な既定と見なさないため）。

### 4.2 判定（`src/control/profile-policy.ts`）

公開する関数（名前は実装で変えてよいが、責務は変えない）:

1. `validateSiteProfile(input: unknown, context: ProfileValidationContext): ProfileValidationResult`
   - 戻り値は `{ ok: true, profile }` か `{ ok: false, errors: readonly ProfileValidationError[] }`。`errors` は閉じた一覧のコード（4.4）と、英語の技術的な詳細の組。
   - `context` は、参照するターゲット JSON を読み込んだ結果（`AuditConfig`。既存の `loadConfig` の結果）を、呼び出し側が渡す。`profile-policy.ts` はファイルを読まない（入出力を持たない判定の部品にする）。
2. `resolveLegacyTargetProfile(config: AuditConfig, targetConfigPath: string): SiteProfile`（2026-10-24 LG-3 で消した。製品で呼ぶ所がなかった。テストの組の設計書 3.7.2）
   - プロファイルのない旧ターゲット JSON を、`environment: 'PUBLIC'`、`mode: 'PUBLIC_PASSIVE'`、`auth: 'NONE'`、`approvedTestOrigins: []`、`environmentEvidenceRef: null`、`revision: 1`、`profileId` は `target.id` から 4.3 の規則で作った値、として解決する（I01）。権限を増やす入力を受けない。
3. `assertProfileRevisionAdvance(previous: SiteProfile | null, next: ValidatedSiteProfile): ProfileValidationResult`
   - `next` は `validateSiteProfile` が受けた値だけ（型の印 `ValidatedSiteProfile` と、`profile-policy.ts` の中の実行時の印）。印のない値（写し、型を変換した値、Proxy）は `PROFILE_SCHEMA_INVALID`。保存から読んだ値は、もう一度 `validateSiteProfile` を通してから渡す（Task 23）。
   - `previous` と `next` の形をスキーマで確かめ、同じ `profileId` で、改訂の番号がどちらも安全な整数で、`next` が大きいときだけ受ける（それ以外は `PROFILE_REVISION_NOT_ADVANCED`）。保存は Task 23 の owner。

### 4.3 検証の規則（すべて fail-closed。1 つでも当たれば拒否）

- **形**: スキーマ（`schemas/control/profile.schema.json`）に合わない（未知の鍵、型、閉じた一覧にない値、`schemaVersion` 違い）。
- **`profileId`**: `^[a-z0-9][a-z0-9-]{0,62}$`（小文字の英数字とハイフン。顧客名を避けるのは運用。形だけを判定）。
- **`targetConfigPath`**: ASCII の `[A-Za-z0-9._/-]` だけからなる相対パスで、区切りは `/`、`..` と絶対パスとドライブ名を含まず、`config/targets/` か `local/targets/` の下の `.json`。参照するターゲット JSON は呼び出し側が読み、`context` に渡す（渡された `AuditConfig` の `target.id` と、パスの対応は呼び出し側の責務。判定は形だけ）。
- **モードと環境と認証の組み合わせ**（表のとおり。表にない組み合わせはすべて拒否）:

| environment | mode | auth | approvedTestOrigins | environmentEvidenceRef |
| --- | --- | --- | --- | --- |
| `PUBLIC` | `PUBLIC_PASSIVE` | `NONE` | 空 | `null` |
| `TEST` | `PUBLIC_PASSIVE` | `NONE` | 空 | `null` か非空の文字列（任意） |
| `TEST` | `TEST_AUTH_PASSIVE` | `MANUAL_SESSION` か `AUTOMATED_LOGIN` | 1 件以上 | 非空の文字列（必須） |
| `TEST` | `TEST_APPROVED_WRITE` | `MANUAL_SESSION` か `AUTOMATED_LOGIN` | 1 件以上 | 非空の文字列（必須） |

  - `PUBLIC_PASSIVE` は、どの環境でも認証なし（ロードマップ 3.1）。テスト環境を認証なしの公開監査で見ることは許す（R02 の「環境ごとに方式を選ぶ」）。
  - `PUBLIC` と `TEST_AUTH_PASSIVE`・`TEST_APPROVED_WRITE` の組み合わせは拒否（RF1）。
- **`approvedTestOrigins`**（TEST の認証・書き込みのモード）:
  - 各値は Origin の正規の直列化（`new URL(v).origin === v`）で、重複なし。
  - scheme は `https:`。`http:` は、host が loopback（`localhost`、`127.0.0.1`、`[::1]`）のときだけ（ロードマップ 1.3）。
  - 参照するターゲット JSON の `site.allowedOrigins` に含まれる（監査の範囲の外に、認証・書き込みの許可を作らない）。
- **`environmentEvidenceRef`**: 非秘密の参照（UTF-16 のコード単位で 1〜200。制御文字、U+2028・U+2029、向きを変える文字（U+200E、U+200F、U+202A〜U+202E、U+2066〜U+2069）、対になっていないサロゲートを含まず、空白とゼロ幅の文字だけでない）。中身の検証（テスト環境の隔離の確認）は、人間の登録の手順（Task 23 の UI と Task 25 の実行前の確認）の責務。Task 22 は「ないなら認証・書き込みのモードを拒否する」だけを判定する（I03）。
- **`revision`**: 1 以上の安全な整数。

### 4.4 拒否のコード（閉じた一覧。`contracts.ts`）

`PROFILE_SCHEMA_INVALID`、`PROFILE_ID_INVALID`、`PROFILE_TARGET_PATH_INVALID`、`PROFILE_MODE_ENVIRONMENT_MISMATCH`（RF1 を含む組み合わせの誤り）、`PROFILE_AUTH_MISMATCH`、`PROFILE_TEST_ORIGINS_REQUIRED`、`PROFILE_TEST_ORIGIN_INVALID`、`PROFILE_TEST_ORIGIN_OUTSIDE_TARGET`、`PROFILE_ENVIRONMENT_EVIDENCE_REQUIRED`、`PROFILE_REVISION_NOT_ADVANCED`。表示の文言は Task 23（UI）で表示カタログに置く。Task 22 ではコードと英語の詳細だけを返す。

### 4.5 互換性の固定（golden 回帰）

既存のテストが広く押さえているので、Task 22 では「Control の追加で何も変わらないこと」を固定する検査を足す。

- **I01**: ターゲット JSON に `mode`、`environment`、`auth`、`profile` のどれかを書くと、`loadConfig` が `CONFIG_INVALID`（`unknown configuration key`）で拒む（既存の振る舞いを、意図として固定する）。`resolveLegacyTargetProfile` は、どの `AuditConfig` からも `PUBLIC_PASSIVE`・`NONE`・空の origin を返す。
- **I02（Guard）**: `classifyPassiveRequest` の判定の表（method `GET`・`HEAD`・`POST`・`PUT`・`PATCH`・`DELETE`・`OPTIONS` × 許可 Origin の内・外 × ナビゲーション・サブリソース）を、golden のテストとして固定する（今の値を期待値として書く。将来 `PUBLIC_PASSIVE` の判定を変えたら、このテストが落ちる）。
- **I02（出力）**: `schemas/run.schema.json`、`audit.schema.json`、`page.schema.json`、`checkpoint.schema.json` の `$id` と `schemaVersion` の値が変わっていないことを、テストで固定する（文字列の比較）。
- **CLI**: 既存の `tests/integration/cli.test.ts`、`fixture-full-crawl.test.ts`、`cli-resume.test.ts` が今までどおり PASS する（新しいテストは足さない。全体の検証で確かめる）。
- **Architecture Gate**: (a) `src/` の `control/` 以外のファイルは `src/control/` を import しない。(b) `src/control/` は `playwright`、`src/browser/`、`src/safety/`、`src/orchestration/` を import しない（Task 22 の時点では、判定は監査エンジンから独立）。正規表現の検査。1 ファイル 1 秒以内。

## 5. SSOT と安全性への影響

| 項目 | owner | この設計での扱い |
| --- | --- | --- |
| 監査モード・環境・認証方式の閉じた一覧、プロファイルの型 | `src/control/contracts.ts` | 新設（SSOT） |
| プロファイルの検証と旧 JSON の解決（環境と監査モードの判定） | `src/control/profile-policy.ts` | 新設（唯一の owner） |
| プロファイルの JSON Schema | `schemas/control/profile.schema.json` | 新設。`contracts.ts` と一致をテスト |
| Passive の要求の判定 | `src/safety/request-policy.ts` | 変更なし（golden で固定） |
| 設定の読み込みと検証 | `src/config/*` | 変更なし（ターゲット JSON の閉じた形を固定） |
| Run と出力 | `run-coordinator.ts`、`artifact-writer.ts`、`schemas/*.json` | 変更なし |

- 第二の owner: プロファイルの判定は `profile-policy.ts` の 1 か所。UI（Task 23）と実行ワーカー（Task 24 以降）は、この関数を呼ぶだけにする。
- target 固有の情報: `src/control/` と `schemas/control/` と fixture に、実在のドメインや顧客名を書かない（例は `example.com`、`example.invalid`、`127.0.0.1` だけ）。既存の Target Isolation の Architecture Gate の対象に `src/control/` も入る（`src/**` 全体が対象）。

## 6. 共通部品と共通仕様

| 区分 | 名前 | 置き場所 | この設計での扱い |
| --- | --- | --- | --- |
| 利用する既存の部品 | `isRecord`、`deepFreeze` | `src/core/guards.ts`、`src/core/immutable.ts` | 利用のみ |
| 利用する既存の部品 | スキーマの検証（Ajv） | `src/core/schema-validator.ts` | `profile` のスキーマを加えるかは 7 で決める |
| 利用する既存の部品 | `AuditConfig` | `src/config/types.ts` | 型の参照のみ（`profile-policy.ts` から。`src/config/` は監査エンジンの一部だが、型の参照は許す） |
| 新しく作る共通部品 | `AUDIT_MODES` など、`validateSiteProfile`、`resolveLegacyTargetProfile` | `src/control/*` | 新設。共通部品台帳に追記 |

- 後続の Task で使われる見込み: すべて（Task 23 の保存と UI、Task 24 のジョブ、Task 25 以降の実行前の確認）。
- スキーマの検証: 既存の `validateArtifact` は成果物のスキーマの名前の閉じた一覧を持つ。プロファイルは成果物ではないので、`src/control/` に Control のスキーマの検証の部品（`validateControlDocument('profile', value)`）を新設し、Ajv の設定（`strict: true`、`allErrors: true`）を既存と合わせる。Ajv の扱いは既存の `src/core/schema-validator.ts` の 1 か所に残し、そこに公開した `createSchemaValidatorRegistry` を使う（T22a の Blocker の判断。成果物の契約と管理の契約を分ける。ロードマップ 4.2 の `schemas/control/` の分離）。Ajv は既存の依存で、新しい依存ではない。
- 変更容易性: Task 23 以降でモードや認証方式を 1 つ足すとき、変えるのは `contracts.ts` の一覧、スキーマの enum、`profile-policy.ts` の組み合わせの表だけ（表示は Task 23 のカタログ）。

## 7. テスト設計

- `tests/unit/control-profile-policy.test.ts`（新設）: 4.3 の組み合わせの表をすべて（受ける組み合わせと、表にない組み合わせ。`PUBLIC + TEST_AUTH_PASSIVE`、`PUBLIC + TEST_APPROVED_WRITE`、`TEST + 証拠なし`、`TEST + origin なし`、未知のモード、`schemaVersion` 違い、`revision` 0・負・小数、`profileId` の形、`targetConfigPath` の `..`・絶対パス・ドライブ名・`config/targets/` の外、origin の形（パスつき、末尾の `/`、大文字、`http` の非 loopback、ターゲットの許可 Origin の外）、改訂の単調増加）。
- `tests/unit/control-legacy-profile.test.ts`（新設）: `resolveLegacyTargetProfile` が、`config/targets/example.json` と fixture のターゲットから `PUBLIC_PASSIVE`・`NONE`・空を返す。ターゲット JSON にモードの鍵を書くと `loadConfig` が拒む。
- `tests/unit/control-contracts.test.ts`（新設）: `contracts.ts` の一覧と `schemas/control/profile.schema.json` の enum の一致、スキーマの検証（受ける例と拒む例）。既存の `schema-enum-consistency.test.ts` の対応表に、Control のスキーマの enum を加える（「対応表にない enum があれば失敗」の決まりのため）。
- `tests/unit/public-passive-golden.test.ts`（新設）: 4.5 の Guard の判定の表と、成果物のスキーマの `$id`・`schemaVersion` の固定。
- `tests/architecture/`（既存のファイルに追加）: 4.5 の Architecture Gate。
- RED: 新設のテストは、モジュールがないので最初は失敗する。golden のテストは、今の値を期待値として書くので最初から PASS する（固定のためのテスト。RED の対象外と明記する）。Architecture Gate は、`src/control/` を作る前は対象がなく PASS する。違反を作って落ちることを、実装者が一時の変更で確かめて戻す（報告に書く）。

## 8. 対象ファイル

| パス | 責務 | 変更の種類 |
| --- | --- | --- |
| `src/control/contracts.ts` | 型と閉じた一覧 | 新規 |
| `src/control/profile-policy.ts` | 検証と解決 | 新規 |
| `src/control/control-schema-validator.ts` | Control のスキーマの検証 | 新規 |
| `schemas/control/profile.schema.json` | プロファイルのスキーマ | 新規 |
| `tests/unit/control-*.test.ts`、`tests/unit/public-passive-golden.test.ts` | テスト | 新規 |
| `tests/unit/schema-enum-consistency.test.ts` | 対応表の追加 | 変更 |
| `tests/architecture/semantic-ownership.test.ts`（か新しいファイル） | Architecture Gate | 変更 |
| `tests/fixtures` か `fixtures/control/` | プロファイルの例（匿名の値だけ） | 新規 |
| `package.json` の `build` | `schemas/control/` も `dist/schemas/control/` に写る（今の `cpSync('schemas', ...)` は再帰なので変更不要の見込み。確かめる） | 変更なしの見込み |
| `doc/spec/`（新設の `profiles.md`） | プロファイルの仕様（利用者向け。Task 23 で UI から使うまでは「開発中」と明記） | 新規 |

## 9. 対象外

- プロファイルの保存（SQLite）、UI、プロファイルを使う実行の経路（Task 23・24）。
- 認証・書き込みの機能（Task 25 以降）。Task 22 は判定で「許可しない」側だけを作る。
- テスト環境の隔離の実際の確認（DNS、リダイレクト、接続先の照合）。Task 25 の実行前の確認で行う。Task 22 は「証拠の参照がなければ拒否」まで。
- 同じ Origin が別のプロファイル（PUBLIC と TEST）で重なる場合の判定（複数のプロファイルを見渡す判定は、保存の owner の Task 23 で行う）。
- CLI の変更。

## 10. 完了条件（Exit Gate G22）

- [ ] 7 のテストが PASS し、新設のテストは実装の前に失敗した（golden を除く）。
- [ ] `npm run verify` が通しで PASS する（既存の公開監査の互換。CLI、fixture の full crawl、Gate を含む）。
- [ ] プロファイルの不正な値と、表にない組み合わせが、すべて拒否される。
- [ ] Safety の不変条件の違反 0（既存の Gate）。実サイトへのアクセスなし。
- [ ] 独立レビュー（安全: SSOT、fail-closed、未監視の経路を新しく作っていないこと）で Critical 0・Important 0。
- [ ] ユーザーの承認。

## 11. 設計変更履歴

| 日付 | 契機 | 変更内容 | 影響範囲 |
| --- | --- | --- | --- |
| 2026-10-09 | 初版（ロードマップの Task 22） | - | `src/control/`、`schemas/control/`、テスト、`doc/spec/` |
| 2026-10-09 | ユーザーの承認 | 設計の判断 1〜5 を承認（テスト環境の `PUBLIC_PASSIVE` は、ログイン前の画面だけを監査する使い方。ログインの後ろは Task 25・26 の `TEST_AUTH_PASSIVE`）。UI のコンセプトアートは、後でユーザーが提供する（Task 23 の設計で使う） | なし |
| 2026-10-09 | T22a の Blocker（GATE-ARCH08: Ajv の import は `src/core/schema-validator.ts` だけ。Control の検証の部品が Ajv を import すると Gate に反する） | 6 を改めた: Ajv の扱いは `src/core/schema-validator.ts` の 1 か所に残し、そこに、スキーマの一覧から Ajv を作って検証関数を返す部品と、誤りの文の作り方（今の `describeError`）を公開する。既存の `validateArtifact` の振る舞いは変えない。`src/control/control-schema-validator.ts` は、その部品で Control のスキーマ（`schemas/control/`）を登録して検証するだけにする（Ajv を import しない）。GATE-ARCH08 は変えない | `src/core/schema-validator.ts`（公開の追加だけ）、`control-schema-validator.ts` |
| 2026-10-09 | T22b の Blocker（loopback の定義が `validate-config.ts` に非公開で置かれている。Origin の判定を `src/control/` に書くと GATE-ARCH04（URL の受け入れの判定は URL の owner だけ）に反する） | 案 A: URL の意味の owner の `src/crawl/normalize-url.ts`（core だけを import する）に、`LOOPBACK_HOSTNAMES`・`isLoopbackUrl`（`validate-config.ts` から移す。`validate-config.ts` はそれを import する）、値が HTTP(S) の Origin の正規の直列化かを返す部品、許可 Origin の設定値にある Origin が含まれるかを返す部品を置く。`profile-policy.ts` はそれらを呼ぶだけ。GATE-ARCH04 は変えない。`src/control/` から `src/crawl/normalize-url.ts` の import は許す（4.5 (b) の禁止の対象外） | `normalize-url.ts`、`validate-config.ts`（import の付け替えだけ）、テスト、台帳 |
| 2026-10-09 | T22b の報告 | 4.3 の「受ける 4 行」は、認証の欄に 2 つの値を持つ行があるので、組み合わせとしては 18 通り中 6 通りを受ける。拒否のコードの対応（モードごとに受ける環境の一覧と認証の一覧で判定し、両方に当たれば両方のコード）、PUBLIC の `environmentEvidenceRef` が null でないときは `PROFILE_MODE_ENVIRONMENT_MISMATCH`、`environmentEvidenceRef` の空白だけ・制御文字・U+2028/2029 は `PROFILE_ENVIRONMENT_EVIDENCE_REQUIRED`、安全な整数でない `revision` は `PROFILE_SCHEMA_INVALID`、`profileId` 違いの改訂は `PROFILE_REVISION_NOT_ADVANCED`（閉じた一覧を広げない）、`targetConfigPath` は `isPortableRelativeArtifactPath` に加えて `..` と `:` を含まない、`profileId` の作り方（小文字化、`-` への置き換え、63 文字、合わなければ `legacy-target`）を、実装とテストで固定した | なし（記述） |
| 2026-10-09 | T22c の報告 | (1) 4.4 の補足: 形の誤りはスキーマの検査で先に `PROFILE_SCHEMA_INVALID` になる（`profileId` の形、`approvedTestOrigins` の重複、`environmentEvidenceRef` の空と長さ）。`PROFILE_ID_INVALID` は防御のための判定で、ふつうの経路では返らない（`doc/spec/profiles.md` は実際の振る舞いで書いた）。(2) 4.5 の Architecture Gate は `tests/architecture/control-boundary.test.ts` に置き、(b) に「`src/control/` から実行時に読み込む import を順にたどり、禁止の対象に届かないこと」（間接の検査）を加えた（`validate-config` が `src/safety/` を間接に読み込む、という意図を固定する） | なし（記述） |
| 2026-10-09 | 独立レビュー T22R（Critical 0、Important 2、Minor 6）と T22d の報告 | 4.2 の 3 を改めた: `assertProfileRevisionAdvance(previous: SiteProfile | null, next: ValidatedSiteProfile)`。`validateSiteProfile` が受けた値だけを、型の印（`ValidatedSiteProfile`）と実行時の印（`profile-policy.ts` の中の `WeakSet`）で受ける。改訂の番号は両方が安全な整数で次が大きいときだけ。保存から読んだ値は、もう一度 `validateSiteProfile` を通してから渡す（Task 23）。4.3 に加えた: `targetConfigPath` は ASCII の `[A-Za-z0-9._/-]` だけ、`environmentEvidenceRef` は UTF-16 のコード単位で数え、空白・ゼロ幅の文字だけ、向きを変える文字、対になっていないサロゲートを拒否。`LOOPBACK_HOSTNAMES` は凍結した配列。Gate: `createSchemaValidatorRegistry` を呼べるのは core と Control の検証の 2 ファイルだけ（GATE-ARCH08 (T22d)）、Gate (b) に `@axe-core/playwright`、間接の検査は `createRequire` の文字列の指定子も追う。M5（golden の範囲）は記録だけ: Guard の golden は WEBSOCKET・小文字の method・子フレームを含まず、CLI の互換は既存の結合テスト（`cli.test.ts`、`fixture-full-crawl.test.ts`、`cli-resume.test.ts`）で固定する（ロードマップの「golden 回帰を追加」はこの組み合わせで満たす） | なし（記述） |
| 2026-10-09 | 独立レビュー T22R2（承認。Critical 0、Important 0、Minor 4） | 本文（4.2 の 3、4.3、6）を変更履歴に合わせた（Minor 2）。残る Minor を記録: (1) GATE-ARCH08 (T22d) は `createRequire`・テンプレート・`new URL` の指定子を取り出さない（Gate (b) は取り出す。指定子の取り出しの共通化は CC-054）、(3) `environmentEvidenceRef` は U+061C と Default_Ignorable_Code_Point の一部（U+00AD など）を受ける（権限は上がらない。参照の確認は人が行う。Task 23 の UI で表示の安全を扱うときに見直す）、(4) 同じプロセスの中で `WeakSet.prototype.has` や `Set.prototype.has` を書き換えると印や loopback の判定をだませる（同じプロセスの中の悪意あるコードは脅威の範囲外） | なし（記述） |
