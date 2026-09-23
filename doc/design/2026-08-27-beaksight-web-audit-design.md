# BeakSight Webサイト自動監査システム 設計書

- Date: 2026-08-27
- Status: Approved by user
- Product: `BeakSight`
- CLI: `beaksight`
- Initial operational target: `https://www.example.com/`
- Runtime: Node.js + TypeScript + Playwright Library
- Primary objective: 公開Webサイトを読み取り専用で再帰巡回し、決定論的に検証可能な異常と、後段のChatGPT意味監査に必要な証跡を収集する

## 1. 背景と目的

対象Webサイトは継続的に改修されるため、固定URL一覧、固定DOM selector、固定メニュー構造に依存したE2Eテストでは保守負荷が高い。

本ツールは、トップページを起点に同一Origin内の到達可能ページを自動発見し、人間が公開サイトを巡回して確認する作業のうち、機械的に判定できる範囲をPlaywrightで自動化する。

自動側では意味的・美的な断定を行わない。自動監査結果を構造化証跡として出力し、必要に応じてユーザーがChatGPTへ手動アップロードして、文章、導線、カテゴリ分類、重複内容、UI/UX、配色バランス等の意味監査を行う。

## 2. 最上位要件

### 2.1 対象

- BeakSightは公開Webサイトを監査対象とする汎用監査システムとして設計する。
- 初期運用対象Originは `https://www.example.com` とする。
- 初期運用の開始URLは `https://www.example.com/` とする。
- トップページから到達可能な同一Originページを再帰巡回する。
- 問い合わせページ自体は閲覧・監査対象に含める。

### 2.2 禁止事項

以下のユーザー起点処理を実行しない。

- 登録
- 更新
- 保存
- 削除
- 予約確定
- 問い合わせ送信
- フォーム送信
- 電話発信
- メール送信・メールアプリ起動
- LINE等の外部アプリ起動
- ダウンロード実行
- 外部サービス上の確定操作

### 2.3 読み取り専用方針

- Passive Contextでは、実ネットワーク送信を `GET` / `HEAD` に限定する。
- `POST` / `PUT` / `PATCH` / `DELETE` およびその他の非read methodはSafety Guardで送信前に遮断する。
- フォームactionはクロール対象URLとして採用しない。
- URL巡回候補は原則として同一Originの通常アンカー `a[href]` とし、sitemapは比較用Evidenceとして扱う。
- `tel:` / `mailto:` / `sms:` / `intent:` / `javascript:` 等の特殊schemeは記録のみ行い、実行しない。
- 外部Originへのリンクは記録のみ行い、遷移しない。

注意: HTTP `GET` がサーバー側で本当に副作用ゼロであることはクライアント側だけでは証明できない。本ツールは公開・非認証サイトを対象とし、フォームactionやボタン遷移を実行せず、同一Originの通常アンカー由来URLに限定することでリスクを最小化する。サーバー側で副作用を持つ不正なGETエンドポイントまで完全に識別することは本設計の保証範囲外とする。

## 3. 自動監査とChatGPT監査の責務境界

### 3.1 自動監査ツールの責務

- 再帰クロール
- URL正規化と重複排除
- HTTP / Navigation監査
- 内部リンク監査
- Resource監査
- Console / JavaScript監査
- DOM / HTML監査
- Form存在・構造観測
- Accessibility監査
- Color Contrast監査
- Layout監査
- Responsive Stress監査
- CLS / Layout Shift監査
- Synthetic Performance監査
- Navigation Timing / Resource Timing / Server-Timing等のPerformance Evidence収集
- Telemetry関連通信の存在・属性のEvidence収集
- 動的に発見した安全なUI候補の隔離Interaction監査
- Cross-page構造監査
- Screenshot取得
- JSON / HTMLレポート生成
- ChatGPT handoff bundle生成

### 3.2 ChatGPT側の責務

自動ツールは以下を断定しない。

- 文章の自然さ
- 内容の意味的矛盾
- リンク文言と遷移先の意味的不一致
- 重複コンテンツのビジネス上の問題性
- カテゴリ分類の妥当性
- 配色バランス・美的完成度
- UI/UX上の違和感
- ビジネス上の改善余地

自動側は、これらを後段で判断できるようにURL、見出し、可視テキスト、リンク文言、構造情報、Screenshot等を保存する。

## 4. 非目標

初版では以下を実装しない。

- GUI
- SaaS化
- DB永続化
- ユーザー管理
- 認証ページ監査
- スケジューラー
- CI/CD連携
- Screenshot Baseline / Visual Regression
- Performance Baseline / Regression
- Color Baseline / Regression
- LLM API連携
- 自動改善要望生成
- 自動通知
- クラウド分散Crawler
- 外部リンク先の実アクセス監査

## 5. アーキテクチャ

```text
CLI
 |
 v
Run Coordinator
 |
 +-- Crawl Engine
 |    +-- URL Discovery
 |    +-- URL Normalizer
 |    +-- Scope / Admission Policy
 |    +-- Crawl Queue
 |
 +-- Browser Context Factory
 |    +-- Passive Context
 |    +-- Isolated Interaction Context
 |
 +-- Safety Guard
 |    +-- HTTP Method Guard
 |    +-- Origin Guard
 |    +-- External Action Guard
 |    +-- Popup / Download Guard
 |    +-- Service Worker Guard
 |    +-- WebSocket Guard
 |
 +-- Evidence Collector
 |    +-- HTTP / Network
 |    +-- Console
 |    +-- Page Error
 |    +-- Resource
 |    +-- DOM / Visible Text
 |    +-- Accessibility
 |    +-- Layout
 |    +-- Performance
 |    +-- Interaction
 |    +-- Screenshot
 |
 +-- Deterministic Rule Engine
 |    +-- HTTP Auditor
 |    +-- Link Auditor
 |    +-- Resource Auditor
 |    +-- DOM Auditor
 |    +-- Form Auditor
 |    +-- Accessibility Auditor
 |    +-- Layout Auditor
 |    +-- Performance Auditor
 |    +-- Interaction Auditor
 |    +-- Cross-page Auditor
 |
 +-- Report Generator
      +-- run.json
      +-- audit.json
      +-- report.html
      +-- pages/*
      +-- beaksight-audit-bundle.zip
```

### 5.1 責務分離

- Crawl EngineはURL発見・正規化・queue制御だけを担当する。
- Safety GuardはCrawlerやAuditorから独立した強制レイヤーとする。
- Evidence Collectorは観測事実を収集し、Finding判定を行わない。
- Rule EngineはNormalized Evidenceだけを入力としてFindingを生成する。
- Report Generatorは監査ロジックを持たず、既に確定したRun / Evidence / Findingを表現する。

## 6. Browser Context設計

### 6.1 Passive Context

目的は通常ページ表示の観測であり、UI候補をクリックしない。

```text
同一Origin URLへGET navigation
 -> network / console observer開始
 -> DOM ready
 -> controlled scroll
 -> lazy content settling
 -> Evidence収集
 -> Screenshot
 -> link抽出
```

Safety Guardにより非read HTTP methodは遮断する。ページ自身がAnalytics等でPOSTを発生させようとした場合も送信せず、Safety Eventとして記録する。

非read通信を遮断したことでページ表示・情報取得が成立しない場合、そのページを `PAGE_PARTIALLY_OBSERVED` とし、完全監査済みにしない。

### 6.2 Isolated Interaction Context

UI操作はPassive Contextと分離した使い捨てContextで行う。

```text
対象ページを初期ロード
 -> 初期Evidence取得
 -> Interaction Network Freeze
 -> semantic UI候補を動的発見
 -> 候補を1つ操作
 -> DOM / ARIA / layout変化検証
 -> Context破棄
```

必要に応じて候補単位または候補グループ単位でContextを再作成し、ある操作の状態が次の操作に汚染しないようにする。

Interaction開始後は新規network、navigation、popup、download、WebSocket接続を遮断する。

## 7. 動的Safe Interaction Policy

固定selector Allowlistは使用しない。

### 7.1 候補発見

例:

- `button`
- `[role="button"]`
- `[role="tab"]`
- `[aria-expanded]`
- `[aria-controls]`
- `details > summary`

### 7.2 機械的除外

例:

- `type="submit"`
- `type="reset"`
- form送信に直接関与するcontrol
- navigationを主目的とする `a[href]`
- `download`
- 特殊scheme
- 外部Origin遷移

文言だけを安全性の根拠にしない。

### 7.3 Post-condition verification

操作後に以下を検査する。

- unexpected navigationが発生していない
- form submitが発生していない
- popupが発生していない
- downloadが発生していない
- network side effectが発生していない
- ARIAまたはDOM visibility/state/layoutの検証可能な変化がある

結果状態:

- `VERIFIED`
- `REJECTED_UNSAFE`
- `BLOCKED_BY_SAFETY`
- `NOT_VERIFIABLE`
- `EXECUTION_FAILED`

`NOT_VERIFIABLE` をPASS扱いしない。

## 8. URL Discovery / Crawl Policy

### 8.1 発見方法

- 開始URLからBFS型で巡回する。
- ページ内の同一Origin `a[href]` を抽出する。
- URLをnormalizeしてqueueへ投入する。
- sitemap.xmlはEvidenceとして取得するが、トップページから到達不能なsitemap-only URLを自動巡回対象へ追加しない。

### 8.2 URL normalization

- fragmentは除去する。
- tracking query parameterは除去する。
- query parameterは原則DROPする。
- 内容識別に必要なqueryだけ設定Allowlistで残せる。
- trailing slash等の正規化ルールは一貫して適用する。
- visited setはNormalized URLをkeyとする。

初期drop対象例:

- `utm_source`
- `utm_medium`
- `utm_campaign`
- `utm_term`
- `utm_content`
- `gclid`
- `fbclid`

### 8.3 Crawl budget

初期default:

- `maxPages = 500`
- `maxDepth = 20`
- `maxRuntimeMs = 3600000`
- `crawlConcurrency = 1`

Budget到達時は `PARTIAL` とし、理由を記録する。

- `CRAWL_PAGE_LIMIT_REACHED`
- `CRAWL_DEPTH_LIMIT_REACHED`
- `RUN_TIME_LIMIT_REACHED`

## 9. 実行フローと状態管理

```text
INIT
 -> PREFLIGHT
 -> DISCOVERY / PASSIVE_AUDIT loop
 -> INTERACTION_AUDIT
 -> CROSS_PAGE_AUDIT
 -> REPORT
 -> FINALIZE
```

### 9.1 PREFLIGHT

以下を満たさなければ対象サイトへアクセスしない。

- startUrl valid
- allowedOrigin valid
- output directory writable
- browser launch success
- Safety Guard initialized
- Service Worker blocking configured
- request interception configured
- maxPages / maxDepth / maxRuntime valid

### 9.2 URL状態

- `DISCOVERED`
- `QUEUED`
- `AUDITING`
- `AUDITED`
- `SKIPPED`
- `FAILED`

### 9.3 Viewport状態

ページ全体とは別にDesktop / Mobileの監査状態を持つ。

例:

```text
Desktop = AUDITED
Mobile  = FAILED
Page    = PARTIAL
```

### 9.4 Run status

- `COMPLETE`
- `PARTIAL`
- `FAILED`
- `ABORTED_BY_SAFETY`

`COMPLETE` 条件:

- 全発見対象が終端状態に到達
- crawl budget未到達
- unhandled failureなし
- 必須artifact生成成功
- JSON Schema validation成功

サイトFindingが存在しても、監査処理が完全ならRunは `COMPLETE` とする。

### 9.5 Safety eventとRun abortの区別

非read requestを正常に遮断できたこと自体はRun abort条件にしない。Safety Eventとして記録し、可能な範囲で監査を継続する。

`ABORTED_BY_SAFETY` は以下に限定する。

- Safety Guard初期化失敗
- interceptionを保証できない状態
- guard bypassを示す事象
- read-only invariantを保証できない異常

## 10. Retry / Timeout / Settling

### 10.1 Retry

- transient navigation failure: 最大1回再試行
- HTTP 4xx / 5xx: 再試行しない
- Safety block: 再試行しない
- mutation attempt: 再試行しない

最初の失敗Evidenceは保持する。

### 10.2 初期timeout

- `navigationTimeoutMs = 30000`
- `resourceSettlingTimeoutMs = 5000`
- `interactionTimeoutMs = 3000`
- `overallPageTimeoutMs = 60000`

`networkidle`だけをpage ready条件にしない。DOM readiness、一定時間のDOM/height安定、controlled scroll完了を組み合わせる。

## 11. Controlled Scroll

各ページは先頭から最下部まで段階的にスクロールする。

目的:

- lazy-loaded image / contentを発火させる
- scroll-triggered UIを観測する
- CLS / layout shiftを観測する

スクロールは人間相当の一定step + waitを使用し、短時間に極端な操作を行わない。scrollHeight増加を追跡し、安定するまで有限回数繰り返す。overallPageTimeoutを超えて継続しない。

## 12. Evidenceモデル

原則:

```text
Evidence = 観測した事実
Finding  = Evidenceを決定論的ルールで評価した結果
```

すべてのEvidenceに一意な `evidenceId` を付与する。

例:

- `EV-NET-*`
- `EV-DOM-*`
- `EV-LAYOUT-*`
- `EV-PERF-*`
- `EV-A11Y-*`
- `EV-INTERACTION-*`
- `EV-SHOT-*`

Findingは `evidenceRefs[]` を介して一次証跡へ遡れるようにする。

## 13. Findingモデル

共通属性:

- `findingId`
- `fingerprint`
- `ruleId`
- `ruleVersion`
- `category`
- `severity`
- `pageId`
- `pageUrl`
- `viewport`
- `message`
- `evidenceRefs[]`

Severity:

- `ERROR`: 客観的な故障・破損
- `WARN`: 問題可能性が高いが断定範囲を限定すべきもの
- `INFO`: 後段分析に有用な観測
- `SAFETY`: サイト品質とは別の安全制御イベント

Safety findingとsite quality findingを集計上分離する。

## 14. Deterministic Rule Catalog

### 14.1 HTTP / Navigation

候補rule:

- `HTTP_4XX`
- `HTTP_5XX`
- `NAVIGATION_TIMEOUT`
- `REDIRECT_LOOP`
- `UNEXPECTED_ORIGIN_REDIRECT`
- `EMPTY_HTTP_RESPONSE`

301 / 302 / 307 / 308はそれ自体をERRORにせずredirect chain Evidenceとする。

### 14.2 Internal Link

収集:

- source URL
- anchor text
- aria label
- title
- raw href
- normalized target

候補rule:

- `BROKEN_INTERNAL_LINK`
- `INVALID_INTERNAL_URL`
- `UNSUPPORTED_URL_SCHEME`
- `TARGET_NAVIGATION_FAILED`

リンク文言とリンク先の意味的一致は自動Findingにしない。

### 14.3 Resource

対象:

- script
- stylesheet
- image
- font
- fetch/xhr

候補rule:

- `RESOURCE_4XX`
- `RESOURCE_5XX`
- `SCRIPT_LOAD_FAILED`
- `STYLESHEET_LOAD_FAILED`
- `IMAGE_LOAD_FAILED`

画像はHTTP statusに加え `complete` / `naturalWidth` / `naturalHeight` 等もEvidenceとする。

### 14.4 JavaScript / Console

収集:

- uncaught page error
- `console.error`
- failed request
- `console.warn` Evidence

同一エラーはmessage / source / stack fingerprintで集約する。

### 14.5 DOM / HTML

候補rule:

- `MISSING_TITLE`
- `EMPTY_TITLE`
- `MISSING_HTML_LANG`
- `EMPTY_VISIBLE_CONTENT`
- `DUPLICATE_ELEMENT_ID`
- `INVALID_CANONICAL_URL`

H1数や見出し飛び等は原則Evidenceとし、即ERRORにしない。

### 14.6 Form

フォームは入力・submitしない。

収集:

- action
- method
- input types
- required
- labels
- submit controls

候補rule:

- `FORM_WITHOUT_ACTION`
- `UNLABELED_REQUIRED_CONTROL`

フォームactionはCrawlerへ投入しない。

### 14.7 Accessibility / Contrast

`@axe-core/playwright` 等のアクセシビリティエンジンをPlaywright Libraryに統合し、客観的なviolationsを収集する。

配色について自動判定する主対象は可読性・アクセシビリティとする。

例:

- `COLOR_CONTRAST_VIOLATION`
- landmark / label等のaxe violations

美的な配色バランスはScreenshotとCSS color EvidenceをChatGPT側で評価する。

### 14.8 Layout

各ViewportでDOM geometryを検査する。

候補rule:

- `DOCUMENT_HORIZONTAL_OVERFLOW`
- `ELEMENT_OUTSIDE_VIEWPORT`
- `ELEMENT_OVERLAP`
- `TEXT_CLIPPING`
- `FIXED_ELEMENT_OCCLUSION`
- `ZERO_SIZE_INTERACTIVE_ELEMENT`
- `CONTENT_COLLISION`
- `OVERSIZED_FIXED_ELEMENT`

誤検知を避けるため、単純なbounding-box交差だけでERRORにせず、visibility、position、z-index、overflow、semantic role等を組み合わせる。

### 14.9 Responsive Stress Audit

Primary viewport:

- Desktop: `1440 x 900`
- Mobile: `390 x 844`

Layout stress widths:

- 320
- 390
- 768
- 1024
- 1440

Stress Auditはフル監査を繰り返さず、主にDOM geometry / overflow / collision / fixed occlusionを高速確認する。

### 14.10 Layout Shift / CLS

PerformanceObserver等から以下を収集する。

- CLS
- layout shift entries
- affected nodes/elements when attribution is available
- previous/current geometry when available

候補rule:

- `DYNAMIC_LAYOUT_SHIFT`
- `POOR_CLS`

### 14.11 Synthetic Performance

本ツールはRUMそのものではなくSynthetic Browser Measurementを行う。

収集候補:

- FCP
- LCP
- CLS
- TTFB
- INPまたはEvent Timing Evidence（有効なinteractionが観測された場合のみ）
- DOMContentLoaded
- load event
- Navigation Timing
- Resource Timing
- transferSize / encodedBodySize / decodedBodySize
- resource count
- JS / CSS / image transfer size summaries
- Server-Timing（公開されている場合）

INPはinteractionが観測されない場合 `NOT_OBSERVED` とし、値を捏造しない。

初版は各ページ1回計測とし、値はEvidence / WARNとして扱う。複数sampleによる統計化は初版対象外。

既知のWeb Vitals基準に照らした絶対評価は可能だが、Synthetic値の環境依存性を考慮してERRORではなくWARNを基本とする。

### 14.12 Telemetry / APM-related Evidence

「RUM取得」「APM取得」とは呼ばず、ブラウザから観測可能な以下をEvidenceとして記録する。

- telemetry / analytics request metadata
- Navigation Timing
- Resource Timing
- Server-Timing
- traceparent / tracestate（公開されている場合）
- request-id / correlation-id系header（公開されている場合）

DB query spanやserver-side private trace等、ブラウザから公開されないAPM内部情報は取得対象外。

### 14.13 Cross-page

候補rule:

- `DUPLICATE_PAGE_TITLE`
- `DUPLICATE_CANONICAL`
- `MULTIPLE_URLS_SAME_CANONICAL`
- `CANONICAL_TARGET_NOT_FOUND`
- `INCONSISTENT_ORIGIN`

sitemap比較はEvidence中心とし、sitemapとの差異だけでERRORにしない。

## 15. Rule Versioning / Fingerprint

各ruleはversionを持つ。

例:

- `BROKEN_INTERNAL_LINK@1`
- `DOCUMENT_HORIZONTAL_OVERFLOW@1`
- `IMAGE_LOAD_FAILED@1`

Finding fingerprintは、rule + normalized URL + stable target identity等から決定論的に生成する。

初版でBaseline比較は行わないが、fingerprintを持つことで将来の外部比較や重複排除に利用可能とする。

## 16. Current-State Audit方針

Baselineは持たない。

削除対象:

- approved baseline lifecycle
- screenshot diff
- visual regression判定
- color palette regression判定
- performance regression判定
- baseline environment comparison

現在状態に対する絶対監査だけを行う。

Screenshotは比較用ではなく、Evidence、人間確認、ChatGPT意味監査用として保持する。

## 17. 配色Evidence

Baselineなしで自動断定するのは主にContrastとAccessibilityとする。

後段ChatGPT監査を支援するため、可能な範囲で以下のCSS color Evidenceを収集する。

- visible textのcomputed foreground color
- effective background color candidate
- contrast pair
- visible elementのarea-weighted dominant CSS colorsの近似集計

Screenshot画像自体から重い画像解析を行うことは初版では必須としない。

## 18. 出力契約

```text
beaksight-output/
└─ <timestamp>-<run-id>/
   ├─ run.json
   ├─ audit.json
   ├─ report.html
   ├─ pages/
   │  └─ <page-id>/
   │     ├─ page.json
   │     ├─ visible-text.txt
   │     ├─ desktop/
   │     │  ├─ viewport.png
   │     │  └─ full.png
   │     └─ mobile/
   │        ├─ viewport.png
   │        └─ full.png
   ├─ evidence/
   │  ├─ network.json
   │  ├─ console.json
   │  ├─ performance.json
   │  ├─ accessibility.json
   │  └─ interactions.json
   ├─ chatgpt/
   │  ├─ manifest.json
   │  ├─ summary.json
   │  ├─ findings.json
   │  ├─ pages.json
   │  └─ evidence-index.json
   └─ beaksight-audit-bundle.zip
```

### 18.1 run.json

含有項目:

- schemaVersion
- runId
- toolVersion
- startedAt / finishedAt
- startUrl / allowedOrigin
- runStatus
- discovered / audited / failed / skipped page counts
- desktop / mobile counts
- blocked actions
- unverified interactions
- crawl limit state
- incomplete reasons
- environment
- effective configuration
- Safety Ledger

### 18.2 page.json

主構造:

```text
identity
  pageId
  requestedUrl
  finalUrl
  httpStatus

document
  title
  metaDescription
  canonical
  lang

content
  headings[]
  visibleText
  textStatistics

navigation
  internalLinks[]
  externalLinks[]
  specialLinks[]

media
  images[]

forms
  forms[]

interaction
  candidates[]
  verified[]
  blocked[]
  unverified[]

technical
  consoleErrors[]
  pageErrors[]
  failedRequests[]

layout
  desktop
  mobile
  stressSweep

performance
  webVitals
  navigationTiming
  resourceSummary
  serverTiming

accessibility
  violations[]

findings[]
```

### 18.3 Visible Text

単純なbody.innerTextだけに依存せず、semantic landmarkが利用可能なら以下の領域を区別する。

- header
- navigation
- main
- aside
- footer
- forms

識別不能な場合はvisible textへfallbackする。

### 18.4 Screenshot

各Primary viewportで以下を保存する。

- initial viewport screenshot
- full-page screenshot

Screenshotには `screenshotId` / `pageId` / `viewport` / `captureType` / `relatedFindingIds` をmetadataとして紐付ける。

## 19. ChatGPT Handoff

`beaksight-audit-bundle.zip` は後段の意味監査に必要な論理ビューをまとめる。

最低限:

- manifest.json
- run.json
- summary.json
- findings.json
- pages.json
- evidence-index.json
- 問題確認に必要なscreenshots

Handoff用データは元Evidenceを単に捨てて要約するのではなく、`evidenceRef`で一次証跡へ追跡可能にする。

## 20. HTML Report

トップサマリー:

```text
Run Status
Pages audited / discovered
ERROR count
WARN count
INFO count
SAFETY count
```

カテゴリ:

- Critical Findings
- Network
- JavaScript
- Links
- Resources
- Layout
- Accessibility
- Performance
- Interactions
- Pages

各Findingから以下へ遷移できる。

```text
Finding
 -> URL
 -> Viewport
 -> Rule
 -> Evidence
 -> Screenshot
```

監査レポート内の危険schemeや外部アクションURLはクリック可能リンクにせず、テキスト/コピー用途として表示する。

## 21. Schema / Validation

主要JSONに `schemaVersion` を必須とする。

例:

- `run-schema/1.0`
- `audit-schema/1.0`
- `page-schema/1.0`
- `finding-schema/1.0`

JSON Schemaをsource管理する。

```text
schemas/
├─ run.schema.json
├─ audit.schema.json
├─ page.schema.json
└─ finding.schema.json
```

TypeScript型だけでなく、最終artifactをSchema validationしてから `COMPLETE` 判定する。

## 22. CLI

初版command:

```text
beaksight run
beaksight validate-config
```

主option:

```text
--config <path>
--headed
--headless
--output <path>
```

標準はCLI。headed / headlessを切替可能とする。

## 23. Configuration

設定はサイトの現在DOMではなく監査ポリシーを表す。

概念構造:

```text
site:
  startUrl
  allowedOrigins

crawl:
  maxPages
  maxDepth
  maxRuntimeMs
  navigationTimeoutMs
  overallPageTimeoutMs
  resourceSettlingTimeoutMs
  queryPolicy

browser:
  headed
  locale
  timezone

viewports:
  primaryDesktop
  primaryMobile
  stressWidths

audit:
  performance
  accessibility
  interactions
  screenshots

output:
  directory
```

持たせないもの:

- hamburger selector
- FAQ selector
- page URL一覧
- menu構造
- submit button selector
- expected title一覧

## 24. Default Browser / Locale Policy

初版:

- Browser: Playwright Chromium
- Locale: `ja-JP`
- Timezone: `Asia/Tokyo`
- Primary Desktop: 1440 x 900
- Primary Mobile: 390 x 844
- concurrency: 1

User-Agentは通常のPlaywright Chromiumを基本とし、独自の強い偽装を行わない。実User-Agentをrun.jsonへ記録する。

## 25. robots.txt / sitemap.xml

- robots.txtはEvidenceとして取得可能にする。
- sitemap.xmlはEvidenceおよびcross-page comparisonに利用する。
- 本ツールは検索エンジンcrawlerではないため、robots.txtを唯一の巡回権限判定にはしない。
- 初版対象はユーザーが監査対象として指定した公開サイトに限定する。

## 26. Data Minimization / Redaction

raw response bodyを全保存しない。

Network Evidenceは原則以下に限定する。

- URL
- method
- status
- resource type
- timing
- transfer size
- 必要なheader subset

以下は保存前にredactする。

- Authorization
- Cookie
- Set-Cookie
- API token候補
- session identifier候補

## 27. Artifact容量方針

初期default:

- full screenshot: retain
- viewport screenshot: retain
- raw network body: do not retain
- duplicate raw artifact: avoid

Baselineを持たないため、過去比較用artifact複製は行わない。

## 28. Exit Code

- `0`: COMPLETE
- `1`: FAILED
- `2`: PARTIAL
- `3`: ABORTED_BY_SAFETY
- `4`: CONFIG_ERROR

サイトFindingのERROR件数だけでは非zero exitにしない。

例:

```text
runStatus = COMPLETE
ERROR findings = 10
exitCode = 0
```

## 29. Testing Strategy

テストを4層に分ける。

```text
Unit
 -> Component
 -> Integration fixture site
 -> Target-site smoke
```

### 29.1 Unit

対象:

- URL normalization
- query stripping
- origin admission
- fingerprint generation
- severity mapping
- rule evaluation
- schema validation
- redaction
- run status aggregation
- exit code mapping

状態集約は可能な限り純粋関数とする。

### 29.2 Component

人工Evidenceを各Auditorへ投入し、Playwrightなしでrule判定を検証する。

例:

```text
status 404 -> HTTP_4XX
scrollWidth 600 / viewport 390 -> DOCUMENT_HORIZONTAL_OVERFLOW
```

### 29.3 Integration fixture site

ローカルに意図的に壊したfixture siteを持つ。

```text
/
├─ normal
├─ 404-link
├─ js-error
├─ broken-image
├─ overflow
├─ clipped-text
├─ bad-contrast
├─ accordion
├─ popup-button
├─ download-button
├─ external-link
├─ mailto-link
├─ tel-link
├─ post-form
├─ put-request
├─ websocket
└─ service-worker
```

Responsive fixtureは特定幅で意図的にoverflow / collisionするページを用意する。

## 30. Safety Acceptance Gates

本番サイトを監査可能とする前に以下をPASSする。

- `GATE-S01`: POST never reaches fixture server
- `GATE-S02`: PUT/PATCH/DELETE never reach fixture server
- `GATE-S03`: mailto/tel/external app actions are never launched
- `GATE-S04`: popup is blocked during isolated interaction
- `GATE-S05`: download is blocked during isolated interaction
- `GATE-S06`: interaction-time navigation is blocked
- `GATE-S07`: WebSocket is blocked during isolated interaction
- `GATE-S08`: Service Worker cannot bypass required interception policy
- `GATE-S09`: sensitive headers are redacted in artifacts
- `GATE-S10`: Safety Guard initialization failure prevents target-site audit

Fixture server側でmutation endpoint hit countを保持し、Playwright側の「abortしたつもり」ではなく、実際にserverへ到達していないことを検証する。

## 31. Auditor Acceptance Gates

- `GATE-A01`: 404 -> HTTP_4XX
- `GATE-A02`: broken internal link -> BROKEN_INTERNAL_LINK
- `GATE-A03`: uncaught JS exception -> page error finding
- `GATE-A04`: broken image -> IMAGE_LOAD_FAILED
- `GATE-A05`: horizontal overflow -> DOCUMENT_HORIZONTAL_OVERFLOW
- `GATE-A06`: poor contrast -> accessibility finding
- `GATE-A07`: safe accordion -> interaction VERIFIED
- `GATE-A08`: unsafe interaction -> blocked / not verified
- `GATE-A09`: crawl limit -> PARTIAL
- `GATE-A10`: invalid output schema -> COMPLETE prohibited

## 32. Performance Test方針

固定時間値をテストしない。

テスト対象:

- observer / timing dataを取得できる
- schemaに格納できる
- unsupported metricを明示的に扱える
- INP未観測をNOT_OBSERVEDにできる
- performance collection timeoutがRun全体を破壊しない

## 33. Target-site Smoke

全Safety / Auditor Gate通過後のみ、初期運用対象 `https://www.example.com/` でSmokeを行う。

初回:

- `maxPages = 5`
- `headed = true`
- `concurrency = 1`

確認:

- ページ表示
- controlled scroll
- internal URL discovery
- no form input
- no form submit
- no phone/mail/LINE launch
- non-read network blocked
- artifacts generated

Smoke PASS後にfull crawlへ広げる。

## 34. 初版Completion Gate

以下をすべて満たす。

- TypeScript strict compile PASS
- Unit tests PASS
- Component tests PASS
- Integration fixture tests PASS
- Safety Gates S01-S10 PASS
- Auditor Gates A01-A10 PASS
- JSON Schema validation PASS
- fixture full crawl COMPLETE
- initial target-site (`https://www.example.com/`) smoke PASS
- full auditが実行可能
- run.json / audit.json / report.html / page evidence / screenshots / ChatGPT bundleが生成される
- non-read operationが本番対象へ送信されないSafety Ledgerが残る

## 35. Safety Ledger

run.jsonに最低限以下を保存する。

```text
safety:
  guardEnabled
  blockedRequestsByMethod
  blockedExternalActions
  blockedNavigations
  blockedPopups
  blockedDownloads
  blockedWebSockets
  invariantViolations
```

`blockedRequests > 0` は必ずしもRun failureではない。guardが正常に遮断した証拠である。

`invariantViolations > 0` は `COMPLETE` を禁止する。

## 36. 設計原則

1. Read-only by default
2. Fail closed when safety cannot be guaranteed
3. Deterministic automatic audit
4. Evidence before Finding
5. No hidden skip
6. Incomplete is not success
7. Site-specific selector dependencyを極小化
8. Site DOM変更で壊れにくい
9. 監査不能も結果として残す
10. Tool execution qualityとsite qualityを分離する
11. ChatGPT後段監査に必要なEvidenceを失わない
12. YAGNI: 初版にBaseline、LLM、GUI、DB、schedulerを入れない

## 37. 実装時の推奨モジュール境界

ファイル構成は実装計画で確定するが、責務境界は以下を維持する。

- `config`
- `cli`
- `crawl`
- `browser`
- `safety`
- `evidence`
- `audit/rules`
- `audit/layout`
- `audit/performance`
- `audit/accessibility`
- `audit/interaction`
- `report`
- `schemas`
- `fixtures`
- `tests`

巨大なCrawler単一ファイルへ責務を集中させない。

## 38. 設計レビュー結果

本仕様を実装前に自己レビューし、以下を確認した。

- Baseline関連要件はすべて削除済み。
- LLMはRuntime dependencyではなく、手動handoffのみ。
- 固定selector Allowlistは存在しない。
- URL巡回とUI interactionを分離している。
- Passive ContextとIsolated Interaction Contextを分離している。
- 非read requestを遮断しても即Run abortにはせず、正常blockとSafety invariant failureを区別している。
- 真のRUM/APMとSynthetic/Telemetry Evidenceを区別している。
- INP未観測時に値を捏造しない。
- COMPLETEとサイトFinding件数を分離している。
- 出力Schema不整合時にCOMPLETEにならない。
- 本番前Safety Gateが定義されている。
- 初版非目標が明示されている。

## 39. 実装着手条件

本設計書はユーザー承認済みである。実装計画は本仕様を唯一の設計基準として作成し、実装はその計画承認後に開始する。

