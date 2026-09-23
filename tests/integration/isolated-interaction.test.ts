import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';
import { BrowserContextFactory, type InteractionGuardedSession } from '../../src/browser/context-factory.js';
import type { AuditConfig, Viewport } from '../../src/config/types.js';
import type { InteractionStatus } from '../../src/core/contracts.js';
import type { InteractionChangeEvidence } from '../../src/evidence/interaction-collector.js';
import {
  discoverInteractionCandidates,
  inspectInteractionCandidateHandle,
  resolveInteractionCandidateHandle,
  INTERACTION_CANDIDATE_SELECTOR,
} from '../../src/interaction/discover-candidates.js';
import {
  auditInteraction,
  InteractionOwnerCleanupError,
  type InteractionAuditInput,
} from '../../src/interaction/isolated-auditor.js';
import {
  classifyInteractionCandidate,
  INTERACTION_CANDIDATE_LIMITS,
  type InteractionCandidate,
} from '../../src/safety/interaction-policy.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';

type ExpectedStructuredInteractionResult = Awaited<ReturnType<typeof auditInteraction>> & {
  readonly work: {
    readonly status: InteractionStatus;
    readonly reason: string;
    readonly evidence: InteractionChangeEvidence;
  };
  readonly lifecycle:
    | { readonly status: 'CLOSED'; readonly reason: string | null }
    | { readonly status: 'NON_TERMINAL'; readonly reason: string };
};

function expectedStructuredResult(
  result: Awaited<ReturnType<typeof auditInteraction>>,
): ExpectedStructuredInteractionResult {
  return result as ExpectedStructuredInteractionResult;
}

async function expectOwnerCleanupError(
  completion: Promise<Awaited<ReturnType<typeof auditInteraction>>>,
): Promise<InteractionOwnerCleanupError> {
  const rejection = await completion.catch((error: unknown) => error);
  expect(rejection).toBeInstanceOf(InteractionOwnerCleanupError);
  return rejection as InteractionOwnerCleanupError;
}

function fakeCloseLifecycle(
  closeBehavior: () => Promise<void> = async () => undefined,
): Pick<InteractionGuardedSession, 'close' | 'isClosed'> {
  let closed = false;
  return Object.freeze({
    isClosed: (): boolean => closed,
    close: async (): Promise<void> => {
      await closeBehavior();
      closed = true;
    },
  });
}

const viewport: Viewport = Object.freeze({ width: 900, height: 700 });
let browser: Browser;
let server: FixtureServer;
let factory: BrowserContextFactory;

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function boundedResolutionEnvelope(handle: {
  readonly evaluate: (...args: never[]) => Promise<unknown>;
  readonly dispose: () => Promise<unknown>;
}) {
  const property = (value: unknown) => ({
    jsonValue: async () => value,
    dispose: async () => undefined,
    asElement: () => value === handle ? handle : null,
  });
  return {
    getProperties: async () => new Map([
      ['status', property('FOUND')],
      ['domWorkUsed', property(0)],
      ['element', property(handle)],
    ]),
    dispose: async () => undefined,
  };
}

function injectedResolutionEnvelope(
  properties: ReadonlyMap<string, unknown>,
  dispose: () => Promise<unknown> = async () => undefined,
) {
  return {
    getProperties: async () => properties,
    dispose,
  };
}

function injectedResolutionPage(envelope: unknown): Page {
  return {
    evaluateHandle: async () => envelope,
  } as unknown as Page;
}

function rawCandidateFor(candidate: InteractionCandidate) {
  return {
    ordinal: candidate.ordinal,
    tagName: candidate.tagName,
    role: candidate.role,
    accessibleName: candidate.accessibleName,
    normalizedText: candidate.accessibleName,
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
}

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

async function discover(
  path: string,
  expectedCompleteness: 'COMPLETE' | 'CANDIDATE_LIMIT_REACHED' = 'COMPLETE',
): Promise<readonly InteractionCandidate[]> {
  const context = await factory.createPassiveContext(viewport);
  const page = await factory.createPassivePage(context);
  try {
    await page.goto(`${server.origin}${path}`, { waitUntil: 'load' });
    const result = await discoverInteractionCandidates(page);
    expect(result.completeness).toBe(expectedCompleteness);
    return result.candidates;
  } finally {
    await factory.closePassiveContext(context);
  }
}

it('exports bounded exact-handle resolution API', async () => {
  const discoveryModule = await import('../../src/interaction/discover-candidates.js');
  expect(discoveryModule).toHaveProperty('resolveInteractionCandidateHandle');
});

async function totalBudgetPage(section?: string): Promise<Page> {
  const page = await browser.newPage();
  await page.goto(`${server.origin}/total-dom-budget.html`, { waitUntil: 'load' });
  const precondition = await page.evaluate(() => {
    const controlled = document.getElementById('deep-controlled');
    const scopedHost = document.getElementById('deep-chain-host');
    const early = document.getElementById('early');
    let scopedAncestors = 0;
    let parent = controlled?.parentElement ?? null;
    while (parent !== null && parent !== scopedHost) {
      scopedAncestors += 1;
      parent = parent.parentElement;
    }
    return {
      scopedAncestors,
      reachedScopedHost: parent === scopedHost,
      connected: early?.isConnected,
      width: early?.getBoundingClientRect().width ?? 0,
    };
  });
  expect(precondition.scopedAncestors).toBe(20_000);
  expect(precondition.reachedScopedHost).toBe(true);
  expect(precondition.connected).toBe(true);
  expect(precondition.width).toBeGreaterThan(0);
  if (section !== undefined) {
    await page.evaluate((id) => {
      const selected = document.getElementById(id);
      if (selected === null) throw new Error('Missing total budget section');
      document.body.replaceChildren(selected);
    }, section);
  }
  return page;
}

async function installTotalTraversalProbe(page: Page): Promise<() => Promise<number>> {
  await page.evaluate(() => {
    const original = document.createTreeWalker.bind(document);
    let count = 0;
    Object.defineProperty(document, 'createTreeWalker', {
      configurable: true,
      value(root: Node, whatToShow: number, filter?: NodeFilter | null) {
        const walker = original(root, whatToShow, filter);
        return new Proxy(walker, {
          get(target, property) {
            if (property !== 'nextNode') return Reflect.get(target, property, target);
            return () => {
              const node = target.nextNode();
              if (node !== null && ++count > 16_384) throw new Error('Total DOM traversal exceeded 16,384');
              return node;
            };
          },
        });
      },
    });
    Object.defineProperty(globalThis, '__totalDomTraversalCount', { get: () => count });
  });
  return () => page.evaluate(() => (
    globalThis as typeof globalThis & { readonly __totalDomTraversalCount: number }
  ).__totalDomTraversalCount);
}

it('avoids whole-DOM selector enumeration during discovery', async () => {
  const page = await totalBudgetPage();
  try {
    await page.evaluate(() => {
      Document.prototype.querySelectorAll = () => { throw new Error('Forbidden whole-DOM query'); };
    });
    await expect(discoverInteractionCandidates(page)).resolves.toBeDefined();
  } finally { await page.close(); }
});

it('reports total DOM work exhaustion before a late candidate with immutable completeness', async () => {
  const page = await totalBudgetPage('no-early-candidate');
  try {
    const count = await installTotalTraversalProbe(page);
    const result = await discoverInteractionCandidates(page);
    expect(result.completeness).toBe('DOM_WORK_BUDGET_REACHED');
    expect(result.domWorkUsed).toBe(16_384);
    expect(result.candidates).toEqual([]);
    expect(await count()).toBeLessThanOrEqual(result.domWorkUsed);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.candidates)).toBe(true);
  } finally { await page.close(); }
});

it('shares ancestor work and discards a partial early candidate on budget exhaustion', async () => {
  const page = await totalBudgetPage();
  try {
    const result = await discoverInteractionCandidates(page);
    expect(result.completeness).toBe('DOM_WORK_BUDGET_REACHED');
    expect(result.domWorkUsed).toBe(16_384);
    expect(result.candidates).toEqual([]);
  } finally { await page.close(); }
});

it('uses shared text and enumeration work across candidate subtrees', async () => {
  const page = await totalBudgetPage('many-candidate-subtrees');
  try {
    const count = await installTotalTraversalProbe(page);
    const result = await discoverInteractionCandidates(page);
    expect(result.completeness).toBe('DOM_WORK_BUDGET_REACHED');
    expect(result.domWorkUsed).toBeLessThan(16_384);
    expect(result.candidates).toEqual([]);
    expect(result.candidates.some(({ accessibleName }) => accessibleName === 'Repeated candidate 99')).toBe(false);
    expect(await count()).toBeLessThanOrEqual(result.domWorkUsed);
  } finally { await page.close(); }
});

it('bounded exact-handle resolution preserves the child after envelope disposal without whole-DOM queries', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<button type="button">Retained child</button>');
    await page.evaluate(() => {
      Document.prototype.querySelectorAll = () => { throw new Error('Forbidden whole-DOM query'); };
    });
    const resolution = await resolveInteractionCandidateHandle(page, 0);
    expect(resolution.status).toBe('FOUND');
    if (resolution.status !== 'FOUND') throw new Error('Expected retained child');
    try {
      expect(await resolution.handle.evaluate((element) => element.isConnected)).toBe(true);
      expect(Object.isFrozen(resolution)).toBe(true);
      const snapshot = await inspectInteractionCandidateHandle(resolution.handle, 0);
      expect(snapshot).toMatchObject({ status: 'CONNECTED', candidate: { accessibleName: 'Retained child' } });
    } finally { await resolution.handle.dispose(); }
  } finally { await page.close(); }
});

it('bounded exact-handle resolution distinguishes late-target budget exhaustion from missing', async () => {
  const page = await totalBudgetPage('no-early-candidate');
  try {
    const count = await installTotalTraversalProbe(page);
    expect(await resolveInteractionCandidateHandle(page, 0)).toEqual({ status: 'DOM_WORK_BUDGET_REACHED', domWorkUsed: 16_384 });
    expect(await count()).toBeLessThanOrEqual(16_384);
  } finally { await page.close(); }
});

it('retained inspection reports shared ancestor budget exhaustion distinctly from disconnected', async () => {
  const page = await totalBudgetPage();
  const handle = await page.locator('#early').elementHandle();
  if (handle === null) throw new Error('Missing early fixture node');
  try {
    expect(await inspectInteractionCandidateHandle(handle, 0)).toEqual({ status: 'DOM_WORK_BUDGET_REACHED', domWorkUsed: 16_384 });
  } finally { await handle.dispose(); await page.close(); }
});

it('retained inspection reports late live-ordinal budget exhaustion distinctly from disconnected', async () => {
  const page = await totalBudgetPage('no-early-candidate');
  const handle = await page.locator('button').elementHandle();
  if (handle === null) throw new Error('Missing late fixture node');
  try {
    const count = await installTotalTraversalProbe(page);
    expect(await inspectInteractionCandidateHandle(handle, 0)).toEqual({ status: 'DOM_WORK_BUDGET_REACHED', domWorkUsed: 16_384 });
    expect(await count()).toBeLessThanOrEqual(16_384);
  } finally { await handle.dispose(); await page.close(); }
});

it('retained inspection shares total DOM work between live ordinal and candidate facts', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<button type="button" aria-controls="controlled">Combined</button><div id="controlled-host" style="display:none"><div id="controlled" style="width:1px;height:1px"></div></div>');
    await page.evaluate(() => {
      const button = document.querySelector('button')!;
      for (let index = 0; index < 8_000; index += 1) button.before(document.createElement('div'));
      let parent = document.getElementById('controlled')!;
      for (let index = 0; index < 9_000; index += 1) {
        const wrapper = document.createElement('div');
        parent.replaceWith(wrapper);
        wrapper.append(parent);
        parent = wrapper;
      }
      const controlledHost = document.getElementById('controlled-host');
      let controlledAncestors = 0;
      let current = document.getElementById('controlled')?.parentElement ?? null;
      while (current !== null && current !== controlledHost) {
        controlledAncestors += 1;
        current = current.parentElement;
      }
      let precedingNodes = 0;
      for (let preceding = button.previousElementSibling; preceding !== null; preceding = preceding.previousElementSibling) {
        if (preceding.tagName !== 'DIV') throw new Error('Combined preceding-node scope was contaminated');
        precedingNodes += 1;
      }
      if (controlledAncestors !== 9_000 || current !== controlledHost) {
        throw new Error(`Combined controlled chain precondition failed: ${controlledAncestors}`);
      }
      if (precedingNodes !== 8_000) {
        throw new Error(`Combined preceding-node precondition failed: ${precedingNodes}`);
      }
    });
    const handle = await page.locator('button').elementHandle();
    if (handle === null) throw new Error('Missing combined fixture node');
    try {
      expect(await inspectInteractionCandidateHandle(handle, 0)).toEqual({ status: 'DOM_WORK_BUDGET_REACHED', domWorkUsed: 16_384 });
    } finally { await handle.dispose(); }
  } finally { await page.close(); }
});

it('bounded exact-handle resolution and retained inspection distinguish true absence', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<button type="button">Detach</button>');
    expect(await resolveInteractionCandidateHandle(page, 1)).toMatchObject({ status: 'MISSING' });
    const resolution = await resolveInteractionCandidateHandle(page, 0);
    if (resolution.status !== 'FOUND') throw new Error('Expected retained node');
    try {
      await resolution.handle.evaluate((element) => element.remove());
      expect(await inspectInteractionCandidateHandle(resolution.handle, 0)).toMatchObject({ status: 'DISCONNECTED' });
    } finally { await resolution.handle.dispose(); }
  } finally { await page.close(); }
});

describe('Task 2 correction boundaries', () => {
  it('stops before retained candidate facts when exact identity consumes the final work unit', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<button type="button" aria-controls="controlled">Boundary</button><div id="controlled"></div>');
      const handle = await page.locator('button').elementHandle();
      if (handle === null) throw new Error('Missing boundary candidate');
      try {
        await page.evaluate(() => {
          const target = document.querySelector('button')!;
          const dummy = document.createElement('div');
          const originalCreateTreeWalker = document.createTreeWalker.bind(document);
          const originalRootMatches = document.documentElement.matches.bind(document.documentElement);
          let rootInspected = false;
          let factReads = 0;
          let descendantWalkers = 0;
          document.documentElement.matches = ((selector: string) => {
            rootInspected = true;
            return originalRootMatches(selector);
          }) as typeof document.documentElement.matches;
          const originalGetAttribute = target.getAttribute.bind(target);
          target.getAttribute = ((name: string) => {
            factReads += 1;
            return originalGetAttribute(name);
          }) as typeof target.getAttribute;
          Object.defineProperty(document, 'createTreeWalker', {
            configurable: true,
            value(root: Node, whatToShow: number, filter?: NodeFilter | null) {
              if (root === document.documentElement && whatToShow === NodeFilter.SHOW_ELEMENT) {
                let index = 0;
                return {
                  nextNode(): Node | null {
                    index += 1;
                    const preceding = rootInspected ? 16_381 : 16_382;
                    if (index <= preceding) return dummy;
                    if (index === preceding + 1) return target;
                    return null;
                  },
                };
              }
              if (whatToShow === NodeFilter.SHOW_ALL) descendantWalkers += 1;
              return originalCreateTreeWalker(root, whatToShow, filter);
            },
          });
          Object.defineProperty(globalThis, '__retainedIdentityBoundary', {
            configurable: true,
            get: () => ({ factReads, descendantWalkers }),
          });
        });

        expect(await inspectInteractionCandidateHandle(handle, 0)).toEqual({
          status: 'DOM_WORK_BUDGET_REACHED',
          domWorkUsed: 16_384,
        });
        expect(await page.evaluate(() => (
          globalThis as typeof globalThis & {
            readonly __retainedIdentityBoundary: { readonly factReads: number; readonly descendantWalkers: number };
          }
        ).__retainedIdentityBoundary)).toEqual({ factReads: 0, descendantWalkers: 0 });
      } finally {
        await handle.dispose();
      }
    } finally {
      await page.close();
    }
  });

  it('stops before geometry after the final retained visibility debit', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<button type="button" aria-controls="controlled" aria-label="Boundary">Boundary</button><div id="controlled"></div>');
      const handle = await page.locator('button').elementHandle();
      if (handle === null) throw new Error('Missing visibility boundary candidate');
      try {
        await page.evaluate(() => {
          const target = document.querySelector('button')!;
          const controlled = document.getElementById('controlled')!;
          const originalCreateTreeWalker = document.createTreeWalker.bind(document);
          const originalGetElementById = document.getElementById.bind(document);
          const originalRootMatches = document.documentElement.matches.bind(document.documentElement);
          let rootInspected = false;
          let controlledGeometryReads = 0;
          document.documentElement.matches = ((selector: string) => {
            rootInspected = true;
            return originalRootMatches(selector);
          }) as typeof document.documentElement.matches;
          const controlledAtDepth = (depth: number): Element => new Proxy(controlled, {
            get(subject, property) {
              if (property === 'parentElement') return depth > 1 ? controlledAtDepth(depth - 1) : null;
              if (property === 'getBoundingClientRect') {
                return () => {
                  controlledGeometryReads += 1;
                  return { x: 0, y: 0, width: 1, height: 1, top: 0, right: 1, bottom: 1, left: 0 };
                };
              }
              if (property === 'getClientRects') return () => [{ width: 1, height: 1 }];
              const value = Reflect.get(subject, property, subject) as unknown;
              return typeof value === 'function' ? value.bind(subject) : value;
            },
          });
          document.getElementById = ((id: string) => {
            if (id !== 'controlled') return originalGetElementById(id);
            return controlledAtDepth(rootInspected ? 16_379 : 16_381);
          }) as typeof document.getElementById;
          Object.defineProperty(document, 'createTreeWalker', {
            configurable: true,
            value(root: Node, whatToShow: number, filter?: NodeFilter | null) {
              if (root === document.documentElement && whatToShow === NodeFilter.SHOW_ELEMENT) {
                let returned = false;
                return { nextNode: () => returned ? null : (returned = true, target) };
              }
              return originalCreateTreeWalker(root, whatToShow, filter);
            },
          });
          Object.defineProperty(globalThis, '__retainedVisibilityBoundary', {
            configurable: true,
            get: () => controlledGeometryReads,
          });
        });

        expect(await inspectInteractionCandidateHandle(handle, 0)).toEqual({
          status: 'DOM_WORK_BUDGET_REACHED',
          domWorkUsed: 16_384,
        });
        expect(await page.evaluate(() => (
          globalThis as typeof globalThis & { readonly __retainedVisibilityBoundary: number }
        ).__retainedVisibilityBoundary)).toBe(0);
      } finally {
        await handle.dispose();
      }
    } finally {
      await page.close();
    }
  });

  it('keeps the exact retained node connected and returns its new ordinal after insertion', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<button type="button">Target</button>');
      const resolution = await resolveInteractionCandidateHandle(page, 0);
      if (resolution.status !== 'FOUND') throw new Error('Expected retained target');
      try {
        await page.evaluate(() => {
          const unrelated = document.createElement('button');
          unrelated.type = 'button';
          unrelated.textContent = 'Unrelated';
          document.body.prepend(unrelated);
        });
        await expect(inspectInteractionCandidateHandle(resolution.handle, 0)).resolves.toMatchObject({
          status: 'CONNECTED',
          candidate: { ordinal: 1, accessibleName: 'Target' },
        });
      } finally {
        await resolution.handle.dispose();
      }
    } finally {
      await page.close();
    }
  });

  it('keeps the exact retained node connected at the maximum live ordinal 99', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<button type="button">Target</button>');
      const resolution = await resolveInteractionCandidateHandle(page, 0);
      if (resolution.status !== 'FOUND') throw new Error('Expected retained target');
      try {
        await page.evaluate(() => {
          const target = document.querySelector('button');
          if (target === null) throw new Error('Missing retained target');
          const fragment = document.createDocumentFragment();
          for (let index = 0; index < 99; index += 1) {
            const preceding = document.createElement('button');
            preceding.type = 'button';
            preceding.textContent = `Preceding ${index}`;
            fragment.append(preceding);
          }
          target.before(fragment);
        });

        await expect(inspectInteractionCandidateHandle(resolution.handle, 0)).resolves.toMatchObject({
          status: 'CONNECTED',
          candidate: { ordinal: 99, accessibleName: 'Target' },
        });
      } finally {
        await resolution.handle.dispose();
      }
    } finally {
      await page.close();
    }
  });

  it('reports candidate-limit incompleteness when the exact retained node moves to live ordinal 100', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<button type="button">Target</button>');
      const resolution = await resolveInteractionCandidateHandle(page, 0);
      if (resolution.status !== 'FOUND') throw new Error('Expected retained target');
      try {
        await page.evaluate(() => {
          const target = document.querySelector('button');
          if (target === null) throw new Error('Missing retained target');
          const fragment = document.createDocumentFragment();
          for (let index = 0; index < 100; index += 1) {
            const preceding = document.createElement('button');
            preceding.type = 'button';
            preceding.textContent = `Preceding ${index}`;
            fragment.append(preceding);
          }
          target.before(fragment);
        });

        const snapshot = await inspectInteractionCandidateHandle(resolution.handle, 0);
        expect(snapshot).toEqual({
          status: 'CANDIDATE_LIMIT_REACHED',
          domWorkUsed: expect.any(Number),
        });
        expect(snapshot.status).not.toBe('DISCONNECTED');
        expect(Object.hasOwn(snapshot, 'candidate')).toBe(false);
        expect(Object.isFrozen(snapshot)).toBe(true);
      } finally {
        await resolution.handle.dispose();
      }
    } finally {
      await page.close();
    }
  });

  it('includes a matching document root in discovery, resolution, and retained inspection', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<button type="button">Child</button>');
      await page.evaluate(() => {
        document.documentElement.setAttribute('role', 'button');
        document.documentElement.setAttribute('aria-label', 'Root candidate');
      });
      const discovery = await discoverInteractionCandidates(page);
      expect(discovery.completeness).toBe('COMPLETE');
      expect(discovery.candidates.map(({ ordinal, tagName, accessibleName }) => [ordinal, tagName, accessibleName])).toEqual([
        [0, 'html', 'Root candidate'],
        [1, 'button', 'Child'],
      ]);
      const resolution = await resolveInteractionCandidateHandle(page, 0);
      if (resolution.status !== 'FOUND') throw new Error('Expected root candidate');
      try {
        expect(await resolution.handle.evaluate((element) => element === document.documentElement)).toBe(true);
        await expect(inspectInteractionCandidateHandle(resolution.handle, 0)).resolves.toMatchObject({
          status: 'CONNECTED',
          candidate: { ordinal: 0, tagName: 'html', accessibleName: 'Root candidate' },
        });
      } finally {
        await resolution.handle.dispose();
      }
    } finally {
      await page.close();
    }
  });

  it('Task 2 fix round 2 shares the secondary text cap across accessible-name and normalized-text work', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<div id="label">Label</div><button type="button" aria-labelledby="label">Body</button>');
      await page.evaluate(() => {
        const label = document.getElementById('label')!;
        const button = document.querySelector('button')!;
        label.prepend(...Array.from({ length: 300 }, () => document.createElement('span')));
        button.prepend(...Array.from({ length: 300 }, () => document.createElement('span')));
      });
      const readAcceptedTextNodes = await installTextTraversalCounter(page);

      const discovery = await discoverInteractionCandidates(page);

      expect(discovery.completeness).toBe('DOM_WORK_BUDGET_REACHED');
      expect(discovery.candidates).toEqual([]);
      expect(await readAcceptedTextNodes()).toBe(INTERACTION_CANDIDATE_LIMITS.maxTextNodes);
      expect(discovery.domWorkUsed).toBeLessThan(INTERACTION_CANDIDATE_LIMITS.maxDomWork);
    } finally {
      await page.close();
    }
  });

  it('Task 2 fix round 2 shares the secondary text cap across candidates', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<button type="button" aria-label="First">First body</button><button type="button" aria-label="Second">Second body</button>');
      await page.evaluate(() => {
        for (const button of document.querySelectorAll('button')) {
          button.prepend(...Array.from({ length: 300 }, () => document.createElement('span')));
        }
      });
      const readAcceptedTextNodes = await installTextTraversalCounter(page);

      const discovery = await discoverInteractionCandidates(page);

      expect(discovery.completeness).toBe('DOM_WORK_BUDGET_REACHED');
      expect(discovery.candidates.map(({ accessibleName }) => accessibleName)).toEqual(['First']);
      expect(await readAcceptedTextNodes()).toBe(INTERACTION_CANDIDATE_LIMITS.maxTextNodes);
      expect(discovery.domWorkUsed).toBeLessThan(INTERACTION_CANDIDATE_LIMITS.maxDomWork);
    } finally {
      await page.close();
    }
  });

  it('Task 2 fix round 2 shares the retained secondary text cap across accessible-name and normalized-text work', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<div id="label">Label</div><button type="button" aria-labelledby="label">Body</button>');
      await page.evaluate(() => {
        const label = document.getElementById('label')!;
        const button = document.querySelector('button')!;
        label.prepend(...Array.from({ length: 300 }, () => document.createElement('span')));
        button.prepend(...Array.from({ length: 300 }, () => document.createElement('span')));
      });
      const resolution = await resolveInteractionCandidateHandle(page, 0);
      if (resolution.status !== 'FOUND') throw new Error('Expected retained secondary-cap candidate');
      try {
        const readAcceptedTextNodes = await installTextTraversalCounter(page);

        await expect(inspectInteractionCandidateHandle(resolution.handle, 0)).resolves.toEqual({
          status: 'DOM_WORK_BUDGET_REACHED',
          domWorkUsed: expect.any(Number),
        });
        expect(await readAcceptedTextNodes()).toBe(INTERACTION_CANDIDATE_LIMITS.maxTextNodes);
      } finally {
        await resolution.handle.dispose();
      }
    } finally {
      await page.close();
    }
  });
});

describe('Task 2 correction resolver ownership and envelope validation', () => {
  function probeProperty(
    name: string,
    disposed: string[],
    options: {
      readonly value?: unknown;
      readonly element?: unknown;
      readonly readError?: Error;
      readonly disposeError?: Error;
    } = {},
  ) {
    return {
      async jsonValue() {
        if (options.readError !== undefined) throw options.readError;
        return options.value;
      },
      asElement: () => options.element ?? null,
      async dispose() {
        disposed.push(name);
        if (options.disposeError !== undefined) throw options.disposeError;
      },
    };
  }

  it('cleans every acquired resolver property when status reading fails', async () => {
    const disposed: string[] = [];
    const candidate = probeProperty('element', disposed);
    const envelope = injectedResolutionEnvelope(new Map([
      ['status', probeProperty('status', disposed, { readError: new Error('status read failed') })],
      ['domWorkUsed', probeProperty('domWorkUsed', disposed, { value: 1 })],
      ['element', candidate],
      ['extra', probeProperty('extra', disposed, { value: 'unused' })],
    ]), async () => { disposed.push('envelope'); });

    await expect(resolveInteractionCandidateHandle(injectedResolutionPage(envelope), 0)).rejects.toThrow('status read failed');
    expect(disposed.sort()).toEqual(['domWorkUsed', 'element', 'envelope', 'extra', 'status'].sort());
  });

  it('Task 2 fix round 2 preserves an undefined resolver rejection after successful cleanup', async () => {
    const disposed: string[] = [];
    const undefinedRejectingStatus = {
      jsonValue: async (): Promise<never> => Promise.reject(undefined),
      asElement: () => null,
      dispose: async () => { disposed.push('status'); },
    };
    const envelope = injectedResolutionEnvelope(new Map([
      ['status', undefinedRejectingStatus],
      ['domWorkUsed', probeProperty('domWorkUsed', disposed, { value: 1 })],
      ['element', probeProperty('element', disposed)],
      ['extra', probeProperty('extra', disposed, { value: 'unused' })],
    ]), async () => { disposed.push('envelope'); });

    await expect(resolveInteractionCandidateHandle(injectedResolutionPage(envelope), 0)).rejects.toBeUndefined();
    expect(disposed.sort()).toEqual(['domWorkUsed', 'element', 'envelope', 'extra', 'status'].sort());
  });

  it('Task 2 fix round 2 retains undefined primary presence with cleanup failures', async () => {
    const disposed: string[] = [];
    const cleanupError = new Error('metadata cleanup failed');
    const undefinedRejectingStatus = {
      jsonValue: async (): Promise<never> => Promise.reject(undefined),
      asElement: () => null,
      dispose: async () => { disposed.push('status'); },
    };
    const envelope = injectedResolutionEnvelope(new Map([
      ['status', undefinedRejectingStatus],
      ['domWorkUsed', probeProperty('domWorkUsed', disposed, { value: 1, disposeError: cleanupError })],
      ['element', probeProperty('element', disposed)],
      ['extra', probeProperty('extra', disposed, { value: 'unused' })],
    ]), async () => { disposed.push('envelope'); });

    let rejection: unknown;
    try {
      await resolveInteractionCandidateHandle(injectedResolutionPage(envelope), 0);
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(AggregateError);
    expect((rejection as AggregateError).errors).toEqual([undefined, cleanupError]);
    expect(disposed.sort()).toEqual(['domWorkUsed', 'element', 'envelope', 'extra', 'status'].sort());
  });

  it('attempts all resolver cleanup after metadata disposal fails and reclaims the prospective FOUND child', async () => {
    const disposed: string[] = [];
    const candidate = probeProperty('element', disposed);
    candidate.asElement = () => candidate;
    const envelope = injectedResolutionEnvelope(new Map([
      ['status', probeProperty('status', disposed, { value: 'FOUND', disposeError: new Error('status dispose failed') })],
      ['domWorkUsed', probeProperty('domWorkUsed', disposed, { value: 2 })],
      ['element', candidate],
      ['extra', probeProperty('extra', disposed, { value: 'unused' })],
    ]), async () => { disposed.push('envelope'); });

    await expect(resolveInteractionCandidateHandle(injectedResolutionPage(envelope), 0)).rejects.toThrow('status dispose failed');
    expect(disposed.sort()).toEqual(['domWorkUsed', 'element', 'envelope', 'extra', 'status'].sort());
  });

  it('disposes unknown resolver properties on a successful non-FOUND envelope', async () => {
    const disposed: string[] = [];
    const envelope = injectedResolutionEnvelope(new Map([
      ['status', probeProperty('status', disposed, { value: 'MISSING' })],
      ['domWorkUsed', probeProperty('domWorkUsed', disposed, { value: 2 })],
      ['extra', probeProperty('extra', disposed, { value: 'unused' })],
    ]), async () => { disposed.push('envelope'); });

    await expect(resolveInteractionCandidateHandle(injectedResolutionPage(envelope), 0)).resolves.toEqual({
      status: 'MISSING',
      domWorkUsed: 2,
    });
    expect(disposed.sort()).toEqual(['domWorkUsed', 'envelope', 'extra', 'status'].sort());
  });

  it('reclaims a prospective FOUND child when envelope cleanup fails before transfer', async () => {
    const disposed: string[] = [];
    const candidate = probeProperty('element', disposed);
    candidate.asElement = () => candidate;
    const envelope = injectedResolutionEnvelope(new Map([
      ['status', probeProperty('status', disposed, { value: 'FOUND' })],
      ['domWorkUsed', probeProperty('domWorkUsed', disposed, { value: 2 })],
      ['element', candidate],
    ]), async () => {
      disposed.push('envelope');
      throw new Error('envelope dispose failed');
    });

    await expect(resolveInteractionCandidateHandle(injectedResolutionPage(envelope), 0)).rejects.toThrow('envelope dispose failed');
    expect(disposed.sort()).toEqual(['domWorkUsed', 'element', 'envelope', 'status'].sort());
  });

  it.each([
    ['unknown status', new Map<string, unknown>([['status', 'UNKNOWN'], ['domWorkUsed', 0]])],
    ['negative work', new Map<string, unknown>([['status', 'MISSING'], ['domWorkUsed', -1]])],
    ['out-of-range work', new Map<string, unknown>([['status', 'MISSING'], ['domWorkUsed', 16_385]])],
    ['fractional work', new Map<string, unknown>([['status', 'MISSING'], ['domWorkUsed', 1.5]])],
    ['missing FOUND child', new Map<string, unknown>([['status', 'FOUND'], ['domWorkUsed', 2]])],
    ['non-element FOUND child', new Map<string, unknown>([['status', 'FOUND'], ['domWorkUsed', 2], ['element', null]])],
    ['contradictory MISSING child', new Map<string, unknown>([['status', 'MISSING'], ['domWorkUsed', 2], ['element', 'element']])],
    ['contradictory budget child', new Map<string, unknown>([['status', 'DOM_WORK_BUDGET_REACHED'], ['domWorkUsed', 2], ['element', 'element']])],
  ] as const)('rejects malformed resolver envelope: %s', async (_label, values) => {
    const disposed: string[] = [];
    let candidate: ReturnType<typeof probeProperty> | undefined;
    const properties = new Map<string, unknown>();
    for (const [name, value] of values) {
      if (name === 'element') {
        candidate = probeProperty('element', disposed);
        if (value === 'element') candidate.asElement = () => candidate as ReturnType<typeof probeProperty>;
        properties.set(name, candidate);
      } else {
        properties.set(name, probeProperty(name, disposed, { value }));
      }
    }
    const envelope = injectedResolutionEnvelope(properties, async () => { disposed.push('envelope'); });
    await expect(resolveInteractionCandidateHandle(injectedResolutionPage(envelope), 0)).rejects.toThrow();
    expect(disposed).toContain('envelope');
    expect(disposed).toEqual(expect.arrayContaining([...properties.keys()]));
  });

  it.each([
    ['null container', null],
    ['array container', []],
    ['unknown status', { status: 'UNKNOWN', domWorkUsed: 0 }],
    ['negative work', { status: 'DISCONNECTED', domWorkUsed: -1 }],
    ['out-of-range work', { status: 'DOM_WORK_BUDGET_REACHED', domWorkUsed: 16_385 }],
    ['fractional work', { status: 'DISCONNECTED', domWorkUsed: 1.5 }],
    ['missing CONNECTED raw', { status: 'CONNECTED', domWorkUsed: 1 }],
    ['contradictory DISCONNECTED raw', { status: 'DISCONNECTED', domWorkUsed: 1, raw: {} }],
    ['contradictory budget raw', { status: 'DOM_WORK_BUDGET_REACHED', domWorkUsed: 1, raw: {} }],
    ['contradictory candidate-limit raw', { status: 'CANDIDATE_LIMIT_REACHED', domWorkUsed: 1, raw: {} }],
    ['out-of-range candidate-limit work', { status: 'CANDIDATE_LIMIT_REACHED', domWorkUsed: 16_385 }],
  ] as const)('rejects malformed retained snapshot: %s', async (_label, value) => {
    const handle = { evaluate: async () => value } as unknown as Parameters<typeof inspectInteractionCandidateHandle>[0];
    await expect(inspectInteractionCandidateHandle(handle, 0)).rejects.toThrow();
  });

  it('accepts an immutable candidate-limit retained snapshot without a candidate payload', async () => {
    const handle = {
      evaluate: async () => ({ status: 'CANDIDATE_LIMIT_REACHED', domWorkUsed: 205 }),
    } as unknown as Parameters<typeof inspectInteractionCandidateHandle>[0];

    const snapshot = await inspectInteractionCandidateHandle(handle, 0);

    expect(snapshot).toEqual({ status: 'CANDIDATE_LIMIT_REACHED', domWorkUsed: 205 });
    expect(Object.hasOwn(snapshot, 'candidate')).toBe(false);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });
});

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

async function installTextTraversalCounter(page: Page): Promise<() => Promise<number>> {
  await page.evaluate(() => {
    const original = document.createTreeWalker.bind(document);
    let acceptedTextNodes = 0;
    Object.defineProperty(document, 'createTreeWalker', {
      configurable: true,
      value(root: Node, whatToShow: number, filter?: NodeFilter | null) {
        const walker = original(root, whatToShow, filter);
        if (whatToShow !== NodeFilter.SHOW_ALL) return walker;
        const nextNode = walker.nextNode.bind(walker);
        walker.nextNode = () => {
          const node = nextNode();
          if (node !== null) acceptedTextNodes += 1;
          return node;
        };
        return walker;
      },
    });
    Object.defineProperty(globalThis, '__acceptedTextNodes', {
      configurable: true,
      get: () => acceptedTextNodes,
    });
  });
  return () => page.evaluate(() => (
    globalThis as typeof globalThis & { readonly __acceptedTextNodes: number }
  ).__acceptedTextNodes);
}

async function installTraversalProbe(page: Page): Promise<() => Promise<number>> {
  await page.evaluate((maxNodes) => {
    const original = document.createTreeWalker.bind(document);
    let nextNodeCalls = 0;
    Object.defineProperty(document, 'createTreeWalker', {
      configurable: true,
      value(root: Node, whatToShow: number, filter?: NodeFilter | null) {
        if (whatToShow !== NodeFilter.SHOW_ALL) return original(root, whatToShow, filter);
        const walker = original(root, whatToShow, filter);
        return new Proxy(walker, {
          get(target, property) {
            if (property !== 'nextNode') {
              return Reflect.get(target, property, target);
            }
            return () => {
              nextNodeCalls += 1;
              if (nextNodeCalls > maxNodes) {
                throw new Error('total node traversal exceeded its bound');
              }
              return target.nextNode();
            };
          },
        });
      },
    });
    Object.defineProperty(globalThis, '__beakSightTraversalCount', {
      configurable: true,
      get: () => nextNodeCalls,
    });
  }, INTERACTION_CANDIDATE_LIMITS.maxTextNodes);
  return async () => page.evaluate(() => (
    globalThis as typeof globalThis & { readonly __beakSightTraversalCount: number }
  ).__beakSightTraversalCount);
}

async function installAggregateTraversalProbe(page: Page): Promise<() => Promise<number>> {
  await page.evaluate((maxNodes) => {
    const original = document.createTreeWalker.bind(document);
    let nonNullNextNodeCalls = 0;
    Object.defineProperty(document, 'createTreeWalker', {
      configurable: true,
      value(root: Node, whatToShow: number, filter?: NodeFilter | null) {
        if (whatToShow !== NodeFilter.SHOW_ALL) return original(root, whatToShow, filter);
        const walker = original(root, whatToShow, filter);
        return new Proxy(walker, {
          get(target, property) {
            if (property !== 'nextNode') {
              return Reflect.get(target, property, target);
            }
            return () => {
              const node = target.nextNode();
              if (node !== null) {
                nonNullNextNodeCalls += 1;
                if (nonNullNextNodeCalls > maxNodes) {
                  throw new Error('aggregate descendant traversal exceeded its bound');
                }
              }
              return node;
            };
          },
        });
      },
    });
    Object.defineProperty(globalThis, '__beakSightAggregateTraversalCount', {
      configurable: true,
      get: () => nonNullNextNodeCalls,
    });
  }, INTERACTION_CANDIDATE_LIMITS.maxTextNodes);
  return async () => page.evaluate(() => (
    globalThis as typeof globalThis & { readonly __beakSightAggregateTraversalCount: number }
  ).__beakSightAggregateTraversalCount);
}

describe('interaction candidate discovery', () => {
  it('discovers the generic union once in document order, deduplicates it, bounds facts, and leaves DOM untouched', async () => {
    const context = await factory.createPassiveContext(viewport);
    const page = await factory.createPassivePage(context);
    try {
      await page.goto(`${server.origin}/accordion.html`, { waitUntil: 'load' });
      const before = await page.content();

      const discovery = await discoverInteractionCandidates(page);
      expect(discovery.completeness).toBe('COMPLETE');
      const candidates = discovery.candidates;

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
    const candidates = await discover('/candidate-overflow.html', 'CANDIDATE_LIMIT_REACHED');

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
            if (whatToShow !== NodeFilter.SHOW_ALL) return createTreeWalker(root, whatToShow, filter);
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
      }, INTERACTION_CANDIDATE_LIMITS.maxTextNodes);

      const discovery = await discoverInteractionCandidates(page);
      expect(discovery.completeness).toBe('DOM_WORK_BUDGET_REACHED');
      const candidates = discovery.candidates;

      expect(candidates).toEqual([]);
    } finally {
      await factory.closePassiveContext(context);
    }
  });

  it('bounds total descendant nodes during discovery with all-node traversal', async () => {
    const context = await factory.createPassiveContext(viewport);
    const page = await factory.createPassivePage(context);
    try {
      await page.goto(`${server.origin}/hostile-candidates.html`, { waitUntil: 'load' });
      const readNextNodeCalls = await installTraversalProbe(page);

      const discovery = await discoverInteractionCandidates(page);
      expect(discovery.completeness).toBe('DOM_WORK_BUDGET_REACHED');
      const candidates = discovery.candidates;
      const nextNodeCalls = await readNextNodeCalls();

      expect(nextNodeCalls).toBeLessThanOrEqual(INTERACTION_CANDIDATE_LIMITS.maxTextNodes);
      expect(candidates).toEqual([]);
    } finally {
      await factory.closePassiveContext(context);
    }
  });

  it('bounds total descendant nodes during retained inspection with all-node traversal', async () => {
    const context = await factory.createPassiveContext(viewport);
    const page = await factory.createPassivePage(context);
    try {
      await page.goto(`${server.origin}/hostile-candidates.html`, { waitUntil: 'load' });
      const handle = await page.locator(INTERACTION_CANDIDATE_SELECTOR).first().elementHandle();
      if (handle === null) {
        throw new Error('fixture candidate handle missing');
      }
      try {
        const readNextNodeCalls = await installTraversalProbe(page);

        await expect(inspectInteractionCandidateHandle(handle, 0)).resolves.toMatchObject({
          status: 'DOM_WORK_BUDGET_REACHED',
        });
        const nextNodeCalls = await readNextNodeCalls();

        expect(nextNodeCalls).toBeLessThanOrEqual(INTERACTION_CANDIDATE_LIMITS.maxTextNodes);
      } finally {
        await handle.dispose();
      }
    } finally {
      await factory.closePassiveContext(context);
    }
  });

  it('shares the aggregate descendant-node budget across label roots during discovery', async () => {
    const context = await factory.createPassiveContext(viewport);
    const page = await factory.createPassivePage(context);
    try {
      await page.goto(`${server.origin}/multi-root-candidates.html`, { waitUntil: 'load' });
      const readNextNodeCalls = await installAggregateTraversalProbe(page);

      const discovery = await discoverInteractionCandidates(page);
      expect(discovery.completeness).toBe('DOM_WORK_BUDGET_REACHED');
      const candidates = discovery.candidates;
      const nextNodeCalls = await readNextNodeCalls();

      expect(nextNodeCalls).toBe(INTERACTION_CANDIDATE_LIMITS.maxTextNodes);
      expect(candidates).toEqual([]);
    } finally {
      await factory.closePassiveContext(context);
    }
  });

  it('shares the aggregate descendant-node budget across label roots during retained inspection', async () => {
    const context = await factory.createPassiveContext(viewport);
    const page = await factory.createPassivePage(context);
    try {
      await page.goto(`${server.origin}/multi-root-candidates.html`, { waitUntil: 'load' });
      const handle = await page.locator(INTERACTION_CANDIDATE_SELECTOR).first().elementHandle();
      if (handle === null) {
        throw new Error('fixture candidate handle missing');
      }
      try {
        const readNextNodeCalls = await installAggregateTraversalProbe(page);

        await expect(inspectInteractionCandidateHandle(handle, 0)).resolves.toMatchObject({
          status: 'DOM_WORK_BUDGET_REACHED',
        });
        const nextNodeCalls = await readNextNodeCalls();

        expect(nextNodeCalls).toBe(INTERACTION_CANDIDATE_LIMITS.maxTextNodes);
      } finally {
        await handle.dispose();
      }
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

        await expect(inspectInteractionCandidateHandle(handle, 0)).resolves.toMatchObject({ status: 'CONNECTED' });
      } finally {
        await handle.dispose();
      }
    } finally {
      await factory.closePassiveContext(context);
    }
  });

  it('keeps a connected retained handle outside the ordinal cap distinct from disconnection', async () => {
    const context = await factory.createPassiveContext(viewport);
    const page = await factory.createPassivePage(context);
    try {
      await page.goto(`${server.origin}/candidate-overflow.html`, { waitUntil: 'load' });
      const handle = await page.locator(INTERACTION_CANDIDATE_SELECTOR).nth(100).elementHandle();
      if (handle === null) {
        throw new Error('overflow fixture candidate handle missing');
      }
      try {
        await expect(inspectInteractionCandidateHandle(handle, 99)).resolves.toEqual({
          status: 'CANDIDATE_LIMIT_REACHED',
          domWorkUsed: expect.any(Number),
        });
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
      const beforeDiscovery = await discoverInteractionCandidates(page);
      expect(beforeDiscovery.completeness).toBe('COMPLETE');
      const before = beforeDiscovery.candidates
        .find((candidate) => candidate.accessibleName === 'Toggle details');
      await page.evaluate(() => {
        const inserted = document.createElement('button');
        inserted.type = 'button';
        inserted.textContent = 'Unrelated inserted candidate';
        document.body.prepend(inserted);
      });
      const afterDiscovery = await discoverInteractionCandidates(page);
      expect(afterDiscovery.completeness).toBe('COMPLETE');
      const after = afterDiscovery.candidates
        .find((candidate) => candidate.accessibleName === 'Toggle details');
      const unrelated = afterDiscovery.candidates
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
  it('Task 2 fix round 2 keeps identity unestablished when the initial load consumes the deadline', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const page = {
      goto: async () => { vi.setSystemTime(3_000); },
    } as unknown as Page;
    const session: InteractionGuardedSession = {
      page,
      ledger: new SafetyLedger(),
      activateInteractionFreeze: async () => undefined,
      ...fakeCloseLifecycle(),
    };
    try {
      const result = await auditInteraction({
        ...input('/accordion.html', candidate),
        timeoutMs: 2_000,
        deadlineAtMs: 10_000,
        sessionFactory: async () => session,
      });

      expect(result.status).toBe('NOT_VERIFIABLE');
      expect(result.reason).toBe('Interaction deadline expired after initial load');
      expect(result.evidence.identityStatus).toBe('UNESTABLISHED');
    } finally {
      vi.useRealTimers();
    }
  });

  it('Task 2 fix round 2 keeps identity unestablished for navigation work errors', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    const session: InteractionGuardedSession = {
      page: { goto: async (): Promise<never> => { throw new Error('navigation work failed'); } } as unknown as Page,
      ledger: new SafetyLedger(),
      activateInteractionFreeze: async () => undefined,
      ...fakeCloseLifecycle(),
    };

    const result = await auditInteraction({
      ...input('/accordion.html', candidate),
      sessionFactory: async () => session,
    });

    expect(result.status).toBe('EXECUTION_FAILED');
    expect(result.reason).toBe('navigation work failed');
    expect(result.evidence.identityStatus).toBe('UNESTABLISHED');
  });

  it('Task 2 fix round 2 keeps identity unestablished for an unresolved safety transition', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    const page = {
      goto: async () => undefined,
      evaluate: async () => true,
    } as unknown as Page;
    const session: InteractionGuardedSession = {
      page,
      ledger: new SafetyLedger(),
      activateInteractionFreeze: async (): Promise<never> => { throw new Error('freeze transition unresolved'); },
      ...fakeCloseLifecycle(),
    };

    const result = await auditInteraction({
      ...input('/accordion.html', candidate),
      sessionFactory: async () => session,
    });

    expect(result.status).toBe('EXECUTION_FAILED');
    expect(result.reason).toBe('freeze transition unresolved');
    expect(result.evidence.identityStatus).toBe('UNESTABLISHED');
  });

  it('Task 2 fix round 2 keeps identity unestablished before the first retained observation', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    const rawCandidate = rawCandidateFor(candidate);
    const ledger = new SafetyLedger();
    const targetHandle = {
      evaluate: async () => ({ status: 'CONNECTED', domWorkUsed: 10, raw: rawCandidate }),
      click: async () => {
        ledger.recordBlockedInteractionRequest({
          method: 'GET',
          url: `${server.origin}/blocked-before-observation`,
          reason: 'INTERACTION_FROZEN',
        });
      },
      dispose: async () => undefined,
    };
    const page = {
      goto: async () => undefined,
      evaluate: async (_callback: unknown, argument?: unknown) => (
        argument === undefined ? true : { candidates: [rawCandidate], completeness: 'COMPLETE', domWorkUsed: 20 }
      ),
      evaluateHandle: async () => boundedResolutionEnvelope(targetHandle),
    } as unknown as Page;
    const session: InteractionGuardedSession = {
      page,
      ledger,
      activateInteractionFreeze: async () => undefined,
      ...fakeCloseLifecycle(),
    };

    const result = await auditInteraction({
      ...input('/accordion.html', candidate),
      sessionFactory: async () => session,
    });

    expect(result.status).toBe('BLOCKED_BY_SAFETY');
    expect(result.evidence.identityStatus).toBe('UNESTABLISHED');
  });

  it('Task 2 fix round 2 keeps identity unestablished when the retained node changes before admission', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    const rawCandidate = rawCandidateFor(candidate);
    const changedRawCandidate = { ...rawCandidate, accessibleName: 'Changed retained candidate' };
    const targetHandle = {
      evaluate: async () => ({ status: 'CONNECTED', domWorkUsed: 10, raw: changedRawCandidate }),
      click: async () => undefined,
      dispose: async () => undefined,
    };
    const page = {
      goto: async () => undefined,
      evaluate: async (_callback: unknown, argument?: unknown) => (
        argument === undefined ? true : { candidates: [rawCandidate], completeness: 'COMPLETE', domWorkUsed: 20 }
      ),
      evaluateHandle: async () => boundedResolutionEnvelope(targetHandle),
    } as unknown as Page;
    const session: InteractionGuardedSession = {
      page,
      ledger: new SafetyLedger(),
      activateInteractionFreeze: async () => undefined,
      ...fakeCloseLifecycle(),
    };

    const result = await auditInteraction({
      ...input('/accordion.html', candidate),
      sessionFactory: async () => session,
    });

    expect(result.status).toBe('NOT_VERIFIABLE');
    expect(result.reason).toBe('Candidate target changed during exact-node resolution');
    expect(result.evidence.identityStatus).toBe('UNESTABLISHED');
  });

  it('Task 2 fix round 2 keeps identity unestablished after disconnection and incomplete rediscovery', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    const rawCandidate = rawCandidateFor(candidate);
    const snapshots = [
      { status: 'CONNECTED', domWorkUsed: 10, raw: rawCandidate },
      { status: 'DISCONNECTED', domWorkUsed: 10 },
    ];
    let snapshotIndex = 0;
    let discoveryIndex = 0;
    const targetHandle = {
      evaluate: async () => snapshots[snapshotIndex++],
      click: async () => undefined,
      dispose: async () => undefined,
    };
    const page = {
      goto: async () => undefined,
      evaluate: async (_callback: unknown, argument?: unknown) => {
        if (argument === undefined) return true;
        discoveryIndex += 1;
        return discoveryIndex === 1
          ? { candidates: [rawCandidate], completeness: 'COMPLETE', domWorkUsed: 20 }
          : { candidates: [], completeness: 'DOM_WORK_BUDGET_REACHED', domWorkUsed: 16_344 };
      },
      evaluateHandle: async () => boundedResolutionEnvelope(targetHandle),
    } as unknown as Page;
    const session: InteractionGuardedSession = {
      page,
      ledger: new SafetyLedger(),
      activateInteractionFreeze: async () => undefined,
      ...fakeCloseLifecycle(),
    };

    const result = await auditInteraction({
      ...input('/accordion.html', candidate),
      sessionFactory: async () => session,
    });

    expect(result.status).toBe('NOT_VERIFIABLE');
    expect(result.reason).toBe('Interaction-wide DOM work budget exhausted');
    expect(result.evidence.identityStatus).toBe('UNESTABLISHED');
  });

  it.each(['pre-admission inspection', 'retained observation'] as const)(
    'Task 11 final quality maps candidate-limit %s directly without disconnected rediscovery',
    async (branch) => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');
      const rawCandidate = rawCandidateFor(candidate);
      const snapshots = branch === 'pre-admission inspection'
        ? [{ status: 'CANDIDATE_LIMIT_REACHED', domWorkUsed: 205 }]
        : [
            { status: 'CONNECTED', domWorkUsed: 10, raw: rawCandidate },
            { status: 'CANDIDATE_LIMIT_REACHED', domWorkUsed: 205 },
          ];
      let snapshotIndex = 0;
      let discoveryCount = 0;
      const targetHandle = {
        evaluate: async () => snapshots[snapshotIndex++],
        click: async () => {
          if (branch === 'pre-admission inspection') {
            throw new Error('candidate-limit pre-admission must not click');
          }
        },
        dispose: async () => undefined,
      };
      const page = {
        goto: async () => undefined,
        evaluate: async (_callback: unknown, argument?: unknown) => {
          if (argument === undefined) return true;
          discoveryCount += 1;
          if (discoveryCount > 1) {
            throw new Error('candidate-limit retained inspection must not rediscover');
          }
          return { candidates: [rawCandidate], completeness: 'COMPLETE', domWorkUsed: 20 };
        },
        evaluateHandle: async () => boundedResolutionEnvelope(targetHandle),
      } as unknown as Page;
      const session: InteractionGuardedSession = {
        page,
        ledger: new SafetyLedger(),
        activateInteractionFreeze: async () => undefined,
        ...fakeCloseLifecycle(),
      };

      const result = await auditInteraction({
        ...input('/accordion.html', candidate),
        sessionFactory: async () => session,
      });

      expect(result.status).toBe('NOT_VERIFIABLE');
      expect(result.reason).toBe(branch === 'pre-admission inspection'
        ? 'Candidate target inspection reached candidate limit'
        : 'Retained candidate inspection reached candidate limit');
      expect(result.evidence).toMatchObject({
        identityStatus: 'UNESTABLISHED',
        after: null,
      });
      expect(result.evidence.identityStatus).not.toBe('MISSING');
      expect(result.evidence.identityStatus).not.toBe('REPLACED');
      expect(discoveryCount).toBe(1);
    },
  );

  it.each(['complete rediscovery absence', 'complete resolution absence'] as const)(
    'Task 2 fix round 2 preserves MISSING for %s',
    async (branch) => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');
      const rawCandidate = rawCandidateFor(candidate);
      const property = (value: unknown) => ({
        jsonValue: async () => value,
        asElement: () => null,
        dispose: async () => undefined,
      });
      const page = {
        goto: async () => undefined,
        evaluate: async (_callback: unknown, argument?: unknown) => (
          argument === undefined
            ? true
            : branch === 'complete rediscovery absence'
              ? { candidates: [], completeness: 'COMPLETE', domWorkUsed: 10 }
              : { candidates: [rawCandidate], completeness: 'COMPLETE', domWorkUsed: 20 }
        ),
        evaluateHandle: async () => injectedResolutionEnvelope(new Map([
          ['status', property('MISSING')],
          ['domWorkUsed', property(10)],
        ])),
      } as unknown as Page;
      const session: InteractionGuardedSession = {
        page,
        ledger: new SafetyLedger(),
        activateInteractionFreeze: async () => undefined,
        ...fakeCloseLifecycle(),
      };

      const result = await auditInteraction({
        ...input('/accordion.html', candidate),
        sessionFactory: async () => session,
      });

      expect(result.status).toBe('NOT_VERIFIABLE');
      expect(result.evidence.identityStatus).toBe('MISSING');
    },
  );

  it.each([
    'rediscovery',
    'resolution',
    'pre-admission inspection',
    'retained observation',
  ] as const)('Task 2 correction represents incomplete %s identity as unestablished', async (branch) => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    const rawCandidate = rawCandidateFor(candidate);
    const snapshots = branch === 'pre-admission inspection'
      ? [{ status: 'DOM_WORK_BUDGET_REACHED', domWorkUsed: 16_364 }]
      : branch === 'retained observation'
        ? [
            { status: 'CONNECTED', domWorkUsed: 10, raw: rawCandidate },
            { status: 'DOM_WORK_BUDGET_REACHED', domWorkUsed: 16_354 },
          ]
        : [];
    let snapshotIndex = 0;
    const targetHandle = {
      evaluate: async () => snapshots[snapshotIndex++],
      click: async () => undefined,
      dispose: async () => undefined,
    };
    const property = (value: unknown, element: unknown = null) => ({
      jsonValue: async () => value,
      asElement: () => element,
      dispose: async () => undefined,
    });
    const resolutionEnvelope = branch === 'resolution'
      ? injectedResolutionEnvelope(new Map([
          ['status', property('DOM_WORK_BUDGET_REACHED')],
          ['domWorkUsed', property(16_364)],
        ]))
      : boundedResolutionEnvelope(targetHandle);
    const page = {
      goto: async () => undefined,
      evaluate: async (_callback: unknown, argument?: unknown) => (
        argument === undefined
          ? true
          : branch === 'rediscovery'
            ? { candidates: [], completeness: 'DOM_WORK_BUDGET_REACHED', domWorkUsed: 16_384 }
            : { candidates: [rawCandidate], completeness: 'COMPLETE', domWorkUsed: 20 }
      ),
      evaluateHandle: async () => resolutionEnvelope,
    } as unknown as Page;
    const session: InteractionGuardedSession = {
      page,
      ledger: new SafetyLedger(),
      activateInteractionFreeze: async () => undefined,
      ...fakeCloseLifecycle(),
    };

    const result = await auditInteraction({
      ...input('/accordion.html', candidate),
      sessionFactory: async () => session,
    });

    expect(result.status).toBe('NOT_VERIFIABLE');
    expect(result.reason).toBe('Interaction-wide DOM work budget exhausted');
    expect(result.evidence.identityStatus).toBe('UNESTABLISHED');
  });

  it('returns immutable result axes for a normal successful audit', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    server.resetCounters();
    server.resetRequestObservations();

    const result = await auditInteraction(input('/accordion.html', candidate));

    expect(result.status, JSON.stringify(result)).toBe('VERIFIED');
    expect(result.reason).toBe('Observable interaction state changed');
    expect(expectedStructuredResult(result).work).toEqual({
      status: 'VERIFIED',
      reason: 'Observable interaction state changed',
      evidence: result.evidence,
    });
    expect(expectedStructuredResult(result).lifecycle).toEqual({ status: 'CLOSED', reason: null });
    expect(result.evidence).toBe(expectedStructuredResult(result).work.evidence);
    expect(result.evidence.changedFields).toEqual(expect.arrayContaining(['ariaExpanded', 'controlledVisible']));
    expect(result.evidence.before?.ariaExpanded).toBe('false');
    expect(result.evidence.after?.ariaExpanded).toBe('true');
    expect(server.getCounters()).toMatchObject({ get: 1, post: 0, download: 0, webSocketUpgrade: 0 });
    expect(server.getRequestObservations().map((entry) => entry.pathname)).toEqual(['/accordion.html']);
    expect(result.safety.invariantViolations).toEqual([]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(expectedStructuredResult(result).work)).toBe(true);
    expect(Object.isFrozen(expectedStructuredResult(result).lifecycle)).toBe(true);
    expect(Object.isFrozen(result.evidence)).toBe(true);
    expect(Object.isFrozen(result.evidence.changedFields)).toBe(true);
    expect(Object.isFrozen(result.safety)).toBe(true);
    for (const value of Object.values(result.safety)) {
      expect(Object.isFrozen(value)).toBe(true);
    }
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
    let browserClickEvents = 0;
    const sessionFactory = async (sessionViewport: Viewport): Promise<InteractionGuardedSession> => {
      const session = await factory.createInteractionSession(sessionViewport);
      const page = session.page;
      await page.exposeFunction('__recordUnsafeAcquiredChildClick', () => {
        browserClickEvents += 1;
      });
      const wrappedPage = Object.create(page) as Page;
      const evaluateHandle = page.evaluateHandle.bind(page) as (...args: never[]) => Promise<unknown>;
      wrappedPage.evaluateHandle = (async (...args: never[]) => {
        await page.evaluate(() => {
          document.addEventListener('click', () => {
            void (globalThis as typeof globalThis & {
              __recordUnsafeAcquiredChildClick(): Promise<void>;
            }).__recordUnsafeAcquiredChildClick();
          }, { capture: true });
          const inserted = document.createElement('a');
          inserted.setAttribute('role', 'button');
          inserted.href = '/navigation-target.html';
          inserted.textContent = 'Unsafe inserted navigation';
          document.body.prepend(inserted);
        });
        return evaluateHandle(...args);
      }) as Page['evaluateHandle'];
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
    expect(browserClickEvents).toBe(0);
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
        return { candidates: [rawCandidate], completeness: 'COMPLETE', domWorkUsed: 0 };
      },
      evaluateHandle: async () => boundedResolutionEnvelope((await page.locator(INTERACTION_CANDIDATE_SELECTOR).nth(candidate.ordinal).elementHandle()) as never),
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
      ...fakeCloseLifecycle(),
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

  it('preserves the deadline outcome when deadline handle dispose failed', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    let clickCalls = 0;
    let disposeCalls = 0;
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
        argument === undefined ? true : { candidates: [rawCandidate], completeness: 'COMPLETE', domWorkUsed: 0 }
      ),
      evaluateHandle: async () => boundedResolutionEnvelope((await page.locator(INTERACTION_CANDIDATE_SELECTOR).nth(candidate.ordinal).elementHandle()) as never),
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
                return { status: 'CONNECTED', domWorkUsed: 0, raw: rawCandidate };
              },
              async click() {
                clickCalls += 1;
              },
              async dispose(): Promise<never> {
                disposeCalls += 1;
                throw new Error('deadline handle dispose failed');
              },
            };
          },
        }),
      }),
    } as unknown as Page;
    const session: InteractionGuardedSession = {
      page,
      ledger: new SafetyLedger(),
      activateInteractionFreeze: async () => undefined,
      ...fakeCloseLifecycle(),
    };
    try {
      const result = await auditInteraction({
        ...input('/accordion.html', candidate),
        timeoutMs: 2_000,
        deadlineAtMs: 10_000,
        sessionFactory: async () => session,
      });

      expect(result.status).toBe('NOT_VERIFIABLE');
      expect(result.reason).toBe('Interaction deadline expired during target handle acquisition');
      expect(result.evidence.after).toBeNull();
      expect(disposeCalls).toBe(1);
      expect(result.safety.invariantViolations).toContainEqual({
        code: 'INTERACTION_HANDLE_DISPOSE_FAILED',
        message: 'deadline handle dispose failed',
      });
      expect(result.safety.invariantViolations.filter(
        ({ code }) => code === 'INTERACTION_HANDLE_DISPOSE_FAILED',
      )).toHaveLength(1);
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
        argument === undefined ? true : { candidates: [rawCandidate], completeness: 'COMPLETE', domWorkUsed: 0 }
      ),
      evaluateHandle: async () => boundedResolutionEnvelope((await page.locator(INTERACTION_CANDIDATE_SELECTOR).nth(candidate.ordinal).elementHandle()) as never),
      locator: () => ({
        nth: () => ({
          elementHandle: async () => ({
            evaluate: async () => {
              handleEvaluations += 1;
              return { status: 'CONNECTED', domWorkUsed: 0, raw: rawCandidate };
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
      ...fakeCloseLifecycle(),
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
        argument === undefined ? true : { candidates: [rawCandidate()], completeness: 'COMPLETE', domWorkUsed: 0 }
      ),
      evaluateHandle: async () => boundedResolutionEnvelope((await page.locator(INTERACTION_CANDIDATE_SELECTOR).nth(candidate.ordinal).elementHandle()) as never),
      locator: () => ({
        nth: () => ({
          elementHandle: async () => ({
            evaluate: async () => {
              handleEvaluations += 1;
              return { status: 'CONNECTED', domWorkUsed: 0, raw: rawCandidate() };
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
      ...fakeCloseLifecycle(),
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
        argument === undefined ? true : { candidates: [rawCandidate], completeness: 'COMPLETE', domWorkUsed: 0 }
      ),
      evaluateHandle: async () => boundedResolutionEnvelope((await page.locator(INTERACTION_CANDIDATE_SELECTOR).nth(candidate.ordinal).elementHandle()) as never),
      locator: () => ({
        nth: () => ({
          elementHandle: async () => ({
            evaluate: async () => ({ status: 'CONNECTED', domWorkUsed: 0, raw: rawCandidate }),
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
      ...fakeCloseLifecycle(),
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
    await expect(session.activateInteractionFreeze()).rejects.toThrow(/invalid from FROZEN_ACTIVE/u);

    await expect.poll(() => session.page.isClosed()).toBe(true);
    expect(session.ledger.snapshot().invariantViolations).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'INTERACTION_FREEZE_ACTIVATION_FAILED' }),
    ]));
  });

  it('preserves structured work and non-terminal lifecycle when work and owner close fail', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    let closeCalls = 0;
    const page = {
      goto: async (): Promise<never> => { throw new Error('fixture work failed'); },
    } as unknown as Page;
    const session: InteractionGuardedSession & { readonly isClosed: () => boolean } = {
      page,
      ledger: new SafetyLedger(),
      activateInteractionFreeze: async () => undefined,
      isClosed: () => false,
      close: async (): Promise<never> => {
        closeCalls += 1;
        throw new Error('fixture close failed');
      },
    };

    const cleanupError = await expectOwnerCleanupError(auditInteraction({
      ...input('/accordion.html', candidate),
      sessionFactory: async () => session,
    }));

    expect(cleanupError.session).toBe(session);
    expect(cleanupError.work).toEqual({
      status: 'EXECUTION_FAILED',
      reason: 'fixture work failed',
      evidence: cleanupError.work.evidence,
    });
    expect(cleanupError.lifecycle).toEqual({ status: 'NON_TERMINAL', reason: 'fixture close failed' });
    expect(cleanupError.work.evidence.after).toBeNull();
    expect(closeCalls).toBe(2);
    expect(cleanupError.safety.invariantViolations).toContainEqual({
      code: 'INTERACTION_OWNER_CLOSE_FAILED',
      message: 'fixture close failed',
    });
    expect(cleanupError.safety.invariantViolations.filter(
      ({ code }) => code === 'INTERACTION_OWNER_CLOSE_FAILED',
    )).toHaveLength(2);
  });

  it('owner cleanup retry closes a real Factory Guard session before returning preserved work', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    let capturedSession: InteractionGuardedSession | undefined;
    let capturedContext: ReturnType<Page['context']> | undefined;
    let rawCloseCalls = 0;
    const firstFailure = new Error('first audit owner close failed');

    const result = await auditInteraction({
      ...input('/accordion.html', candidate),
      sessionFactory: async (sessionViewport) => {
        const session = await factory.createInteractionSession(sessionViewport);
        capturedSession = session;
        capturedContext = session.page.context();
        const rawClose = capturedContext.close.bind(capturedContext);
        vi.spyOn(capturedContext, 'close').mockImplementation(async () => {
          rawCloseCalls += 1;
          if (rawCloseCalls === 1) throw firstFailure;
          await rawClose();
        });
        return session;
      },
    });

    expect(capturedSession).toBeDefined();
    expect(capturedContext).toBeDefined();
    expect(rawCloseCalls).toBe(2);
    expect(capturedSession?.isClosed()).toBe(true);
    expect(result.status).toBe('BLOCKED_BY_SAFETY');
    expect(result.reason).toBe('Interaction owner close reported a safety failure');
    expect(result.work.status).toBe('VERIFIED');
    expect(result.work.reason).toBe('Observable interaction state changed');
    expect(result.lifecycle).toEqual({ status: 'CLOSED', reason: firstFailure.message });
    expect(result.evidence).toBe(result.work.evidence);
    await expect(factory.closePassiveContext(capturedContext!)).rejects.toThrow(/no longer active|not owned/i);
  });

  it('owner cleanup exhaustion transfers the exact real session for later terminal recovery', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    const firstFailure = new Error('first bounded cleanup failure');
    let capturedSession: InteractionGuardedSession | undefined;
    let capturedContext: ReturnType<Page['context']> | undefined;
    let rawCloseCalls = 0;

    const rejection = await auditInteraction({
      ...input('/accordion.html', candidate),
      sessionFactory: async (sessionViewport) => {
        const session = await factory.createInteractionSession(sessionViewport);
        capturedSession = session;
        capturedContext = session.page.context();
        const rawClose = capturedContext.close.bind(capturedContext);
        vi.spyOn(capturedContext, 'close').mockImplementation(async () => {
          rawCloseCalls += 1;
          if (rawCloseCalls === 1) throw firstFailure;
          if (rawCloseCalls === 2) return Promise.reject(undefined);
          await rawClose();
        });
        return session;
      },
    }).catch((error: unknown) => error);

    const cleanupError = rejection as {
      readonly name: string;
      readonly message: string;
      readonly session: InteractionGuardedSession;
      readonly candidateId: string;
      readonly work: ExpectedStructuredInteractionResult['work'];
      readonly lifecycle: { readonly status: 'NON_TERMINAL'; readonly reason: string };
      readonly safety: ReturnType<SafetyLedger['snapshot']>;
      readonly lastCloseRejected: boolean;
      readonly lastCloseError: unknown;
    };
    expect(cleanupError.name).toBe('InteractionOwnerCleanupError');
    expect(cleanupError.message).toBe('Interaction owner cleanup retry budget exhausted');
    expect(cleanupError.session).toBe(capturedSession);
    expect(cleanupError.candidateId).toBe(candidate.candidateId);
    expect(cleanupError.work.status).toBe('VERIFIED');
    expect(cleanupError.work.reason).toBe('Observable interaction state changed');
    expect(cleanupError.lifecycle).toEqual({ status: 'NON_TERMINAL', reason: 'undefined' });
    expect(cleanupError.lastCloseRejected).toBe(true);
    expect(Object.hasOwn(cleanupError, 'lastCloseError')).toBe(true);
    expect(cleanupError.lastCloseError).toBeUndefined();
    expect(cleanupError.safety.invariantViolations).toContainEqual({
      code: 'INTERACTION_OWNER_CLEANUP_RETRY_EXHAUSTED',
      message: 'Interaction owner cleanup retry budget exhausted',
    });
    expect(Object.isFrozen(cleanupError)).toBe(true);
    expect(Object.isFrozen(cleanupError.work)).toBe(true);
    expect(Object.isFrozen(cleanupError.lifecycle)).toBe(true);
    expect(Object.isFrozen(cleanupError.safety)).toBe(true);
    expect(rawCloseCalls).toBe(2);
    expect(capturedSession?.isClosed()).toBe(false);

    const module = await import('../../src/interaction/isolated-auditor.js');
    expect(module).toHaveProperty('InteractionOwnerCleanupError');
    await expect(cleanupError.session.close()).resolves.toBeUndefined();
    expect(rawCloseCalls).toBe(3);
    expect(cleanupError.session.isClosed()).toBe(true);
    await expect(factory.closePassiveContext(capturedContext!)).rejects.toThrow(/no longer active|not owned/i);
  });

  it('owner cleanup retries fulfilled non-terminal close and retains the anomaly after CLOSED', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    const ledger = new SafetyLedger();
    let closeCalls = 0;
    let closed = false;
    const session: InteractionGuardedSession = {
      page: { goto: async (): Promise<never> => { throw new Error('fulfilled retry work failed'); } } as unknown as Page,
      ledger,
      activateInteractionFreeze: async () => undefined,
      isClosed: () => closed,
      close: async () => {
        closeCalls += 1;
        if (closeCalls === 2) closed = true;
      },
    };

    const result = await auditInteraction({
      ...input('/accordion.html', candidate),
      sessionFactory: async () => session,
    });

    expect(closeCalls).toBe(2);
    expect(result.status).toBe('BLOCKED_BY_SAFETY');
    expect(result.reason).toBe('Interaction owner close reported a safety failure');
    expect(result.work).toEqual({
      status: 'EXECUTION_FAILED',
      reason: 'fulfilled retry work failed',
      evidence: result.evidence,
    });
    expect(result.lifecycle).toEqual({
      status: 'CLOSED',
      reason: 'Interaction owner close fulfilled without terminal Guard state',
    });
    expect(result.safety.invariantViolations).toContainEqual({
      code: 'INTERACTION_OWNER_CLOSE_NON_TERMINAL',
      message: 'Interaction owner close fulfilled without terminal Guard state',
    });
  });

  it('owner cleanup preserves an undefined rejection after automatic recovery', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    const ledger = new SafetyLedger();
    let closeCalls = 0;
    let closed = false;
    const session: InteractionGuardedSession = {
      page: { goto: async (): Promise<never> => { throw new Error('undefined retry work failed'); } } as unknown as Page,
      ledger,
      activateInteractionFreeze: async () => undefined,
      isClosed: () => closed,
      close: async () => {
        closeCalls += 1;
        if (closeCalls === 1) return Promise.reject(undefined);
        closed = true;
      },
    };

    const result = await auditInteraction({
      ...input('/accordion.html', candidate),
      sessionFactory: async () => session,
    });

    expect(closeCalls).toBe(2);
    expect(result.status).toBe('BLOCKED_BY_SAFETY');
    expect(result.work.reason).toBe('undefined retry work failed');
    expect(result.lifecycle).toEqual({ status: 'CLOSED', reason: 'undefined' });
    expect(result.safety.invariantViolations).toContainEqual({
      code: 'INTERACTION_OWNER_CLOSE_FAILED',
      message: 'undefined',
    });
  });

  it('preserves VERIFIED structured work under a rejected non-terminal lifecycle', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    const ownedSession = await factory.createInteractionSession(viewport);
    let closeCalls = 0;
    const session: InteractionGuardedSession & { readonly isClosed: () => boolean } = Object.freeze({
      ...ownedSession,
      isClosed: () => false,
      close: async (): Promise<never> => {
        closeCalls += 1;
        throw new Error('verified close failed');
      },
    });
    try {
      const cleanupError = await expectOwnerCleanupError(auditInteraction({
        ...input('/accordion.html', candidate),
        sessionFactory: async () => session,
      }));

      expect(cleanupError.work.status).toBe('VERIFIED');
      expect(cleanupError.work.reason).toBe('Observable interaction state changed');
      expect(cleanupError.work.evidence.changedFields).toEqual(expect.arrayContaining(['ariaExpanded', 'controlledVisible']));
      expect(cleanupError.lifecycle).toEqual({ status: 'NON_TERMINAL', reason: 'verified close failed' });
      expect(closeCalls).toBe(2);
    } finally {
      await ownedSession.close();
    }
  });

  it('records fulfilled without terminal Guard state as a non-terminal lifecycle invariant', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    let closeCalls = 0;
    const ledger = new SafetyLedger();
    const session: InteractionGuardedSession & { readonly isClosed: () => boolean } = {
      page: { goto: async (): Promise<never> => { throw new Error('fulfilled non-terminal work failed'); } } as unknown as Page,
      ledger,
      activateInteractionFreeze: async () => undefined,
      isClosed: () => false,
      close: async () => { closeCalls += 1; },
    };

    const cleanupError = await expectOwnerCleanupError(auditInteraction({
      ...input('/accordion.html', candidate),
      sessionFactory: async () => session,
    }));

    expect(cleanupError.work.status).toBe('EXECUTION_FAILED');
    expect(cleanupError.work.reason).toBe('fulfilled non-terminal work failed');
    expect(cleanupError.lifecycle).toEqual({
      status: 'NON_TERMINAL',
      reason: 'Interaction owner close fulfilled without terminal Guard state',
    });
    expect(closeCalls).toBe(2);
    expect(cleanupError.safety.invariantViolations).toContainEqual({
      code: 'INTERACTION_OWNER_CLOSE_NON_TERMINAL',
      message: 'Interaction owner close fulfilled without terminal Guard state',
    });
  });

  it.each(['INVALIDATING', 'CLOSED'] as const)(
    'returns terminal invalidation structured work and CLOSED lifecycle when the audit joins during %s',
    async (joinTiming) => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');
      const rawCloseGate = createDeferred<void>();
      let rawCloseCalls = 0;
      let contextCleanupCalls = 0;
      const sessionFactory = async (sessionViewport: Viewport): Promise<InteractionGuardedSession> => {
        const session = await factory.createInteractionSession(sessionViewport);
        const context = session.page.context();
        const rawContextClose = context.close.bind(context);
        const rawContextOff = context.off.bind(context);
        vi.spyOn(context, 'close').mockImplementation(async () => {
          rawCloseCalls += 1;
          await rawCloseGate.promise;
          await rawContextClose();
        });
        vi.spyOn(context, 'off').mockImplementation((event, listener) => {
          contextCleanupCalls += 1;
          if (contextCleanupCalls === 1) {
            throw new Error(`late ${joinTiming} listener cleanup evidence`);
          }
          return rawContextOff(event, listener);
        });
        return Object.freeze({
          ...session,
          async close(): Promise<void> {
            await session.page.close();
            await expect.poll(() => rawCloseCalls).toBe(1);
            if (joinTiming === 'INVALIDATING') {
              const joining = session.close();
              rawCloseGate.resolve(undefined);
              await joining;
              return;
            }
            rawCloseGate.resolve(undefined);
            await expect.poll(() => contextCleanupCalls).toBe(2);
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            await session.close();
          },
        });
      };

      const result = await auditInteraction({
        ...input('/accordion.html', candidate),
        sessionFactory,
      });

      expect(result.status).toBe('BLOCKED_BY_SAFETY');
      expect(result.reason).toBe('Interaction owner close reported a safety failure');
      expect(expectedStructuredResult(result).work.status).toBe('VERIFIED');
      expect(expectedStructuredResult(result).work.reason).toBe('Observable interaction state changed');
      expect(expectedStructuredResult(result).lifecycle).toEqual({
        status: 'CLOSED',
        reason: 'Passive request guard context was invalidated',
      });
      expect(result.evidence).toBe(expectedStructuredResult(result).work.evidence);
      expect(result.evidence.identityStatus).toBe('MATCHED');
      expect(result.evidence.changedFields).toEqual(expect.arrayContaining(['ariaExpanded', 'controlledVisible']));
      expect(result.safety.invariantViolations).toEqual(expect.arrayContaining([
        {
          code: 'CDP_SESSION_DETACHED',
          message: 'Document interception session detached while its page remained active',
        },
        {
          code: 'GUARD_LISTENER_CLEANUP_FAILED',
          message: `late ${joinTiming} listener cleanup evidence`,
        },
        {
          code: 'INTERACTION_OWNER_CLOSE_FAILED',
          message: 'Passive request guard context was invalidated',
        },
      ]));
      expect(rawCloseCalls).toBe(1);
      expect(contextCleanupCalls).toBe(2);
    },
  );

  async function auditWithLifecyclePriority(order: 'CLOSE_FIRST' | 'INVALIDATE_FIRST') {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    const rawCloseGate = createDeferred<void>();
    let rawCloseCalls = 0;
    const sessionFactory = async (sessionViewport: Viewport): Promise<InteractionGuardedSession> => {
      const session = await factory.createInteractionSession(sessionViewport);
      const context = session.page.context();
      const rawContextClose = context.close.bind(context);
      vi.spyOn(context, 'close').mockImplementation(async () => {
        rawCloseCalls += 1;
        await rawCloseGate.promise;
        await rawContextClose();
      });
      const invalidate = (): void => {
        // frameが分類できないPlaywrightのリクエスト失敗は、freezeイベントを追加することなく
        // インストール済みの実際のguardを通して無効化されなければならない。
        const emitter = context as unknown as { emit(event: string, value: unknown): boolean };
        emitter.emit('requestfailed', {
          isNavigationRequest: () => true,
          frame: () => { throw new Error('lifecycle priority frame classification failed'); },
        });
      };
      return Object.freeze({
        ...session,
        async close(): Promise<void> {
          if (order === 'INVALIDATE_FIRST') invalidate();
          // raw-closeの境界がゲートされている間に、拒否を即座に観測する。
          const closing = session.close().then(
            () => ({ failed: false as const }),
            (error: unknown) => ({ failed: true as const, error }),
          );
          await expect.poll(() => rawCloseCalls).toBe(1);
          if (order === 'CLOSE_FIRST') invalidate();
          rawCloseGate.resolve(undefined);
          const outcome = await closing;
          if (outcome.failed) throw outcome.error;
        },
      });
    };
    const result = await auditInteraction({ ...input('/accordion.html', candidate), sessionFactory });
    return { result, rawCloseCalls };
  }

  it('lifecycle priority rejects the mutation that drops invalidation during close after VERIFIED work', async () => {
    const { result, rawCloseCalls } = await auditWithLifecyclePriority('CLOSE_FIRST');

    expect(result.status).toBe('BLOCKED_BY_SAFETY');
    expect(result.reason).toBe('Interaction owner close reported a safety failure');
    expect(expectedStructuredResult(result).work.status).toBe('VERIFIED');
    expect(expectedStructuredResult(result).work.reason).toBe('Observable interaction state changed');
    expect(expectedStructuredResult(result).lifecycle).toEqual({
      status: 'CLOSED',
      reason: 'Passive request guard context was invalidated',
    });
    expect(result.evidence.identityStatus).toBe('MATCHED');
    expect(result.evidence.changedFields).toEqual(expect.arrayContaining(['ariaExpanded', 'controlledVisible']));
    expect(result.safety.invariantViolations).toEqual(expect.arrayContaining([
      { code: 'FRAME_CLASSIFICATION_FAILED', message: 'lifecycle priority frame classification failed' },
      { code: 'INTERACTION_OWNER_CLOSE_FAILED', message: 'Passive request guard context was invalidated' },
    ]));
    expect(result.safety.blockedInteractionRequests).toEqual([]);
    expect(Object.isFrozen(result.safety.invariantViolations)).toBe(true);
    expect(rawCloseCalls).toBe(1);
  });

  it('lifecycle priority rejects the mutation that lets normal close win only when it starts first', async () => {
    const invalidationFirst = await auditWithLifecyclePriority('INVALIDATE_FIRST');
    const closeFirst = await auditWithLifecyclePriority('CLOSE_FIRST');

    expect(closeFirst.result.status).toBe(invalidationFirst.result.status);
    expect([invalidationFirst.result.status, closeFirst.result.status]).toEqual([
      'BLOCKED_BY_SAFETY', 'BLOCKED_BY_SAFETY',
    ]);
    expect([invalidationFirst.rawCloseCalls, closeFirst.rawCloseCalls]).toEqual([1, 1]);
    expect(closeFirst.result.safety).toEqual(invalidationFirst.result.safety);
    expect(closeFirst.result.evidence.changedFields).toEqual(invalidationFirst.result.evidence.changedFields);
  });

  it.each([false, true] as const)(
    'preserves undefined close rejection presence for terminal=%s',
    async (terminal) => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    let closeCalls = 0;
    const ledger = new SafetyLedger();
    const page = {
      goto: async (): Promise<never> => { throw new Error('undefined-close work failed'); },
    } as unknown as Page;
    let closed = false;
    const session: InteractionGuardedSession & { readonly isClosed: () => boolean } = {
      page,
      ledger,
      activateInteractionFreeze: async () => undefined,
      isClosed: () => closed,
      close: async (): Promise<never> => {
        closeCalls += 1;
        closed = terminal;
        return Promise.reject(undefined);
      },
    };

    const completion = auditInteraction({
      ...input('/accordion.html', candidate),
      sessionFactory: async () => session,
    });
    if (terminal) {
      const result = await completion;
      expect(result.status).toBe('BLOCKED_BY_SAFETY');
      expect(result.reason).toBe('Interaction owner close reported a safety failure');
      expect(result.work.status).toBe('EXECUTION_FAILED');
      expect(result.work.reason).toBe('undefined-close work failed');
      expect(result.lifecycle).toEqual({ status: 'CLOSED', reason: 'undefined' });
      expect(result.evidence).toBe(result.work.evidence);
      expect(closeCalls).toBe(1);
      expect(result.safety.invariantViolations).toEqual([{
        code: 'INTERACTION_OWNER_CLOSE_FAILED',
        message: 'undefined',
      }]);
    } else {
      const cleanupError = await expectOwnerCleanupError(completion);
      expect(cleanupError.work.status).toBe('EXECUTION_FAILED');
      expect(cleanupError.work.reason).toBe('undefined-close work failed');
      expect(cleanupError.lifecycle).toEqual({ status: 'NON_TERMINAL', reason: 'undefined' });
      expect(cleanupError.work.evidence.before?.candidateId).toBe(candidate.candidateId);
      expect(cleanupError.work.evidence.after).toBeNull();
      expect(cleanupError.lastCloseRejected).toBe(true);
      expect(Object.hasOwn(cleanupError, 'lastCloseError')).toBe(true);
      expect(cleanupError.lastCloseError).toBeUndefined();
      expect(closeCalls).toBe(2);
      expect(cleanupError.safety.invariantViolations.filter(
        ({ code }) => code === 'INTERACTION_OWNER_CLOSE_FAILED',
      )).toHaveLength(2);
    }
    },
  );

  it('normalizes a hostile work rejection and still closes exactly once', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    let closeCalls = 0;
    const hostileWorkError = new Proxy(Object.create(null) as object, {
      getPrototypeOf(): never {
        throw new Error('hostile instanceof trap');
      },
    });
    const page = {
      goto: async (): Promise<never> => { throw hostileWorkError; },
    } as unknown as Page;
    const session: InteractionGuardedSession = {
      page,
      ledger: new SafetyLedger(),
      activateInteractionFreeze: async () => undefined,
      ...fakeCloseLifecycle(async () => { closeCalls += 1; }),
    };

    const result = await auditInteraction({
      ...input('/accordion.html', candidate),
      sessionFactory: async () => session,
    });

    expect(result.status).toBe('EXECUTION_FAILED');
    expect(result.reason).toBe('Interaction error could not be safely normalized');
    expect(result.evidence.before?.candidateId).toBe(candidate.candidateId);
    expect(result.evidence.after).toBeNull();
    expect(closeCalls).toBe(1);
    expect(result.safety.invariantViolations).toEqual([]);
  });

  it('preserves a deadline result when hostile handle dispose rejection normalization fails', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    let closeCalls = 0;
    let disposeCalls = 0;
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
    const hostileDisposeError = new Proxy(new Error('hidden dispose failure'), {
      get(target, property) {
        if (property === 'message') {
          throw new Error('hostile message getter');
        }
        return Reflect.get(target, property, target) as unknown;
      },
    });
    const page = {
      goto: async () => undefined,
      evaluate: async (_callback: unknown, argument?: unknown) => (
        argument === undefined ? true : { candidates: [rawCandidate], completeness: 'COMPLETE', domWorkUsed: 0 }
      ),
      evaluateHandle: async () => boundedResolutionEnvelope((await page.locator(INTERACTION_CANDIDATE_SELECTOR).nth(candidate.ordinal).elementHandle()) as never),
      locator: () => ({
        nth: () => ({
          elementHandle: async () => {
            vi.setSystemTime(3_000);
            return {
              evaluate: async () => ({ status: 'CONNECTED', domWorkUsed: 0, raw: rawCandidate }),
              click: async () => undefined,
              dispose: async (): Promise<never> => {
                disposeCalls += 1;
                throw hostileDisposeError;
              },
            };
          },
        }),
      }),
    } as unknown as Page;
    const ledger = new SafetyLedger();
    const session: InteractionGuardedSession = {
      page,
      ledger,
      activateInteractionFreeze: async () => undefined,
      ...fakeCloseLifecycle(async () => { closeCalls += 1; }),
    };

    try {
      const result = await auditInteraction({
        ...input('/accordion.html', candidate),
        timeoutMs: 2_000,
        deadlineAtMs: 10_000,
        sessionFactory: async () => session,
      });

      expect(result.status).toBe('NOT_VERIFIABLE');
      expect(result.reason).toBe('Interaction deadline expired during target handle acquisition');
      expect(result.evidence.after).toBeNull();
      expect(disposeCalls).toBe(1);
      expect(closeCalls).toBe(1);
      expect(result.safety.invariantViolations).toEqual([{
        code: 'INTERACTION_HANDLE_DISPOSE_FAILED',
        message: 'Interaction error could not be safely normalized',
      }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('normalizes a hostile owner close rejection into a safety result', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    let closeCalls = 0;
    const hostileCloseError = {
      [Symbol.toPrimitive](): never {
        throw new Error('hostile coercion trap');
      },
    };
    const ledger = new SafetyLedger();
    const page = {
      goto: async (): Promise<never> => { throw new Error('hostile-close work failed'); },
    } as unknown as Page;
    const session: InteractionGuardedSession = {
      page,
      ledger,
      activateInteractionFreeze: async () => undefined,
      ...fakeCloseLifecycle(async (): Promise<never> => {
        closeCalls += 1;
        throw hostileCloseError;
      }),
    };

    const cleanupError = await expectOwnerCleanupError(auditInteraction({
      ...input('/accordion.html', candidate),
      sessionFactory: async () => session,
    }));

    expect(cleanupError.work.status).toBe('EXECUTION_FAILED');
    expect(cleanupError.work.reason).toBe('hostile-close work failed');
    expect(cleanupError.lifecycle).toEqual({
      status: 'NON_TERMINAL',
      reason: 'Interaction error could not be safely normalized',
    });
    expect(cleanupError.work.evidence.before?.candidateId).toBe(candidate.candidateId);
    expect(closeCalls).toBe(2);
    expect(cleanupError.safety.invariantViolations.filter(
      ({ code }) => code === 'INTERACTION_OWNER_CLOSE_FAILED',
    )).toHaveLength(2);
  });

  it('preserves changed evidence when click failure and owner close both fail', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    let expanded = false;
    let closeCalls = 0;
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
        argument === undefined ? true : { candidates: [rawCandidate()], completeness: 'COMPLETE', domWorkUsed: 0 }
      ),
      evaluateHandle: async () => boundedResolutionEnvelope((await page.locator(INTERACTION_CANDIDATE_SELECTOR).nth(candidate.ordinal).elementHandle()) as never),
      locator: () => ({
        nth: () => ({
          elementHandle: async () => ({
            evaluate: async () => ({ status: 'CONNECTED', domWorkUsed: 0, raw: rawCandidate() }),
            click: async () => {
              expanded = true;
              throw new Error('original click failure');
            },
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
      ...fakeCloseLifecycle(async (): Promise<never> => {
        closeCalls += 1;
        throw new Error('fixture close failed');
      }),
    };

    const cleanupError = await expectOwnerCleanupError(auditInteraction({
      ...input('/accordion.html', candidate),
      sessionFactory: async () => session,
    }));

    expect(cleanupError.work.status).toBe('EXECUTION_FAILED');
    expect(cleanupError.work.reason).toBe('original click failure');
    expect(cleanupError.lifecycle).toEqual({
      status: 'NON_TERMINAL',
      reason: 'fixture close failed',
    });
    expect(cleanupError.work.evidence.changedFields).toContain('ariaExpanded');
    expect(closeCalls).toBe(2);
    expect(cleanupError.safety.invariantViolations).toContainEqual({
      code: 'INTERACTION_OWNER_CLOSE_FAILED',
      message: 'fixture close failed',
    });
    expect(cleanupError.safety.invariantViolations.filter(
      ({ code }) => code === 'INTERACTION_OWNER_CLOSE_FAILED',
    )).toHaveLength(2);
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
        argument === undefined ? true : { candidates: [rawCandidate()], completeness: 'COMPLETE', domWorkUsed: 0 }
      ),
      evaluateHandle: async () => boundedResolutionEnvelope((await page.locator(INTERACTION_CANDIDATE_SELECTOR).nth(candidate.ordinal).elementHandle()) as never),
      locator: () => ({
        nth: () => ({
          elementHandle: async () => ({
            evaluate: async () => ({ status: 'CONNECTED', domWorkUsed: 0, raw: rawCandidate() }),
            click: async () => { expanded = true; },
            dispose: async () => undefined,
          }),
        }),
      }),
    } as unknown as Page;
    const ledger = new SafetyLedger();
    let closed = false;
    const session: InteractionGuardedSession & { readonly isClosed: () => boolean } = {
      page,
      ledger,
      activateInteractionFreeze: async () => undefined,
      isClosed: () => closed,
      close: async () => {
        ledger.recordBlockedInteractionRequest({
          method: 'GET',
          url: `${server.origin}/late`,
          reason: 'INTERACTION_FROZEN',
        });
        closed = true;
      },
    };

    const result = await auditInteraction({
      ...input('/accordion.html', candidate),
      sessionFactory: async () => session,
    });

    expect(result.status).toBe('BLOCKED_BY_SAFETY');
    expect(result.reason).toBe('Interaction activity was blocked by safety freeze');
    expect(expectedStructuredResult(result).work.status).toBe('VERIFIED');
    expect(expectedStructuredResult(result).lifecycle).toEqual({ status: 'CLOSED', reason: null });
    expect(result.evidence.changedFields).toContain('ariaExpanded');
    expect(result.safety.blockedInteractionRequests).toHaveLength(1);
  });

  it('lets freeze evidence outrank an owner close rejection', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    let expanded = false;
    let closeCalls = 0;
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
        argument === undefined ? true : { candidates: [rawCandidate()], completeness: 'COMPLETE', domWorkUsed: 0 }
      ),
      evaluateHandle: async () => boundedResolutionEnvelope((await page.locator(INTERACTION_CANDIDATE_SELECTOR).nth(candidate.ordinal).elementHandle()) as never),
      locator: () => ({
        nth: () => ({
          elementHandle: async () => ({
            evaluate: async () => ({ status: 'CONNECTED', domWorkUsed: 0, raw: rawCandidate() }),
            click: async () => { expanded = true; },
            dispose: async () => undefined,
          }),
        }),
      }),
    } as unknown as Page;
    const ledger = new SafetyLedger();
    const session: InteractionGuardedSession & { readonly isClosed: () => boolean } = {
      page,
      ledger,
      activateInteractionFreeze: async () => undefined,
      isClosed: () => false,
      close: async (): Promise<never> => {
        closeCalls += 1;
        ledger.recordBlockedInteractionRequest({
          method: 'GET',
          url: `${server.origin}/late-before-close-rejection`,
          reason: 'INTERACTION_FROZEN',
        });
        throw new Error('freeze owner close failed');
      },
    };

    const cleanupError = await expectOwnerCleanupError(auditInteraction({
      ...input('/accordion.html', candidate),
      sessionFactory: async () => session,
    }));

    expect(cleanupError.work.status).toBe('VERIFIED');
    expect(cleanupError.lifecycle).toEqual({ status: 'NON_TERMINAL', reason: 'freeze owner close failed' });
    expect(cleanupError.work.evidence.changedFields).toContain('ariaExpanded');
    expect(closeCalls).toBe(2);
    expect(cleanupError.safety.blockedInteractionRequests).toHaveLength(2);
    expect(cleanupError.safety.invariantViolations.filter(
      ({ code }) => code === 'INTERACTION_OWNER_CLOSE_FAILED',
    )).toHaveLength(2);
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
    expect(result.reason).toBe('Interaction activity was blocked by safety freeze');
    expect(expectedStructuredResult(result).work.status).toBe('REJECTED_UNSAFE');
    expect(expectedStructuredResult(result).lifecycle).toEqual({ status: 'CLOSED', reason: null });
    expect(result.evidence.identityStatus).toBe('MATCHED');
    expect(result.safety.blockedInteractionRequests).toHaveLength(1);
  });

  it('preserves click-failure status, reason, and observed evidence when handle disposal fails', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    let expanded = false;
    let disposeCalls = 0;
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
        argument === undefined ? true : { candidates: [rawCandidate()], completeness: 'COMPLETE', domWorkUsed: 0 }
      ),
      evaluateHandle: async () => boundedResolutionEnvelope((await page.locator(INTERACTION_CANDIDATE_SELECTOR).nth(candidate.ordinal).elementHandle()) as never),
      locator: () => ({
        nth: () => ({
          elementHandle: async () => ({
            evaluate: async () => ({ status: 'CONNECTED', domWorkUsed: 0, raw: rawCandidate() }),
            click: async () => {
              expanded = true;
              throw new Error('original click failure');
            },
            dispose: async (): Promise<never> => {
              disposeCalls += 1;
              throw new Error('handle dispose failure');
            },
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
        ...fakeCloseLifecycle(),
      }),
    });

    expect(result.status).toBe('EXECUTION_FAILED');
    expect(result.reason).toBe('original click failure');
    expect(result.evidence.changedFields).toContain('ariaExpanded');
    expect(disposeCalls).toBe(1);
    expect(result.safety.invariantViolations).toContainEqual({
      code: 'INTERACTION_HANDLE_DISPOSE_FAILED',
      message: 'handle dispose failure',
    });
    expect(result.safety.invariantViolations.filter(
      ({ code }) => code === 'INTERACTION_HANDLE_DISPOSE_FAILED',
    )).toHaveLength(1);
  });

  it('preserves safety status and observed evidence when handle disposal fails', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    const ledger = new SafetyLedger();
    let expanded = false;
    let disposeCalls = 0;
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
        argument === undefined ? true : { candidates: [rawCandidate()], completeness: 'COMPLETE', domWorkUsed: 0 }
      ),
      evaluateHandle: async () => boundedResolutionEnvelope((await page.locator(INTERACTION_CANDIDATE_SELECTOR).nth(candidate.ordinal).elementHandle()) as never),
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
              return { status: 'CONNECTED', domWorkUsed: 0, raw: rawCandidate() };
            },
            click: async () => { expanded = true; },
            dispose: async (): Promise<never> => {
              disposeCalls += 1;
              throw new Error('safety handle dispose failure');
            },
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
        ...fakeCloseLifecycle(),
      }),
    });

    expect(result.status).toBe('BLOCKED_BY_SAFETY');
    expect(result.reason).toBe('Interaction activity was blocked by safety freeze');
    expect(result.evidence.changedFields).toContain('ariaExpanded');
    expect(disposeCalls).toBe(1);
    expect(result.safety.invariantViolations).toContainEqual({
      code: 'INTERACTION_HANDLE_DISPOSE_FAILED',
      message: 'safety handle dispose failure',
    });
    expect(result.safety.invariantViolations.filter(
      ({ code }) => code === 'INTERACTION_HANDLE_DISPOSE_FAILED',
    )).toHaveLength(1);
  });

  it('preserves a work error and separately ledgers disposal failure when no outcome exists', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    const ledger = new SafetyLedger();
    let disposeCalls = 0;
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
        argument === undefined ? true : { candidates: [rawCandidate], completeness: 'COMPLETE', domWorkUsed: 0 }
      ),
      evaluateHandle: async () => boundedResolutionEnvelope((await page.locator(INTERACTION_CANDIDATE_SELECTOR).nth(candidate.ordinal).elementHandle()) as never),
      locator: () => ({
        nth: () => ({
          elementHandle: async () => ({
            evaluate: async () => {
              handleEvaluations += 1;
              if (handleEvaluations === 2) {
                throw new Error('original observation failure');
              }
              return { status: 'CONNECTED', domWorkUsed: 0, raw: rawCandidate };
            },
            click: async () => undefined,
            dispose: async (): Promise<never> => {
              disposeCalls += 1;
              throw new Error('observation handle dispose failure');
            },
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
        ...fakeCloseLifecycle(),
      }),
    });

    expect(result.status).toBe('EXECUTION_FAILED');
    expect(result.reason).toBe('original observation failure');
    expect(disposeCalls).toBe(1);
    expect(result.safety.invariantViolations).toContainEqual({
      code: 'INTERACTION_HANDLE_DISPOSE_FAILED',
      message: 'observation handle dispose failure',
    });
    expect(result.safety.invariantViolations.filter(
      ({ code }) => code === 'INTERACTION_HANDLE_DISPOSE_FAILED',
    )).toHaveLength(1);
  });

  describe('Task 11 cleanup deadline and interaction-wide DOM budget', () => {
    type CleanupDiagnostic = {
      readonly kind: 'DEADLINE_EXCEEDED' | 'ATTEMPT_BUDGET_EXHAUSTED';
      readonly attemptsStarted: number;
      readonly deadlineAtMs: number;
      readonly deadlineReached: boolean;
      readonly anomaly: 'TIMED_OUT' | 'REJECTED' | 'FULFILLED_NON_TERMINAL';
      readonly lastCloseRejected: boolean;
      readonly lastCloseError: unknown;
    };

    const withCleanup = (error: InteractionOwnerCleanupError): InteractionOwnerCleanupError & {
      readonly cleanup: CleanupDiagnostic;
    } => error as InteractionOwnerCleanupError & { readonly cleanup: CleanupDiagnostic };

    const resolutionEnvelopeWithWork = (handle: unknown, domWorkUsed: number) => {
      const property = (value: unknown) => ({
        jsonValue: async () => value,
        dispose: async () => undefined,
        asElement: () => value === handle ? handle : null,
      });
      return {
        getProperties: async () => new Map([
          ['status', property('FOUND')],
          ['domWorkUsed', property(domWorkUsed)],
          ['element', property(handle)],
        ]),
        dispose: async () => undefined,
      };
    };

    it('bounds a never-settling real Guard close by one cleanup deadline and one raw close owner', async () => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');
      const rawCloseGate = createDeferred<void>();
      const unhandled: unknown[] = [];
      const observeUnhandled = (reason: unknown) => { unhandled.push(reason); };
      process.on('unhandledRejection', observeUnhandled);
      let capturedSession: InteractionGuardedSession | undefined;
      let rawCloseCalls = 0;
      let auditCloseCalls = 0;
      const startedAt = Date.now();
      let completion: Promise<Awaited<ReturnType<typeof auditInteraction>>> | undefined;
      try {
        completion = auditInteraction({
          ...input('/accordion.html', candidate),
          timeoutMs: 80,
          sessionFactory: async (sessionViewport) => {
            const owned = await factory.createInteractionSession(sessionViewport);
            const context = owned.page.context();
            const rawClose = context.close.bind(context);
            vi.spyOn(context, 'close').mockImplementation(async () => {
              rawCloseCalls += 1;
              await rawCloseGate.promise;
              await rawClose();
            });
            const session: InteractionGuardedSession = Object.freeze({
              ...owned,
              page: { goto: async (): Promise<never> => { throw new Error('deadline fixture work'); } } as unknown as Page,
              close: async () => {
                auditCloseCalls += 1;
                await owned.close();
              },
            });
            capturedSession = session;
            return session;
          },
        });
        const observed = await Promise.race([
          completion.catch((error: unknown) => error),
          new Promise<'STILL_PENDING'>((resolve) => setTimeout(() => resolve('STILL_PENDING'), 240)),
        ]);
        expect(observed).toBeInstanceOf(InteractionOwnerCleanupError);
        const cleanupError = withCleanup(observed as InteractionOwnerCleanupError);
        expect(cleanupError.session).toBe(capturedSession);
        expect(cleanupError.cleanup).toMatchObject({
          kind: 'DEADLINE_EXCEEDED',
          attemptsStarted: 2,
          deadlineReached: true,
          anomaly: 'TIMED_OUT',
          lastCloseRejected: false,
        });
        expect(Object.isFrozen(cleanupError.cleanup)).toBe(true);
        expect(cleanupError.cleanup.deadlineAtMs).toBeGreaterThanOrEqual(startedAt + 80);
        expect(Date.now() - startedAt).toBeLessThan(240);
        expect(auditCloseCalls).toBe(2);
        expect(rawCloseCalls).toBe(1);
        expect(cleanupError.safety.invariantViolations).toContainEqual(expect.objectContaining({
          code: 'INTERACTION_OWNER_CLEANUP_DEADLINE_EXCEEDED',
        }));
      } finally {
        rawCloseGate.resolve();
        await completion?.catch(() => undefined);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        process.off('unhandledRejection', observeUnhandled);
      }
      expect(unhandled).toEqual([]);
    });

    it('rechecks terminal Guard truth after the timeout macrotask yield before a second close call', async () => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');
      const closeGate = createDeferred<void>();
      let closeCalls = 0;
      let closed = false;
      let terminalTransitionScheduled = false;
      const session: InteractionGuardedSession = {
        page: { goto: async (): Promise<never> => { throw new Error('timeout yield work'); } } as unknown as Page,
        ledger: new SafetyLedger(),
        activateInteractionFreeze: async () => undefined,
        close: async () => {
          closeCalls += 1;
          await closeGate.promise;
        },
        isClosed: () => {
          if (!closed && !terminalTransitionScheduled) {
            terminalTransitionScheduled = true;
            setTimeout(() => { closed = true; }, 0);
          }
          return closed;
        },
      };
      let completion: Promise<Awaited<ReturnType<typeof auditInteraction>>> | undefined;
      try {
        completion = auditInteraction({
          ...input('/accordion.html', candidate),
          timeoutMs: 60,
          sessionFactory: async () => session,
        });
        const observed = await Promise.race([
          completion,
          new Promise<'STILL_PENDING'>((resolve) => setTimeout(() => resolve('STILL_PENDING'), 180)),
        ]);
        expect(observed).not.toBe('STILL_PENDING');
        expect(closeCalls).toBe(1);
        expect((observed as Awaited<ReturnType<typeof auditInteraction>>).lifecycle).toEqual({
          status: 'CLOSED',
          reason: 'Interaction owner close timed out before terminal Guard state',
        });
      } finally {
        closed = true;
        closeGate.resolve();
        await completion?.catch(() => undefined);
      }
    });

    it('yields a macrotask after rejected non-terminal close so delayed terminal settlement suppresses retry', async () => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');
      let closeCalls = 0;
      let closed = false;
      let transitionScheduled = false;
      const session: InteractionGuardedSession = {
        page: { goto: async (): Promise<never> => { throw new Error('rejected yield work'); } } as unknown as Page,
        ledger: new SafetyLedger(),
        activateInteractionFreeze: async () => undefined,
        close: async (): Promise<never> => {
          closeCalls += 1;
          throw new Error('rejected before yield');
        },
        isClosed: () => {
          if (!closed && !transitionScheduled) {
            transitionScheduled = true;
            setTimeout(() => { closed = true; }, 0);
          }
          return closed;
        },
      };

      const result = await auditInteraction({
        ...input('/accordion.html', candidate),
        timeoutMs: 200,
        sessionFactory: async () => session,
      });

      expect(closeCalls).toBe(1);
      expect(result.status).toBe('BLOCKED_BY_SAFETY');
      expect(result.lifecycle).toEqual({ status: 'CLOSED', reason: 'rejected before yield' });
    });

    it('contains an undefined rejection observed after first-half timeout and exposes it in cleanup diagnostics', async () => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');
      let rejectClose!: (reason?: unknown) => void;
      const closePromise = new Promise<void>((_resolve, reject) => { rejectClose = reject; });
      let closeCalls = 0;
      const session: InteractionGuardedSession = {
        page: { goto: async (): Promise<never> => { throw new Error('late rejection work'); } } as unknown as Page,
        ledger: new SafetyLedger(),
        activateInteractionFreeze: async () => undefined,
        close: () => {
          closeCalls += 1;
          return closePromise;
        },
        isClosed: () => false,
      };
      setTimeout(() => rejectClose(undefined), 60);

      const cleanupError = withCleanup(await expectOwnerCleanupError(auditInteraction({
        ...input('/accordion.html', candidate),
        timeoutMs: 100,
        sessionFactory: async () => session,
      })));

      expect(closeCalls).toBe(2);
      expect(cleanupError.cleanup).toMatchObject({
        kind: 'ATTEMPT_BUDGET_EXHAUSTED',
        attemptsStarted: 2,
        deadlineReached: false,
        anomaly: 'REJECTED',
        lastCloseRejected: true,
      });
      expect(Object.hasOwn(cleanupError.cleanup, 'lastCloseError')).toBe(true);
      expect(cleanupError.cleanup.lastCloseError).toBeUndefined();
      expect(cleanupError.lastCloseRejected).toBe(true);
      expect(cleanupError.lastCloseError).toBeUndefined();
    });

    it('shares one DOM-work remainder across discovery resolution and inspection before click', async () => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');
      const rawCandidate = rawCandidateFor(candidate);
      const observedLimits: number[] = [];
      let disposeCalls = 0;
      let clickCalls = 0;
      const targetHandle = {
        evaluate: async (_callback: unknown, argument: { readonly limits: { readonly maxDomWork: number } }) => {
          observedLimits.push(argument.limits.maxDomWork);
          return { status: 'CONNECTED', domWorkUsed: 3_384, raw: rawCandidate };
        },
        click: async () => { clickCalls += 1; },
        dispose: async () => { disposeCalls += 1; },
      };
      const page = {
        goto: async () => undefined,
        evaluate: async (_callback: unknown, argument?: { readonly limits: { readonly maxDomWork: number } }) => {
          if (argument === undefined) return true;
          observedLimits.push(argument.limits.maxDomWork);
          return { candidates: [rawCandidate], completeness: 'COMPLETE', domWorkUsed: 8_000 };
        },
        evaluateHandle: async (_callback: unknown, argument: { readonly limits: { readonly maxDomWork: number } }) => {
          observedLimits.push(argument.limits.maxDomWork);
          return resolutionEnvelopeWithWork(targetHandle, 5_000);
        },
      } as unknown as Page;

      const result = await auditInteraction({
        ...input('/accordion.html', candidate),
        sessionFactory: async () => ({
          page,
          ledger: new SafetyLedger(),
          activateInteractionFreeze: async () => undefined,
          ...fakeCloseLifecycle(),
        }),
      });

      expect(observedLimits).toEqual([16_384, 8_384, 3_384]);
      expect(observedLimits[0]! - observedLimits[1]!
        + observedLimits[1]! - observedLimits[2]!
        + observedLimits[2]!).toBe(16_384);
      expect(result.status).toBe('NOT_VERIFIABLE');
      expect(result.reason).toBe('Interaction-wide DOM work budget exhausted');
      expect(clickCalls).toBe(0);
      expect(disposeCalls).toBe(1);
    });

    it('shares the remaining DOM budget across repeated observation and disconnected fallback rediscovery', async () => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');
      const rawCandidate = rawCandidateFor(candidate);
      const observedLimits: number[] = [];
      const snapshots = [
        { status: 'CONNECTED', domWorkUsed: 10, raw: rawCandidate },
        { status: 'CONNECTED', domWorkUsed: 8_000, raw: rawCandidate },
        { status: 'DISCONNECTED', domWorkUsed: 100 },
      ];
      let snapshotIndex = 0;
      let discoveryIndex = 0;
      const targetHandle = {
        evaluate: async (_callback: unknown, argument: { readonly limits: { readonly maxDomWork: number } }) => {
          observedLimits.push(argument.limits.maxDomWork);
          return snapshots[snapshotIndex++];
        },
        click: async () => undefined,
        dispose: async () => undefined,
      };
      const page = {
        goto: async () => undefined,
        evaluate: async (_callback: unknown, argument?: { readonly limits: { readonly maxDomWork: number } }) => {
          if (argument === undefined) return true;
          observedLimits.push(argument.limits.maxDomWork);
          discoveryIndex += 1;
          return discoveryIndex === 1
            ? { candidates: [rawCandidate], completeness: 'COMPLETE', domWorkUsed: 10 }
            : { candidates: [], completeness: 'DOM_WORK_BUDGET_REACHED', domWorkUsed: 8_254 };
        },
        evaluateHandle: async (_callback: unknown, argument: { readonly limits: { readonly maxDomWork: number } }) => {
          observedLimits.push(argument.limits.maxDomWork);
          return resolutionEnvelopeWithWork(targetHandle, 10);
        },
      } as unknown as Page;

      const result = await auditInteraction({
        ...input('/accordion.html', candidate),
        sessionFactory: async () => ({
          page,
          ledger: new SafetyLedger(),
          activateInteractionFreeze: async () => undefined,
          ...fakeCloseLifecycle(),
        }),
      });

      expect(observedLimits).toEqual([16_384, 16_374, 16_364, 16_354, 8_354, 8_254]);
      expect(result.status).toBe('NOT_VERIFIABLE');
      expect(result.reason).toBe('Interaction-wide DOM work budget exhausted');
    });

    it('disposes the exact retained handle once when resolution consumes the final DOM-work unit', async () => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');
      const rawCandidate = rawCandidateFor(candidate);
      let disposeCalls = 0;
      let clickCalls = 0;
      let inspectCalls = 0;
      const targetHandle = {
        evaluate: async () => {
          inspectCalls += 1;
          return { status: 'CONNECTED', domWorkUsed: 0, raw: rawCandidate };
        },
        click: async () => { clickCalls += 1; },
        dispose: async () => { disposeCalls += 1; },
      };
      const page = {
        goto: async () => undefined,
        evaluate: async (_callback: unknown, argument?: unknown) => argument === undefined
          ? true
          : { candidates: [rawCandidate], completeness: 'COMPLETE', domWorkUsed: 100 },
        evaluateHandle: async () => resolutionEnvelopeWithWork(targetHandle, 16_284),
      } as unknown as Page;

      const result = await auditInteraction({
        ...input('/accordion.html', candidate),
        sessionFactory: async () => ({
          page,
          ledger: new SafetyLedger(),
          activateInteractionFreeze: async () => undefined,
          ...fakeCloseLifecycle(),
        }),
      });

      expect(result.status).toBe('NOT_VERIFIABLE');
      expect(result.reason).toBe('Interaction-wide DOM work budget exhausted');
      expect(inspectCalls).toBe(0);
      expect(clickCalls).toBe(0);
      expect(disposeCalls).toBe(1);
    });

    it('returns budget-reached from every DOM operation at zero without browser traversal', async () => {
      const page = {
        evaluate: async (): Promise<never> => { throw new Error('zero budget must not evaluate'); },
        evaluateHandle: async (): Promise<never> => { throw new Error('zero budget must not evaluateHandle'); },
      } as unknown as Page;
      const handle = {
        evaluate: async (): Promise<never> => { throw new Error('zero budget must not inspect'); },
      } as unknown as Parameters<typeof inspectInteractionCandidateHandle>[0];
      const discoverWithLimit = discoverInteractionCandidates as unknown as (
        target: Page,
        maxDomWork?: number,
      ) => ReturnType<typeof discoverInteractionCandidates>;
      const resolveWithLimit = resolveInteractionCandidateHandle as unknown as (
        target: Page,
        ordinal: number,
        maxDomWork?: number,
      ) => ReturnType<typeof resolveInteractionCandidateHandle>;
      const inspectWithLimit = inspectInteractionCandidateHandle as unknown as (
        target: typeof handle,
        ordinal: number,
        maxDomWork?: number,
      ) => ReturnType<typeof inspectInteractionCandidateHandle>;

      const settlements = await Promise.allSettled([
        discoverWithLimit(page, 0),
        resolveWithLimit(page, 0, 0),
        inspectWithLimit(handle, 0, 0),
      ]);

      expect(settlements).toEqual([
        { status: 'fulfilled', value: { candidates: [], completeness: 'DOM_WORK_BUDGET_REACHED', domWorkUsed: 0 } },
        { status: 'fulfilled', value: { status: 'DOM_WORK_BUDGET_REACHED', domWorkUsed: 0 } },
        { status: 'fulfilled', value: { status: 'DOM_WORK_BUDGET_REACHED', domWorkUsed: 0 } },
      ]);
    });
  });
});
