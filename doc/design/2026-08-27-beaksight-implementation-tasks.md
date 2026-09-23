# BeakSight 実装指示

BeakSightを、承認済みの設計書および実装計画に従って実装してください。

## 1. Authority / SSOT

以下を実装上の正とします。

1. `doc/design/2026-08-27-beaksight-web-audit-design.md`
2. `doc/design/2026-08-27-beaksight-implementation-plan.md`

実装計画に記載された **Architecture / SSOT Invariants** は、設計書承認後に追加承認された拘束条件です。

設計書と実装計画の記述が競合する場合は、

**実装計画のArchitecture / SSOT Invariantsおよび具体的Task定義を優先してください。**

勝手な仕様追加、スコープ拡張、代替アーキテクチャへの変更は禁止します。

不整合・実装不能・重大な設計上の欠陥を発見した場合は、推測で補完せず、そのTaskを停止して報告してください。

---

# 2. 実装目的

Node.js + TypeScript + Playwright Libraryを使用して、公開Webサイトを読み取り専用で再帰巡回するWebサイト自動監査CLI **BeakSight** を実装します。

主要目的は以下です。

* 公開Webサイトの再帰クロール
* HTTP / Resource / JavaScript / Console監査
* DOM / HTML監査
* Accessibility / Contrast監査
* Layout / Responsive監査
* CLS / Web Vitals / Synthetic Performance Evidence取得
* Telemetry / Server-Timing等のブラウザ観測可能Evidence取得
* 安全なUI候補の隔離Interaction監査
* Cross-page構造監査
* Screenshot取得
* JSON / HTMLレポート生成
* ChatGPT意味監査用handoff bundle生成

自動側では意味的・美的判断を行わず、

**Evidenceを収集した後に、決定論的RuleからFindingを生成する**

構造を守ってください。

---

# 3. 実装順序

`2026-08-27-beaksight-implementation-plan.md` の **Task 1〜Task 21を記載順に実施してください。**

Taskを飛ばさないでください。

各Taskは必ず、

```text
RED
↓
最小実装
↓
GREEN
↓
関連verification
↓
Task完了判定
```

のTDDサイクルで進めてください。

既にPASSしたTaskを、後続Taskで理由なく再実装しないでください。

---

# 4. Architecture / SSOT Invariants

以下は最上位の実装制約です。

## 4.1 Single Semantic Owner

同じ意味・判断・変換には、production上のownerを1つだけ持たせてください。

以下を複数箇所へ再実装することは禁止します。

* Config resolution
* URL normalization
* URL admission / scope classification
* Link extraction
* Crawl queue authority
* HTTP safety decision
* Interaction admission
* ID / Finding fingerprint生成
* Run status derivation
* Rule registration
* Cross-page evaluation
* JSON Schema validation
* Final artifact serialization

---

## 4.2 No Parallel Entry Points

同じユースケースに対して、

* 別Facade
* convenience helper
* legacy flow
* alternate implementation
* 独立した第二入口

を作らないでください。

Wrapperが必要な場合も、canonical ownerへ委譲するだけとし、意味論を再解釈してはいけません。

---

## 4.3 No Duplicate Processing Flow

canonical ownerが一度生成したmodelは、後続処理で再利用してください。

例えばLinkについては、

```text
DOM
 ↓
discoverLinks()
 ↓
LinkEvidence[]
 ├─ PageAuditResult
 ├─ RunCoordinator / Crawler
 ├─ Rule Engine
 └─ Reporter / ChatGPT Evidence
```

とします。

`dom-collector.ts`、`run-coordinator.ts`、Reporter等で再度`a[href]`を解析して、独自のLinkモデルを生成してはいけません。

---

## 4.4 Encapsulation

各ownerはtyped interfaceの背後に実装を隠してください。

Consumerは、

* private state
* global config
* 他ownerの内部実装

に依存してはいけません。

依存はDIしてください。

---

## 4.5 Configuration SSOT

設定解決の唯一のproduction authorityは、

```text
src/config/load-config.ts
```

です。

canonical API:

```text
loadConfig(path, overrides?) -> AuditConfig
```

処理順序は、

```text
generic DEFAULT_POLICY
 ↓
target config
 ↓
CLI overrides
 ↓
validation
 ↓
immutable AuditConfig
```

です。

他moduleで、

* JSON target configを読む
* CLI optionを解析する
* Configをdeep mergeする
* environment variableから監査設定を直接読む

ことは禁止します。

---

# 5. SSOT Owner Matrix

以下のownerを変更しないでください。

| Semantic                     | Owner                              |
| ---------------------------- | ---------------------------------- |
| Effective configuration      | `src/config/load-config.ts`        |
| URL canonicalization         | `src/crawl/normalize-url.ts`       |
| URL admission                | `src/crawl/admission-policy.ts`    |
| Link extraction              | `src/crawl/discover-links.ts`      |
| Crawl queue authority        | `src/crawl/crawl-queue.ts`         |
| Passive HTTP authority       | `src/safety/request-policy.ts`     |
| Interaction admission        | `src/safety/interaction-policy.ts` |
| IDs / Finding fingerprint    | `src/core/ids.ts`                  |
| Final Run status             | `src/core/status.ts`               |
| Page rule registry           | `src/audit/rule-catalog.ts`        |
| Cross-page rule evaluation   | `src/audit/cross-page-rules.ts`    |
| JSON Schema validation       | `src/core/schema-validator.ts`     |
| Final artifact serialization | `src/report/artifact-writer.ts`    |

新しい実装で第二ownerが必要に見えた場合は、第二ownerを追加せず停止して設計上の問題として報告してください。

---

# 6. Target Isolation

production sourceである、

```text
src/**
```

は完全にtarget-agnosticにしてください。

以下を`src/**`へ記述してはいけません。

* `example`
* 対象固有の名称（顧客サイト名等）
* 対象domain
* 対象absolute URL
* 対象固有page path
* 対象固有DOM selector
* 対象固有メニュー構造
* 対象固有page list
* 対象固有expected title
* その他target固有ロジック

対象固有情報は、

```text
config/targets/**
```

に隔離してください。

初期targetは、

```text
config/targets/example.json
```

です。

各target configには必ず、

```text
target.id
```

を持たせ、全target間で一意であることを検証してください。

サイト側の通常改修だけで`src/**`変更が必要になる構造は禁止します。

---

# 7. Safety Invariants

BeakSightは読み取り専用を最優先します。

Passive Contextで実ネットワーク送信を許可するmethodは、

```text
GET
HEAD
```

のみです。

以下は送信前にBLOCKしてください。

```text
POST
PUT
PATCH
DELETE
その他すべてのnon-read method
```

また以下を実行してはいけません。

* form submission
* 登録
* 更新
* 保存
* 削除
* 予約確定
* 問い合わせ送信
* `tel:`
* `mailto:`
* `sms:`
* `intent:`
* `javascript:`
* LINE等の外部application launch
* download
* external-origin navigation
* その他状態変更操作

BLOCKした処理は隠さずSafety Ledgerへ記録してください。

Interaction AuditはDisposable BrowserContextで実行し、interaction開始後は、

* network
* navigation
* popup
* download
* WebSocket

をfail-closedしてください。

---

# 8. Evidence before Finding

以下の責務境界を破らないでください。

```text
Evidence Collector
    ↓
Normalized Evidence
    ↓
Rule Engine
    ↓
Finding
```

CollectorはFindingを作成してはいけません。

Reporterは監査判定を行ってはいけません。

CrawlerはRule評価を行ってはいけません。

Rule Engineはブラウザを操作してはいけません。

意味的・美的判断はFindingにしないでください。

例えば、

```text
anchorText = "交通事故"
href = "/symptoms"
```

はEvidenceです。

「リンク文言と遷移先が不適切である」はBeakSight側で断定しません。

---

# 9. Completion Semantics

以下を厳守してください。

```text
COMPLETE
PARTIAL
FAILED
ABORTED_BY_SAFETY
```

Findingの件数はRun Statusを決定しません。

例えば、

```text
100件のERROR Finding
+
全ページ監査完了
```

なら`COMPLETE`になり得ます。

一方、

```text
Finding 0件
+
一部ページ未監査
```

なら`COMPLETE`は禁止です。

以下を隠してはいけません。

* skipped
* blocked
* timed out
* not observed
* not verified
* failed
* budget reached
* schema invalid
* collector incomplete

fake completionは禁止します。

---

# 10. Architecture Gates

Task 18で以下を必ず実装してください。

```text
GATE-ARCH01
GATE-ARCH02
GATE-ARCH03
GATE-ARCH04
GATE-ARCH05
GATE-ARCH06
GATE-ARCH07
GATE-ARCH08
```

要件:

### ARCH01 Target Isolation

`config/targets/*.json`からtarget-specific identity / URLを取得し、

```text
src/**/*.ts
```

に同一文字列が存在しないことを検証してください。

`target.id`の一意性も確認してください。

### ARCH02 Configuration Authority

production componentはDIされた`AuditConfig`だけを利用し、

`loadConfig`を呼ぶのはCLI/composition rootだけであることを検証してください。

### ARCH03 Link Discovery SSOT

anchor / href extractionを行うproduction ownerは、

```text
discover-links.ts
```

だけであること。

`PageAuditor`で一度生成した`LinkEvidence[]`を`RunCoordinator`が再利用することを証明してください。

### ARCH04 URL Semantics SSOT

URL normalization / admission consumerは、

```text
normalizeUrl
classifyUrl
```

を利用してください。

alternate normalizer / admission implementationは禁止です。

### ARCH05 Run Status SSOT

最終Run Statusは、

```text
deriveRunStatus()
```

だけが決定してください。

### ARCH06 Fingerprint SSOT

Finding fingerprintは、

```text
createFindingFingerprint()
```

だけが生成してください。

### ARCH07 Rule Catalog SSOT

Page Ruleは、

```text
RULE_CATALOG
```

へ一度だけ登録してください。

Rule Engineはそのregistryだけを使用します。

Cross-page semanticsは、

```text
evaluateCrossPageRules()
```

のみを通してください。

Reporterでrule評価してはいけません。

### ARCH08 Schema / Artifact Authority

JSON validationは、

```text
validateArtifact()
```

へ委譲してください。

Final canonical serializationは、

```text
ArtifactWriter.writeRun()
```

を唯一のownerとしてください。

---

# 11. Acceptance Gates

Targetサイトへアクセスする前に、以下すべてをPASSさせてください。

## Safety

```text
S01-S10
```

## Auditor

```text
A01-A10
```

## Architecture

```text
ARCH01-ARCH08
```

1件でもFAILしている状態でtarget-site smokeを実施してはいけません。

---

# 12. Mandatory Review Checkpoints

以下のTask終了後は、自動的に次Taskへ進まず、一度実装状態を整理してください。

```text
Task 3
Task 5
Task 11
Task 14
Task 15
Task 18
Task 21
```

特に確認する内容:

### Task 3

URL / Link semanticsのSSOTが成立していること。

### Task 5

Mutation preventionがserver boundaryで証明されていること。

### Task 11

Dynamic Interactionがfail-closedであること。

### Task 14

Page pipeline内でLinkEvidence等を再抽出せずcanonical modelを再利用していること。

### Task 15

Crawl completenessとRun Statusにfake completionがないこと。

### Task 18

S01-S10 / A01-A10 / ARCH01-ARCH08がすべて成立していること。

### Task 21

Target full auditの証跡とSafety invariantが成立していること。

---

# 13. 初期Target実行

Safety / Auditor / Architecture Gate通過後にのみ実施してください。

Target identity / URLはコマンドへハードコードせず、

```bash
TARGET_CONFIG=./config/targets/example.json
```

を参照してください。

まずSmoke:

```text
maxPages = 5
headed = true
concurrency = 1
```

SmokeがPASSした場合だけFull Auditへ進んでください。

Targetサイトで問題が発見されても、BeakSightのproduction codeへtarget-specific workaroundを追加してはいけません。

Generic auditorの不備なのか、サイト自身のFindingなのかを分離してください。

---

# 14. Verification

各Taskでは、そのTaskの計画に記載されたverificationを実行してください。

最終的には少なくとも以下をfresh runしてください。

```bash
npm run verify
npx vitest run tests/integration/safety-gates.test.ts tests/integration/auditor-gates.test.ts
npx vitest run tests/architecture/target-isolation.test.ts tests/architecture/semantic-ownership.test.ts
```

最終Completionには次の証拠が必要です。

```text
TypeScript strict compile PASS
Unit tests PASS
Component tests PASS
Integration tests PASS
Architecture tests PASS
Safety Gates S01-S10 PASS
Auditor Gates A01-A10 PASS
Architecture Gates ARCH01-ARCH08 PASS
JSON Schema validation PASS
fixture full crawl COMPLETE
target smoke PASS
full audit executable
required JSON / HTML / Screenshot / ChatGPT bundle generated
Safety Ledger invariant violations = 0
non-read target operations sent by BeakSight = 0
```

古いテスト結果や推測をPASS根拠にしてはいけません。

---

# 15. Not-Run Ledger

実行できなかったcommand / test / gateが存在する場合は必ず報告してください。

形式:

```text
NOT RUN
- command:
- reason:
- impact:
- completion blocker: yes/no
```

実行していないものをPASS扱いしてはいけません。

---

# 16. 実装報告フォーマット

実装終了時は以下を報告してください。

## 1. Result

```text
COMPLETE / PARTIAL / FAILED / ABORTED_BY_SAFETY
```

## 2. Implemented Tasks

Task 1〜21について、

```text
Task N: PASS / PARTIAL / NOT RUN
```

を列挙。

## 3. Changed Files

新規・変更ファイルを責務付きで列挙。

## 4. SSOT / Architecture Verification

以下について実装ownerとconsumerを報告。

* Config
* URL normalization
* URL admission
* Link extraction
* Safety policy
* Interaction policy
* Finding fingerprint
* Run Status
* Rule Catalog
* Cross-page rules
* Schema validation
* Artifact serialization

第二ownerが存在しないことを明記してください。

## 5. Target Isolation

```text
src/** target-specific identity/domain/absolute URL occurrences:
```

の検査結果を報告してください。

## 6. Safety Gates

S01-S10の結果。

## 7. Auditor Gates

A01-A10の結果。

## 8. Architecture Gates

ARCH01-ARCH08の結果。

## 9. Test / Build Results

実行したcommandと、

```text
PASS / FAIL
test count
failure count
exit code
```

を記録。

## 10. Target Smoke / Full Audit

実施した場合、

* target.id
* Run Status
* discovered pages
* audited pages
* failed/skipped pages
* blocked actions
* Safety invariant violations
* Finding counts
* output artifact path

を報告。

## 11. Not-Run Ledger

未実行項目をすべて記載。

## 12. Remaining Issues

failed / partial / unresolvedだけを列挙。

---

# 17. 禁止事項

以下は禁止します。

* 設計書・実装計画を読まずに実装開始
* 計画外の機能追加
* Target固有コードの`src/**`への追加
* 同一意味論の第二実装
* 同一処理の複数入口
* Configの独自読み込み
* URLの独自normalize
* Linkの再抽出
* Safety判定の局所実装
* Finding fingerprintの局所実装
* Run Statusの局所導出
* Reporter内でのRule評価
* Schema validatorの独自実装
* Targetサイトに対するPOST等の実送信
* テストを削除・弱体化してPASSさせる行為
* Gateをskipしてtargetサイトへ進むこと
* 未実行テストをPASS扱いすること
* `PARTIAL`を`COMPLETE`として報告すること
* 証拠なしの完了宣言

---

# 18. 開始手順

実装開始前に必ず、

1. 設計書を読む
2. 実装計画を全文読む
3. Global Constraintsを確認
4. Architecture / SSOT Invariantsを確認
5. SSOT Owner Matrixを確認
6. Task 1〜21とReview Checkpointを確認
7. 現在のrepository / branch / worktree状態を確認
8. 実装前状態を報告
9. Task 1からTDDで開始

してください。

**実装計画を短縮・再解釈せず、Task単位で最後まで実行してください。**
