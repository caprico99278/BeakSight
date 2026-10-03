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
import { ResourceCache } from '../../src/browser/resource-delivery.js';
import type { AuditConfig } from '../../src/config/types.js';
import { runArtifactDirectory } from '../../src/core/artifact-layout.js';
import {
  VIEWPORT_PROFILES,
  type AuditRunResult,
  type EvidenceRecord,
  type Finding,
  type IncompleteReason,
  type PageAuditOutcome,
  type PageAuditResult,
  type PageId,
  type RunEnvironment,
  type RunProgressReport,
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
import { LOAD_PEAK_WINDOW_MS, type LoadMeter } from '../../src/crawl/load-meter.js';
import { normalizeUrl } from '../../src/crawl/normalize-url.js';
import type { collectSiteMetadata, SiteMetadataResult } from '../../src/crawl/site-metadata.js';
import type { collectRunEnvironment } from '../../src/orchestration/environment.js';
import { createEvidenceRecord } from '../../src/orchestration/evidence-builder.js';
import { IdAllocator } from '../../src/orchestration/id-allocator.js';
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
  RunNotResumableError,
  RunResumeUnavailableError,
  type RunCoordinatorCheckpointConclusion,
  type RunCoordinatorDependencies,
  type RunCoordinatorResumeInput,
  type RunPageAuditor,
} from '../../src/orchestration/run-coordinator.js';
import {
  checkRunCheckpointConsistency,
  checkRunCheckpointPageConsistency,
  createRunCheckpoint,
  decideRunResumption,
  RUN_CHECKPOINT_PAGE_SCHEMA_VERSION,
  RUN_CHECKPOINT_SCHEMA_VERSION,
  type RunCheckpoint,
  type RunCheckpointInput,
  type RunCheckpointPage,
} from '../../src/orchestration/run-checkpoint.js';
import { createRunIdFromTime } from '../../src/orchestration/run-id.js';
import type {
  RunCheckpointSessionStart,
  RunCheckpointSessionStartOptions,
} from '../../src/orchestration/run-checkpoint-session.js';
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
  /**
   * Page の最後の Ledger（Mobile）に記録する、不変条件の違反の数（R4a2b-fix-round-1）。偽の Page Auditor は、ページの中の違反の確かめを
   * Desktop の後にだけ行うので、この違反は、ページの中の確かめでは見つからない（本物の Page Auditor で、ページの最後の Context の Ledger に
   * 記録された違反と同じ）。
   */
  readonly violationsAfterLastCheck?: number;
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
  /** 監査の呼び出しのたびに（試行ごとに）、監査の途中で呼ぶ（R4b2。監査の途中で止める印を付けるため）。 */
  readonly duringAudit?: () => void;
  /**
   * Desktop の `link` の Evidence の Link の一覧を、配列でない値にする（R4b2。`markFinished` の後、Link の取り出しで、巡回が予期しない
   * 例外で止まる形を作るため。page のスキーマにも合わない）。
   */
  readonly malformedLinks?: boolean;
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
  /**
   * 偽の Page Auditor が、注入された `navigationPacer` の待ちを終えて読み込みを始めた時刻（`nowMs`。読み込みの順。`paceNavigations` が
   * 真のときだけ記録する。R7b。再開の直後の最初の読み込みの開始を確かめるため）。
   */
  readonly navigationStartedAtMs: number[];
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

/**
 * 偽の Page Auditor。Evidence と Finding の ID は、注入された採番器で採番する（本物の Page Auditor と同じ）。
 * `paceNavigations` が真なら、本物と同じく、ビューポートごとに、注入された `navigationPacer` の待ちを呼ぶ（L2）。
 */
function fakePageAuditorFactory(
  site: FakeSite,
  world: FakeWorld,
  paceNavigations = false,
): (deps: PageAuditorDependencies) => RunPageAuditor {
  return (deps) => {
    world.createdAuditors.push(deps);
    const attemptsByUrl = new Map<string, number>();
    return {
      audit: async (url, pageId, auditAttempt) => {
        world.auditCalls.push({ url, pageId, attempt: auditAttempt });
        const spec = site[pathOf(url)] ?? {};
        spec.duringAudit?.();
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
          if (paceNavigations) {
            await deps.navigationPacer.beforeNavigation();
            world.navigationStartedAtMs.push(world.nowMs);
          }
          const reasons: IncompleteReason[] = [];
          if (navigation.outcome === 'OK' && profile === 'desktop') {
            record(createEvidenceRecord({
              type: 'link',
              pageId,
              viewport: profile,
              payload: {
                links: spec.malformedLinks === true
                  ? null as unknown as LinkEvidence[]
                  : (spec.links ?? []).map((href) => linkEvidence(pageId, url, href)),
                omittedLinkCount: 0,
              },
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
          if (profile === 'mobile') {
            recordViolations(ledger, spec.violationsAfterLastCheck ?? 0, 'TEST_VIOLATION');
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
   * 真なら、偽の metadata の取得と偽の Page Auditor が、本物と同じく、読み込みの前に間隔の待ちを呼ぶ（L2。サイトへの負荷の制御の
   * 設計書 4.1）。metadata は robots.txt と sitemap.xml の前に1回ずつ、Page Auditor はビューポートごとに1回呼ぶ。
   */
  readonly paceNavigations?: boolean;
  /** Run Coordinator に注入する、ページの読み込みの間隔の待ち（L2）。省略すると、本番の待ち。 */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Run Coordinator に注入する、進み具合の受け手（L7）。省略すると、渡さない。 */
  readonly onProgress?: RunCoordinatorDependencies['onProgress'];
  /** Run Coordinator に注入する、再開のための保存のセッション（R4a）。省略すると、渡さない。 */
  readonly checkpointSession?: RunCoordinatorDependencies['checkpointSession'];
  /** Run Coordinator に注入する、保存からの再開の入力（R4a2b）。省略すると、渡さない（新しい Run）。 */
  readonly resumeFrom?: RunCoordinatorDependencies['resumeFrom'];
  /** Run Coordinator に注入する時計（R4b1。保存の時刻を確かめるため）。省略すると、いつも `STARTED_AT` を返す。 */
  readonly clock?: () => Date;
  /** Run Coordinator に注入する止める印（R4b2。設計書 4.6.1）。省略すると、渡さない。 */
  readonly stopSignal?: RunCoordinatorDependencies['stopSignal'];
  /** 真なら、偽の環境の事実の収集が、予期しない例外を投げる（R4b2。`run()` が予期しない例外で reject する形を作るため）。 */
  readonly environmentThrows?: boolean;
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
    navigationStartedAtMs: [],
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
    if (options.environmentThrows === true) {
      throw new Error('fake environment failure');
    }
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
    if (options.paceNavigations === true) {
      // robots.txt と sitemap.xml の、それぞれの読み込みの前。
      for (let file = 0; file < 2; file += 1) {
        if (metadataOptions.beforeNavigation === undefined) {
          throw new Error('the site metadata must receive the navigation pacing');
        }
        await metadataOptions.beforeNavigation();
      }
    }
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
    clock: options.clock ?? (() => STARTED_AT),
    now: () => world.nowMs,
    outputDirectory,
    createPageAuditor: fakePageAuditorFactory(options.site, world, options.paceNavigations === true),
    collectSiteMetadata: metadata as unknown as typeof collectSiteMetadata,
    runPreflight: preflight as unknown as typeof runPreflight,
    ...(options.realEnvironmentFactory === undefined
      ? { collectRunEnvironment: environment as unknown as typeof collectRunEnvironment }
      : {}),
    readToolVersion: async () => '0.1.0-test',
    ...(options.browserCloseTimeoutMs === undefined ? {} : { browserCloseTimeoutMs: options.browserCloseTimeoutMs }),
    ...(options.deadlines === undefined ? {} : { deadlines: options.deadlines }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
    ...(options.checkpointSession === undefined ? {} : { checkpointSession: options.checkpointSession }),
    ...(options.resumeFrom === undefined ? {} : { resumeFrom: options.resumeFrom }),
    ...(options.stopSignal === undefined ? {} : { stopSignal: options.stopSignal }),
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

// L2（サイトへの負荷の制御の設計書 4.1）: Run Coordinator は、Run の初めにページの読み込みの間隔を守る部品（`NavigationPacer`）を
// 1つだけ作り、robots.txt と sitemap.xml の取得と、Page Auditor に、同じものを渡す。間隔は設定の `crawl.minNavigationIntervalMs`、
// 時刻は注入した `now`、待ちは注入した `sleep`（省略すると本番の待ち）である。
describe('RunCoordinator: one navigation pacer for the whole Run (load control design 4.1)', () => {
  const INTERVAL_MS = 5_000;

  it('paces the metadata and every page navigation with one pacer made from the setting, the clock and the injected sleep', async () => {
    const sleeps: number[] = [];
    let harness: Harness | undefined;
    harness = createHarness({
      site: { [START_PATH]: {} },
      config: { crawl: { minNavigationIntervalMs: INTERVAL_MS } },
      paceNavigations: true,
      sleep: async (ms) => {
        sleeps.push(ms);
        if (harness !== undefined) {
          harness.world.nowMs += ms;
        }
      },
    });
    const startedAtMs = harness.world.nowMs;
    const result = await harness.coordinator.run();

    // robots.txt（待たない）、sitemap.xml（間隔の全体）、Desktop（監査の 10ms を除いた残り）、Mobile（間隔の全体）。
    // Desktop の待ちが sitemap.xml の開始から数えた残りなので、metadata と Page Auditor は、同じ pacer を使っている。
    expect(sleeps).toEqual([INTERVAL_MS, INTERVAL_MS - DEFAULT_AUDIT_DURATION_MS, INTERVAL_MS]);
    expect(harness.world.createdAuditors).toHaveLength(1);
    expect(harness.world.createdAuditors[0]?.navigationPacer.snapshot()).toEqual({
      navigationCount: 4,
      totalWaitMs: 3 * INTERVAL_MS - DEFAULT_AUDIT_DURATION_MS,
      lastNavigationStartedAtMs: startedAtMs + 3 * INTERVAL_MS,
    });
    expect(result.run.runStatus).toBe('COMPLETE');
    await expectValidRun(result);
  });

  it('does not sleep when the interval setting is 0', async () => {
    const sleeps: number[] = [];
    const harness = createHarness({
      site: { [START_PATH]: {} },
      paceNavigations: true,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    await harness.coordinator.run();

    expect(sleeps).toEqual([]);
    expect(harness.world.createdAuditors[0]?.navigationPacer.snapshot()).toMatchObject({ navigationCount: 4, totalWaitMs: 0 });
  });

  it('rejects an injected sleep that is not a function with TypeError', () => {
    expect(() => createHarness({ site: { [START_PATH]: {} }, sleep: 'sleep' as unknown as (ms: number) => Promise<void> }))
      .toThrow(TypeError);
  });

  it('rejects the Run with RangeError before PREFLIGHT when the interval setting is not a non-negative safe integer', async () => {
    const harness = createHarness({ site: { [START_PATH]: {} }, config: { crawl: { minNavigationIntervalMs: -1 } } });

    await expect(harness.coordinator.run()).rejects.toThrow(RangeError);
    expect(harness.preflight).not.toHaveBeenCalled();
    expect(harness.launchBrowser).not.toHaveBeenCalled();
    expect(existsSync(harness.outputDirectory)).toBe(false);
  });
});

// L4（サイトへの負荷の制御の設計書 4.5）: Run Coordinator は、Run の初めに要求の実績を数える部品（`LoadMeter`）を1つだけ作り、
// PREFLIGHT に `contextFactoryOptions: { loadMeter }` で渡す（PREFLIGHT が、それを factory に渡す）。Run の結果の `load` は、
// Browser を閉じた後に、設定、pacer、meter の値から組み立てる。Run が早く終わった場合も、`load` は必ず入れる。
describe('RunCoordinator: the load record of the Run (load control design 4.5)', () => {
  const INTERVAL_MS = 5_000;
  /** 許可 Origin の外の URL（偽の要求の終わりの事象に使う）。 */
  const OTHER_URL = 'http://127.0.0.2:4173/tag.js';

  /** PREFLIGHT が受け取った `contextFactoryOptions` の meter。 */
  const meterOf = (options: Parameters<typeof runPreflight>[0]): LoadMeter => {
    const loadMeter = options.contextFactoryOptions?.loadMeter;
    if (loadMeter === undefined) {
      throw new Error('PREFLIGHT did not receive the load meter');
    }
    return loadMeter;
  };

  /**
   * 偽の PREFLIGHT を包み、受け取った meter を `received` に記録し、PREFLIGHT の Context の要求の終わりの事象を `onPreflight` で
   * 起こしてから、元の偽の PREFLIGHT を呼ぶ。
   */
  const wrapPreflight = (
    harness: Harness,
    onPreflight: (loadMeter: LoadMeter) => void,
  ): { readonly received: Parameters<typeof runPreflight>[0][] } => {
    const original = harness.preflight.getMockImplementation() as (options: Parameters<typeof runPreflight>[0]) => Promise<PreflightResult>;
    const received: Parameters<typeof runPreflight>[0][] = [];
    harness.preflight.mockImplementation(async (options: Parameters<typeof runPreflight>[0]) => {
      received.push(options);
      onPreflight(meterOf(options));
      return await original(options);
    });
    return { received };
  };

  it('passes one load meter to PREFLIGHT and records load from the setting, the pacer and the meter after the Browser is closed', async () => {
    let harness: Harness | undefined;
    harness = createHarness({
      site: { [START_PATH]: {} },
      config: { crawl: { minNavigationIntervalMs: INTERVAL_MS } },
      paceNavigations: true,
      sleep: async (ms) => {
        if (harness !== undefined) {
          harness.world.nowMs += ms;
        }
      },
    });
    const current = harness;
    const { received } = wrapPreflight(current, (loadMeter) => {
      loadMeter.recordRequestFinished({}, `${ORIGIN}/preflight-a.css`);
      loadMeter.recordRequestFinished({}, `${ORIGIN}/preflight-b.js`);
      loadMeter.recordRequestFailed({}, OTHER_URL, 'net::ERR_CONNECTION_REFUSED');
    });
    // Browser を閉じる間に届いた事象も、記録に入る（Browser を閉じた後の値で組み立てる）。1分より後に届けて、meter の時刻が
    // 注入した `now` であることも確かめる（直近の1分から、先の2件が外れる）。
    current.browserClose.mockImplementation(async () => {
      current.world.nowMs += LOAD_PEAK_WINDOW_MS;
      meterOf(received[0]!).recordRequestFinished({}, `${ORIGIN}/late.png`);
    });

    const result = await current.coordinator.run();

    expect(received).toHaveLength(1);
    // L5b: Run 全体のキャッシュも、同じ経路で渡す（`run cache` の describe で確かめる）。
    expect(Object.keys(received[0]?.contextFactoryOptions ?? {})).toEqual(['loadMeter', 'resourceCache']);
    const pacer = current.world.createdAuditors[0]?.navigationPacer.snapshot();
    expect(result.run.load).toEqual({
      minNavigationIntervalMs: INTERVAL_MS,
      maxInteractionsPerPage: current.config.crawl.maxInteractionsPerPage,
      navigationCount: pacer?.navigationCount,
      pacingWaitMs: pacer?.totalWaitMs,
      requests: {
        allowedOrigins: { count: 3, peakPerMinute: 2 },
        otherOrigins: { count: 1, peakPerMinute: 1 },
        servedFromCache: 0,
        withheldOtherOrigins: 0,
      },
    });
    expect(result.run.load.navigationCount).toBe(4);
    expect(result.run.load.pacingWaitMs).toBeGreaterThan(0);
    expect(Object.isFrozen(result.run.load.requests.allowedOrigins)).toBe(true);
    await expectValidRun(result);
  });

  it('records load with the requests counted so far when PREFLIGHT fails', async () => {
    const harness = createHarness({ site: { [START_PATH]: {} }, preflightOk: false });
    wrapPreflight(harness, (loadMeter) => {
      loadMeter.recordRequestFinished({}, `${ORIGIN}/preflight.css`);
    });

    const result = await harness.coordinator.run();

    expect(result.run.runStatus).toBe('FAILED');
    expect(result.run.load).toEqual({
      minNavigationIntervalMs: harness.config.crawl.minNavigationIntervalMs,
      maxInteractionsPerPage: harness.config.crawl.maxInteractionsPerPage,
      navigationCount: 0,
      pacingWaitMs: 0,
      requests: {
        allowedOrigins: { count: 1, peakPerMinute: 1 },
        otherOrigins: { count: 0, peakPerMinute: 0 },
        servedFromCache: 0,
        withheldOtherOrigins: 0,
      },
    });
    await expectValidRun(result);
  });

  // L5b（サイトへの負荷の制御の設計書 4.6）: Run 全体のキャッシュも、Run の初めに1つだけ作り、PREFLIGHT に `contextFactoryOptions`
  // で渡す（PREFLIGHT が factory に渡す）。Run ごとに新しく、空から始める（ファイルには書かない）。
  it('creates one empty Run cache per Run and passes it to PREFLIGHT with the load meter (L5b)', async () => {
    const caches: unknown[] = [];
    for (let run = 0; run < 2; run += 1) {
      const harness = createHarness({ site: { [START_PATH]: {} } });
      const { received } = wrapPreflight(harness, () => undefined);

      await harness.coordinator.run();

      expect(received).toHaveLength(1);
      const resourceCache = received[0]?.contextFactoryOptions?.resourceCache;
      expect(resourceCache).toBeInstanceOf(ResourceCache);
      expect(resourceCache?.stats()).toEqual({ entryCount: 0, totalBytes: 0 });
      caches.push(resourceCache);
    }
    expect(caches[0]).not.toBe(caches[1]);
  });

  it('records an empty load when the run directory cannot be created (PREFLIGHT does not run)', async () => {
    const outputDirectory = join(workDirectory, 'load-output-is-a-file');
    await writeFile(outputDirectory, 'not a directory', 'utf8');
    const harness = createHarness({ site: { [START_PATH]: {} }, outputDirectory });

    const error = await harness.coordinator.run().then(
      () => new Error('the Run was expected to reject with RunDirectoryUnavailableError'),
      (rejection: unknown) => rejection,
    );

    expect(error).toBeInstanceOf(RunDirectoryUnavailableError);
    const { run } = (error as RunDirectoryUnavailableError).result;
    expect(harness.preflight).not.toHaveBeenCalled();
    expect(run.load).toEqual({
      minNavigationIntervalMs: harness.config.crawl.minNavigationIntervalMs,
      maxInteractionsPerPage: harness.config.crawl.maxInteractionsPerPage,
      navigationCount: 0,
      pacingWaitMs: 0,
      requests: {
        allowedOrigins: { count: 0, peakPerMinute: 0 },
        otherOrigins: { count: 0, peakPerMinute: 0 },
        servedFromCache: 0,
        withheldOtherOrigins: 0,
      },
    });
    await expect(validateArtifact('run', run)).resolves.toEqual({ ok: true });
  });
});

// L7（サイトへの負荷の制御の設計書 4.8）: Run Coordinator は、ページの監査が1つ終わるたびに（`frontier.markFinished` と Link からの
// 発見の後に）、進み具合の事実を、注入された受け手（`onProgress`）に渡す。受け手がなければ何もしない。受け手の例外は、Run を止めず、
// Run の理由にもしない（表示の失敗で監査を止めないため）。
describe('RunCoordinator: the progress report after every audited page (load control design 4.8)', () => {
  const INTERVAL_MS = 5_000;
  /** 許可 Origin の外の URL（偽の要求の終わりの事象に使う）。 */
  const OTHER_URL = 'http://127.0.0.2:4173/tag.js';
  /** 3つのページ（開始のページが、2つのページにリンクする）。2つ目に監査するページは、監査に1分かかる。 */
  const progressSite: FakeSite = {
    [START_PATH]: { links: ['/a.html', '/b.html'] },
    '/a.html': { durationMs: LOAD_PEAK_WINDOW_MS },
    '/b.html': {},
  };

  /** PREFLIGHT の Context の要求の終わりの事象を、PREFLIGHT が受け取った meter に起こす（許可 Origin への2件と、外への1件）。 */
  const recordPreflightRequests = (harness: Harness): void => {
    const original = harness.preflight.getMockImplementation() as (options: Parameters<typeof runPreflight>[0]) => Promise<PreflightResult>;
    harness.preflight.mockImplementation(async (options: Parameters<typeof runPreflight>[0]) => {
      const loadMeter = options.contextFactoryOptions?.loadMeter;
      if (loadMeter === undefined) {
        throw new Error('PREFLIGHT did not receive the load meter');
      }
      loadMeter.recordRequestFinished({}, `${ORIGIN}/preflight-a.css`);
      loadMeter.recordRequestFinished({}, `${ORIGIN}/preflight-b.js`);
      loadMeter.recordRequestFinished({}, OTHER_URL);
      return await original(options);
    });
  };

  const expectDeeplyFrozen = (value: unknown, path: string): void => {
    if (typeof value !== 'object' || value === null) {
      return;
    }
    expect(Object.isFrozen(value), `${path} is frozen`).toBe(true);
    for (const [key, child] of Object.entries(value)) {
      expectDeeplyFrozen(child, `${path}.${key}`);
    }
  };

  it('calls the receiver once after every audited page, after its links are discovered, with the facts of that moment', async () => {
    const reports: RunProgressReport[] = [];
    const auditCallsAtReport: number[] = [];
    let harness: Harness | undefined;
    harness = createHarness({
      site: progressSite,
      onProgress: (report) => {
        reports.push(report);
        auditCallsAtReport.push(harness?.world.auditCalls.length ?? -1);
      },
    });
    recordPreflightRequests(harness);

    await harness.coordinator.run();

    // 次のページの監査を始める前に、毎回呼ぶ。
    expect(auditCallsAtReport).toEqual([1, 2, 3]);
    const requests = {
      allowedOrigins: { count: 2, peakPerMinute: 2 },
      otherOrigins: { count: 1, peakPerMinute: 1 },
      servedFromCache: 0,
      withheldOtherOrigins: 0,
    };
    // 1つ目のページの Link からの発見の後なので、発見したページは、最初の報告から3つ。偽の監査は、ページの読み込みの待ちを呼ばない。
    const common = { pagesDiscovered: 3, maxPages: harness.config.crawl.maxPages, navigationCount: 0, pacingWaitMs: 0, requests };
    expect(reports).toEqual([
      // PREFLIGHT の要求は、1つ目のページの後（10ms 後）には、直近の1分に入る。
      { ...common, pagesFinished: 1, elapsedMs: DEFAULT_AUDIT_DURATION_MS, recentPerMinute: { allowedOrigins: 2, otherOrigins: 1 } },
      // 2つ目のページの監査に1分かかったので、直近の1分から外れる（1分あたりの最大は変わらない）。
      {
        ...common,
        pagesFinished: 2,
        elapsedMs: DEFAULT_AUDIT_DURATION_MS + LOAD_PEAK_WINDOW_MS,
        recentPerMinute: { allowedOrigins: 0, otherOrigins: 0 },
      },
      {
        ...common,
        pagesFinished: 3,
        elapsedMs: 2 * DEFAULT_AUDIT_DURATION_MS + LOAD_PEAK_WINDOW_MS,
        recentPerMinute: { allowedOrigins: 0, otherOrigins: 0 },
      },
    ]);
    for (const [index, report] of reports.entries()) {
      expectDeeplyFrozen(report, `report ${String(index)}`);
      expect(JSON.parse(JSON.stringify(report))).toEqual(report);
    }
  });

  it('takes the navigation count and the pacing wait from the pacer of the Run, and the elapsed time from the injected clock', async () => {
    const reports: RunProgressReport[] = [];
    const pacerAtReport: { readonly navigationCount: number; readonly pacingWaitMs: number }[] = [];
    const nowAtReport: number[] = [];
    let harness: Harness | undefined;
    harness = createHarness({
      site: progressSite,
      config: { crawl: { minNavigationIntervalMs: INTERVAL_MS } },
      paceNavigations: true,
      sleep: async (ms) => {
        if (harness !== undefined) {
          harness.world.nowMs += ms;
        }
      },
      onProgress: (report) => {
        reports.push(report);
        const pacer = harness?.world.createdAuditors[0]?.navigationPacer.snapshot();
        pacerAtReport.push({ navigationCount: pacer?.navigationCount ?? -1, pacingWaitMs: pacer?.totalWaitMs ?? -1 });
        nowAtReport.push(harness?.world.nowMs ?? -1);
      },
    });
    const startedAtMs = harness.world.nowMs;

    await harness.coordinator.run();

    // robots.txt と sitemap.xml の2回と、ページごとに Desktop と Mobile の2回。
    expect(reports.map(({ navigationCount }) => navigationCount)).toEqual([4, 6, 8]);
    expect(reports.map(({ navigationCount, pacingWaitMs }) => ({ navigationCount, pacingWaitMs }))).toEqual(pacerAtReport);
    expect(reports.every(({ pacingWaitMs }) => pacingWaitMs > 0)).toBe(true);
    expect(reports.map(({ elapsedMs }) => elapsedMs)).toEqual(nowAtReport.map((nowMs) => nowMs - startedAtMs));
  });

  it('does not call the receiver for pages that were not audited (limits) or when PREFLIGHT fails', async () => {
    const limited: RunProgressReport[] = [];
    await createHarness({ site: progressSite, config: { crawl: { maxPages: 2 } }, onProgress: (report) => limited.push(report) })
      .coordinator.run();
    expect(limited.map(({ pagesFinished, pagesDiscovered, maxPages }) => ({ pagesFinished, pagesDiscovered, maxPages }))).toEqual([
      { pagesFinished: 1, pagesDiscovered: 3, maxPages: 2 },
      { pagesFinished: 2, pagesDiscovered: 3, maxPages: 2 },
    ]);

    const failed: RunProgressReport[] = [];
    const result = await createHarness({ site: progressSite, preflightOk: false, onProgress: (report) => failed.push(report) })
      .coordinator.run();
    expect(result.run.runStatus).toBe('FAILED');
    expect(failed).toEqual([]);
  });

  it('keeps the Run going without a new reason when the receiver throws: the Run is the same as without a receiver', async () => {
    const withoutReceiver = await createHarness({ site: progressSite }).coordinator.run();
    let calls = 0;
    const harness = createHarness({
      site: progressSite,
      onProgress: () => {
        calls += 1;
        throw new Error('progress display failed');
      },
    });

    const result = await harness.coordinator.run();

    expect(calls).toBe(3);
    expect(harness.world.auditCalls).toHaveLength(3);
    expect(result).toEqual(withoutReceiver);
    expect(result.statusInput.unhandledFailures).toBe(0);
    await expectValidRun(result);
  });

  it('keeps the Run going when the receiver returns a rejected promise', async () => {
    const withoutReceiver = await createHarness({ site: progressSite }).coordinator.run();
    let calls = 0;
    const harness = createHarness({
      site: progressSite,
      onProgress: async () => {
        calls += 1;
        throw new Error('asynchronous progress display failed');
      },
    });

    const result = await harness.coordinator.run();

    expect(calls).toBe(3);
    expect(result).toEqual(withoutReceiver);
  });

  it('rejects a receiver that is not a function with TypeError', () => {
    expect(() => createHarness({ site: progressSite, onProgress: 'print' as unknown as RunCoordinatorDependencies['onProgress'] }))
      .toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// R4a（中断した Run の再開の設計書 4.1、4.3、4.3.1）: 新しい Run の間の、再開のための保存（チェックポイント）の時期と中身と、
// 保存に失敗した場合の扱い。偽の保存のセッションで、Run Coordinator が頼んだ保存を記録する。
// ---------------------------------------------------------------------------------------------------------------

/** 偽の保存のセッションが受けた依頼の1件（`auditCalls` は、その時点で偽の Page Auditor が呼ばれた回数）。 */
type CheckpointCall =
  | {
    readonly kind: 'start';
    readonly runDirectory: string;
    readonly mode: string;
    readonly auditCalls: number;
    /** 依頼を受けた時点で、Run のディレクトリがあったか。 */
    readonly directoryExisted: boolean;
  }
  | { readonly kind: 'page'; readonly page: RunCheckpointPage; readonly auditCalls: number }
  | { readonly kind: 'state'; readonly state: RunCheckpoint; readonly auditCalls: number };

interface CheckpointRecorderOptions {
  /** 始める依頼の結果。省略すると `{ ok: true }`。 */
  readonly start?: () => Promise<RunCheckpointSessionStart>;
  /** この回数目（1から）のページの保存を、失敗させる。 */
  readonly failPageAt?: number;
  /** この回数目（1から）の状態の保存を、失敗させる。 */
  readonly failStateAt?: number;
}

const PAGE_CHECKPOINT_FAILURE_MESSAGE = 'page checkpoint write failed';
const STATE_CHECKPOINT_FAILURE_MESSAGE = 'state checkpoint write failed';

/** 偽の保存のセッション。受けた依頼を、受けた順に `calls` に記録する。`watch` で、記録に使うハーネスを結びつける。 */
function checkpointRecorder(options: CheckpointRecorderOptions = {}) {
  const calls: CheckpointCall[] = [];
  let world: FakeWorld | null = null;
  const auditCalls = (): number => world?.auditCalls.length ?? -1;
  let pageSaves = 0;
  let stateSaves = 0;
  const session = {
    start: vi.fn(async (runDirectory: string, startOptions: RunCheckpointSessionStartOptions): Promise<RunCheckpointSessionStart> => {
      calls.push({ kind: 'start', runDirectory, mode: startOptions.mode, auditCalls: auditCalls(), directoryExisted: existsSync(runDirectory) });
      return options.start === undefined ? { ok: true } : await options.start();
    }),
    savePage: vi.fn(async (page: RunCheckpointPage): Promise<void> => {
      pageSaves += 1;
      calls.push({ kind: 'page', page, auditCalls: auditCalls() });
      if (pageSaves === options.failPageAt) {
        throw new Error(PAGE_CHECKPOINT_FAILURE_MESSAGE);
      }
    }),
    saveState: vi.fn(async (state: RunCheckpoint): Promise<void> => {
      stateSaves += 1;
      calls.push({ kind: 'state', state, auditCalls: auditCalls() });
      if (stateSaves === options.failStateAt) {
        throw new Error(STATE_CHECKPOINT_FAILURE_MESSAGE);
      }
    }),
    // 最後の状態の書き出しと、やめることは、CLI が呼ぶ（Run Coordinator は呼ばない。設計書 4.3.1）。
    finish: vi.fn(async (): Promise<void> => undefined),
    abandon: vi.fn(async (): Promise<void> => undefined),
  };
  return {
    session,
    calls,
    watch: (harness: Harness): void => {
      world = harness.world;
    },
    states: (): RunCheckpoint[] => calls.flatMap((call) => (call.kind === 'state' ? [call.state] : [])),
    pages: (): RunCheckpointPage[] => calls.flatMap((call) => (call.kind === 'page' ? [call.page] : [])),
  };
}

/** 偽の保存のセッションを渡したハーネス。 */
function checkpointHarness(
  options: Omit<HarnessOptions, 'checkpointSession'>,
  recorderOptions: CheckpointRecorderOptions = {},
): { readonly harness: Harness; readonly recorder: ReturnType<typeof checkpointRecorder> } {
  const recorder = checkpointRecorder(recorderOptions);
  const harness = createHarness({ ...options, checkpointSession: recorder.session });
  recorder.watch(harness);
  return { harness, recorder };
}

/** 3つのページ（開始のページが、2つのページにリンクする）。 */
const CHECKPOINT_SITE: FakeSite = {
  [START_PATH]: { links: ['/a.html', '/b.html'] },
  '/a.html': {},
  '/b.html': {},
};

const CHECKPOINT_WRITE_FAILED_SKIP: IncompleteReason = { code: 'CHECKPOINT_WRITE_FAILED', detail: null };

const pageStates = (result: Awaited<ReturnType<RunCoordinator['run']>>) =>
  result.pages.map((page) => [pathOf(page.pageUrl), page.status, page.incompleteReasons] as const);

describe('RunCoordinator: checkpoints of a new Run (resumable run design 4.3, R4a)', () => {
  it('starts the session with NEW_RUN right after the run directory is created, before PREFLIGHT', async () => {
    const { harness, recorder } = checkpointHarness({ site: CHECKPOINT_SITE });

    const result = await harness.coordinator.run();

    expect(recorder.session.start).toHaveBeenCalledOnce();
    expect(recorder.calls[0]).toEqual({
      kind: 'start',
      runDirectory: runArtifactDirectory(harness.outputDirectory, result.run.runId),
      mode: 'NEW_RUN',
      auditCalls: 0,
      directoryExisted: true,
    });
    expect(recorder.session.start.mock.invocationCallOrder[0]).toBeLessThan(harness.preflight.mock.invocationCallOrder[0] ?? 0);
  });

  it('saves the state once after robots.txt and sitemap.xml, and then the page and the state after every audited page', async () => {
    const { harness, recorder } = checkpointHarness({ site: CHECKPOINT_SITE });

    const result = await harness.coordinator.run();

    expect(recorder.calls.map(({ kind, auditCalls }) => [kind, auditCalls])).toEqual([
      ['start', 0],
      ['state', 0],
      ['page', 1],
      ['state', 1],
      ['page', 2],
      ['state', 2],
      ['page', 3],
      ['state', 3],
    ]);
    expect(harness.metadata.mock.invocationCallOrder[0]).toBeLessThan(recorder.session.saveState.mock.invocationCallOrder[0] ?? 0);
    const pageIds = result.pages.map(({ pageId }) => pageId);
    expect(recorder.pages().map(({ pageId }) => pageId)).toEqual(pageIds);
    const states = recorder.states();
    expect(states.map(({ completedPageIds }) => completedPageIds)).toEqual([[], pageIds.slice(0, 1), pageIds.slice(0, 2), pageIds]);
    expect(states.map(({ progress }) => progress.pagesStarted)).toEqual([0, 1, 2, 3]);
    // 同じ状態の保存の中で、`markFinished` と `completedPageIds` が合い、Link から発見した URL が待ち行列にある。
    expect(states.map(({ frontier }) => frontier.entries.map(({ state }) => state))).toEqual([
      ['QUEUED'],
      ['AUDITED', 'QUEUED', 'QUEUED'],
      ['AUDITED', 'AUDITED', 'QUEUED'],
      ['AUDITED', 'AUDITED', 'AUDITED'],
    ]);
    // Run Coordinator は、最後の状態を書かず、セッションを終えもやめもしない（設計書 4.3.1）。
    expect(states.every(({ state }) => state === 'IN_PROGRESS')).toBe(true);
    expect(recorder.session.finish).not.toHaveBeenCalled();
    expect(recorder.session.abandon).not.toHaveBeenCalled();
  });

  it('saves values that match the checkpoint schemas and the R2 consistency checks', async () => {
    const { harness, recorder } = checkpointHarness({ site: CHECKPOINT_SITE });
    await harness.coordinator.run();

    expect(recorder.calls.length).toBeGreaterThan(1);
    let following: RunCheckpoint | undefined;
    for (const call of [...recorder.calls].reverse()) {
      if (call.kind === 'state') {
        await expect(validateArtifact('checkpoint', JSON.parse(JSON.stringify(call.state)))).resolves.toEqual({ ok: true });
        expect(checkRunCheckpointConsistency(call.state)).toEqual({ ok: true });
        following = call.state;
      } else if (call.kind === 'page') {
        await expect(validateArtifact('checkpoint-page', JSON.parse(JSON.stringify(call.page)))).resolves.toEqual({ ok: true });
        // ページの保存は、その後の状態の保存に載る。
        expect(following === undefined ? null : checkRunCheckpointPageConsistency(call.page, following)).toEqual({ ok: true });
      }
    }
  });

  it('keeps the identity, the execution, the setting, the progress, robots.txt and sitemap.xml, and the load of the Run', async () => {
    const { harness, recorder } = checkpointHarness({ site: CHECKPOINT_SITE });

    const result = await harness.coordinator.run();

    const states = recorder.states();
    expect(states).toHaveLength(4);
    const last = states.at(-1) as RunCheckpoint;
    const startedAt = STARTED_AT.toISOString();
    const metadataRecords = result.pages[0]?.evidence.filter(({ type }) => type === 'metadata');
    expect(metadataRecords).toHaveLength(2);
    for (const state of states) {
      expect(state).toMatchObject({
        schemaVersion: RUN_CHECKPOINT_SCHEMA_VERSION,
        state: 'IN_PROGRESS',
        runId: result.run.runId,
        toolVersion: '0.1.0-test',
        startedAt,
        executions: [{ startedAt, finishedAt: null, endReason: null, environment: ENVIRONMENT }],
        siteMetadata: { records: metadataRecords },
      });
      expect(state.effectiveConfig).toEqual(harness.config);
    }
    expect(last.progress).toEqual({
      reasons: [],
      retries: [],
      safetyViolationDetected: false,
      stoppedBySafetyViolation: false,
      unhandledFailures: 0,
      guardEnabled: true,
      preflightFailed: false,
      pagesStarted: 3,
    });
    // 採番器は、保存の時点の次の連番（Evidence は、出力のすべての Evidence の次）。
    const evidenceCount = result.pages.reduce((count, page) => count + page.evidence.length, 0);
    expect(last.allocator).toEqual({ nextPageSequence: 4, nextEvidenceSequence: evidenceCount + 1, nextFindingSequence: 1 });
    expect(last.load).toEqual({
      pacer: { navigationCount: result.run.load.navigationCount, totalWaitMs: result.run.load.pacingWaitMs, lastNavigationStartedAtMs: null },
      meter: result.run.load.requests,
    });
  });

  it('puts the Ledgers outside the pages in the state, and the Ledgers made in each page (with its retry) in its page checkpoint', async () => {
    const site: FakeSite = {
      [START_PATH]: { links: ['/a.html', '/b.html'] },
      '/a.html': { attempts: [{ outcome: 'TIMEOUT' }] },
      '/b.html': { blockedPosts: 2 },
    };
    const { harness, recorder } = checkpointHarness({ site });

    await harness.coordinator.run();

    // ページの外: PREFLIGHT の1つ、環境の事実の2つ（Desktop と Mobile）、robots.txt と sitemap.xml の取得の1つ。
    expect(recorder.states().map(({ safetyLedgerSnapshots }) => safetyLedgerSnapshots.length)).toEqual([4, 4, 4, 4]);
    // ページの中: 1回の試行で、Desktop と Mobile の2つ。/a.html は再試行したので、2回の試行の4つ。
    const pages = recorder.pages();
    expect(pages.map(({ safetyLedgerSnapshots }) => safetyLedgerSnapshots.length)).toEqual([2, 4, 2]);
    expect(pages[2]?.safetyLedgerSnapshots.map(({ blockedRequests }) => blockedRequests.length)).toEqual([2, 0]);
    // 再試行したページは、最終の試行の結果と、再試行の前の試行の Evidence を持つ。
    const [, firstAttempt, finalAttempt] = harness.world.auditOutcomes;
    expect(pages[1]).toEqual({
      schemaVersion: RUN_CHECKPOINT_PAGE_SCHEMA_VERSION,
      pageId: finalAttempt?.result.pageId,
      url: finalAttempt?.result.pageUrl,
      result: finalAttempt?.result,
      retryEvidence: firstAttempt?.result.evidence,
      safetyLedgerSnapshots: expect.any(Array),
    });
    expect(recorder.states()[2]?.progress.retries).toHaveLength(1);
  });

  it('puts the time of the injected clock when each state value is made into savedAt (R4b1, resumable run design 4.1)', async () => {
    const MINUTE_MS = 60_000;
    let world: FakeWorld | undefined;
    // 時計は、それまでに監査を始めたページの数だけ、1分ずつ進む（実行の開始の時刻のままでは、保存の時刻にならない）。
    const clock = (): Date => new Date(STARTED_AT.getTime() + (world?.auditCalls.length ?? 0) * MINUTE_MS);
    const { harness, recorder } = checkpointHarness({ site: CHECKPOINT_SITE, clock });
    world = harness.world;

    await harness.coordinator.run();

    const states = recorder.states();
    expect(states.map(({ savedAt }) => savedAt)).toEqual(
      [0, 1, 2, 3].map((pages) => new Date(STARTED_AT.getTime() + pages * MINUTE_MS).toISOString()),
    );
    expect(states.every(({ executions }) => executions[0].startedAt === STARTED_AT.toISOString())).toBe(true);
  });

  it('returns the same Run as without a session when every save succeeds', async () => {
    const withoutSession = await createHarness({ site: CHECKPOINT_SITE }).coordinator.run();
    const { harness, recorder } = checkpointHarness({ site: CHECKPOINT_SITE });

    const result = await harness.coordinator.run();

    expect(recorder.calls).toHaveLength(8);
    expect(result).toEqual(withoutSession);
  });

  it('saves the state with no metadata and the violation flags when a violation stopped the metadata collection', async () => {
    const { harness, recorder } = checkpointHarness({ site: CHECKPOINT_SITE, environmentViolations: 1 });

    const result = await harness.coordinator.run();

    expect(result.run.runStatus).toBe('ABORTED_BY_SAFETY');
    expect(recorder.calls.map(({ kind }) => kind)).toEqual(['start', 'state']);
    const [state] = recorder.states();
    expect(state?.siteMetadata).toBeNull();
    expect(state?.progress).toMatchObject({ safetyViolationDetected: true, stoppedBySafetyViolation: true });
    expect(state === undefined ? null : decideRunResumption(state)).toBe('FINALIZE_ONLY');
  });
});

describe('RunCoordinator: a checkpoint that cannot be written (resumable run design 4.3, R4a)', () => {
  it('starts no new page after a page checkpoint fails, skips the rest with CHECKPOINT_WRITE_FAILED, and is PARTIAL', async () => {
    const { harness, recorder } = checkpointHarness({ site: CHECKPOINT_SITE }, { failPageAt: 1 });

    const result = await harness.coordinator.run();

    expect(harness.world.auditCalls).toHaveLength(1);
    expect(recorder.calls.map(({ kind }) => kind)).toEqual(['start', 'state', 'page']);
    expect(pageStates(result)).toEqual([
      [START_PATH, 'AUDITED', []],
      ['/a.html', 'SKIPPED', [CHECKPOINT_WRITE_FAILED_SKIP]],
      ['/b.html', 'SKIPPED', [CHECKPOINT_WRITE_FAILED_SKIP]],
    ]);
    expect(result.run.incompleteReasons).toEqual([{ code: 'CHECKPOINT_WRITE_FAILED', detail: PAGE_CHECKPOINT_FAILURE_MESSAGE }]);
    expect(result.run.runStatus).toBe('PARTIAL');
    expect(deriveRunStatus(result.statusInput)).toBe('PARTIAL');
    expect(result.run.crawlLimits).toEqual({ maxPagesReached: false, maxDepthReached: false, maxRuntimeReached: false });
    expect(recorder.session.finish).not.toHaveBeenCalled();
    expect(recorder.session.abandon).not.toHaveBeenCalled();
    await expectValidRun(result);
  });

  it('starts no page when the state after robots.txt and sitemap.xml cannot be saved', async () => {
    const { harness, recorder } = checkpointHarness({ site: CHECKPOINT_SITE }, { failStateAt: 1 });

    const result = await harness.coordinator.run();

    expect(harness.world.auditCalls).toEqual([]);
    expect(recorder.calls.map(({ kind }) => kind)).toEqual(['start', 'state']);
    expect(pageStates(result)).toEqual([[START_PATH, 'SKIPPED', [CHECKPOINT_WRITE_FAILED_SKIP]]]);
    expect(result.run.incompleteReasons).toEqual([{ code: 'CHECKPOINT_WRITE_FAILED', detail: STATE_CHECKPOINT_FAILURE_MESSAGE }]);
    expect(result.run.runStatus).toBe('PARTIAL');
    await expectValidRun(result);
  });

  it('starts no new page when the state after a page cannot be saved', async () => {
    const { harness, recorder } = checkpointHarness({ site: CHECKPOINT_SITE }, { failStateAt: 2 });

    const result = await harness.coordinator.run();

    expect(harness.world.auditCalls).toHaveLength(1);
    expect(recorder.calls.map(({ kind }) => kind)).toEqual(['start', 'state', 'page', 'state']);
    expect(pageStates(result).map(([path, status]) => [path, status])).toEqual([
      [START_PATH, 'AUDITED'],
      ['/a.html', 'SKIPPED'],
      ['/b.html', 'SKIPPED'],
    ]);
    expect(codesOf(result.run.incompleteReasons)).toEqual(['CHECKPOINT_WRITE_FAILED']);
    expect(result.run.runStatus).toBe('PARTIAL');
  });

  it('adds the Run reason and is PARTIAL even when no URL is left after the failed save', async () => {
    const { harness } = checkpointHarness({ site: { [START_PATH]: {} } }, { failPageAt: 1 });

    const result = await harness.coordinator.run();

    expect(pageStates(result)).toEqual([[START_PATH, 'AUDITED', []]]);
    expect(codesOf(result.run.incompleteReasons)).toEqual(['CHECKPOINT_WRITE_FAILED']);
    expect(result.run.runStatus).toBe('PARTIAL');
  });

  it('checks a violation before the failed save, and the failed save before the page limit', async () => {
    const violation = await checkpointHarness(
      { site: { ...CHECKPOINT_SITE, [START_PATH]: { links: ['/a.html', '/b.html'], violations: 1 } } },
      { failPageAt: 1 },
    ).harness.coordinator.run();
    expect(pageStates(violation).slice(1).map(([, , reasons]) => codesOf(reasons))).toEqual([
      ['SAFETY_VIOLATION_ABORT'],
      ['SAFETY_VIOLATION_ABORT'],
    ]);
    expect(codesOf(violation.run.incompleteReasons)).toEqual(['SAFETY_VIOLATION_ABORT', 'CHECKPOINT_WRITE_FAILED']);
    expect(violation.run.runStatus).toBe('ABORTED_BY_SAFETY');

    const limited = await checkpointHarness({ site: CHECKPOINT_SITE, config: { crawl: { maxPages: 1 } } }, { failPageAt: 1 })
      .harness.coordinator.run();
    expect(pageStates(limited).slice(1).map(([, , reasons]) => reasons)).toEqual([
      [CHECKPOINT_WRITE_FAILED_SKIP],
      [CHECKPOINT_WRITE_FAILED_SKIP],
    ]);
    expect(limited.run.crawlLimits.maxPagesReached).toBe(false);
    expect(codesOf(limited.run.incompleteReasons)).toEqual(['CHECKPOINT_WRITE_FAILED']);
  });

  it.each([
    ['the lock already exists', async (): Promise<RunCheckpointSessionStart> => ({ ok: false, existingLock: null }), 'checkpoint lock already exists'],
    ['the lock cannot be written', async (): Promise<RunCheckpointSessionStart> => Promise.reject(new Error('lock write failed')), 'lock write failed'],
  ] as const)('finishes FAILED without PREFLIGHT, the browser, or the site when the session cannot start because %s', async (_name, start, detail) => {
    const { harness, recorder } = checkpointHarness({ site: CHECKPOINT_SITE }, { start });

    const result = await harness.coordinator.run();

    expect(harness.preflight).not.toHaveBeenCalled();
    expect(harness.launchBrowser).not.toHaveBeenCalled();
    expect(harness.metadata).not.toHaveBeenCalled();
    expect(harness.world.createdAuditors).toEqual([]);
    expect(recorder.calls.map(({ kind }) => kind)).toEqual(['start']);
    // Run のディレクトリを作れなかった場合と同じく、Run Status の入力 `preflightFailed` で `FAILED` になる（ARCH05）。
    expect(result.run.runStatus).toBe('FAILED');
    expect(result.statusInput.preflightFailed).toBe(true);
    expect(deriveRunStatus(result.statusInput)).toBe('FAILED');
    expect(result.run.incompleteReasons).toEqual([{ code: 'CHECKPOINT_WRITE_FAILED', detail }]);
    expect(result.run.safety.guardEnabled).toBe(false);
    expect(result.pages).toEqual([]);
    expect(harness.environment).toHaveBeenCalledWith(expect.objectContaining({ browser: null, factory: null }));
    await expectValidRun(result);
  });

  it('rejects a session that does not have the start, savePage and saveState functions with TypeError', () => {
    for (const session of ['session', { start: async () => ({ ok: true }) }, { ...checkpointRecorder().session, saveState: undefined }]) {
      expect(() => createHarness({
        site: CHECKPOINT_SITE,
        checkpointSession: session as unknown as RunCoordinatorDependencies['checkpointSession'],
      })).toThrow(TypeError);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// R4a2b（中断した Run の再開の設計書 3.1、3.2、4.1、4.4、4.9）: 保存からの再開。偽の保存のセッションで記録した新しい Run の保存
// （状態の保存と、ページの保存）を再開の入力（`resumeFrom`）にして、新しい Run Coordinator（新しいプロセスを模す）で続きを監査する。
// 記録した Run は、すべての保存に成功した、中断しなかった Run でもある（保存のない Run と同じ結果になる。R4a）。偽の Page Auditor、
// 偽の PREFLIGHT、偽の環境の事実は、同じ入力に同じ結果を返し、時計も同じなので、再開した Run の結果は、中断しなかった Run と全く同じになる。
// ---------------------------------------------------------------------------------------------------------------

/**
 * Run の結果から、実行の記録（`run.executions`）を除いたもの（R4b2。中断した Run の再開の設計書 4.8）。再開した Run は、前の回の実行の
 * 記録も持つので、中断しなかった Run と比べるときは、実行の記録を除いて比べる（実行の記録は、R4b2 のテストで別に確かめる）。
 */
function withoutExecutions(result: AuditRunResult): unknown {
  const { executions: _executions, ...run } = result.run;
  return { ...result, run };
}

/** 偽の保存のセッションが、再開の始め方（`RESUME`）に返す結果（始められた。後始末で消したものはない）。 */
const RESUME_STARTED = async (): Promise<RunCheckpointSessionStart> => ({ ok: true, removedPaths: [] });

const SAFETY_VIOLATION_ABORT_SKIP: IncompleteReason = { code: 'SAFETY_VIOLATION_ABORT', detail: null };

/** 偽の保存のセッションを渡した新しい Run を行い、その結果と、記録した保存を返す（再開の入力の元で、中断しなかった Run でもある）。 */
async function recordedRun(options: Omit<HarnessOptions, 'checkpointSession' | 'resumeFrom'>) {
  const { harness, recorder } = checkpointHarness(options);
  const result = await harness.coordinator.run();
  return { harness, recorder, result };
}

type RecordedRun = Awaited<ReturnType<typeof recordedRun>>;

/** 記録した Run の、終わったページがちょうど `completed` の最初の状態の保存。 */
function savedStateAfter(recorded: RecordedRun, completed: number): RunCheckpoint {
  const state = recorded.recorder.states().find(({ completedPageIds }) => completedPageIds.length === completed);
  if (state === undefined) {
    throw new Error(`no checkpoint state after ${String(completed)} page(s)`);
  }
  return state;
}

/**
 * 記録した Run の、`completed` ページを終えた時点の保存から、再開の入力を作る（その時点でプロセスが終わったことを模す）。ページの保存は、
 * その状態の保存に載ったもの（終わった順）。`changes` を渡すと、状態の保存のその項目を置き換える（`createRunCheckpoint` で作り直す）。
 */
function resumeInputAfter(
  recorded: RecordedRun,
  completed: number,
  changes: Partial<RunCheckpointInput> = {},
): RunCoordinatorResumeInput {
  const { schemaVersion: _schemaVersion, ...input } = savedStateAfter(recorded, completed);
  return resumeInputFrom(recorded, createRunCheckpoint({ ...input, ...changes }));
}

/**
 * 記録した Run の Run のディレクトリと、状態の保存 `checkpoint` から、再開の入力を作る。ページの保存は、`checkpoint` に載ったもの（終わった順）を、
 * 記録した Run のページの保存から取る（R4b2 では、最後の状態の保存 `checkpointConclusion()` の値を渡す）。
 */
function resumeInputFrom(recorded: RecordedRun, checkpoint: RunCheckpoint): RunCoordinatorResumeInput {
  const pages = recorded.recorder.pages();
  return {
    runDirectory: runArtifactDirectory(recorded.harness.outputDirectory, recorded.result.run.runId),
    checkpoint,
    pages: checkpoint.completedPageIds.map((pageId) => {
      const page = pages.find((saved) => saved.pageId === pageId);
      if (page === undefined) {
        throw new Error(`no page checkpoint of ${pageId}`);
      }
      return page;
    }),
  };
}

/** 再開の入力と、偽の保存のセッション（始め方の結果は `start`。既定は、始められる）を渡したハーネス。 */
function resumedHarness(
  options: Omit<HarnessOptions, 'checkpointSession' | 'resumeFrom'>,
  resumeFrom: RunCoordinatorResumeInput,
  start: () => Promise<RunCheckpointSessionStart> = RESUME_STARTED,
): ReturnType<typeof checkpointHarness> {
  return checkpointHarness({ ...options, resumeFrom }, { start });
}

describe('RunCoordinator: resuming a Run from its checkpoint (resumable run design 3.1, 3.2, 4.1, R4a2b)', () => {
  it('audits only the rest with the same IDs, does not collect robots.txt and sitemap.xml again, and returns the same Run as without the interruption', async () => {
    const site: FakeSite = {
      [START_PATH]: { links: ['/a.html', '/b.html'], finding: true },
      '/a.html': { links: ['/c.html'], finding: true },
      '/b.html': { blockedPosts: 1, finding: true },
      '/c.html': {},
    };
    const options = { site, sitemapUrls: [START_PATH, '/a.html', '/orphan.html'] };
    const uninterrupted = await recordedRun(options);
    const resumeFrom = resumeInputAfter(uninterrupted, 2);
    const { harness, recorder } = resumedHarness(options, resumeFrom);

    const result = await harness.coordinator.run();

    // 終わったページ（開始のページと /a.html）は監査し直さず、残りのページを、中断しなかった Run と同じページの ID で監査する。
    const audited = (calls: readonly AuditCall[]): (string | PageId)[][] => calls.map(({ url, pageId }) => [pathOf(url), pageId]);
    expect(audited(harness.world.auditCalls)).toEqual(audited(uninterrupted.harness.world.auditCalls.slice(2)));
    // robots.txt と sitemap.xml は取得し直さない。sitemap は、保存の Evidence から作り直す（sitemap の Finding も同じになる）。
    expect(harness.metadata).not.toHaveBeenCalled();
    const [, sitemapRecord] = uninterrupted.result.pages[0]?.evidence.filter(({ type }) => type === 'metadata') ?? [];
    expect(sitemapRecord).toBeDefined();
    expect(uninterrupted.result.findings.filter(({ evidenceRefs }) =>
      sitemapRecord !== undefined && evidenceRefs.includes(sitemapRecord.evidenceId)).length).toBeGreaterThan(0);
    // ページ、Evidence、Finding の ID、Run Status、Safety の集計（再開の前のページの遮断を含む）、Run Status の入力が、中断しなかった
    // Run と同じ（時計も同じなので、時刻も同じになる）。
    expect(result.run.safety.blockedActions.requests).toBe(1);
    expect(withoutExecutions(result)).toEqual(withoutExecutions(uninterrupted.result));
    await expectValidRun(result);
    // 保存のセッションは、前の回の Run のディレクトリで、再開の始め方（終わったページの ID）で始める。PREFLIGHT の前である。
    expect(recorder.calls[0]).toEqual({ kind: 'start', runDirectory: resumeFrom.runDirectory, mode: 'RESUME', auditCalls: 0, directoryExisted: true });
    expect(recorder.session.start).toHaveBeenCalledWith(resumeFrom.runDirectory, {
      mode: 'RESUME',
      completedPageIds: resumeFrom.checkpoint.completedPageIds,
    });
    expect(recorder.session.start.mock.invocationCallOrder[0]).toBeLessThan(harness.preflight.mock.invocationCallOrder[0] ?? 0);
    // Run のディレクトリは作らない（前の回のものを使う）。PREFLIGHT は、そのディレクトリで行う。
    expect(existsSync(harness.outputDirectory)).toBe(false);
    expect(harness.preflight).toHaveBeenCalledWith(expect.objectContaining({ outputDirectory: resumeFrom.runDirectory }));
  });

  it('keeps saving from the saved progress: the earlier pages, the Ledgers outside the pages, the executions and the start of the Run stay', async () => {
    const uninterrupted = await recordedRun({ site: CHECKPOINT_SITE });
    const resumeFrom = resumeInputAfter(uninterrupted, 1);
    const saved = resumeFrom.checkpoint;
    const { harness, recorder } = resumedHarness({ site: CHECKPOINT_SITE }, resumeFrom);

    await harness.coordinator.run();

    const pageIds = uninterrupted.result.pages.map(({ pageId }) => pageId);
    // 再開の後も、robots.txt と sitemap.xml の段階の後に状態の保存を1回行い、各ページの後にページと状態を保存する。
    expect(recorder.calls.map(({ kind, auditCalls }) => [kind, auditCalls])).toEqual([
      ['start', 0],
      ['state', 0],
      ['page', 1],
      ['state', 1],
      ['page', 2],
      ['state', 2],
    ]);
    // ページの保存は、この実行で終えたページだけ。終わったページの ID は、前の回の分に続ける（消えない）。
    expect(recorder.pages().map(({ pageId }) => pageId)).toEqual(pageIds.slice(1));
    const states = recorder.states();
    expect(states.map(({ completedPageIds }) => completedPageIds)).toEqual([pageIds.slice(0, 1), pageIds.slice(0, 2), pageIds]);
    expect(states.map(({ progress }) => progress.pagesStarted)).toEqual([1, 2, 3]);
    for (const state of states) {
      // Run の ID、版、最初の実行の開始の時刻は、保存のまま。実行の記録は、保存のもの（前の回の途中で終わった実行は、R4b1 で
      // `INTERRUPTED_ABNORMALLY` に閉じる。設計書 4.8）に、この実行の分を1件加える。
      expect(state).toMatchObject({ state: 'IN_PROGRESS', runId: saved.runId, toolVersion: saved.toolVersion, startedAt: saved.startedAt });
      expect(state.executions).toEqual([
        ...saved.executions.map((execution) => ({ ...execution, finishedAt: saved.savedAt, endReason: 'INTERRUPTED_ABNORMALLY' })),
        { startedAt: STARTED_AT.toISOString(), finishedAt: null, endReason: null, environment: ENVIRONMENT },
      ]);
      // ページの外の Ledger: 前の回の4つ（PREFLIGHT、環境の事実の2つ、robots.txt と sitemap.xml）に続けて、この実行の3つ（PREFLIGHT、
      // 環境の事実の2つ）。
      expect(state.safetyLedgerSnapshots.slice(0, saved.safetyLedgerSnapshots.length)).toEqual(saved.safetyLedgerSnapshots);
      expect(state.safetyLedgerSnapshots).toHaveLength(saved.safetyLedgerSnapshots.length + 3);
      expect(state.siteMetadata).toEqual(saved.siteMetadata);
      await expect(validateArtifact('checkpoint', JSON.parse(JSON.stringify(state)))).resolves.toEqual({ ok: true });
      expect(checkRunCheckpointConsistency(state)).toEqual({ ok: true });
    }
    // 最後の状態の保存の巡回の記録、採番器、進み具合は、中断しなかった Run の最後のものと同じ。
    const last = states.at(-1);
    const uninterruptedLast = uninterrupted.recorder.states().at(-1);
    expect(last?.frontier).toEqual(uninterruptedLast?.frontier);
    expect(last?.allocator).toEqual(uninterruptedLast?.allocator);
    expect(last?.progress).toEqual(uninterruptedLast?.progress);
  });

  it('uses the Run ID, the start and the environment of the first execution, and counts the runtime limit from the start of this execution', async () => {
    const options = {
      site: { ...CHECKPOINT_SITE, [START_PATH]: { links: ['/a.html', '/b.html'], durationMs: 1_000 }, '/a.html': { durationMs: 1_000 } },
      config: { crawl: { maxRuntimeMs: 1_500 } },
    };
    const uninterrupted = await recordedRun(options);
    // 中断しなかった Run は、/b.html の前に実行時間の上限に達する。
    expect(pageStates(uninterrupted.result).map(([path, status]) => [path, status])).toEqual([
      [START_PATH, 'AUDITED'],
      ['/a.html', 'AUDITED'],
      ['/b.html', 'SKIPPED'],
    ]);
    const firstStartedAt = '2026-09-20T00:00:00.000Z';
    const firstEnvironment: RunEnvironment = { ...ENVIRONMENT, nodeVersion: 'v24.0.0-first' };
    const saved = savedStateAfter(uninterrupted, 1);
    const resumeFrom = resumeInputAfter(uninterrupted, 1, {
      runId: createRunIdFromTime(new Date(firstStartedAt)),
      startedAt: firstStartedAt,
      executions: [{ ...saved.executions[0], startedAt: firstStartedAt, environment: firstEnvironment }],
    });
    const { harness } = resumedHarness(options, resumeFrom);

    const result = await harness.coordinator.run();

    expect(result.run.runId).toBe(resumeFrom.checkpoint.runId);
    expect(result.run.startedAt).toBe(firstStartedAt);
    expect(result.run.finishedAt).toBe(STARTED_AT.toISOString());
    // `run.json` の環境は、最初の実行のもの（設計書 4.8）。
    expect(result.run.environment).toEqual(firstEnvironment);
    // この実行の開始から数えるので、/a.html と /b.html を監査できる。
    expect(harness.world.auditCalls.map(({ url }) => pathOf(url))).toEqual(['/a.html', '/b.html']);
    expect(result.run.runStatus).toBe('COMPLETE');
  });

  it('restores the Run reasons, the page limit and the failure count from the saved progress', async () => {
    const options = { site: CHECKPOINT_SITE, metadataPageCloseFails: true, config: { crawl: { maxPages: 2 } } };
    const uninterrupted = await recordedRun(options);
    expect(codesOf(uninterrupted.result.run.incompleteReasons)).toEqual(['MAX_PAGES_REACHED', 'UNHANDLED_FAILURE']);
    const { harness } = resumedHarness({ ...options, metadataPageCloseFails: false }, resumeInputAfter(uninterrupted, 1));

    const result = await harness.coordinator.run();

    // 監査を始めたページの数は、保存の値から続ける（ページ数の上限で /b.html を始めない）。metadata の閉じる処理の失敗の理由は、
    // 保存の理由から引き継ぐ（1件だけ）。
    expect(harness.world.auditCalls.map(({ url }) => pathOf(url))).toEqual(['/a.html']);
    expect(withoutExecutions(result)).toEqual(withoutExecutions(uninterrupted.result));

    // 未処理の失敗の件数も、保存の値から続ける（中断しなかった Run は COMPLETE だが、前の回の未処理の失敗があれば PARTIAL になる）。
    const complete = await recordedRun({ site: CHECKPOINT_SITE });
    expect(complete.result.run.runStatus).toBe('COMPLETE');
    const saved = savedStateAfter(complete, 1);
    const failed = await resumedHarness(
      { site: CHECKPOINT_SITE },
      resumeInputAfter(complete, 1, { progress: { ...saved.progress, unhandledFailures: 1 } }),
    ).harness.coordinator.run();
    expect(failed.statusInput.unhandledFailures).toBe(1);
    expect(failed.run.runStatus).toBe(deriveRunStatus(failed.statusInput));
    expect(failed.run.runStatus).toBe('PARTIAL');
  });

  it('keeps the earlier attempt of a retried page and its retry record from the saved page', async () => {
    const site: FakeSite = {
      [START_PATH]: { links: ['/a.html', '/b.html'] },
      '/a.html': { attempts: [{ outcome: 'TIMEOUT' }] },
      '/b.html': {},
    };
    const uninterrupted = await recordedRun({ site });
    const { harness } = resumedHarness({ site }, resumeInputAfter(uninterrupted, 2));

    const result = await harness.coordinator.run();

    expect(harness.world.auditCalls.map(({ url }) => pathOf(url))).toEqual(['/b.html']);
    expect(result.run.retries).toHaveLength(1);
    expect(result.pages[1]?.evidence.map(({ evidenceId }) => evidenceId)).toEqual(
      expect.arrayContaining([...(result.run.retries[0]?.evidenceIds ?? [])]),
    );
    expect(withoutExecutions(result)).toEqual(withoutExecutions(uninterrupted.result));
  });

  it.each([
    ['its runtime limit', 'MAX_RUNTIME_REACHED', 'STOPPED_BY_RUNTIME_LIMIT'],
    ['a stop signal (R4b1)', 'RUN_INTERRUPTED', 'STOPPED_BY_SIGNAL'],
  ] as const)('audits again the URLs that a stopped execution skipped at %s (RESUME_REQUEUE_SKIP_REASON_CODES)', async (_name, code, endReason) => {
    const uninterrupted = await recordedRun({ site: CHECKPOINT_SITE });
    const saved = savedStateAfter(uninterrupted, 1);
    const frontier = {
      entries: saved.frontier.entries.map((entry) => (entry.state === 'QUEUED'
        ? { ...entry, state: 'SKIPPED' as const, skipReason: { code, detail: null } }
        : entry)),
    };
    // STOPPED の保存の最後の実行の記録は、終わり方と終わりの時刻を持つ（R4b1 の整合。設計書 4.8）。
    const stoppedExecution = { ...saved.executions[0], finishedAt: saved.savedAt, endReason };
    const resumeFrom = resumeInputAfter(uninterrupted, 1, { state: 'STOPPED', frontier, executions: [stoppedExecution] });
    expect(checkRunCheckpointConsistency(resumeFrom.checkpoint)).toEqual({ ok: true });
    expect(decideRunResumption(resumeFrom.checkpoint)).toBe('RESUME');
    const { harness, recorder } = resumedHarness({ site: CHECKPOINT_SITE }, resumeFrom);

    const result = await harness.coordinator.run();

    expect(harness.world.auditCalls.map(({ url }) => pathOf(url))).toEqual(['/a.html', '/b.html']);
    expect(withoutExecutions(result)).toEqual(withoutExecutions(uninterrupted.result));
    // 終わり方を持つ実行の記録は、閉じ直さない（そのまま残し、この実行の分を加える）。
    for (const state of recorder.states()) {
      expect(state.executions).toEqual([
        stoppedExecution,
        { startedAt: STARTED_AT.toISOString(), finishedAt: null, endReason: null, environment: ENVIRONMENT },
      ]);
      expect(checkRunCheckpointConsistency(state)).toEqual({ ok: true });
    }
  });

  it.each([
    ['the first execution was interrupted', 1],
    ['an earlier execution is already closed and the second one was interrupted', 2],
  ] as const)(
    'closes the execution that the previous process left unfinished, with INTERRUPTED_ABNORMALLY at the time of its last save, when %s (R4b1)',
    async (_name, executionCount) => {
      const uninterrupted = await recordedRun({ site: CHECKPOINT_SITE });
      const saved = savedStateAfter(uninterrupted, 1);
      const [first] = saved.executions;
      // 前の回の最後の保存の時刻（この実行の開始の時刻とは違う時刻にして、どちらを使ったかを区別する）。
      const previousSavedAt = '2026-09-30T23:30:00.000Z';
      const closedEarlier = { ...first, startedAt: '2026-09-30T22:00:00.000Z', finishedAt: '2026-09-30T22:10:00.000Z', endReason: 'INTERRUPTED_ABNORMALLY' as const };
      const unfinished = { ...first, startedAt: '2026-09-30T23:00:00.000Z' };
      const executions: RunCheckpoint['executions'] = executionCount === 1 ? [unfinished] : [closedEarlier, unfinished];
      const resumeFrom = resumeInputAfter(uninterrupted, 1, { savedAt: previousSavedAt, executions });
      expect(resumeFrom.checkpoint.state).toBe('IN_PROGRESS');
      expect(checkRunCheckpointConsistency(resumeFrom.checkpoint)).toEqual({ ok: true });
      const { harness, recorder } = resumedHarness({ site: CHECKPOINT_SITE }, resumeFrom);

      await harness.coordinator.run();

      const states = recorder.states();
      expect(states).toHaveLength(3);
      for (const state of states) {
        expect(state.executions).toEqual([
          ...(executionCount === 1 ? [] : [closedEarlier]),
          { ...unfinished, finishedAt: previousSavedAt, endReason: 'INTERRUPTED_ABNORMALLY' },
          { startedAt: STARTED_AT.toISOString(), finishedAt: null, endReason: null, environment: ENVIRONMENT },
        ]);
        // この実行の保存の時刻は、この実行の時計の値。
        expect(state.savedAt).toBe(STARTED_AT.toISOString());
        await expect(validateArtifact('checkpoint', JSON.parse(JSON.stringify(state)))).resolves.toEqual({ ok: true });
        expect(checkRunCheckpointConsistency(state)).toEqual({ ok: true });
      }
      // 再開の入力の保存は変えない。
      expect(resumeFrom.checkpoint.executions.at(-1)).toEqual(unfinished);
    },
  );

  it('counts the pages finished before the interruption in the progress report', async () => {
    const uninterrupted = await recordedRun({ site: CHECKPOINT_SITE });
    const reports: RunProgressReport[] = [];
    const { harness } = resumedHarness(
      { site: CHECKPOINT_SITE, onProgress: (report) => reports.push(report) },
      resumeInputAfter(uninterrupted, 1),
    );

    await harness.coordinator.run();

    expect(reports.map(({ pagesFinished, pagesDiscovered }) => [pagesFinished, pagesDiscovered])).toEqual([[2, 3], [3, 3]]);
  });

  it('continues the navigation pacing and the load record from the saved load (load control design 4.1, resumable run design 4.9)', async () => {
    const INTERVAL_MS = 5_000;
    /** 前の回の最後の読み込みの開始から、再開した実行の開始までの時間。 */
    const SINCE_LAST_NAVIGATION_MS = 1_000;
    const config = { crawl: { minNavigationIntervalMs: INTERVAL_MS } };
    const uninterrupted = await recordedRun({ site: CHECKPOINT_SITE, config });
    expect(savedStateAfter(uninterrupted, 1).load.pacer.lastNavigationStartedAtMs).toBeNull();
    // 前の回の最後の読み込みの開始は、前の回の時計の最後の時刻とする。
    const lastNavigationStartedAtMs = uninterrupted.harness.world.nowMs;
    const load = {
      pacer: { navigationCount: 7, totalWaitMs: 1_200, lastNavigationStartedAtMs },
      meter: {
        allowedOrigins: { count: 40, peakPerMinute: 12 },
        otherOrigins: { count: 3, peakPerMinute: 2 },
        servedFromCache: 5,
        withheldOtherOrigins: 1,
      },
    };
    const sleeps: number[] = [];
    let harness: Harness | undefined;
    harness = resumedHarness(
      {
        site: CHECKPOINT_SITE,
        config,
        paceNavigations: true,
        sleep: async (ms) => {
          sleeps.push(ms);
          if (harness !== undefined) {
            harness.world.nowMs += ms;
          }
        },
      },
      resumeInputAfter(uninterrupted, 1, { load }),
    ).harness;
    // 再開した実行は、前の回の最後の読み込みの開始の1秒後に始まる。
    harness.world.nowMs = lastNavigationStartedAtMs + SINCE_LAST_NAVIGATION_MS;

    const result = await harness.coordinator.run();

    // 再開の直後の最初の読み込み（/a.html の Desktop。偽の監査の 10ms の後）は、この実行の開始から、間隔の全体を空ける（前の回の最後の
    // 読み込みの開始は、この実行の開始より前なので、そこからも間隔以上空く）。
    // R7b（設計書 4.9 の最後の項目。RR の Minor-1）で決まりが変わったので、期待する値を直した（前は「間隔 − 前の回の最後の読み込みからの
    // 時間 − 偽の監査の時間」）。最後の読み込みの開始の時刻を、保存の値と、この実行の開始の時刻の遅い方にする決まりで、待ちは前より長く
    // なる（条件を弱めた直しではない）。
    expect(sleeps[0]).toBe(INTERVAL_MS - DEFAULT_AUDIT_DURATION_MS);
    expect(sleeps[0]).toBeGreaterThan(INTERVAL_MS - SINCE_LAST_NAVIGATION_MS - DEFAULT_AUDIT_DURATION_MS);
    // 読み込みは、/a.html と /b.html の、Desktop と Mobile の4回。回数と待ちの合計は、保存の値から続ける。
    expect(sleeps).toHaveLength(4);
    expect(result.run.load.navigationCount).toBe(load.pacer.navigationCount + 4);
    expect(result.run.load.pacingWaitMs).toBe(load.pacer.totalWaitMs + sleeps.reduce((sum, ms) => sum + ms, 0));
    // 要求の実績も、保存の値から続ける（偽の Run は、要求の事象を起こさない）。PREFLIGHT に渡した meter も、保存の値から始まる。
    expect(result.run.load.requests).toEqual(load.meter);
    const preflightOptions = harness.preflight.mock.calls[0]?.[0] as Parameters<typeof runPreflight>[0] | undefined;
    expect(preflightOptions?.contextFactoryOptions?.loadMeter?.snapshot()).toEqual(load.meter);
  });

  // R7b（中断した Run の再開の設計書 4.9 の最後の項目。RR の Minor-1）: 監査の途中のページの読み込みは保存に入らないので、保存の「最後の
  // 読み込みの開始の時刻」は、前の回の実際の最後の読み込みより前になりうる（2回目の Ctrl+C で、そのページの保存の前に終わった場合など）。
  // 再開した実行の最初の読み込みは、この実行の開始から最小の間隔の後に始まるので、実際の最後の読み込みからも、最小の間隔以上空く。
  it('starts the first navigation of a resumed execution the minimum interval after the start of the execution, so also after the unsaved last navigation (RR Minor-1)', async () => {
    const INTERVAL_MS = 5_000;
    const config = { crawl: { minNavigationIntervalMs: INTERVAL_MS } };
    const uninterrupted = await recordedRun({ site: CHECKPOINT_SITE, config });
    // 前の回の、保存に入った最後の読み込みの開始。
    const savedLastNavigationStartedAtMs = uninterrupted.harness.world.nowMs;
    // 前の回は、その後に監査の途中のページの読み込みを始め、そのページの保存の前に終わった（この読み込みは、保存に入らない）。
    const unsavedLastNavigationStartedAtMs = savedLastNavigationStartedAtMs + 3_000;
    // 再開した実行は、その直後（実際の最後の読み込みから、最小の間隔がたつ前）に始まる。
    const executionStartedAtMs = unsavedLastNavigationStartedAtMs + 500;
    const saved = savedStateAfter(uninterrupted, 1);
    const load = { ...saved.load, pacer: { ...saved.load.pacer, lastNavigationStartedAtMs: savedLastNavigationStartedAtMs } };
    let harness: Harness | undefined;
    harness = resumedHarness(
      {
        site: CHECKPOINT_SITE,
        config,
        paceNavigations: true,
        sleep: async (ms) => {
          if (harness !== undefined) {
            harness.world.nowMs += ms;
          }
        },
      },
      resumeInputAfter(uninterrupted, 1, { load }),
    ).harness;
    harness.world.nowMs = executionStartedAtMs;

    await harness.coordinator.run();

    const [firstNavigationStartedAtMs] = harness.world.navigationStartedAtMs;
    expect(firstNavigationStartedAtMs).toBe(executionStartedAtMs + INTERVAL_MS);
    expect((firstNavigationStartedAtMs ?? 0) - unsavedLastNavigationStartedAtMs).toBeGreaterThanOrEqual(INTERVAL_MS);
  });

  it('continues the pacing of a resumed execution from the later of the saved last navigation start and the start of the execution, keeping the saved count and wait (resumable run design 4.9)', async () => {
    const config = { crawl: { minNavigationIntervalMs: 5_000 } };
    const uninterrupted = await recordedRun({ site: CHECKPOINT_SITE, config });
    const saved = savedStateAfter(uninterrupted, 1);
    const executionStartedAtMs = uninterrupted.harness.world.nowMs + 60_000;
    // [名前, 保存の最後の読み込みの開始の時刻, 再開した実行の pacer の最後の読み込みの開始の時刻]。保存の値がこの実行の開始より後になるのは、
    // 時計が戻った場合である。
    const cases: readonly (readonly [string, number | null, number])[] = [
      ['earlier than the start of the execution', executionStartedAtMs - 1_000, executionStartedAtMs],
      ['null', null, executionStartedAtMs],
      ['later than the start of the execution (the clock went back)', executionStartedAtMs + 1_000, executionStartedAtMs + 1_000],
    ];
    for (const [name, savedLastNavigationStartedAtMs, expected] of cases) {
      const pacer = { navigationCount: 7, totalWaitMs: 1_200, lastNavigationStartedAtMs: savedLastNavigationStartedAtMs };
      const { harness, recorder } = resumedHarness(
        { site: CHECKPOINT_SITE, config },
        resumeInputAfter(uninterrupted, 1, { load: { ...saved.load, pacer } }),
      );
      harness.world.nowMs = executionStartedAtMs;

      await harness.coordinator.run();

      // 再開の後の最初の状態の保存（robots.txt と sitemap.xml の段階の後。読み込みの前）の pacer の値は、pacer の `initial` の値である。
      // 回数と待ちの合計は、保存の値のまま。
      expect(recorder.states()[0]?.load.pacer, name).toEqual({ navigationCount: 7, totalWaitMs: 1_200, lastNavigationStartedAtMs: expected });
    }
  });
});

describe('RunCoordinator: resuming after a safety invariant violation (resumable run design 3.2, R4a2b)', () => {
  const VIOLATION_SITE: FakeSite = {
    [START_PATH]: { links: ['/a.html', '/b.html'] },
    '/a.html': { violations: 1 },
    '/b.html': {},
  };

  it.each([
    ['the saved violation flags', false],
    ['only a saved Ledger snapshot, with the saved flags rewritten to false (the guard of R4a2b)', true],
  ] as const)('starts no new page after a violation found in %s, and is ABORTED_BY_SAFETY as without the interruption', async (_name, clearFlags) => {
    const uninterrupted = await recordedRun({ site: VIOLATION_SITE });
    expect(uninterrupted.result.run.runStatus).toBe('ABORTED_BY_SAFETY');
    const saved = savedStateAfter(uninterrupted, 2);
    expect(saved.progress).toMatchObject({ safetyViolationDetected: true, stoppedBySafetyViolation: true });
    // フラグを消した保存は、保存のフラグが偽で、保存した snapshot に違反がある場合を模す（R4a2b の守り）。Run Coordinator は、各ページの
    // 保存の前に、そのページの Ledger を調べてフラグを立てる（R4a2b-fix-round-1）ので、この形の保存は、保存の値を書き換えたときにだけできる。
    const resumeFrom = resumeInputAfter(uninterrupted, 2, clearFlags
      ? { progress: { ...saved.progress, safetyViolationDetected: false, stoppedBySafetyViolation: false } }
      : {});
    expect(decideRunResumption(resumeFrom.checkpoint)).toBe(clearFlags ? 'RESUME' : 'FINALIZE_ONLY');
    const { harness, recorder } = resumedHarness({ site: VIOLATION_SITE }, resumeFrom);

    const result = await harness.coordinator.run();

    expect(harness.world.auditCalls).toEqual([]);
    expect(harness.metadata).not.toHaveBeenCalled();
    expect(pageStates(result)).toEqual([
      [START_PATH, 'AUDITED', []],
      ['/a.html', 'AUDITED', []],
      ['/b.html', 'SKIPPED', [SAFETY_VIOLATION_ABORT_SKIP]],
    ]);
    expect(result.run.runStatus).toBe('ABORTED_BY_SAFETY');
    expect(deriveRunStatus(result.statusInput)).toBe('ABORTED_BY_SAFETY');
    expect(result.run.safety.invariantViolationCount).toBe(1);
    expect(result.run.incompleteReasons).toEqual([SAFETY_VIOLATION_ABORT_SKIP]);
    expect(withoutExecutions(result)).toEqual(withoutExecutions(uninterrupted.result));
    // 新しいページを始めないので、ページの保存はない。
    expect(recorder.pages()).toEqual([]);
  });

  it('does not collect robots.txt and sitemap.xml again or repeat its reason when a violation stopped them before the interruption', async () => {
    const uninterrupted = await recordedRun({ site: CHECKPOINT_SITE, environmentViolations: 1 });
    const resumeFrom = resumeInputAfter(uninterrupted, 0);
    expect(resumeFrom.checkpoint.siteMetadata).toBeNull();
    expect(decideRunResumption(resumeFrom.checkpoint)).toBe('FINALIZE_ONLY');
    // この実行の環境の事実には、違反がない（違反は、保存の snapshot にだけある）。
    const { harness } = resumedHarness({ site: CHECKPOINT_SITE }, resumeFrom);

    const result = await harness.coordinator.run();

    expect(harness.metadata).not.toHaveBeenCalled();
    expect(harness.world.auditCalls).toEqual([]);
    expect(result.run.incompleteReasons).toEqual([SAFETY_VIOLATION_ABORT_SKIP, { code: 'SAFETY_VIOLATION_ABORT', detail: 'site-metadata' }]);
    expect(result.run.runStatus).toBe('ABORTED_BY_SAFETY');
    expect(withoutExecutions(result)).toEqual(withoutExecutions(uninterrupted.result));
  });
});

// R4a2b-fix-round-1（中断した Run の再開の設計書 4.2 の最後の項目、5章）: 保存の「違反の検出」のフラグは、各ページの保存の前に、そのページの
// Ledger を調べてから書く。ページの中の最後の確かめの後に記録された違反（ページの最後の Ledger の違反）も、そのページの保存のフラグに入る。
// 「止めた」ことの記録（`stoppedBySafetyViolation`）は、実際に監査を始めなかったときだけに行う（今の決まりのまま）。Run の結果は変わらない。
describe('RunCoordinator: the violation flag of the checkpoint saved after each page (resumable run design 4.2, R4a2b-fix-round-1)', () => {
  /** /a.html の最後の Ledger（Mobile）に、ページの中の確かめの後で、違反を記録するサイト。 */
  const LATE_VIOLATION_SITE: FakeSite = {
    [START_PATH]: { links: ['/a.html', '/b.html'] },
    '/a.html': { violationsAfterLastCheck: 1 },
    '/b.html': {},
  };
  const flagsOf = ({ progress }: RunCheckpoint): readonly [boolean, boolean] =>
    [progress.safetyViolationDetected, progress.stoppedBySafetyViolation];

  it('sets the detection flag of the state saved after the page with the violation, without the stop flag before the rest is stopped', async () => {
    const { harness, recorder } = checkpointHarness({ site: LATE_VIOLATION_SITE });

    const result = await harness.coordinator.run();

    // ページの中の確かめ（Desktop の後）では、違反は見つからない。
    expect(harness.world.safetyChecks).toEqual([false, false]);
    expect(recorder.calls.map(({ kind }) => kind)).toEqual(['start', 'state', 'page', 'state', 'page', 'state']);
    // 違反のページの保存は、違反を記録した Ledger の snapshot を持つ。その後の状態の保存は、検出のフラグが真で、止めたフラグは偽のまま
    // （残りの URL を止めるのは、次のページを始める前の確かめ）。
    expect(recorder.pages()[1]?.safetyLedgerSnapshots.map(({ invariantViolationCount }) => invariantViolationCount)).toEqual([0, 1]);
    const states = recorder.states();
    expect(states.map(flagsOf)).toEqual([[false, false], [false, false], [true, false]]);
    expect(decideRunResumption(states[2] as RunCheckpoint)).toBe('FINALIZE_ONLY');
    // Run の結果は、今と同じ（違反の後のページは始めず、SKIPPED にする。保存のセッションがない Run とも同じ）。
    expect(harness.world.auditCalls.map(({ url }) => pathOf(url))).toEqual([START_PATH, '/a.html']);
    expect(pageStates(result)).toEqual([
      [START_PATH, 'AUDITED', []],
      ['/a.html', 'AUDITED', []],
      ['/b.html', 'SKIPPED', [SAFETY_VIOLATION_ABORT_SKIP]],
    ]);
    expect(result.run.runStatus).toBe('ABORTED_BY_SAFETY');
    expect(deriveRunStatus(result.statusInput)).toBe('ABORTED_BY_SAFETY');
    expect(result.run.incompleteReasons).toEqual([SAFETY_VIOLATION_ABORT_SKIP]);
    expect(result).toEqual(await createHarness({ site: LATE_VIOLATION_SITE }).coordinator.run());
  });

  it('adds no SAFETY_VIOLATION_ABORT to the Run reasons when the violation is on the last page and no URL is left', async () => {
    const site: FakeSite = { [START_PATH]: { violationsAfterLastCheck: 1 } };
    const { harness, recorder } = checkpointHarness({ site });

    const concluded = await concludedRun(harness);

    const result = concluded.result;
    if (result === null) {
      throw new Error('the Run did not return a result');
    }
    expect(result.run.runStatus).toBe('ABORTED_BY_SAFETY');
    expect(deriveRunStatus(result.statusInput)).toBe('ABORTED_BY_SAFETY');
    expect(result.run.safety.invariantViolationCount).toBe(1);
    // 監査を始めなかったものはないので、止めたことの理由は付けない（今の振る舞い）。
    expect(pageStates(result)).toEqual([[START_PATH, 'AUDITED', []]]);
    expect(result.run.incompleteReasons).toEqual([]);
    // そのページの後の状態の保存と、最後の状態の保存は、検出のフラグが真で、止めたフラグは偽。
    expect(recorder.states().map(flagsOf)).toEqual([[false, false], [true, false]]);
    const checkpoint = await expectFinishCheckpoint(concluded, 'FINISHED');
    expect(flagsOf(checkpoint)).toEqual([true, false]);
    expect(checkpoint.executions.at(-1)?.endReason).toBe('STOPPED_BY_SAFETY_VIOLATION');
    expect(result).toEqual(await createHarness({ site }).coordinator.run());
  });

  it('only finalizes the Run resumed from the state saved after the page with the violation, as without the interruption', async () => {
    const uninterrupted = await recordedRun({ site: LATE_VIOLATION_SITE });
    const resumeFrom = resumeInputAfter(uninterrupted, 2);
    expect(flagsOf(resumeFrom.checkpoint)).toEqual([true, false]);
    expect(decideRunResumption(resumeFrom.checkpoint)).toBe('FINALIZE_ONLY');
    const { harness, recorder } = resumedHarness({ site: LATE_VIOLATION_SITE }, resumeFrom);

    const result = await harness.coordinator.run();

    expect(harness.world.auditCalls).toEqual([]);
    expect(harness.metadata).not.toHaveBeenCalled();
    expect(recorder.pages()).toEqual([]);
    expect(result.run.runStatus).toBe('ABORTED_BY_SAFETY');
    expect(result.run.incompleteReasons).toEqual([SAFETY_VIOLATION_ABORT_SKIP]);
    expect(withoutExecutions(result)).toEqual(withoutExecutions(uninterrupted.result));
  });

  // R4a2b-fix-round-2: robots.txt と sitemap.xml の取得の後の状態の保存も、各ページの保存と同じく、Ledger を調べてからフラグを書く
  // （調べる範囲は、取得で作った Ledger を含む、Run の初めからのすべての Ledger。R5-fix-round-1）。
  it('sets the detection flag of the state saved after robots.txt and sitemap.xml when their Ledger records a violation, without the stop flag', async () => {
    const options = { site: CHECKPOINT_SITE, metadataViolations: 1 };
    const { harness, recorder } = checkpointHarness(options);

    const result = await harness.coordinator.run();

    expect(harness.metadata).toHaveBeenCalledOnce();
    expect(recorder.calls.map(({ kind }) => kind)).toEqual(['start', 'state']);
    // 取得の後の状態の保存（最初の状態の保存）は、検出のフラグが真で、止めたフラグは偽のまま（最初のページを止めるのは、ページを
    // 始める前の確かめ）。その保存の後にプロセスが終わった場合の再開の判定は、違反で止まる実際の動きと合う。
    const [afterMetadata] = recorder.states();
    if (afterMetadata === undefined) {
      throw new Error('the state after robots.txt and sitemap.xml was not saved');
    }
    expect(flagsOf(afterMetadata)).toEqual([true, false]);
    expect(decideRunResumption(afterMetadata)).toBe('FINALIZE_ONLY');
    // Run の結果は、今と同じ（違反の後のページは始めず、SKIPPED にする。保存のセッションがない Run とも同じ）。
    expect(harness.world.auditCalls).toEqual([]);
    expect(pageStates(result)).toEqual([[START_PATH, 'SKIPPED', [SAFETY_VIOLATION_ABORT_SKIP]]]);
    expect(result.run.runStatus).toBe('ABORTED_BY_SAFETY');
    expect(deriveRunStatus(result.statusInput)).toBe('ABORTED_BY_SAFETY');
    expect(result.run.incompleteReasons).toEqual([SAFETY_VIOLATION_ABORT_SKIP]);
    expect(result.run.safety.invariantViolations).toEqual([{ code: 'METADATA_VIOLATION', message: 'METADATA_VIOLATION 0' }]);
    expect(result).toEqual(await createHarness(options).coordinator.run());
  });

  // R5-fix-round-1（設計書 4.2 の最後の項目）: robots.txt と sitemap.xml の取得の後の状態の保存の前は、Run の初めからのすべての Ledger
  // （この実行の PREFLIGHT と環境の記録のものと、保存した snapshot を含む。どれも閉じている）を調べる。再開した実行で、robots.txt と
  // sitemap.xml を保存から作り直した場合も、この実行の PREFLIGHT の Ledger の違反が、その保存のフラグに入る。
  it('sets the detection flag of the state saved after robots.txt and sitemap.xml restored from the checkpoint, when the PREFLIGHT Ledger of the resumed execution records a violation', async () => {
    const uninterrupted = await recordedRun({ site: CHECKPOINT_SITE });
    const resumeFrom = resumeInputAfter(uninterrupted, 1);
    expect(resumeFrom.checkpoint.siteMetadata).not.toBeNull();
    expect(flagsOf(resumeFrom.checkpoint)).toEqual([false, false]);
    expect(decideRunResumption(resumeFrom.checkpoint)).toBe('RESUME');
    const { harness, recorder } = resumedHarness({ site: CHECKPOINT_SITE, preflightViolations: 1 }, resumeFrom);

    const result = await harness.coordinator.run();

    // robots.txt と sitemap.xml は、保存から作り直す（取得し直さない）。
    expect(harness.metadata).not.toHaveBeenCalled();
    expect(recorder.calls.map(({ kind }) => kind)).toEqual(['start', 'state']);
    // Run の結果は、今と同じ（違反の後のページは始めず、SKIPPED にする。止めたことの理由は1件）。
    expect(harness.world.auditCalls).toEqual([]);
    expect(pageStates(result)).toEqual([
      [START_PATH, 'AUDITED', []],
      ['/a.html', 'SKIPPED', [SAFETY_VIOLATION_ABORT_SKIP]],
      ['/b.html', 'SKIPPED', [SAFETY_VIOLATION_ABORT_SKIP]],
    ]);
    expect(result.run.runStatus).toBe('ABORTED_BY_SAFETY');
    expect(deriveRunStatus(result.statusInput)).toBe('ABORTED_BY_SAFETY');
    expect(result.run.incompleteReasons).toEqual([SAFETY_VIOLATION_ABORT_SKIP]);
    expect(result.run.safety.invariantViolations).toEqual([{ code: 'PREFLIGHT_VIOLATION', message: 'PREFLIGHT_VIOLATION 0' }]);
    // 取得の後の状態の保存は、検出のフラグが真で、止めたフラグは偽のまま（最初のページを止めるのは、ページを始める前の確かめ）。
    // その保存の後にプロセスが終わった場合の再開の判定は、違反で止まる実際の動きと合う。
    const [afterMetadata] = recorder.states();
    if (afterMetadata === undefined) {
      throw new Error('the state after robots.txt and sitemap.xml was not saved');
    }
    expect(afterMetadata.siteMetadata).toEqual(resumeFrom.checkpoint.siteMetadata);
    expect(flagsOf(afterMetadata)).toEqual([true, false]);
    expect(decideRunResumption(afterMetadata)).toBe('FINALIZE_ONLY');
  });
});

describe('RunCoordinator: a resume that cannot start (resumable run design 4.4, R4a2b)', () => {
  const ACTIVE_LOCK = Object.freeze({ processId: 4242, bootedAtMs: 1, acquiredAtMs: 2, heartbeatAtMs: 3 });

  it('rejects with RunNotResumableError and does nothing when the checkpoint is not resumable', async () => {
    const uninterrupted = await recordedRun({ site: CHECKPOINT_SITE });
    const resumeFrom = resumeInputAfter(uninterrupted, 3, { state: 'FINISHED' });
    expect(decideRunResumption(resumeFrom.checkpoint)).toBe('NOT_RESUMABLE');
    const { harness, recorder } = resumedHarness({ site: CHECKPOINT_SITE }, resumeFrom);

    const rejection = harness.coordinator.run();

    await expect(rejection).rejects.toBeInstanceOf(RunNotResumableError);
    await expect(rejection).rejects.toMatchObject({
      runId: resumeFrom.checkpoint.runId,
      runDirectory: resumeFrom.runDirectory,
      checkpointState: 'FINISHED',
    });
    expect(recorder.calls).toEqual([]);
    expect(harness.preflight).not.toHaveBeenCalled();
    expect(harness.launchBrowser).not.toHaveBeenCalled();
    expect(harness.environment).not.toHaveBeenCalled();
    expect(harness.metadata).not.toHaveBeenCalled();
    expect(existsSync(harness.outputDirectory)).toBe(false);
  });

  it.each([
    [
      'the lock is held by a running Run',
      async (): Promise<RunCheckpointSessionStart> => ({ ok: false, reason: 'LOCK_HELD_BY_ACTIVE_RUN', existingLock: ACTIVE_LOCK }),
      'LOCK_HELD_BY_ACTIVE_RUN',
      ACTIVE_LOCK,
    ],
    [
      'another process remade the stale lock at the same time',
      async (): Promise<RunCheckpointSessionStart> => ({ ok: false, reason: 'LOCK_TAKEN_OVER_CONCURRENTLY', existingLock: ACTIVE_LOCK }),
      'LOCK_TAKEN_OVER_CONCURRENTLY',
      ACTIVE_LOCK,
    ],
    [
      'the store cannot write',
      async (): Promise<RunCheckpointSessionStart> => Promise.reject(new Error('lock write failed')),
      'CHECKPOINT_STORE_FAILED',
      null,
    ],
  ] as const)('rejects with RunResumeUnavailableError without PREFLIGHT, the browser, or a Run when %s', async (_name, start, reason, existingLock) => {
    const uninterrupted = await recordedRun({ site: CHECKPOINT_SITE });
    const resumeFrom = resumeInputAfter(uninterrupted, 1);
    const { harness, recorder } = resumedHarness({ site: CHECKPOINT_SITE }, resumeFrom, start);

    const rejection = harness.coordinator.run();

    await expect(rejection).rejects.toBeInstanceOf(RunResumeUnavailableError);
    await expect(rejection).rejects.toMatchObject({
      runId: resumeFrom.checkpoint.runId,
      runDirectory: resumeFrom.runDirectory,
      reason,
      existingLock,
    });
    if (reason === 'CHECKPOINT_STORE_FAILED') {
      await expect(rejection).rejects.toMatchObject({ cause: expect.objectContaining({ message: 'lock write failed' }) });
    }
    expect(recorder.calls.map(({ kind }) => kind)).toEqual(['start']);
    expect(harness.preflight).not.toHaveBeenCalled();
    expect(harness.launchBrowser).not.toHaveBeenCalled();
    expect(harness.environment).not.toHaveBeenCalled();
    expect(harness.metadata).not.toHaveBeenCalled();
    expect(harness.world.createdAuditors).toEqual([]);
  });

  it('rejects a resume input without a checkpoint session, or with a broken shape, with TypeError', async () => {
    const resumeFrom = resumeInputAfter(await recordedRun({ site: CHECKPOINT_SITE }), 1);

    expect(() => createHarness({ site: CHECKPOINT_SITE, resumeFrom })).toThrow(TypeError);
    for (const broken of [
      null,
      'resume',
      { ...resumeFrom, runDirectory: '' },
      { ...resumeFrom, checkpoint: null },
      { ...resumeFrom, pages: 'pages' },
    ]) {
      expect(() => checkpointHarness({
        site: CHECKPOINT_SITE,
        resumeFrom: broken as unknown as RunCoordinatorResumeInput,
      })).toThrow(TypeError);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// R4b2（中断した Run の再開の設計書 3.2、4.3.2、4.6、4.6.1、4.8）: 止める印、`run.json` の実行の記録、Run の後の保存の終わり方
// （`checkpointConclusion()`）と、最後の状態の保存の中身（巡回の終わりの値）。
// ---------------------------------------------------------------------------------------------------------------

const RUN_INTERRUPTED_SKIP: IncompleteReason = { code: 'RUN_INTERRUPTED', detail: null };
const NO_CRAWL_LIMITS = Object.freeze({ maxPagesReached: false, maxDepthReached: false, maxRuntimeReached: false });

/** 開始のページ（その監査の途中で、止める印を付ける）と、そこからリンクする2つのページ。 */
function stoppingSite(controller: AbortController, startSpec: FakePageSpec = {}): FakeSite {
  return {
    ...CHECKPOINT_SITE,
    [START_PATH]: { links: ['/a.html', '/b.html'], ...startSpec, duringAudit: () => controller.abort() },
  };
}

/** Run の結果（reject した場合は `null` と、その値）と、その後の保存の終わり方。 */
interface ConcludedRun {
  readonly result: AuditRunResult | null;
  readonly error: unknown;
  readonly conclusion: RunCoordinatorCheckpointConclusion;
}

/** Run を行い（reject も受け取る）、その後に保存の終わり方を読む（CLI と同じ順）。 */
async function concludedRun(harness: Harness): Promise<ConcludedRun> {
  let result: AuditRunResult | null = null;
  let error: unknown = null;
  try {
    result = await harness.coordinator.run();
  } catch (caught) {
    error = caught;
  }
  return { result, error, conclusion: harness.coordinator.checkpointConclusion() };
}

/** 保存の終わり方が `FINISH` なら、その最後の状態の保存を返す（ほかの終わり方なら、テストを失敗させる）。 */
function finishCheckpointOf(conclusion: RunCoordinatorCheckpointConclusion): RunCheckpoint {
  if (conclusion.action !== 'FINISH') {
    throw new Error(`the checkpoint conclusion is ${conclusion.action}, not FINISH`);
  }
  return conclusion.checkpoint;
}

/**
 * 保存の終わり方が `FINISH` で、最後の状態の保存の状態が `state` であることを確かめ、その保存を返す（設計書 4.3.2、4.8）。
 * - 保存の時刻と、この実行の記録の終わりの時刻は、`run.json` の `finishedAt` と同じ。
 * - 実行の記録は、`run.json` の実行の記録に、各実行の環境を加えたもの（この実行の環境は、この実行のもの）。
 * - スキーマ（`checkpoint`）と、R2 の整合の確かめを通る。凍結している。
 * - 出力の書き出しに失敗しても `finish` を行うか（`finishEvenIfOutputFails`）は、Run Status が `ABORTED_BY_SAFETY` のときだけ真（R7c）。
 */
async function expectFinishCheckpoint(concluded: ConcludedRun, state: 'FINISHED' | 'STOPPED'): Promise<RunCheckpoint> {
  const { result, conclusion } = concluded;
  expect(conclusion.action).toBe('FINISH');
  const checkpoint = finishCheckpointOf(conclusion);
  if (result === null) {
    throw new Error('the Run did not return a result');
  }
  // R7c（設計書 4.10）: 出力の書き出しに失敗しても `finish` を行うのは、違反を検出した Run だけ（判定の値を写す）。
  expect(conclusion).toMatchObject({ finishEvenIfOutputFails: result.run.runStatus === 'ABORTED_BY_SAFETY' });
  expect(checkpoint.state).toBe(state);
  expect(checkpoint.runId).toBe(result.run.runId);
  expect(checkpoint.startedAt).toBe(result.run.startedAt);
  expect(checkpoint.savedAt).toBe(result.run.finishedAt);
  expect(checkpoint.executions.at(-1)).toEqual({ ...result.run.executions.at(-1), environment: ENVIRONMENT });
  expect(checkpoint.executions.map(({ environment: _environment, ...execution }) => execution)).toEqual(result.run.executions);
  await expect(validateArtifact('checkpoint', JSON.parse(JSON.stringify(checkpoint)))).resolves.toEqual({ ok: true });
  expect(checkRunCheckpointConsistency(checkpoint)).toEqual({ ok: true });
  expect(Object.isFrozen(conclusion)).toBe(true);
  expect(Object.isFrozen(checkpoint)).toBe(true);
  return checkpoint;
}

/** 状態の保存から、状態、保存の時刻、実行の記録を除いたもの（最後の状態の保存の中身を、ほかの保存と比べるため）。 */
const checkpointContent = ({ state: _state, savedAt: _savedAt, executions: _executions, ...content }: RunCheckpoint): unknown => content;

describe('RunCoordinator: the stop signal (resumable run design 4.6.1, R4b2)', () => {
  it('finishes the page being audited with its retry, skips the rest with RUN_INTERRUPTED, and is PARTIAL', async () => {
    const controller = new AbortController();
    const site: FakeSite = {
      [START_PATH]: { links: ['/a.html', '/b.html', '/c.html'] },
      // /a.html の最初の試行の途中で印を付ける。最初の試行は一時的な失敗なので、再試行まで行う。
      '/a.html': { attempts: [{ outcome: 'TIMEOUT' }], duringAudit: () => controller.abort() },
      '/b.html': {},
      '/c.html': {},
    };
    const harness = createHarness({ site, stopSignal: controller.signal });

    const result = await harness.coordinator.run();

    expect(harness.world.auditCalls.map(({ url, attempt }) => [pathOf(url), attempt?.attempt])).toEqual([
      [START_PATH, 1],
      ['/a.html', 1],
      ['/a.html', 2],
    ]);
    expect(pageStates(result)).toEqual([
      [START_PATH, 'AUDITED', []],
      ['/a.html', 'AUDITED', []],
      ['/b.html', 'SKIPPED', [RUN_INTERRUPTED_SKIP]],
      ['/c.html', 'SKIPPED', [RUN_INTERRUPTED_SKIP]],
    ]);
    expect(result.run.retries).toHaveLength(1);
    // Run の理由に1件だけ残す。上限ではない（`crawlLimits` も `crawlLimitReached` も偽）。SKIPPED のページがあるので PARTIAL。
    expect(result.run.incompleteReasons).toEqual([RUN_INTERRUPTED_SKIP]);
    expect(Object.isFrozen(result.run.incompleteReasons[0])).toBe(true);
    expect(result.run.crawlLimits).toEqual(NO_CRAWL_LIMITS);
    expect(result.statusInput.crawlLimitReached).toBe(false);
    expect(result.run.runStatus).toBe('PARTIAL');
    expect(deriveRunStatus(result.statusInput)).toBe('PARTIAL');
    await expectValidRun(result);
  });

  it('audits no page but still collects robots.txt and sitemap.xml when the signal is set before run()', async () => {
    const controller = new AbortController();
    controller.abort();
    const harness = createHarness({ site: CHECKPOINT_SITE, stopSignal: controller.signal });

    const result = await harness.coordinator.run();

    expect(harness.world.auditCalls).toEqual([]);
    expect(harness.metadata).toHaveBeenCalledOnce();
    expect(result.pages[0]?.evidence.map(({ type }) => type)).toEqual(['metadata', 'metadata']);
    expect(pageStates(result)).toEqual([[START_PATH, 'SKIPPED', [RUN_INTERRUPTED_SKIP]]]);
    expect(result.run.incompleteReasons).toEqual([RUN_INTERRUPTED_SKIP]);
    expect(result.run.runStatus).toBe('PARTIAL');
    await expectValidRun(result);
  });

  it('is the same Run as without the signal (COMPLETE) when no URL is left after the signal', async () => {
    const controller = new AbortController();
    const site: FakeSite = { [START_PATH]: { links: ['/a.html'] }, '/a.html': {} };
    const withoutSignal = await createHarness({ site }).coordinator.run();

    // 最後の URL（/a.html）の監査の途中で印を付ける。
    const result = await createHarness({
      site: { ...site, '/a.html': { duringAudit: () => controller.abort() } },
      stopSignal: controller.signal,
    }).coordinator.run();

    expect(controller.signal.aborted).toBe(true);
    expect(result.run.runStatus).toBe('COMPLETE');
    expect(result.run.incompleteReasons).toEqual([]);
    expect(result.run.executions.map(({ endReason }) => endReason)).toEqual(['COMPLETED']);
    expect(result).toEqual(withoutSignal);
  });

  it.each([
    ['a violation', { violations: 1 }, {}, {}, 'SAFETY_VIOLATION_ABORT'],
    ['a failed save', {}, {}, { failPageAt: 1 }, 'CHECKPOINT_WRITE_FAILED'],
    ['the page limit', {}, { config: { crawl: { maxPages: 1 } } }, {}, 'MAX_PAGES_REACHED'],
    ['the runtime limit', { durationMs: 2_000 }, { config: { crawl: { maxRuntimeMs: 1_500 } } }, {}, 'MAX_RUNTIME_REACHED'],
  ] as const)('checks the signal last: %s reached at the same time gives its own reason', async (_name, startSpec, options, recorderOptions, code) => {
    // 対照: 同じ止める印だけなら、残りの URL は RUN_INTERRUPTED の SKIPPED になる。
    const signalOnly = new AbortController();
    const signalOnlyResult = await checkpointHarness({ site: stoppingSite(signalOnly), stopSignal: signalOnly.signal })
      .harness.coordinator.run();
    expect(signalOnlyResult.pages.slice(1).map(({ incompleteReasons }) => codesOf(incompleteReasons)))
      .toEqual([['RUN_INTERRUPTED'], ['RUN_INTERRUPTED']]);
    const controller = new AbortController();
    const { harness } = checkpointHarness(
      { site: stoppingSite(controller, startSpec), ...options, stopSignal: controller.signal },
      recorderOptions,
    );

    const result = await harness.coordinator.run();

    expect(controller.signal.aborted).toBe(true);
    expect(harness.world.auditCalls.map(({ url }) => pathOf(url))).toEqual([START_PATH]);
    expect(result.pages.slice(1).map(({ incompleteReasons }) => codesOf(incompleteReasons))).toEqual([[code], [code]]);
    expect(codesOf(result.run.incompleteReasons)).not.toContain('RUN_INTERRUPTED');
  });

  it('puts RUN_INTERRUPTED after the limit reasons and before the reasons kept during the Run', async () => {
    const controller = new AbortController();
    const site: FakeSite = {
      [START_PATH]: { links: ['/a.html', '/b.html'] },
      // /a.html から、深さの上限より深い URL を発見する（MAX_DEPTH_REACHED の SKIPPED）。
      '/a.html': { links: ['/deep.html'], duringAudit: () => controller.abort() },
      '/b.html': {},
    };
    const harness = createHarness({ site, config: { crawl: { maxDepth: 1 } }, metadataPageCloseFails: true, stopSignal: controller.signal });

    const result = await harness.coordinator.run();

    expect(pageStates(result).map(([path, status, reasons]) => [path, status, codesOf(reasons)])).toEqual([
      [START_PATH, 'AUDITED', []],
      ['/a.html', 'AUDITED', []],
      ['/b.html', 'SKIPPED', ['RUN_INTERRUPTED']],
      ['/deep.html', 'SKIPPED', ['MAX_DEPTH_REACHED']],
    ]);
    expect(codesOf(result.run.incompleteReasons)).toEqual(['MAX_DEPTH_REACHED', 'RUN_INTERRUPTED', 'UNHANDLED_FAILURE']);
    expect(result.run.crawlLimits).toEqual({ ...NO_CRAWL_LIMITS, maxDepthReached: true });
    await expectValidRun(result);
  });

  it('rejects a stop signal that is not an AbortSignal with TypeError', () => {
    for (const stopSignal of ['signal', { aborted: true }, new AbortController(), null]) {
      expect(() => createHarness({
        site: CHECKPOINT_SITE,
        stopSignal: stopSignal as unknown as AbortSignal,
      }), String(stopSignal)).toThrow(TypeError);
    }
    expect(() => createHarness({ site: CHECKPOINT_SITE, stopSignal: new AbortController().signal })).not.toThrow();
  });
});

describe('RunCoordinator: the executions of run.json (resumable run design 4.8, R4b2)', () => {
  it('has one COMPLETED execution without a session, from the start of the Run to the same finishedAt as run.json', async () => {
    const SECOND_MS = 1_000;
    let clockReads = 0;
    // 時計は、読むたびに1秒進む（終わりの時刻を、`run.json` の `finishedAt` と同じ1回の読み取りで決めることを確かめる）。
    const clock = (): Date => {
      clockReads += 1;
      return new Date(STARTED_AT.getTime() + (clockReads - 1) * SECOND_MS);
    };
    const result = await createHarness({ site: CHECKPOINT_SITE, clock }).coordinator.run();

    expect(result.run.startedAt).toBe(STARTED_AT.toISOString());
    expect(result.run.finishedAt).not.toBe(result.run.startedAt);
    expect(result.run.executions).toEqual([{ startedAt: result.run.startedAt, finishedAt: result.run.finishedAt, endReason: 'COMPLETED' }]);
    await expectValidRun(result);
  });

  it.each([
    ['the stop signal', 'STOPPED_BY_SIGNAL', (controller: AbortController): Omit<HarnessOptions, 'site'> => ({ stopSignal: controller.signal })],
    ['the runtime limit', 'STOPPED_BY_RUNTIME_LIMIT', (): Omit<HarnessOptions, 'site'> => ({ config: { crawl: { maxRuntimeMs: 5 } } })],
    ['a violation', 'STOPPED_BY_SAFETY_VIOLATION', (): Omit<HarnessOptions, 'site'> => ({ environmentViolations: 1 })],
    ['the page limit (not a stop)', 'COMPLETED', (): Omit<HarnessOptions, 'site'> => ({ config: { crawl: { maxPages: 1 } } })],
  ] as const)('ends the execution by %s with %s', async (_name, endReason, options) => {
    const controller = new AbortController();
    const result = await createHarness({ site: stoppingSite(controller), ...options(controller) }).coordinator.run();

    expect(result.run.executions).toEqual([{ startedAt: result.run.startedAt, finishedAt: result.run.finishedAt, endReason }]);
    await expectValidRun(result);
  });

  it('closes the execution that the previous process left unfinished, puts this execution last, and leaves out the environments', async () => {
    const uninterrupted = await recordedRun({ site: CHECKPOINT_SITE });
    const saved = savedStateAfter(uninterrupted, 1);
    const firstStartedAt = '2026-09-30T23:00:00.000Z';
    const previousSavedAt = '2026-09-30T23:30:00.000Z';
    const resumeFrom = resumeInputAfter(uninterrupted, 1, {
      startedAt: firstStartedAt,
      savedAt: previousSavedAt,
      executions: [{ ...saved.executions[0], startedAt: firstStartedAt }],
    });

    const result = await resumedHarness({ site: CHECKPOINT_SITE }, resumeFrom).harness.coordinator.run();

    expect(result.run.startedAt).toBe(firstStartedAt);
    expect(result.run.executions).toEqual([
      { startedAt: firstStartedAt, finishedAt: previousSavedAt, endReason: 'INTERRUPTED_ABNORMALLY' },
      { startedAt: STARTED_AT.toISOString(), finishedAt: result.run.finishedAt, endReason: 'COMPLETED' },
    ]);
    expect(result.run.executions.map((execution) => Object.keys(execution))).toEqual([
      ['startedAt', 'finishedAt', 'endReason'],
      ['startedAt', 'finishedAt', 'endReason'],
    ]);
    await expectValidRun(result);
  });
});

describe('RunCoordinator: the checkpoint conclusion after the Run (resumable run design 4.3.2, R4b2)', () => {
  it('throws Error when it is asked before run() has finished', async () => {
    const { harness } = checkpointHarness({ site: CHECKPOINT_SITE });
    expect(() => harness.coordinator.checkpointConclusion()).toThrow(Error);

    const running = harness.coordinator.run();
    expect(() => harness.coordinator.checkpointConclusion()).toThrow(Error);
    await running;

    expect(harness.coordinator.checkpointConclusion().action).toBe('FINISH');
  });

  it('is NONE without a session', async () => {
    const concluded = await concludedRun(createHarness({ site: CHECKPOINT_SITE }));

    expect(concluded.result?.run.runStatus).toBe('COMPLETE');
    expect(concluded.conclusion).toEqual({ action: 'NONE' });
    expect(Object.isFrozen(concluded.conclusion)).toBe(true);
  });

  it('is NONE when the run directory cannot be created (the session does not start)', async () => {
    const outputDirectory = join(workDirectory, 'conclusion-same-run-id');
    await createHarness({ site: CHECKPOINT_SITE, outputDirectory }).coordinator.run();
    const { harness, recorder } = checkpointHarness({ site: CHECKPOINT_SITE, outputDirectory });

    const concluded = await concludedRun(harness);

    expect(concluded.error).toBeInstanceOf(RunDirectoryUnavailableError);
    expect(recorder.session.start).not.toHaveBeenCalled();
    expect(concluded.conclusion).toEqual({ action: 'NONE' });
  });

  it('is NONE when the lock already exists (the session does not start)', async () => {
    const { harness } = checkpointHarness(
      { site: CHECKPOINT_SITE },
      { start: async (): Promise<RunCheckpointSessionStart> => ({ ok: false, existingLock: null }) },
    );

    const concluded = await concludedRun(harness);

    expect(concluded.result?.run.runStatus).toBe('FAILED');
    expect(concluded.conclusion).toEqual({ action: 'NONE' });
  });

  it('is NONE when a resume cannot start (RunResumeUnavailableError) or the checkpoint is not resumable (RunNotResumableError)', async () => {
    const uninterrupted = await recordedRun({ site: CHECKPOINT_SITE });
    const held = await concludedRun(resumedHarness(
      { site: CHECKPOINT_SITE },
      resumeInputAfter(uninterrupted, 1),
      async (): Promise<RunCheckpointSessionStart> => ({ ok: false, reason: 'LOCK_HELD_BY_ACTIVE_RUN', existingLock: null }),
    ).harness);
    const finished = await concludedRun(resumedHarness({ site: CHECKPOINT_SITE }, resumeInputAfter(uninterrupted, 3, { state: 'FINISHED' })).harness);

    expect(held.error).toBeInstanceOf(RunResumeUnavailableError);
    expect(held.conclusion).toEqual({ action: 'NONE' });
    expect(finished.error).toBeInstanceOf(RunNotResumableError);
    expect(finished.conclusion).toEqual({ action: 'NONE' });
  });

  it('is FINISH with FINISHED from the end of the crawl after a violation', async () => {
    const site: FakeSite = { [START_PATH]: { links: ['/a.html', '/b.html'] }, '/a.html': { violations: 1 }, '/b.html': {} };
    const { harness, recorder } = checkpointHarness({ site });

    const concluded = await concludedRun(harness);

    expect(concluded.result?.run.runStatus).toBe('ABORTED_BY_SAFETY');
    const checkpoint = await expectFinishCheckpoint(concluded, 'FINISHED');
    expect(checkpoint.executions.at(-1)?.endReason).toBe('STOPPED_BY_SAFETY_VIOLATION');
    // 巡回の終わりの値: 違反の後の URL は SKIPPED（最後に書いた状態の保存の後に変わった値）。
    expect(checkpoint.frontier.entries.map(({ state, skipReason }) => [state, skipReason])).toEqual([
      ['AUDITED', null],
      ['AUDITED', null],
      ['SKIPPED', SAFETY_VIOLATION_ABORT_SKIP],
    ]);
    expect(checkpoint.completedPageIds).toEqual(recorder.states().at(-1)?.completedPageIds);
    expect(checkpoint.progress).toMatchObject({ safetyViolationDetected: true, stoppedBySafetyViolation: true, pagesStarted: 2 });
    expect(decideRunResumption(checkpoint)).toBe('NOT_RESUMABLE');
  });

  it('is FINISH with FINISHED from the last written checkpoint after a violation and a failed save', async () => {
    const site: FakeSite = { [START_PATH]: { links: ['/a.html', '/b.html'] }, '/a.html': { violations: 1 }, '/b.html': {} };
    // /a.html のページの保存に失敗する（最後に書けた保存は、開始のページの後の状態の保存）。
    const { harness, recorder } = checkpointHarness({ site }, { failPageAt: 2 });

    const concluded = await concludedRun(harness);

    expect(concluded.result?.run.runStatus).toBe('ABORTED_BY_SAFETY');
    expect(codesOf(concluded.result?.run.incompleteReasons ?? [])).toEqual(['SAFETY_VIOLATION_ABORT', 'CHECKPOINT_WRITE_FAILED']);
    const checkpoint = await expectFinishCheckpoint(concluded, 'FINISHED');
    const lastWritten = recorder.states().at(-1) as RunCheckpoint;
    expect(lastWritten.completedPageIds).toHaveLength(1);
    expect(checkpointContent(checkpoint)).toEqual(checkpointContent(lastWritten));
    expect(decideRunResumption(checkpoint)).toBe('NOT_RESUMABLE');
  });

  it('is ABANDON after a violation and a failed save when no checkpoint was written', async () => {
    const { harness, recorder } = checkpointHarness({ site: CHECKPOINT_SITE, environmentViolations: 1 }, { failStateAt: 1 });

    const concluded = await concludedRun(harness);

    expect(concluded.result?.run.runStatus).toBe('ABORTED_BY_SAFETY');
    expect(recorder.calls.map(({ kind }) => kind)).toEqual(['start', 'state']);
    expect(concluded.conclusion).toEqual({ action: 'ABANDON' });
    expect(Object.isFrozen(concluded.conclusion)).toBe(true);
  });

  it.each([
    ['a page checkpoint', { failPageAt: 1 }],
    ['a state checkpoint', { failStateAt: 2 }],
  ] as const)('is ABANDON when %s failed in this execution (the saved state stays as it was)', async (_name, recorderOptions) => {
    const concluded = await concludedRun(checkpointHarness({ site: CHECKPOINT_SITE }, recorderOptions).harness);

    expect(concluded.result?.run.runStatus).toBe('PARTIAL');
    expect(concluded.conclusion).toEqual({ action: 'ABANDON' });
  });

  it('is ABANDON when PREFLIGHT fails in a resumed execution (the saved state stays as it was)', async () => {
    const uninterrupted = await recordedRun({ site: CHECKPOINT_SITE });

    const concluded = await concludedRun(resumedHarness({ site: CHECKPOINT_SITE, preflightOk: false }, resumeInputAfter(uninterrupted, 1)).harness);

    expect(concluded.result?.run.runStatus).toBe('FAILED');
    expect(concluded.conclusion).toEqual({ action: 'ABANDON' });
  });

  it('is FINISH with FINISHED and an empty crawl record when PREFLIGHT fails in a new Run', async () => {
    const { harness, recorder } = checkpointHarness({ site: CHECKPOINT_SITE, preflightOk: false });

    const concluded = await concludedRun(harness);

    expect(concluded.result?.run.runStatus).toBe('FAILED');
    expect(recorder.states()).toEqual([]);
    const checkpoint = await expectFinishCheckpoint(concluded, 'FINISHED');
    expect(checkpoint.frontier).toEqual({ entries: [] });
    expect(checkpoint.allocator).toEqual(new IdAllocator().snapshot());
    expect(checkpoint.completedPageIds).toEqual([]);
    expect(checkpoint.siteMetadata).toBeNull();
    // ページの外の Ledger は、この実行のすべての Ledger（PREFLIGHT の1つ。Browser がないので、環境の事実の Ledger はない）。
    expect(checkpoint.safetyLedgerSnapshots).toHaveLength(1);
    expect(checkpoint.progress).toEqual({
      reasons: [{ code: 'PREFLIGHT_FAILED', detail: 'BROWSER_LAUNCH' }],
      retries: [],
      safetyViolationDetected: false,
      stoppedBySafetyViolation: false,
      unhandledFailures: 0,
      guardEnabled: false,
      preflightFailed: true,
      pagesStarted: 0,
    });
    expect(decideRunResumption(checkpoint)).toBe('NOT_RESUMABLE');
  });

  it.each([
    ['the runtime limit', 'STOPPED_BY_RUNTIME_LIMIT', (): Omit<HarnessOptions, 'site'> => ({ config: { crawl: { maxRuntimeMs: 5 } } })],
    ['the stop signal', 'STOPPED_BY_SIGNAL', (controller: AbortController): Omit<HarnessOptions, 'site'> => ({ stopSignal: controller.signal })],
  ] as const)('is FINISH with STOPPED when the execution stopped at %s (%s), and the checkpoint is resumable', async (_name, endReason, options) => {
    const controller = new AbortController();
    const { harness } = checkpointHarness({ site: stoppingSite(controller), ...options(controller) });

    const concluded = await concludedRun(harness);

    expect(concluded.result?.run.runStatus).toBe('PARTIAL');
    const checkpoint = await expectFinishCheckpoint(concluded, 'STOPPED');
    expect(checkpoint.executions.at(-1)?.endReason).toBe(endReason);
    expect(decideRunResumption(checkpoint)).toBe('RESUME');
  });

  it.each([
    ['COMPLETE', {}],
    ['PARTIAL', { config: { crawl: { maxPages: 2 } } }],
  ] as const)('is FINISH with FINISHED otherwise (a %s Run)', async (runStatus, options) => {
    const concluded = await concludedRun(checkpointHarness({ site: CHECKPOINT_SITE, ...options }).harness);

    expect(concluded.result?.run.runStatus).toBe(runStatus);
    const checkpoint = await expectFinishCheckpoint(concluded, 'FINISHED');
    expect(checkpoint.executions.at(-1)?.endReason).toBe('COMPLETED');
    expect(decideRunResumption(checkpoint)).toBe('NOT_RESUMABLE');
  });

  it('is ABANDON when run() rejects with an unexpected exception after the session started, and NONE before it started', async () => {
    const started = checkpointHarness({ site: CHECKPOINT_SITE, environmentThrows: true });
    const afterStart = await concludedRun(started.harness);
    const beforeStart = await concludedRun(checkpointHarness({ site: CHECKPOINT_SITE, clock: () => new Date(Number.NaN) }).harness);
    const withoutSession = await concludedRun(createHarness({ site: CHECKPOINT_SITE, environmentThrows: true }));

    expect(afterStart.error).toBeInstanceOf(Error);
    expect(started.recorder.session.start).toHaveBeenCalledOnce();
    expect(afterStart.conclusion).toEqual({ action: 'ABANDON' });
    expect(beforeStart.error).toBeInstanceOf(Error);
    expect(beforeStart.conclusion).toEqual({ action: 'NONE' });
    expect(withoutSession.error).toBeInstanceOf(Error);
    expect(withoutSession.conclusion).toEqual({ action: 'NONE' });
  });

  // R7c（中断した Run の再開の設計書 4.10 の Important-1 の (b)）: `FINISH` の「出力の書き出しに失敗しても `finish` を行う」かどうかは、
  // `decideRunCheckpointConclusion` の判定の値を、そのまま写す（Run Coordinator は決めない）。判定は、Run Status が `ABORTED_BY_SAFETY` の
  // ときだけ真（巡回の終わりの値でも、最後に書けた保存の値でも）。
  it.each([
    ['a violation (the end of the crawl)', true, (): ReturnType<typeof checkpointHarness> => checkpointHarness({
      site: { [START_PATH]: { links: ['/a.html', '/b.html'] }, '/a.html': { violations: 1 }, '/b.html': {} },
    })],
    ['a violation and a failed save (the last written checkpoint)', true, (): ReturnType<typeof checkpointHarness> => checkpointHarness(
      { site: { [START_PATH]: { links: ['/a.html', '/b.html'] }, '/a.html': { violations: 1 }, '/b.html': {} } },
      { failPageAt: 2 },
    )],
    ['a complete Run', false, (): ReturnType<typeof checkpointHarness> => checkpointHarness({ site: CHECKPOINT_SITE })],
    ['the page limit', false, (): ReturnType<typeof checkpointHarness> => checkpointHarness({
      site: CHECKPOINT_SITE,
      config: { crawl: { maxPages: 2 } },
    })],
    ['a new Run whose PREFLIGHT failed', false, (): ReturnType<typeof checkpointHarness> => checkpointHarness({
      site: CHECKPOINT_SITE,
      preflightOk: false,
    })],
    ['the runtime limit (STOPPED)', false, (): ReturnType<typeof checkpointHarness> => checkpointHarness({
      site: stoppingSite(new AbortController()),
      config: { crawl: { maxRuntimeMs: 5 } },
    })],
  ] as const)('copies finishEvenIfOutputFails of the decision to FINISH: %s gives %s', async (_name, expected, harnessOf) => {
    const concluded = await concludedRun(harnessOf().harness);

    expect(concluded.conclusion.action).toBe('FINISH');
    if (concluded.conclusion.action !== 'FINISH') {
      return;
    }
    expect(concluded.conclusion.finishEvenIfOutputFails).toBe(expected);
    expect(concluded.conclusion.finishEvenIfOutputFails).toBe(concluded.result?.run.runStatus === 'ABORTED_BY_SAFETY');
    expect(Object.isFrozen(concluded.conclusion)).toBe(true);
  });

  it('copies finishEvenIfOutputFails for the stop signal (STOPPED) as false', async () => {
    const controller = new AbortController();
    const concluded = await concludedRun(checkpointHarness({ site: stoppingSite(controller), stopSignal: controller.signal }).harness);

    expect(concluded.conclusion).toMatchObject({ action: 'FINISH', finishEvenIfOutputFails: false });
    expect(finishCheckpointOf(concluded.conclusion).state).toBe('STOPPED');
  });

  it('uses the last written checkpoint when the one from the end of the crawl is not consistent (an exception after a page was finished)', async () => {
    // /a.html の監査を終えた（`markFinished` の）後、Link の取り出しで例外が起き、/a.html のページの保存を書かずに巡回が止まる。
    const site: FakeSite = { [START_PATH]: { links: ['/a.html', '/b.html'] }, '/a.html': { malformedLinks: true }, '/b.html': {} };
    const { harness, recorder } = checkpointHarness({ site });

    const concluded = await concludedRun(harness);

    expect(concluded.result?.run.incompleteReasons).toContainEqual({ code: 'UNHANDLED_FAILURE', detail: expect.stringContaining('run-crawl') });
    expect(concluded.result?.pages.map(({ status }) => status)).toEqual(['AUDITED', 'AUDITED', 'SKIPPED']);
    expect(recorder.pages()).toHaveLength(1);
    const checkpoint = await expectFinishCheckpoint(concluded, 'FINISHED');
    expect(checkpointContent(checkpoint)).toEqual(checkpointContent(recorder.states().at(-1) as RunCheckpoint));
  });
});

// R7b（中断した Run の再開の設計書 4.10 の DEF-022、4.3.2）: 再開した実行で PREFLIGHT に失敗した場合。巡回の記録と採番器は、PREFLIGHT の前に
// 保存から作り直すので、巡回を行わなくても、その実行の出力には、前の回までに終わったページの結果が入り、残りの URL（待ち行列のもの。保存の
// 時点で待ち行列に戻したものを含む）は、理由 `PREFLIGHT_FAILED`（`detail` は `null`）の SKIPPED になる。Run の理由の `PREFLIGHT_FAILED`
// （この実行の PREFLIGHT の失敗。`detail` は失敗した項目）は1件。違反がなければ、保存の終わり方は `ABANDON`（保存の状態を変えない）。違反が
// あれば `FINISH`・`FINISHED` で、最後の状態の保存の巡回の記録と終わったページの ID にも、前の回までのページが入る。
describe('RunCoordinator: a resumed execution whose PREFLIGHT fails keeps the pages finished before it (resumable run design 4.10 DEF-022, R7b)', () => {
  const PREFLIGHT_FAILED_SKIP: IncompleteReason = { code: 'PREFLIGHT_FAILED', detail: null };
  /** 偽の PREFLIGHT の失敗の Run の理由（失敗した項目は、既定の `BROWSER_LAUNCH`）。 */
  const PREFLIGHT_FAILED_RUN_REASON: IncompleteReason = { code: 'PREFLIGHT_FAILED', detail: 'BROWSER_LAUNCH' };
  /** 開始のページと /a.html（再試行したページ）を終えた後に中断するサイト。どちらのページも Finding を持つ。 */
  const SITE: FakeSite = {
    [START_PATH]: { links: ['/a.html', '/b.html', '/c.html'], finding: true },
    '/a.html': { attempts: [{ outcome: 'TIMEOUT' }], finding: true },
    '/b.html': {},
    '/c.html': {},
  };
  /** 中断する前に終えたページの数（開始のページと /a.html）。 */
  const FINISHED_PAGES = 2;

  it.each([
    ['the state saved before the process ended (the rest is QUEUED)', false],
    ['the final state of an execution stopped by the signal (the rest is SKIPPED with RUN_INTERRUPTED, and goes back to the queue)', true],
  ] as const)('puts the finished pages and the rest SKIPPED with PREFLIGHT_FAILED into the Run, is FAILED and ABANDON, resumed from %s', async (_name, stopped) => {
    const uninterrupted = await recordedRun({ site: SITE });
    const saved = savedStateAfter(uninterrupted, FINISHED_PAGES);
    const frontier = {
      entries: saved.frontier.entries.map((entry) => (stopped && entry.state === 'QUEUED'
        ? { ...entry, state: 'SKIPPED' as const, skipReason: RUN_INTERRUPTED_SKIP }
        : entry)),
    };
    const stoppedExecution = { ...saved.executions[0], finishedAt: saved.savedAt, endReason: 'STOPPED_BY_SIGNAL' as const };
    const resumeFrom = resumeInputAfter(uninterrupted, FINISHED_PAGES, stopped
      ? { state: 'STOPPED', frontier, executions: [stoppedExecution] }
      : {});
    expect(checkRunCheckpointConsistency(resumeFrom.checkpoint)).toEqual({ ok: true });
    expect(decideRunResumption(resumeFrom.checkpoint)).toBe('RESUME');
    const { harness, recorder } = resumedHarness({ site: SITE, preflightOk: false }, resumeFrom);

    const concluded = await concludedRun(harness);

    const result = concluded.result as AuditRunResult;
    // 巡回は行わない（Page Auditor を作らず、robots.txt と sitemap.xml も取得しない）。保存もしない。
    expect(harness.world.createdAuditors).toEqual([]);
    expect(harness.metadata).not.toHaveBeenCalled();
    expect(recorder.calls.map(({ kind }) => kind)).toEqual(['start']);
    // 前の回までに終わったページの結果（開始のページの robots.txt と sitemap.xml の Evidence と、/a.html の再試行の前の試行の Evidence を
    // 含む）は、中断しなかった Run と同じ。残りの URL は、中断しなかった Run と同じページの ID で、理由 PREFLIGHT_FAILED の SKIPPED。
    expect(result.pages.map(({ pageId }) => pageId)).toEqual(uninterrupted.result.pages.map(({ pageId }) => pageId));
    expect(result.pages.slice(0, FINISHED_PAGES)).toEqual(uninterrupted.result.pages.slice(0, FINISHED_PAGES));
    expect(pageStates(result)).toEqual([
      [START_PATH, 'AUDITED', []],
      ['/a.html', 'AUDITED', []],
      ['/b.html', 'SKIPPED', [PREFLIGHT_FAILED_SKIP]],
      ['/c.html', 'SKIPPED', [PREFLIGHT_FAILED_SKIP]],
    ]);
    expect(result.findings).toEqual(uninterrupted.result.pages.slice(0, FINISHED_PAGES).flatMap(({ findings }) => findings));
    expect(result.findings).toHaveLength(FINISHED_PAGES);
    expect(result.run.retries).toEqual(uninterrupted.result.run.retries);
    expect(result.run.retries).toHaveLength(1);
    expect(result.run).toMatchObject({ discoveredPageCount: 4, auditedPageCount: FINISHED_PAGES, skippedPageCount: 2 });
    // Run の理由の PREFLIGHT_FAILED は、この実行の PREFLIGHT の失敗の1件だけ（RUN_INTERRUPTED も残らない）。Run Status は、`preflightFailed`
    // から `deriveRunStatus` が FAILED と導く。
    expect(result.run.incompleteReasons).toEqual([PREFLIGHT_FAILED_RUN_REASON]);
    expect(result.statusInput.preflightFailed).toBe(true);
    expect(result.run.runStatus).toBe('FAILED');
    expect(deriveRunStatus(result.statusInput)).toBe('FAILED');
    expect(result.run.safety.guardEnabled).toBe(false);
    await expectValidRun(result);
    // 違反はないので、保存の状態を変えない（次の起動で、もう一度再開できる）。
    expect(concluded.conclusion).toEqual({ action: 'ABANDON' });
  });

  it.each([
    ['a saved Ledger snapshot (the resume only finalizes the Run)', 'saved'],
    ['the PREFLIGHT Ledger of the resumed execution', 'preflight'],
  ] as const)('is FINISH with FINISHED from the end of the crawl that keeps the finished pages, after a violation in %s', async (_name, violationIn) => {
    const site: FakeSite = violationIn === 'saved' ? { ...SITE, '/a.html': { violations: 1, finding: true } } : SITE;
    const uninterrupted = await recordedRun({ site });
    const resumeFrom = resumeInputAfter(uninterrupted, FINISHED_PAGES);
    const saved = resumeFrom.checkpoint;
    expect(decideRunResumption(saved)).toBe(violationIn === 'saved' ? 'FINALIZE_ONLY' : 'RESUME');
    const { harness, recorder } = resumedHarness(
      { site, preflightOk: false, preflightViolations: violationIn === 'preflight' ? 1 : 0 },
      resumeFrom,
    );

    const concluded = await concludedRun(harness);

    const result = concluded.result as AuditRunResult;
    expect(harness.world.createdAuditors).toEqual([]);
    expect(recorder.states()).toEqual([]);
    expect(result.run.runStatus).toBe('ABORTED_BY_SAFETY');
    expect(deriveRunStatus(result.statusInput)).toBe('ABORTED_BY_SAFETY');
    expect(result.run.safety.invariantViolationCount).toBe(1);
    expect(result.pages.slice(0, FINISHED_PAGES)).toEqual(uninterrupted.result.pages.slice(0, FINISHED_PAGES));
    expect(pageStates(result).slice(FINISHED_PAGES)).toEqual([
      ['/b.html', 'SKIPPED', [PREFLIGHT_FAILED_SKIP]],
      ['/c.html', 'SKIPPED', [PREFLIGHT_FAILED_SKIP]],
    ]);
    // 最後の状態の保存（巡回の終わりの値）は、作り直した巡回の記録（残りを SKIPPED にした後）、採番器、保存の監査を始めたページの数と
    // 終わったページの ID、ページの外の Ledger の snapshot（保存のものと、この実行の PREFLIGHT のもの）、保存の robots.txt と sitemap.xml の
    // Evidence、負荷の記録で作る。スキーマと整合の確かめを通る（`expectFinishCheckpoint`）。
    const checkpoint = await expectFinishCheckpoint(concluded, 'FINISHED');
    expect(checkpoint.completedPageIds).toEqual(saved.completedPageIds);
    expect(checkpoint.completedPageIds).toHaveLength(FINISHED_PAGES);
    expect(checkpoint.frontier.entries.map(({ pageId, state, skipReason }) => [pageId, state, skipReason])).toEqual(
      saved.frontier.entries.map(({ pageId, state }) => (state === 'QUEUED'
        ? [pageId, 'SKIPPED', PREFLIGHT_FAILED_SKIP]
        : [pageId, state, null])),
    );
    expect(checkpoint.frontier.entries.filter(({ state }) => state === 'AUDITED')).toHaveLength(FINISHED_PAGES);
    expect(checkpoint.allocator).toEqual(saved.allocator);
    expect(checkpoint.progress).toMatchObject({ pagesStarted: saved.progress.pagesStarted, preflightFailed: true, guardEnabled: false });
    expect(checkpoint.siteMetadata).toEqual(saved.siteMetadata);
    expect(checkpoint.siteMetadata).not.toBeNull();
    expect(checkpoint.safetyLedgerSnapshots.slice(0, saved.safetyLedgerSnapshots.length)).toEqual(saved.safetyLedgerSnapshots);
    expect(checkpoint.safetyLedgerSnapshots).toHaveLength(saved.safetyLedgerSnapshots.length + 1);
    expect(checkpoint.load).toMatchObject({
      pacer: { navigationCount: saved.load.pacer.navigationCount, totalWaitMs: saved.load.pacer.totalWaitMs },
      meter: saved.load.meter,
    });
    expect(decideRunResumption(checkpoint)).toBe('NOT_RESUMABLE');
  });

  // R8（設計書 4.10 の DEF-022 の、まれな場合。RR2 の指摘4）: 巡回の記録と採番器は、保存のセッションを始める前に作り直す。作り直せない保存
  // （CLI は、R8 の整合の確かめで、壊れた保存として扱うので渡さない）を渡されたら、ロック、後始末（どちらも保存のセッションの `start` が
  // 行う）、PREFLIGHT のどれも行わずに、作り直しの例外で reject し、保存の終わり方は `NONE`（保存を変えない）。
  it.each([
    [
      'the crawl frontier (a URL deeper than the max depth without MAX_DEPTH_REACHED)',
      (saved: RunCheckpoint): Partial<RunCheckpointInput> => ({
        frontier: {
          entries: saved.frontier.entries.map((entry) => (entry.state === 'QUEUED'
            ? { ...entry, depth: saved.effectiveConfig.crawl.maxDepth + 1 }
            : entry)),
        },
      }),
    ],
    [
      'the ID allocator (a sequence beyond the safe integers)',
      (saved: RunCheckpoint): Partial<RunCheckpointInput> => ({
        allocator: { ...saved.allocator, nextPageSequence: Number.MAX_SAFE_INTEGER + 1 },
      }),
    ],
  ] as const)('rejects before the checkpoint session starts, without the lock, the cleanup or PREFLIGHT, and is NONE, when %s cannot be restored', async (_name, change) => {
    const uninterrupted = await recordedRun({ site: SITE });
    const resumeFrom = resumeInputAfter(uninterrupted, FINISHED_PAGES, change(savedStateAfter(uninterrupted, FINISHED_PAGES)));
    expect(decideRunResumption(resumeFrom.checkpoint)).toBe('RESUME');
    const { harness, recorder } = resumedHarness({ site: SITE }, resumeFrom);

    const concluded = await concludedRun(harness);

    expect(concluded.result).toBeNull();
    expect(concluded.error).toBeInstanceOf(RangeError);
    // 保存のセッションを始めない（ロックも後始末もしない）。PREFLIGHT、Browser の起動、環境の記録、robots.txt と sitemap.xml の取得、監査も
    // 行わない。
    expect(recorder.calls).toEqual([]);
    expect(recorder.session.start).not.toHaveBeenCalled();
    expect(harness.preflight).not.toHaveBeenCalled();
    expect(harness.launchBrowser).not.toHaveBeenCalled();
    expect(harness.environment).not.toHaveBeenCalled();
    expect(harness.metadata).not.toHaveBeenCalled();
    expect(harness.world.createdAuditors).toEqual([]);
    expect(concluded.conclusion).toEqual({ action: 'NONE' });
  });
});

describe('RunCoordinator: the final checkpoint holds the values at the end of the crawl (resumable run design 4.3.2, R4b2)', () => {
  it('does not contain the Run reason of a browser close failure', async () => {
    const { harness, recorder } = checkpointHarness({ site: CHECKPOINT_SITE, browserCloseFails: true });

    const concluded = await concludedRun(harness);

    expect(concluded.result?.run.incompleteReasons).toEqual([
      { code: 'UNHANDLED_FAILURE', detail: expect.stringContaining('browser-close') },
    ]);
    const checkpoint = await expectFinishCheckpoint(concluded, 'FINISHED');
    expect(checkpoint.progress.reasons).toEqual([]);
    // 最後のページの後には、巡回の値は変わらない（最後のページの後の状態の保存と、同じ中身）。
    expect(checkpointContent(checkpoint)).toEqual(checkpointContent(recorder.states().at(-1) as RunCheckpoint));
  });

  it('keeps the Finding sequence from before the Cross-page rules, which number their Findings after it', async () => {
    const site: FakeSite = {
      [START_PATH]: { links: ['/a.html', '/b.html'], finding: true },
      '/a.html': { finding: true },
      '/b.html': {},
    };
    const { harness, recorder } = checkpointHarness({ site, sitemapUrls: [START_PATH, '/orphan.html'] });

    const concluded = await concludedRun(harness);

    const checkpoint = await expectFinishCheckpoint(concluded, 'FINISHED');
    const findings = concluded.result?.findings ?? [];
    const pageFindings = findings.filter(({ ruleId }) => ruleId === 'TEST_PAGE_RULE');
    const crossPageFindings = findings.filter(({ ruleId }) => ruleId !== 'TEST_PAGE_RULE');
    expect(pageFindings).toHaveLength(2);
    expect(crossPageFindings.length).toBeGreaterThan(0);
    expect(checkpoint.allocator.nextFindingSequence).toBe(pageFindings.length + 1);
    expect(crossPageFindings[0]?.findingId).toBe(createFindingId(checkpoint.allocator.nextFindingSequence));
    expect(checkpointContent(checkpoint)).toEqual(checkpointContent(recorder.states().at(-1) as RunCheckpoint));
  });
});

describe('RunCoordinator: resuming from the final checkpoint of a stopped execution (resumable run design 3.2, 4.6, R4b2)', () => {
  it('resumes a Run stopped by the signal and gives the same Run as without the stop, with the executions of both', async () => {
    const uninterrupted = await recordedRun({ site: CHECKPOINT_SITE });
    const controller = new AbortController();
    const stopped = await recordedRun({ site: stoppingSite(controller), stopSignal: controller.signal });
    const checkpoint = finishCheckpointOf(stopped.harness.coordinator.checkpointConclusion());
    expect(checkpoint.state).toBe('STOPPED');
    expect(decideRunResumption(checkpoint)).toBe('RESUME');
    const { harness } = resumedHarness({ site: CHECKPOINT_SITE }, resumeInputFrom(stopped, checkpoint));

    const concluded = await concludedRun(harness);

    expect(harness.world.auditCalls.map(({ url }) => pathOf(url))).toEqual(['/a.html', '/b.html']);
    const result = concluded.result as AuditRunResult;
    expect(withoutExecutions(result)).toEqual(withoutExecutions(uninterrupted.result));
    expect(result.run.executions.map(({ endReason }) => endReason)).toEqual(['STOPPED_BY_SIGNAL', 'COMPLETED']);
    expect(result.run.executions[0]).toEqual(stopped.result.run.executions[0]);
    await expectFinishCheckpoint(concluded, 'FINISHED');
  });

  it('reports maxRuntimeReached of the last execution only: false when the resumed execution finished every page', async () => {
    const options = { site: starSite(3, { durationMs: 1_000 }), config: { crawl: { maxRuntimeMs: 1_500 } } };
    const stopped = await recordedRun(options);
    expect(stopped.result.run.crawlLimits.maxRuntimeReached).toBe(true);
    const checkpoint = finishCheckpointOf(stopped.harness.coordinator.checkpointConclusion());
    expect(checkpoint.state).toBe('STOPPED');
    const { harness } = resumedHarness(options, resumeInputFrom(stopped, checkpoint));

    const concluded = await concludedRun(harness);

    const result = concluded.result as AuditRunResult;
    expect(harness.world.auditCalls).toHaveLength(1);
    expect(result.run.runStatus).toBe('COMPLETE');
    expect(result.run.crawlLimits).toEqual(NO_CRAWL_LIMITS);
    expect(result.run.incompleteReasons).toEqual([]);
    expect(result.run.executions.map(({ endReason }) => endReason)).toEqual(['STOPPED_BY_RUNTIME_LIMIT', 'COMPLETED']);
    await expectFinishCheckpoint(concluded, 'FINISHED');
  });
});
