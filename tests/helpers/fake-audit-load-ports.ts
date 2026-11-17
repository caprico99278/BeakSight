/**
 * RB-10: 偽の監査の読み込みの口（`AuditLoadPorts`）。ブラウザを使わずに Page Auditor の段の順を確かめる。
 * - 口は判定しない。偽は、決めた答え（集めた記録の形だけの見本）を返し、頼まれた操作を `events` に順に残す（間隔の待ち・開く・閉じる・幅・候補）。
 * - 場面ごとの違い（読み込みの結果・collector の失敗・crash・違反・幅の失敗・候補の結果）は `FakeAuditScript` で差し込む。
 * - 見本の記録の中身は Rule が読まない形の最小（テストは `createRuleEngine` を差し替える）。本物との一致は、ずれの確かめと結合の代表で照らす。
 */
import type { AuditConfig, Viewport } from '../../src/config/types.js';
import type { PageId, ViewportProfile } from '../../src/core/contracts.js';
import type { MainFrameLoadObservation } from '../../src/browser/main-frame-load.js';
import type { PageSettlingResult } from '../../src/browser/page-settling.js';
import type { NavigationPacer } from '../../src/crawl/navigation-pacer.js';
import type { DataRequestActivity, NetworkCollectorHandle } from '../../src/evidence/network-collector.js';
import type { CollectorHandle } from '../../src/evidence/collector-handle.js';
import type { InteractionAuditResult } from '../../src/interaction/isolated-auditor.js';
import type { InteractionCandidate } from '../../src/safety/interaction-policy.js';
import { IdAllocator } from '../../src/orchestration/id-allocator.js';
import type {
  AuditInteractionInput,
  AuditInteractionOutcome,
  AuditLoadPorts,
  AuditPassiveOpening,
  AuditStressLayoutOptions,
  AuditStressSession,
  AuditView,
  PageAuditorDependencies,
  PageRuleEvaluator,
} from '../../src/orchestration/page-auditor.js';
import type { PageNavigationResult } from '../../src/orchestration/page-navigation.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import type { StressLayoutEvidence } from '../../src/core/evidence-types.js';
import { createTestConfig, type TestConfigOverrides } from './test-config.js';

/** 偽の page の名前（Passive は `desktop`・`mobile`、幅の走査は `stress-<幅>`、開いた状態は `opened`）。 */
export type FakeViewName = ViewportProfile | `stress-${number}` | 'opened';

/** 場面ごとの差し込み。省略した所は、どれも成功の答え。 */
export interface FakeAuditScript {
  /** Passive を開く結果（省略は開ける）。 */
  readonly open?: (profile: ViewportProfile) => 'OPENED' | 'FAILED' | 'DEADLINE_EXCEEDED' | 'PAGE_DEADLINE_EXCEEDED';
  /** `open` が `FAILED` のときの失敗と Ledger（Context の構築の失敗など。省略は Ledger なしの失敗）。 */
  readonly openFailure?: (profile: ViewportProfile) => { readonly error: unknown; readonly ledger: SafetyLedger | null };
  /** 幅の走査の collector が投げる失敗（省略は投げない）。 */
  readonly stressLayoutError?: () => unknown;
  /** Passive の読み込みの観測（省略は 200 の OK）。 */
  readonly load?: (profile: ViewportProfile) => MainFrameLoadObservation;
  /** 幅の読み込みの観測（省略は 200 の OK）。 */
  readonly stressLoad?: (width: number) => MainFrameLoadObservation;
  /** page の操作を差し替える（collector の失敗・PARTIAL など）。`emit` で crash を起こせる。 */
  readonly view?: (name: FakeViewName, emit: { readonly crash: () => void }) => Partial<AuditView>;
  /** Passive の Context を閉じた失敗（省略は失敗なし）。 */
  readonly closeFailure?: (profile: ViewportProfile) => Error | null;
  /** 幅の page を開いた後（違反を記録するなど）。 */
  readonly afterStressOpen?: (width: number) => void;
  /** Interaction の候補 1 つの結果（省略は `VERIFIED`）。 */
  readonly interaction?: (input: AuditInteractionInput) => Promise<AuditInteractionOutcome> | AuditInteractionOutcome;
  /** 見つける Interaction の候補の ID（省略は候補なし）。 */
  readonly candidates?: (name: FakeViewName) => readonly string[];
}

const OK_LOAD: MainFrameLoadObservation = Object.freeze({ navigationOutcome: 'OK', httpStatus: 200, failureDetail: null });
const NO_DATA_ACTIVITY: DataRequestActivity = Object.freeze({ inFlight: 0, events: 0, endpoints: Object.freeze({ inFlight: [], completed: [] }) });
const SETTLED: PageSettlingResult = Object.freeze({ status: 'SETTLED', reason: 'DOM_AND_HEIGHT_STABLE', observations: Object.freeze([]) });

/** 形だけの見本の記録（Rule は読まない。Evidence の種類ごとの payload として残るだけ）。 */
const sample = <T>(value: object): T => Object.freeze(value) as T;

/** 候補の見本（ID と順番だけ。発見の部品の形）。 */
export const fakeCandidate = (candidateId: string): InteractionCandidate => sample<InteractionCandidate>({ candidateId, ordinal: 0 });

/** 確かめた候補の見本の結果。 */
export const verifiedInteraction = (candidateId: string): InteractionAuditResult => sample<InteractionAuditResult>({
  candidateId, status: 'VERIFIED', reason: 'OBSERVABLE_STATE_CHANGED', reasonDetail: null, safety: new SafetyLedger().snapshot(),
});

const navigationOf = (url: string, observation: MainFrameLoadObservation): PageNavigationResult => sample<PageNavigationResult>({
  navigationOutcome: observation.navigationOutcome,
  httpStatus: observation.navigationOutcome === 'OK' ? observation.httpStatus : null,
  finalUrl: observation.navigationOutcome === 'OK' ? url : null,
  failureDetail: observation.navigationOutcome === 'OK' ? null : `${observation.navigationOutcome}:${observation.failureDetail ?? ''}`,
  loadObservation: observation,
});

/** 偽の監査の読み込みの口と、頼まれた操作の記録。 */
export interface FakeAuditLoad {
  readonly ports: AuditLoadPorts;
  /** 頼まれた操作の順（`open:<名前>`・`close:<名前>`・`navigate:<名前>`・`shown-wait:<名前>`・`interaction:<候補>` など）。 */
  readonly events: string[];
  /** 偽の page の Ledger（違反を記録して Guard の止めを表す）。 */
  readonly ledgers: Map<FakeViewName, SafetyLedger>;
}

export function createFakeAuditLoadPorts(script: FakeAuditScript = {}): FakeAuditLoad {
  const events: string[] = [];
  const ledgers = new Map<FakeViewName, SafetyLedger>();
  const viewOf = (name: FakeViewName, width: number | null, url: () => string): AuditView => {
    const ledger = new SafetyLedger();
    ledgers.set(name, ledger);
    const crashListeners = new Set<() => void>();
    const overrides = script.view?.(name, { crash: () => crashListeners.forEach((listener) => listener()) }) ?? {};
    const candidates = (script.candidates?.(name) ?? []).map(fakeCandidate);
    const view: AuditView = {
      url,
      isClosed: () => false,
      viewportWidth: () => width,
      failureReason: () => 'EVALUATION_FAILED',
      onCrash: (listener) => {
        crashListeners.add(listener);
        return () => crashListeners.delete(listener);
      },
      captureLocation: async () => ({ url: url(), scrollPosition: { x: 0, y: 0 } }),
      attachProgressSignals: () => () => undefined,
      waitForSettled: async () => SETTLED,
      controlledScroll: async () => sample({ status: 'COMPLETE', restoration: { status: 'RESTORED' } }),
      readMediaQueryConditionTexts: async () => [],
      attachDataActivity: () => sample({ dataRequestActivity: () => NO_DATA_ACTIVITY, detach: () => undefined }),
      collectDomEvidence: async () => sample({ headings: [] }),
      collectLayoutEvidence: async () => sample({ status: 'COMPLETE' }),
      collectAccessibilityEvidence: async () => sample({ status: 'COMPLETE', violations: [] }),
      collectPerformance: async () => sample({ status: 'COMPLETE' }),
      readLcpBeforeScroll: async () => undefined,
      captureScreenshots: async () => [],
      captureViewportScreenshot: async () => sample({ captureType: 'VIEWPORT' }),
      collectFocusChecks: async () => sample({ items: [] }),
      revealAndCapture: async () => undefined,
      captureAsIs: async () => null,
      checkScrollableRegions: async () => [],
      discoverLinks: async () => sample({ links: [] }),
      discoverInteractionCandidates: async () => ({ candidates, completeness: 'COMPLETE', domWorkUsed: 0 }),
      dismissNotificationFrames: async () => sample({ readStatus: 'READ', frames: [], pressCount: 0, navigated: false, truncated: false }),
      loadFacts: () => null,
      pressNavigations: () => 0,
      pressNavigationTargets: () => [],
      documentLeftCause: () => null,
      watchAuditScope: () => ({ outsideUrl: () => null, dispose: () => undefined }),
      ledger: () => ledger,
      authenticatedStateNames: () => null,
      observeSessionLossNavigation: () => ({ snapshot: () => ({ urls: [], omitted: 0 }), dispose: () => undefined }),
      waitWithPageShown: async () => {
        events.push(`shown-wait:${name}`);
        return null;
      },
      ...overrides,
    };
    return Object.freeze(view);
  };
  const handleOf = <T>(value: T): CollectorHandle<T> => ({ snapshot: async () => value, detach: () => undefined });
  const ports: AuditLoadPorts = {
    openPassive: async (viewport: Viewport): Promise<AuditPassiveOpening> => {
      const profile: ViewportProfile = viewport.width >= 1024 ? 'desktop' : 'mobile';
      events.push(`open:${profile}`);
      const close = async (): Promise<readonly { readonly step: 'context'; readonly error: unknown }[]> => {
        events.push(`close:${profile}`);
        const failure = script.closeFailure?.(profile) ?? null;
        return failure === null ? [] : [{ step: 'context', error: failure }];
      };
      switch (script.open?.(profile) ?? 'OPENED') {
        case 'FAILED': {
          const failure = script.openFailure?.(profile) ?? { error: new Error('the passive page was not created'), ledger: null };
          return { status: 'FAILED', ...failure, close };
        }
        case 'DEADLINE_EXCEEDED':
          return { status: 'DEADLINE_EXCEEDED', ledger: null, closeFailures: [] };
        case 'PAGE_DEADLINE_EXCEEDED':
          // Context はできたが page が期限までにできなかった（部品が Context を閉じた。Ledger は残る）。
          return { status: 'DEADLINE_EXCEEDED', ledger: new SafetyLedger(), closeFailures: [] };
        case 'OPENED':
          break;
      }
      let currentUrl = 'about:blank';
      const view = viewOf(profile, viewport.width, () => currentUrl);
      return {
        status: 'OPENED',
        ledger: view.ledger(),
        close,
        load: {
          view,
          installPerformance: async () => undefined,
          navigate: async (url) => {
            events.push(`navigate:${profile}`);
            const observation = script.load?.(profile) ?? OK_LOAD;
            currentUrl = url;
            return navigationOf(url, observation);
          },
          attachNetwork: () => sample<NetworkCollectorHandle>({
            snapshot: async () => sample({ requests: [] }),
            dataRequestActivity: () => NO_DATA_ACTIVITY,
            detach: () => undefined,
          }),
          attachConsole: () => handleOf(sample({ messages: [] })),
        },
      };
    },
    stressSessions: () => {
      const opened: SafetyLedger[] = [];
      return {
        ledgers: () => [...opened],
        createSession: async (viewport): Promise<AuditStressSession> => {
          const name: FakeViewName = `stress-${viewport.width}`;
          events.push(`open:${name}`);
          const view = viewOf(name, viewport.width, () => 'https://site.test/');
          opened.push(view.ledger());
          script.afterStressOpen?.(viewport.width);
          return { view, close: async () => { events.push(`close:${name}`); } };
        },
      };
    },
    collectStressLayout: async (createSession, _url, widths, options: AuditStressLayoutOptions): Promise<readonly StressLayoutEvidence[]> => {
      if (script.stressLayoutError !== undefined) {
        throw script.stressLayoutError();
      }
      const results: StressLayoutEvidence[] = [];
      for (const width of widths) {
        await options.beforeNavigation();
        const session = await createSession({ width, height: 900 });
        try {
          options.afterNavigation?.(script.stressLoad?.(width) ?? OK_LOAD);
          await options.settleBeforeLayout(session.view, options.deadlineAtMs);
          results.push(sample<StressLayoutEvidence>({ width, height: 900, status: 'COMPLETE', layout: {} }));
          await options.afterLayout?.(session.view, width, sample({}));
        } finally {
          await session.close();
        }
      }
      return results;
    },
    auditInteraction: async (input): Promise<AuditInteractionOutcome> => {
      events.push(`interaction:${input.candidate.candidateId}`);
      return script.interaction === undefined
        ? { kind: 'AUDITED', result: verifiedInteraction(input.candidate.candidateId) }
        : await script.interaction(input);
    },
  };
  return { ports, events, ledgers };
}

/** 間隔の待ちを `events` に `pacer` と残す pacer（待たない）。 */
export const recordingPacer = (events: string[]): NavigationPacer => ({
  beforeNavigation: async () => {
    events.push('pacer');
    return 0;
  },
  waitUntilNextNavigationDue: async () => 0,
  snapshot: () => ({ navigationCount: 0, totalWaitMs: 0, lastNavigationStartedAtMs: null }),
  raiseMinimumInterval: () => undefined,
  recordDocumentRequestSent: () => undefined,
});

/** Rule を流さない評価（見本の記録は Rule の入力の形を持たない）。 */
export const NO_RULES: () => PageRuleEvaluator = () => ({
  evaluate: () => ({ findings: [], failures: [], nextFindingSequence: 1 }),
});

/** 偽の口で動かす Page Auditor の依存（時刻は固定、画像は書かない）。 */
export function fakeAuditorDependencies(
  fake: FakeAuditLoad,
  overrides: Partial<PageAuditorDependencies> = {},
  configOverrides: TestConfigOverrides = {},
): PageAuditorDependencies {
  const config: AuditConfig = createTestConfig('https://site.test', '/', configOverrides);
  return {
    auditLoadPorts: fake.ports,
    config,
    allocator: new IdAllocator(),
    clock: () => new Date(0),
    now: () => 0,
    screenshotRootDirectory: 'unused-screenshots',
    createRuleEngine: NO_RULES,
    safetyViolationRecorded: () => false,
    navigationPacer: recordingPacer(fake.events),
    ...overrides,
  };
}

/** 監査する URL とページの ID（偽の口の場面で共通）。 */
export const FAKE_PAGE: { readonly url: string; readonly pageId: PageId } = Object.freeze({ url: 'https://site.test/', pageId: 'PAGE-000001' as PageId });
