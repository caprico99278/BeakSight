/**
 * 表示のテストが使う、Run の見本（`AuditRunResult`）の組み立て（CC-024、C16b。Task 14〜17 の設計書 6.1.3、6.1.8、6.1.9）。
 * - 表示用モデル、`ArtifactWriter`、HTML レポート、ChatGPT 用バンドル、CLI のテストは、ここから見本を作る。テストのファイルの中に、
 *   見本を組み立てる関数を複製しない。
 * - どの見本も、スキーマ（run、audit、page、finding）に合う形で作る。スキーマに合わない見本が要るテストは、結果を上書きして作る。
 * - スクリーンショットの相対パスは、`screenshotRelativePath`（artifact の配置の owner。設計書 6.1.8）で作る。
 * - 返す値は、呼ぶたびに新しく作り、凍結しない（入力を凍結しないことを確かめるテストがあるため）。
 * - 既定値（Interaction の理由の詳細の `reason <番号>`、`Button <番号>`、`テストの指摘 <番号>`、`TEST_RULE_<番号>` など）は、使っているテストの期待値の前提である。
 *   変える場合は、使っているテストを確かめる。
 */
import { screenshotRelativePath } from '../../src/core/artifact-layout.js';
import type {
  AuditRunResult,
  EvidenceId,
  EvidencePayloadByType,
  EvidenceRecord,
  EvidenceRecordFor,
  EvidenceType,
  Finding,
  FindingCategory,
  IncompleteReason,
  InteractionStatus,
  PageAuditResult,
  PageAuditStatus,
  PageId,
  RunId,
  RunSummary,
  Severity,
  ViewportAuditResult,
  ViewportProfile,
} from '../../src/core/contracts.js';
import {
  INTERACTION_REASON_CODES_BY_STATUS,
  SAFETY_EVENT_KINDS,
  type DomEvidence,
  type InteractionCandidateEvidence,
  type InteractionChangeEvidence,
  type InteractionNotVerifiableKind,
  type InteractionReasonCode,
  type NormalizedHttpUrlEvidence,
  type RobotsTxtMetadataEvidence,
  type SafetyEventKind,
  type SafetyEventsEvidence,
  type ScreenshotCaptureType,
} from '../../src/core/evidence-types.js';
import { createEvidenceId, createFindingId, createPageId, createRunId, createSha256Fingerprint } from '../../src/core/ids.js';
import type { RunStatusInput } from '../../src/core/status.js';
import { SafetyLedger, safetyEventsEvidenceFromSnapshot } from '../../src/safety/safety-ledger.js';
import { createTestConfig } from './test-config.js';

// ---------------------------------------------------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------------------------------------------------

/** 見本の Run の許可 Origin（ローカルの fixture サーバと同じ形）。 */
export const FIXTURE_ORIGIN = 'http://127.0.0.1:4173';
/** 見本の Evidence の観測の時刻。 */
export const FIXTURE_OBSERVED_AT = '2026-09-24T00:00:00.000Z';
/** 見本の Run の ID。 */
export const FIXTURE_RUN_ID: RunId = createRunId(20260924000000);

export const PAGE_1: PageId = createPageId(1);
export const PAGE_2: PageId = createPageId(2);
export const PAGE_3: PageId = createPageId(3);

/** HTML とバンドルのエスケープを確かめるための、危険な文字列。 */
export const HOSTILE_STRINGS = Object.freeze({
  scriptTag: '<script>alert("beaksight")</script>',
  attributeBreak: '"onerror=alert(1)',
  javascriptUrl: 'javascript:alert(1)',
} as const);

/** `HOSTILE_STRINGS` のすべてを、空白でつないだ文字列。 */
export const HOSTILE_TEXT = `${HOSTILE_STRINGS.scriptTag} ${HOSTILE_STRINGS.attributeBreak} ${HOSTILE_STRINGS.javascriptUrl}`;

/** リンクにせず、文字として示す URL（`SPECIAL_SCHEME_RECORD_ONLY`。設計書 6.1.6）。 */
export const SPECIAL_SCHEME_URLS = Object.freeze({
  mailto: 'mailto:contact@example.test',
  tel: 'tel:+81-3-0000-0000',
} as const);

/** 日本語の本文。 */
export const JAPANESE_TEXT = 'トップページの本文です。お知らせと製品の一覧があります。';

// ---------------------------------------------------------------------------------------------------------------
// 基本
// ---------------------------------------------------------------------------------------------------------------

/** `FIXTURE_ORIGIN` の下の URL（`path` は `/` から始める）。 */
export const fixtureUrl = (path: string): NormalizedHttpUrlEvidence => `${FIXTURE_ORIGIN}${path}` as NormalizedHttpUrlEvidence;

/** Evidence の ID。 */
export const idOf = (evidence: EvidenceRecord): EvidenceId => evidence.evidenceId;

/** ページの既定のパス（`finding` の既定の `pageUrl` に使う）。 */
const DEFAULT_PAGE_PATHS: Readonly<Record<string, string>> = {
  [PAGE_1]: '/',
  [PAGE_2]: '/second.html',
  [PAGE_3]: '/third.html',
};

const defaultPagePath = (pageId: PageId): string => DEFAULT_PAGE_PATHS[pageId] ?? `/${pageId.toLowerCase()}.html`;

// ---------------------------------------------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------------------------------------------

/** 任意の種類の Evidence（ID は `createEvidenceId(type, sequence)`、観測の時刻は `FIXTURE_OBSERVED_AT`）。 */
export function record<TType extends EvidenceType>(
  type: TType,
  sequence: number,
  pageId: PageId,
  viewport: ViewportProfile | null,
  payload: EvidencePayloadByType[TType],
): EvidenceRecordFor<TType> {
  return { evidenceId: createEvidenceId(type, sequence), type, pageId, viewport, observedAt: FIXTURE_OBSERVED_AT, payload };
}

/**
 * DOM の Evidence。可視テキストは `text`（`BODY_FALLBACK`）。題名は `Page`、言語は `ja`、ほかの一覧は空。
 * `overrides` は payload の項目を浅く上書きする。
 */
export function dom(
  sequence: number,
  pageId: PageId,
  viewport: ViewportProfile,
  text: string,
  overrides: Partial<DomEvidence> = {},
): EvidenceRecordFor<'dom'> {
  return record('dom', sequence, pageId, viewport, {
    pageId,
    scrollPosition: { scrollX: 0, scrollY: 0 },
    title: 'Page',
    metaDescription: null,
    canonicalUrl: null,
    lang: 'ja',
    headings: [],
    visibleText: {
      source: 'BODY_FALLBACK',
      text,
      truncated: false,
      nodeLimitReached: false,
      ariaHiddenText: '',
      regions: [],
      omittedRegionCount: 0,
    },
    images: [],
    forms: [],
    unassociatedFields: [],
    duplicateIds: [],
    truncation: {
      documentFields: { title: false, metaDescription: false, canonicalUrl: false, lang: false },
      omittedHeadingCount: 0,
      omittedImageCount: 0,
      omittedFormCount: 0,
      omittedUnassociatedFieldCount: 0,
      omittedDuplicateIdCount: 0,
    },
    ...overrides,
  });
}

/**
 * スクリーンショットの Evidence。相対パスは `screenshotRelativePath(pageId, viewport, captureType, retryAttempt)`。
 * 再試行の前の試行のものは、`retryAttempt` に試行の番号を渡す（`pages/<pageId>/retry-<n>/<ビューポート>/`）。
 */
export function screenshot(
  sequence: number,
  pageId: PageId,
  viewport: ViewportProfile,
  captureType: ScreenshotCaptureType = 'VIEWPORT',
  retryAttempt: number | null = null,
): EvidenceRecordFor<'screenshot'> {
  return record('screenshot', sequence, pageId, viewport, {
    pageId,
    viewport,
    relativePath: screenshotRelativePath(pageId, viewport, captureType, retryAttempt),
    captureType,
    scrollPosition: { scrollX: 0, scrollY: 0 },
  });
}

/** `interaction` の上書きの指定。 */
export interface InteractionOptions {
  /** 既定は `desktop`。 */
  readonly viewport?: ViewportProfile;
  /**
   * `reason` と `work.reason`（理由のコード。C18n）。既定は、status に合うコードの一覧の最初のコード
   * （`INTERACTION_REASON_CODES_BY_STATUS`）。status に合わないコードを渡すと、スキーマに合わない見本になる。
   */
  readonly reason?: InteractionReasonCode;
  /** `reasonDetail` と `work.reasonDetail`（技術的な詳細）。既定は `reason <sequence>`。 */
  readonly reasonDetail?: string | null;
  /** 対象の要素（操作の前の記録）の名前。既定は `Button <sequence>`。 */
  readonly accessibleName?: string;
}

function interactionCandidate(candidateId: string, accessibleName: string): InteractionCandidateEvidence {
  return {
    candidateId,
    ordinal: 0,
    tagName: 'button',
    role: null,
    accessibleName,
    textFingerprint: createSha256Fingerprint(accessibleName),
    ariaExpanded: 'false',
    ariaControls: null,
    ariaSelected: null,
    controlledVisible: null,
    controlledHidden: null,
    formAssociated: false,
    formMethod: null,
    formAction: null,
    href: null,
    hrefKind: 'NONE',
    download: false,
    type: 'button',
    disabled: false,
    visible: true,
    boundingBox: { x: 8, y: 8, width: 100, height: 20, top: 8, right: 108, bottom: 28, left: 8 },
  };
}

function interactionChange(candidateId: string, accessibleName: string): InteractionChangeEvidence {
  return {
    before: interactionCandidate(candidateId, accessibleName),
    after: null,
    identityStatus: 'MATCHED',
    changedFields: [],
    changedAttributes: [],
    changedAttributesTruncated: false,
    detailsOpenBefore: null,
    detailsOpenAfter: null,
  };
}

/**
 * Interaction の Evidence。候補の ID は `interaction-candidate:<candidate-<sequence> の SHA-256>`、対象は `button`（role なし）。
 * スキーマは、`status` が `NOT_VERIFIABLE` のときだけ `notVerifiableKind` を非 null にすることを求める。
 */
export function interaction(
  sequence: number,
  pageId: PageId,
  status: InteractionStatus,
  notVerifiableKind: InteractionNotVerifiableKind | null,
  options: InteractionOptions = {},
): EvidenceRecordFor<'interaction'> {
  const candidateId = `interaction-candidate:${createSha256Fingerprint(`candidate-${sequence}`)}`;
  const reason = options.reason ?? INTERACTION_REASON_CODES_BY_STATUS[status][0];
  const reasonDetail = options.reasonDetail === undefined ? `reason ${sequence}` : options.reasonDetail;
  const accessibleName = options.accessibleName ?? `Button ${sequence}`;
  return record('interaction', sequence, pageId, options.viewport ?? 'desktop', {
    candidateId,
    status,
    reason,
    reasonDetail,
    evidence: interactionChange(candidateId, accessibleName),
    work: { status, reason, reasonDetail, evidence: interactionChange(candidateId, accessibleName) },
    lifecycle: { status: 'CLOSED', reason: null, reasonDetail: null },
    notVerifiableKind,
  });
}

/** robots.txt の metadata の Evidence（ビューポートは `null`、取得は `OK`）。sitemap.xml の見本は `record` で作る。 */
export function metadata(
  sequence: number,
  pageId: PageId,
  overrides: Partial<RobotsTxtMetadataEvidence> = {},
): EvidenceRecordFor<'metadata'> {
  return record('metadata', sequence, pageId, null, {
    kind: 'ROBOTS_TXT',
    url: fixtureUrl('/robots.txt'),
    outcome: 'OK',
    httpStatus: 200,
    text: 'User-agent: *',
    textTruncated: false,
    sitemapUrls: null,
    sitemapUrlsTruncated: false,
    ...overrides,
  });
}

/** Safety の Evidence（空の Safety Ledger から作った `PASSIVE` の記録）。`overrides` は payload の項目を浅く上書きする。 */
export function safety(
  sequence: number,
  pageId: PageId,
  viewport: ViewportProfile | null = 'desktop',
  overrides: Partial<SafetyEventsEvidence> = {},
): EvidenceRecordFor<'safety'> {
  // Ledger の結果は深く凍結されているので、複製して凍結しない値にする。
  const empty = structuredClone(safetyEventsEvidenceFromSnapshot(new SafetyLedger().snapshot(), 'PASSIVE'));
  return record('safety', sequence, pageId, viewport, { ...empty, ...overrides });
}

/**
 * Safety の Evidence の、事象の一覧の項目の名前（`SafetyEventsEvidence` の項目の順）。値の一覧の owner は core の
 * `SAFETY_EVENT_KINDS` なので、それをそのまま返す（同じ一覧を、ここで作り直さない。C16e）。core の一覧と、空の Safety Ledger から
 * 作った記録の項目が一致することは、`tests/unit/core-contracts.test.ts` で確かめる。
 */
export const safetyEventListNames = (): readonly SafetyEventKind[] => SAFETY_EVENT_KINDS;

/** 事象の一覧の項目だけを持つ、Safety の Evidence の上書き。 */
export type SafetyEventLists = Pick<SafetyEventsEvidence, SafetyEventKind>;

/**
 * Safety の事象の見本（C16d。設計書 6.1.10）。すべての事象の一覧に1件以上の記録があり、スキーマに合う。`safety(…, overrides)` に渡す。
 * - `blockedExternalActions` は3件（`mailto:`、`tel:`、URL なし）。ほかは1件ずつ（`externalSchemeNavigations` は独自のスキーム。C18a）。
 * - 危険な文字列: `blockedNavigations` の URL（クエリに `<script>`）と、`blockedPopups` の URL（`javascript:`）。
 * - メソッドがあるのは、`blockedRequests`（POST）、`blockedNavigations`（GET）、`blockedInteractionRequests`（PUT）、
 *   `blockedInteractionNavigations`（GET）。候補の ID があるのは、`blockedExternalActions` と `excludedInteractionCandidates`。
 */
export function safetyEventSamples(): SafetyEventLists {
  return {
    blockedRequests: [{ method: 'POST', url: fixtureUrl('/api/submit'), reason: 'NON_READ_METHOD' }],
    blockedNavigations: [
      { method: 'GET', url: `https://external.test/?q=${HOSTILE_STRINGS.scriptTag}`, reason: 'EXTERNAL_MAIN_FRAME_NAVIGATION' },
    ],
    blockedWebSockets: [{ url: 'ws://127.0.0.1:4173/socket', reason: 'PASSIVE_WEBSOCKET' }],
    blockedExternalActions: [
      { candidateId: 'candidate-mailto', url: SPECIAL_SCHEME_URLS.mailto, reason: 'EXTERNAL_ACTION' },
      { candidateId: 'candidate-tel', url: SPECIAL_SCHEME_URLS.tel, reason: 'EXTERNAL_ACTION' },
      { candidateId: 'candidate-download', url: null, reason: 'DOWNLOAD' },
    ],
    excludedInteractionCandidates: [{ candidateId: 'candidate-submit', reason: 'SUBMISSION_CONTROL' }],
    blockedInteractionRequests: [{ method: 'PUT', url: fixtureUrl('/api/update'), reason: 'INTERACTION_FROZEN' }],
    blockedInteractionNavigations: [{ method: 'GET', url: fixtureUrl('/next.html'), reason: 'INTERACTION_FROZEN' }],
    blockedPopups: [{ url: HOSTILE_STRINGS.javascriptUrl, reason: 'INTERACTION_FROZEN' }],
    blockedDownloads: [{ url: fixtureUrl('/file.pdf'), suggestedFilename: 'file.pdf', reason: 'PASSIVE_DOWNLOAD' }],
    blockedInteractionWebSockets: [{ url: 'wss://external.test/live', reason: 'INTERACTION_FROZEN' }],
    externalSchemeNavigations: [{
      url: 'beaksight-test-app:probe',
      scheme: 'beaksight-test-app',
      frame: 'MAIN',
      phase: 'PASSIVE',
      reason: 'EXTERNAL_SCHEME_NAVIGATION',
    }],
  };
}

/** `httpSafetyEventSamples` が記録を持つ、事象の一覧の項目。 */
export type HttpSafetyEventKind = 'blockedRequests' | 'blockedExternalActions' | 'blockedDownloads' | 'blockedPopups';

/**
 * http(s) の URL を持つ Safety の事象の見本（R16f。設計書 6.1.11）。`safety(…, overrides)` に渡す。
 * - 遮断した POST、外部への作用、ダウンロード、ポップアップの4種類に、許可 Origin の中の URL と外部の URL を1件ずつ持つ
 *   （`classifyUrl` なら、`INTERNAL_NAVIGABLE` と `EXTERNAL_RECORD_ONLY` になり、リンクにされ得る URL）。
 * - 事象の表の URL が、種類と `classifyUrl` の結果によらず、リンクにならないことを確かめるために使う。
 */
export function httpSafetyEventSamples(): Pick<SafetyEventLists, HttpSafetyEventKind> {
  return {
    blockedRequests: [
      { method: 'POST', url: fixtureUrl('/api/contact'), reason: 'NON_READ_METHOD' },
      { method: 'POST', url: 'https://external.test/api/collect', reason: 'NON_READ_METHOD' },
    ],
    blockedExternalActions: [
      { candidateId: 'candidate-internal-action', url: fixtureUrl('/action.html'), reason: 'EXTERNAL_ACTION' },
      { candidateId: 'candidate-share', url: 'https://external.test/share?u=1', reason: 'EXTERNAL_ACTION' },
    ],
    blockedDownloads: [
      { url: fixtureUrl('/catalog.pdf'), suggestedFilename: 'catalog.pdf', reason: 'PASSIVE_DOWNLOAD' },
      { url: 'https://external.test/file.zip', suggestedFilename: 'file.zip', reason: 'PASSIVE_DOWNLOAD' },
    ],
    blockedPopups: [
      { url: fixtureUrl('/popup.html'), reason: 'INTERACTION_FROZEN' },
      { url: 'https://external.test/popup', reason: 'INTERACTION_FROZEN' },
    ],
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Finding とページ
// ---------------------------------------------------------------------------------------------------------------

/**
 * Finding。`ruleId` は `TEST_RULE_<sequence>`、`message` は `テストの指摘 <sequence>`、fingerprint は `finding-<sequence>` の SHA-256。
 * `pageUrl` は、ページがあればその既定のパス（PAGE-000001 は `/`、PAGE-000002 は `/second.html`、PAGE-000003 は `/third.html`）の URL、
 * なければ `null`。`viewport` は、ページがあれば `desktop`、なければ `null`。`overrides` は項目を上書きする。
 */
export function finding(
  sequence: number,
  severity: Severity,
  category: FindingCategory,
  pageId: PageId | null,
  evidenceRefs: readonly EvidenceId[],
  overrides: Partial<Finding> = {},
): Finding {
  return {
    schemaVersion: 'finding-schema/1.0',
    findingId: createFindingId(sequence),
    fingerprint: createSha256Fingerprint(`finding-${sequence}`),
    ruleId: `TEST_RULE_${sequence}`,
    ruleVersion: 1,
    category,
    severity,
    pageId,
    pageUrl: pageId === null ? null : fixtureUrl(defaultPagePath(pageId)),
    viewport: pageId === null ? null : 'desktop',
    message: `テストの指摘 ${sequence}`,
    evidenceRefs,
    ...overrides,
  };
}

const skippedReasons = (): IncompleteReason[] => [{ code: 'MAX_PAGES_REACHED', detail: null }];

/**
 * ビューポートの結果。`SKIPPED` は、最終 URL・HTTP ステータス・ナビゲーションの結果が `null`、理由が `MAX_PAGES_REACHED`。
 * ほかの状態は、最終 URL が `pageUrl`、HTTP ステータスが 200、理由なし、ナビゲーションの結果が `OK`（`overrides` で変える）。
 */
export function viewportResult(
  pageUrl: NormalizedHttpUrlEvidence,
  status: PageAuditStatus,
  overrides: Partial<ViewportAuditResult> = {},
): ViewportAuditResult {
  const skipped = status === 'SKIPPED';
  return {
    requestedUrl: pageUrl,
    finalUrl: skipped ? null : pageUrl,
    httpStatus: skipped ? null : 200,
    status,
    incompleteReasons: skipped ? skippedReasons() : [],
    navigationOutcome: skipped ? null : 'OK',
    ...overrides,
  };
}

/**
 * ページの結果。URL は `fixtureUrl(path)`、Desktop と Mobile の結果は `viewportResult(URL, status)`。
 * 理由は、`SKIPPED` なら `MAX_PAGES_REACHED`、ほかは空。`overrides` は項目を上書きする。
 */
export function page(
  pageId: PageId,
  path: string,
  status: PageAuditStatus = 'AUDITED',
  evidence: readonly EvidenceRecord[] = [],
  findings: readonly Finding[] = [],
  overrides: Partial<PageAuditResult> = {},
): PageAuditResult {
  const pageUrl = fixtureUrl(path);
  return {
    schemaVersion: 'page-schema/1.0',
    pageId,
    pageUrl,
    status,
    viewports: { desktop: viewportResult(pageUrl, status), mobile: viewportResult(pageUrl, status) },
    evidence,
    findings,
    incompleteReasons: status === 'SKIPPED' ? skippedReasons() : [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------------------------------------------

/** `RunSummary.retries` の1件。 */
export type RetryRecord = RunSummary['retries'][number];

/** 再試行の記録。既定は `TIMEOUT`（`detail` も `TIMEOUT`）。`evidenceIds` は、再試行の前の試行の Evidence の ID。 */
export function retry(
  url: NormalizedHttpUrlEvidence,
  attempt: number,
  evidence: readonly EvidenceRecord[],
  overrides: Partial<RetryRecord> = {},
): RetryRecord {
  return { url, attempt, navigationOutcome: 'TIMEOUT', detail: 'TIMEOUT', evidenceIds: evidence.map(idOf), ...overrides };
}

/** Run Status の入力。既定は、`deriveRunStatus` が `COMPLETE` を返すもの（すべて偽か 0、理由なし、検証済み、実行を終えた）。 */
export function runStatusInput(overrides: Partial<RunStatusInput> = {}): RunStatusInput {
  return {
    preflightFailed: false,
    safetyInvariantViolations: 0,
    safetyLedgerTruncated: false,
    incompleteReasons: [],
    unhandledFailures: 0,
    crawlLimitReached: false,
    requiredArtifactsValid: true,
    executionComplete: true,
    skippedRequiredWork: 0,
    blockedRequiredWork: 0,
    timedOutRequiredWork: 0,
    notObservedRequiredWork: 0,
    notVerifiedRequiredWork: 0,
    failedRequiredWork: 0,
    incompleteCollectorCount: 0,
    ...overrides,
  };
}

/**
 * Run の要約。既定は、`auditRun()` の既定の結果（監査した1ページ、`COMPLETE`、再試行なし、Safety の事象なし）に合う値。
 * 設定は `createTestConfig(FIXTURE_ORIGIN)`。`overrides` は項目を浅く上書きする（件数などを、ページに合わせて直すことはしない）。
 */
export function runSummary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    schemaVersion: 'run-schema/1.0',
    runId: FIXTURE_RUN_ID,
    toolVersion: '0.1.0',
    target: { id: 'test-target' },
    startUrl: fixtureUrl('/'),
    allowedOrigins: [FIXTURE_ORIGIN],
    runStatus: 'COMPLETE',
    startedAt: '2026-09-24T00:00:00.000Z',
    finishedAt: '2026-09-24T00:01:00.000Z',
    discoveredPageCount: 1,
    auditedPageCount: 1,
    partialPageCount: 0,
    failedPageCount: 0,
    skippedPageCount: 0,
    viewportPageCounts: {
      desktop: { audited: 1, partial: 0, failed: 0, skipped: 0 },
      mobile: { audited: 1, partial: 0, failed: 0, skipped: 0 },
    },
    environment: {
      nodeVersion: 'v24.0.0',
      platform: 'test',
      osRelease: 'test',
      arch: 'x64',
      playwrightVersion: '1.0.0',
      chromiumVersion: '140.0.0.0',
      userAgents: { desktop: 'agent-desktop', mobile: 'agent-mobile' },
    },
    effectiveConfig: createTestConfig(FIXTURE_ORIGIN),
    safety: {
      guardEnabled: true,
      blockedRequestsByMethod: {},
      blockedActions: { requests: 0, navigations: 0, externalActions: 0, popups: 0, downloads: 0, webSockets: 0 },
      excludedInteractionCandidateCount: 0,
      invariantViolationCount: 0,
      invariantViolations: [],
      recordTruncated: false,
    },
    unverifiedInteractionCount: 0,
    unverifiedInternalLinkCount: 0,
    retries: [],
    crawlLimits: { maxPagesReached: false, maxDepthReached: false, maxRuntimeReached: false },
    incompleteReasons: [],
    ...overrides,
  };
}

/** `auditRun` の上書きの指定。 */
export interface AuditRunOptions {
  /** `runSummary(run)` に渡す。 */
  readonly run?: Partial<RunSummary>;
  /** 渡すと、既定のページの代わりに、そのまま使う。 */
  readonly pages?: readonly PageAuditResult[];
  /** 渡さない場合は、各ページの `findings` を、ページの順につないだもの。 */
  readonly findings?: readonly Finding[];
  /** `runStatusInput(statusInput)` に渡す（既定の `COMPLETE` の入力の、一部を上書きする）。 */
  readonly statusInput?: Partial<RunStatusInput>;
}

/** `auditRun()` の既定のページ: 監査した PAGE-000001（`/`）。Evidence は、次の順。 */
function defaultPages(): PageAuditResult[] {
  const desktopDom = dom(2, PAGE_1, 'desktop', JAPANESE_TEXT);
  const evidence = [
    metadata(1, PAGE_1),
    desktopDom,
    screenshot(3, PAGE_1, 'desktop', 'VIEWPORT'),
    screenshot(4, PAGE_1, 'desktop', 'FULL_PAGE'),
    dom(5, PAGE_1, 'mobile', JAPANESE_TEXT),
    screenshot(6, PAGE_1, 'mobile', 'VIEWPORT'),
    interaction(7, PAGE_1, 'VERIFIED', null),
    safety(8, PAGE_1, 'desktop'),
  ];
  return [page(PAGE_1, '/', 'AUDITED', evidence, [finding(1, 'WARN', 'LAYOUT', PAGE_1, [idOf(desktopDom)])])];
}

/**
 * Run の見本（`AuditRunResult`）。既定は、スキーマに合い、`deriveRunStatus(statusInput)` が `runStatus`（`COMPLETE`）と一致する。
 * - ページ: PAGE-000001（`/`、AUDITED）。Evidence は、metadata（robots.txt）、Desktop の DOM（日本語）、Desktop の VIEWPORT と FULL_PAGE の
 *   スクリーンショット、Mobile の DOM、Mobile の VIEWPORT のスクリーンショット、Desktop の Interaction（VERIFIED）、Desktop の Safety。
 * - Finding: WARN・LAYOUT の1件（Desktop の DOM を参照）。
 * 上書きしても、件数や Run Status を、ほかの項目に合わせて直すことはしない（`runStatus` と `statusInput` の一致は、呼ぶ側が保つ）。
 */
export function auditRun(options: AuditRunOptions = {}): AuditRunResult {
  const pages = options.pages ?? defaultPages();
  return {
    run: runSummary(options.run),
    pages,
    findings: options.findings ?? pages.flatMap((value) => value.findings),
    statusInput: runStatusInput(options.statusInput),
  };
}

/**
 * HTML とバンドルのテストのための Run の見本。スキーマに合い、Run Status は `PARTIAL`（`deriveRunStatus` と一致）。
 * - 危険な文字列（`HOSTILE_STRINGS`）: Finding の文言、DOM の題名と可視テキスト、Interaction の対象の名前と理由の詳細、Run の理由の `detail`、
 *   PAGE-000002 の URL（クエリ）、Finding の `pageUrl`（`javascript:`）。
 * - `mailto:` と `tel:` の URL（`SPECIAL_SCHEME_URLS`）: Cross-page の Finding の `pageUrl`。
 * - 日本語: DOM の可視テキスト（`JAPANESE_TEXT`）と Finding の文言。
 * - 再試行したページ: PAGE-000001 の1回目の試行（TIMEOUT）の Desktop の DOM と、`retry-1` のスクリーンショット。
 * - Finding: ERROR、WARN、INFO、SAFETY のすべて。Cross-page の Finding と、スクリーンショットを直接参照する Finding を含む。
 */
export function edgeCaseAuditRun(): AuditRunResult {
  // PAGE-000001: 再試行の前の試行（1〜2）と、最終の試行（3〜9）。
  const retryDom = dom(1, PAGE_1, 'desktop', '再試行の前の本文');
  const retryShot = screenshot(2, PAGE_1, 'desktop', 'VIEWPORT', 1);
  const finalDom = dom(3, PAGE_1, 'desktop', `${JAPANESE_TEXT}\n${HOSTILE_TEXT}`, { title: `日本語の題名 ${HOSTILE_STRINGS.scriptTag}` });
  const interactionEvidence = interaction(8, PAGE_1, 'NOT_VERIFIABLE', 'CHECK_NOT_COMPLETED', {
    accessibleName: `メニュー ${HOSTILE_STRINGS.attributeBreak}`,
    reason: 'CANDIDATE_REDISCOVERY_INCOMPLETE',
    reasonDetail: HOSTILE_TEXT,
  });
  const safetyEvidence = safety(9, PAGE_1, 'desktop');
  const startEvidence = [
    retryDom,
    retryShot,
    finalDom,
    screenshot(4, PAGE_1, 'desktop', 'VIEWPORT'),
    screenshot(5, PAGE_1, 'desktop', 'FULL_PAGE'),
    dom(6, PAGE_1, 'mobile', JAPANESE_TEXT),
    screenshot(7, PAGE_1, 'mobile', 'VIEWPORT'),
    interactionEvidence,
    safetyEvidence,
  ];
  // PAGE-000002: URL のクエリに危険な文字列がある。
  const secondPath = `/search.html?q=${HOSTILE_STRINGS.scriptTag}`;
  const secondDom = dom(10, PAGE_2, 'desktop', '2ページ目の本文');
  const secondShot = screenshot(11, PAGE_2, 'desktop', 'VIEWPORT');

  const findings = [
    finding(1, 'ERROR', 'JAVASCRIPT', PAGE_1, [idOf(finalDom)], { message: `日本語の指摘: ${HOSTILE_TEXT}` }),
    finding(2, 'WARN', 'CROSS_PAGE', null, [idOf(finalDom)], { pageUrl: SPECIAL_SCHEME_URLS.mailto }),
    finding(3, 'INFO', 'CROSS_PAGE', null, [idOf(finalDom)], { pageUrl: SPECIAL_SCHEME_URLS.tel }),
    finding(4, 'INFO', 'CROSS_PAGE', null, [idOf(secondDom)], { pageUrl: HOSTILE_STRINGS.javascriptUrl }),
    finding(5, 'WARN', 'LAYOUT', PAGE_2, [idOf(secondShot)], { pageUrl: fixtureUrl(secondPath) }),
    finding(6, 'SAFETY', 'SAFETY', PAGE_1, [idOf(safetyEvidence)]),
  ] as const;
  const incompleteReasons: IncompleteReason[] = [{ code: 'REQUIRED_WORK_NOT_VERIFIED', detail: HOSTILE_TEXT }];

  return {
    run: runSummary({
      runStatus: 'PARTIAL',
      discoveredPageCount: 2,
      auditedPageCount: 2,
      viewportPageCounts: {
        desktop: { audited: 2, partial: 0, failed: 0, skipped: 0 },
        mobile: { audited: 2, partial: 0, failed: 0, skipped: 0 },
      },
      unverifiedInteractionCount: 1,
      retries: [retry(fixtureUrl('/'), 1, [retryDom, retryShot])],
      incompleteReasons,
    }),
    pages: [
      page(PAGE_1, '/', 'AUDITED', startEvidence, [findings[0], findings[5]]),
      page(PAGE_2, secondPath, 'AUDITED', [secondDom, secondShot], [findings[4]]),
    ],
    findings: [...findings],
    statusInput: runStatusInput({ incompleteReasons: structuredClone(incompleteReasons), notVerifiedRequiredWork: 1 }),
  };
}
