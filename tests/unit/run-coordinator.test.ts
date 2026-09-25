// R15d（Task 14〜17 の設計書 5.6、実装計画 Task 15 の Step 1）: Run Coordinator の BFS、上限、再試行、Run Status の入力。
// 偽の Page Auditor、偽の PREFLIGHT、偽の環境の事実、偽の metadata の取得を使い、Browser は起動しない。
// Run のディレクトリは、Run Coordinator が実際に作る（DEF-009）。出力先は、ハーネスごとに、一時ディレクトリの下の別の場所にする。
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { evaluateCrossPageRules } from '../../src/audit/cross-page-rules.js';
import type { BrowserContextFactory, SafetyLedgerFactory } from '../../src/browser/context-factory.js';
import type { AuditConfig } from '../../src/config/types.js';
import { runArtifactDirectory } from '../../src/core/artifact-layout.js';
import {
  VIEWPORT_PROFILES,
  type EvidenceRecord,
  type Finding,
  type IncompleteReason,
  type PageAuditOutcome,
  type PageAuditResult,
  type PageId,
  type RunEnvironment,
  type ViewportAuditResult,
  type ViewportProfile,
} from '../../src/core/contracts.js';
import {
  INTERACTION_REASON_CODES_BY_STATUS,
  type InteractionCandidateEvidence,
  type InteractionChangeEvidence,
  type InteractionEvidence,
  type InteractionNotVerifiableKind,
  type LinkEvidence,
  type NavigationOutcomeKind,
  type NormalizedHttpUrlEvidence,
} from '../../src/core/evidence-types.js';
import { createFindingId, createSha256Fingerprint } from '../../src/core/ids.js';
import { BROWSER_CLOSE_TIMEOUT_MS, CONTEXT_CLOSE_TIMEOUT_MS } from '../../src/core/limits.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import { derivePageAuditStatus, deriveRunStatus } from '../../src/core/status.js';
import { classifyUrl } from '../../src/crawl/admission-policy.js';
import { normalizeUrl } from '../../src/crawl/normalize-url.js';
import type { collectSiteMetadata, SiteMetadataResult } from '../../src/crawl/site-metadata.js';
import type { collectRunEnvironment } from '../../src/orchestration/environment.js';
import { createEvidenceRecord } from '../../src/orchestration/evidence-builder.js';
import type { PageAuditAttempt, PageAuditorDependencies } from '../../src/orchestration/page-auditor.js';
import {
  PASSIVE_CONTEXT_CLOSE_DEADLINE_MESSAGE,
  PassiveContextCloseDeadlineError,
  type PassiveSessionCloseFailure,
} from '../../src/orchestration/passive-session-close.js';
import type { PassiveSessionDeadlineOptions } from '../../src/orchestration/passive-session-open.js';
import {
  BROWSER_CLOSE_DEADLINE_MESSAGE,
  type PreflightFailure,
  type PreflightResult,
  type runPreflight,
} from '../../src/orchestration/preflight.js';
import {
  RETRYABLE_NAVIGATION_FAILURE_DETAILS,
  RunCoordinator,
  RunDirectoryUnavailableError,
  type RunCoordinatorDependencies,
  type RunPageAuditor,
} from '../../src/orchestration/run-coordinator.js';
import { safetyEventsEvidenceFromSnapshot, SafetyLedger, summarizePageSafety } from '../../src/safety/safety-ledger.js';
import { createTestConfig, type TestConfigOverrides } from '../helpers/test-config.js';

// Cross-page rule の失敗と例外を再現するため、評価の関数だけを差し替えられるようにする（既定は本物の関数）。
vi.mock(import('../../src/audit/cross-page-rules.js'), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, evaluateCrossPageRules: vi.fn(actual.evaluateCrossPageRules) };
});

const ORIGIN = 'http://127.0.0.1:4173';
const START_PATH = '/index.html';
const STARTED_AT = new Date('2026-09-24T01:02:03.000Z');
/** Browser を閉じる期限のテストで注入する、短い期限（実際の時間を待つのは、これだけにする。R15r-4）。 */
const SHORT_BROWSER_CLOSE_TIMEOUT_MS = 100;

/** ハーネスの出力先を置く一時ディレクトリ（テストの後に消す）。 */
let workDirectory: string;
let harnessCount = 0;

beforeAll(async () => {
  workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-run-coordinator-'));
});

afterAll(async () => {
  await rm(workDirectory, { recursive: true, force: true });
});
/** 偽のページの監査1回で進む時間（既定）。 */
const DEFAULT_AUDIT_DURATION_MS = 10;

// ---------------------------------------------------------------------------------------------------------------
// 偽のサイトと、偽の Page Auditor
// ---------------------------------------------------------------------------------------------------------------

/** 1回の試行のナビゲーション。省略すると `OK`（HTTP 200）。 */
interface AttemptSpec {
  readonly outcome: NavigationOutcomeKind;
  /** `OK` の場合の HTTP ステータス。 */
  readonly httpStatus?: number;
  /** `OK` 以外の場合の、`NAVIGATION_FAILED` の detail。 */
  readonly detail?: string;
}

interface InteractionSpec {
  readonly status: InteractionEvidence['status'];
  readonly notVerifiableKind?: InteractionNotVerifiableKind;
}

interface FakePageSpec {
  /** 文書の順のリンク（パスか、絶対 URL か、`mailto:` など）。 */
  readonly links?: readonly string[];
  /** 試行ごとのナビゲーション。足りない試行は `OK`。 */
  readonly attempts?: readonly AttemptSpec[];
  readonly interactions?: readonly InteractionSpec[];
  /** Page の Ledger に記録する、不変条件の違反の数。 */
  readonly violations?: number;
  /** Page の Ledger に記録する、遮断した POST の数。 */
  readonly blockedPosts?: number;
  /** Desktop のビューポートを PARTIAL にする。 */
  readonly partial?: boolean;
  /** ページの Finding を1つ作る。 */
  readonly finding?: boolean;
  /** 監査の呼び出しで例外を投げる（Desktop の Ledger に `violations` と `blockedPosts` を記録してから投げる）。 */
  readonly throws?: boolean;
  /** 2回目以降の試行（再試行）で、例外を投げる。 */
  readonly throwsOnRetry?: boolean;
  /** ページの結果に、スキーマにない項目を加える（page のスキーマに合わない結果にする）。 */
  readonly schemaInvalid?: boolean;
  /** 監査1回で進む時間。 */
  readonly durationMs?: number;
}

type FakeSite = Readonly<Record<string, FakePageSpec>>;

const urlOf = (path: string): NormalizedHttpUrlEvidence => {
  const normalized = normalizeUrl(path, `${ORIGIN}/`, new Set());
  if (!normalized.ok) {
    throw new Error(`test URL must be normalizable: ${path}`);
  }
  return normalized.url;
};

const pathOf = (url: string): string => new URL(url).pathname;

const linkEvidence = (pageId: PageId, pageUrl: string, href: string): LinkEvidence => {
  const normalized = normalizeUrl(href, pageUrl, new Set());
  return {
    sourcePageId: pageId,
    anchorText: href,
    ariaLabel: null,
    title: null,
    rawHref: href,
    normalized,
    admission: normalized.ok
      ? classifyUrl(new URL(normalized.url), { allowedOrigins: new Set([ORIGIN]) })
      : { kind: 'SPECIAL_SCHEME_RECORD_ONLY', rawUrl: href, scheme: href.split(':', 1)[0] ?? '' },
    truncated: false,
  };
};

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

const unchangedInteraction = {
  before: interactionCandidate,
  after: interactionCandidate,
  identityStatus: 'MATCHED',
  changedFields: [],
  changedAttributes: [],
  changedAttributesTruncated: false,
  detailsOpenBefore: null,
  detailsOpenAfter: null,
} satisfies InteractionChangeEvidence;

// C18n: 理由は status に合うコード（一覧の最初のコード）、詳細は `test <status>`。
const interactionPayload = (spec: InteractionSpec): InteractionEvidence => ({
  candidateId: interactionCandidate.candidateId,
  status: spec.status,
  reason: INTERACTION_REASON_CODES_BY_STATUS[spec.status][0],
  reasonDetail: `test ${spec.status}`,
  evidence: unchangedInteraction,
  work: {
    status: spec.status,
    reason: INTERACTION_REASON_CODES_BY_STATUS[spec.status][0],
    reasonDetail: `test ${spec.status}`,
    evidence: unchangedInteraction,
  },
  lifecycle: { status: 'CLOSED', reason: null, reasonDetail: null },
  notVerifiableKind: spec.status === 'NOT_VERIFIABLE' ? spec.notVerifiableKind ?? 'OBSERVED_NO_CHANGE' : null,
});

interface AuditCall {
  readonly url: NormalizedHttpUrlEvidence;
  readonly pageId: PageId;
  /** Run Coordinator が渡した、再試行を区別する情報（DEF-007）。 */
  readonly attempt: PageAuditAttempt | undefined;
}

interface FakeWorld {
  nowMs: number;
  readonly auditCalls: AuditCall[];
  readonly createdAuditors: PageAuditorDependencies[];
  /** 偽の Page Auditor が返した結果（呼び出しの順）。 */
  readonly auditOutcomes: PageAuditOutcome[];
  /**
   * Coordinator が PREFLIGHT に渡した Ledger の factory。本番では、Context の factory がこれで Ledger を作るので、偽の環境の事実、
   * 偽の metadata の取得、偽の Page Auditor も、これで Ledger を作る。
   */
  createSafetyLedger: SafetyLedgerFactory | null;
  /** 偽の PREFLIGHT が呼ばれた時点で、渡された Run のディレクトリがあったか（呼ばれていなければ `null`。DEF-009）。 */
  runDirectoryExistedAtPreflight: boolean | null;
  /**
   * 偽の Page Auditor が、Desktop の Ledger に記録した後に、注入された違反の確かめ（`safetyViolationRecorded`）を呼んだ結果
   * （呼び出しの順。C18f）。本物の Page Auditor が、次のビューポートの前に確かめるのと同じ時点である。
   */
  readonly safetyChecks: boolean[];
}

/** Coordinator が PREFLIGHT に渡した factory で、Ledger を作る（本番の Context の factory と同じ経路）。 */
function ledgerFrom(world: FakeWorld): SafetyLedger {
  if (world.createSafetyLedger === null) {
    throw new Error('the fake PREFLIGHT has not received the Safety Ledger factory');
  }
  return world.createSafetyLedger();
}

const recordViolations = (ledger: SafetyLedger, count: number, code: string): void => {
  for (let index = 0; index < count; index += 1) {
    ledger.recordInvariantViolation({ code, message: `${code} ${index}` });
  }
};

const recordBlockedPosts = (ledger: SafetyLedger, count: number, url: string): void => {
  for (let index = 0; index < count; index += 1) {
    ledger.recordBlockedRequest({ method: 'POST', url, reason: 'NON_READ_METHOD' });
  }
};

/** 偽の Page Auditor。Evidence と Finding の ID は、注入された採番器で採番する（本物の Page Auditor と同じ）。 */
function fakePageAuditorFactory(site: FakeSite, world: FakeWorld): (deps: PageAuditorDependencies) => RunPageAuditor {
  return (deps) => {
    world.createdAuditors.push(deps);
    const attemptsByUrl = new Map<string, number>();
    return {
      audit: async (url, pageId, auditAttempt) => {
        world.auditCalls.push({ url, pageId, attempt: auditAttempt });
        const spec = site[pathOf(url)] ?? {};
        world.nowMs += spec.durationMs ?? DEFAULT_AUDIT_DURATION_MS;
        const attempt = attemptsByUrl.get(url) ?? 0;
        attemptsByUrl.set(url, attempt + 1);
        if (spec.throws === true || (spec.throwsOnRetry === true && attempt > 0)) {
          // 本物の Page Auditor と同じく、Context の Ledger に記録した後で例外が起きる場合（その Ledger は結果として返らない）。
          const ledger = ledgerFrom(world);
          recordViolations(ledger, spec.violations ?? 0, 'TEST_VIOLATION');
          recordBlockedPosts(ledger, spec.blockedPosts ?? 0, url);
          throw new Error(`fake audit failure for ${url}`);
        }
        const navigation: AttemptSpec = spec.attempts?.[attempt] ?? { outcome: 'OK' };
        const context = { allocator: deps.allocator, clock: deps.clock };
        const evidence: EvidenceRecord[] = [];
        const record = <T extends EvidenceRecord>(created: T): T => {
          evidence.push(created);
          return created;
        };
        const ledgers: SafetyLedger[] = [];
        const viewports = {} as Record<ViewportProfile, ViewportAuditResult>;
        for (const profile of VIEWPORT_PROFILES) {
          const reasons: IncompleteReason[] = [];
          if (navigation.outcome === 'OK' && profile === 'desktop') {
            record(createEvidenceRecord({
              type: 'link',
              pageId,
              viewport: profile,
              payload: { links: (spec.links ?? []).map((href) => linkEvidence(pageId, url, href)), omittedLinkCount: 0 },
            }, context));
            for (const interaction of spec.interactions ?? []) {
              record(createEvidenceRecord({ type: 'interaction', pageId, viewport: profile, payload: interactionPayload(interaction) }, context));
            }
            if (spec.partial === true) {
              reasons.push({ code: 'COLLECTOR_INCOMPLETE', detail: 'dom:EVALUATION_FAILED' });
            }
          }
          if (navigation.outcome !== 'OK') {
            reasons.push({ code: 'NAVIGATION_FAILED', detail: navigation.detail ?? navigation.outcome });
          }
          const ledger = ledgerFrom(world);
          if (profile === 'desktop') {
            recordViolations(ledger, spec.violations ?? 0, 'TEST_VIOLATION');
            recordBlockedPosts(ledger, spec.blockedPosts ?? 0, url);
            world.safetyChecks.push(deps.safetyViolationRecorded());
          }
          ledgers.push(ledger);
          record(createEvidenceRecord({
            type: 'safety',
            pageId,
            viewport: profile,
            payload: safetyEventsEvidenceFromSnapshot(ledger.snapshot(), 'PASSIVE'),
          }, context));
          viewports[profile] = {
            requestedUrl: url,
            finalUrl: navigation.outcome === 'OK' ? url : null,
            httpStatus: navigation.outcome === 'OK' ? navigation.httpStatus ?? 200 : null,
            status: navigation.outcome !== 'OK' ? 'FAILED' : reasons.length > 0 ? 'PARTIAL' : 'AUDITED',
            incompleteReasons: reasons,
            navigationOutcome: navigation.outcome,
          };
        }
        const findings: Finding[] = [];
        // Finding は、その試行の最初の Evidence を参照する（ナビゲーションが失敗した試行でも作る）。
        const [firstEvidence] = evidence;
        if (spec.finding === true && firstEvidence !== undefined) {
          const sequence = deps.allocator.nextFindingSequence;
          findings.push({
            schemaVersion: 'finding-schema/1.0',
            findingId: createFindingId(sequence),
            fingerprint: createSha256Fingerprint(`finding:${url}`),
            ruleId: 'TEST_PAGE_RULE',
            ruleVersion: 1,
            category: 'HTTP',
            severity: 'ERROR',
            pageId,
            pageUrl: url,
            viewport: 'desktop',
            message: 'テストの Finding',
            evidenceRefs: [firstEvidence.evidenceId],
          });
          deps.allocator.advanceFindingSequence(sequence + 1);
        }
        const reasonKeys = new Set<string>();
        const result: PageAuditResult & { readonly unexpectedField?: true } = {
          schemaVersion: 'page-schema/1.0',
          pageId,
          pageUrl: url,
          status: derivePageAuditStatus(VIEWPORT_PROFILES.map((profile) => viewports[profile].status)),
          viewports,
          evidence,
          findings,
          incompleteReasons: VIEWPORT_PROFILES.flatMap((profile) => viewports[profile].incompleteReasons).filter((reason) => {
            const key = JSON.stringify([reason.code, reason.detail]);
            return reasonKeys.has(key) ? false : (reasonKeys.add(key), true);
          }),
          ...(spec.schemaInvalid === true ? { unexpectedField: true } : {}),
        };
        const outcome: PageAuditOutcome = { result, safety: summarizePageSafety(ledgers.map((ledger) => ledger.snapshot())) };
        world.auditOutcomes.push(outcome);
        return outcome;
      },
    };
  };
}

// ---------------------------------------------------------------------------------------------------------------
// 偽の PREFLIGHT、環境の事実、metadata の取得
// ---------------------------------------------------------------------------------------------------------------

const ENVIRONMENT: RunEnvironment = Object.freeze({
  nodeVersion: 'v24.0.0',
  platform: 'test',
  osRelease: 'test',
  arch: 'x64',
  playwrightVersion: '1.0.0',
  chromiumVersion: '140.0.0.0',
  userAgents: Object.freeze({ desktop: 'test-agent-desktop', mobile: 'test-agent-mobile' }),
});

interface HarnessOptions {
  readonly site: FakeSite;
  readonly config?: TestConfigOverrides;
  readonly preflightOk?: boolean;
  /** PREFLIGHT が失敗する場合の、失敗した項目（既定は `BROWSER_LAUNCH`）。 */
  readonly preflightFailedCheck?: PreflightFailure['failedCheck'];
  /** PREFLIGHT の Ledger に記録する、不変条件の違反の数。 */
  readonly preflightViolations?: number;
  /** PREFLIGHT の Ledger に記録する、遮断した POST の数。 */
  readonly preflightBlockedPosts?: number;
  /** 環境の事実の Ledger（Desktop の User-Agent の読み取りの Context）に記録する、不変条件の違反の数。 */
  readonly environmentViolations?: number;
  /** metadata の取得の Ledger に記録する、不変条件の違反の数。 */
  readonly metadataViolations?: number;
  /** metadata の取得に使った page を閉じる処理が失敗する。 */
  readonly metadataPageCloseFails?: boolean;
  readonly browserCloseFails?: boolean;
  /** Browser を閉じる処理が終わらない（R15 の Minor-2）。 */
  readonly browserCloseHangs?: boolean;
  readonly sitemapUrls?: readonly string[];
  /** 出力先の根。省略すると、ハーネスごとに、一時ディレクトリの下の新しい場所にする（まだ作らない）。 */
  readonly outputDirectory?: string;
  /** Run Coordinator に注入する、Browser を閉じる期限（ms）。省略すると既定値（`BROWSER_CLOSE_TIMEOUT_MS`）。 */
  readonly browserCloseTimeoutMs?: number;
  /** 偽の環境の事実の収集が、`onCloseFailure` に渡す、閉じる処理の失敗（RP18 の指摘1）。 */
  readonly environmentCloseFailures?: readonly PassiveSessionCloseFailure[];
  /** Run Coordinator に注入する、Context と page の作成・終了の期限（RP18 の指摘2）。省略すると既定値。 */
  readonly deadlines?: PassiveSessionDeadlineOptions;
  /**
   * 指定すると、偽の PREFLIGHT がこの Context の factory を返し、環境の事実は本物の `collectRunEnvironment` で集める
   * （RP18 の指摘1・2。作成か終了が終わらない偽の factory で、Run 全体が期限の中で確定することを確かめる）。
   */
  readonly realEnvironmentFactory?: BrowserContextFactory;
}

interface Harness {
  readonly coordinator: RunCoordinator;
  readonly config: AuditConfig;
  readonly world: FakeWorld;
  /** 出力先の根。 */
  readonly outputDirectory: string;
  readonly launchBrowser: ReturnType<typeof vi.fn>;
  readonly browserClose: ReturnType<typeof vi.fn>;
  readonly preflight: ReturnType<typeof vi.fn>;
  readonly environment: ReturnType<typeof vi.fn>;
  readonly metadata: ReturnType<typeof vi.fn>;
}

function createHarness(options: HarnessOptions): Harness {
  const config = createTestConfig(ORIGIN, START_PATH, options.config);
  const world: FakeWorld = {
    nowMs: 1_000_000,
    auditCalls: [],
    createdAuditors: [],
    auditOutcomes: [],
    createSafetyLedger: null,
    runDirectoryExistedAtPreflight: null,
    safetyChecks: [],
  };
  harnessCount += 1;
  const outputDirectory = options.outputDirectory ?? join(workDirectory, `harness-${String(harnessCount)}`);
  const browserClose = vi.fn(async () => {
    if (options.browserCloseHangs === true) {
      await new Promise<never>(() => undefined);
    }
    if (options.browserCloseFails === true) {
      throw new Error('browser close failed');
    }
  });
  const browser = { close: browserClose, version: () => ENVIRONMENT.chromiumVersion } as unknown as Browser;
  const launchBrowser = vi.fn(async () => browser);
  const preflight = vi.fn(async (preflightOptions: Parameters<typeof runPreflight>[0]): Promise<PreflightResult> => {
    world.runDirectoryExistedAtPreflight = existsSync(preflightOptions.outputDirectory);
    // 本番の PREFLIGHT は、渡された factory で Context の factory を作る。以後の Ledger は、すべてこの factory で作る。
    world.createSafetyLedger = preflightOptions.createSafetyLedger;
    const ledger = ledgerFrom(world);
    recordViolations(ledger, options.preflightViolations ?? 0, 'PREFLIGHT_VIOLATION');
    recordBlockedPosts(ledger, options.preflightBlockedPosts ?? 0, `${ORIGIN}/preflight`);
    if (options.preflightOk === false) {
      const failedCheck = options.preflightFailedCheck ?? 'BROWSER_LAUNCH';
      return {
        ok: false,
        failedCheck,
        message: `${failedCheck} failed`,
        reason: { code: 'PREFLIGHT_FAILED', detail: failedCheck },
        safetyLedgers: [ledger],
      };
    }
    return { ok: true, browser, factory: options.realEnvironmentFactory ?? ({} as BrowserContextFactory), safetyLedgers: [ledger] };
  });
  const environment = vi.fn(async (environmentOptions: Parameters<typeof collectRunEnvironment>[0]): Promise<RunEnvironment> => {
    // 本番と同じく、Browser がある場合だけ、ビューポートごとに Context を作って User-Agent を読む。
    if (environmentOptions.browser !== null) {
      for (const profile of VIEWPORT_PROFILES) {
        const ledger = ledgerFrom(world);
        recordViolations(ledger, profile === 'desktop' ? options.environmentViolations ?? 0 : 0, 'ENVIRONMENT_VIOLATION');
        environmentOptions.onSafetyLedger(ledger);
      }
      // 本番と同じく、閉じる処理の失敗は、受け取る口に渡す（RP18 の指摘1）。
      for (const failure of options.environmentCloseFailures ?? []) {
        environmentOptions.onCloseFailure(failure);
      }
    }
    return ENVIRONMENT;
  });
  const metadata = vi.fn(async (metadataOptions: Parameters<typeof collectSiteMetadata>[0]): Promise<SiteMetadataResult> => {
    const ledger = ledgerFrom(world);
    recordViolations(ledger, options.metadataViolations ?? 0, 'METADATA_VIOLATION');
    const context = { allocator: metadataOptions.allocator, clock: metadataOptions.clock };
    const robots = createEvidenceRecord({
      type: 'metadata',
      pageId: metadataOptions.pageId,
      viewport: null,
      payload: {
        kind: 'ROBOTS_TXT',
        url: `${metadataOptions.origin}/robots.txt`,
        outcome: 'NOT_FOUND',
        httpStatus: 404,
        text: null,
        textTruncated: false,
        sitemapUrls: null,
        sitemapUrlsTruncated: false,
      },
    }, context);
    const sitemapUrls = options.sitemapUrls?.map(urlOf) ?? null;
    const sitemap = createEvidenceRecord({
      type: 'metadata',
      pageId: metadataOptions.pageId,
      viewport: null,
      payload: {
        kind: 'SITEMAP_XML',
        url: `${metadataOptions.origin}/sitemap.xml`,
        outcome: sitemapUrls === null ? 'NOT_FOUND' : 'OK',
        httpStatus: sitemapUrls === null ? 404 : 200,
        text: sitemapUrls === null ? null : '<urlset></urlset>',
        textTruncated: false,
        sitemapUrls,
        sitemapUrlsTruncated: false,
      },
    }, context);
    return {
      records: [robots, sitemap],
      sitemap: sitemapUrls === null ? null : { evidenceId: sitemap.evidenceId, urls: sitemapUrls, truncated: false },
      unnormalizableSitemapUrlCount: 0,
      failures: [],
      ledgerSnapshot: ledger.snapshot(),
      closeFailures: options.metadataPageCloseFails === true ? [{ step: 'page', error: new Error('metadata page close failed') }] : [],
    };
  });
  const dependencies: RunCoordinatorDependencies = {
    config,
    launchBrowser,
    createSafetyLedger: () => new SafetyLedger(),
    clock: () => STARTED_AT,
    now: () => world.nowMs,
    outputDirectory,
    createPageAuditor: fakePageAuditorFactory(options.site, world),
    collectSiteMetadata: metadata as unknown as typeof collectSiteMetadata,
    runPreflight: preflight as unknown as typeof runPreflight,
    ...(options.realEnvironmentFactory === undefined
      ? { collectRunEnvironment: environment as unknown as typeof collectRunEnvironment }
      : {}),
    readToolVersion: async () => '0.1.0-test',
    ...(options.browserCloseTimeoutMs === undefined ? {} : { browserCloseTimeoutMs: options.browserCloseTimeoutMs }),
    ...(options.deadlines === undefined ? {} : { deadlines: options.deadlines }),
  };
  return {
    coordinator: new RunCoordinator(dependencies),
    config,
    world,
    outputDirectory,
    launchBrowser,
    browserClose,
    preflight,
    environment,
    metadata,
  };
}

/** `count` 個のページ（開始のページと、そこからリンクする `count - 1` 個のページ）。どのページも Finding を1つ持つ。 */
function starSite(count: number, extra: FakePageSpec = {}): FakeSite {
  const leaves = Array.from({ length: count - 1 }, (_, index) => `/page-${String(index + 1).padStart(3, '0')}.html`);
  return Object.fromEntries([
    [START_PATH, { links: leaves, finding: true, ...extra }],
    ...leaves.map((path) => [path, { links: [START_PATH], finding: true, ...extra }]),
  ]);
}

const codesOf = (reasons: readonly IncompleteReason[]): string[] => reasons.map(({ code }) => code);

async function expectValidRun(result: Awaited<ReturnType<RunCoordinator['run']>>): Promise<void> {
  await expect(validateArtifact('run', result.run)).resolves.toEqual({ ok: true });
  for (const page of result.pages) {
    await expect(validateArtifact('page', page)).resolves.toEqual({ ok: true });
  }
  for (const finding of result.findings) {
    await expect(validateArtifact('finding', finding)).resolves.toEqual({ ok: true });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// テスト
// ---------------------------------------------------------------------------------------------------------------

describe('RunCoordinator: crawl budgets (Task 15 Step 1)', () => {
  it('stops at the page limit with PARTIAL and MAX_PAGES_REACHED, and keeps the skipped URLs as SKIPPED pages', async () => {
    const harness = createHarness({ site: starSite(4), config: { crawl: { maxPages: 2 } } });
    const result = await harness.coordinator.run();

    expect(result.run.runStatus).toBe('PARTIAL');
    expect(codesOf(result.run.incompleteReasons)).toContain('MAX_PAGES_REACHED');
    expect(result.run.crawlLimits).toEqual({ maxPagesReached: true, maxDepthReached: false, maxRuntimeReached: false });
    expect(harness.world.auditCalls).toHaveLength(2);
    expect(result.run.discoveredPageCount).toBe(4);
    expect(result.pages.map((page) => page.status)).toEqual(['AUDITED', 'AUDITED', 'SKIPPED', 'SKIPPED']);
    expect(result.pages.slice(2).map((page) => page.incompleteReasons)).toEqual([
      [{ code: 'MAX_PAGES_REACHED', detail: null }],
      [{ code: 'MAX_PAGES_REACHED', detail: null }],
    ]);
    expect(result.run).toMatchObject({ auditedPageCount: 2, skippedPageCount: 2, partialPageCount: 0, failedPageCount: 0 });
    await expectValidRun(result);
  });

  it('does not queue URLs deeper than maxDepth, and records them as SKIPPED with MAX_DEPTH_REACHED', async () => {
    const site: FakeSite = {
      [START_PATH]: { links: ['/level-1.html'] },
      '/level-1.html': { links: ['/level-2.html'] },
      '/level-2.html': { links: ['/level-3.html'] },
      '/level-3.html': { links: [] },
    };
    const harness = createHarness({ site, config: { crawl: { maxDepth: 2 } } });
    const result = await harness.coordinator.run();

    expect(result.run.runStatus).toBe('PARTIAL');
    expect(codesOf(result.run.incompleteReasons)).toContain('MAX_DEPTH_REACHED');
    expect(result.run.crawlLimits).toEqual({ maxPagesReached: false, maxDepthReached: true, maxRuntimeReached: false });
    expect(harness.world.auditCalls.map(({ url }) => pathOf(url))).toEqual([START_PATH, '/level-1.html', '/level-2.html']);
    const deepest = result.pages.find((page) => pathOf(page.pageUrl) === '/level-3.html');
    expect(deepest?.status).toBe('SKIPPED');
    expect(deepest?.incompleteReasons).toEqual([{ code: 'MAX_DEPTH_REACHED', detail: null }]);
    await expectValidRun(result);
  });

  it('audits every page within maxDepth (depth 0 is the start URL)', async () => {
    const site: FakeSite = {
      [START_PATH]: { links: ['/level-1.html'] },
      '/level-1.html': { links: ['/level-2.html'] },
      '/level-2.html': { links: [] },
    };
    const result = await createHarness({ site, config: { crawl: { maxDepth: 2 } } }).coordinator.run();
    expect(result.run.runStatus).toBe('COMPLETE');
    expect(result.run.crawlLimits.maxDepthReached).toBe(false);
  });

  it('stops at the runtime limit with PARTIAL and MAX_RUNTIME_REACHED, checking before each page', async () => {
    const harness = createHarness({
      site: starSite(5, { durationMs: 1_000 }),
      config: { crawl: { maxRuntimeMs: 2_500 } },
    });
    const result = await harness.coordinator.run();

    // 0 ms、1000 ms、2000 ms に始めた3ページを監査し、3000 ms の時点で残りを SKIPPED にする（ページとページの間でだけ確かめる）。
    expect(harness.world.auditCalls).toHaveLength(3);
    expect(result.run.runStatus).toBe('PARTIAL');
    expect(codesOf(result.run.incompleteReasons)).toContain('MAX_RUNTIME_REACHED');
    expect(result.run.crawlLimits).toEqual({ maxPagesReached: false, maxDepthReached: false, maxRuntimeReached: true });
    expect(result.pages.filter((page) => page.status === 'SKIPPED').map((page) => page.incompleteReasons)).toEqual([
      [{ code: 'MAX_RUNTIME_REACHED', detail: null }],
      [{ code: 'MAX_RUNTIME_REACHED', detail: null }],
    ]);
  });

  it('records maxRuntimeReached without a Run reason when the last page runs past the limit and no URL is left (5.6.3)', async () => {
    const harness = createHarness({
      site: starSite(3, { durationMs: 1_000 }),
      config: { crawl: { maxRuntimeMs: 2_500 } },
    });
    const result = await harness.coordinator.run();

    // 0 ms、1000 ms、2000 ms に始めた3ページで、すべての URL を監査した。最後のページの後は 3000 ms で、上限を超えている。
    expect(harness.world.auditCalls).toHaveLength(3);
    expect(result.run.crawlLimits).toEqual({ maxPagesReached: false, maxDepthReached: false, maxRuntimeReached: true });
    expect(result.run.incompleteReasons).toEqual([]);
    expect(result.run.skippedPageCount).toBe(0);
    expect(result.run.runStatus).toBe('COMPLETE');
    await expectValidRun(result);
  });

  it('does not record maxRuntimeReached when the last page finishes within the limit', async () => {
    const harness = createHarness({
      site: starSite(3, { durationMs: 1_000 }),
      config: { crawl: { maxRuntimeMs: 3_001 } },
    });
    const result = await harness.coordinator.run();

    expect(harness.world.auditCalls).toHaveLength(3);
    expect(result.run.crawlLimits.maxRuntimeReached).toBe(false);
    expect(result.run.runStatus).toBe('COMPLETE');
  });

  it('can be COMPLETE when all 50 of 50 pages are audited, even with Findings', async () => {
    const harness = createHarness({ site: starSite(50), config: { crawl: { maxPages: 50 } } });
    const result = await harness.coordinator.run();

    expect(result.run.runStatus).toBe('COMPLETE');
    expect(result.run.incompleteReasons).toEqual([]);
    expect(result.run).toMatchObject({ discoveredPageCount: 50, auditedPageCount: 50, skippedPageCount: 0 });
    expect(result.findings.filter((finding) => finding.ruleId === 'TEST_PAGE_RULE')).toHaveLength(50);
    await expectValidRun(result);
  });

  it('is never COMPLETE when only 49 of 50 pages are audited (one page is SKIPPED)', async () => {
    const harness = createHarness({ site: starSite(50), config: { crawl: { maxPages: 49 } } });
    const result = await harness.coordinator.run();

    expect(result.run.runStatus).not.toBe('COMPLETE');
    expect(result.run.runStatus).toBe('PARTIAL');
    expect(result.run).toMatchObject({ discoveredPageCount: 50, auditedPageCount: 49, skippedPageCount: 1 });
    expect(result.pages).toHaveLength(50);
    expect(codesOf(result.run.incompleteReasons)).toContain('MAX_PAGES_REACHED');
  });
});

describe('RunCoordinator: retry of transient navigation failures (design 5.2, 5.6.4)', () => {
  it('defines the retryable details with navigationFailureDetail', () => {
    expect(RETRYABLE_NAVIGATION_FAILURE_DETAILS).toEqual([
      'TIMEOUT',
      'FAILED:net::ERR_CONNECTION_RESET',
      'FAILED:net::ERR_CONNECTION_CLOSED',
      'FAILED:net::ERR_EMPTY_RESPONSE',
      'FAILED:net::ERR_NETWORK_CHANGED',
    ]);
  });

  it.each([
    ['TIMEOUT', 'TIMEOUT'],
    ['FAILED', 'FAILED:net::ERR_CONNECTION_RESET'],
    ['FAILED', 'FAILED:net::ERR_CONNECTION_CLOSED'],
    ['FAILED', 'FAILED:net::ERR_EMPTY_RESPONSE'],
    ['FAILED', 'FAILED:net::ERR_NETWORK_CHANGED'],
  ] as const)('retries %s (%s) once with the same pageId and records the first attempt', async (outcome, detail) => {
    const harness = createHarness({ site: { [START_PATH]: { attempts: [{ outcome, detail }] } } });
    const result = await harness.coordinator.run();

    expect(harness.world.auditCalls).toHaveLength(2);
    expect(harness.world.auditCalls[0]?.pageId).toBe(harness.world.auditCalls[1]?.pageId);
    const firstAttemptEvidenceIds = harness.world.auditOutcomes[0]?.result.evidence.map(({ evidenceId }) => evidenceId);
    expect(result.run.retries).toEqual([
      { url: urlOf(START_PATH), attempt: 1, navigationOutcome: outcome, detail, evidenceIds: firstAttemptEvidenceIds },
    ]);
    // 最終の試行の結果を、pages に入れる（最初の試行の Evidence も残す）。
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]?.status).toBe('AUDITED');
    expect(result.run.runStatus).toBe('COMPLETE');
    await expectValidRun(result);
  });

  // DEF-007: Page Auditor には、試行の番号と、Coordinator の再試行の判断を渡す（再試行の前の試行のスクリーンショットの置き場所を分けるため）。
  it('passes the attempt number and the retry decision of the Coordinator to the Page Auditor', async () => {
    const harness = createHarness({
      site: { [START_PATH]: { attempts: [{ outcome: 'TIMEOUT', detail: 'TIMEOUT' }], links: ['/stable.html'] }, '/stable.html': {} },
    });
    await harness.coordinator.run();
    const [firstCall, retryCall, stableCall] = harness.world.auditCalls;
    const [firstOutcome, retryOutcome, stableOutcome] = harness.world.auditOutcomes;
    const desktopOf = (outcome: PageAuditOutcome | undefined): ViewportAuditResult => outcome?.result.viewports.desktop as ViewportAuditResult;

    expect([firstCall?.attempt?.attempt, retryCall?.attempt?.attempt, stableCall?.attempt?.attempt]).toEqual([1, 2, 1]);
    // 最初の試行は、再試行の前の試行である。最後の試行の後には、同じ失敗でも再試行しない。
    expect(firstCall?.attempt?.precedesRetry(desktopOf(firstOutcome))).toBe(true);
    expect(retryCall?.attempt?.precedesRetry(desktopOf(firstOutcome))).toBe(false);
    expect(retryCall?.attempt?.precedesRetry(desktopOf(retryOutcome))).toBe(false);
    expect(stableCall?.attempt?.precedesRetry(desktopOf(stableOutcome))).toBe(false);
  });

  it('keeps the Evidence of the first attempt on the final page, points to it from retries, and drops its Findings (5.6.4)', async () => {
    const harness = createHarness({
      site: { [START_PATH]: { attempts: [{ outcome: 'TIMEOUT', detail: 'TIMEOUT' }], finding: true } },
    });
    const result = await harness.coordinator.run();
    const [first, final] = harness.world.auditOutcomes;
    const firstIds = first?.result.evidence.map(({ evidenceId }) => evidenceId) ?? [];
    const finalIds = final?.result.evidence.map(({ evidenceId }) => evidenceId) ?? [];
    const page = result.pages[0];

    expect(firstIds.length).toBeGreaterThan(0);
    expect(result.run.retries.map(({ evidenceIds }) => evidenceIds)).toEqual([firstIds]);
    // 開始の URL のページなので、metadata の Evidence が先頭にある。その次に最初の試行、最後に最終の試行の Evidence を置く。
    expect(page?.evidence.filter(({ type }) => type !== 'metadata').map(({ evidenceId }) => evidenceId))
      .toEqual([...firstIds, ...finalIds]);
    expect(page?.evidence.filter(({ evidenceId }) => firstIds.includes(evidenceId))).toEqual(first?.result.evidence);
    // 最初の試行の Finding は残さない（Rule は、最終の試行の Evidence で評価する）。
    const pageFindings = result.findings.filter((finding) => finding.ruleId === 'TEST_PAGE_RULE');
    expect(pageFindings).toEqual(final?.result.findings);
    expect(page?.findings).toEqual(final?.result.findings);
    expect(pageFindings.flatMap(({ evidenceRefs }) => evidenceRefs).some((id) => firstIds.includes(id))).toBe(false);
    await expectValidRun(result);
  });

  it('keeps the Evidence of the first attempt on the page even when the retry throws', async () => {
    const harness = createHarness({
      site: { [START_PATH]: { links: ['/flaky.html'] }, '/flaky.html': { attempts: [{ outcome: 'TIMEOUT', detail: 'TIMEOUT' }], throwsOnRetry: true } },
    });
    const result = await harness.coordinator.run();
    const firstIds = harness.world.auditOutcomes[1]?.result.evidence.map(({ evidenceId }) => evidenceId) ?? [];
    const flaky = result.pages[1];

    expect(harness.world.auditCalls.map(({ url }) => pathOf(url))).toEqual([START_PATH, '/flaky.html', '/flaky.html']);
    expect(firstIds.length).toBeGreaterThan(0);
    expect(result.run.retries.map(({ evidenceIds }) => evidenceIds)).toEqual([firstIds]);
    expect(flaky?.status).toBe('SKIPPED');
    expect(flaky?.incompleteReasons).toEqual([{ code: 'EXECUTION_INCOMPLETE', detail: null }]);
    expect(flaky?.evidence.map(({ evidenceId }) => evidenceId)).toEqual(firstIds);
    expect(result.run.incompleteReasons).toContainEqual({
      code: 'UNHANDLED_FAILURE',
      detail: expect.stringMatching(/^run-crawl:.*fake audit failure/u),
    });
    await expectValidRun(result);
  });

  it('retries only once (two attempts in total), and keeps the failed final attempt', async () => {
    const harness = createHarness({
      site: { [START_PATH]: { attempts: [{ outcome: 'TIMEOUT' }, { outcome: 'TIMEOUT' }, { outcome: 'OK' }] } },
    });
    const result = await harness.coordinator.run();

    expect(harness.world.auditCalls).toHaveLength(2);
    expect(result.run.retries).toHaveLength(1);
    expect(result.pages[0]?.status).toBe('FAILED');
    expect(result.run.runStatus).toBe('PARTIAL');
    expect(result.run.failedPageCount).toBe(1);
  });

  it.each([
    ['a refused connection', { outcome: 'FAILED', detail: 'FAILED:net::ERR_CONNECTION_REFUSED' }],
    ['a failure without a Chromium code', { outcome: 'FAILED', detail: 'FAILED' }],
    ['a safety block of an external redirect', { outcome: 'BLOCKED_EXTERNAL_REDIRECT', detail: 'BLOCKED_EXTERNAL_REDIRECT' }],
    ['an HTTP 503 response', { outcome: 'OK', httpStatus: 503 }],
    ['an HTTP 404 response', { outcome: 'OK', httpStatus: 404 }],
  ] as const)('does not retry %s', async (_label, attempt: AttemptSpec) => {
    const harness = createHarness({ site: { [START_PATH]: { attempts: [attempt, { outcome: 'OK' }] } } });
    const result = await harness.coordinator.run();

    expect(harness.world.auditCalls).toHaveLength(1);
    expect(result.run.retries).toEqual([]);
  });
});

describe('RunCoordinator: PREFLIGHT and Run Status inputs (design 5.6.6)', () => {
  it('does not call the Page Auditor or the metadata collection when PREFLIGHT fails, and finishes FAILED', async () => {
    const harness = createHarness({ site: starSite(3), preflightOk: false });
    const result = await harness.coordinator.run();

    expect(result.run.runStatus).toBe('FAILED');
    expect(harness.world.createdAuditors).toHaveLength(0);
    expect(harness.world.auditCalls).toHaveLength(0);
    expect(harness.metadata).not.toHaveBeenCalled();
    expect(harness.browserClose).not.toHaveBeenCalled();
    expect(result.pages).toEqual([]);
    expect(result.run.incompleteReasons).toContainEqual({ code: 'PREFLIGHT_FAILED', detail: 'BROWSER_LAUNCH' });
    expect(result.run.safety.guardEnabled).toBe(false);
    // 環境の事実は、Browser なしでも集める。
    expect(harness.environment).toHaveBeenCalledWith(expect.objectContaining({ browser: null, factory: null }));
    expect(result.run.environment).toEqual(ENVIRONMENT);
    await expectValidRun(result);
  });

  it('passes the run directory under the output root to PREFLIGHT and the Page Auditor', async () => {
    const harness = createHarness({ site: { [START_PATH]: {} } });
    const result = await harness.coordinator.run();
    const runDirectory = runArtifactDirectory(harness.outputDirectory, result.run.runId);

    expect(result.run.runId).toBe('RUN-20260924010203');
    expect(harness.preflight).toHaveBeenCalledWith(expect.objectContaining({ outputDirectory: runDirectory }));
    expect(harness.world.createdAuditors[0]?.screenshotRootDirectory).toBe(runDirectory);
    expect(harness.browserClose).toHaveBeenCalledTimes(1);
    expect(result.run.safety.guardEnabled).toBe(true);
  });

  it('is ABORTED_BY_SAFETY when a page Ledger records an invariant violation', async () => {
    const result = await createHarness({ site: { [START_PATH]: { violations: 2 } } }).coordinator.run();
    expect(result.run.runStatus).toBe('ABORTED_BY_SAFETY');
    expect(result.run.safety.invariantViolationCount).toBe(2);
    expect(result.run.safety.invariantViolations).toHaveLength(2);
  });

  it('is ABORTED_BY_SAFETY when a Ledger the Coordinator created (PREFLIGHT) records an invariant violation', async () => {
    const result = await createHarness({ site: { [START_PATH]: {} }, preflightViolations: 1 }).coordinator.run();
    expect(result.run.runStatus).toBe('ABORTED_BY_SAFETY');
    expect(result.run.safety.invariantViolationCount).toBe(1);
  });

  it('is ABORTED_BY_SAFETY, not FAILED, when a PREFLIGHT Guard failure records an invariant violation (5.6.7)', async () => {
    const harness = createHarness({
      site: starSite(3),
      preflightOk: false,
      preflightFailedCheck: 'PASSIVE_GUARD',
      preflightViolations: 1,
    });
    const result = await harness.coordinator.run();

    expect(result.run.runStatus).toBe('ABORTED_BY_SAFETY');
    expect(result.run.safety.invariantViolationCount).toBe(1);
    expect(result.run.incompleteReasons).toContainEqual({ code: 'PREFLIGHT_FAILED', detail: 'PASSIVE_GUARD' });
    // 対象のサイトにはアクセスしない。
    expect(harness.world.auditCalls).toHaveLength(0);
    expect(harness.metadata).not.toHaveBeenCalled();
    await expectValidRun(result);
  });

  it('stays FAILED when PREFLIGHT fails without an invariant violation', async () => {
    const result = await createHarness({ site: starSite(3), preflightOk: false, preflightFailedCheck: 'PASSIVE_GUARD' })
      .coordinator.run();
    expect(result.run.runStatus).toBe('FAILED');
    expect(result.run.safety.invariantViolationCount).toBe(0);
  });

  it('is ABORTED_BY_SAFETY when the Page Auditor records a violation in a Ledger and then throws (5.6.5)', async () => {
    const site: FakeSite = {
      [START_PATH]: { links: ['/boom.html'] },
      '/boom.html': { throws: true, violations: 1, blockedPosts: 1 },
    };
    const result = await createHarness({ site }).coordinator.run();

    expect(result.run.runStatus).toBe('ABORTED_BY_SAFETY');
    expect(result.run.safety.invariantViolationCount).toBe(1);
    expect(result.run.safety.invariantViolations).toEqual([{ code: 'TEST_VIOLATION', message: 'TEST_VIOLATION 0' }]);
    // 例外を投げた試行の Ledger の遮断も、件数に入る。
    expect(result.run.safety.blockedRequestsByMethod).toEqual({ POST: 1 });
    expect(result.run.safety.blockedActions.requests).toBe(1);
    await expectValidRun(result);
  });

  it('is ABORTED_BY_SAFETY when a Ledger of the environment facts records an invariant violation', async () => {
    const result = await createHarness({ site: { [START_PATH]: {} }, environmentViolations: 1 }).coordinator.run();
    expect(result.run.runStatus).toBe('ABORTED_BY_SAFETY');
    expect(result.run.safety.invariantViolations).toEqual([{ code: 'ENVIRONMENT_VIOLATION', message: 'ENVIRONMENT_VIOLATION 0' }]);
  });

  it('is ABORTED_BY_SAFETY when the Ledger of the metadata collection records an invariant violation', async () => {
    const result = await createHarness({ site: { [START_PATH]: {} }, metadataViolations: 1 }).coordinator.run();
    expect(result.run.runStatus).toBe('ABORTED_BY_SAFETY');
    expect(result.run.safety.invariantViolations).toEqual([{ code: 'METADATA_VIOLATION', message: 'METADATA_VIOLATION 0' }]);
  });

  it('counts the blocked requests of the attempt before a retry', async () => {
    const site: FakeSite = { [START_PATH]: { attempts: [{ outcome: 'TIMEOUT', detail: 'TIMEOUT' }], blockedPosts: 1 } };
    const result = await createHarness({ site }).coordinator.run();
    // 偽の Page Auditor は、試行のたびに1件の POST を遮断する。最初の試行の分も数える。
    expect(result.run.retries).toHaveLength(1);
    expect(result.run.safety.blockedRequestsByMethod).toEqual({ POST: 2 });
    expect(result.run.safety.blockedActions.requests).toBe(2);
    expect(result.run.runStatus).toBe('COMPLETE');
  });

  it('adds REQUIRED_ARTIFACT_INVALID and is not COMPLETE when a page does not match the page schema', async () => {
    const site: FakeSite = { [START_PATH]: { links: ['/invalid.html'] }, '/invalid.html': { schemaInvalid: true } };
    const result = await createHarness({ site }).coordinator.run();

    expect(result.run.runStatus).not.toBe('COMPLETE');
    expect(result.run.runStatus).toBe('PARTIAL');
    expect(result.run.incompleteReasons).toEqual([
      { code: 'REQUIRED_ARTIFACT_INVALID', detail: expect.stringMatching(/^page:PAGE-000002:/u) },
    ]);
  });

  it('adds the Cross-page rule failures to the Run reasons and is not COMPLETE', async () => {
    const evaluate = vi.mocked(evaluateCrossPageRules);
    evaluate.mockImplementationOnce((input) => ({
      findings: [],
      failures: [{ code: 'RULE_EVALUATION_FAILED', ruleId: 'BROKEN_INTERNAL_LINK', message: 'test rule failure' }],
      nextFindingSequence: input.firstFindingSequence,
      unverifiedInternalLinkCount: 0,
    }));
    const result = await createHarness({ site: { [START_PATH]: {} } }).coordinator.run();

    expect(evaluate).toHaveBeenCalled();
    expect(result.run.runStatus).toBe('PARTIAL');
    expect(result.run.incompleteReasons).toEqual([
      { code: 'RULE_EVALUATION_FAILED', detail: 'BROKEN_INTERNAL_LINK:test rule failure' },
    ]);
  });

  it('counts an exception of the Cross-page rule evaluation as an unhandled failure', async () => {
    vi.mocked(evaluateCrossPageRules).mockImplementationOnce(() => {
      throw new Error('cross-page exploded');
    });
    const result = await createHarness({ site: { [START_PATH]: {} } }).coordinator.run();

    expect(result.run.runStatus).toBe('PARTIAL');
    expect(result.run.incompleteReasons).toEqual([
      { code: 'UNHANDLED_FAILURE', detail: expect.stringMatching(/^run-cross-page:.*cross-page exploded/u) },
    ]);
  });

  it('adds a failure to close the metadata page to the Run reasons', async () => {
    const result = await createHarness({ site: { [START_PATH]: {} }, metadataPageCloseFails: true }).coordinator.run();
    expect(result.run.runStatus).toBe('PARTIAL');
    expect(result.run.incompleteReasons).toEqual([
      { code: 'UNHANDLED_FAILURE', detail: expect.stringMatching(/^site-metadata-page-close:.*metadata page close failed/u) },
    ]);
  });

  // C18f（Task 19 の前の整理の設計書 4.5。設計者の判断で期待値を変えた）: 再試行も、対象のサイトへの新しい監査である。違反を検出した
  // 後は、再試行を始めない。最初の試行の違反は、今までどおり数える（捨てた試行の違反も数える、という意図は変えない）。
  it('counts the violation of the first attempt and does not start the retry after it', async () => {
    const site: FakeSite = { [START_PATH]: { attempts: [{ outcome: 'TIMEOUT' }], violations: 1 } };
    const harness = createHarness({ site });
    const result = await harness.coordinator.run();
    // 偽の Page Auditor は、試行のたびに1件の違反を記録する。最初の試行の分を数え、再試行はしない。
    expect(result.run.safety.invariantViolationCount).toBe(1);
    expect(harness.world.auditCalls).toHaveLength(1);
    expect(result.run.retries).toEqual([]);
    // 最初の試行の結果（Desktop のナビゲーションの失敗）を、そのまま最終の結果にする。
    expect(result.pages[0]?.viewports.desktop.incompleteReasons).toEqual([{ code: 'NAVIGATION_FAILED', detail: 'TIMEOUT' }]);
    // Page Auditor には、再試行の前の試行ではないと答える（スクリーンショットを retry-<n> に置かない）。
    const [firstCall] = harness.world.auditCalls;
    const desktop = result.pages[0]?.viewports.desktop;
    expect(desktop === undefined ? null : firstCall?.attempt?.precedesRetry(desktop)).toBe(false);
    // 止めたことは、Run の理由に残す。Run Status は ABORTED_BY_SAFETY。
    expect(result.run.incompleteReasons).toContainEqual({ code: 'SAFETY_VIOLATION_ABORT', detail: null });
    expect(result.run.runStatus).toBe('ABORTED_BY_SAFETY');
    await expectValidRun(result);
  });

  it('sums the blocked requests of every safety Evidence and of the Coordinator Ledgers', async () => {
    const site: FakeSite = { [START_PATH]: { links: ['/a.html'], blockedPosts: 2 }, '/a.html': { blockedPosts: 1 } };
    const result = await createHarness({ site, preflightBlockedPosts: 1 }).coordinator.run();
    expect(result.run.safety.blockedRequestsByMethod).toEqual({ POST: 4 });
    expect(result.run.safety.blockedActions).toEqual({
      requests: 4,
      navigations: 0,
      externalActions: 0,
      popups: 0,
      downloads: 0,
      webSockets: 0,
    });
    // 遮断は、Guard が正しく働いた証拠で、Run の失敗ではない。
    expect(result.run.runStatus).toBe('COMPLETE');
  });

  it('is PARTIAL when an Interaction is NOT_VERIFIABLE with CHECK_NOT_COMPLETED', async () => {
    const site: FakeSite = {
      [START_PATH]: { interactions: [{ status: 'NOT_VERIFIABLE', notVerifiableKind: 'CHECK_NOT_COMPLETED' }] },
    };
    const result = await createHarness({ site }).coordinator.run();
    expect(result.run.runStatus).toBe('PARTIAL');
    expect(result.run.unverifiedInteractionCount).toBe(1);
    await expectValidRun(result);
  });

  it('stays COMPLETE when the only unverified Interactions are OBSERVED_NO_CHANGE, and still counts them', async () => {
    const site: FakeSite = {
      [START_PATH]: {
        interactions: [
          { status: 'NOT_VERIFIABLE', notVerifiableKind: 'OBSERVED_NO_CHANGE' },
          { status: 'VERIFIED' },
        ],
      },
    };
    const result = await createHarness({ site }).coordinator.run();
    expect(result.run.runStatus).toBe('COMPLETE');
    expect(result.run.unverifiedInteractionCount).toBe(1);
    await expectValidRun(result);
  });

  it('is PARTIAL when an Interaction is EXECUTION_FAILED', async () => {
    const site: FakeSite = { [START_PATH]: { interactions: [{ status: 'EXECUTION_FAILED' }] } };
    const result = await createHarness({ site }).coordinator.run();
    expect(result.run.runStatus).toBe('PARTIAL');
    expect(result.run.unverifiedInteractionCount).toBe(1);
  });

  it('is PARTIAL when a viewport is PARTIAL, and counts the page as partial', async () => {
    const result = await createHarness({ site: { [START_PATH]: { partial: true } } }).coordinator.run();
    expect(result.run.runStatus).toBe('PARTIAL');
    expect(result.run.partialPageCount).toBe(1);
    expect(result.run.viewportPageCounts).toEqual({
      desktop: { audited: 0, partial: 1, failed: 0, skipped: 0 },
      mobile: { audited: 1, partial: 0, failed: 0, skipped: 0 },
    });
  });

  it('counts an unexpected exception as an unhandled failure, finishes the Run, and closes the browser', async () => {
    const site: FakeSite = {
      [START_PATH]: { links: ['/boom.html', '/later.html'] },
      '/boom.html': { throws: true },
      '/later.html': {},
    };
    const harness = createHarness({ site });
    const result = await harness.coordinator.run();

    expect(result.run.runStatus).toBe('PARTIAL');
    expect(result.run.incompleteReasons).toContainEqual({
      code: 'UNHANDLED_FAILURE',
      detail: expect.stringMatching(/^run-crawl:.*fake audit failure/u),
    });
    expect(harness.browserClose).toHaveBeenCalledTimes(1);
    // 監査を終えられなかった URL も、隠さずに SKIPPED の結果にする。
    expect(result.pages.map((page) => [pathOf(page.pageUrl), page.status])).toEqual([
      [START_PATH, 'AUDITED'],
      ['/boom.html', 'SKIPPED'],
      ['/later.html', 'SKIPPED'],
    ]);
    expect(result.pages[1]?.incompleteReasons).toEqual([{ code: 'EXECUTION_INCOMPLETE', detail: null }]);
    await expectValidRun(result);
  });

  it('records a browser close failure as a Run reason', async () => {
    const result = await createHarness({ site: { [START_PATH]: {} }, browserCloseFails: true }).coordinator.run();
    expect(result.run.runStatus).toBe('PARTIAL');
    expect(result.run.incompleteReasons).toContainEqual({
      code: 'UNHANDLED_FAILURE',
      detail: expect.stringMatching(/^browser-close:.*browser close failed/u),
    });
  });
});

// C18f（Task 19 の前の整理の設計書 4.5、RC18a の指摘2）: 違反を検出した後は、新しいページを始めない。残りのページは、理由付きの
// SKIPPED にする。Run Status は、`deriveRunStatus` が `ABORTED_BY_SAFETY` と導く。
describe('RunCoordinator: no new audit after a safety invariant violation (C18f, design 4.5)', () => {
  const SAFETY_VIOLATION_ABORT: IncompleteReason = { code: 'SAFETY_VIOLATION_ABORT', detail: null };

  it('does not start the pages after the page with a violation and marks them SKIPPED with SAFETY_VIOLATION_ABORT', async () => {
    // 違反を起こすページが3つあるサイト。最初の1つの後は、どのページも始めない。
    const site: FakeSite = {
      [START_PATH]: { links: ['/a.html', '/b.html', '/c.html'] },
      '/a.html': { violations: 1, links: ['/d.html'] },
      '/b.html': { violations: 1 },
      '/c.html': { violations: 1 },
    };
    const harness = createHarness({ site });
    const result = await harness.coordinator.run();

    expect(harness.world.auditCalls.map(({ url }) => pathOf(url))).toEqual([START_PATH, '/a.html']);
    expect(result.run.safety.invariantViolationCount).toBe(1);
    expect(result.run.runStatus).toBe('ABORTED_BY_SAFETY');
    expect(deriveRunStatus(result.statusInput)).toBe('ABORTED_BY_SAFETY');
    // 違反のページのリンク（/d.html）も、発見の順に、SKIPPED の結果にする。
    expect(result.pages.map((page) => [pathOf(page.pageUrl), page.status])).toEqual([
      [START_PATH, 'AUDITED'],
      ['/a.html', 'AUDITED'],
      ['/b.html', 'SKIPPED'],
      ['/c.html', 'SKIPPED'],
      ['/d.html', 'SKIPPED'],
    ]);
    for (const page of result.pages.filter(({ status }) => status === 'SKIPPED')) {
      expect(page.incompleteReasons).toEqual([SAFETY_VIOLATION_ABORT]);
      for (const profile of VIEWPORT_PROFILES) {
        expect(page.viewports[profile]).toMatchObject({ status: 'SKIPPED', incompleteReasons: [SAFETY_VIOLATION_ABORT], navigationOutcome: null });
      }
    }
    expect(result.run.skippedPageCount).toBe(3);
    // 止めたことは、Run の理由にも残す。上限の理由ではない。
    expect(result.run.incompleteReasons).toEqual([SAFETY_VIOLATION_ABORT]);
    expect(result.run.crawlLimits).toEqual({ maxPagesReached: false, maxDepthReached: false, maxRuntimeReached: false });
    // Browser は、今までどおり閉じる。
    expect(harness.browserClose).toHaveBeenCalledTimes(1);
    await expectValidRun(result);
  });

  it('does not start the metadata collection or any page when a Ledger of the environment facts has recorded a violation', async () => {
    const harness = createHarness({ site: { [START_PATH]: { links: ['/a.html'] } }, environmentViolations: 1 });
    const result = await harness.coordinator.run();

    // robots.txt と sitemap.xml の取得も、対象のサイトへの新しいアクセスなので、始めない（設計者の判断）。
    expect(harness.metadata).not.toHaveBeenCalled();
    expect(harness.world.auditCalls).toEqual([]);
    expect(result.pages.map((page) => [pathOf(page.pageUrl), page.status, page.incompleteReasons])).toEqual([
      [START_PATH, 'SKIPPED', [SAFETY_VIOLATION_ABORT]],
    ]);
    // 取得しなかったので、metadata の Evidence はない（観測していないものを記録しない）。
    expect(result.pages[0]?.evidence.filter((record) => record.type === 'metadata')).toEqual([]);
    expect(result.run.runStatus).toBe('ABORTED_BY_SAFETY');
    // 止めたこと（`detail` は null）と、metadata の取得を始めなかったこと（`detail` は `site-metadata`）を、Run の理由に残す。
    expect(result.run.incompleteReasons).toEqual([
      SAFETY_VIOLATION_ABORT,
      { code: 'SAFETY_VIOLATION_ABORT', detail: 'site-metadata' },
    ]);
    expect(harness.browserClose).toHaveBeenCalledTimes(1);
    await expectValidRun(result);
  });

  it('gives the Page Auditor a check that answers from the Ledgers of the Run, for the next viewport and candidate', async () => {
    const site: FakeSite = { [START_PATH]: { links: ['/a.html'] }, '/a.html': { violations: 1 } };
    const harness = createHarness({ site });
    const result = await harness.coordinator.run();

    // 開始のページの Desktop の後は、違反がない。/a.html の Desktop の Ledger に記録した後は、違反がある。
    expect(harness.world.safetyChecks).toEqual([false, true]);
    expect(result.run.runStatus).toBe('ABORTED_BY_SAFETY');
    // Page Auditor の中で止めた場合も、Run の理由に残す。
    expect(result.run.incompleteReasons).toEqual([SAFETY_VIOLATION_ABORT]);
  });

  it('adds no reason and starts every page when no violation is recorded', async () => {
    const harness = createHarness({ site: starSite(3) });
    const result = await harness.coordinator.run();

    expect(harness.world.auditCalls).toHaveLength(3);
    expect(harness.world.safetyChecks).toEqual([false, false, false]);
    expect(result.run.incompleteReasons).toEqual([]);
    expect(result.run.runStatus).toBe('COMPLETE');
  });
});

describe('RunCoordinator: browser close deadline (R15 Minor-2)', () => {
  // R15r-4: 期限は、短い値を注入して確かめる（既定の `BROWSER_CLOSE_TIMEOUT_MS` の実際の時間は待たない）。
  it('records the missed browser close deadline as a Run reason and still returns the Run', async () => {
    const harness = createHarness({
      site: { [START_PATH]: {} },
      browserCloseHangs: true,
      browserCloseTimeoutMs: SHORT_BROWSER_CLOSE_TIMEOUT_MS,
    });

    const startedAt = performance.now();
    const result = await harness.coordinator.run();
    const elapsedMs = performance.now() - startedAt;

    expect(harness.browserClose).toHaveBeenCalledTimes(1);
    expect(result.run.runStatus).toBe('PARTIAL');
    expect(result.run.incompleteReasons).toContainEqual({
      code: 'UNHANDLED_FAILURE',
      detail: `browser-close:${BROWSER_CLOSE_DEADLINE_MESSAGE}`,
    });
    // 注入した期限まで待ち、既定の期限（`BROWSER_CLOSE_TIMEOUT_MS`）より前に返る。
    expect(elapsedMs).toBeGreaterThanOrEqual(SHORT_BROWSER_CLOSE_TIMEOUT_MS / 2);
    expect(elapsedMs).toBeLessThan(SHORT_BROWSER_CLOSE_TIMEOUT_MS + 5_000);
    expect(elapsedMs).toBeLessThan(BROWSER_CLOSE_TIMEOUT_MS);
    await expectValidRun(result);
  });

  it('rejects a browser close timeout that is not a positive safe integer when it is constructed', () => {
    for (const browserCloseTimeoutMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createHarness({ site: { [START_PATH]: {} }, browserCloseTimeoutMs }), String(browserCloseTimeoutMs))
        .toThrow(RangeError);
    }
  });
});

/** User-Agent を読む Context を閉じる処理が終わらない、偽の Context の factory（RP18 の指摘1・2）。Browser は起動しない。 */
function hangingEnvironmentContextCloseFactory(): { readonly factory: BrowserContextFactory; readonly events: string[] } {
  const events: string[] = [];
  const ledgers = new Map<unknown, SafetyLedger>();
  let sequence = 0;
  const factory = {
    createPassiveContext: async () => {
      sequence += 1;
      const context = { name: `environment-context-${String(sequence)}` } as unknown as BrowserContext;
      ledgers.set(context, new SafetyLedger());
      events.push('createContext');
      return context;
    },
    getSafetyLedger: (context: BrowserContext) => {
      const ledger = ledgers.get(context);
      if (ledger === undefined) throw new Error('BrowserContext is not owned by this factory');
      return ledger;
    },
    createPassivePage: async () => {
      events.push('createPage');
      return { goto: async () => null, evaluate: async () => 'fake-user-agent' } as unknown as Page;
    },
    closePassivePage: async () => {
      events.push('closePage');
    },
    closePassiveContext: async () => {
      events.push('closeContext');
      await new Promise<never>(() => undefined);
    },
  };
  return { factory: factory as unknown as BrowserContextFactory, events };
}

/** Run 全体の期限のテストで注入する、短い期限（ms。実際の `CONTEXT_CLOSE_TIMEOUT_MS` を待たない）。 */
const SHORT_CONTEXT_CLOSE_TIMEOUT_MS = 100;
/** 期限を過ぎてから、Run が確定して返るまでの余裕。 */
const RUN_RETURN_MARGIN_MS = 2_000;
/** タイマーが少し早く発火する場合の許容。 */
const TIMER_TOLERANCE_MS = 20;

// RP18 の指摘1: 環境の読み取りの、閉じる処理の失敗（期限切れを含む）は、捨てずに Run の理由にする（Run は COMPLETE にならない）。
// RP18 の指摘2: Run Coordinator は、期限の注入口（`deadlines`）を、PREFLIGHT、環境、サイトの metadata、Page Auditor へ渡す。
describe('RunCoordinator: close failures of the environment and the injected deadlines (RP18 findings 1 and 2)', () => {
  it('adds the environment page and Context close failures to the Run reasons, so the Run is not COMPLETE', async () => {
    const result = await createHarness({
      site: { [START_PATH]: {} },
      environmentCloseFailures: [
        { step: 'page', error: new Error('environment page close failed') },
        { step: 'context', error: new PassiveContextCloseDeadlineError() },
      ],
    }).coordinator.run();

    expect(result.run.runStatus).toBe('PARTIAL');
    expect(result.run.incompleteReasons).toEqual([
      { code: 'UNHANDLED_FAILURE', detail: 'environment-page-close:environment page close failed' },
      { code: 'UNHANDLED_FAILURE', detail: `environment-context-close:${PASSIVE_CONTEXT_CLOSE_DEADLINE_MESSAGE}` },
    ]);
    expect(deriveRunStatus(result.statusInput)).toBe(result.run.runStatus);
    await expectValidRun(result);
  });

  it('passes the injected deadlines down to PREFLIGHT, the environment, the site metadata and the Page Auditor', async () => {
    const deadlines = {
      sessionOpenTimeoutMs: 1_234,
      pageCloseTimeoutMs: 2_345,
      contextCloseTimeoutMs: 3_456,
    } as const satisfies PassiveSessionDeadlineOptions;
    const harness = createHarness({ site: { [START_PATH]: {} }, deadlines, browserCloseTimeoutMs: 4_567 });

    const result = await harness.coordinator.run();

    expect(result.run.runStatus).toBe('COMPLETE');
    expect(harness.preflight).toHaveBeenCalledWith(expect.objectContaining({
      deadlines: expect.objectContaining({ ...deadlines, browserCloseTimeoutMs: 4_567 }),
    }));
    expect(harness.environment).toHaveBeenCalledWith(expect.objectContaining({ deadlines: expect.objectContaining(deadlines) }));
    expect(harness.metadata).toHaveBeenCalledWith(expect.objectContaining({ deadlines: expect.objectContaining(deadlines) }));
    expect(harness.world.createdAuditors).toHaveLength(1);
    expect(harness.world.createdAuditors[0]?.deadlines).toMatchObject(deadlines);
  });

  it('rejects invalid injected deadlines when it is constructed', () => {
    expect(() => createHarness({ site: { [START_PATH]: {} }, deadlines: { contextCloseTimeoutMs: 0 } })).toThrow(RangeError);
    expect(() => createHarness({ site: { [START_PATH]: {} }, deadlines: { sessionOpenTimeoutMs: 1.5 } })).toThrow(RangeError);
    expect(() => createHarness({ site: { [START_PATH]: {} }, deadlines: null as never })).toThrow(TypeError);
  });

  // 作成か終了が終わらない偽の Browser（Context の factory）で、Run 全体が期限の中で確定して返る。環境の読み取りの Context の終了だけが
  // 止まる場合である（RP18 の指摘1の再発を防ぐ）。実際の期限（`CONTEXT_CLOSE_TIMEOUT_MS`）は待たない。
  it('settles the Run within the injected deadline, not COMPLETE, when only closing the environment Contexts does not finish', async () => {
    const hanging = hangingEnvironmentContextCloseFactory();
    const harness = createHarness({
      site: { [START_PATH]: {} },
      realEnvironmentFactory: hanging.factory,
      deadlines: { contextCloseTimeoutMs: SHORT_CONTEXT_CLOSE_TIMEOUT_MS },
    });

    const startedAt = performance.now();
    const result = await harness.coordinator.run();
    const elapsedMs = performance.now() - startedAt;

    // Desktop と Mobile の Context を、それぞれ期限まで待ってから見切る。
    expect(hanging.events.filter((event) => event === 'closeContext')).toHaveLength(2);
    expect(elapsedMs).toBeGreaterThanOrEqual(2 * (SHORT_CONTEXT_CLOSE_TIMEOUT_MS - TIMER_TOLERANCE_MS));
    expect(elapsedMs).toBeLessThan(2 * SHORT_CONTEXT_CLOSE_TIMEOUT_MS + RUN_RETURN_MARGIN_MS);
    expect(elapsedMs).toBeLessThan(CONTEXT_CLOSE_TIMEOUT_MS);
    // User-Agent は読めた（閉じる処理の失敗は、値を変えない）。Browser は閉じた。
    expect(result.run.environment.userAgents).toEqual({ desktop: 'fake-user-agent', mobile: 'fake-user-agent' });
    expect(harness.browserClose).toHaveBeenCalledTimes(1);
    expect(result.run.runStatus).not.toBe('COMPLETE');
    expect(result.run.runStatus).toBe('PARTIAL');
    expect(result.run.incompleteReasons).toEqual([
      { code: 'UNHANDLED_FAILURE', detail: `environment-context-close:${PASSIVE_CONTEXT_CLOSE_DEADLINE_MESSAGE}` },
      { code: 'UNHANDLED_FAILURE', detail: `environment-context-close:${PASSIVE_CONTEXT_CLOSE_DEADLINE_MESSAGE}` },
    ]);
    await expectValidRun(result);
  }, 2 * SHORT_CONTEXT_CLOSE_TIMEOUT_MS + RUN_RETURN_MARGIN_MS + 1_000);
});

// P18d（DEF-009。Task 18 の前の整理の設計書 第6章）: Run のディレクトリは、Run の開始の時点（PREFLIGHT の前）で、排他的に作る。
// 作れなかった Run は、対象のサイトにアクセスせず、Browser も起動せずに FAILED で確定し、専用の例外（`RunDirectoryUnavailableError`）で
// 返す。artifact を書かせないためである（書く場所が、別の Run のディレクトリだから）。
describe('RunCoordinator: the run directory is created exclusively at the start of the Run (DEF-009)', () => {
  /** ディレクトリの下のすべてのファイルの、相対パスと中身（並べ替え済み）。 */
  const snapshotFiles = async (directory: string): Promise<readonly (readonly [string, string])[]> => {
    const entries = await readdir(directory, { recursive: true, withFileTypes: true });
    const files = await Promise.all(entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const path = join(entry.parentPath, entry.name);
        return [path.slice(directory.length), await readFile(path, 'utf8')] as const;
      }));
    return files.sort(([left], [right]) => left.localeCompare(right));
  };

  const runRejection = async (harness: Harness): Promise<RunDirectoryUnavailableError> => {
    const outcome = await harness.coordinator.run().then(
      () => new Error('the Run was expected to reject with RunDirectoryUnavailableError'),
      (error: unknown) => error,
    );
    expect(outcome).toBeInstanceOf(RunDirectoryUnavailableError);
    return outcome as RunDirectoryUnavailableError;
  };

  it('creates the run directory before PREFLIGHT', async () => {
    const harness = createHarness({ site: { [START_PATH]: {} } });
    const result = await harness.coordinator.run();

    expect(harness.world.runDirectoryExistedAtPreflight).toBe(true);
    expect(await readdir(harness.outputDirectory)).toEqual([result.run.runId]);
    expect(result.run.runStatus).toBe('COMPLETE');
  });

  it('fails a second Run with the same runId without PREFLIGHT, the browser or the site, and leaves the first run directory unchanged', async () => {
    const outputDirectory = join(workDirectory, 'same-run-id');
    const first = await createHarness({ site: starSite(2), outputDirectory }).coordinator.run();
    const runDirectory = runArtifactDirectory(outputDirectory, first.run.runId);
    // 1つ目の Run の artifact の代わり。
    await writeFile(join(runDirectory, 'run.json'), JSON.stringify(first.run), 'utf8');
    const before = await snapshotFiles(runDirectory);

    const second = createHarness({ site: starSite(2), outputDirectory });
    const error = await runRejection(second);

    // 同じ時計なので、同じ runId になる。
    expect(error.result.run.runId).toBe(first.run.runId);
    expect(error.runDirectory).toBe(runDirectory);
    expect(error.alreadyExists).toBe(true);
    // 対象のサイトにアクセスせず、Browser も起動しない。
    expect(second.preflight).not.toHaveBeenCalled();
    expect(second.launchBrowser).not.toHaveBeenCalled();
    expect(second.metadata).not.toHaveBeenCalled();
    expect(second.world.createdAuditors).toEqual([]);
    expect(second.world.auditCalls).toEqual([]);
    expect(second.browserClose).not.toHaveBeenCalled();
    // PREFLIGHT の失敗と同じく、FAILED で確定する（環境の事実は、Browser なしで集める）。
    expect(error.result.run.runStatus).toBe('FAILED');
    expect(error.result.statusInput.preflightFailed).toBe(true);
    expect(deriveRunStatus(error.result.statusInput)).toBe('FAILED');
    expect(error.result.run.incompleteReasons).toEqual([
      { code: 'RUN_DIRECTORY_UNAVAILABLE', detail: expect.stringContaining('EEXIST') },
    ]);
    expect(error.result.run.safety.guardEnabled).toBe(false);
    expect(error.result.pages).toEqual([]);
    expect(second.environment).toHaveBeenCalledWith(expect.objectContaining({ browser: null, factory: null }));
    await expectValidRun(error.result);
    // 1つ目の Run のディレクトリの中身は、変わらない。
    expect(await snapshotFiles(runDirectory)).toEqual(before);
    expect(await readdir(outputDirectory)).toEqual([first.run.runId]);
  });

  it('fails without alreadyExists when the output directory cannot be created, without PREFLIGHT', async () => {
    const blockingFile = join(workDirectory, 'blocking-file');
    await writeFile(blockingFile, 'a file where the output directory should be', 'utf8');
    const harness = createHarness({ site: { [START_PATH]: {} }, outputDirectory: join(blockingFile, 'output') });

    const error = await runRejection(harness);

    expect(error.alreadyExists).toBe(false);
    expect(error.runDirectory).toBe(runArtifactDirectory(join(blockingFile, 'output'), error.result.run.runId));
    expect(harness.preflight).not.toHaveBeenCalled();
    expect(harness.launchBrowser).not.toHaveBeenCalled();
    expect(error.result.run.runStatus).toBe('FAILED');
    expect(codesOf(error.result.run.incompleteReasons)).toEqual(['RUN_DIRECTORY_UNAVAILABLE']);
    expect(await readFile(blockingFile, 'utf8')).toBe('a file where the output directory should be');
  });
});

// P18d（R15r-3。Task 18 の前の整理の設計書 第7章）: 例外でクロールが止まった経路でも、実行時間の上限を過ぎていれば、
// `crawlLimits.maxRuntimeReached` を真にする。記録の規則は 5.6.3 と同じ（監査していない URL に MAX_RUNTIME_REACHED を付けていなければ、
// Run の理由は付けない）。Run Status の決め方は変えない。
describe('RunCoordinator: the runtime limit on the exception path (R15r-3)', () => {
  const site: FakeSite = {
    [START_PATH]: { links: ['/boom.html', '/later.html'], durationMs: 1_000 },
    // 1000 ms に始め（上限の前）、3000 ms に例外で終わる（上限の後）。
    '/boom.html': { throws: true, durationMs: 2_000 },
    '/later.html': {},
  };

  it('records maxRuntimeReached without a Run reason when the crawl stops on an exception after the runtime limit', async () => {
    const harness = createHarness({ site, config: { crawl: { maxRuntimeMs: 2_500 } } });
    const result = await harness.coordinator.run();

    expect(harness.world.auditCalls.map(({ url }) => pathOf(url))).toEqual([START_PATH, '/boom.html']);
    expect(result.run.crawlLimits).toEqual({ maxPagesReached: false, maxDepthReached: false, maxRuntimeReached: true });
    expect(codesOf(result.run.incompleteReasons)).not.toContain('MAX_RUNTIME_REACHED');
    expect(codesOf(result.run.incompleteReasons)).toContain('UNHANDLED_FAILURE');
    expect(result.pages.slice(1).map((page) => page.incompleteReasons)).toEqual([
      [{ code: 'EXECUTION_INCOMPLETE', detail: null }],
      [{ code: 'EXECUTION_INCOMPLETE', detail: null }],
    ]);
    // Run Status の決め方は変えない（上限の理由がないので、crawlLimitReached は偽のまま）。
    expect(result.statusInput.crawlLimitReached).toBe(false);
    expect(result.run.runStatus).toBe('PARTIAL');
    expect(deriveRunStatus(result.statusInput)).toBe(result.run.runStatus);
    await expectValidRun(result);
  });

  it('does not record maxRuntimeReached when the crawl stops on an exception within the runtime limit', async () => {
    const harness = createHarness({ site, config: { crawl: { maxRuntimeMs: 10_000 } } });
    const result = await harness.coordinator.run();

    expect(result.run.crawlLimits.maxRuntimeReached).toBe(false);
    expect(result.run.runStatus).toBe('PARTIAL');
  });
});

describe('RunCoordinator: discovery order, IDs, metadata and Cross-page rules', () => {
  const site: FakeSite = {
    [START_PATH]: {
      links: ['/b.html', '/a.html', '/b.html', 'https://external.example.test/', 'mailto:someone@example.test'],
    },
    '/a.html': { links: ['/c.html', START_PATH] },
    '/b.html': { links: ['/a.html'] },
    '/c.html': {},
  };

  it('discovers URLs in BFS and document order, allocates page IDs in that order, and follows only internal links', async () => {
    const first = await createHarness({ site }).coordinator.run();
    const second = await createHarness({ site }).coordinator.run();

    expect(first.pages.map((page) => [page.pageId, pathOf(page.pageUrl)])).toEqual([
      ['PAGE-000001', START_PATH],
      ['PAGE-000002', '/b.html'],
      ['PAGE-000003', '/a.html'],
      ['PAGE-000004', '/c.html'],
    ]);
    expect(second.pages).toEqual(first.pages);
    expect(second.findings).toEqual(first.findings);
    expect(first.run.discoveredPageCount).toBe(4);
  });

  it('puts the robots.txt and sitemap.xml Evidence on the start page with a null viewport', async () => {
    const harness = createHarness({ site });
    const result = await harness.coordinator.run();
    const start = result.pages[0];
    expect(harness.metadata).toHaveBeenCalledWith(expect.objectContaining({ origin: ORIGIN, pageId: 'PAGE-000001' }));
    expect(start?.evidence.filter((record) => record.type === 'metadata').map((record) => [record.viewport, record.pageId]))
      .toEqual([[null, 'PAGE-000001'], [null, 'PAGE-000001']]);
    await expectValidRun(result);
  });

  it('evaluates Cross-page rules after the crawl with the sitemap, and numbers their Findings after the page Findings', async () => {
    const harness = createHarness({
      site: { [START_PATH]: { finding: true } },
      sitemapUrls: [START_PATH, '/sitemap-only.html'],
    });
    const result = await harness.coordinator.run();
    const crossPage = result.findings.filter((finding) => finding.ruleId === 'SITEMAP_URL_NOT_DISCOVERED');
    expect(crossPage).toHaveLength(1);
    expect(crossPage[0]?.findingId).toBe('FIND-000002');
    expect(result.findings[0]?.findingId).toBe('FIND-000001');
    await expectValidRun(result);
  });

  it('counts internal links whose target was not audited as unverified internal links', async () => {
    const harness = createHarness({ site: starSite(3), config: { crawl: { maxPages: 1 } } });
    const result = await harness.coordinator.run();
    expect(result.run.unverifiedInternalLinkCount).toBe(2);
  });
});

// U16b（Task 14〜17 の設計書 6.1.1）: 確定した Run は、`deriveRunStatus` に渡した入力（`statusInput`）を、メモリの上だけで持つ。
describe('RunCoordinator: the Run Status input kept on the confirmed Run (design 6.1.1)', () => {
  it('keeps the same input that derived the Run Status, with the Run reasons', async () => {
    const result = await createHarness({ site: starSite(4), config: { crawl: { maxPages: 2 } } }).coordinator.run();

    expect(result.statusInput).toBeDefined();
    expect(deriveRunStatus(result.statusInput)).toBe(result.run.runStatus);
    expect(result.statusInput.incompleteReasons).toEqual(result.run.incompleteReasons);
    expect(result.statusInput).toMatchObject({
      preflightFailed: false,
      crawlLimitReached: true,
      requiredArtifactsValid: true,
      executionComplete: true,
      skippedRequiredWork: 2,
      failedRequiredWork: 0,
    });
    expect(Object.isFrozen(result.statusInput)).toBe(true);
    expect(Object.isFrozen(result.statusInput.incompleteReasons)).toBe(true);
  });

  it('records a false requiredArtifactsValid when a page does not match the page schema', async () => {
    const site: FakeSite = { [START_PATH]: { links: ['/invalid.html'] }, '/invalid.html': { schemaInvalid: true } };
    const result = await createHarness({ site }).coordinator.run();

    expect(result.statusInput.requiredArtifactsValid).toBe(false);
    expect(deriveRunStatus(result.statusInput)).toBe(result.run.runStatus);
  });

  it('keeps the input of a failed PREFLIGHT too', async () => {
    const result = await createHarness({ site: starSite(1), preflightOk: false }).coordinator.run();

    expect(result.statusInput.preflightFailed).toBe(true);
    expect(deriveRunStatus(result.statusInput)).toBe(result.run.runStatus);
    expect(result.run.runStatus).toBe('FAILED');
  });

  it('does not put the input into the run summary (it is not written to run.json)', async () => {
    const result = await createHarness({ site: starSite(1) }).coordinator.run();
    expect(Object.keys(result.run)).not.toContain('statusInput');
    expect(Object.keys(result).sort()).toEqual(['findings', 'pages', 'run', 'statusInput']);
  });
});
