import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Browser, BrowserContext, Page } from 'playwright';
import { describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import { controlledScroll } from '../../src/browser/controlled-scroll.js';
import type { Viewport } from '../../src/config/types.js';
import {
  FINDING_CATEGORIES,
  INCOMPLETE_REASON_CODES,
  INTERACTION_STATUSES,
  VIEWPORT_PROFILES,
  type AuditRunResult,
  type EvidenceId,
  type EvidencePayloadByType,
  type EvidenceRecord,
  type EvidenceRecordFor,
  type EvidenceType,
  type Finding,
  type InteractionStatus,
  type PageAuditResult,
  type PageId,
  type RunSummary,
} from '../../src/core/contracts.js';
import type {
  InteractionCandidateEvidence,
  InteractionChangeEvidence,
  LayoutElementEvidence,
  LayoutEvidence,
  LinkEvidence,
  NormalizedHttpUrlEvidence,
  RectangleEvidence,
  VisibilityEvidence,
} from '../../src/core/evidence-types.js';
import {
  INTERACTION_LIFECYCLE_REASON_CODES,
  INTERACTION_REASON_CODES,
  INTERACTION_REASON_CODES_BY_STATUS,
  SCROLL_INCOMPLETE_REASONS,
  URL_REJECTION_REASONS,
} from '../../src/core/evidence-types.js';
import {
  createEvidenceId,
  createFindingId,
  createPageId,
  createRunId,
  createSha256Fingerprint,
} from '../../src/core/ids.js';
import { MIN_INTERACTION_TIMEOUT_EXCLUSIVE_MS } from '../../src/core/limits.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import { discoverLinks } from '../../src/crawl/discover-links.js';
import { collectAccessibilityEvidence } from '../../src/evidence/accessibility-collector.js';
import { collectColorEvidence } from '../../src/evidence/color-collector.js';
import { ConsoleCollector } from '../../src/evidence/console-collector.js';
import { collectDomEvidence } from '../../src/evidence/dom-collector.js';
import { collectLayoutEvidence, collectStressLayout } from '../../src/evidence/layout-collector.js';
import { NetworkCollector } from '../../src/evidence/network-collector.js';
import { PerformanceCollector } from '../../src/evidence/performance-collector.js';
import { captureScreenshots } from '../../src/evidence/screenshot-collector.js';
import { discoverInteractionCandidates } from '../../src/interaction/discover-candidates.js';
import { auditInteraction } from '../../src/interaction/isolated-auditor.js';
import { SafetyLedger, safetyEventsEvidenceFromSnapshot } from '../../src/safety/safety-ledger.js';
import { useHeadlessChromium } from '../helpers/chromium.js';
import { closePassiveResources } from '../helpers/passive-cleanup.js';
import { buildIntoTemporaryDirectory, snapshotDirectory } from '../helpers/temporary-build.js';
import { createTestConfig } from '../helpers/test-config.js';

const pageId = createPageId(1);
const observedAt = '2026-08-27T00:00:00.000Z';

/** 実際のページで controlled scroll を実行するときの設定（期限は各テストで決める）。 */
const SCHEMA_TEST_SCROLL_OPTIONS = Object.freeze({
  stepViewportFraction: 0.75,
  stepWaitMs: 25,
  stableWindowMs: 100,
});

const validFinding = {
  schemaVersion: 'finding-schema/1.0',
  findingId: createFindingId(42),
  fingerprint: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  ruleId: 'IMAGE_LOAD_FAILED',
  ruleVersion: 1,
  category: 'RESOURCE',
  severity: 'ERROR',
  pageId,
  pageUrl: 'https://example.test/catalog',
  viewport: 'desktop',
  message: 'An image did not load.',
  evidenceRefs: [createEvidenceId('network', 12)],
} satisfies Finding;

const networkTiming = {
  startTime: 1_000.5,
  domainLookupStart: -1,
  domainLookupEnd: -1,
  connectStart: -1,
  secureConnectionStart: -1,
  connectEnd: -1,
  requestStart: 0.25,
  responseStart: 2.5,
  responseEnd: 3.75,
};

const networkPayload = {
  requests: [{
    requestId: 'REQ-000001',
    url: 'https://example.test/missing.png',
    method: 'GET',
    resourceType: 'image',
    headers: { status: 'OBSERVED', values: { accept: 'image/*' } },
    timing: networkTiming,
    redirectFromRequestId: null,
    redirectToRequestId: null,
    redirectChainRequestIds: [],
    isNavigationRequest: false,
    isMainFrame: true,
    truncated: false,
  }],
  responses: [{
    requestId: 'REQ-000001',
    url: 'https://example.test/missing.png',
    status: 404,
    statusText: 'Not Found',
    headers: { status: 'FAILED', errorText: 'headers unavailable' },
    contentLengthHeader: null,
    timing: networkTiming,
    transferSize: { status: 'OBSERVED', headersBytes: 120, bodyBytes: 0, totalBytes: 120 },
    isNavigationRequest: false,
    isMainFrame: true,
    truncated: false,
  }],
  failures: [{
    requestId: 'REQ-000002',
    url: 'https://example.test/app.js',
    method: 'GET',
    resourceType: 'script',
    errorText: 'net::ERR_FAILED',
    timing: networkTiming,
    isNavigationRequest: false,
    isMainFrame: null,
    truncated: false,
  }],
  omittedRequestCount: 0,
  omittedResponseCount: 0,
  omittedFailureCount: 0,
} satisfies EvidencePayloadByType['network'];

const consolePayload = {
  consoleMessages: [{
    type: 'error',
    text: 'Failed to load resource',
    location: { url: 'https://example.test/catalog', lineNumber: 3, columnNumber: 7 },
    truncated: false,
  }],
  pageErrors: [{ name: 'TypeError', message: 'x is not a function', stack: null, truncated: false }],
  omittedConsoleMessageCount: 0,
  omittedPageErrorCount: 1,
} satisfies EvidencePayloadByType['console'];

const internalLink = {
  sourcePageId: pageId,
  anchorText: 'Catalog',
  ariaLabel: null,
  title: null,
  rawHref: '/catalog',
  normalized: { ok: true, url: 'https://example.test/catalog' as NormalizedHttpUrlEvidence },
  admission: { kind: 'INTERNAL_NAVIGABLE', url: 'https://example.test/catalog' },
  truncated: false,
} satisfies LinkEvidence;

const specialLink = {
  sourcePageId: pageId,
  anchorText: 'Mail',
  ariaLabel: 'Mail us',
  title: 'Mail',
  rawHref: 'mailto:info@example.test',
  normalized: { ok: false, rawUrl: 'mailto:info@example.test', reason: 'UNSUPPORTED_SCHEME' },
  admission: { kind: 'SPECIAL_SCHEME_RECORD_ONLY', rawUrl: 'mailto:info@example.test', scheme: 'mailto' },
  truncated: false,
} satisfies LinkEvidence;

const linkPayload = { links: [internalLink, specialLink], omittedLinkCount: 0 } satisfies EvidencePayloadByType['link'];

const domPayload = {
  pageId,
  scrollPosition: { scrollX: 0, scrollY: 0 },
  title: 'Catalog',
  metaDescription: null,
  canonicalUrl: 'https://example.test/catalog',
  lang: 'ja',
  headings: [{ level: 1, text: 'Catalog', truncated: false }],
  visibleText: {
    source: 'SEMANTIC_LANDMARKS',
    text: 'Catalog',
    truncated: false,
    nodeLimitReached: false,
    ariaHiddenText: '',
    regions: [{ kind: 'main', text: 'Catalog', ariaHidden: false, truncated: false }],
    omittedRegionCount: 0,
  },
  images: [{
    src: '/missing.png',
    resolvedUrl: 'https://example.test/missing.png',
    alt: null,
    complete: true,
    naturalWidth: 0,
    naturalHeight: 0,
    truncated: false,
  }],
  forms: [{
    method: 'get',
    action: 'https://example.test/search',
    fields: [{
      type: 'text',
      name: 'q',
      required: false,
      visible: true,
      labels: ['Search'],
      hasAriaLabel: false,
      hasAriaLabelledby: false,
      hasTitle: false,
      truncated: false,
    }],
    submitControls: [{ type: 'submit', name: '', value: '', text: 'Go', truncated: false }],
    omittedFieldCount: 0,
    omittedSubmitControlCount: 0,
    truncated: false,
  }],
  unassociatedFields: [{
    type: 'email',
    name: '',
    required: true,
    visible: true,
    labels: [],
    hasAriaLabel: false,
    hasAriaLabelledby: false,
    hasTitle: false,
    truncated: false,
  }],
  duplicateIds: [{ id: 'duplicate', count: 2, truncated: false }],
  truncation: {
    documentFields: { title: false, metaDescription: false, canonicalUrl: false, lang: false },
    omittedHeadingCount: 0,
    omittedImageCount: 0,
    omittedFormCount: 0,
    omittedUnassociatedFieldCount: 0,
    omittedDuplicateIdCount: 0,
  },
} satisfies EvidencePayloadByType['dom'];

const rect = {
  x: 0.5,
  y: 10,
  top: 10,
  right: 100.5,
  bottom: 30,
  left: 0.5,
  width: 100,
  height: 20,
} satisfies RectangleEvidence;

const visibility = {
  visible: true,
  display: 'block',
  visibility: 'visible',
  opacity: 1,
  hiddenAttribute: false,
  ariaHidden: false,
  clientRectCount: 1,
} satisfies VisibilityEvidence;

const layoutElement = {
  selector: 'main > h1',
  kind: 'heading',
  rect,
  area: 2_000,
  visibility,
  position: 'static',
  zIndex: 'auto',
  overflowX: 'visible',
  overflowY: 'visible',
  fixedOrStickyAncestor: false,
} satisfies LayoutElementEvidence;

const layout = {
  scrollPosition: { scrollX: 0, scrollY: 0 },
  document: {
    viewportWidth: 1_440,
    viewportHeight: 900,
    documentElementClientWidth: 1_440,
    documentElementClientHeight: 900,
    documentElementScrollWidth: 1_500,
    documentElementScrollHeight: 2_000,
    bodyScrollWidth: 1_500,
    bodyScrollHeight: 2_000,
    bodyClientWidth: 1_440,
    bodyClientHeight: 2_000,
    horizontalOverflowPx: 60,
    viewportHorizontalClip: 'NONE',
  },
  boxesOutsideViewport: [{
    selector: 'div.wide',
    kind: 'other',
    rect,
    visibility,
    position: 'static',
    zIndex: 'auto',
    overflowX: 'visible',
    overflowY: 'visible',
    horizontalClipAncestor: 'NONE',
    nearestListedAncestorIndex: null,
    outside: { left: false, right: true, top: false, bottom: false },
    truncated: false,
  }, {
    selector: 'div.wide > img',
    kind: 'image',
    rect,
    visibility,
    position: 'static',
    zIndex: 'auto',
    overflowX: 'clip',
    overflowY: 'clip',
    horizontalClipAncestor: 'SCROLLABLE',
    nearestListedAncestorIndex: 0,
    outside: { left: false, right: true, top: false, bottom: false },
    truncated: false,
  }],
  zeroSizeInteractive: [{
    selector: 'button.empty',
    tagName: 'button',
    role: null,
    rect: { ...rect, width: 0, height: 0 },
    visibility,
    position: 'static',
    zIndex: 'auto',
    overflowX: 'visible',
    overflowY: 'visible',
    hasRenderedDescendant: false,
    truncated: false,
  }],
  clippedText: [{
    selector: 'p.clip',
    text: 'Clipped text',
    rect,
    visibility,
    overflowX: 'hidden',
    overflowY: 'hidden',
    position: 'static',
    zIndex: 'auto',
    clientWidth: 100,
    clientHeight: 20,
    scrollWidth: 180,
    scrollHeight: 20,
    widthClipped: true,
    heightClipped: false,
    partiallyClippedText: true,
    truncated: false,
  }],
  fixedHeadingOverlaps: [{
    overlaySelector: 'header',
    headingSelector: 'h2',
    overlayRect: rect,
    headingRect: rect,
    overlayVisibility: visibility,
    headingVisibility: visibility,
    overlayPosition: 'fixed',
    overlayZIndex: '10',
    overlayOverflowX: 'visible',
    overlayOverflowY: 'visible',
    headingPosition: 'static',
    headingZIndex: 'auto',
    headingOverflowX: 'visible',
    headingOverflowY: 'visible',
    intersection: { ...rect, area: 2_000 },
    truncated: false,
  }],
  elementOverlaps: [{
    first: layoutElement,
    second: { ...layoutElement, selector: 'main > p', kind: 'paragraph' },
    intersection: { ...rect, area: 2_000 },
    truncated: false,
  }],
  fixedElements: [{
    ...layoutElement,
    selector: 'header',
    kind: 'other',
    position: 'fixed',
    viewportIntersectionArea: 2_000,
    viewportArea: 1_296_000,
    viewportAreaRatio: 0.0015,
    truncated: false,
  }],
  truncation: {
    omittedOutsideViewportCount: 0,
    omittedZeroSizeInteractiveCount: 0,
    omittedClippedTextCount: 0,
    omittedFixedHeadingOverlapCount: 0,
    omittedElementOverlapCount: 0,
    omittedFixedElementCount: 0,
    overlapComparisonLimitReached: false,
    clippedTextNodeScanLimitReachedCount: 0,
    renderedDescendantScanLimitReachedCount: 0,
  },
} satisfies LayoutEvidence;

const layoutPayload = {
  primary: { status: 'COMPLETE', layout },
  stressSweep: [
    { width: 320, height: 900, status: 'COMPLETE', layout },
    { width: 390, height: 900, status: 'PARTIAL', reason: 'DEADLINE_EXCEEDED', layout: null },
    {
      width: 768,
      height: 900,
      status: 'FAILED',
      stage: 'NAVIGATION',
      reason: 'NAVIGATION_FAILED',
      message: 'net::ERR_CONNECTION_RESET',
      layout: null,
    },
  ],
} satisfies EvidencePayloadByType['layout'];

const cssColor = { css: 'rgba(17, 17, 17, 1)', red: 17, green: 17, blue: 17, alpha: 1 };

const colorPayload = {
  scrollPosition: { scrollX: 0, scrollY: 120.5 },
  textSamples: [
    {
      selector: 'p.body',
      text: 'Body text',
      foreground: { status: 'OBSERVED', color: cssColor },
      background: { status: 'OBSERVED', color: { ...cssColor, css: 'rgba(255, 255, 255, 1)', red: 255, green: 255, blue: 255 } },
      contrast: { status: 'OBSERVED', ratio: 18.88, effectiveForeground: cssColor },
      boundingArea: 1_000,
      visibleArea: 900.5,
      truncated: false,
    },
    {
      selector: 'p.hero',
      text: 'Hero text',
      foreground: { status: 'UNAVAILABLE', reason: 'INVALID_COLOR', serialized: 'color(display-p3 1 0 0)' },
      background: { status: 'UNAVAILABLE', reason: 'BACKGROUND_IMAGE' },
      contrast: { status: 'UNAVAILABLE', reason: 'BACKGROUND_IMAGE' },
      boundingArea: 500,
      visibleArea: 500,
      truncated: true,
    },
  ],
  textSamplesTruncated: false,
  foregroundDistribution: [{ color: cssColor, area: 900.5, proportion: 1, sampleCount: 1 }],
  omittedDistributionEntryCount: 0,
  observedArea: 900.5,
} satisfies EvidencePayloadByType['color'];

const performancePayload = {
  status: 'COMPLETE',
  reason: 'COLLECTED',
  webVitals: {
    CLS: {
      status: 'OBSERVED',
      value: 0.02,
      id: 'v5-1',
      navigationType: 'navigate',
      attribution: { largestShiftTarget: 'main', largestShiftValue: 0.02 },
    },
    FCP: { status: 'OBSERVED', value: 512.5, id: 'v5-2', navigationType: 'navigate', attribution: null },
    INP: { status: 'UNSUPPORTED', value: null, id: null, navigationType: null, attribution: null },
    LCP: { status: 'NOT_OBSERVED', value: null, id: null, navigationType: null, attribution: null },
    TTFB: { status: 'OBSERVED', value: 20.25, id: 'v5-3', navigationType: 'navigate', attribution: null },
  },
  navigationTiming: {
    url: 'https://example.test/catalog',
    navigationType: 'navigate',
    startTime: 0,
    duration: 800.5,
    responseStart: 20.25,
    responseEnd: 30.5,
    domContentLoadedEventStart: 400,
    domContentLoadedEventEnd: 401,
    loadEventStart: 800,
    loadEventEnd: 800.5,
    transferSize: 1_200,
    encodedBodySize: 900,
    decodedBodySize: 2_000,
    serverTiming: [{ source: 'NAVIGATION', url: 'https://example.test/catalog', name: 'db', description: '', duration: 12.5 }],
  },
  resources: [
    {
      url: 'https://example.test/app.js',
      initiatorType: 'script',
      startTime: 100,
      duration: 50.5,
      responseStart: 120,
      responseEnd: 150.5,
      requestId: 'REQ-000003',
      networkResourceType: 'script',
      category: 'script',
      categoryBasis: 'NETWORK_EVIDENCE',
      serverTiming: [],
      sizeStatus: 'OBSERVED',
      transferSize: 300,
      encodedBodySize: 200,
      decodedBodySize: 400,
    },
    {
      url: 'https://cdn.example.test/font.woff2',
      initiatorType: 'css',
      startTime: 110,
      duration: 20,
      responseStart: 0,
      responseEnd: 130,
      requestId: null,
      networkResourceType: null,
      category: null,
      categoryBasis: 'UNKNOWN',
      serverTiming: [],
      sizeStatus: 'CROSS_ORIGIN_RESTRICTED',
      transferSize: null,
      encodedBodySize: null,
      decodedBodySize: null,
    },
  ],
  resourceSummaries: {
    script: { count: 1, sizeUnknownCount: 0, transferSize: 300, encodedBodySize: 200, decodedBodySize: 400 },
    stylesheet: { count: 0, sizeUnknownCount: 0, transferSize: 0, encodedBodySize: 0, decodedBodySize: 0 },
    image: { count: 0, sizeUnknownCount: 0, transferSize: 0, encodedBodySize: 0, decodedBodySize: 0 },
    'fetch-xhr': { count: 0, sizeUnknownCount: 0, transferSize: 0, encodedBodySize: 0, decodedBodySize: 0 },
  },
  resourceCoverage: { bufferSize: 500, bufferFull: false, retainedEntryCount: 2, omittedEntryCount: 0 },
  serverTiming: [{ source: 'NAVIGATION', url: 'https://example.test/catalog', name: 'db', description: '', duration: 12.5 }],
  telemetryHeaders: [
    {
      direction: 'REQUEST',
      requestId: 'REQ-000001',
      url: 'https://example.test/catalog',
      status: 'OBSERVED',
      values: { traceparent: '[REDACTED]' },
    },
    { direction: 'RESPONSE', requestId: 'REQ-000001', url: 'https://example.test/catalog', status: 'FAILED', errorText: 'x' },
  ],
  telemetryCandidates: [{
    requestId: 'REQ-000004',
    url: 'https://example.test/collect',
    method: 'GET',
    resourceType: 'fetch',
    matchingBasis: ['GENERIC_URL_HINT'],
    matchedHeaderNames: [],
    matchedHints: ['collect'],
  }],
  truncation: {
    omittedServerTimingCount: 0,
    omittedTelemetryHeaderCount: 0,
    omittedTelemetryCandidateCount: 0,
    omittedNetworkRequestCount: 0,
    omittedNetworkResponseCount: 0,
    textTruncated: false,
  },
} satisfies EvidencePayloadByType['performance'];

const partialPerformancePayload = {
  status: 'PARTIAL',
  reason: 'DEADLINE_EXCEEDED',
  webVitals: null,
  navigationTiming: null,
  resources: [],
  resourceSummaries: null,
  resourceCoverage: null,
  serverTiming: [],
  telemetryHeaders: [],
  telemetryCandidates: [],
  truncation: null,
} satisfies EvidencePayloadByType['performance'];

const accessibilityPayload = {
  status: 'COMPLETE',
  scrollPosition: { scrollX: 0, scrollY: 0 },
  frameScope: 'SAME_ORIGIN_ONLY',
  violations: [{
    ruleId: 'color-contrast',
    impact: 'serious',
    help: 'Elements must meet minimum color contrast ratio thresholds',
    helpUrl: 'https://dequeuniversity.com/rules/axe/4.13/color-contrast',
    tags: ['wcag2aa'],
    nodes: [{
      impact: 'serious',
      targetSelectors: ['#low', ['iframe', '#inner']],
      failureSummary: 'Fix any of the following',
      htmlSnippet: '<p id="low">Low</p>',
      truncated: false,
    }],
    omittedNodeCount: 0,
  }],
  incomplete: [{
    ruleId: 'color-contrast',
    impact: null,
    help: 'Needs review',
    helpUrl: 'https://dequeuniversity.com/rules/axe/4.13/color-contrast',
    tags: [],
    nodes: [],
    omittedNodeCount: 3,
  }],
} satisfies EvidencePayloadByType['accessibility'];

const partialAccessibilityPayload = {
  status: 'PARTIAL',
  reason: 'EVALUATION_FAILED',
  scrollPosition: null,
  frameScope: 'SAME_ORIGIN_ONLY',
  violations: [],
  incomplete: [],
} satisfies EvidencePayloadByType['accessibility'];

const interactionCandidate = {
  candidateId: `interaction-candidate:${createSha256Fingerprint('toggle')}`,
  ordinal: 0,
  tagName: 'button',
  role: null,
  accessibleName: 'Toggle details',
  textFingerprint: createSha256Fingerprint('Toggle details'),
  ariaExpanded: 'false',
  ariaControls: 'accordion-panel',
  ariaSelected: null,
  controlledVisible: false,
  controlledHidden: true,
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
} satisfies InteractionCandidateEvidence;

const interactionChange = {
  before: interactionCandidate,
  after: { ...interactionCandidate, ariaExpanded: 'true', controlledVisible: true, controlledHidden: false },
  identityStatus: 'MATCHED',
  changedFields: ['ariaExpanded', 'controlledVisible', 'controlledHidden', 'attributes'],
  changedAttributes: ['aria-expanded'],
  changedAttributesTruncated: false,
  detailsOpenBefore: null,
  detailsOpenAfter: null,
} satisfies InteractionChangeEvidence;

const interactionPayload = {
  candidateId: interactionCandidate.candidateId,
  status: 'VERIFIED',
  reason: 'OBSERVABLE_STATE_CHANGED',
  reasonDetail: null,
  evidence: interactionChange,
  work: { status: 'VERIFIED', reason: 'OBSERVABLE_STATE_CHANGED', reasonDetail: null, evidence: interactionChange },
  lifecycle: { status: 'CLOSED', reason: null, reasonDetail: null },
  notVerifiableKind: null,
} satisfies EvidencePayloadByType['interaction'];

const screenshotPayload = {
  pageId,
  viewport: 'desktop',
  relativePath: 'pages/PAGE-000001/desktop/viewport.png',
  captureType: 'VIEWPORT',
  scrollPosition: { scrollX: 0, scrollY: 0 },
} satisfies EvidencePayloadByType['screenshot'];

const scrollObservation = {
  observedAtMs: 1_790_000_000_000,
  scrollTarget: 'SCROLLING_ELEMENT',
  scrollY: 1_100,
  viewportHeight: 900,
  scrollHeight: 2_000,
  contentHeight: 2_000,
  documentScrollRange: 1_100,
  bodyScrollRange: 0,
  heightGrew: false,
  atBottom: true,
} satisfies EvidencePayloadByType['scroll']['observations'][number];

const scrollPayload = {
  status: 'COMPLETE',
  reason: 'BOTTOM_AND_HEIGHT_STABLE',
  heightGrowthCount: 1,
  observations: [{ ...scrollObservation, scrollY: 0, atBottom: false }, scrollObservation],
  omittedObservationCount: 12,
  targetSwitchCount: 1,
  restoration: { status: 'RESTORED', position: { scrollX: 0, scrollY: 0 } },
  innerScrollScan: {
    scannedElementCount: 16_384,
    scanLimitReached: true,
    containerCount: 1,
    representative: { clientHeight: 300, scrollHeight: 600 },
  },
  finalSnapshot: scrollObservation,
} satisfies EvidencePayloadByType['scroll'];

const partialScrollPayload = {
  status: 'PARTIAL',
  reason: 'SCROLL_TARGET_UNSTABLE',
  heightGrowthCount: 0,
  observations: [],
  omittedObservationCount: 0,
  targetSwitchCount: 0,
  restoration: { status: 'NOT_RESTORED', reason: 'DEADLINE_EXCEEDED', position: null },
  innerScrollScan: null,
  finalSnapshot: null,
} satisfies EvidencePayloadByType['scroll'];

// R15a（Task 14〜17 の設計書 5.6.2）: robots.txt と sitemap.xml の metadata の Evidence の見本。
const metadataPayload = {
  kind: 'ROBOTS_TXT',
  url: 'https://example.test/robots.txt',
  outcome: 'OK',
  httpStatus: 200,
  text: 'User-agent: *',
  textTruncated: false,
  sitemapUrls: null,
  sitemapUrlsTruncated: false,
} satisfies EvidencePayloadByType['metadata'];

const sitemapMetadataPayload = {
  kind: 'SITEMAP_XML',
  url: 'https://example.test/sitemap.xml',
  outcome: 'OK',
  httpStatus: 200,
  text: '<urlset><url><loc>https://example.test/catalog</loc></url></urlset>',
  textTruncated: false,
  sitemapUrls: ['https://example.test/catalog'],
  sitemapUrlsTruncated: false,
} satisfies EvidencePayloadByType['metadata'];

// T12d0: safety の Evidence の見本。すべての種類の事象を1件以上持ち、記録の上限に達した印も持つ。
const safetyCandidateId = `interaction-candidate:${createSha256Fingerprint('safety')}`;
const safetyPayload = {
  scope: 'PASSIVE',
  blockedRequestsByMethod: { POST: 2 },
  blockedRequests: [
    { method: 'POST', url: 'https://example.test/submit', reason: 'NON_READ_METHOD' },
    { method: 'POST', url: 'https://example.test/submit', reason: 'NON_READ_METHOD' },
  ],
  blockedNavigations: [{ method: 'GET', url: 'https://external.test/', reason: 'EXTERNAL_MAIN_FRAME_NAVIGATION' }],
  blockedWebSockets: [{ url: 'wss://example.test/socket', reason: 'PASSIVE_WEBSOCKET' }],
  blockedExternalActions: [
    { candidateId: safetyCandidateId, url: 'tel:0000', reason: 'EXTERNAL_ACTION' },
    { candidateId: safetyCandidateId, url: null, reason: 'DOWNLOAD' },
  ],
  excludedInteractionCandidates: [{ candidateId: safetyCandidateId, reason: 'SUBMISSION_CONTROL' }],
  blockedInteractionRequests: [{ method: 'GET', url: 'https://example.test/api', reason: 'INTERACTION_FROZEN' }],
  blockedInteractionNavigations: [{ method: 'GET', url: 'https://example.test/next', reason: 'INTERACTION_FROZEN' }],
  blockedPopups: [{ url: 'https://example.test/popup', reason: 'INTERACTION_FROZEN' }],
  blockedDownloads: [
    { url: 'https://example.test/file.pdf', suggestedFilename: 'file.pdf', reason: 'PASSIVE_DOWNLOAD' },
    { url: 'https://example.test/file.zip', suggestedFilename: 'file.zip', reason: 'INTERACTION_FROZEN' },
  ],
  blockedInteractionWebSockets: [{ url: 'wss://example.test/live', reason: 'INTERACTION_FROZEN' }],
  externalSchemeNavigations: [
    { url: 'tel:+10000000000', scheme: 'tel', frame: 'MAIN', phase: 'PASSIVE', reason: 'EXTERNAL_SCHEME_NAVIGATION' },
    {
      url: 'beaksight-test-app:probe',
      scheme: 'beaksight-test-app',
      frame: 'SUB',
      phase: 'INTERACTION',
      reason: 'EXTERNAL_SCHEME_NAVIGATION',
    },
  ],
  recordLimits: {
    truncated: true,
    droppedEventCount: 1,
    uncountedBlockedRequestCount: 0,
    truncatedTextCount: 0,
    reachedCategories: ['blockedPopups'],
  },
} satisfies EvidencePayloadByType['safety'];

function evidenceRecord<TType extends EvidenceType>(
  type: TType,
  sequence: number,
  payload: EvidencePayloadByType[TType],
): EvidenceRecordFor<TType> {
  // ID は createEvidenceId で作る。スキーマは、Evidence の種類ごとに ID の接頭辞を限る（R''2 の m2）。
  const evidenceId: EvidenceId = createEvidenceId(type, sequence);
  return { evidenceId, type, pageId, viewport: 'desktop', observedAt, payload };
}

const evidenceSamples = {
  network: evidenceRecord('network', 12, networkPayload),
  console: evidenceRecord('console', 13, consolePayload),
  dom: evidenceRecord('dom', 14, domPayload),
  link: evidenceRecord('link', 15, linkPayload),
  layout: evidenceRecord('layout', 16, layoutPayload),
  color: evidenceRecord('color', 17, colorPayload),
  performance: evidenceRecord('performance', 18, performancePayload),
  accessibility: evidenceRecord('accessibility', 19, accessibilityPayload),
  interaction: evidenceRecord('interaction', 20, interactionPayload),
  screenshot: evidenceRecord('screenshot', 21, screenshotPayload),
  scroll: evidenceRecord('scroll', 23, scrollPayload),
  metadata: evidenceRecord('metadata', 22, metadataPayload),
  safety: evidenceRecord('safety', 24, safetyPayload),
} satisfies { readonly [TType in EvidenceType]: EvidenceRecordFor<TType> };

const allEvidence: readonly EvidenceRecord[] = Object.values(evidenceSamples);
const evidenceTypes = Object.keys(evidenceSamples) as EvidenceType[];

const validEvidence = evidenceSamples.network;

const validPage = {
  schemaVersion: 'page-schema/1.0',
  pageId,
  pageUrl: 'https://example.test/catalog' as NormalizedHttpUrlEvidence,
  status: 'PARTIAL',
  viewports: {
    desktop: {
      requestedUrl: 'https://example.test/catalog' as NormalizedHttpUrlEvidence,
      finalUrl: 'https://example.test/catalog/',
      httpStatus: 200,
      status: 'AUDITED',
      incompleteReasons: [],
      navigationOutcome: 'OK',
    },
    mobile: {
      requestedUrl: 'https://example.test/catalog' as NormalizedHttpUrlEvidence,
      finalUrl: 'https://example.test/catalog/',
      httpStatus: 200,
      status: 'PARTIAL',
      incompleteReasons: [{ code: 'DEADLINE_EXCEEDED', detail: 'accessibility' }],
      navigationOutcome: 'OK',
    },
  },
  evidence: allEvidence,
  findings: [validFinding],
  incompleteReasons: [{ code: 'DEADLINE_EXCEEDED', detail: 'mobile: accessibility' }],
} satisfies PageAuditResult;

const validRun = {
  schemaVersion: 'run-schema/1.0',
  runId: createRunId(1),
  toolVersion: '0.1.0',
  target: { id: 'test-target' },
  startUrl: 'https://example.test/',
  allowedOrigins: ['https://example.test'],
  runStatus: 'PARTIAL',
  startedAt: '2026-08-27T00:00:00.000Z',
  finishedAt: '2026-08-27T00:01:00.000Z',
  discoveredPageCount: 1,
  auditedPageCount: 0,
  partialPageCount: 1,
  failedPageCount: 0,
  skippedPageCount: 0,
  viewportPageCounts: {
    desktop: { audited: 1, partial: 0, failed: 0, skipped: 0 },
    mobile: { audited: 0, partial: 1, failed: 0, skipped: 0 },
  },
  environment: {
    nodeVersion: 'v24.0.0',
    platform: 'win32',
    osRelease: '10.0.26200',
    arch: 'x64',
    playwrightVersion: '1.62.1',
    chromiumVersion: '140.0.7339.16',
    userAgents: { desktop: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', mobile: null },
  },
  effectiveConfig: createTestConfig('https://example.test'),
  safety: {
    guardEnabled: true,
    blockedRequestsByMethod: { POST: 2 },
    blockedActions: { requests: 2, navigations: 0, externalActions: 1, popups: 0, downloads: 0, webSockets: 0 },
    excludedInteractionCandidateCount: 3,
    invariantViolationCount: 0,
    invariantViolations: [],
    recordTruncated: false,
  },
  unverifiedInteractionCount: 1,
  unverifiedInternalLinkCount: 2,
  retries: [{
    url: 'https://example.test/catalog' as NormalizedHttpUrlEvidence,
    attempt: 1,
    navigationOutcome: 'FAILED',
    detail: 'FAILED:net::ERR_CONNECTION_RESET',
    evidenceIds: [createEvidenceId('safety', 3)],
  }],
  crawlLimits: { maxPagesReached: false, maxDepthReached: false, maxRuntimeReached: false },
  incompleteReasons: [{ code: 'DEADLINE_EXCEEDED', detail: 'PAGE-000001 mobile accessibility' }],
} satisfies RunSummary;

const validAudit = {
  schemaVersion: 'audit-schema/1.0',
  run: validRun,
  pages: [validPage],
  findings: [validFinding],
};

function withoutKey(value: object, key: string): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...value };
  delete copy[key];
  return copy;
}

describe('validateArtifact', () => {
  it('accepts a valid Finding through the canonical validator API', async () => {
    await expect(validateArtifact('finding', validFinding)).resolves.toEqual({ ok: true });
  });

  it('returns typed errors instead of throwing when a Finding lacks evidenceRefs', async () => {
    const { evidenceRefs: _evidenceRefs, ...missingEvidenceRefs } = validFinding;

    await expect(validateArtifact('finding', missingEvidenceRefs)).resolves.toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.stringContaining('evidenceRefs')]),
    });
  });

  it('rejects run statuses outside the four approved values', async () => {
    await expect(validateArtifact('run', { ...validRun, runStatus: 'IN_PROGRESS' })).resolves.toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.stringContaining('runStatus')]),
    });
  });

  it('accepts aligned versioned Finding, Page, Run, and Audit artifacts', async () => {
    await expect(validateArtifact('finding', validFinding)).resolves.toEqual({ ok: true });
    await expect(validateArtifact('page', validPage)).resolves.toEqual({ ok: true });
    await expect(validateArtifact('run', validRun)).resolves.toEqual({ ok: true });
    await expect(validateArtifact('audit', validAudit)).resolves.toEqual({ ok: true });
  });

  it('rejects malformed nested Evidence and Findings in Page and Audit artifacts', async () => {
    await expect(validateArtifact('page', {
      ...validPage,
      evidence: [{ ...validEvidence, payload: { ...networkPayload, omittedRequestCount: '0' } }],
    })).resolves.toMatchObject({ ok: false });
    await expect(validateArtifact('audit', {
      ...validAudit,
      pages: [{ ...validPage, findings: [{ ...validFinding, evidenceRefs: undefined }] }],
    })).resolves.toMatchObject({ ok: false });
  });

  it('rejects an audit with a malformed nested Run summary', async () => {
    await expect(validateArtifact('audit', { ...validAudit, run: {} })).resolves.toMatchObject({ ok: false });
  });

  // DEF-002: 検証関数の表は普通のオブジェクトなので、Object の既定のプロパティ名（継承したもの）や未知の名前を
  // スキーマ名として受け付けてはいけない。受け付けると、`Object` などが検証関数として呼ばれ、検証を素通りする。
  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf', 'report'])(
    'rejects %s as an artifact schema name instead of validating with an unrelated function',
    async (schemaName) => {
      await expect(validateArtifact(schemaName as never, validFinding)).rejects.toThrow(RangeError);
      await expect(validateArtifact(schemaName as never, validFinding)).rejects.toThrow('unsupported artifact schema name');
    },
  );

  it('validates through the canonical distribution module after the schemas are copied, without touching dist/', async () => {
    const repositoryDistDirectory = resolve(process.cwd(), 'dist');
    const distBefore = await snapshotDirectory(repositoryDistDirectory);
    const build = await buildIntoTemporaryDirectory();
    try {
      expect(build.distDirectory.startsWith(repositoryDistDirectory)).toBe(false);
      const moduleUrl = pathToFileURL(join(build.distDirectory, 'core', 'schema-validator.js')).href;
      const compiledValidator = await import(moduleUrl) as typeof import('../../src/core/schema-validator.js');
      await expect(compiledValidator.validateArtifact('audit', validAudit)).resolves.toEqual({ ok: true });
    } finally {
      await build.remove();
    }

    expect(existsSync(build.rootDirectory)).toBe(false);
    expect(await snapshotDirectory(repositoryDistDirectory)).toEqual(distBefore);
  });
});

async function readSchema(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(resolve(process.cwd(), 'schemas', `${name}.schema.json`), 'utf8')) as Record<
    string,
    unknown
  >;
}

function schemaAt(schema: unknown, path: readonly string[]): unknown {
  let current = schema;
  for (const key of path) {
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

describe('C8: Evidence payload schemas', () => {
  it('lists exactly the evidence types of EvidencePayloadByType, including link and color', async () => {
    const pageSchema = await readSchema('page');

    expect(schemaAt(pageSchema, ['$defs', 'evidence', 'properties', 'type', 'enum'])).toEqual(evidenceTypes);
    expect(evidenceTypes).toEqual(expect.arrayContaining(['link', 'color']));
  });

  it.each(evidenceTypes)('accepts a %s Evidence record in the collector output shape', async (type) => {
    await expect(validateArtifact('page', { ...validPage, evidence: [evidenceSamples[type]] }))
      .resolves.toEqual({ ok: true });
  });

  it.each(evidenceTypes)('rejects a %s Evidence record whose payload lacks a required field', async (type) => {
    const record = evidenceSamples[type];
    const [firstKey] = Object.keys(record.payload);
    const broken = { ...record, payload: withoutKey(record.payload, firstKey ?? '') };

    await expect(validateArtifact('page', { ...validPage, evidence: [broken] })).resolves.toMatchObject({ ok: false });
  });

  it.each(evidenceTypes)('rejects a %s Evidence record whose payload has an undeclared field', async (type) => {
    const record = evidenceSamples[type];
    const broken = { ...record, payload: { ...record.payload, undeclared: true } };

    await expect(validateArtifact('page', { ...validPage, evidence: [broken] })).resolves.toMatchObject({ ok: false });
  });

  it('rejects a payload of another evidence type', async () => {
    await expect(validateArtifact('page', {
      ...validPage,
      evidence: [{ ...evidenceSamples.color, payload: layoutPayload }],
    })).resolves.toMatchObject({ ok: false });
  });

  it.each([
    ['layout', (payload: typeof layoutPayload) => ({ ...payload, primary: { status: 'COMPLETE', layout: withoutKey(layout, 'scrollPosition') } })],
    ['color', (payload: typeof colorPayload) => withoutKey(payload, 'scrollPosition')],
    ['screenshot', (payload: typeof screenshotPayload) => withoutKey(payload, 'scrollPosition')],
    ['dom', (payload: typeof domPayload) => withoutKey(payload, 'scrollPosition')],
    ['accessibility', (payload: typeof accessibilityPayload) => withoutKey(payload, 'scrollPosition')],
  ] as const)('requires the collection scroll position in %s Evidence (C4)', async (type, breakPayload) => {
    const record = evidenceSamples[type];
    const broken = { ...record, payload: (breakPayload as (payload: unknown) => unknown)(record.payload) };

    await expect(validateArtifact('page', { ...validPage, evidence: [broken] })).resolves.toMatchObject({ ok: false });
  });

  it('accepts partial collector results with their reason codes', async () => {
    await expect(validateArtifact('page', {
      ...validPage,
      evidence: [
        evidenceRecord('performance', 30, partialPerformancePayload),
        evidenceRecord('accessibility', 31, partialAccessibilityPayload),
        evidenceRecord('layout', 32, {
          primary: { status: 'PARTIAL', reason: 'DEADLINE_EXCEEDED', layout: null },
          stressSweep: null,
        }),
      ],
    })).resolves.toEqual({ ok: true });
  });

  it('accepts UNSUPPORTED as an observation status and rejects statuses outside ObservationStatus', async () => {
    const inp = { status: 'UNSUPPORTED', value: null, id: null, navigationType: null, attribution: null };
    const withStatus = (status: string) => evidenceRecord('performance', 33, {
      ...performancePayload,
      webVitals: { ...performancePayload.webVitals, INP: { ...inp, status } },
    } as never);

    await expect(validateArtifact('page', { ...validPage, evidence: [withStatus('UNSUPPORTED')] }))
      .resolves.toEqual({ ok: true });
    await expect(validateArtifact('page', { ...validPage, evidence: [withStatus('UNKNOWN')] }))
      .resolves.toMatchObject({ ok: false });
  });

  it.each([
    ['COMPLETE', accessibilityPayload],
    ['PARTIAL', partialAccessibilityPayload],
  ] as const)('rejects %s accessibility Evidence without the frame scope (DEF-001b)', async (_status, payload) => {
    await expect(validateArtifact('page', {
      ...validPage,
      evidence: [evidenceRecord('accessibility', 35, withoutKey(payload, 'frameScope') as never)],
    })).resolves.toMatchObject({ ok: false, errors: expect.arrayContaining([expect.stringContaining('frameScope')]) });
  });

  it.each([
    ['COMPLETE', accessibilityPayload],
    ['PARTIAL', partialAccessibilityPayload],
  ] as const)('rejects %s accessibility Evidence with a frame scope other than SAME_ORIGIN_ONLY (DEF-001b)', async (_status, payload) => {
    await expect(validateArtifact('page', {
      ...validPage,
      evidence: [evidenceRecord('accessibility', 36, { ...payload, frameScope: 'ALL_FRAMES' } as never)],
    })).resolves.toMatchObject({ ok: false });
  });

  it('rejects a partial collector result with a reason outside the closed reason codes', async () => {
    await expect(validateArtifact('page', {
      ...validPage,
      evidence: [evidenceRecord('accessibility', 34, { ...partialAccessibilityPayload, reason: 'TIMEOUT' } as never)],
    })).resolves.toMatchObject({ ok: false });
  });
});

describe('C8: page results per viewport', () => {
  it('rejects a page without the per-viewport audit states', async () => {
    await expect(validateArtifact('page', withoutKey(validPage, 'viewports'))).resolves.toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.stringContaining('viewports')]),
    });
  });

  it.each(['desktop', 'mobile'] as const)('rejects a page without the %s viewport state', async (viewport) => {
    await expect(validateArtifact('page', { ...validPage, viewports: withoutKey(validPage.viewports, viewport) }))
      .resolves.toMatchObject({ ok: false });
  });

  it('rejects a viewport state outside the page audit statuses', async () => {
    await expect(validateArtifact('page', {
      ...validPage,
      viewports: { ...validPage.viewports, mobile: { ...validPage.viewports.mobile, status: 'DONE' } },
    })).resolves.toMatchObject({ ok: false });
  });
});

describe('C8: structured incomplete reasons', () => {
  it('uses the closed reason codes of INCOMPLETE_REASON_CODES in the schema', async () => {
    const runSchema = await readSchema('run');

    expect(schemaAt(runSchema, ['$defs', 'incompleteReason', 'properties', 'code', 'enum'])).toEqual(
      INCOMPLETE_REASON_CODES,
    );
  });

  it('accepts every reason code of INCOMPLETE_REASON_CODES on runs, pages, and viewports', async () => {
    expect(INCOMPLETE_REASON_CODES?.length).toBeGreaterThan(0);
    for (const code of INCOMPLETE_REASON_CODES) {
      const reasons = [{ code, detail: null }];

      await expect(validateArtifact('run', { ...validRun, incompleteReasons: reasons }), code)
        .resolves.toEqual({ ok: true });
      await expect(validateArtifact('page', {
        ...validPage,
        incompleteReasons: reasons,
        viewports: { ...validPage.viewports, desktop: { ...validPage.viewports.desktop, status: 'PARTIAL', incompleteReasons: reasons } },
      }), code).resolves.toEqual({ ok: true });
    }
  });

  it.each([
    ['a free-text string', 'a collector did not finish'],
    ['an unknown code', { code: 'SOMETHING_ELSE', detail: null }],
    ['a reason without detail', { code: 'DEADLINE_EXCEEDED' }],
    ['a reason with an undeclared field', { code: 'DEADLINE_EXCEEDED', detail: null, extra: 1 }],
  ])('rejects %s as an incomplete reason', async (_label, reason) => {
    await expect(validateArtifact('run', { ...validRun, incompleteReasons: [reason] })).resolves.toMatchObject({
      ok: false,
    });
    await expect(validateArtifact('page', { ...validPage, incompleteReasons: [reason] })).resolves.toMatchObject({
      ok: false,
    });
    await expect(validateArtifact('page', {
      ...validPage,
      viewports: { ...validPage.viewports, desktop: { ...validPage.viewports.desktop, status: 'PARTIAL', incompleteReasons: [reason] } },
    })).resolves.toMatchObject({ ok: false });
  });
});

describe('C8: run.json items of design 18.1 and chapter 35', () => {
  it.each([
    'toolVersion',
    'target',
    'startUrl',
    'allowedOrigins',
    'environment',
    'effectiveConfig',
    'viewportPageCounts',
    'safety',
    'unverifiedInteractionCount',
    'crawlLimits',
    'partialPageCount',
    'unverifiedInternalLinkCount',
    'retries',
  ])('rejects a run summary without %s', async (key) => {
    await expect(validateArtifact('run', withoutKey(validRun, key))).resolves.toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.stringContaining(key)]),
    });
  });

  it.each([
    ['guardEnabled'],
    ['blockedRequestsByMethod'],
    ['blockedActions'],
    ['invariantViolationCount'],
    ['recordTruncated'],
  ])('rejects a Safety Ledger summary without %s', async (key) => {
    await expect(validateArtifact('run', { ...validRun, safety: withoutKey(validRun.safety, key) }))
      .resolves.toMatchObject({ ok: false });
  });

  it('rejects a run summary whose target has no id', async () => {
    await expect(validateArtifact('run', { ...validRun, target: {} })).resolves.toMatchObject({ ok: false });
  });

  it('rejects an effective configuration that differs from the AuditConfig shape', async () => {
    await expect(validateArtifact('run', {
      ...validRun,
      effectiveConfig: withoutKey(validRun.effectiveConfig, 'crawl'),
    })).resolves.toMatchObject({ ok: false });
    await expect(validateArtifact('run', {
      ...validRun,
      effectiveConfig: { ...validRun.effectiveConfig, unknownSection: {} },
    })).resolves.toMatchObject({ ok: false });
  });

  it('rejects negative or fractional counts', async () => {
    await expect(validateArtifact('run', { ...validRun, unverifiedInteractionCount: -1 })).resolves.toMatchObject({
      ok: false,
    });
    await expect(validateArtifact('run', {
      ...validRun,
      safety: { ...validRun.safety, invariantViolationCount: 1.5 },
    })).resolves.toMatchObject({ ok: false });
  });
});

describe('C8: finding categories', () => {
  it('uses the closed categories of FINDING_CATEGORIES in the schema', async () => {
    const findingSchema = await readSchema('finding');

    expect(schemaAt(findingSchema, ['properties', 'category', 'enum'])).toEqual(FINDING_CATEGORIES);
  });

  it('accepts every category of FINDING_CATEGORIES', async () => {
    expect(FINDING_CATEGORIES?.length).toBeGreaterThan(0);
    for (const category of FINDING_CATEGORIES) {
      await expect(validateArtifact('finding', { ...validFinding, category }), category).resolves.toEqual({ ok: true });
    }
  });

  it.each(['media', 'http', ''])('rejects the category %j', async (category) => {
    await expect(validateArtifact('finding', { ...validFinding, category })).resolves.toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.stringContaining('category')]),
    });
  });
});

describe('F07 M1: integer viewport sizes and interaction timeout in the effective configuration', () => {
  const config = validRun.effectiveConfig;

  it.each([
    ['a fractional desktop width', { viewports: { ...config.viewports, primaryDesktop: { width: 1_440.5, height: 900 } } }],
    ['a fractional mobile height', { viewports: { ...config.viewports, primaryMobile: { width: 390, height: 844.5 } } }],
    ['a zero viewport width', { viewports: { ...config.viewports, primaryDesktop: { width: 0, height: 900 } } }],
    ['a fractional stress width', { viewports: { ...config.viewports, stressWidths: [320, 390.5] } }],
    ['a zero stress width', { viewports: { ...config.viewports, stressWidths: [0] } }],
    ['a fractional interaction timeout', { crawl: { ...config.crawl, interactionTimeoutMs: 2_500.5 } }],
  ])('rejects %s', async (_label, change) => {
    await expect(validateArtifact('run', { ...validRun, effectiveConfig: { ...config, ...change } }))
      .resolves.toMatchObject({ ok: false });
  });
});

// P14a（Task 14〜17 の設計書 4.5.7）: 時間の設定は、正の整数に限る。設定の検証（`validateConfig`）と同じ規則。
describe('P14a: integer durations in the effective configuration', () => {
  const config = validRun.effectiveConfig;
  const durationKeys = ['maxRuntimeMs', 'navigationTimeoutMs', 'overallPageTimeoutMs', 'resourceSettlingTimeoutMs'] as const;
  const withCrawl = (change: Record<string, unknown>) => ({
    ...validRun,
    effectiveConfig: { ...config, crawl: { ...config.crawl, ...change } },
  });

  it.each(durationKeys.flatMap((key) => [
    [key, 1_000.5],
    [key, 0.5],
    [key, 0],
    [key, -1],
  ] as const))('rejects crawl.%s = %s', async (key, value) => {
    await expect(validateArtifact('run', withCrawl({ [key]: value }))).resolves.toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.stringContaining(key)]),
    });
  });

  it.each(durationKeys)('accepts crawl.%s = 1', async (key) => {
    await expect(validateArtifact('run', withCrawl({ [key]: 1 }))).resolves.toEqual({ ok: true });
  });
});

// F17b（F17 の発見事項3）: 設定のスキーマの interactionTimeoutMs の下限を、設定の検証と同じ定数にそろえる。
describe('F17b: the lower bound of the interaction timeout in the effective configuration', () => {
  const config = validRun.effectiveConfig;
  const lowestAcceptedTimeoutMs = MIN_INTERACTION_TIMEOUT_EXCLUSIVE_MS + 1;
  const withInteractionTimeout = (interactionTimeoutMs: number) => ({
    ...validRun,
    effectiveConfig: { ...config, crawl: { ...config.crawl, interactionTimeoutMs } },
  });

  it('uses MIN_INTERACTION_TIMEOUT_EXCLUSIVE_MS + 1 as the minimum of the schema', async () => {
    const runSchema = await readSchema('run');

    expect(
      schemaAt(runSchema, ['properties', 'effectiveConfig', 'properties', 'crawl', 'properties', 'interactionTimeoutMs', 'minimum']),
    ).toBe(lowestAcceptedTimeoutMs);
  });

  it.each([1, MIN_INTERACTION_TIMEOUT_EXCLUSIVE_MS - 1, MIN_INTERACTION_TIMEOUT_EXCLUSIVE_MS])(
    'rejects an interaction timeout of %s ms, which is below the lower bound',
    async (interactionTimeoutMs) => {
      await expect(validateArtifact('run', withInteractionTimeout(interactionTimeoutMs))).resolves.toMatchObject({
        ok: false,
        errors: expect.arrayContaining([expect.stringContaining('interactionTimeoutMs')]),
      });
    },
  );

  it('accepts an interaction timeout at the lower bound', async () => {
    await expect(validateArtifact('run', withInteractionTimeout(lowestAcceptedTimeoutMs))).resolves.toEqual({ ok: true });
  });
});

describe('F16 R5 N-5: the names of the changed target attributes in Interaction Evidence', () => {
  const withChange = (change: Record<string, unknown>) => {
    const evidence = { ...interactionChange, ...change };
    return {
      ...validPage,
      evidence: [{
        ...evidenceSamples.interaction,
        payload: { ...interactionPayload, evidence, work: { ...interactionPayload.work, evidence } },
      }],
    };
  };

  it('accepts an empty list of changed attribute names', async () => {
    await expect(validateArtifact('page', withChange({ changedAttributes: [] }))).resolves.toEqual({ ok: true });
  });

  // F17（F16 の発見事項7）: 変わった属性の名前を上限で切り詰めたことを残す。
  it('accepts a truncated list of changed attribute names', async () => {
    await expect(validateArtifact('page', withChange({ changedAttributesTruncated: true }))).resolves.toEqual({ ok: true });
  });

  it.each([
    ['without the changed attribute names', withoutKey(interactionChange, 'changedAttributes')],
    ['with a non-string attribute name', { ...interactionChange, changedAttributes: [1] }],
    ['with a non-array list of attribute names', { ...interactionChange, changedAttributes: 'class' }],
    ['without the truncation mark of the changed attribute names', withoutKey(interactionChange, 'changedAttributesTruncated')],
    ['with a non-boolean truncation mark', { ...interactionChange, changedAttributesTruncated: 'true' }],
    ['with a null truncation mark', { ...interactionChange, changedAttributesTruncated: null }],
  ])('rejects an interaction change %s', async (_label, evidence) => {
    const page = {
      ...validPage,
      evidence: [{
        ...evidenceSamples.interaction,
        payload: { ...interactionPayload, evidence, work: { ...interactionPayload.work, evidence } },
      }],
    };
    await expect(validateArtifact('page', page)).resolves.toMatchObject({ ok: false });
  });
});

// F18（R6 の M-4）: 対象が details の summary の場合の、click の前後の open の値。
describe('F18 R6 M-4: the open state of the parent details before and after the click in Interaction Evidence', () => {
  const pageWithChange = (evidence: Record<string, unknown>) => ({
    ...validPage,
    evidence: [{
      ...evidenceSamples.interaction,
      payload: { ...interactionPayload, evidence, work: { ...interactionPayload.work, evidence } },
    }],
  });

  it.each([
    [false, true],
    [true, false],
    [null, null],
  ] as const)('accepts detailsOpenBefore = %s and detailsOpenAfter = %s', async (before, after) => {
    const evidence = { ...interactionChange, detailsOpenBefore: before, detailsOpenAfter: after };
    await expect(validateArtifact('page', pageWithChange(evidence))).resolves.toEqual({ ok: true });
  });

  it.each([
    ['without the open state before the click', withoutKey(interactionChange, 'detailsOpenBefore')],
    ['without the open state after the click', withoutKey(interactionChange, 'detailsOpenAfter')],
    ['with a non-boolean open state before the click', { ...interactionChange, detailsOpenBefore: 'open' }],
    ['with a non-boolean open state after the click', { ...interactionChange, detailsOpenAfter: 1 }],
  ])('rejects an interaction change %s', async (_label, evidence) => {
    await expect(validateArtifact('page', pageWithChange(evidence))).resolves.toMatchObject({ ok: false });
  });
});

// I15a（Task 14〜17 の設計書 5.4.1）: NOT_VERIFIABLE の区分は、状態が NOT_VERIFIABLE の場合だけ値を持ち、ほかの状態では null。
describe('I15a: the NOT_VERIFIABLE kind in Interaction Evidence', () => {
  // C18n: 理由のコードは status に合うものにする（status ごとの一覧の最初のコード）。
  const pageWithOutcome = (status: InteractionStatus, notVerifiableKind: unknown) => {
    const reason = INTERACTION_REASON_CODES_BY_STATUS[status][0];
    return {
      ...validPage,
      evidence: [{
        ...evidenceSamples.interaction,
        payload: {
          ...interactionPayload,
          status,
          reason,
          work: { ...interactionPayload.work, status, reason },
          notVerifiableKind,
        },
      }],
    };
  };

  it.each([['OBSERVED_NO_CHANGE'], ['CHECK_NOT_COMPLETED']] as const)('accepts NOT_VERIFIABLE with the kind %s', async (kind) => {
    await expect(validateArtifact('page', pageWithOutcome('NOT_VERIFIABLE', kind))).resolves.toEqual({ ok: true });
  });

  it.each(INTERACTION_STATUSES.filter((status) => status !== 'NOT_VERIFIABLE').map((status) => [status]))(
    'accepts %s with a null kind',
    async (status) => {
      await expect(validateArtifact('page', pageWithOutcome(status, null))).resolves.toEqual({ ok: true });
    },
  );

  it('rejects NOT_VERIFIABLE with a null kind', async () => {
    await expect(validateArtifact('page', pageWithOutcome('NOT_VERIFIABLE', null))).resolves.toEqual({
      ok: false,
      errors: expect.arrayContaining([expect.stringContaining('must match "then" schema')]),
    });
  });

  it.each(INTERACTION_STATUSES.filter((status) => status !== 'NOT_VERIFIABLE').map((status) => [status]))(
    'rejects %s with a kind',
    async (status) => {
      await expect(validateArtifact('page', pageWithOutcome(status, 'OBSERVED_NO_CHANGE'))).resolves.toEqual({
        ok: false,
        errors: expect.arrayContaining([expect.stringContaining('must match "else" schema')]),
      });
    },
  );

  it('rejects an unknown kind and a missing kind', async () => {
    await expect(validateArtifact('page', pageWithOutcome('NOT_VERIFIABLE', 'TIMED_OUT'))).resolves.toMatchObject({ ok: false });
    await expect(validateArtifact('page', {
      ...validPage,
      evidence: [{ ...evidenceSamples.interaction, payload: withoutKey(interactionPayload, 'notVerifiableKind') }],
    })).resolves.toEqual({
      ok: false,
      errors: expect.arrayContaining([expect.stringContaining('must include notVerifiableKind')]),
    });
  });
});

// C18n（Task 19 の前の整理の設計書 5.1）: Interaction の理由は、閉じた一覧のコードと、必須の技術的な詳細（`reasonDetail`）に分ける。
// status ごとに入りうるコード（`INTERACTION_REASON_CODES_BY_STATUS`）を、スキーマでも確かめる。
describe('C18n: Interaction reason codes and reason details', () => {
  type InteractionPayloadOverride = Record<string, unknown>;
  const pageWithInteraction = (payload: InteractionPayloadOverride) => ({
    ...validPage,
    evidence: [{ ...evidenceSamples.interaction, payload }],
  });
  const outcomeOf = (status: InteractionStatus, reason: string, reasonDetail: unknown = null) => ({
    ...interactionPayload,
    status,
    reason,
    reasonDetail,
    work: { ...interactionPayload.work, status, reason, reasonDetail },
    notVerifiableKind: status === 'NOT_VERIFIABLE' ? 'CHECK_NOT_COMPLETED' : null,
  });
  const statusCodePairs = INTERACTION_STATUSES.flatMap((status) =>
    INTERACTION_REASON_CODES_BY_STATUS[status].map((code) => [status, code] as const));

  it('lists every reason code under exactly one status', () => {
    expect(statusCodePairs.map(([, code]) => code).sort()).toEqual([...INTERACTION_REASON_CODES].sort());
    expect(new Set(INTERACTION_REASON_CODES).size).toBe(INTERACTION_REASON_CODES.length);
  });

  it.each(statusCodePairs)('accepts %s with the reason code %s, with and without a detail', async (status, code) => {
    await expect(validateArtifact('page', pageWithInteraction(outcomeOf(status, code)))).resolves.toEqual({ ok: true });
    await expect(validateArtifact('page', pageWithInteraction(outcomeOf(status, code, 'detail'))))
      .resolves.toEqual({ ok: true });
  });

  it.each([
    ['an English sentence', 'Observable interaction state changed'],
    ['an unknown code', 'UNKNOWN_REASON'],
    ['a lower-case code', 'observable_state_changed'],
    ['a lifecycle code', 'OWNER_CLOSE_FAILED'],
  ])('rejects %s as the reason and as the work reason', async (_label, reason) => {
    const topLevel = { ...interactionPayload, reason };
    const work = { ...interactionPayload, work: { ...interactionPayload.work, reason } };
    await expect(validateArtifact('page', pageWithInteraction(topLevel))).resolves.toMatchObject({ ok: false });
    await expect(validateArtifact('page', pageWithInteraction(work))).resolves.toMatchObject({ ok: false });
  });

  it.each([
    ['VERIFIED', 'CLICK_FAILED'],
    ['REJECTED_UNSAFE', 'NO_OBSERVABLE_CHANGE'],
    ['BLOCKED_BY_SAFETY', 'OBSERVABLE_STATE_CHANGED'],
    ['NOT_VERIFIABLE', 'SAFETY_FREEZE_BLOCKED'],
    ['EXECUTION_FAILED', 'CLICK_TIMED_OUT'],
  ] as const)('rejects %s with the reason code %s of another status', async (status, reason) => {
    const mismatched = outcomeOf(status, reason);
    const topLevelOnly = { ...mismatched, work: { ...mismatched.work, status: 'VERIFIED', reason: 'OBSERVABLE_STATE_CHANGED' } };
    const workOnly = { ...outcomeOf(status, INTERACTION_REASON_CODES_BY_STATUS[status][0]), work: mismatched.work };
    await expect(validateArtifact('page', pageWithInteraction(topLevelOnly))).resolves.toMatchObject({ ok: false });
    await expect(validateArtifact('page', pageWithInteraction(workOnly))).resolves.toMatchObject({ ok: false });
  });

  it('rejects a missing or non-string reason detail on the Evidence and the work', async () => {
    await expect(validateArtifact('page', pageWithInteraction(withoutKey(interactionPayload, 'reasonDetail')))).resolves.toEqual({
      ok: false,
      errors: expect.arrayContaining([expect.stringContaining('must include reasonDetail')]),
    });
    await expect(validateArtifact('page', pageWithInteraction({
      ...interactionPayload,
      work: withoutKey(interactionPayload.work, 'reasonDetail'),
    }))).resolves.toEqual({
      ok: false,
      errors: expect.arrayContaining([expect.stringContaining('must include reasonDetail')]),
    });
    await expect(validateArtifact('page', pageWithInteraction({ ...interactionPayload, reasonDetail: 1 })))
      .resolves.toMatchObject({ ok: false });
    await expect(validateArtifact('page', pageWithInteraction({
      ...interactionPayload,
      work: { ...interactionPayload.work, reasonDetail: false },
    }))).resolves.toMatchObject({ ok: false });
  });

  it.each(INTERACTION_LIFECYCLE_REASON_CODES.map((code) => [code]))(
    'accepts the lifecycle reason code %s, with and without a detail',
    async (code) => {
      for (const reasonDetail of [null, 'close failed']) {
        await expect(validateArtifact('page', pageWithInteraction({
          ...interactionPayload,
          lifecycle: { status: 'CLOSED', reason: code, reasonDetail },
        }))).resolves.toEqual({ ok: true });
      }
    },
  );

  it.each([
    ['an English lifecycle reason', { status: 'CLOSED', reason: 'Interaction owner close failed', reasonDetail: null }],
    ['an Interaction reason code as the lifecycle reason', { status: 'CLOSED', reason: 'EXECUTION_FAILED', reasonDetail: null }],
    ['a detail without a lifecycle reason', { status: 'CLOSED', reason: null, reasonDetail: 'close failed' }],
    ['a missing lifecycle reason detail', { status: 'CLOSED', reason: null }],
    ['a non-string lifecycle reason detail', { status: 'CLOSED', reason: 'OWNER_CLOSE_FAILED', reasonDetail: 1 }],
  ])('rejects %s', async (_label, lifecycle) => {
    await expect(validateArtifact('page', pageWithInteraction({ ...interactionPayload, lifecycle })))
      .resolves.toMatchObject({ ok: false });
  });
});

describe('F07 M4: bounded Link Evidence', () => {
  it('requires the omitted link count and rejects a negative or fractional count', async () => {
    const withPayload = (payload: unknown) => ({ ...validPage, evidence: [{ ...evidenceSamples.link, payload }] });

    await expect(validateArtifact('page', withPayload(withoutKey(linkPayload, 'omittedLinkCount'))))
      .resolves.toMatchObject({ ok: false });
    await expect(validateArtifact('page', withPayload({ ...linkPayload, omittedLinkCount: -1 })))
      .resolves.toMatchObject({ ok: false });
    await expect(validateArtifact('page', withPayload({ ...linkPayload, omittedLinkCount: 1.5 })))
      .resolves.toMatchObject({ ok: false });
  });

  it('requires the truncation mark on every link', async () => {
    await expect(validateArtifact('page', {
      ...validPage,
      evidence: [{ ...evidenceSamples.link, payload: { ...linkPayload, links: [withoutKey(internalLink, 'truncated')] } }],
    })).resolves.toMatchObject({ ok: false });
  });

  it('keeps links only in link Evidence and rejects a copy of them in DOM Evidence (R\'2 m3)', async () => {
    await expect(validateArtifact('page', {
      ...validPage,
      evidence: [{ ...evidenceSamples.dom, payload: { ...domPayload, links: [internalLink] } }],
    })).resolves.toMatchObject({ ok: false });
    await expect(validateArtifact('page', {
      ...validPage,
      evidence: [{
        ...evidenceSamples.dom,
        payload: { ...domPayload, truncation: { ...domPayload.truncation, omittedLinkCount: 0 } },
      }],
    })).resolves.toMatchObject({ ok: false });
  });
});

describe('F07 M5: URL rejection reason codes', () => {
  it('uses the closed codes of URL_REJECTION_REASONS in the schema', async () => {
    const pageSchema = await readSchema('page');

    expect(schemaAt(pageSchema, ['$defs', 'urlRejectionReason', 'enum'])).toEqual(URL_REJECTION_REASONS);
    expect(Object.isFrozen(URL_REJECTION_REASONS)).toBe(true);
  });

  it('accepts every code of URL_REJECTION_REASONS on the normalization and the admission of a link', async () => {
    for (const reason of URL_REJECTION_REASONS) {
      const link = {
        ...internalLink,
        normalized: { ok: false, rawUrl: '/catalog', reason },
        admission: { kind: 'REJECTED_INVALID', rawUrl: '/catalog', reason },
      };
      await expect(validateArtifact('page', {
        ...validPage,
        evidence: [{ ...evidenceSamples.link, payload: { ...linkPayload, links: [link] } }],
      }), reason).resolves.toEqual({ ok: true });
    }
  });

  it.each([
    ['normalized', { ok: false, rawUrl: '/catalog', reason: 'invalid URL' }],
    ['admission', { kind: 'REJECTED_INVALID', rawUrl: '/catalog', reason: 'credential-bearing HTTP(S) URL' }],
  ])('rejects a free-text reason in the %s result', async (key, result) => {
    await expect(validateArtifact('page', {
      ...validPage,
      evidence: [{ ...evidenceSamples.link, payload: { ...linkPayload, links: [{ ...internalLink, [key]: result }] } }],
    })).resolves.toMatchObject({ ok: false });
  });
});

describe('F07 M5: viewport of Evidence and Findings', () => {
  it('uses the viewport profiles of VIEWPORT_PROFILES, or null, in the schemas', async () => {
    const pageSchema = await readSchema('page');
    const findingSchema = await readSchema('finding');

    expect(VIEWPORT_PROFILES).toEqual(['desktop', 'mobile']);
    expect(Object.isFrozen(VIEWPORT_PROFILES)).toBe(true);
    expect(schemaAt(pageSchema, ['$defs', 'evidence', 'properties', 'viewport', 'enum'])).toEqual([...VIEWPORT_PROFILES, null]);
    expect(schemaAt(findingSchema, ['properties', 'viewport', 'enum'])).toEqual([...VIEWPORT_PROFILES, null]);
  });

  it('accepts null as the viewport of viewport-independent Evidence and Findings', async () => {
    await expect(validateArtifact('page', {
      ...validPage,
      evidence: [{ ...evidenceSamples.metadata, viewport: null }],
    })).resolves.toEqual({ ok: true });
    await expect(validateArtifact('finding', { ...validFinding, category: 'CROSS_PAGE', viewport: null }))
      .resolves.toEqual({ ok: true });
  });

  it.each(['tablet', '', 'Desktop'])('rejects the viewport %j on Evidence and Findings', async (viewport) => {
    await expect(validateArtifact('page', { ...validPage, evidence: [{ ...validEvidence, viewport }] }))
      .resolves.toMatchObject({ ok: false });
    await expect(validateArtifact('finding', { ...validFinding, viewport })).resolves.toMatchObject({ ok: false });
  });
});

describe('F07 M5: page identity per viewport', () => {
  it.each(['requestedUrl', 'finalUrl', 'httpStatus', 'navigationOutcome'])('rejects a viewport result without %s', async (key) => {
    await expect(validateArtifact('page', {
      ...validPage,
      viewports: { ...validPage.viewports, desktop: withoutKey(validPage.viewports.desktop, key) },
    })).resolves.toMatchObject({ ok: false, errors: expect.arrayContaining([expect.stringContaining(key)]) });
  });

  it.each([
    ['an empty requestedUrl', { requestedUrl: '' }],
    ['a null requestedUrl', { requestedUrl: null }],
    ['an empty finalUrl', { finalUrl: '' }],
    ['a fractional httpStatus', { httpStatus: 200.5 }],
    ['a negative httpStatus', { httpStatus: -1 }],
    ['a string httpStatus', { httpStatus: '200' }],
    ['a navigationOutcome outside the closed list', { navigationOutcome: 'REDIRECTED' }],
    ['a lower-case navigationOutcome', { navigationOutcome: 'ok' }],
  ])('rejects a viewport result with %s', async (_label, change) => {
    await expect(validateArtifact('page', {
      ...validPage,
      viewports: { ...validPage.viewports, desktop: { ...validPage.viewports.desktop, ...change } },
    })).resolves.toMatchObject({ ok: false });
  });
});

// P14a（Task 14〜17 の設計書 4.3.0）: ビューポートごとのナビゲーションの結果の種類。スキップしたビューポートでは null。
describe('P14a: navigation outcome per viewport', () => {
  const failedViewport = (navigationOutcome: 'TIMEOUT' | 'FAILED' | 'BLOCKED_EXTERNAL_REDIRECT') => ({
    ...validPage.viewports.desktop,
    finalUrl: null,
    httpStatus: null,
    status: 'FAILED',
    incompleteReasons: [{ code: 'NAVIGATION_FAILED', detail: navigationOutcome }],
    navigationOutcome,
  });

  it.each(['TIMEOUT', 'FAILED', 'BLOCKED_EXTERNAL_REDIRECT'] as const)(
    'accepts a failed viewport whose navigation outcome is %s, without a final URL or an HTTP status',
    async (navigationOutcome) => {
      await expect(validateArtifact('page', {
        ...validPage,
        status: 'FAILED',
        viewports: { ...validPage.viewports, mobile: failedViewport(navigationOutcome) },
      })).resolves.toEqual({ ok: true });
    },
  );

  it('accepts a skipped viewport whose navigation outcome is null', async () => {
    const skipped = {
      ...validPage.viewports.mobile,
      finalUrl: null,
      httpStatus: null,
      status: 'SKIPPED',
      incompleteReasons: [],
      navigationOutcome: null,
    };

    await expect(validateArtifact('page', { ...validPage, viewports: { desktop: skipped, mobile: skipped } }))
      .resolves.toEqual({ ok: true });
  });
});

describe('F08: Evidence shapes changed by R4 and the F07 findings', () => {
  const withEvidence = (...evidence: unknown[]) => ({ ...validPage, evidence });

  it('requires a scroll position object on COMPLETE accessibility Evidence and allows null only on PARTIAL (R4 M1)', async () => {
    await expect(validateArtifact('page', withEvidence(evidenceRecord('accessibility', 40, {
      ...partialAccessibilityPayload,
      scrollPosition: { scrollX: 0, scrollY: 120 },
    })))).resolves.toEqual({ ok: true });
    await expect(validateArtifact('page', withEvidence(evidenceRecord('accessibility', 41, {
      ...accessibilityPayload,
      scrollPosition: null,
    } as never)))).resolves.toMatchObject({ ok: false });
    await expect(validateArtifact('page', withEvidence(evidenceRecord(
      'accessibility',
      42,
      withoutKey(partialAccessibilityPayload, 'scrollPosition') as never,
    )))).resolves.toMatchObject({ ok: false });
  });

  it('records fields outside forms with their visibility and the omitted counts in DOM Evidence (R4 N2, F07 finding 3)', async () => {
    const [field] = domPayload.unassociatedFields;
    const [form] = domPayload.forms;
    const [formField] = form?.fields ?? [];
    if (field === undefined || form === undefined || formField === undefined) {
      throw new Error('The DOM sample must have a field outside forms and a form field');
    }
    await expect(validateArtifact('page', withEvidence(evidenceRecord('dom', 43, {
      ...domPayload,
      unassociatedFields: [withoutKey(field, 'visible')],
    } as never)))).resolves.toMatchObject({ ok: false });
    await expect(validateArtifact('page', withEvidence(evidenceRecord('dom', 44, {
      ...domPayload,
      forms: [{ ...form, fields: [withoutKey(formField, 'visible')] }],
    } as never)))).resolves.toMatchObject({ ok: false });
    for (const key of ['omittedUnassociatedFieldCount'] as const) {
      await expect(validateArtifact('page', withEvidence(evidenceRecord('dom', 45, {
        ...domPayload,
        truncation: withoutKey(domPayload.truncation, key),
      } as never))), key).resolves.toMatchObject({ ok: false });
      await expect(validateArtifact('page', withEvidence(evidenceRecord('dom', 46, {
        ...domPayload,
        truncation: { ...domPayload.truncation, [key]: -1 },
      } as never))), key).resolves.toMatchObject({ ok: false });
    }
    await expect(validateArtifact('page', withEvidence(evidenceRecord(
      'dom',
      47,
      withoutKey(domPayload, 'unassociatedFields') as never,
    )))).resolves.toMatchObject({ ok: false });
  });

  it('separates the node limit mark from the text truncation mark in DOM visible text (R4 M2)', async () => {
    await expect(validateArtifact('page', withEvidence(evidenceRecord('dom', 48, {
      ...domPayload,
      visibleText: { ...domPayload.visibleText, nodeLimitReached: true },
    })))).resolves.toEqual({ ok: true });
    await expect(validateArtifact('page', withEvidence(evidenceRecord('dom', 49, {
      ...domPayload,
      visibleText: withoutKey(domPayload.visibleText, 'nodeLimitReached'),
    } as never)))).resolves.toMatchObject({ ok: false });
  });

  it('accepts a layout result that stopped at the comparison limit, with its facts (R4 M2)', async () => {
    const limited = { ...layout, truncation: { ...layout.truncation, overlapComparisonLimitReached: true } };
    await expect(validateArtifact('page', withEvidence(evidenceRecord('layout', 50, {
      primary: { status: 'PARTIAL', reason: 'LAYOUT_COMPARISON_LIMIT_REACHED', layout: limited },
      stressSweep: [{ width: 320, height: 900, status: 'PARTIAL', reason: 'LAYOUT_COMPARISON_LIMIT_REACHED', layout: limited }],
    })))).resolves.toEqual({ ok: true });
  });

  it('uses the viewport profiles as the screenshot viewport (F07 finding 4)', async () => {
    const pageSchema = await readSchema('page');

    expect(schemaAt(pageSchema, ['$defs', 'screenshotEvidence', 'properties', 'viewport', 'enum'])).toEqual(VIEWPORT_PROFILES);
    await expect(validateArtifact('page', withEvidence(evidenceRecord('screenshot', 51, {
      ...screenshotPayload,
      viewport: 'mobile',
    })))).resolves.toEqual({ ok: true });
    await expect(validateArtifact('page', withEvidence(evidenceRecord('screenshot', 52, {
      ...screenshotPayload,
      viewport: 'tablet',
    } as never)))).resolves.toMatchObject({ ok: false });
  });
});

describe('R\'2 I-2: scroll Evidence', () => {
  const withScroll = (payload: unknown) => ({ ...validPage, evidence: [{ ...evidenceSamples.scroll, payload }] });

  it('lists scroll as an evidence type with its own identifier prefix', async () => {
    const pageSchema = await readSchema('page');

    expect(schemaAt(pageSchema, ['$defs', 'evidence', 'properties', 'type', 'enum'])).toContain('scroll');
    expect(createEvidenceId('scroll', 7)).toBe('EV-SCROLL-000007');
  });

  it('lists exactly the scroll incomplete reasons of the core constant as the PARTIAL reasons (F11)', async () => {
    const pageSchema = await readSchema('page');

    expect(schemaAt(pageSchema, ['$defs', 'scrollEvidence', 'oneOf', '1', 'properties', 'reason', 'enum']))
      .toEqual(SCROLL_INCOMPLETE_REASONS);
    for (const reason of SCROLL_INCOMPLETE_REASONS) {
      await expect(validateArtifact('page', withScroll({ ...partialScrollPayload, reason }))).resolves.toEqual({ ok: true });
    }
  });

  it('accepts a PARTIAL result without a final snapshot, an inner scan, or a restored origin', async () => {
    await expect(validateArtifact('page', withScroll(partialScrollPayload))).resolves.toEqual({ ok: true });
    await expect(validateArtifact('page', withScroll({
      ...partialScrollPayload,
      reason: 'INNER_SCROLL_CONTAINER_NOT_TRAVERSED',
      finalSnapshot: { ...scrollObservation, scrollTarget: null },
      restoration: { status: 'NOT_RESTORED', reason: 'POSITION_NOT_AT_ORIGIN', position: { scrollX: 0, scrollY: 40 } },
    }))).resolves.toEqual({ ok: true });
  });

  it.each([
    'status',
    'reason',
    'heightGrowthCount',
    'observations',
    'omittedObservationCount',
    'targetSwitchCount',
    'restoration',
    'innerScrollScan',
    'finalSnapshot',
  ])(
    'rejects a scroll result without %s',
    async (key) => {
      await expect(validateArtifact('page', withScroll(withoutKey(scrollPayload, key)))).resolves.toMatchObject({ ok: false });
    },
  );

  it.each(['scannedElementCount', 'scanLimitReached', 'containerCount', 'representative'])(
    'rejects an inner container scan without %s',
    async (key) => {
      await expect(validateArtifact('page', withScroll({
        ...scrollPayload,
        innerScrollScan: withoutKey(scrollPayload.innerScrollScan, key),
      }))).resolves.toMatchObject({ ok: false });
    },
  );

  it.each([
    'scrollTarget',
    'scrollY',
    'documentScrollRange',
    'bodyScrollRange',
    'atBottom',
  ])('rejects a scroll observation without %s', async (key) => {
    await expect(validateArtifact('page', withScroll({
      ...scrollPayload,
      finalSnapshot: withoutKey(scrollObservation, key),
    }))).resolves.toMatchObject({ ok: false });
    await expect(validateArtifact('page', withScroll({
      ...scrollPayload,
      observations: [withoutKey(scrollObservation, key)],
    }))).resolves.toMatchObject({ ok: false });
  });

  it.each([
    ['a COMPLETE result without a final snapshot', { ...scrollPayload, finalSnapshot: null }],
    ['a COMPLETE result with a partial reason', { ...scrollPayload, reason: 'SCROLL_NOT_ADVANCED' }],
    ['a PARTIAL result with a reason outside the scroll reasons', { ...partialScrollPayload, reason: 'NAVIGATION_FAILED' }],
    ['an unknown scroll target', { ...scrollPayload, finalSnapshot: { ...scrollObservation, scrollTarget: 'WINDOW' } }],
    ['a restoration without its position', { ...scrollPayload, restoration: { status: 'RESTORED' } }],
    ['a restoration reason outside the closed codes', {
      ...scrollPayload,
      restoration: { status: 'NOT_RESTORED', reason: 'SCROLL_NOT_ADVANCED', position: null },
    }],
    ['a negative omitted observation count', { ...scrollPayload, omittedObservationCount: -1 }],
    ['a fractional omitted observation count', { ...partialScrollPayload, omittedObservationCount: 0.5 }],
    ['a negative target switch count (F12)', { ...scrollPayload, targetSwitchCount: -1 }],
    ['a fractional target switch count (F12)', { ...partialScrollPayload, targetSwitchCount: 0.5 }],
    ['a fractional inner scan count', {
      ...scrollPayload,
      innerScrollScan: { ...scrollPayload.innerScrollScan, scannedElementCount: 1.5 },
    }],
  ])('rejects %s', async (_label, payload) => {
    await expect(validateArtifact('page', withScroll(payload))).resolves.toMatchObject({ ok: false });
  });
});

describe('R\'\'2 m4: truncation mark of each DOM document field', () => {
  const withDocumentFields = (documentFields: unknown) => ({
    ...validPage,
    evidence: [evidenceRecord('dom', 40, { ...domPayload, truncation: { ...domPayload.truncation, documentFields } } as never)],
  });

  it('accepts a truncation mark on the canonical URL only', async () => {
    await expect(validateArtifact('page', withDocumentFields({
      title: false,
      metaDescription: false,
      canonicalUrl: true,
      lang: false,
    }))).resolves.toEqual({ ok: true });
  });

  it('rejects the former single mark for all document fields', async () => {
    await expect(validateArtifact('page', withDocumentFields(true))).resolves.toMatchObject({ ok: false });
  });

  it.each(['title', 'metaDescription', 'canonicalUrl', 'lang'] as const)(
    'requires the truncation mark of %s',
    async (field) => {
      await expect(validateArtifact('page', withDocumentFields(withoutKey(domPayload.truncation.documentFields, field))))
        .resolves.toMatchObject({ ok: false });
    },
  );

  it('rejects an undeclared document field mark', async () => {
    await expect(validateArtifact('page', withDocumentFields({
      ...domPayload.truncation.documentFields,
      headings: false,
    }))).resolves.toMatchObject({ ok: false });
  });
});

// T12d0（Task 12・13 の設計書 5.4.1）: safety の Evidence。Safety Ledger の snapshot のうち、ページの事象の記録と
// 記録の上限の情報を持ち、不変条件の違反は持たない。
describe('T12d0: safety Evidence', () => {
  const withSafetyPayload = (payload: unknown) => ({
    ...validPage,
    evidence: [{ ...evidenceSamples.safety, payload }],
  });

  function ledgerWithEveryRecord(): SafetyLedger {
    const ledger = new SafetyLedger();
    ledger.recordBlockedRequest({ method: 'put', url: 'https://example.test/item', reason: 'NON_READ_METHOD' });
    ledger.recordBlockedNavigation({ method: 'GET', url: 'https://external.test/', reason: 'EXTERNAL_MAIN_FRAME_NAVIGATION' });
    ledger.recordBlockedWebSocket({ url: 'wss://example.test/socket', reason: 'PASSIVE_WEBSOCKET' });
    ledger.recordBlockedExternalAction({ candidateId: safetyCandidateId, url: null, reason: 'DOWNLOAD' });
    ledger.recordExcludedInteractionCandidate({ candidateId: safetyCandidateId, reason: 'NAVIGATION_HREF' });
    ledger.recordBlockedInteractionRequest({ method: 'POST', url: 'https://example.test/api', reason: 'INTERACTION_FROZEN' });
    ledger.recordBlockedInteractionNavigation({ method: 'GET', url: 'https://example.test/next', reason: 'INTERACTION_FROZEN' });
    ledger.recordBlockedPopup({ url: 'https://example.test/popup', reason: 'INTERACTION_FROZEN' });
    ledger.recordBlockedDownload({ url: 'https://example.test/file', suggestedFilename: 'file', reason: 'INTERACTION_FROZEN' });
    ledger.recordBlockedInteractionWebSocket({ url: 'wss://example.test/live', reason: 'INTERACTION_FROZEN' });
    ledger.recordExternalSchemeNavigation({
      url: 'mailto:nobody@example.invalid',
      scheme: 'mailto',
      frame: 'MAIN',
      phase: 'INTERACTION',
      reason: 'EXTERNAL_SCHEME_NAVIGATION',
    });
    // C18g: Guard がたどる前に止めた、外部スキームへのサーバのリダイレクト。
    ledger.recordExternalSchemeNavigation({
      url: 'beaksight-test-app:probe',
      scheme: 'beaksight-test-app',
      frame: 'SUB',
      phase: 'PASSIVE',
      reason: 'EXTERNAL_SCHEME_REDIRECT_BLOCKED',
    });
    ledger.recordInvariantViolation({ code: 'GUARD_FAILURE', message: 'guard failed' });
    return ledger;
  }

  it.each(['PASSIVE', 'INTERACTION'] as const)(
    'accepts the %s payload that safetyEventsEvidenceFromSnapshot builds from a Ledger snapshot',
    async (scope) => {
      const payload = safetyEventsEvidenceFromSnapshot(ledgerWithEveryRecord().snapshot(), scope);

      await expect(validateArtifact('page', withSafetyPayload(JSON.parse(JSON.stringify(payload)) as unknown)))
        .resolves.toEqual({ ok: true });
    },
  );

  it('accepts the payload of an empty Ledger', async () => {
    const payload = safetyEventsEvidenceFromSnapshot(new SafetyLedger().snapshot(), 'PASSIVE');

    await expect(validateArtifact('page', withSafetyPayload(JSON.parse(JSON.stringify(payload)) as unknown)))
      .resolves.toEqual({ ok: true });
  });

  it('rejects a payload that carries the invariant violations', async () => {
    await expect(validateArtifact('page', withSafetyPayload({ ...safetyPayload, invariantViolationCount: 0 })))
      .resolves.toMatchObject({ ok: false });
    await expect(validateArtifact('page', withSafetyPayload({ ...safetyPayload, invariantViolations: [] })))
      .resolves.toMatchObject({ ok: false });
  });

  it.each([
    ['a scope outside the closed list', { ...safetyPayload, scope: 'FROZEN' }],
    ['a negative method count', { ...safetyPayload, blockedRequestsByMethod: { POST: -1 } }],
    ['a fractional method count', { ...safetyPayload, blockedRequestsByMethod: { POST: 1.5 } }],
    ['a blocked request reason outside its closed list', {
      ...safetyPayload,
      blockedRequests: [{ method: 'POST', url: 'https://example.test/', reason: 'INTERACTION_FROZEN' }],
    }],
    ['a blocked navigation reason outside its closed list', {
      ...safetyPayload,
      blockedNavigations: [{ method: 'GET', url: 'https://external.test/', reason: 'NON_READ_METHOD' }],
    }],
    ['a blocked WebSocket reason outside its closed list', {
      ...safetyPayload,
      blockedWebSockets: [{ url: 'wss://example.test/', reason: 'INTERACTION_FROZEN' }],
    }],
    ['an excluded candidate reason outside the Interaction rejection reasons', {
      ...safetyPayload,
      excludedInteractionCandidates: [{ candidateId: safetyCandidateId, reason: 'UNSAFE' }],
    }],
    ['a frozen Interaction request reason outside its closed list', {
      ...safetyPayload,
      blockedInteractionRequests: [{ method: 'GET', url: 'https://example.test/', reason: 'NON_READ_METHOD' }],
    }],
    ['a frozen Interaction navigation reason outside its closed list', {
      ...safetyPayload,
      blockedInteractionNavigations: [{ method: 'GET', url: 'https://example.test/', reason: 'PASSIVE_WEBSOCKET' }],
    }],
    ['a popup reason outside its closed list', {
      ...safetyPayload,
      blockedPopups: [{ url: 'https://example.test/', reason: 'PASSIVE_DOWNLOAD' }],
    }],
    ['a download reason outside its closed list', {
      ...safetyPayload,
      blockedDownloads: [{ url: 'https://example.test/', suggestedFilename: 'file', reason: 'NON_READ_METHOD' }],
    }],
    ['a frozen Interaction WebSocket reason outside its closed list', {
      ...safetyPayload,
      blockedInteractionWebSockets: [{ url: 'wss://example.test/', reason: 'PASSIVE_WEBSOCKET' }],
    }],
    ['a blocked external action reason outside its closed list (CC-014)', {
      ...safetyPayload,
      blockedExternalActions: [{ candidateId: safetyCandidateId, url: null, reason: 'NAVIGATION_HREF' }],
    }],
    ['a blocked external action without a URL field', {
      ...safetyPayload,
      blockedExternalActions: [{ candidateId: safetyCandidateId, reason: 'EXTERNAL_ACTION' }],
    }],
    // C18a（DEF-012）: 外部スキームへの移動の試み。
    ['a Safety payload without the external scheme navigations', withoutKey(safetyPayload, 'externalSchemeNavigations')],
    ['an external scheme navigation frame outside its closed list', {
      ...safetyPayload,
      externalSchemeNavigations: [
        { url: 'tel:+10000000000', scheme: 'tel', frame: 'POPUP', phase: 'PASSIVE', reason: 'EXTERNAL_SCHEME_NAVIGATION' },
      ],
    }],
    ['an external scheme navigation phase outside its closed list', {
      ...safetyPayload,
      externalSchemeNavigations: [
        { url: 'tel:+10000000000', scheme: 'tel', frame: 'MAIN', phase: 'FROZEN', reason: 'EXTERNAL_SCHEME_NAVIGATION' },
      ],
    }],
    ['an external scheme navigation reason outside its closed list', {
      ...safetyPayload,
      externalSchemeNavigations: [
        { url: 'tel:+10000000000', scheme: 'tel', frame: 'MAIN', phase: 'PASSIVE', reason: 'EXTERNAL_ACTION' },
      ],
    }],
    ['an external scheme navigation without its scheme', {
      ...safetyPayload,
      externalSchemeNavigations: [
        { url: 'tel:+10000000000', frame: 'MAIN', phase: 'PASSIVE', reason: 'EXTERNAL_SCHEME_NAVIGATION' },
      ],
    }],
    ['an event with an undeclared field', {
      ...safetyPayload,
      blockedPopups: [{ url: 'https://example.test/', reason: 'INTERACTION_FROZEN', extra: true }],
    }],
    ['record limits without the truncation mark', {
      ...safetyPayload,
      recordLimits: withoutKey(safetyPayload.recordLimits, 'truncated'),
    }],
    ['a negative dropped event count', {
      ...safetyPayload,
      recordLimits: { ...safetyPayload.recordLimits, droppedEventCount: -1 },
    }],
  ] as const)('rejects %s', async (_case, payload) => {
    await expect(validateArtifact('page', withSafetyPayload(payload))).resolves.toMatchObject({ ok: false });
  });

  it('rejects safety Evidence whose evidenceId has the prefix of another Evidence type', async () => {
    await expect(validateArtifact('page', {
      ...validPage,
      evidence: [{ ...evidenceSamples.safety, evidenceId: 'EV-INTERACTION-000001' }],
    })).resolves.toMatchObject({ ok: false });
    await expect(validateArtifact('page', {
      ...validPage,
      evidence: [{ ...evidenceSamples.safety, evidenceId: 'EV-SAFETY-000001' }],
    })).resolves.toEqual({ ok: true });
  });
});

describe('R\'\'2 m2: evidenceId prefix of each Evidence type', () => {
  it('rejects scroll Evidence whose evidenceId has the prefix of DOM Evidence', async () => {
    await expect(validateArtifact('page', {
      ...validPage,
      evidence: [{ ...evidenceSamples.scroll, evidenceId: 'EV-DOM-000001' }],
    })).resolves.toMatchObject({ ok: false });
  });

  it.each(evidenceTypes)('rejects %s Evidence whose evidenceId has the prefix of any other Evidence type', async (type) => {
    for (const otherType of evidenceTypes.filter((candidate) => candidate !== type)) {
      await expect(validateArtifact('page', {
        ...validPage,
        evidence: [{ ...evidenceSamples[type], evidenceId: createEvidenceId(otherType, 1) }],
      }), `${type} with the prefix of ${otherType}`).resolves.toMatchObject({ ok: false });
    }
  });

  it.each(evidenceTypes)('accepts %s Evidence whose evidenceId has its own createEvidenceId prefix', async (type) => {
    await expect(validateArtifact('page', {
      ...validPage,
      evidence: [{ ...evidenceSamples[type], evidenceId: createEvidenceId(type, 1_234_567) }],
    })).resolves.toEqual({ ok: true });
  });
});

describe('C8: real collector output from local fixtures', () => {
  let browser: Browser;
  useHeadlessChromium((launched) => {
    browser = launched;
  });

  const viewport: Viewport = Object.freeze({ width: 1_024, height: 768 });

  async function collectPassiveEvidence(
    factory: BrowserContextFactory,
    server: FixtureServer,
    pathname: string,
    sequenceBase: number,
    screenshotDirectory: string,
  ): Promise<readonly EvidenceRecord[]> {
    const performanceCollector = new PerformanceCollector();
    let context: BrowserContext | undefined;
    let page: Page | undefined;
    try {
      context = await factory.createPassiveContext(viewport);
      await performanceCollector.installBeforeNavigation(context);
      page = await factory.createPassivePage(context);
      const network = NetworkCollector.attach(page);
      const consoleHandle = ConsoleCollector.attach(page);
      const url = `${server.origin}${pathname}`;
      await page.goto(url, { waitUntil: 'load' });
      const deadlineAtMs = Date.now() + 20_000;
      const scroll = await controlledScroll(page, { deadlineAtMs, ...SCHEMA_TEST_SCROLL_OPTIONS });
      const sourcePageId: PageId = pageId;
      const linkEvidence = await discoverLinks(page, sourcePageId, {
        allowedOrigins: new Set([server.origin]),
        allowedQueryParameters: new Set<string>(),
      });
      const dom = await collectDomEvidence(page, sourcePageId);
      const primary = await collectLayoutEvidence(page, viewport, { deadlineAtMs });
      const stressSweep = await collectStressLayout(async (stressViewport) => {
        const stressContext = await factory.createPassiveContext(stressViewport);
        const stressPage = await factory.createPassivePage(stressContext);
        return {
          page: stressPage,
          close: async () => {
            await factory.closePassivePage(stressPage);
            await factory.closePassiveContext(stressContext);
          },
        };
      }, url, [320], { deadlineAtMs });
      const color = await collectColorEvidence(page);
      const networkEvidence = await network.snapshot();
      const performance = await performanceCollector.collect(page, networkEvidence, { deadlineAtMs });
      const consoleEvidence = await consoleHandle.snapshot();
      const screenshots = await captureScreenshots(page, {
        pageId: sourcePageId,
        viewport: 'desktop',
        viewportCapture: {
          outputPath: join(screenshotDirectory, `${sequenceBase}-viewport.png`),
          relativeArtifactPath: `pages/${sequenceBase}/desktop/viewport.png`,
        },
        fullPageCapture: {
          outputPath: join(screenshotDirectory, `${sequenceBase}-full.png`),
          relativeArtifactPath: `pages/${sequenceBase}/desktop/full.png`,
        },
      });
      // DEF-001 の修正の後、axe はレガシーの方式（`setLegacyMode(true)`）で対象の page の中だけで実行され、別の page を開かないので、
      // Guard の付いた Passive の Context を無効にしない。検査の範囲は同じOriginの文書に限られる（`frameScope: 'SAME_ORIGIN_ONLY'`。DEF-001b）。
      const accessibility = await collectAccessibilityEvidence(page, { deadlineAtMs });
      return [
        evidenceRecord('network', sequenceBase + 1, networkEvidence),
        evidenceRecord('console', sequenceBase + 2, consoleEvidence),
        evidenceRecord('link', sequenceBase + 3, linkEvidence),
        evidenceRecord('dom', sequenceBase + 4, dom),
        evidenceRecord('layout', sequenceBase + 5, { primary, stressSweep }),
        evidenceRecord('color', sequenceBase + 6, color),
        evidenceRecord('accessibility', sequenceBase + 7, accessibility),
        evidenceRecord('performance', sequenceBase + 8, performance),
        ...screenshots.map((screenshot, index) => evidenceRecord('screenshot', sequenceBase + 9 + index, screenshot)),
        evidenceRecord('scroll', sequenceBase + 20, scroll),
      ];
    } finally {
      await closePassiveResources({ factory, context, page });
    }
  }

  it('accepts the Evidence that the collectors produce on the local fixture site', async () => {
    const server = await startFixtureServer();
    const screenshotDirectory = await mkdtemp(join(tmpdir(), 'beaksight-c8-schema-'));
    try {
      // Passive の Context ごとの Safety Ledger を残し、その snapshot から safety の Evidence を作る（T12d0）。
      const passiveLedgers: SafetyLedger[] = [];
      const factory = new BrowserContextFactory(browser, createTestConfig(server.origin), () => {
        const ledger = new SafetyLedger();
        passiveLedgers.push(ledger);
        return ledger;
      });
      const evidence: EvidenceRecord[] = [];
      const pathnames = ['/index.html', '/js-error.html', '/bad-contrast.html', '/element-overlap.html', '/post-form.html'];
      for (const [index, pathname] of pathnames.entries()) {
        const ledgerCountBefore = passiveLedgers.length;
        evidence.push(...await collectPassiveEvidence(factory, server, pathname, (index + 1) * 100, screenshotDirectory));
        const pageLedger = passiveLedgers[ledgerCountBefore];
        expect(pageLedger).toBeDefined();
        if (pageLedger !== undefined) {
          evidence.push(evidenceRecord(
            'safety',
            (index + 1) * 100 + 50,
            safetyEventsEvidenceFromSnapshot(pageLedger.snapshot(), 'PASSIVE'),
          ));
        }
      }

      const candidatesContext = await factory.createPassiveContext(viewport);
      const candidatesPage = await factory.createPassivePage(candidatesContext);
      let candidate;
      try {
        await candidatesPage.goto(`${server.origin}/accordion.html`, { waitUntil: 'load' });
        candidate = (await discoverInteractionCandidates(candidatesPage)).candidates
          .find((item) => item.accessibleName === 'Toggle details');
      } finally {
        await closePassiveResources({ factory, context: candidatesContext, page: candidatesPage });
      }
      expect(candidate).toBeDefined();
      if (candidate !== undefined) {
        const interaction = await auditInteraction({
          sessionFactory: (sessionViewport) => factory.createInteractionSession(sessionViewport),
          targetUrl: `${server.origin}/accordion.html`,
          candidate,
          viewport,
          navigationTimeoutMs: 5_000,
          timeoutMs: 2_000,
          deadlineAtMs: Date.now() + 5_000,
        });
        const { safety, ...interactionEvidence } = interaction;
        evidence.push(evidenceRecord('interaction', 900, interactionEvidence));
        evidence.push(evidenceRecord('safety', 901, safetyEventsEvidenceFromSnapshot(safety, 'INTERACTION')));
      }

      expect(new Set(evidence.map((record) => record.type))).toEqual(
        new Set(evidenceTypes.filter((type) => type !== 'metadata')),
      );
      const result = await validateArtifact('page', {
        ...validPage,
        evidence: JSON.parse(JSON.stringify(evidence)) as unknown,
      });
      expect(result).toEqual({ ok: true });
    } finally {
      await server.close();
      await rm(screenshotDirectory, { recursive: true, force: true });
    }
  }, 120_000);

  it('accepts the actual controlledScroll results, COMPLETE and PARTIAL, as scroll Evidence (R\'2 I-2)', async () => {
    const server = await startFixtureServer();
    try {
      const factory = new BrowserContextFactory(browser, createTestConfig(server.origin), () => new SafetyLedger());
      const results: EvidencePayloadByType['scroll'][] = [];
      for (const pathname of [
        '/lazy-content.html',
        '/body-scroll-late-growth.html',
        '/inner-scroll-container.html',
        '/shadow-scan-limit.html',
      ]) {
        const context = await factory.createPassiveContext(viewport);
        const page = await factory.createPassivePage(context);
        try {
          await page.goto(`${server.origin}${pathname}`, { waitUntil: 'domcontentloaded' });
          results.push(await controlledScroll(page, {
            deadlineAtMs: Date.now() + 10_000,
            ...SCHEMA_TEST_SCROLL_OPTIONS,
            stableWindowMs: 500,
          }));
        } finally {
          await closePassiveResources({ factory, context, page });
        }
      }

      expect(results.map((result) => result.status)).toEqual(['COMPLETE', 'COMPLETE', 'PARTIAL', 'COMPLETE']);
      expect(results.map((result) => result.innerScrollScan?.scanLimitReached)).toEqual([false, false, false, true]);
      const records = results.map((result, index) => evidenceRecord('scroll', 700 + index, result));
      await expect(validateArtifact('page', {
        ...validPage,
        evidence: JSON.parse(JSON.stringify(records)) as unknown,
      })).resolves.toEqual({ ok: true });
    } finally {
      await server.close();
    }
  }, 60_000);
});

// R15a（Task 14〜17 の設計書 5.6.2）: robots.txt と sitemap.xml の metadata の Evidence。
describe('R15a: site metadata Evidence', () => {
  const metadataRecord = (payload: unknown) => ({ ...evidenceSamples.metadata, viewport: null, payload });

  it('accepts robots.txt and sitemap.xml metadata Evidence without a viewport', async () => {
    await expect(validateArtifact('page', {
      ...validPage,
      evidence: [metadataRecord(metadataPayload), metadataRecord(sitemapMetadataPayload)],
    })).resolves.toEqual({ ok: true });
  });

  it.each([
    ['a missing sitemap', { ...sitemapMetadataPayload, outcome: 'NOT_FOUND', httpStatus: 404, text: null, sitemapUrls: null }],
    ['a failed robots.txt', { ...metadataPayload, outcome: 'FAILED', httpStatus: null, text: null }],
    ['a truncated sitemap', { ...sitemapMetadataPayload, textTruncated: true, sitemapUrlsTruncated: true }],
    ['a sitemap whose URLs were not read', { ...sitemapMetadataPayload, sitemapUrls: null }],
  ])('accepts %s', async (_label, payload) => {
    await expect(validateArtifact('page', { ...validPage, evidence: [metadataRecord(payload)] }))
      .resolves.toEqual({ ok: true });
  });

  it.each([
    ['the old source and value shape', { source: 'robots.txt', value: 'User-agent: *' }],
    ['an unknown kind', { ...metadataPayload, kind: 'HUMANS_TXT' }],
    ['an unknown outcome', { ...metadataPayload, outcome: 'REDIRECTED' }],
    ['a fractional httpStatus', { ...metadataPayload, httpStatus: 200.5 }],
    ['robots.txt with sitemap URLs', { ...metadataPayload, sitemapUrls: [] }],
    ['robots.txt with truncated sitemap URLs', { ...metadataPayload, sitemapUrlsTruncated: true }],
    ['truncated text without text', { ...metadataPayload, text: null, textTruncated: true }],
    ['truncated sitemap URLs without URLs', { ...sitemapMetadataPayload, sitemapUrls: null, sitemapUrlsTruncated: true }],
    ['sitemap URLs of a missing sitemap', { ...sitemapMetadataPayload, outcome: 'NOT_FOUND', httpStatus: 404 }],
    ['a non-string sitemap URL', { ...sitemapMetadataPayload, sitemapUrls: [1] }],
    ['an undeclared field', { ...metadataPayload, extra: 1 }],
  ])('rejects metadata Evidence with %s', async (_label, payload) => {
    await expect(validateArtifact('page', { ...validPage, evidence: [metadataRecord(payload)] }))
      .resolves.toMatchObject({ ok: false });
  });

  it.each(['kind', 'url', 'outcome', 'httpStatus', 'text', 'textTruncated', 'sitemapUrls', 'sitemapUrlsTruncated'])(
    'rejects metadata Evidence without %s',
    async (key) => {
      await expect(validateArtifact('page', {
        ...validPage,
        evidence: [metadataRecord(withoutKey(sitemapMetadataPayload, key))],
      })).resolves.toMatchObject({ ok: false });
    },
  );
});

// R15a（Task 14〜17 の設計書 5.6.4、5.6.5）: RunSummary の追加（PARTIAL のページの数、検証できなかった内部リンクの数、再試行の記録）。
describe('R15a: run summary counts and retries', () => {
  const [retry] = validRun.retries;

  it('accepts a run summary without retries', async () => {
    await expect(validateArtifact('run', { ...validRun, retries: [] })).resolves.toEqual({ ok: true });
  });

  it.each([
    ['a negative partial page count', { partialPageCount: -1 }],
    ['a fractional unverified internal link count', { unverifiedInternalLinkCount: 0.5 }],
    ['retries that are not an array', { retries: {} }],
    ['a retry with attempt 0', { retries: [{ ...retry, attempt: 0 }] }],
    ['a retry with a fractional attempt', { retries: [{ ...retry, attempt: 1.5 }] }],
    ['a retry with an unknown navigation outcome', { retries: [{ ...retry, navigationOutcome: 'REFUSED' }] }],
    ['a retry without a navigation outcome', { retries: [{ ...retry, navigationOutcome: null }] }],
    ['a retry with an empty URL', { retries: [{ ...retry, url: '' }] }],
    ['a retry with a numeric detail', { retries: [{ ...retry, detail: 1 }] }],
    ['a retry with an undeclared field', { retries: [{ ...retry, extra: 1 }] }],
    ['a retry whose evidenceIds are not an array', { retries: [{ ...retry, evidenceIds: 'EV-SAFETY-000003' }] }],
    ['a retry with a malformed Evidence ID', { retries: [{ ...retry, evidenceIds: ['SAFETY-3'] }] }],
  ])('rejects a run summary with %s', async (_label, change) => {
    await expect(validateArtifact('run', { ...validRun, ...change })).resolves.toMatchObject({ ok: false });
  });

  it('accepts a retry without Evidence of the first attempt (an empty evidenceIds)', async () => {
    await expect(validateArtifact('run', { ...validRun, retries: [{ ...retry, evidenceIds: [] }] })).resolves.toEqual({ ok: true });
  });

  it.each(['url', 'attempt', 'navigationOutcome', 'detail', 'evidenceIds'])('rejects a retry without %s', async (key) => {
    await expect(validateArtifact('run', { ...validRun, retries: [withoutKey(retry as object, key)] }))
      .resolves.toMatchObject({ ok: false });
  });
});

// R15a（Task 14〜17 の設計書 5.6.1）: 確定した Run（`AuditRunResult`）は、audit.schema.json の最上位の run・pages・findings と合う。
// U16b（設計書 6.1.1）: メモリの上だけの `statusInput` は、audit.json に書かない。
describe('R15a: the confirmed run and the audit schema', () => {
  it('matches the top level of the audit schema except the schema version of the artifact and the in-memory Run Status input', async () => {
    const auditRun = { run: validRun, pages: [validPage], findings: [validFinding] } satisfies Omit<AuditRunResult, 'statusInput'>;
    const auditSchema = await readSchema('audit');

    expect(schemaAt(auditSchema, ['required'])).toEqual(['schemaVersion', ...Object.keys(auditRun)]);
    expect(Object.keys(schemaAt(auditSchema, ['properties']) as object)).toEqual(['schemaVersion', ...Object.keys(auditRun)]);
    await expect(validateArtifact('audit', { schemaVersion: 'audit-schema/1.0', ...auditRun })).resolves.toEqual({ ok: true });
  });
});
