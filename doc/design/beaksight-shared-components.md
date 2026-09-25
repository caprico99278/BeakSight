# BeakSight 共通部品台帳

最終更新: 2026-09-25

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
| 型 | `EvidenceRecord`、`EvidenceType`、`Finding`、`PageAuditResult`、`RunSummary` | `src/core/contracts.ts` | Evidence・Finding・結果の契約 | すべて | `Finding.category` は `FindingCategory`、`incompleteReasons` は `IncompleteReason[]`（2026-09-23 C8・F05 で閉じた型にした）。Evidence の型の定義は `src/core/evidence-types.ts` に集め、owner のファイルは別名だけを持つ（F05） |
| 型 | ブランド型のID（`RunId`、`PageId`、`EvidenceId`、`FindingId`） | `src/core/contracts.ts` | IDの取り違え防止 | すべて | 採番は `src/core/ids.ts` |
| 型 | `Viewport`、`AuditConfig`、`AuditConfigOverrides` | `src/config/types.ts` | 設定の型 | すべて | 設定の値は `loadConfig()` が決める |
| 定数 | `DEFAULT_CONFIG` | `src/config/defaults.ts` | 対象に依存しない既定の設定 | `src/config/**` と、テストでの設定の生成 | 実装タスク指示では `DEFAULT_POLICY` と呼ばれている |
| 定数 | `INTERACTION_CANDIDATE_LIMITS` | `src/safety/interaction-policy.ts` | Interaction候補の上限（`maxDomWork = 16_384`、属性の値の上限 `maxAttributeLength = 512`、class 専用の上限 `maxClassAttributeLength = 4_096` を含む） | interaction と、その collector | この値を別の場所で定義し直さない（F20b で class 専用の上限を追加） |
| 関数 | `freezeInteractionCandidate` | `src/safety/interaction-policy.ts` | Interaction候補の不変化 | interaction と、その collector | |
| 関数 | `isReadMethod` | `src/safety/request-policy.ts` | 読み取り専用のHTTPメソッドかの判定 | すべて | `GET` / `HEAD` の判定を別に書かない |
| 関数 | `redactHeaders` | `src/safety/redact.ts` | 機微なヘッダ値の伏せ字化 | Evidenceを記録するすべての場所 | |
| 関数 | `createCollectorHandle` | `src/evidence/collector-handle.ts` | collectorの開始・停止・結果取得の共通の形 | `src/evidence/**` | 現在は network と console が使用 |
| クラス | `SafetyLedger` | `src/safety/safety-ledger.ts` | ブロックした操作と不変条件違反の記録。記録上限への到達は `recordLimits`、除外した Interaction 候補は `excludedInteractionCandidates`、外部スキームへの移動の試みは `externalSchemeNavigations`（C18a。`recordExternalSchemeNavigation`）に記録する | 安全判定を行うすべての場所 | 記録を別の場所に持たない（2026-09-23 C2・C3 で拡張） |
| 定数 | `REDACTED` | `src/core/redaction.ts` | 伏せ字の文字列 | すべて | 2026-09-23 追加（F04） |
| 関数 | `pageFailureReason` | `src/browser/page-failure.ts` | ページの失敗の理由（閉じている・評価の失敗）の判定 | `src/browser/**`、`src/evidence/**` | 2026-09-23 追加（F04） |
| 定数・型 | `SAFETY_EVENT_KINDS`（`SafetyEventKind`） | `src/core/evidence-types.ts` | Safety の事象の記録の種類（`SafetyEventsEvidence` の事象の一覧の項目の名前）の唯一の一覧。書き漏れと余分は型のエラーになる | すべて | 2026-09-25 追加（C16e）。表示のラベルは `SAFETY_EVENT_KIND_CATALOG` |
| 定数・型 | `INTERACTION_REASON_CODES`（`InteractionReasonCode`。69個）、`INTERACTION_REASON_CODES_BY_STATUS`、`InteractionReasonCodeFor<S>`、status ごとの一覧（VERIFIED、BLOCKED_BY_SAFETY、EXECUTION_FAILED の分。名前は `evidence-types.ts` を見る）、`INTERACTION_NOT_VERIFIABLE_REASON_CODES`（55個）、`INTERACTION_LIFECYCLE_REASON_CODES`（4個） | `src/core/evidence-types.ts` | Interaction の Evidence の理由のコードの唯一の一覧と、status ごとの組み合わせ。詳細は `reasonDetail` に分ける（英文を理由の欄に入れない）。NOT_VERIFIABLE の区分への対応は `isolated-auditor.ts` の `INTERACTION_NOT_VERIFIABLE_REASONS`、日本語の説明は `messages.ts` | すべて | 2026-09-25 追加（C18n、CC-010）。スキーマの enum との一致は `schema-enum-consistency.test.ts` で確かめる |
| 定数・型 | `NON_EXTERNAL_NAVIGATION_SCHEMES`、外部スキームへの移動の事象の型と閉じた一覧（frame、段階、理由） | `src/core/evidence-types.ts` | 外部スキームへの移動とみなさないスキームの唯一の一覧（`http:`、`https:`、`about:`、`data:`、`blob:`）と、その事象の形（DEF-012） | safety、audit、report | 2026-09-25 追加（C18a） |
| 定数・型 | `SCROLL_INCOMPLETE_REASONS`（`ScrollIncompleteReason`） | `src/core/evidence-types.ts` | controlled scroll の部分失敗の理由 | すべて | 2026-09-23 追加（F11） |
| 定数・型 | `INTERACTION_HREF_KINDS`（`InteractionHrefKindEvidence` はここから導く） | `src/core/evidence-types.ts` | Interaction の href の種類の一覧 | すべて | 2026-09-23 追加（DEF-001b） |
| 型・関数 | `InteractionScrollRecord`、`compareInteractionScrollRecords` | `src/interaction/discover-candidates.ts` | 対象のスクロールする祖先のスクロール位置の記録と比較 | interaction | 2026-09-23 追加（F10） |
| 関数 | `interactionGeometryChanged` | `src/evidence/interaction-collector.ts` | Interaction の対象の位置か大きさが変わったかの判定（Evidence の記録用。VERIFIED の根拠には使わない） | interaction | 2026-09-23 追加（F10）、F15 で用途を限定 |
| 関数・定数 | `interactionStateChanges`、`retainPersistentInteractionChanges`、`interactionTargetStateChanged`、`MAX_CHANGED_ATTRIBUTE_NAMES`、`DETAILS_OPEN_CHANGED_FIELD`、`TARGET_ATTRIBUTES_CHANGED_FIELD`、`INTERACTION_NON_EVIDENCE_ATTRIBUTES`、`INTERACTION_NON_EVIDENCE_NAME_PATTERN`、`CLASS_ATTRIBUTE_NAME` | `src/evidence/interaction-collector.ts` | VERIFIED の根拠の計算（不安定な項目の除外、持続の確認、tooltip や入力の種類の属性の除外、名前に focus・hover を含む `data-*` 属性と class の名前の除外）、下準備の focus の前後の状態の比較 | interaction | 2026-09-23 追加（F16）、F19 で根拠にしない属性、F20 で名前の決まりと focus の前後の比較、F20b で `CLASS_ATTRIBUTE_NAME` を追加 |
| 関数 | `changedInteractionAttributeNames`、`changedInteractionClassNames` | `src/interaction/discover-candidates.ts` | 変わった属性の名前の一覧（style は `--*` 以外の宣言で比べる）、変わった class の名前の一覧 | interaction | 2026-09-23 追加（F16）、F18 で class と style の比べ方を追加 |
| 関数（ブラウザ内） | `interactionCandidateProbe`（`DISCOVER`、`RESOLVE`、`INSPECT` の3つのモード） | `src/interaction/discover-candidates.ts` | Interaction の候補を扱う、ブラウザの中の唯一の処理。作業量のカウンタ、要素の走査、テキストの切り詰め、可視判定、アクセシブルネーム、候補の組み立てを、探索・handle の解決・保持した handle の読み取りで共有する。関数の外の値を参照しない | interaction | 2026-09-25 追加（C18e、CC-008）。候補の走査を、ほかの `page.evaluate` の関数に複製しない |
| 関数・定数 | `hasExplicitTabRole`、`ASCII_WHITESPACE_SEPARATOR_PATTERN`、`attributeValueLengthLimit` | `src/interaction/discover-candidates.ts` | `role` に `tab` を明示しているかの判定、ASCII の空白での区切り（class と role で共有）、属性ごとの値の上限の選択 | interaction | 2026-09-24 追加（F20、F20b） |
| 型・関数 | `InteractionAttributeRecord`、`compareInteractionAttributeRecords` | `src/interaction/discover-candidates.ts` | 対象の要素そのものの属性の記録と比較（VERIFIED の根拠 `attributes`） | interaction | 2026-09-23 追加（F15） |
| 関数 | `interactionRejectionLedgerRecord` | `src/safety/interaction-policy.ts` | Interaction 候補の除外理由ごとに、Safety Ledger の記録先を決める | interaction | 2026-09-23 追加（C3） |
| 定数・関数 | `RULE_CATALOG`、`freezeCatalog` | `src/audit/rule-catalog.ts` | 唯一の Rule の登録先（各 Rule のファイルの配列を1つにまとめる）と、その検査（ruleId の重複、`ruleIdPrefix` の衝突）と凍結。`freezeCatalog(rules, registeredRules)` は、`CROSS_PAGE_RULES` の検査にも使う（RT12b） | audit | 2026-09-24 追加（T12a、T12a2）。Rule の登録は、各 Rule のファイルの配列（`TECHNICAL_RULES` など）に加えるだけにする |
| 型・関数 | `AuditRule`、`FindingDraft`、`PageRuleInput`、`materializeFindingDrafts`、`RuleEngine` | `src/audit/rule.ts`、`src/audit/rule-engine.ts` | Rule の契約。下書きを Finding に変える処理（検査、fingerprint、並べ替え、ID の採番）。Page rule の評価 | audit（Page rule と Cross-page rule） | 2026-09-24 追加（T12a、T12a2）。Cross-page rule も `materializeFindingDrafts` を使い、同じ処理を別に書かない。予約名 `viewport` |
| 関数・定数 | `evidenceOfType`、`distinctSorted`、`HttpStatusRange`、`SUCCESS_HTTP_STATUS_RANGE` などの `*_HTTP_STATUS_RANGE`、`isHttpStatusInRange` | `src/audit/rule-helpers.ts` | 入力のビューポートの、ある種類の Evidence を型付きで取り出す処理。重複を除いてコード単位の順に並べる処理。Rule が使う HTTP のステータスの範囲（RT12b で追加） | audit（すべての Rule のファイルと Rule Engine）、orchestration（`evidenceOfType` の利用。R15d）、report（`evidenceOfType` の利用は U16b、`distinctSorted` の利用は U16d） | 2026-09-24 追加（T12f、CC-013）。日本語の文字列リテラルを置かない |
| 関数 | `formatDecimal`、`formatPixels`、`formatMilliseconds`、`formatPercent`、`formatDateTime`、`formatDuration`、`formatBytes`、`formatCount`、`formatInteger`（C16d）、`formatNotObserved`、`DISPLAY_TIME_ZONE` | `src/presentation/format.ts` | 表示用の数値の書式（UI追補設計書の owner）。Rule の文言でも使う | Rule のファイル、表示面 | 2026-09-24 追加（T12f）。Task 16 で、日時、データ量などの書式を加える |
| 関数 | `compareRuleEvaluationFailures`、`toRuleEvaluationFailure` | `src/audit/rule-engine.ts` | Rule の評価の失敗の並べ替えと、例外を失敗に変える処理 | Rule Engine、Cross-page rule | 2026-09-24 追加（T13b、T12f） |
| 関数・定数 | `evaluateCrossPageRules`、`CROSS_PAGE_RULES` | `src/audit/cross-page-rules.ts` | Cross-page rule の唯一の入口と、その登録先 | pipeline（Task 14・15） | 2026-09-24 追加（T13、T13b） |
| 定数・型 | `PAGE_AUDIT_STAGES`（`PageAuditStage`）、`PageAuditOutcome`、`PageSafetySummary` | `src/core/contracts.ts` | ページの監査の段階の名前、Page Auditor の戻り値、ページの Safety の集計 | orchestration、Run Coordinator | 2026-09-24 追加（P14a） |
| 関数 | `derivePageAuditStatus`、`collectorIncompleteReason`、`unhandledFailureReason`、`ruleEvaluationFailureReason`、`requiredArtifactInvalidReason` | `src/core/status.ts` | ビューポートの状態からページの状態を導く（最も悪いもの。SKIPPED の扱いを含む）。`COLLECTOR_INCOMPLETE` の理由を `<段階>:<理由>` で、`UNHANDLED_FAILURE` の理由を `<場面>:<メッセージ>` で、Rule の失敗の理由を `<ruleId>:<メッセージ>` で、`REQUIRED_ARTIFACT_INVALID` の理由を `<スキーマ>:<ID>:<最初の誤り>` で作る | orchestration、report | 2026-09-24 追加（P14a）、C15x（CC-021）で2つを追加。状態の集計と理由の書式を、ほかに書かない |
| 関数・定数 | `summarizePageSafety`、`isBlockedExternalActionReason`、`BLOCKED_EXTERNAL_ACTION_REASONS` | `src/safety/safety-ledger.ts`、`src/core/evidence-types.ts` | 複数の Ledger の snapshot から、ページの Safety の集計を作る。外部作用の遮断の理由の閉じた一覧（CC-014） | orchestration、interaction | 2026-09-24 追加（P14a） |
| 定数 | `INTERACTION_CLEANUP_ALLOWANCE_MS`、`PAGE_SETTLING_PACING`、`CONTROLLED_SCROLL_PACING`、`SCROLL_STAGE_BUDGET_SETTLING_MULTIPLIER`、`INTERACTION_TIMEOUT_COUNT_PER_CANDIDATE`、`COLLECTOR_DEADLINE_MARGIN_MS`、`PAGE_CLOSE_TIMEOUT_MS`、`BROWSER_CLOSE_TIMEOUT_MS`、`CHATGPT_BUNDLE_SCREENSHOT_BUDGET_BYTES`（R16f）、`CONTEXT_CLOSE_TIMEOUT_MS`、`SESSION_OPEN_TIMEOUT_MS`（P18a） | `src/core/limits.ts` | Page Auditor の待ち方と、段階の予算の定数。候補ごとの見積もりの倍数は、設定の検証でも使う。collector に渡す期限の余裕 | orchestration、config | 2026-09-24 追加（P14a）、P14e で倍数、P14f で期限の余裕を追加 |
| クラス | `IdAllocator` | `src/orchestration/id-allocator.ts` | Run で1つの、Page、Evidence、Finding の採番器。Run Coordinator が作り、注入する | orchestration、Cross-page rule の呼び出し | 2026-09-24 追加（P14a）。ID の書式は `src/core/ids.ts` を使う |
| 関数 | `navigatePage` | `src/orchestration/page-navigation.ts` | ナビゲーションと、その結果（`navigationOutcome`、`httpStatus`、正規化した最終URL）の判定 | orchestration | 2026-09-24 追加（P14b）。例外を投げずに結果を返す |
| 関数 | `createStressSessionFactory` | `src/orchestration/stress-session.ts` | 幅の走査のセッション（Guard の付いた Passive Context）と、その Ledger の集め方 | orchestration | 2026-09-24 追加（P14b） |
| 関数 | `createEvidenceRecord` | `src/orchestration/evidence-builder.ts` | ID と `observedAt` を付けた、深く凍結した `EvidenceRecord` を作る | orchestration | 2026-09-24 追加（P14b）。Evidence の組み立てを、ほかに書かない |
| 関数 | `stageDeadline` | `src/orchestration/stage-deadline.ts` | ページの期限と、段階の予算から、段階の期限を求める | orchestration | 2026-09-24 追加（P14b） |
| クラス | `PageAuditor` | `src/orchestration/page-auditor.ts` | 1ページを、Desktop と Mobile で監査する唯一の入口 | Run Coordinator（Task 15） | 2026-09-24 追加（P14c、P14d） |
| 関数 | `isPlaywrightTimeoutError` | `src/browser/playwright-errors.ts` | Playwright の期限切れの例外かの判定 | すべて（Node側） | 2026-09-24 追加（C14x、CC-017）。期限切れの判定を、ほかに書かない |
| 関数・型 | `closePassivePageAndContext`、`closePassivePageBeforeDeadline`、`closePassiveContextBeforeDeadline`（閉じる処理の失敗は、呼び出し元が必ず Run かページの理由にする。捨てない。RP18。例外: Run がすでに `FAILED` に決まっている PREFLIGHT の失敗の経路では、メッセージに含めないことがある。RP18r の Minor-1。Task 18 の後の整理で、メッセージに含める）、`PassiveSessionCloseFailure`、`PassivePageCloseDeadlineError`、`PassiveContextCloseDeadlineError` | `src/orchestration/passive-session-close.ts` | page と Context を、期限付きで閉じ、失敗の一覧を返す。Guard が閉じた Context は、閉じ直さない（C15x で page の期限、P18a で Context の期限と期限の注入を追加） | orchestration | 2026-09-24 追加（C14x、CC-018） |
| テスト補助 | `browserOpeningPageAfterNewContext` | `tests/helpers/browser-opening-page.ts` | Guard の取り付けを失敗させるための、Browser の Proxy | `tests/**` | 2026-09-24 追加（C14x、CC-019） |
| 定数・型 | `INTERACTION_NOT_VERIFIABLE_KINDS`（`InteractionNotVerifiableKind`） | `src/core/evidence-types.ts` | Interaction の NOT_VERIFIABLE の区分（確かめたが変化なし / 確かめる手順を終えられなかった） | すべて | 2026-09-24 追加（I15a）。Run Status への反映（Task 14〜17 の設計書 5.4.1）に使う |
| 定数 | `INTERACTION_NOT_VERIFIABLE_REASONS` | `src/interaction/isolated-auditor.ts` | NOT_VERIFIABLE の理由の code から、区分（`notVerifiableKind`）への対応だけを持つ表（C18n で文言を消した。日本語の説明は `messages.ts`） | interaction | 2026-09-24 追加（I15a）。NOT_VERIFIABLE の結果は、この表を通してだけ作る |
| 定数・型 | `SITE_METADATA_KINDS`、`SITE_METADATA_OUTCOMES`、`MetadataEvidence`、`SitemapEvidence` | `src/core/evidence-types.ts` | robots.txt と sitemap.xml の Evidence と、Cross-page rule に渡す sitemap の形 | すべて | 2026-09-24 追加（R15a） |
| 定数 | `MAX_SITE_METADATA_TEXT_LENGTH`、`MAX_SITEMAP_URLS` | `src/core/limits.ts` | サイトの metadata の本文の文字数と、sitemap の URL の件数の上限 | crawl | 2026-09-24 追加（R15a） |
| 型 | `AuditRunResult`、`RunRetryRecord` | `src/core/contracts.ts` | 確定した Run（Task 16 の書き出しの入力）と、再試行の記録 | orchestration、report | 2026-09-24 追加（R15a） |
| 関数 | `sitemapEvidenceFromMetadata` | `src/crawl/sitemap-evidence.ts` | `metadata` の Evidence から、Cross-page rule に渡す `SitemapEvidence` を作る | crawl、orchestration | 2026-09-24 追加（R15a） |
| 関数 | `chromiumNetErrorCode`、`navigationFailureDetail` | `src/orchestration/page-auditor.ts` | Chromium のエラーのコードの取り出しと、ナビゲーションの失敗の detail の形 | orchestration（再試行の判断を含む） | 2026-09-24 追加（R15a）。detail の形を、ほかに書かない |
| 関数 | `skippedPageResult` | `src/orchestration/skipped-page.ts` | 監査しなかった URL の `PageAuditResult`（両方のビューポートが SKIPPED） | Run Coordinator | 2026-09-24 追加（R15a） |
| 関数・定数 | `runPreflight`、`PREFLIGHT_CHECKS`、`BrowserLauncher`、`closeBrowserBeforeDeadline` | `src/orchestration/preflight.ts` | Run の前の確認（出力先、スキーマ、開始の URL、Chromium、Guard）。失敗したら、対象のサイトにアクセスしない | Run Coordinator | 2026-09-24 追加（R15c） |
| 関数 | `collectRunEnvironment`、`readToolVersion` | `src/orchestration/environment.ts` | 環境の事実（Node、OS、Playwright、Chromium の版、User-Agent）と、BeakSight の版 | Run Coordinator | 2026-09-24 追加（R15c） |
| 関数 | `createRunIdFromTime` | `src/orchestration/run-id.ts` | UTC の時刻から `runId` を作る（書式は `createRunId`） | Run Coordinator | 2026-09-24 追加（R15c） |
| 関数・定数 | `collectSiteMetadata`、`SITE_METADATA_DEFAULT_LIMITS` | `src/crawl/site-metadata.ts` | robots.txt と sitemap.xml を、Guard の付いた Passive Context で取得し、`metadata` の Evidence にする | Run Coordinator | 2026-09-24 追加（R15b）。XML の解析は、依存パッケージを使わず、上限付きで行う |
| 定数・関数 | `NETWORK_LAYER_FAILURE_CODES`、`NETWORK_LAYER_FAILURE_CODE_PREFIXES`、`isNetworkLayerFailure` | `src/safety/network-layer-failure.ts` | Guard の違反としない、ネットワークの層の失敗の閉じた一覧（接続、名前解決、TLS、証明書） | safety | 2026-09-24 追加（DEF-004）。一覧を広げるときは、Guard の独立レビューを行う |
| クラス・定数 | `RunCoordinator`、`RunDirectoryUnavailableError`（P18d）、`RETRYABLE_NAVIGATION_FAILURE_DETAILS`、`SITE_METADATA_SAFETY_ABORT_REASON`（C18f） | `src/orchestration/run-coordinator.ts` | Run の唯一の入口（PREFLIGHT、metadata、BFS、再試行、Cross-page rule、Run Status）。再試行の対象。Run のディレクトリを作れなかったことを表す例外。違反の検出（`#safetyViolationRecorded`。C18f）の唯一の場所で、違反の後は新しい監査を始めない | CLI（Task 17） | 2026-09-24 追加（R15d）。`runArtifactDirectory` は、C16a で `src/core/artifact-layout.ts` に移した |
| 関数・定数 | `runArtifactDirectory`、`pageArtifactRelativePath`、`screenshotRelativePath`、`artifactFilePath`、`RUN_ARTIFACT_FILE_NAMES`、`PAGE_ARTIFACT_FILE_NAMES`、`PAGES_ARTIFACT_DIRECTORY`、`RETRY_ARTIFACT_DIRECTORY_PREFIX`、`SCREENSHOT_FILE_NAMES`、`isPortableRelativeArtifactPath`、`isPortableArtifactPathSegment`、`createRunArtifactDirectory`（P18d。Run のディレクトリの排他的な作成） | `src/core/artifact-layout.ts` | artifact の配置（Run のディレクトリ、ファイルの名前、ページとスクリーンショットの相対パス）と、相対パスの検証の唯一の owner（検証は C16c、CC-027） | orchestration（Page Auditor、Run Coordinator）、report、CLI | 2026-09-25 追加（C16a、CC-023）。配置の名前とパスを、ほかに書かない。report は orchestration を import しない |
| クラス・定数 | `CrawlFrontier`、`CRAWL_URL_STATES` | `src/orchestration/crawl-frontier.ts` | URL ごとの状態、深さ、ページの ID | Run Coordinator | 2026-09-24 追加（R15d）。`CrawlQueue` は、FIFO と重複の排除だけに使う |
| 関数 | `run-aggregation.ts` の集計の関数 | `src/orchestration/run-aggregation.ts` | ページの件数、Interaction の件数、`RunSafetySummary` の集計 | Run Coordinator | 2026-09-24 追加（R15d）。集計を、ほかに書かない |
| 関数 | `viewportSizeFor` | `src/config/viewport-size.ts` | ビューポートと、設定の大きさの対応づけ | すべて | 2026-09-24 追加（R15d、CC-020） |
| 定数・関数 | `SEVERITY_CATALOG`、`RUN_STATUS_CATALOG`、`PAGE_AUDIT_STATUS_CATALOG`、`INTERACTION_STATUS_CATALOG`、`INTERACTION_NOT_VERIFIABLE_KIND_CATALOG`、`FINDING_CATEGORY_CATALOG`、`EVIDENCE_TYPE_CATALOG`、`VIEWPORT_PROFILE_CATALOG`、`SCREENSHOT_CAPTURE_TYPE_CATALOG`、`REPORT_SECTION_CATALOG`、`REPORT_CATEGORY_SECTION_CATALOG`、`SAFETY_EVENT_KIND_CATALOG`（C16d）、`severitiesInGroup`（C17a）、`sortByDisplayOrder`、`findingCategoriesInSection` | `src/presentation/catalog.ts` | 表示の語彙（日本語のラベル、順、色のトーン、説明、節の対応）。値の意味は決めない | 表示面（report、cli） | 2026-09-24 追加（U16a）。UI追補設計書の owner |
| 定数・関数 | `NOT_OBSERVED_TEXT`、`INCOMPLETE_REASON_DESCRIPTIONS`、`describeIncompleteReason`、`INTERACTION_REASON_DESCRIPTIONS`・`describeInteractionReason`（C18o。lifecycle の理由の説明は、表示しないので C18p で消した）、`REPORT_COMPONENT_TEXT`、`HTML_REPORT_TEXT`（U16c）、`CONFIG_ERROR_DESCRIPTIONS`、`describeConfigError`、`CLI_TEXT`（U17a）、`RUN_SUMMARY_TEXT`（HTML と CLI で共通の要約の文言）、`listText`、`truncatedListText`（一覧の書式。CC-016。C17a） | `src/presentation/messages.ts` | 利用者に見せる日本語の文言（理由の説明、部品の文言）。Task 17 で CLI と設定のエラーの文言を加える | 表示面 | 2026-09-24 追加（U16a）。UI追補設計書の owner |
| 定数 | `REPORT_COLOR_TOKENS`、`REPORT_CLASS_NAMES`、`REPORT_STYLESHEET` | `src/report/html-tokens.ts` | 色の値の唯一の定義と、唯一のスタイルシート | report | 2026-09-24 追加（U16a） |
| 関数 | `escapeHtml`、`SafeHtml`、`render*` の各部品（U16c で `renderCode`、`renderMutedText`、`renderInternalLink`、`renderFileLink`、`renderReferenceList`、R16f で `renderUrlAsText` と `renderTable` の `emptyText` を追加。Safety の事象の URL は `renderUrlAsText` で示す） | `src/report/html-components.ts` | 唯一のエスケープと、エスケープを必ず通す HTML の部品 | report | 2026-09-24 追加（U16a）。タグは、このファイルでだけ書く |
| 関数・型 | `buildReportViewModel`、`ReportViewModel` とその部分の型（`RunSummaryView`、`FindingView`、`PageView`、`ScreenshotView`、`EvidenceLocationView` など） | `src/report/view-model.ts` | 確定した Run から、表示用モデルを1回だけ組み立てる。表示用の集計（severity と category による分類と件数）は、ここだけで行う（UI04）。ラベルは持たず、値だけを持つ | report（HTML、バンドル）、CLI | 2026-09-25 追加（U16b） |
| クラス・関数・定数 | `ArtifactWriter`（`writeRun`、`writePresentation`）、`ArtifactWriteError`、`AUDIT_ARTIFACT_SCHEMA_VERSION`、`retryRecordsOf`、`earlierAttemptEvidenceIds`、`visibleTextOf` | `src/report/artifact-writer.ts` | artifact の唯一の書き出し（ARCH08）。スキーマの検証と、Run Status の導き直し。再試行の前の記録の区別 | CLI | 2026-09-25 追加（U16b）。ファイルの名前とパスは、C16a で `src/core/artifact-layout.ts` に移した |
| 関数・型・定数 | `createChatGptBundle`、`ReadArtifactFile`、`ChatGptBundleOptions`、`CHATGPT_BUNDLE_FILE_NAMES`、`BUNDLE_SIZE_LIMIT` | `src/report/chatgpt-bundle.ts` | 表示用モデルから、ChatGPT 用バンドルの ZIP を作り、バイト列で返す（ファイルは書かない）。各ページの `page.json` と、上限の中のスクリーンショットを入れる | CLI | 2026-09-25 追加（U16d）。R16f で `page.json` と上限を追加 |
| 関数 | `renderHtmlReport` | `src/report/html-report.ts` | 表示用モデルから、HTML レポートの文字列を描く（ファイルは書かない）。部品を組み合わせるだけにする | CLI | 2026-09-25 追加（U16c） |
| 関数・型 | `reasonParts`（HTML の内側の関数）、`ReasonView<TCode>`（表示用モデル） | `src/report/html-report.ts`、`src/report/view-model.ts` | 理由（ページと Run の未完了の理由、Interaction の理由）を、コード、日本語の説明、詳細の組として渡し、同じ部品で描く | 表示面 | 2026-09-25 追加（C18o、CC-010）。理由の表示を、理由の種類ごとに別に書かない |
| 関数 | `serializeArtifactJson`、`artifactJsonBytes` | `src/report/artifact-json.ts` | artifact の JSON の書式（字下げ2文字、末尾に LF、UTF-8） | report | 2026-09-25 追加（C16c、CC-026）。JSON の書式を、ほかに書かない |
| 関数・定数 | `EXIT_CODES`、`exitCodeForRunStatus`、`CONFIG_ERROR_EXIT_CODE`、`FAILURE_EXIT_CODE`、`SUCCESS_EXIT_CODE` | `src/cli/exit-codes.ts` | 終了コードの唯一の表（Run Status と CONFIG_ERROR） | CLI | 2026-09-25 追加（U17a、CC-012）。サイトの Finding の件数で決めない |
| クラス・関数・定数 | `ConfigError`、`isConfigError`、`CONFIG_ERROR_KINDS` | `src/config/config-error.ts` | 設定と引数の誤り（種類のコードと詳細の一覧）。CLI は、これで CONFIG_ERROR を見分ける | config、CLI | 2026-09-25 追加（U17a） |
| 関数 | `runCli`、`reportUnhandledFailure`、`streamOutput`、`ignoreOutputErrors`、`artifactFileReader`、`finishAuditRun` | `src/cli/main.ts`、`output-stream.ts`、`run-command.ts` | CLI の入口、扱われない失敗の表示、書き込みの完了を待てる出力と出力先のエラーの無視、`readArtifactFile` の作り方、確定した Run から書き出し・表示・終了コードまでを行う処理 | CLI | 2026-09-25 追加（U17a）。R17f で3つを追加 |
| 関数・型 | `openPassiveSessionBeforeDeadline`、`openPassiveContextBeforeDeadline`、`openPassivePageBeforeDeadline`、`passiveSessionOpenDeadlineAtMs`、`resolvePassiveSessionDeadlines`、`releaseLatePassiveContextFailure`（P18c）、`PassiveSessionOpenDeadlineError` | `src/orchestration/passive-session-open.ts` | Context と page を、期限付きで作る。期限切れの後に届いた Context を閉じる（DEF-008） | orchestration、interaction | 2026-09-25 追加（P18a）。Context と page の作成に、期限のない呼び出しを新しく書かない |
| 関数 | `resolveTimeoutMs` | `src/core/deadline.ts` | 期限の値（ms）の検証。`undefined` なら既定値を返し、正の安全な整数でなければ `RangeError` を投げる | すべて | 2026-09-25 追加（P18e）。期限を注入できる部品は、これで検証する |
| テスト補助 | `createRunLauncher`（いつも headless で起動する）、`runWithCoordinator`、`runCliInProcess`、`captureCliOutput`、`readRunArtifactFiles`、`findingsOf`、`expectSchemaValid`、`expectOnlyReadRequests`、`fastRunConfig` など | `tests/helpers/run-harness.ts` | Run の起動、CLI での Run、artifact の読み取り、確かめ方 | 統合テスト、Gate | 2026-09-25 追加（C18d、CC-029） |
| テスト補助 | `overrideBrowser`、`browserFailingNewContext`、`browserHangingNewContext`、`browserStallingContextClose`、`neverSettles` | `tests/helpers/browser-proxies.ts` | Browser の Proxy（作成の失敗、止まる作成、止まる終了） | 統合テスト、Gate | 2026-09-25 追加（C18d、CC-029） |
| テスト補助 | `EXTERNAL_SCHEME_TARGETS`、`EXTERNAL_SCHEME_KEYS`、`ExternalSchemeKey` | `fixtures/external-scheme-targets.ts` | 外部スキームへの移動の試験の宛先（すべて実在しない値）。ほかのファイルを import しない。fixture の HTML 2つに複製があり、一致は `tests/unit/external-scheme-fixture.test.ts` で確かめる | `fixtures/server.ts`、テスト | 2026-09-25 追加（C18k-fix-round-1）。`fixtures/` から `tests/` を import しない |
| テスト補助 | `EXTERNAL_SCHEME_ROUTES`、試験用のパスの定数と組み立て、`attemptExternalSchemeNavigation`、期待値の組み立て（宛先の値は上の3つを export し直す） | `tests/helpers/external-scheme-fixture.ts` | 外部スキームへの移動の試験の、経路、パス、期待値（DEF-012） | 統合テスト、Gate | 2026-09-25 追加（C18d、CC-029） |
| テスト補助 | `launchHeadlessChromium`、`SITE_PER_PROCESS_ARGS`、`oopifTargetUrls`、`useHeadlessChromium` | `tests/helpers/chromium.ts` | headless の Chromium の起動と、OOPIF の確かめ | テスト | C18d で OOPIF の分を追加 |
| テスト補助 | `openServerWindow`、`NO_NON_READ_REQUESTS`、`withUnguardedPage`、`discoverInteractionCandidate`、`interactionAuditInput`、`GATE_INTERACTION_TIMING`、`QUIET_PERIOD_MS`、`withGuardedPassivePage`、`FACTORY_MODES`、`createModeFactories`、`factoryModeCases` | `tests/helpers/gate-harness.ts` | fixture のサーバの境界で、操作の後に届いたリクエストの差分を数える。Guard のない対照の page と、Guard の付いた Passive の page を開いて閉じる処理。headless と headed（注入）の factory の組。遅れて起きる事象を待つ時間 | Gate のテスト、統合テスト | 2026-09-25 追加（T18b）。C18k で `QUIET_PERIOD_MS` から `factoryModeCases` までを追加（CC-031）。`withGuardedPassivePage` の、ほかのテストでの利用は C18m（CC-032）。C18p で `expectNoViolations`（閉じる前に違反が0件であることを確かめる指定。既定は確かめない）を追加 |
| テスト補助 | `loadSourceFiles`、`scanSource`、`findImportSpecifiers` など | `tests/architecture/source-scan.ts` | `src/**` を1回だけ読み、コメント・文字列・正規表現のリテラルを分けて走査する。UI Gate と Architecture の Gate が共通に使う | `tests/architecture/**` | 2026-09-25 追加（T18d）。T18e で UI Gate も使う形にした（DEF-011）。コメントの除去を、正規表現だけで書かない |
| テスト補助 | `auditRun`、`edgeCaseAuditRun`、`runSummary`、`runStatusInput`、`page`、`finding`、`record`、`dom`、`screenshot`、`interaction`、`metadata`、`safety`、`retry`、`HOSTILE_STRINGS`、`SPECIAL_SCHEME_URLS` など | `tests/helpers/audit-run-fixture.ts` | スキーマに合う Run の見本（Evidence、Finding、ページ、`RunSummary`、`AuditRunResult`）を組み立てる。危険な文字列と特殊なスキームの見本を含む | 表示のテスト（view-model、artifact-writer、HTML、バンドル、CLI） | 2026-09-25 追加（C16b、CC-024）。見本の組み立てを、テストのファイルに複製しない |
| テスト補助 | `startFixtureServer` | `fixtures/server.ts` | ローカルfixtureサーバの起動と、サーバ側の変更系リクエストの計数 | `tests/**` | R15a で、`siteMetadata` のオプションと、robots.txt・sitemap.xml の Origin の置き換えを追加 |
| 関数 | `awaitBeforeDeadline`、`wait`、`yieldMacrotask` | `src/core/deadline.ts` | 絶対時刻の期限までの待機（期限前の完了・reject・期限切れを区別し、例外を投げない。期限切れ後の reject も封じ込める）、待機、マクロタスクを1回譲る | すべて（Node側） | 2026-09-23 追加（CC-001） |
| 関数 | `safeErrorMessage`、`ERROR_MESSAGE_FALLBACK` | `src/core/errors.ts` | 不明な値を、例外を投げずに上限付きの文字列にする | すべて（Node側） | 2026-09-23 追加（CC-002） |
| 関数 | `isRecord`、`isPositiveFiniteNumber`、`isNonNegativeFiniteNumber`、`isNonNegativeSafeInteger`、`isPositiveSafeInteger` | `src/core/guards.ts` | 型と数値の判定 | すべて（Node側） | 2026-09-23 追加（CC-003） |
| 関数 | `deepFreeze` | `src/core/immutable.ts` | 深い不変化 | すべて（Node側） | 2026-09-23 追加（CC-003） |
| 関数 | `normalizeWhitespace`、`truncateText`、`compareCodeUnits` | `src/core/text.ts` | 空白の正規化、切り詰め（切り詰めたかどうかも返す）、コード単位での比較 | すべて（Node側） | 2026-09-23 追加（CC-003） |
| 定数 | `MAX_URL_LENGTH`、`MAX_ERROR_MESSAGE_LENGTH`、`MAX_HTTP_METHOD_LENGTH`、`MAX_SELECTOR_LENGTH`、`MAX_SELECTOR_DEPTH`、`GEOMETRY_EPSILON_PX` | `src/core/limits.ts` | 意味が同じ上限値と、Evidence の収集の上限（C7 で `MAX_CONSOLE_MESSAGES`、`MAX_PAGE_ERRORS`、`MAX_CONSOLE_TEXT_LENGTH`、`MAX_ERROR_NAME_LENGTH`、`MAX_STACK_LENGTH`、`MAX_NETWORK_REQUESTS`、`MAX_HEADER_VALUE_LENGTH`、`MAX_RESOURCE_TIMING_ENTRIES` を追加。F17b で Interaction の時間の `INTERACTION_STABILITY_WINDOW_MS`、`INTERACTION_PERSISTENCE_WINDOW_MS`、`MIN_INTERACTION_TIMEOUT_EXCLUSIVE_MS` を追加。スキーマの `interactionTimeoutMs` の下限は、最後の値 + 1 で、テストで一致を確かめる） | すべて | 2026-09-23 追加（CC-007）。特定のownerが意味を決める上限はそのownerに置く |
| 関数 | `createRequestId`、`createSha256Fingerprint`、`createSha256FingerprintOfBytes`、`isSha256Fingerprint`、`isRunId`、`isPageId` | `src/core/ids.ts` | リクエストIDの採番、`sha256:` 形式の作成（文字列とバイト列）と判定、Run と Page の ID の形の判定（C16d） | すべて | 2026-09-23 追加（CC-006）。バイト列の版は 2026-09-25 追加（U16d） |
| 型 | `PartialFailureReason`、`ObservationStatus`（と、それぞれの値の配列） | `src/core/contracts.ts` | 部分失敗の理由、観測状態 | すべて | 2026-09-23 追加（CC-009） |
| 関数 | `isHttpProtocol`、`canonicalizeAllowedOrigins` | `src/crawl/normalize-url.ts` | http/https の判定、許可Originの正規化 | すべて（Node側） | 2026-09-23 追加（CC-004、CC-005）。URLの意味のowner |
| 定数・型 | `URL_REJECTION_REASONS`（`UrlRejectionReason`） | `src/core/evidence-types.ts` | URLの正規化と受け入れ判定の理由のコード | すべて | 2026-09-23 追加（F07） |
| 定数・型 | `VIEWPORT_PROFILES`（`ViewportProfile`） | `src/core/contracts.ts` | ビューポートの種類（desktop・mobile） | すべて | 2026-09-23 追加（F07） |
| 定数 | `LINK_LIMITS` | `src/crawl/discover-links.ts` | Link の件数と文字列の上限 | discover-links | 2026-09-23 追加（F07）。collector に固有の上限 |
| 関数 | `hasUrlCredentials`、`redactUrlCredentials`（と理由コード `CREDENTIALS_NOT_ALLOWED`） | `src/crawl/normalize-url.ts` | URLの認証情報の判定と伏せ字化 | すべて（Node側） | 2026-09-23 追加（C1） |
| 型 | `AuditConfigDefaults` | `src/config/types.ts` | `target` を除いた既定値の型 | `src/config/**` | 2026-09-23 追加（C1） |
| 型・関数 | `ScrollPosition`・`ScrollEvidence` など scroll の型（定義は `src/core/evidence-types.ts`）、`ScrollTarget`・`ScrollOriginRestoration`（controlled-scroll の別名）、`scrollDocumentToOrigin`・`readDocumentScrollPosition`（関数は controlled-scroll） | `src/core/evidence-types.ts`、`src/browser/controlled-scroll.ts` | 文書のスクロール位置の定義、スクロールする要素、先頭へ戻す処理 | すべて | 2026-09-23 追加（C4）。ブラウザ内での位置の読み取り式は layout・color に複製されている（設計書 3.1 の範囲） |
| テスト補助 | `buildIntoTemporaryDirectory`、`snapshotDirectory` | `tests/helpers/temporary-build.ts` | 一時ディレクトリへのビルドと、ディレクトリの状態の記録 | `tests/**` | 2026-09-23 追加（C1） |
| テスト補助 | `createTestConfig`、`closePassiveResources`、`createDeferred`（`useHeadlessChromium` は `chromium.ts` の行） | `tests/helpers/` | テスト用の設定の生成、Chromium の起動と終了、factory の後片付け、Deferred | `tests/**` | 2026-09-23 追加（CC-011） |
| 定数 | `VISIBILITY_CHECK_OPTIONS` | `src/core/visibility.ts` | ブラウザ内の `element.checkVisibility()` に渡すオプション（可視判定の唯一の定義） | ブラウザ内で可視判定をするすべての collector | 2026-09-23 追加（CC-008、設計書 foundation-corrections 5.5） |

### 2.1 Guard の付いた Context で使うライブラリの注意

Guard（`src/safety/passive-request-guard.ts`）は、Guard の終了処理を経由せずに page が閉じられ、その page の CDP のセッションが切り離されると、それを不変条件の違反として記録し、Context を無効化する。これは安全のための仕様どおりの振る舞いである。

したがって、同じ Context に自分で page を開き、それを直接閉じるライブラリを collector で使ってはいけない。例えば `@axe-core/playwright` は、既定の方式ではこれを行うので、レガシーの方式（`setLegacyMode(true)`）で使う（DEF-001）。

新しいライブラリを collector で使うときは、そのライブラリが page を開かないことを確かめる。確かめる方法は、Guard の付いた Context で実行し、Safety Ledger の `invariantViolations` が0件であることをテストすることである。

### 2.2 値の一覧（enum）の置き場所

スキーマ（`schemas/*.json`）の enum に現れる値の一覧は、すべて `src/core/contracts.ts` か `src/core/evidence-types.ts` に、`as const` の凍結した配列として1回だけ定義する。TypeScript の型は、その配列から導く（2026-09-23 F12）。

- 主な配列:
  - `RUN_STATUSES`、`PAGE_AUDIT_STATUSES`、`SEVERITIES`、`INTERACTION_STATUSES`、`EVIDENCE_TYPES`
  - `FINDING_CATEGORIES`、`INCOMPLETE_REASON_CODES`、`VIEWPORT_PROFILES`、`URL_REJECTION_REASONS`
  - `SCROLL_TARGETS`、`SCROLL_INCOMPLETE_REASONS`、`LAYOUT_ELEMENT_KINDS`、`HORIZONTAL_CLIP_ANCESTOR_KINDS`（RT12a で追加）、`LAYOUT_INCOMPLETE_REASONS`
  - `PERFORMANCE_INCOMPLETE_REASONS`、`ACCESSIBILITY_IMPACTS`、`INTERACTION_HREF_KINDS`、`INTERACTION_IDENTITY_STATUSES`、`SCREENSHOT_CAPTURE_TYPES` など
- 個数は、追加のたびに増える（2026-09-23 の F12 の時点では36個）。正しい一覧は、`tests/unit/schema-enum-consistency.test.ts` の対応表である。F12 で新しく置いた29個の一覧は、作業記録置き場の `F12-report.md` にある。
- この検査の範囲には限界がある（2026-09-23 R''2 の m1）。`oneOf` の `const` で表した閉じた集合（例: `COMPLETE`/`PARTIAL`、`RESTORED`/`NOT_RESTORED`）は、対象に入らない。また、TypeScript の型が配列から導かれていることは、機械的には確かめていない。これらは、レビューで確かめる。
- スキーマの enum と配列が一致することは、`tests/unit/schema-enum-consistency.test.ts` が、対応表で確かめる。スキーマに新しい enum を加えたときは、core に配列を置き、この対応表に1行を加える。対応表に載っていない enum があると、テストが失敗する。
- collector や interaction の処理で値の一覧が必要なときは、core の配列を import する。ブラウザの中で動く関数には、import の代わりに evaluate の引数で渡す。
- 表示のラベル（日本語）は、ここではなく、表示カタログ（`src/presentation/catalog.ts`、Task 16）に置く。

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

## 4. 共通化の候補

既存コードで見つかった重複は、作業記録置き場の `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/commonization-candidates.md` に CC-001〜CC-012 として記録しています。
2026-09-23 のユーザーの開発指示を受けて、実施時期を `doc/design/2026-09-23-beaksight-foundation-corrections-design.md` 第3章で決め、順に実施しています。
新しいコードでは、これらの重複をさらに増やさないでください。上の表の共通部品を使ってください。

## 5. 更新履歴

| 日付 | 内容 |
| --- | --- |
| 2026-09-23 | 初版。既存の共通部品と、UI追補設計書で決めたownerを登録 |
| 2026-09-23 | F01〜F03 で新設した共通部品を登録。第4章を、保留から実施中に改めた |
| 2026-09-23 | C1〜C8、F04、F05、DEF-001、DEF-001b で新設・移動した共通部品を登録。2.1 に、Guard の付いた Context で使うライブラリの注意を加えた |
| 2026-09-23 | F06〜F12 で新設した共通部品を登録。2.2 に、値の一覧（enum）の置き場所と一致の検査を加えた |
| 2026-09-23 | F13: Evidence の ID の接頭辞をスキーマの分岐ごとに限り、`ids.ts` との一致をテストで確かめるようにした。DOM の Evidence の文書の項目の切り詰めを、項目ごとの印（`DomDocumentFieldTruncationEvidence`）にした |
| 2026-09-26 | Task 19（fixture の全体の監査と README）: 新しい共通部品はなし。README は、この台帳の部品（終了コード表、表示カタログ、既定値）を出どころにして書いた |
