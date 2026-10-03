import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';
import { BrowserContextFactory, type InteractionGuardedSession } from '../../src/browser/context-factory.js';
import type { AuditConfig, Viewport } from '../../src/config/types.js';
import {
  discoverInteractionCandidates,
  inspectInteractionCandidateHandle,
  INTERACTION_CANDIDATE_SELECTOR,
} from '../../src/interaction/discover-candidates.js';
import { auditInteraction, type InteractionAuditInput } from '../../src/interaction/isolated-auditor.js';
import {
  classifyInteractionCandidate,
  type InteractionCandidate,
} from '../../src/safety/interaction-policy.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';

const viewport: Viewport = Object.freeze({ width: 900, height: 700 });
let browser: Browser;
let server: FixtureServer;
let factory: BrowserContextFactory;

function configFor(origin: string): AuditConfig {
  return {
    site: { startUrl: `${origin}/index.html`, allowedOrigins: [origin] },
    crawl: {
      maxPages: 10,
      maxDepth: 2,
      maxRuntimeMs: 30_000,
      navigationTimeoutMs: 5_000,
      overallPageTimeoutMs: 5_000,
      resourceSettlingTimeoutMs: 500,
      interactionTimeoutMs: 500,
      allowedQueryParameters: [],
    },
    browser: { headed: false, locale: 'ja-JP', timezone: 'Asia/Tokyo' },
    viewports: { primaryDesktop: viewport, primaryMobile: { width: 390, height: 844 }, stressWidths: [] },
    audit: { performance: true, accessibility: true, interactions: true, screenshots: true },
    output: { directory: './tmp' },
  };
}

beforeAll(async () => {
  server = await startFixtureServer();
  browser = await chromium.launch({ headless: true });
  factory = new BrowserContextFactory(browser, configFor(server.origin), () => new SafetyLedger());
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

async function discover(path: string): Promise<readonly InteractionCandidate[]> {
  const context = await factory.createPassiveContext(viewport);
  const page = await factory.createPassivePage(context);
  try {
    await page.goto(`${server.origin}${path}`, { waitUntil: 'load' });
    return await discoverInteractionCandidates(page);
  } finally {
    await factory.closePassiveContext(context);
  }
}

async function candidateNamed(path: string, name: string): Promise<InteractionCandidate> {
  const found = (await discover(path)).find((candidate) => candidate.accessibleName === name);
  if (found === undefined) {
    throw new Error(`Missing fixture interaction candidate: ${path} ${name}`);
  }
  return found;
}

function input(path: string, candidate: InteractionCandidate): InteractionAuditInput {
  return {
    sessionFactory: (sessionViewport) => factory.createInteractionSession(sessionViewport),
    targetUrl: `${server.origin}${path}`,
    candidate,
    viewport,
    timeoutMs: 2_000,
    deadlineAtMs: Date.now() + 5_000,
  };
}

describe('interaction candidate discovery', () => {
  it('discovers the generic union once in document order, deduplicates it, bounds facts, and leaves DOM untouched', async () => {
    const context = await factory.createPassiveContext(viewport);
    const page = await factory.createPassivePage(context);
    try {
      await page.goto(`${server.origin}/accordion.html`, { waitUntil: 'load' });
      const before = await page.content();

      const candidates = await discoverInteractionCandidates(page);

      expect(candidates).toHaveLength(3);
      expect(candidates.map((candidate) => [candidate.ordinal, candidate.tagName, candidate.role])).toEqual([
        [0, 'button', null],
        [1, 'div', 'tab'],
        [2, 'summary', null],
      ]);
      expect(candidates[0]).toMatchObject({
        accessibleName: 'Toggle details',
        ariaExpanded: 'false',
        ariaControls: 'accordion-panel',
        controlledVisible: false,
        controlledHidden: true,
      });
      expect(candidates[0]?.candidateId).toMatch(/^interaction-candidate:sha256:[a-f0-9]{64}$/u);
      expect(candidates[0]?.textFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
      expect(Object.isFrozen(candidates)).toBe(true);
      expect(Object.isFrozen(candidates[0])).toBe(true);
      expect(Object.isFrozen(candidates[0]?.boundingBox)).toBe(true);
      expect(await page.content()).toBe(before);
    } finally {
      await factory.closePassiveContext(context);
    }
  });

  it('retains at most 100 candidates and bounds every persisted name', async () => {
    const candidates = await discover('/candidate-overflow.html');

    expect(candidates).toHaveLength(100);
    expect(candidates.at(-1)?.ordinal).toBe(99);
    expect(candidates.every((candidate) => candidate.accessibleName.length <= 256)).toBe(true);
    expect(candidates.every(Object.isFrozen)).toBe(true);
  });

  it('does not iterate a hostile NodeList or materialize full descendant text during discovery', async () => {
    const context = await factory.createPassiveContext(viewport);
    const page = await factory.createPassivePage(context);
    try {
      await page.goto(`${server.origin}/hostile-candidates.html`, { waitUntil: 'load' });
      await page.evaluate((maxTextNodes) => {
        Object.defineProperty(NodeList.prototype, Symbol.iterator, {
          configurable: true,
          value(): never {
            throw new Error('NodeList iterator must not be used');
          },
        });
        Object.defineProperty(Node.prototype, 'textContent', {
          configurable: true,
          get(): never {
            throw new Error('full textContent must not be materialized');
          },
        });
        Object.defineProperty(Node.prototype, 'nodeValue', {
          configurable: true,
          get(): never {
            throw new Error('full text-node value must not be materialized');
          },
        });
        const createTreeWalker = document.createTreeWalker.bind(document);
        Object.defineProperty(document, 'createTreeWalker', {
          configurable: true,
          value(root: Node, whatToShow: number, filter?: NodeFilter | null) {
            const walker = createTreeWalker(root, whatToShow, filter);
            let nextCalls = 0;
            return new Proxy(walker, {
              get(target, property) {
                if (property === 'nextNode') {
                  return () => {
                    nextCalls += 1;
                    if (nextCalls > maxTextNodes) {
                      throw new Error('bounded text walk exceeded its node limit');
                    }
                    return target.nextNode();
                  };
                }
                return Reflect.get(target, property, target) as unknown;
              },
            });
          },
        });
      }, 512);

      const candidates = await discoverInteractionCandidates(page);

      expect(candidates).toHaveLength(1);
      expect(candidates[0]?.accessibleName).toBe('x'.repeat(256));
      expect(candidates[0]?.accessibleName.length).toBeLessThanOrEqual(256);
    } finally {
      await factory.closePassiveContext(context);
    }
  });

  it('inspects a retained handle without iterating the candidate NodeList', async () => {
    const context = await factory.createPassiveContext(viewport);
    const page = await factory.createPassivePage(context);
    try {
      await page.goto(`${server.origin}/accordion.html`, { waitUntil: 'load' });
      const handle = await page.locator(INTERACTION_CANDIDATE_SELECTOR).first().elementHandle();
      if (handle === null) {
        throw new Error('fixture candidate handle missing');
      }
      try {
        await page.evaluate(() => {
          Object.defineProperty(NodeList.prototype, Symbol.iterator, {
            configurable: true,
            value(): never {
              throw new Error('NodeList iterator must not be used');
            },
          });
        });

        await expect(inspectInteractionCandidateHandle(handle, 0)).resolves.toMatchObject({ connected: true });
      } finally {
        await handle.dispose();
      }
    } finally {
      await factory.closePassiveContext(context);
    }
  });

  it('fails closed when a retained handle is outside the bounded ordinal scan', async () => {
    const context = await factory.createPassiveContext(viewport);
    const page = await factory.createPassivePage(context);
    try {
      await page.goto(`${server.origin}/candidate-overflow.html`, { waitUntil: 'load' });
      const handle = await page.locator(INTERACTION_CANDIDATE_SELECTOR).nth(100).elementHandle();
      if (handle === null) {
        throw new Error('overflow fixture candidate handle missing');
      }
      try {
        await expect(inspectInteractionCandidateHandle(handle, 99)).resolves.toEqual({ connected: false });
      } finally {
        await handle.dispose();
      }
    } finally {
      await factory.closePassiveContext(context);
    }
  });

  it('discovers hidden and visible generic candidates without aborting the page snapshot', async () => {
    const candidates = await discover('/hidden-candidates.html');
    const hidden = candidates.find((candidate) => candidate.accessibleName === 'Hidden candidate');
    const visible = candidates.find((candidate) => candidate.accessibleName === 'Visible candidate');

    expect(candidates).toHaveLength(2);
    expect(hidden).toMatchObject({
      visible: false,
      boundingBox: { width: 0, height: 0 },
    });
    expect(classifyInteractionCandidate(hidden as InteractionCandidate)).toEqual({
      action: 'REJECT',
      reason: 'NOT_VISIBLE',
    });
    expect(classifyInteractionCandidate(visible as InteractionCandidate)).toEqual({
      action: 'ALLOW',
      reason: 'MECHANICALLY_SAFE',
    });
  });

  it('discovers an unresolved aria-controls candidate and a safe sibling without aborting', async () => {
    const candidates = await discover('/missing-aria-controls.html');
    const unresolved = candidates.find((candidate) => candidate.accessibleName === 'Missing controlled target');

    expect(candidates.map((candidate) => candidate.accessibleName)).toEqual([
      'Missing controlled target',
      'Safe sibling',
    ]);
    expect(unresolved).toMatchObject({
      ariaControls: 'absent-panel',
      controlledVisible: null,
      controlledHidden: null,
    });
  });

  it('keeps semantic identity stable when an unrelated candidate is inserted before it', async () => {
    const context = await factory.createPassiveContext(viewport);
    const page = await factory.createPassivePage(context);
    try {
      await page.goto(`${server.origin}/accordion.html`, { waitUntil: 'load' });
      const before = (await discoverInteractionCandidates(page))
        .find((candidate) => candidate.accessibleName === 'Toggle details');
      await page.evaluate(() => {
        const inserted = document.createElement('button');
        inserted.type = 'button';
        inserted.textContent = 'Unrelated inserted candidate';
        document.body.prepend(inserted);
      });
      const after = (await discoverInteractionCandidates(page))
        .find((candidate) => candidate.accessibleName === 'Toggle details');
      const unrelated = (await discoverInteractionCandidates(page))
        .find((candidate) => candidate.accessibleName === 'Unrelated inserted candidate');

      expect(before?.ordinal).toBe(0);
      expect(after?.ordinal).toBe(1);
      expect(after?.candidateId).toBe(before?.candidateId);
      expect(unrelated?.candidateId).not.toBe(after?.candidateId);
    } finally {
      await factory.closePassiveContext(context);
    }
  });
});

describe('isolated fail-closed interaction audit', () => {
  it('verifies a safe accordion change with no post-freeze server activity', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    server.resetCounters();
    server.resetRequestObservations();

    const result = await auditInteraction(input('/accordion.html', candidate));

    expect(result.status, JSON.stringify(result)).toBe('VERIFIED');
    expect(result.evidence.changedFields).toEqual(expect.arrayContaining(['ariaExpanded', 'controlledVisible']));
    expect(result.evidence.before?.ariaExpanded).toBe('false');
    expect(result.evidence.after?.ariaExpanded).toBe('true');
    expect(server.getCounters()).toMatchObject({ get: 1, post: 0, download: 0, webSocketUpgrade: 0 });
    expect(server.getRequestObservations().map((entry) => entry.pathname)).toEqual(['/accordion.html']);
    expect(result.safety.invariantViolations).toEqual([]);
  });

  it.each([
    ['/popup-button.html', 'Open popup', 'blockedPopups', 'popup-target.html'],
    ['/navigation-button.html', 'Attempt navigation', 'blockedInteractionNavigations', 'navigation-target.html'],
    ['/websocket.html', 'Open WebSocket', 'blockedInteractionWebSockets', '/socket'],
    ['/mutation-button.html', 'Attempt mutation', 'blockedInteractionRequests', '/__mutation'],
  ] as const)('blocks an admitted %s action before its target reaches the server', async (
    path,
    name,
    ledgerKey,
    forbiddenPath,
  ) => {
    const candidate = await candidateNamed(path, name);
    server.resetCounters();
    server.resetRequestObservations();

    const result = await auditInteraction(input(path, candidate));

    expect(result.status).toBe('BLOCKED_BY_SAFETY');
    expect(result.safety[ledgerKey].length).toBeGreaterThan(0);
    expect(server.getRequestObservations().some((entry) => entry.pathname === forbiddenPath)).toBe(false);
    expect(server.getCounters()).toMatchObject({ post: 0, put: 0, patch: 0, delete: 0, download: 0, webSocketUpgrade: 0 });
    expect(result.safety.invariantViolations).toEqual([]);
  });

  it('cancels and records a generated data-URL download without making a server-delivery claim', async () => {
    const candidate = await candidateNamed('/download-button.html', 'Attempt generated download');
    server.resetCounters();
    server.resetRequestObservations();

    const result = await auditInteraction(input('/download-button.html', candidate));

    expect(result.status).toBe('BLOCKED_BY_SAFETY');
    expect(result.safety.blockedDownloads.length).toBeGreaterThan(0);
    expect(server.getCounters().download).toBe(0);
    expect(server.getRequestObservations().map((entry) => entry.pathname)).toEqual(['/download-button.html']);
  });

  it('blocks an admitted HTTP download before /__download reaches the fixture server', async () => {
    const candidate = await candidateNamed('/download-button.html', 'Attempt HTTP download');
    server.resetCounters();
    server.resetRequestObservations();

    const result = await auditInteraction(input('/download-button.html', candidate));

    expect(result.status).toBe('BLOCKED_BY_SAFETY');
    expect(result.safety.blockedInteractionRequests.length).toBeGreaterThan(0);
    expect(server.getRequestObservations().some((entry) => entry.pathname === '/__download')).toBe(false);
    expect(server.getCounters().download).toBe(0);
  });

  it('does not click an unsafe node inserted between rediscovery and target acquisition', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    let unsafeClickCalls = 0;
    const sessionFactory = async (sessionViewport: Viewport): Promise<InteractionGuardedSession> => {
      const session = await factory.createInteractionSession(sessionViewport);
      const page = session.page;
      const wrappedPage = Object.create(page) as Page;
      wrappedPage.locator = ((selector: string) => {
        const locator = page.locator(selector);
        return {
          nth(index: number) {
            const target = locator.nth(index);
            const insertUnsafeCandidate = async () => {
              await page.evaluate(() => {
                const inserted = document.createElement('a');
                inserted.setAttribute('role', 'button');
                inserted.href = '/navigation-target.html';
                inserted.textContent = 'Unsafe inserted navigation';
                document.body.prepend(inserted);
              });
            };
            return {
              async click(options: { readonly timeout?: number }) {
                await insertUnsafeCandidate();
                unsafeClickCalls += 1;
                return target.click(options);
              },
              async elementHandle(options: { readonly timeout?: number }) {
                await insertUnsafeCandidate();
                const handle = await target.elementHandle(options);
                if (handle === null) {
                  return null;
                }
                return {
                  evaluate: handle.evaluate.bind(handle),
                  async click(clickOptions: { readonly timeout?: number }) {
                    unsafeClickCalls += 1;
                    return handle.click(clickOptions);
                  },
                  dispose: handle.dispose.bind(handle),
                };
              },
            };
          },
        };
      }) as Page['locator'];
      return Object.freeze({ ...session, page: wrappedPage });
    };

    const result = await auditInteraction({ ...input('/accordion.html', candidate), sessionFactory });

    expect(result.status).toBe('NOT_VERIFIABLE');
    expect(unsafeClickCalls).toBe(0);
  });

  it.each([
    ['/missing-button.html', 'Remove candidate', 'MISSING'],
    ['/ambiguous-button.html', 'Duplicate candidate', 'AMBIGUOUS'],
    ['/replacement-button.html', 'Replace candidate', 'REPLACED'],
  ] as const)('reports exact retained-node identity loss for %s', async (path, name, identityStatus) => {
    const candidate = await candidateNamed(path, name);

    const result = await auditInteraction(input(path, candidate));

    expect(result.status).toBe('NOT_VERIFIABLE');
    expect(result.evidence.identityStatus).toBe(identityStatus);
  });

  it('verifies visibility evidence when the retained exact node hides itself', async () => {
    const candidate = await candidateNamed('/self-hide-button.html', 'Hide candidate');

    const result = await auditInteraction(input('/self-hide-button.html', candidate));

    expect(result.status, JSON.stringify(result)).toBe('VERIFIED');
    expect(result.evidence.identityStatus).toBe('MATCHED');
    expect(result.evidence.before?.visible).toBe(true);
    expect(result.evidence.after).toMatchObject({
      visible: false,
      boundingBox: { width: 0, height: 0 },
    });
    expect(result.evidence.changedFields).toEqual(expect.arrayContaining(['visible', 'boundingBox']));
  });

  it('reports an initially duplicated semantic identity as ambiguous in reason and evidence', async () => {
    const candidate = await candidateNamed('/initial-duplicate-button.html', 'Duplicate identity');

    const result = await auditInteraction(input('/initial-duplicate-button.html', candidate));

    expect(result.status).toBe('NOT_VERIFIABLE');
    expect(result.reason).toMatch(/ambiguous/iu);
    expect(result.evidence.identityStatus).toBe('AMBIGUOUS');
  });

  it.each([
    ['/mailto-link.html', 'Email fixture', 1],
    ['/tel-link.html', 'Call fixture', 1],
    ['/external-link.html', 'External resource', 1],
    ['/download-button.html', 'Direct download', 1],
    ['/post-form.html', 'Submit', 0],
  ] as const)('mechanically rejects %s before clicking', async (path, name, externalActionCount) => {
    const candidate = await candidateNamed(path, name);
    server.resetCounters();
    server.resetRequestObservations();

    const result = await auditInteraction(input(path, candidate));

    expect(result.status).toBe('REJECTED_UNSAFE');
    expect(result.evidence.identityStatus).toBe('MATCHED');
    expect(result.safety.blockedExternalActions).toHaveLength(externalActionCount);
    expect(server.getRequestObservations().map((entry) => entry.pathname)).toEqual([path]);
    expect(server.getCounters()).toMatchObject({ post: 0, download: 0, webSocketUpgrade: 0 });
  });

  it('blocks Service Worker bypass without fetching the worker script', async () => {
    const candidate = await candidateNamed('/service-worker.html', 'Register worker');
    server.resetCounters();
    server.resetRequestObservations();

    const result = await auditInteraction(input('/service-worker.html', candidate));

    expect(result.status).toBe('NOT_VERIFIABLE');
    expect(server.getRequestObservations().map((entry) => entry.pathname)).toEqual(['/service-worker.html']);
    expect(result.safety.invariantViolations).toEqual([]);
  });

  it('closes the owner session exactly once after a verified audit', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    let closeCalls = 0;
    let observedPage: Page | undefined;
    const sessionFactory = async (sessionViewport: Viewport): Promise<InteractionGuardedSession> => {
      const session = await factory.createInteractionSession(sessionViewport);
      observedPage = session.page;
      return Object.freeze({
        ...session,
        async close(): Promise<void> {
          closeCalls += 1;
          await session.close();
        },
      });
    };

    const result = await auditInteraction({ ...input('/accordion.html', candidate), sessionFactory });

    expect(result.status).toBe('VERIFIED');
    expect(closeCalls).toBe(1);
    expect(observedPage?.isClosed()).toBe(true);
  });

  it('does not click when freeze activation fails and still closes once', async () => {
    const candidate = await candidateNamed('/mutation-button.html', 'Attempt mutation');
    let closeCalls = 0;
    const sessionFactory = async (sessionViewport: Viewport): Promise<InteractionGuardedSession> => {
      const session = await factory.createInteractionSession(sessionViewport);
      return Object.freeze({
        ...session,
        async activateInteractionFreeze(): Promise<void> {
          throw new Error('fixture freeze activation failed');
        },
        async close(): Promise<void> {
          closeCalls += 1;
          await session.close();
        },
      });
    };
    server.resetCounters();

    const result = await auditInteraction({ ...input('/mutation-button.html', candidate), sessionFactory });

    expect(result.status).toBe('EXECUTION_FAILED');
    expect(result.reason).toContain('freeze activation failed');
    expect(closeCalls).toBe(1);
    expect(server.getCounters().post).toBe(0);
  });

  it('does not click or perform a post evaluation after rediscovery reaches the absolute deadline', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    let discoveryEvaluations = 0;
    let clickCalls = 0;
    const rawCandidate = {
      ordinal: candidate.ordinal,
      tagName: candidate.tagName,
      role: candidate.role,
      accessibleName: candidate.accessibleName,
      normalizedText: 'Toggle details',
      ariaExpanded: candidate.ariaExpanded,
      ariaControls: candidate.ariaControls,
      ariaSelected: candidate.ariaSelected,
      controlledVisible: candidate.controlledVisible,
      controlledHidden: candidate.controlledHidden,
      formAssociated: candidate.formAssociated,
      formMethod: candidate.formMethod,
      formAction: candidate.formAction,
      rawHref: candidate.href,
      documentUrl: `${server.origin}/accordion.html`,
      documentOrigin: server.origin,
      download: candidate.download,
      type: candidate.type,
      disabled: candidate.disabled,
      visible: candidate.visible,
      boundingBox: candidate.boundingBox,
    };
    const page = {
      goto: async () => undefined,
      evaluate: async (_callback: unknown, argument?: unknown) => {
        if (argument === undefined) {
          return true;
        }
        discoveryEvaluations += 1;
        vi.setSystemTime(3_000);
        return [rawCandidate];
      },
      locator: () => ({
        nth: () => ({
          click: async () => {
            clickCalls += 1;
          },
        }),
      }),
    } as unknown as Page;
    const session: InteractionGuardedSession = {
      page,
      ledger: new SafetyLedger(),
      activateInteractionFreeze: async () => undefined,
      close: async () => undefined,
    };
    try {
      const result = await auditInteraction({
        ...input('/accordion.html', candidate),
        timeoutMs: 2_000,
        deadlineAtMs: 10_000,
        sessionFactory: async () => session,
      });

      expect(result.status).toBe('NOT_VERIFIABLE');
      expect(clickCalls).toBe(0);
      expect(discoveryEvaluations).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not click or inspect a target when ElementHandle acquisition reaches the absolute deadline', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    let clickCalls = 0;
    let handleEvaluateCalls = 0;
    const rawCandidate = {
      ordinal: candidate.ordinal,
      tagName: candidate.tagName,
      role: candidate.role,
      accessibleName: candidate.accessibleName,
      normalizedText: 'Toggle details',
      ariaExpanded: candidate.ariaExpanded,
      ariaControls: candidate.ariaControls,
      ariaSelected: candidate.ariaSelected,
      controlledVisible: candidate.controlledVisible,
      controlledHidden: candidate.controlledHidden,
      formAssociated: candidate.formAssociated,
      formMethod: candidate.formMethod,
      formAction: candidate.formAction,
      rawHref: candidate.href,
      documentUrl: `${server.origin}/accordion.html`,
      documentOrigin: server.origin,
      download: candidate.download,
      type: candidate.type,
      disabled: candidate.disabled,
      visible: candidate.visible,
      boundingBox: candidate.boundingBox,
    };
    const page = {
      goto: async () => undefined,
      evaluate: async (_callback: unknown, argument?: unknown) => (
        argument === undefined ? true : [rawCandidate]
      ),
      locator: () => ({
        nth: () => ({
          async click() {
            clickCalls += 1;
            vi.setSystemTime(3_000);
          },
          async elementHandle() {
            vi.setSystemTime(3_000);
            return {
              async evaluate() {
                handleEvaluateCalls += 1;
                return { connected: true, raw: rawCandidate };
              },
              async click() {
                clickCalls += 1;
              },
              async dispose() {},
            };
          },
        }),
      }),
    } as unknown as Page;
    const session: InteractionGuardedSession = {
      page,
      ledger: new SafetyLedger(),
      activateInteractionFreeze: async () => undefined,
      close: async () => undefined,
    };
    try {
      const result = await auditInteraction({
        ...input('/accordion.html', candidate),
        timeoutMs: 2_000,
        deadlineAtMs: 10_000,
        sessionFactory: async () => session,
      });

      expect(result.status).toBe('NOT_VERIFIABLE');
      expect(clickCalls).toBe(0);
      expect(handleEvaluateCalls).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['ordinary Error', 'EXECUTION_FAILED', 'ordinary click consumed deadline'],
    ['TimeoutError', 'NOT_VERIFIABLE', 'timeout click consumed deadline'],
  ] as const)('reports %s when click reaches the deadline without a post evaluation', async (errorKind, expectedStatus, expectedReason) => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    let handleEvaluations = 0;
    const rawCandidate = {
      ordinal: candidate.ordinal,
      tagName: candidate.tagName,
      role: candidate.role,
      accessibleName: candidate.accessibleName,
      normalizedText: 'Toggle details',
      ariaExpanded: candidate.ariaExpanded,
      ariaControls: candidate.ariaControls,
      ariaSelected: candidate.ariaSelected,
      controlledVisible: candidate.controlledVisible,
      controlledHidden: candidate.controlledHidden,
      formAssociated: candidate.formAssociated,
      formMethod: candidate.formMethod,
      formAction: candidate.formAction,
      rawHref: candidate.href,
      documentUrl: `${server.origin}/accordion.html`,
      documentOrigin: server.origin,
      download: candidate.download,
      type: candidate.type,
      disabled: candidate.disabled,
      visible: candidate.visible,
      boundingBox: candidate.boundingBox,
    };
    const clickError = new Error(expectedReason);
    clickError.name = errorKind === 'TimeoutError' ? 'TimeoutError' : 'Error';
    const page = {
      goto: async () => undefined,
      evaluate: async (_callback: unknown, argument?: unknown) => (
        argument === undefined ? true : [rawCandidate]
      ),
      locator: () => ({
        nth: () => ({
          elementHandle: async () => ({
            evaluate: async () => {
              handleEvaluations += 1;
              return { connected: true, raw: rawCandidate };
            },
            click: async () => {
              vi.setSystemTime(3_000);
              throw clickError;
            },
            dispose: async () => undefined,
          }),
        }),
      }),
    } as unknown as Page;
    const session: InteractionGuardedSession = {
      page,
      ledger: new SafetyLedger(),
      activateInteractionFreeze: async () => undefined,
      close: async () => undefined,
    };

    try {
      const result = await auditInteraction({
        ...input('/accordion.html', candidate),
        sessionFactory: async () => session,
      });

      expect(result.status).toBe(expectedStatus);
      expect(result.reason).toBe(expectedReason);
      expect(handleEvaluations).toBe(1);
      expect(result.evidence.after).toBeNull();
      expect(result.evidence.changedFields).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['TimeoutError', 'NOT_VERIFIABLE'],
    ['ordinary Error', 'EXECUTION_FAILED'],
  ] as const)('keeps observed evidence and reports %s after click mutates then throws', async (errorKind, expectedStatus) => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    let expanded = false;
    let handleEvaluations = 0;
    const rawCandidate = () => ({
      ordinal: candidate.ordinal,
      tagName: candidate.tagName,
      role: candidate.role,
      accessibleName: candidate.accessibleName,
      normalizedText: 'Toggle details',
      ariaExpanded: expanded ? 'true' : 'false',
      ariaControls: candidate.ariaControls,
      ariaSelected: candidate.ariaSelected,
      controlledVisible: expanded,
      controlledHidden: !expanded,
      formAssociated: candidate.formAssociated,
      formMethod: candidate.formMethod,
      formAction: candidate.formAction,
      rawHref: candidate.href,
      documentUrl: `${server.origin}/accordion.html`,
      documentOrigin: server.origin,
      download: candidate.download,
      type: candidate.type,
      disabled: candidate.disabled,
      visible: candidate.visible,
      boundingBox: candidate.boundingBox,
    });
    const clickError = new Error(`${errorKind} after state change`);
    clickError.name = errorKind === 'TimeoutError' ? 'TimeoutError' : 'Error';
    const page = {
      goto: async () => undefined,
      evaluate: async (_callback: unknown, argument?: unknown) => (
        argument === undefined ? true : [rawCandidate()]
      ),
      locator: () => ({
        nth: () => ({
          elementHandle: async () => ({
            evaluate: async () => {
              handleEvaluations += 1;
              return { connected: true, raw: rawCandidate() };
            },
            click: async () => {
              expanded = true;
              throw clickError;
            },
            dispose: async () => undefined,
          }),
        }),
      }),
    } as unknown as Page;
    const session: InteractionGuardedSession = {
      page,
      ledger: new SafetyLedger(),
      activateInteractionFreeze: async () => undefined,
      close: async () => undefined,
    };

    const result = await auditInteraction({
      ...input('/accordion.html', candidate),
      sessionFactory: async () => session,
    });

    expect(result.status).toBe(expectedStatus);
    expect(result.status).not.toBe('VERIFIED');
    expect(result.evidence.changedFields).toEqual(expect.arrayContaining(['ariaExpanded', 'controlledVisible']));
    expect(result.evidence.after?.ariaExpanded).toBe('true');
  });

  it('lets a freeze event outrank a click failure and changed evidence', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    const ledger = new SafetyLedger();
    const rawCandidate = {
      ordinal: candidate.ordinal,
      tagName: candidate.tagName,
      role: candidate.role,
      accessibleName: candidate.accessibleName,
      normalizedText: 'Toggle details',
      ariaExpanded: candidate.ariaExpanded,
      ariaControls: candidate.ariaControls,
      ariaSelected: candidate.ariaSelected,
      controlledVisible: candidate.controlledVisible,
      controlledHidden: candidate.controlledHidden,
      formAssociated: candidate.formAssociated,
      formMethod: candidate.formMethod,
      formAction: candidate.formAction,
      rawHref: candidate.href,
      documentUrl: `${server.origin}/accordion.html`,
      documentOrigin: server.origin,
      download: candidate.download,
      type: candidate.type,
      disabled: candidate.disabled,
      visible: candidate.visible,
      boundingBox: candidate.boundingBox,
    };
    const page = {
      goto: async () => undefined,
      evaluate: async (_callback: unknown, argument?: unknown) => (
        argument === undefined ? true : [rawCandidate]
      ),
      locator: () => ({
        nth: () => ({
          elementHandle: async () => ({
            evaluate: async () => ({ connected: true, raw: rawCandidate }),
            click: async () => {
              ledger.recordBlockedInteractionRequest({
                method: 'GET',
                url: `${server.origin}/blocked-after-click`,
                reason: 'INTERACTION_FROZEN',
              });
              throw new Error('click failed after freeze event');
            },
            dispose: async () => undefined,
          }),
        }),
      }),
    } as unknown as Page;
    const session: InteractionGuardedSession = {
      page,
      ledger,
      activateInteractionFreeze: async () => undefined,
      close: async () => undefined,
    };

    const result = await auditInteraction({
      ...input('/accordion.html', candidate),
      sessionFactory: async () => session,
    });

    expect(result.status).toBe('BLOCKED_BY_SAFETY');
  });

  it('invalidates the guarded context when freeze is activated twice', async () => {
    const session = await factory.createInteractionSession(viewport);
    await session.page.goto(`${server.origin}/accordion.html`, { waitUntil: 'load' });

    await session.activateInteractionFreeze();
    await expect(session.activateInteractionFreeze()).rejects.toThrow(/invalid from INTERACTION_FROZEN/u);

    await expect.poll(() => session.page.isClosed()).toBe(true);
    expect(session.ledger.snapshot().invariantViolations).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'INTERACTION_FREEZE_ACTIVATION_FAILED' }),
    ]));
  });

  it('preserves both work and owner-close failures', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    const page = {
      goto: async (): Promise<never> => { throw new Error('fixture work failed'); },
    } as unknown as Page;
    const session: InteractionGuardedSession = {
      page,
      ledger: new SafetyLedger(),
      activateInteractionFreeze: async () => undefined,
      close: async (): Promise<never> => { throw new Error('fixture close failed'); },
    };

    const promise = auditInteraction({
      ...input('/accordion.html', candidate),
      sessionFactory: async () => session,
    });

    await expect(promise).rejects.toBeInstanceOf(AggregateError);
    await expect(promise).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: 'fixture work failed' }), expect.objectContaining({ message: 'fixture close failed' })],
    });
  });

  it('lets a freeze event recorded during owner close override a verified work outcome', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    let expanded = false;
    const rawCandidate = () => ({
      ordinal: candidate.ordinal,
      tagName: candidate.tagName,
      role: candidate.role,
      accessibleName: candidate.accessibleName,
      normalizedText: 'Toggle details',
      ariaExpanded: expanded ? 'true' : 'false',
      ariaControls: candidate.ariaControls,
      ariaSelected: candidate.ariaSelected,
      controlledVisible: expanded,
      controlledHidden: !expanded,
      formAssociated: candidate.formAssociated,
      formMethod: candidate.formMethod,
      formAction: candidate.formAction,
      rawHref: candidate.href,
      documentUrl: `${server.origin}/accordion.html`,
      documentOrigin: server.origin,
      download: candidate.download,
      type: candidate.type,
      disabled: candidate.disabled,
      visible: candidate.visible,
      boundingBox: candidate.boundingBox,
    });
    const page = {
      goto: async () => undefined,
      evaluate: async (_callback: unknown, argument?: unknown) => (
        argument === undefined ? true : [rawCandidate()]
      ),
      locator: () => ({
        nth: () => ({
          elementHandle: async () => ({
            evaluate: async () => ({ connected: true, raw: rawCandidate() }),
            click: async () => { expanded = true; },
            dispose: async () => undefined,
          }),
        }),
      }),
    } as unknown as Page;
    const ledger = new SafetyLedger();
    const session: InteractionGuardedSession = {
      page,
      ledger,
      activateInteractionFreeze: async () => undefined,
      close: async () => {
        ledger.recordBlockedInteractionRequest({
          method: 'GET',
          url: `${server.origin}/late`,
          reason: 'INTERACTION_FROZEN',
        });
      },
    };

    const result = await auditInteraction({
      ...input('/accordion.html', candidate),
      sessionFactory: async () => session,
    });

    expect(result.status).toBe('BLOCKED_BY_SAFETY');
    expect(result.evidence.changedFields).toContain('ariaExpanded');
    expect(result.safety.blockedInteractionRequests).toHaveLength(1);
  });

  it('lets a freeze event recorded during owner close override a rejected-unsafe outcome', async () => {
    const candidate = await candidateNamed('/post-form.html', 'Submit');
    const sessionFactory = async (sessionViewport: Viewport): Promise<InteractionGuardedSession> => {
      const session = await factory.createInteractionSession(sessionViewport);
      return Object.freeze({
        ...session,
        async close(): Promise<void> {
          session.ledger.recordBlockedInteractionRequest({
            method: 'GET',
            url: `${server.origin}/late-after-rejection`,
            reason: 'INTERACTION_FROZEN',
          });
          await session.close();
        },
      });
    };

    const result = await auditInteraction({ ...input('/post-form.html', candidate), sessionFactory });

    expect(result.status).toBe('BLOCKED_BY_SAFETY');
    expect(result.evidence.identityStatus).toBe('MATCHED');
    expect(result.safety.blockedInteractionRequests).toHaveLength(1);
  });

  it('preserves click-failure status, reason, and observed evidence when handle disposal fails', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    let expanded = false;
    const rawCandidate = () => ({
      ordinal: candidate.ordinal,
      tagName: candidate.tagName,
      role: candidate.role,
      accessibleName: candidate.accessibleName,
      normalizedText: 'Toggle details',
      ariaExpanded: expanded ? 'true' : 'false',
      ariaControls: candidate.ariaControls,
      ariaSelected: candidate.ariaSelected,
      controlledVisible: expanded,
      controlledHidden: !expanded,
      formAssociated: candidate.formAssociated,
      formMethod: candidate.formMethod,
      formAction: candidate.formAction,
      rawHref: candidate.href,
      documentUrl: `${server.origin}/accordion.html`,
      documentOrigin: server.origin,
      download: candidate.download,
      type: candidate.type,
      disabled: candidate.disabled,
      visible: candidate.visible,
      boundingBox: candidate.boundingBox,
    });
    const page = {
      goto: async () => undefined,
      evaluate: async (_callback: unknown, argument?: unknown) => (
        argument === undefined ? true : [rawCandidate()]
      ),
      locator: () => ({
        nth: () => ({
          elementHandle: async () => ({
            evaluate: async () => ({ connected: true, raw: rawCandidate() }),
            click: async () => {
              expanded = true;
              throw new Error('original click failure');
            },
            dispose: async (): Promise<never> => { throw new Error('handle dispose failure'); },
          }),
        }),
      }),
    } as unknown as Page;
    const ledger = new SafetyLedger();
    const result = await auditInteraction({
      ...input('/accordion.html', candidate),
      sessionFactory: async () => ({
        page,
        ledger,
        activateInteractionFreeze: async () => undefined,
        close: async () => undefined,
      }),
    });

    expect(result.status).toBe('EXECUTION_FAILED');
    expect(result.reason).toBe('original click failure');
    expect(result.evidence.changedFields).toContain('ariaExpanded');
    expect(result.safety.invariantViolations).toContainEqual({
      code: 'INTERACTION_HANDLE_DISPOSE_FAILED',
      message: 'handle dispose failure',
    });
  });

  it('preserves safety status and observed evidence when handle disposal fails', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    const ledger = new SafetyLedger();
    let expanded = false;
    let handleEvaluations = 0;
    const rawCandidate = () => ({
      ordinal: candidate.ordinal,
      tagName: candidate.tagName,
      role: candidate.role,
      accessibleName: candidate.accessibleName,
      normalizedText: 'Toggle details',
      ariaExpanded: expanded ? 'true' : 'false',
      ariaControls: candidate.ariaControls,
      ariaSelected: candidate.ariaSelected,
      controlledVisible: expanded,
      controlledHidden: !expanded,
      formAssociated: candidate.formAssociated,
      formMethod: candidate.formMethod,
      formAction: candidate.formAction,
      rawHref: candidate.href,
      documentUrl: `${server.origin}/accordion.html`,
      documentOrigin: server.origin,
      download: candidate.download,
      type: candidate.type,
      disabled: candidate.disabled,
      visible: candidate.visible,
      boundingBox: candidate.boundingBox,
    });
    const page = {
      goto: async () => undefined,
      evaluate: async (_callback: unknown, argument?: unknown) => (
        argument === undefined ? true : [rawCandidate()]
      ),
      locator: () => ({
        nth: () => ({
          elementHandle: async () => ({
            evaluate: async () => {
              handleEvaluations += 1;
              if (handleEvaluations === 2) {
                ledger.recordBlockedInteractionRequest({
                  method: 'GET',
                  url: `${server.origin}/blocked-during-observation`,
                  reason: 'INTERACTION_FROZEN',
                });
              }
              return { connected: true, raw: rawCandidate() };
            },
            click: async () => { expanded = true; },
            dispose: async (): Promise<never> => { throw new Error('safety handle dispose failure'); },
          }),
        }),
      }),
    } as unknown as Page;
    const result = await auditInteraction({
      ...input('/accordion.html', candidate),
      sessionFactory: async () => ({
        page,
        ledger,
        activateInteractionFreeze: async () => undefined,
        close: async () => undefined,
      }),
    });

    expect(result.status).toBe('BLOCKED_BY_SAFETY');
    expect(result.reason).toBe('Interaction activity was blocked by safety freeze');
    expect(result.evidence.changedFields).toContain('ariaExpanded');
    expect(result.safety.invariantViolations).toContainEqual({
      code: 'INTERACTION_HANDLE_DISPOSE_FAILED',
      message: 'safety handle dispose failure',
    });
  });

  it('preserves a work error and separately ledgers disposal failure when no outcome exists', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    const ledger = new SafetyLedger();
    let handleEvaluations = 0;
    const rawCandidate = {
      ordinal: candidate.ordinal,
      tagName: candidate.tagName,
      role: candidate.role,
      accessibleName: candidate.accessibleName,
      normalizedText: 'Toggle details',
      ariaExpanded: candidate.ariaExpanded,
      ariaControls: candidate.ariaControls,
      ariaSelected: candidate.ariaSelected,
      controlledVisible: candidate.controlledVisible,
      controlledHidden: candidate.controlledHidden,
      formAssociated: candidate.formAssociated,
      formMethod: candidate.formMethod,
      formAction: candidate.formAction,
      rawHref: candidate.href,
      documentUrl: `${server.origin}/accordion.html`,
      documentOrigin: server.origin,
      download: candidate.download,
      type: candidate.type,
      disabled: candidate.disabled,
      visible: candidate.visible,
      boundingBox: candidate.boundingBox,
    };
    const page = {
      goto: async () => undefined,
      evaluate: async (_callback: unknown, argument?: unknown) => (
        argument === undefined ? true : [rawCandidate]
      ),
      locator: () => ({
        nth: () => ({
          elementHandle: async () => ({
            evaluate: async () => {
              handleEvaluations += 1;
              if (handleEvaluations === 2) {
                throw new Error('original observation failure');
              }
              return { connected: true, raw: rawCandidate };
            },
            click: async () => undefined,
            dispose: async (): Promise<never> => { throw new Error('observation handle dispose failure'); },
          }),
        }),
      }),
    } as unknown as Page;
    const result = await auditInteraction({
      ...input('/accordion.html', candidate),
      sessionFactory: async () => ({
        page,
        ledger,
        activateInteractionFreeze: async () => undefined,
        close: async () => undefined,
      }),
    });

    expect(result.status).toBe('EXECUTION_FAILED');
    expect(result.reason).toBe('original observation failure');
    expect(result.safety.invariantViolations).toContainEqual({
      code: 'INTERACTION_HANDLE_DISPOSE_FAILED',
      message: 'observation handle dispose failure',
    });
  });
});
