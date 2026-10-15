// DEF-085（不具合台帳の DEF-085。Task 27 の設計書 11 章の 2026-10-12 の行の (2)）: 同じタスクの中で開いた 2 つ目のポップアップの GET が、
// Guard が Context を閉じる途中（無効化による close、持ち主の close）に横取りを外れてサーバに届く経路を、すべての Guard の Context に付けた
// 出口の中継（`src/safety/egress-proxy.ts`）と、閉じる直前の中継の凍結で止めることを確かめる。
// - 本物の factory（`createPassiveContext`・`createPassivePage`、認証つきの factory、`createInteractionSession`）と、127.0.0.1 の fixture の
//   サーバの 2 つの Origin で確かめる。ページは `fixtures/site/popup-close-race.html`。
// - 場面: (i) 読み込みの直後に、target=_blank の form の `requestSubmit()` と、別の Origin への `window.open` を同じタスクで行う（burst）。
//   (ii) 3 ms ごとに別の Origin へ `window.open` を続ける（storm。Guard が閉じていなければ、持ち主の `closePassiveContext` で閉じる）。
//   (iii) (i) の 2 つ目の先を、同じ Origin の除外のパスにする（認証つきの factory の監査の段の除外）。(iv) 凍結の段の storm（Interaction の
//   session を凍結してから storm を始め、session の close で閉じる）。
// - 確かめること（競争のある安全のテストの条件）: 回ごとに、禁止のパスへの要求がサーバに 0 件、GET・HEAD 以外が 0 件。全部の回の後に
//   `POPUP_CLOSE_RACE_LATE_DELIVERY_SETTLE_MS` 待ってから、もう一度 0 件。止める経路が働いた証拠（中継の拒否、違反、遮断の記録）が少なくとも
//   1 回ある。区分の内訳は、テストの出力に残す。
// - Chromium は headless だけ。CLI の起動の設定（`launchCliChromium`。修正の前に届いた）と、テストの既定（headless shell。退行の検出）の両方。
// - fix round 3（T27R2 の C1）: 閉じる直前の凍結の後に中継が拒んだ要求は、記録しない。止めた証拠は、Guard の違反と遮断したポップアップの記録で
//   確かめる（`GUARD_BYPASS_EGRESS` の数は、診断のために出力に残すだけ）。
// - 加えて、Guard の閉じる直前の凍結の口（`PassiveRequestGuardOptions.egressFreeze`）を、本物の Guard で確かめる（持ち主の close と無効化の
//   両方で、`context.close()` より前に呼ぶ。口の例外は違反 `GUARD_EGRESS_FREEZE_FAILED` に記録し、閉じる処理は続ける）。
import type { Browser, BrowserContext } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';
import {
  BrowserContextFactory,
  type AuthenticatedStorageState,
  type BrowserContextFactoryOptions,
} from '../../src/browser/context-factory.js';
import type { AuditConfig } from '../../src/config/types.js';
import { wait } from '../../src/core/deadline.js';
import {
  activateInteractionFreeze,
  awaitPassiveRequestGuardReady,
  closePassiveGuardedContext,
  installPassiveRequestGuard,
  isPassiveRequestGuardClosed,
  type EgressFreezeCause,
} from '../../src/safety/passive-request-guard.js';
import type { AuditExclusionPolicy } from '../../src/safety/request-policy.js';
import { SafetyLedger, type SafetyLedgerSnapshot } from '../../src/safety/safety-ledger.js';
import { launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import { NO_NON_READ_REQUESTS, openServerWindow, QUIET_PERIOD_MS } from '../helpers/gate-harness.js';
import { createTestConfig, TEST_FACTORY_OPTIONS } from '../helpers/test-config.js';

/** fixture のページ。 */
const RACE_PAGE = '/popup-close-race.html';
/** 別の Origin の、届いてはいけないパス（fixture のサーバにはないので 404 になるが、届けば記録に残る）。 */
const FORBIDDEN_PATH = '/def085-forbidden';
/** 同じ Origin の、除外のパスの前方一致と、その下の届いてはいけないパス。 */
const EXCLUDED_PATH_PREFIX = '/def085-excluded/';
const EXCLUDED_PATH = `${EXCLUDED_PATH_PREFIX}logout`;
/** burst の場面の回数。 */
const BURST_ROUNDS = 20;
/** storm の場面の回数。 */
const STORM_ROUNDS = 40;
/** storm を続けさせる時間（ms）。この後、Guard が閉じていなければ持ち主が閉じる。 */
const STORM_RUN_MS = 300;
/** 全部の回の後に、閉じた後に遅れて届く要求を見逃さないために待つ時間（ms）。期限ではなく、確かめる前の余裕である。 */
const POPUP_CLOSE_RACE_LATE_DELIVERY_SETTLE_MS = 2_000;
/** 1 回の見積もりの上限（ms）。期限の値ではない。 */
const ROUND_BUDGET_MS = 3_000;
/** 場面のテストの期限（ms）。 */
const scenarioTimeoutMs = (rounds: number): number => rounds * (ROUND_BUDGET_MS + QUIET_PERIOD_MS) + POPUP_CLOSE_RACE_LATE_DELIVERY_SETTLE_MS;
const VIEWPORT = Object.freeze({ width: 1280, height: 720 });

/** 認証つきの factory（監査の段）の除外（除外のパスだけ。読む範囲と危険な語は制限しない）。 */
const EXCLUSIONS: AuditExclusionPolicy = Object.freeze({
  excludedPathPrefixes: Object.freeze([EXCLUDED_PATH_PREFIX]),
  auditPathPrefixes: Object.freeze([]),
  dangerousTerms: Object.freeze([]),
});
const AUTHENTICATED_FACTORY_OPTIONS: BrowserContextFactoryOptions = Object.freeze({
  ...TEST_FACTORY_OPTIONS,
  authentication: Object.freeze({
    initialState: Object.freeze({ cookies: Object.freeze([]), origins: Object.freeze([]) }),
    filterState: (state: AuthenticatedStorageState): AuthenticatedStorageState => state,
    auditExclusions: EXCLUSIONS,
  }),
});

interface ChromiumLaunch {
  readonly name: string;
  launch(): Promise<Browser>;
}

const CHROMIUM_LAUNCHES: readonly ChromiumLaunch[] = [
  { name: 'the CLI Chromium (launchCliChromium, headless)', launch: () => launchCliChromium() },
  { name: 'the headless shell (test default)', launch: () => launchHeadlessChromium() },
];

/** 止める経路が働いた証拠の数（中継の拒否、違反、遮断したポップアップ、Guard の遮断）。 */
function evidenceOf(snapshot: SafetyLedgerSnapshot): {
  readonly egressRejections: number;
  readonly violations: readonly string[];
  readonly blockedPopups: number;
  readonly frozenRequests: number;
} {
  return {
    egressRejections: snapshot.blockedInteractionRequests.filter(({ reason }) => reason === 'GUARD_BYPASS_EGRESS').length,
    violations: [...new Set(snapshot.invariantViolations.map(({ code }) => code))],
    blockedPopups: snapshot.blockedPopups.length,
    frozenRequests: snapshot.blockedInteractionRequests.filter(({ reason }) => reason !== 'GUARD_BYPASS_EGRESS').length,
  };
}

/**
 * 止めた証拠（fix round 3）: Guard の違反、遮断したポップアップ、凍結の段の遮断の記録。閉じる直前の凍結の後の中継の拒否は記録されないので、
 * 証拠に数えない（`egressRejections` は、要求の方針の拒否の数として、診断のために出力に残すだけ）。
 */
const hasEvidence = (evidence: ReturnType<typeof evidenceOf>): boolean =>
  evidence.violations.length > 0 || evidence.blockedPopups > 0 || evidence.frozenRequests > 0;

describe.each(CHROMIUM_LAUNCHES)('DEF-085: popups opened while the Guard closes the Context never reach the server, with $name', ({ name, launch }) => {
  let browser: Browser;
  let opener: FixtureServer;
  let other: FixtureServer;

  beforeAll(async () => {
    browser = await launch();
    opener = await startFixtureServer();
    other = await startFixtureServer();
  });

  afterAll(async () => {
    await browser?.close();
    await opener?.close();
    await other?.close();
  });

  const configFor = (): AuditConfig => createTestConfig(opener.origin);
  const racePageUrl = (scenario: 'burst' | 'storm', target: string, auto = true): string =>
    `${opener.origin}${RACE_PAGE}?scenario=${scenario}&target=${encodeURIComponent(target)}${auto ? '' : '&auto=0'}`;

  /**
   * Passive の Context で、`scenario` のページを `rounds` 回読み込む。回ごとに、Guard が閉じていなければ持ち主の `closePassiveContext` で
   * 閉じる。`target` は 2 つ目以降のポップアップの先、`forbidden` はその先のサーバと path。
   */
  async function runPassiveRounds(options: {
    readonly label: string;
    readonly factoryOptions: BrowserContextFactoryOptions;
    readonly scenario: 'burst' | 'storm';
    readonly rounds: number;
    readonly target: string;
    readonly forbiddenServer: FixtureServer;
    readonly forbiddenPath: string;
    readonly settleMs: number;
  }): Promise<void> {
    const factory = new BrowserContextFactory(browser, configFor(), () => new SafetyLedger(), options.factoryOptions);
    const allRounds = openServerWindow(options.forbiddenServer);
    const openerRounds = openServerWindow(opener);
    const failedRounds: unknown[] = [];
    const roundsWithEvidence: number[] = [];
    const deliveredByRound: number[] = [];
    // 中継が Guard を通らずに出ようとした要求を拒んだ記録の、回ごとの数（診断のため。区分の判定には使わない）。
    const egressRejectionsByRound: number[] = [];
    try {
      for (let round = 0; round < options.rounds; round += 1) {
        const serverWindow = openServerWindow(options.forbiddenServer);
        const context = await factory.createPassiveContext(VIEWPORT);
        const ledger = factory.getSafetyLedger(context);
        // 閉じる処理の失敗の文（診断のため）。Guard が無効化で閉じた Context の持ち主の close は reject しうる（設計どおり）ので、
        // 確かめるのは、閉じる処理の後に Guard が閉じていること（`closed`）である。
        let closeError: string | null = null;
        try {
          const page = await factory.createPassivePage(context);
          await page.goto(racePageUrl(options.scenario, options.target), { waitUntil: 'load' }).catch(() => undefined);
          await wait(options.settleMs);
        } catch {
          // Guard が Context を閉じた後の page の作成と読み込みの失敗は、場面の一部である。
        } finally {
          await factory.closePassiveContext(context).catch((error: unknown) => {
            closeError = error instanceof Error ? error.message : String(error);
          });
        }
        const closed = isPassiveRequestGuardClosed(context);
        await wait(QUIET_PERIOD_MS);
        const evidence = evidenceOf(ledger.snapshot());
        const delivered = serverWindow.count(null, options.forbiddenPath);
        deliveredByRound.push(delivered);
        egressRejectionsByRound.push(evidence.egressRejections);
        if (hasEvidence(evidence)) roundsWithEvidence.push(round);
        if (delivered !== 0 || Object.values(serverWindow.nonReadCounters()).some((count) => count !== 0) || !closed) {
          failedRounds.push({ round, delivered, lines: serverWindow.requestLines(), nonRead: serverWindow.nonReadCounters(), closed, closeError, evidence });
        }
      }
    } finally {
      await factory.close();
    }
    await wait(POPUP_CLOSE_RACE_LATE_DELIVERY_SETTLE_MS);
    console.info(`DEF-085 ${name} ${options.label}: delivered by round ${deliveredByRound.join(',')}; rounds with evidence ${roundsWithEvidence.length}/${options.rounds}; GUARD_BYPASS_EGRESS by round ${egressRejectionsByRound.join(',')}`);

    expect(failedRounds).toEqual([]);
    expect(allRounds.count(null, options.forbiddenPath)).toBe(0);
    expect(allRounds.nonReadCounters()).toEqual(NO_NON_READ_REQUESTS);
    expect(openerRounds.nonReadCounters()).toEqual(NO_NON_READ_REQUESTS);
    expect(roundsWithEvidence.length).toBeGreaterThan(0);
  }

  it('(i) burst: a form popup and a window.open to another Origin in the same task right after the load', async () => {
    await runPassiveRounds({
      label: '(i) burst to another Origin',
      factoryOptions: TEST_FACTORY_OPTIONS,
      scenario: 'burst',
      rounds: BURST_ROUNDS,
      target: `${other.origin}${FORBIDDEN_PATH}`,
      forbiddenServer: other,
      forbiddenPath: FORBIDDEN_PATH,
      settleMs: QUIET_PERIOD_MS,
    });
  }, scenarioTimeoutMs(BURST_ROUNDS));

  it('(ii) storm: window.open to another Origin every 3 ms, closed by the Guard or by the owner', async () => {
    await runPassiveRounds({
      label: '(ii) storm to another Origin',
      factoryOptions: TEST_FACTORY_OPTIONS,
      scenario: 'storm',
      rounds: STORM_ROUNDS,
      target: `${other.origin}${FORBIDDEN_PATH}`,
      forbiddenServer: other,
      forbiddenPath: FORBIDDEN_PATH,
      settleMs: STORM_RUN_MS,
    });
  }, scenarioTimeoutMs(STORM_ROUNDS));

  it('(iii) burst to an excluded path of the same Origin, with the audit stage exclusions of an authenticated factory', async () => {
    await runPassiveRounds({
      label: '(iii) burst to an excluded path',
      factoryOptions: AUTHENTICATED_FACTORY_OPTIONS,
      scenario: 'burst',
      rounds: BURST_ROUNDS,
      target: `${opener.origin}${EXCLUDED_PATH}`,
      forbiddenServer: opener,
      forbiddenPath: EXCLUDED_PATH,
      settleMs: QUIET_PERIOD_MS,
    });
  }, scenarioTimeoutMs(BURST_ROUNDS));

  it('(iv) frozen storm: window.open to another Origin every 3 ms after the Interaction freeze, closed by the session close', async () => {
    const factory = new BrowserContextFactory(browser, configFor(), () => new SafetyLedger(), TEST_FACTORY_OPTIONS);
    const allRounds = openServerWindow(other);
    const failedRounds: unknown[] = [];
    const roundsWithEvidence: number[] = [];
    const deliveredByRound: number[] = [];
    const egressRejectionsByRound: number[] = [];
    try {
      for (let round = 0; round < STORM_ROUNDS; round += 1) {
        const serverWindow = openServerWindow(other);
        const session = await factory.createInteractionSession(VIEWPORT);
        // 閉じる処理の失敗の文（診断のため）。storm で Guard が Context を無効化した session の close は reject する（設計どおり）ので、
        // 確かめるのは、閉じる処理の後に Guard が閉じていること（`closed`）である。
        let closeError: string | null = null;
        try {
          await session.page.goto(racePageUrl('storm', `${other.origin}${FORBIDDEN_PATH}`, false), { waitUntil: 'load' });
          await session.activateInteractionFreeze();
          await session.page.evaluate(() => {
            (window as unknown as { __popupCloseRaceRun(): void }).__popupCloseRaceRun();
          }).catch(() => undefined);
          await wait(STORM_RUN_MS);
        } finally {
          await session.close().catch((error: unknown) => {
            closeError = error instanceof Error ? error.message : String(error);
          });
        }
        const closed = session.isClosed();
        await wait(QUIET_PERIOD_MS);
        const evidence = evidenceOf(session.ledger.snapshot());
        const delivered = serverWindow.count(null, FORBIDDEN_PATH);
        deliveredByRound.push(delivered);
        egressRejectionsByRound.push(evidence.egressRejections);
        if (hasEvidence(evidence)) roundsWithEvidence.push(round);
        if (delivered !== 0 || Object.values(serverWindow.nonReadCounters()).some((count) => count !== 0) || !closed) {
          failedRounds.push({ round, delivered, lines: serverWindow.requestLines(), closed, closeError, evidence });
        }
      }
    } finally {
      await factory.close();
    }
    await wait(POPUP_CLOSE_RACE_LATE_DELIVERY_SETTLE_MS);
    console.info(`DEF-085 ${name} (iv) frozen storm: delivered by round ${deliveredByRound.join(',')}; rounds with evidence ${roundsWithEvidence.length}/${STORM_ROUNDS}; GUARD_BYPASS_EGRESS by round ${egressRejectionsByRound.join(',')}`);

    expect(failedRounds).toEqual([]);
    expect(allRounds.count(null, FORBIDDEN_PATH)).toBe(0);
    expect(allRounds.nonReadCounters()).toEqual(NO_NON_READ_REQUESTS);
    expect(roundsWithEvidence.length).toBeGreaterThan(0);
  }, scenarioTimeoutMs(STORM_ROUNDS));
});

describe('DEF-085: the egress freeze hook of the Guard (egressFreeze), with the headless shell', () => {
  let browser: Browser;
  let server: FixtureServer;
  let other: FixtureServer;

  beforeAll(async () => {
    browser = await launchHeadlessChromium();
    server = await startFixtureServer();
    other = await startFixtureServer();
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
    await other?.close();
  });

  /** 本物の Guard を、`egressFreeze` を付けて取り付けた Context。`calls` は、口と `context.close()` の呼ばれた順。 */
  async function guardedContext(egressFreeze: () => void): Promise<{
    readonly context: BrowserContext;
    readonly ledger: SafetyLedger;
    readonly calls: string[];
  }> {
    const context = await browser.newContext({ viewport: VIEWPORT, serviceWorkers: 'block', acceptDownloads: false });
    const calls: string[] = [];
    const originalClose = context.close.bind(context);
    vi.spyOn(context, 'close').mockImplementation(async (...args) => {
      calls.push('context.close');
      await originalClose(...args);
    });
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(context, ledger, new Set([server.origin]), {
      egressFreeze: (cause: EgressFreezeCause) => {
        calls.push(`egressFreeze:${cause}`);
        egressFreeze();
      },
    });
    return { context, ledger, calls };
  }

  it('calls the hook once, before context.close(), on the owner close', async () => {
    const { context, ledger, calls } = await guardedContext(() => undefined);
    const page = await context.newPage();
    await awaitPassiveRequestGuardReady(page);
    await page.goto(`${server.origin}/`, { waitUntil: 'load' });

    await closePassiveGuardedContext(context);

    expect(calls).toEqual(['egressFreeze:CONTEXT_CLOSE', 'context.close']);
    expect(isPassiveRequestGuardClosed(context)).toBe(true);
    expect(ledger.snapshot().invariantViolations).toEqual([]);
  });

  it('calls the hook with INTERACTION_FREEZE right after the Guard enters the freeze, and with CONTEXT_CLOSE before closing (DEF-085 round 3 I2)', async () => {
    const { context, ledger, calls } = await guardedContext(() => undefined);
    const page = await context.newPage();
    await awaitPassiveRequestGuardReady(page);
    await page.goto(`${server.origin}/`, { waitUntil: 'load' });

    await activateInteractionFreeze(page);
    expect(calls).toEqual(['egressFreeze:INTERACTION_FREEZE']);
    await closePassiveGuardedContext(context);

    expect(calls).toEqual(['egressFreeze:INTERACTION_FREEZE', 'egressFreeze:CONTEXT_CLOSE', 'context.close']);
    expect(ledger.snapshot().invariantViolations).toEqual([]);
  });

  it('calls the hook before context.close() when the Guard invalidates the Context (a popup it cannot classify)', async () => {
    const { context, ledger, calls } = await guardedContext(() => undefined);
    const page = await context.newPage();
    await awaitPassiveRequestGuardReady(page);

    await page.goto(
      `${server.origin}${RACE_PAGE}?scenario=burst&target=${encodeURIComponent(`${other.origin}${FORBIDDEN_PATH}`)}`,
      { waitUntil: 'load' },
    ).catch(() => undefined);
    await vi.waitFor(() => {
      expect(isPassiveRequestGuardClosed(context)).toBe(true);
    }, { timeout: ROUND_BUDGET_MS });

    expect(ledger.snapshot().invariantViolations.length).toBeGreaterThan(0);
    expect(calls[0]).toBe('egressFreeze:CONTEXT_CLOSE');
    expect(calls).toContain('context.close');
  });

  it('records GUARD_EGRESS_FREEZE_FAILED when the hook throws, and still closes the Context', async () => {
    const { context, ledger, calls } = await guardedContext(() => {
      throw new Error('fixture freeze failure');
    });

    await closePassiveGuardedContext(context);

    expect(calls).toEqual(['egressFreeze:CONTEXT_CLOSE', 'context.close']);
    expect(isPassiveRequestGuardClosed(context)).toBe(true);
    expect(ledger.snapshot().invariantViolations).toEqual([
      { code: 'GUARD_EGRESS_FREEZE_FAILED', message: 'fixture freeze failure' },
    ]);
  });

  it('rejects a hook that is not a function, before installing anything', async () => {
    const context = await browser.newContext({ viewport: VIEWPORT });
    try {
      await expect(installPassiveRequestGuard(context, new SafetyLedger(), new Set([server.origin]), {
        egressFreeze: 'freeze' as unknown as () => void,
      })).rejects.toThrow(TypeError);
    } finally {
      await context.close();
    }
  });
});
