import type {
  BrowserContext,
  CDPSession,
  Page,
  Request,
  Route,
} from 'playwright';
import { classifyPassiveRequest, type PassiveRequestDecision } from './request-policy.js';
import type { SafetyLedger } from './safety-ledger.js';

type BlockDecision = Extract<PassiveRequestDecision, { readonly action: 'BLOCK' }>;
type GuardPhase =
  | 'INSTALLING'
  | 'PASSIVE_ACTIVE'
  | 'FROZEN_ACTIVE'
  | 'PASSIVE_CLOSING'
  | 'FROZEN_CLOSING'
  | 'PASSIVE_INVALIDATING'
  | 'FROZEN_INVALIDATING'
  | 'CLOSED';
type PageGuardStatus = 'INSTALLING' | 'READY' | 'FAILED';
const OWNER_PAGE_CLOSE_MARKER_RETENTION_MS = 100;
const EXPECTED_CDP_FAILURE_RETENTION_MS = 1_000;
const GUARD_PENDING_TASK_DRAIN_TIMEOUT_MS = 1_000;

interface ExpectedCdpFailure {
  readonly method: string;
  readonly url: string;
  readonly errorText: string;
  readonly expiresAt: number;
}

interface PageDocumentGuard {
  readonly session: CDPSession;
  readonly rootFrameId: string;
}

interface PageGuardRecord {
  status: PageGuardStatus;
  readonly ready: Promise<PageDocumentGuard>;
}

interface GuardState {
  phase: GuardPhase;
  readonly context: BrowserContext;
  readonly ledger: SafetyLedger;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly pageGuards: WeakMap<Page, PageGuardRecord>;
  readonly pendingTasks: Set<Promise<void>>;
  readonly listenerCleanups: Array<() => void>;
  overflowInvalidation: Promise<void> | undefined;
  invalidationCompletion: Promise<void> | undefined;
  taskLimitReported: boolean;
  trackTask(task: Promise<unknown>, rejectionCode: string): void;
  ensurePageGuard(page: Page): PageGuardRecord;
}

const guardStates = new WeakMap<BrowserContext, GuardState>();
const ownerClosingPages = new WeakSet<Page>();

function isFrozenPhase(phase: GuardPhase): boolean {
  return phase === 'FROZEN_ACTIVE'
    || phase === 'FROZEN_CLOSING'
    || phase === 'FROZEN_INVALIDATING';
}

function isClosingOrInvalidatingPhase(phase: GuardPhase): boolean {
  return phase === 'PASSIVE_CLOSING'
    || phase === 'FROZEN_CLOSING'
    || phase === 'PASSIVE_INVALIDATING'
    || phase === 'FROZEN_INVALIDATING'
    || phase === 'CLOSED';
}

function ownerClosingPhase(phase: GuardPhase): GuardPhase {
  if (phase === 'PASSIVE_ACTIVE') return 'PASSIVE_CLOSING';
  if (phase === 'FROZEN_ACTIVE') return 'FROZEN_CLOSING';
  throw new Error(`Guarded Context close is invalid from ${phase}`);
}

function invalidatingPhase(phase: GuardPhase): GuardPhase {
  return isFrozenPhase(phase) ? 'FROZEN_INVALIDATING' : 'PASSIVE_INVALIDATING';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function drainGuardTasks(guardState: GuardState): Promise<void> {
  const deadlineAt = Date.now() + GUARD_PENDING_TASK_DRAIN_TIMEOUT_MS;
  while (guardState.pendingTasks.size > 0) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      guardState.ledger.recordInvariantViolation({
        code: 'GUARD_PENDING_TASK_DRAIN_TIMEOUT',
        message: 'Guard-owned listener tasks did not settle before cleanup deadline',
      });
      return;
    }
    const stableTasks = Array.from(guardState.pendingTasks);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const settled = await Promise.race([
        Promise.allSettled(stableTasks).then(() => true),
        new Promise<false>((resolveTimeout) => {
          timer = setTimeout(() => resolveTimeout(false), remainingMs);
        }),
      ]);
      if (!settled) {
        guardState.ledger.recordInvariantViolation({
          code: 'GUARD_PENDING_TASK_DRAIN_TIMEOUT',
          message: 'Guard-owned listener tasks did not settle before cleanup deadline',
        });
        return;
      }
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }
}

function classifyMainFrame(request: Request, ledger: SafetyLedger): boolean | undefined {
  if (!request.isNavigationRequest()) {
    return false;
  }
  try {
    return request.frame().parentFrame() === null;
  } catch (error) {
    ledger.recordInvariantViolation({
      code: 'FRAME_CLASSIFICATION_FAILED',
      message: errorMessage(error),
    });
    return undefined;
  }
}

async function invalidateContext(context: BrowserContext, ledger: SafetyLedger): Promise<void> {
  const guardState = guardStates.get(context);
  if (guardState === undefined || guardState.phase === 'CLOSED') {
    return;
  }
  if (
    guardState.phase === 'PASSIVE_INVALIDATING'
    || guardState.phase === 'FROZEN_INVALIDATING'
  ) {
    if (guardState.invalidationCompletion === undefined) {
      throw new Error('Invalidating passive request guard has no completion owner');
    }
    return guardState.invalidationCompletion;
  }
  if (guardState.phase === 'PASSIVE_CLOSING' || guardState.phase === 'FROZEN_CLOSING') {
    return;
  }
  guardState.phase = invalidatingPhase(guardState.phase);
  let beginCompletion!: () => void;
  const completionStart = new Promise<void>((resolve) => {
    beginCompletion = resolve;
  });
  const completion = (async (): Promise<void> => {
    await completionStart;
    let closeSucceeded = false;
    try {
      await context.close();
      closeSucceeded = true;
    } catch (error) {
      ledger.recordInvariantViolation({
        code: 'GUARD_CONTEXT_INVALIDATION_FAILED',
        message: errorMessage(error),
      });
    }
    await drainGuardTasks(guardState);
    if (closeSucceeded) {
      if (
        guardState.phase === 'PASSIVE_INVALIDATING'
        || guardState.phase === 'FROZEN_INVALIDATING'
      ) {
        guardState.phase = 'CLOSED';
      }
    }
  })();
  guardState.invalidationCompletion = completion;
  beginCompletion();
  return completion;
}

function registerExpectedCdpFailure(
  expectedCdpFailures: WeakMap<Page, ExpectedCdpFailure[]>,
  page: Page,
  request: { readonly method: string; readonly url: string },
): ExpectedCdpFailure {
  const expectedFailure: ExpectedCdpFailure = {
    method: request.method.toUpperCase(),
    url: request.url,
    errorText: 'net::ERR_BLOCKED_BY_CLIENT',
    expiresAt: Date.now() + EXPECTED_CDP_FAILURE_RETENTION_MS,
  };
  const failures = expectedCdpFailures.get(page) ?? [];
  failures.push(expectedFailure);
  expectedCdpFailures.set(page, failures);
  return expectedFailure;
}

function removeExpectedCdpFailure(
  expectedCdpFailures: WeakMap<Page, ExpectedCdpFailure[]>,
  page: Page,
  expectedFailure: ExpectedCdpFailure,
): void {
  const failures = expectedCdpFailures.get(page);
  const index = failures?.indexOf(expectedFailure) ?? -1;
  if (index >= 0) {
    failures?.splice(index, 1);
  }
}

function recordBlockedDecision(
  ledger: SafetyLedger,
  decision: BlockDecision,
  request: { readonly method: string; readonly url: string },
): void {
  if (decision.category === 'REQUEST') {
    ledger.recordBlockedRequest({ ...request, reason: decision.reason });
  } else if (decision.category === 'NAVIGATION') {
    ledger.recordBlockedNavigation({ ...request, reason: decision.reason });
  } else {
    ledger.recordInvariantViolation({
      code: 'UNEXPECTED_HTTP_DECISION',
      message: `HTTP policy returned ${decision.category}`,
    });
  }
}

async function abortHttpRequest(
  context: BrowserContext,
  route: Route,
  ledger: SafetyLedger,
  decision: BlockDecision,
  request: { readonly method: string; readonly url: string },
): Promise<void> {
  try {
    await route.abort('blockedbyclient');
    recordBlockedDecision(ledger, decision, request);
  } catch (error) {
    ledger.recordInvariantViolation({ code: 'HTTP_ABORT_FAILED', message: errorMessage(error) });
    await invalidateContext(context, ledger);
    throw error;
  }
}

async function abortUnreadyNavigation(
  context: BrowserContext,
  route: Route,
  ledger: SafetyLedger,
): Promise<void> {
  let abortError: unknown;
  try {
    await route.abort('blockedbyclient');
  } catch (error) {
    abortError = error;
    ledger.recordInvariantViolation({ code: 'HTTP_ABORT_FAILED', message: errorMessage(error) });
  }
  await invalidateContext(context, ledger);
  if (abortError !== undefined) {
    throw abortError;
  }
}

async function abortInteractionRequest(
  context: BrowserContext,
  route: Route,
  ledger: SafetyLedger,
  request: { readonly method: string; readonly url: string; readonly navigation: boolean },
): Promise<void> {
  ledger.recordBlockedInteractionRequest({
    method: request.method,
    url: request.url,
    reason: 'INTERACTION_FROZEN',
  });
  if (request.navigation) {
    ledger.recordBlockedInteractionNavigation({
      method: request.method,
      url: request.url,
      reason: 'INTERACTION_FROZEN',
    });
  }
  try {
    await route.abort('blockedbyclient');
  } catch (error) {
    ledger.recordInvariantViolation({ code: 'INTERACTION_HTTP_ABORT_FAILED', message: errorMessage(error) });
    await invalidateContext(context, ledger);
    throw error;
  }
}

async function continueNative(context: BrowserContext, route: Route, ledger: SafetyLedger): Promise<void> {
  try {
    await route.fallback();
  } catch (error) {
    ledger.recordInvariantViolation({ code: 'HTTP_FALLBACK_FAILED', message: errorMessage(error) });
    try {
      await route.abort('blockedbyclient');
    } catch (abortError) {
      ledger.recordInvariantViolation({ code: 'HTTP_ABORT_FAILED', message: errorMessage(abortError) });
    }
    await invalidateContext(context, ledger);
    throw error;
  }
}

async function failPausedDocumentForLifecycle(
  context: BrowserContext,
  session: CDPSession,
  requestId: string,
  ledger: SafetyLedger,
  expectedCdpFailures: WeakMap<Page, ExpectedCdpFailure[]>,
  page: Page,
  request: { readonly method: string; readonly url: string },
): Promise<void> {
  const expectedFailure = registerExpectedCdpFailure(expectedCdpFailures, page, request);
  try {
    await session.send('Fetch.failRequest', {
      requestId,
      errorReason: 'BlockedByClient',
    });
  } catch (error) {
    removeExpectedCdpFailure(expectedCdpFailures, page, expectedFailure);
    ledger.recordInvariantViolation({
      code: 'CDP_LIFECYCLE_FAIL_REQUEST_FAILED',
      message: errorMessage(error),
    });
    if (!isClosingOrInvalidatingPhase(guardStates.get(context)?.phase ?? 'CLOSED')) {
      void invalidateContext(context, ledger);
    }
  }
}

export async function awaitPassiveRequestGuardReady(page: Page): Promise<void> {
  const context = page.context();
  const guardState = guardStates.get(context);
  if (guardState === undefined) {
    throw new Error('Passive request guard is not installed for this page context');
  }
  if (isClosingOrInvalidatingPhase(guardState.phase)) {
    throw new Error('Passive request guard context was invalidated');
  }
  if (guardState.phase !== 'PASSIVE_ACTIVE') {
    throw new Error('Passive request guard is not installed for this page context');
  }
  if (page.isClosed()) {
    throw new Error('Passive request guard cannot become ready for a closed page');
  }
  await guardState.ensurePageGuard(page).ready;
  if (guardState.phase !== 'PASSIVE_ACTIVE') {
    throw new Error('Passive request guard context was invalidated');
  }
  if (page.isClosed()) {
    throw new Error('Passive request guard page closed during setup');
  }
}

function requireGuardState(context: BrowserContext, allowed: readonly GuardPhase[]): GuardState {
  const guardState = guardStates.get(context);
  if (guardState === undefined || !allowed.includes(guardState.phase)) {
    throw new Error(`Passive request guard phase is not allowed (${guardState?.phase ?? 'MISSING'})`);
  }
  return guardState;
}

function requireActiveGuardState(context: BrowserContext, allowed: readonly GuardPhase[]): GuardState {
  const guardState = guardStates.get(context);
  if (guardState === undefined) {
    throw new Error('Passive request guard is not installed for this context');
  }
  if (isClosingOrInvalidatingPhase(guardState.phase)) {
    throw new Error('Passive request guard context was invalidated');
  }
  return requireGuardState(context, allowed);
}

export function assertPassiveRequestGuardActive(context: BrowserContext): void {
  requireActiveGuardState(context, ['PASSIVE_ACTIVE', 'FROZEN_ACTIVE']);
}

/** Irreversibly changes the existing passive guard into an all-new-activity freeze. */
export async function activateInteractionFreeze(page: Page): Promise<void> {
  const context = page.context();
  const guardState = requireActiveGuardState(context, ['PASSIVE_ACTIVE', 'FROZEN_ACTIVE']);
  const failClosed = async (message: string): Promise<never> => {
    guardState.ledger.recordInvariantViolation({ code: 'INTERACTION_FREEZE_ACTIVATION_FAILED', message });
    await invalidateContext(context, guardState.ledger);
    throw new Error(message);
  };
  if (guardState.phase !== 'PASSIVE_ACTIVE') {
    return failClosed(`Interaction freeze transition is invalid from ${guardState.phase}`);
  }
  if (page.isClosed() || guardState.pageGuards.get(page)?.status !== 'READY') {
    return failClosed('Interaction freeze requires the current guarded page to be ready');
  }
  const activePages = context.pages().filter((candidate) => !candidate.isClosed());
  if (activePages.length !== 1 || activePages[0] !== page) {
    return failClosed('Interaction freeze requires exactly one current owner page');
  }
  let currentUrl: URL;
  try {
    currentUrl = new URL(page.url());
  } catch {
    return failClosed('Interaction freeze requires a completed initial HTTP(S) load');
  }
  if (currentUrl.protocol !== 'http:' && currentUrl.protocol !== 'https:') {
    return failClosed('Interaction freeze requires a completed initial HTTP(S) load');
  }
  guardState.phase = 'FROZEN_ACTIVE';
}

export async function closePassiveGuardedPage(page: Page): Promise<void> {
  const context = page.context();
  const guardState = requireActiveGuardState(context, ['PASSIVE_ACTIVE', 'FROZEN_ACTIVE']);
  if (guardState.pageGuards.get(page)?.status !== 'READY') {
    throw new Error('Passive request guard is not ready for this page');
  }
  if (ownerClosingPages.has(page)) {
    throw new Error('Passive guarded page close is already in progress');
  }
  ownerClosingPages.add(page);
  let closeSucceeded = false;
  try {
    await page.close();
    closeSucceeded = true;
  } catch (error) {
    guardState.ledger.recordInvariantViolation({
      code: 'GUARDED_PAGE_CLOSE_FAILED',
      message: errorMessage(error),
    });
    await invalidateContext(context, guardState.ledger);
    throw error;
  } finally {
    if (closeSucceeded) {
      setTimeout(() => ownerClosingPages.delete(page), OWNER_PAGE_CLOSE_MARKER_RETENTION_MS);
    } else {
      ownerClosingPages.delete(page);
    }
  }
}

export async function closePassiveGuardedContext(context: BrowserContext): Promise<void> {
  const guardState = requireActiveGuardState(context, ['PASSIVE_ACTIVE', 'FROZEN_ACTIVE']);
  guardState.phase = ownerClosingPhase(guardState.phase);
  let closeError: unknown;
  let resolveInvalidationCompletion: (() => void) | undefined;
  try {
    await context.close();
  } catch (error) {
    closeError = error;
    guardState.invalidationCompletion = new Promise<void>((resolve) => {
      resolveInvalidationCompletion = resolve;
    });
    guardState.phase = invalidatingPhase(guardState.phase);
    guardState.ledger.recordInvariantViolation({
      code: 'GUARDED_CONTEXT_CLOSE_FAILED',
      message: errorMessage(error),
    });
  } finally {
    await drainGuardTasks(guardState);
    resolveInvalidationCompletion?.();
  }
  if (closeError !== undefined) throw closeError;
  guardState.phase = 'CLOSED';
}

export async function installPassiveRequestGuard(
  context: BrowserContext,
  ledger: SafetyLedger,
  allowedOrigins: ReadonlySet<string>,
): Promise<void> {
  const existingState = guardStates.get(context);
  if (existingState !== undefined) {
    const message = `Passive request guard is already installed or invalidated (${existingState.phase})`;
    ledger.recordInvariantViolation({ code: 'GUARD_REPEAT_INSTALLATION', message });
    throw new Error(message);
  }

  const authoritySnapshot = new Set(allowedOrigins);
  const pageGuards = new WeakMap<Page, PageGuardRecord>();
  const pendingTasks = new Set<Promise<void>>();
  const expectedCdpFailures = new WeakMap<Page, ExpectedCdpFailure[]>();
  const expectedRouteFailures = new WeakSet<Request>();
  const recordedFrozenPopups = new WeakSet<Page>();
  const guardState: GuardState = {
    phase: 'INSTALLING',
    context,
    ledger,
    allowedOrigins: authoritySnapshot,
    pageGuards,
    pendingTasks,
    listenerCleanups: [],
    overflowInvalidation: undefined,
    invalidationCompletion: undefined,
    taskLimitReported: false,
    trackTask(task: Promise<unknown>, rejectionCode: string): void {
      let trackedTask: Promise<void>;
      trackedTask = task.then(
        () => undefined,
        (error: unknown) => {
          ledger.recordInvariantViolation({ code: rejectionCode, message: errorMessage(error) });
        },
      ).finally(() => {
        pendingTasks.delete(trackedTask);
      });
      pendingTasks.add(trackedTask);
    },
    ensurePageGuard(page: Page): PageGuardRecord {
      const existing = pageGuards.get(page);
      if (existing !== undefined) {
        return existing;
      }
      let record: PageGuardRecord;
      const ready = (async (): Promise<PageDocumentGuard> => {
        const session = await context.newCDPSession(page);
        const frameTree = await session.send('Page.getFrameTree');
        const rootFrameId = frameTree.frameTree.frame.id;
        const interceptedDocuments = new Map<string, { readonly method: string; readonly url: string }>();
        session.on('close', () => {
          if (
            !ownerClosingPages.has(page)
            && !isClosingOrInvalidatingPhase(guardState.phase)
          ) {
            ledger.recordInvariantViolation({
              code: 'CDP_SESSION_DETACHED',
              message: 'Document interception session detached while its page remained active',
            });
            void invalidateContext(context, ledger);
          }
        });
        session.on('Fetch.requestPaused', (event) => {
          guardState.trackTask((async () => {
            const phase = guardState.phase;
            const interceptedRequest = {
              method: event.request.method.toUpperCase(),
              url: event.request.url,
            };
            const playwrightVisibleRequest = event.redirectedRequestId === undefined
              ? interceptedRequest
              : interceptedDocuments.get(event.redirectedRequestId) ?? interceptedRequest;
            if (isFrozenPhase(phase)) {
              const expectedFailure = registerExpectedCdpFailure(
                expectedCdpFailures,
                page,
                playwrightVisibleRequest,
              );
              ledger.recordBlockedInteractionRequest({
                method: interceptedRequest.method,
                url: interceptedRequest.url,
                reason: 'INTERACTION_FROZEN',
              });
              ledger.recordBlockedInteractionNavigation({
                method: interceptedRequest.method,
                url: interceptedRequest.url,
                reason: 'INTERACTION_FROZEN',
              });
              try {
                await session.send('Fetch.failRequest', {
                  requestId: event.requestId,
                  errorReason: 'BlockedByClient',
                });
              } catch (error) {
                removeExpectedCdpFailure(expectedCdpFailures, page, expectedFailure);
                ledger.recordInvariantViolation({
                  code: 'INTERACTION_CDP_FAIL_REQUEST_FAILED',
                  message: errorMessage(error),
                });
                void invalidateContext(context, ledger);
              }
              return;
            }
            if (isClosingOrInvalidatingPhase(phase) || ownerClosingPages.has(page)) {
              await failPausedDocumentForLifecycle(
                context,
                session,
                event.requestId,
                ledger,
                expectedCdpFailures,
                page,
                playwrightVisibleRequest,
              );
              return;
            }
            if (phase !== 'PASSIVE_ACTIVE') {
              ledger.recordInvariantViolation({
                code: 'CDP_DOCUMENT_PHASE_INVALID',
                message: `Paused Document observed during ${phase}`,
              });
              await failPausedDocumentForLifecycle(
                context,
                session,
                event.requestId,
                ledger,
                expectedCdpFailures,
                page,
                playwrightVisibleRequest,
              );
              return;
            }
            interceptedDocuments.set(event.requestId, interceptedRequest);
            const decision = classifyPassiveRequest({
              kind: 'HTTP',
              method: interceptedRequest.method,
              url: event.request.url,
              isNavigationRequest: true,
              isMainFrame: event.frameId === rootFrameId,
            }, authoritySnapshot);
            if (decision.action === 'BLOCK') {
              const redirectedFrom = event.redirectedRequestId === undefined
                ? undefined
                : interceptedDocuments.get(event.redirectedRequestId);
              let expectedFailure: ExpectedCdpFailure | undefined;
              if (redirectedFrom !== undefined) {
                expectedFailure = registerExpectedCdpFailure(expectedCdpFailures, page, redirectedFrom);
              }
              try {
                await session.send('Fetch.failRequest', {
                  requestId: event.requestId,
                  errorReason: 'BlockedByClient',
                });
                recordBlockedDecision(ledger, decision, {
                  method: event.request.method,
                  url: event.request.url,
                });
              } catch (error) {
                if (expectedFailure !== undefined) {
                  removeExpectedCdpFailure(expectedCdpFailures, page, expectedFailure);
                }
                ledger.recordInvariantViolation({
                  code: 'CDP_FAIL_REQUEST_FAILED',
                  message: errorMessage(error),
                });
                void invalidateContext(context, ledger);
              }
              return;
            }
            try {
              await session.send('Fetch.continueRequest', { requestId: event.requestId });
            } catch (error) {
              ledger.recordInvariantViolation({
                code: 'CDP_CONTINUE_REQUEST_FAILED',
                message: errorMessage(error),
              });
              void invalidateContext(context, ledger);
            }
          })(), 'GUARD_CDP_PAUSED_TASK_FAILED');
        });
        await session.send('Fetch.enable', {
          patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }],
        });
        return { session, rootFrameId };
      })().then((guard) => {
        record.status = 'READY';
        return guard;
      }).catch(async (error: unknown) => {
        record.status = 'FAILED';
        ledger.recordInvariantViolation({ code: 'CDP_SETUP_FAILED', message: errorMessage(error) });
        void invalidateContext(context, ledger);
        throw error;
      });
      record = { status: 'INSTALLING', ready };
      pageGuards.set(page, record);
      guardState.trackTask(ready.catch(() => undefined), 'GUARD_PAGE_READINESS_TASK_FAILED');
      return record;
    },
  };
  guardStates.set(context, guardState);

  if (context.pages().length > 0) {
    const error = new Error('Passive request guard must be installed before creating any pages');
    ledger.recordInvariantViolation({ code: 'GUARD_INSTALLATION_FAILED', message: error.message });
    await invalidateContext(context, ledger);
    throw error;
  }

  const recordAndCloseFrozenPopup = (page: Page): void => {
    if (recordedFrozenPopups.has(page)) {
      return;
    }
    recordedFrozenPopups.add(page);
    ledger.recordBlockedPopup({ url: page.url(), reason: 'INTERACTION_FROZEN' });
    ownerClosingPages.add(page);
    guardState.trackTask(page.close().catch(async (error: unknown) => {
      ledger.recordInvariantViolation({ code: 'INTERACTION_POPUP_CLOSE_FAILED', message: errorMessage(error) });
      void invalidateContext(context, ledger);
    }).finally(() => {
      ownerClosingPages.delete(page);
    }), 'GUARD_POPUP_CLOSE_TASK_FAILED');
  };
  const onPage = (page: Page): void => {
    const phase = guardState.phase;
    if (isFrozenPhase(phase)) {
      recordAndCloseFrozenPopup(page);
      return;
    }
    if (isClosingOrInvalidatingPhase(phase)) {
      return;
    }
    if (phase !== 'PASSIVE_ACTIVE') {
      ledger.recordInvariantViolation({
        code: 'GUARD_PAGE_PHASE_INVALID',
        message: `Page observed during ${phase}`,
      });
      void invalidateContext(context, ledger);
      return;
    }
    page.on('download', (download) => {
      const downloadPhase = guardState.phase;
      if (!isFrozenPhase(downloadPhase)) {
        return;
      }
      ledger.recordBlockedDownload({
        url: download.url(),
        suggestedFilename: download.suggestedFilename(),
        reason: 'INTERACTION_FROZEN',
      });
      guardState.trackTask(download.cancel().catch(async (error: unknown) => {
        ledger.recordInvariantViolation({
          code: 'INTERACTION_DOWNLOAD_CANCEL_FAILED',
          message: errorMessage(error),
        });
        void invalidateContext(context, ledger);
      }), 'GUARD_DOWNLOAD_CANCEL_TASK_FAILED');
    });
    page.on('popup', (popup) => {
      if (isFrozenPhase(guardState.phase)) {
        recordAndCloseFrozenPopup(popup);
      }
    });
    page.on('framenavigated', (frame) => {
      if (isFrozenPhase(guardState.phase)) {
        ledger.recordBlockedInteractionNavigation({
          method: 'GET',
          url: frame.url(),
          reason: 'INTERACTION_FROZEN',
        });
      }
    });
    guardState.ensurePageGuard(page);
  };
  const onRequestFailed = async (request: Request): Promise<void> => {
    if (expectedRouteFailures.has(request)) {
      return;
    }
    const isMainFrame = classifyMainFrame(request, ledger);
    if (isMainFrame === undefined) {
      await invalidateContext(context, ledger);
      return;
    }
    let requestPage: Page | undefined;
    if (isMainFrame) {
      try {
        requestPage = request.frame().page();
      } catch (error) {
        ledger.recordInvariantViolation({ code: 'CDP_PAGE_LOOKUP_FAILED', message: errorMessage(error) });
        await invalidateContext(context, ledger);
        return;
      }
    }
    const message = request.failure()?.errorText ?? 'main-frame request failed without an error reason';
    if (requestPage !== undefined) {
      const failures = expectedCdpFailures.get(requestPage);
      if (failures !== undefined) {
        const now = Date.now();
        const failureIndex = failures.findIndex((failure) => (
          failure.expiresAt >= now
          && failure.method === request.method().toUpperCase()
          && failure.url === request.url()
          && failure.errorText === message
        ));
        if (failureIndex >= 0) {
          failures.splice(failureIndex, 1);
          return;
        }
        expectedCdpFailures.set(
          requestPage,
          failures.filter((failure) => failure.expiresAt >= now),
        );
      }
    }
    const decision = classifyPassiveRequest({
      kind: 'HTTP',
      method: request.method(),
      url: request.url(),
      isNavigationRequest: request.isNavigationRequest(),
      isMainFrame,
    }, authoritySnapshot);
    if (decision.action === 'ALLOW' && request.isNavigationRequest() && isMainFrame) {
      if (
        message === 'net::ERR_ABORTED'
        && requestPage !== undefined
        && (
          ownerClosingPages.has(requestPage)
          || isClosingOrInvalidatingPhase(guardState.phase)
        )
      ) {
        return;
      }
      ledger.recordInvariantViolation({ code: 'HTTP_MAIN_FRAME_DELIVERY_FAILED', message });
      await invalidateContext(context, ledger);
    }
  };

  try {
    context.on('page', onPage);
    context.on('requestfailed', onRequestFailed);

    await context.routeWebSocket(/.*/, async (webSocketRoute) => {
      const phase = guardState.phase;
      if (isFrozenPhase(phase)) {
        ledger.recordBlockedInteractionWebSocket({
          url: webSocketRoute.url(),
          reason: 'INTERACTION_FROZEN',
        });
        try {
          await webSocketRoute.close({ code: 1008, reason: 'INTERACTION_FROZEN' });
        } catch (error) {
          ledger.recordInvariantViolation({ code: 'WEBSOCKET_CLOSE_FAILED', message: errorMessage(error) });
          await invalidateContext(context, ledger);
        }
        return;
      }
      if (isClosingOrInvalidatingPhase(phase)) {
        try {
          await webSocketRoute.close({ code: 1008, reason: 'GUARD_LIFECYCLE_CLOSED' });
        } catch (error) {
          ledger.recordInvariantViolation({ code: 'WEBSOCKET_CLOSE_FAILED', message: errorMessage(error) });
        }
        return;
      }
      if (phase !== 'PASSIVE_ACTIVE') {
        ledger.recordInvariantViolation({
          code: 'WEBSOCKET_PHASE_INVALID',
          message: `WebSocket observed during ${phase}`,
        });
        try {
          await webSocketRoute.close({ code: 1008, reason: 'GUARD_PHASE_INVALID' });
        } catch (error) {
          ledger.recordInvariantViolation({ code: 'WEBSOCKET_CLOSE_FAILED', message: errorMessage(error) });
        }
        await invalidateContext(context, ledger);
        return;
      }
      const decision = classifyPassiveRequest({ kind: 'WEBSOCKET', url: webSocketRoute.url() }, authoritySnapshot);
      if (decision.action === 'ALLOW') {
        ledger.recordInvariantViolation({
          code: 'UNEXPECTED_WEBSOCKET_ALLOW',
          message: `Passive WebSocket policy unexpectedly returned ${decision.delivery}`,
        });
        await invalidateContext(context, ledger);
        return;
      }
      if (decision.category !== 'WEBSOCKET') {
        ledger.recordInvariantViolation({
          code: 'UNEXPECTED_WEBSOCKET_DECISION',
          message: `WebSocket policy returned ${decision.category}`,
        });
        await invalidateContext(context, ledger);
        return;
      }
      ledger.recordBlockedWebSocket({ url: webSocketRoute.url(), reason: decision.reason });
      try {
        await webSocketRoute.close({ code: 1008, reason: decision.reason });
      } catch (error) {
        ledger.recordInvariantViolation({ code: 'WEBSOCKET_CLOSE_FAILED', message: errorMessage(error) });
      }
    });

    await context.route('**/*', async (route) => {
      const request = route.request();
      const phase = guardState.phase;
      if (isFrozenPhase(phase)) {
        const isNavigationRequest = request.isNavigationRequest();
        expectedRouteFailures.add(request);
        await abortInteractionRequest(context, route, ledger, {
          method: request.method(),
          url: request.url(),
          navigation: isNavigationRequest,
        });
        return;
      }
      if (isClosingOrInvalidatingPhase(phase)) {
        try {
          await route.abort('blockedbyclient');
        } catch (error) {
          ledger.recordInvariantViolation({ code: 'HTTP_ABORT_FAILED', message: errorMessage(error) });
        }
        return;
      }
      if (phase !== 'PASSIVE_ACTIVE') {
        ledger.recordInvariantViolation({
          code: 'HTTP_ROUTE_PHASE_INVALID',
          message: `HTTP route observed during ${phase}`,
        });
        try {
          await route.abort('blockedbyclient');
        } catch (error) {
          ledger.recordInvariantViolation({ code: 'HTTP_ABORT_FAILED', message: errorMessage(error) });
        }
        await invalidateContext(context, ledger);
        return;
      }
      const isNavigationRequest = request.isNavigationRequest();
      const isMainFrame = classifyMainFrame(request, ledger);
      if (isMainFrame === undefined) {
        expectedRouteFailures.add(request);
        await abortUnreadyNavigation(context, route, ledger);
        return;
      }
      const decision = classifyPassiveRequest({
        kind: 'HTTP',
        method: request.method(),
        url: request.url(),
        isNavigationRequest,
        isMainFrame,
      }, authoritySnapshot);

      if (isNavigationRequest) {
        let page: Page;
        try {
          page = request.frame().page();
        } catch (error) {
          ledger.recordInvariantViolation({ code: 'CDP_PAGE_LOOKUP_FAILED', message: errorMessage(error) });
          expectedRouteFailures.add(request);
          await abortUnreadyNavigation(context, route, ledger);
          throw error;
        }
        const pageGuard = pageGuards.get(page);
        if (pageGuard?.status !== 'READY') {
          ledger.recordInvariantViolation({
            code: 'PASSIVE_GUARD_PAGE_NOT_READY',
            message: `Navigation started before explicit page readiness: ${request.method()} ${request.url()}`,
          });
          expectedRouteFailures.add(request);
          await abortUnreadyNavigation(context, route, ledger);
          return;
        }
      }

      if (decision.action === 'BLOCK') {
        expectedRouteFailures.add(request);
        await abortHttpRequest(context, route, ledger, decision, {
          method: request.method(),
          url: request.url(),
        });
        return;
      }
      await continueNative(context, route, ledger);
    });
  } catch (error) {
    ledger.recordInvariantViolation({ code: 'GUARD_INSTALLATION_FAILED', message: errorMessage(error) });
    await invalidateContext(context, ledger);
    throw error;
  }

  if (guardState.phase !== 'INSTALLING') {
    if (guardState.invalidationCompletion === undefined) {
      throw new Error('Invalidated passive request guard installation has no completion owner');
    }
    await guardState.invalidationCompletion;
    throw new Error(`Passive request guard installation was invalidated (${guardState.phase})`);
  }
  guardState.phase = 'PASSIVE_ACTIVE';
}
