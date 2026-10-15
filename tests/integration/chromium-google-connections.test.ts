// DEF-070（DEF-046 を含む）: CLI の起動の設定（`chromiumLaunchOptions({ headless: true })`。`channel: 'chromium'` の `chrome.exe`）の
// Chromium は、Playwright の既定の起動の引数のままでは、自分で Google へ接続しようとする（起動のたびの時刻の問い合わせ
// `clients2.google.com`、AI Mode の可否の問い合わせと preconnect の `www.google.com`、form のあるページのたびの autofill の問い合わせ
// `content-autofill.googleapis.com`、起動のときの ListAccounts の `accounts.google.com` と GCM の checkin の `android.clients.google.com`）。
// CLI の起動の設定は、これらの feature を止める `--disable-features`（Playwright の既定の値を含む 1 つの引数。
// `CHROMIUM_GOOGLE_SERVICES_DISABLED_ARGS`）と、ListAccounts と checkin の向け先を使われないローカルの宛先に変える引数
// （`CHROMIUM_GOOGLE_ENDPOINTS_REDIRECTED_ARGS`）を渡す。
// このテストは、インターネットへは出さない。Chromium には、テストの中だけで、記録用の中継（`tests/helpers/chromium-egress-recorder.ts`。
// loopback だけを転送し、それ以外は拒んで宛先を記録する）を `--proxy-server` に、DNS を外へ出さない `--host-resolver-rules` を足す。
// Interaction の Context は、自分の出口の中継（`src/safety/egress-proxy.ts`）を通るので、テストの上流の方針（loopback だけを許す）で拒んだ
// 記録（Safety Ledger の `EGRESS_UPSTREAM_DENIED`、`INTERACTION_FROZEN_EGRESS`）も数える（DEF-046）。
// DEF-085 fix round 2: Passive とログインの段の Context も、自分の出口の中継を通る（Context ごとの proxy は、Chromium の `--proxy-server` より
// 優先する）。そのため、その Context の factory にも、テストの上流の方針（loopback だけを許す。`TEST_FACTORY_OPTIONS`）を渡し（渡さないと、
// production の方針で中継が実在の外部の host に接続してしまう）、中継が上流の方針で拒んだ記録（`EGRESS_UPSTREAM_DENIED`）も、記録用の
// 中継の試みと同じく、loopback でない宛先への試みとして数える（`egressDeniedAttempts`）。
// (a)〜(d) のすべての場面で、Chromium 自身の loopback でない宛先への試みが 0 件であることを確かめる。対照（DEF-070 の引数を外した起動）で、
// 同じ記録の仕組みが Chromium 自身の試みを記録できることも確かめる。
// `--gaia-url` の向け先を変えても、ページが読み込む `accounts.google.com` の要求（「Google でログイン」のボタン）と、監査の Evidence
// （スクリーンショット、DOM の Evidence、Guard の判定と記録）が変わらないことを、引数を足す前と後の起動で比べて確かめる。
// 公開監査の不変の一部として、Playwright の既定で止めている HttpsUpgrades が効き出していないこと（`http://` の名前を開いて `:443` への
// 試みがないこと）も確かめる。対照（Playwright の既定の `--disable-features` を上書きする起動）で `:443` への試みが出ることを先に確かめる。
import { chromium, type Browser } from 'playwright';
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  CHROMIUM_GOOGLE_ENDPOINTS_REDIRECTED_ARGS,
  CHROMIUM_GOOGLE_SERVICES_DISABLED_ARGS,
  chromiumLaunchOptions,
} from '../../src/browser/chromium-launch.js';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import type { Viewport } from '../../src/config/types.js';
import { wait } from '../../src/core/deadline.js';
import { createPageId } from '../../src/core/ids.js';
import { collectDomEvidence } from '../../src/evidence/dom-collector.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import {
  CONTACT_FORM_FIXTURE_PATHS,
  egressAttemptAuthority,
  GOOGLE_SIGN_IN_FIXTURE_HOST,
  recordingChromiumArgs,
  startChromiumEgressRecorder,
  startContactFormFixtureServer,
  type RecordedEgressAttempt,
} from '../helpers/chromium-egress-recorder.js';
import { LOGIN_FIXTURE_PATHS, startLoginFixtureServer } from '../helpers/login-fixture-server.js';
import { TEST_FACTORY_OPTIONS, createTestConfig } from '../helpers/test-config.js';

/** DEF-070 の引数（対照の起動では外す）。 */
const DEF_070_ARGS: readonly string[] = Object.freeze([
  ...CHROMIUM_GOOGLE_SERVICES_DISABLED_ARGS,
  ...CHROMIUM_GOOGLE_ENDPOINTS_REDIRECTED_ARGS,
]);

/**
 * 起動しただけの場面で、接続の試みを待つ時間（ms）。DEF-070-research では 30 秒待ったが、試みは起動から約 0.5 秒以内に始まった
 * （時刻の問い合わせ 約 0.3 秒、`www.google.com` 約 0.45 秒）。テストの時間に合わせて短くした（直す前の RED を、この時間で確かめた）。
 */
const LAUNCH_ONLY_SETTLE_MS = 10_000;
/**
 * ページを開いた後、接続の試みを待つ時間（ms）。DEF-070-research では 15 秒待ったが、autofill の問い合わせは開いてから約 0.5 秒以内に
 * 始まった。短くした（直す前の RED を、この時間で確かめた）。
 */
const PAGE_SETTLE_MS = 5_000;
/** Interaction の凍結の後、出口の中継の記録を待つ時間（ms）。 */
const FREEZE_SETTLE_MS = 2_000;
/** HttpsUpgrades の確かめで、`http://` の名前を開いた後に待つ時間（ms）。 */
const HTTPS_UPGRADE_SETTLE_MS = 1_000;
/** `http://` の名前を開くときの期限（ms）。中継が拒むので、読み込みは失敗する。 */
const PROBE_NAVIGATION_TIMEOUT_MS = 8_000;
/** 1 つのテストの期限（ms）。Chromium の起動と、上の待ち時間を含む。 */
const SCENARIO_TIMEOUT_MS = 60_000;

/**
 * HttpsUpgrades の確かめに開く `http://` の名前。中継が拒むので、どこへも接続しない（DNS も、中継と規則で外へ出ない）。
 * HTTPS への格上げは、IP アドレスや一意でない名前では起きないので、ふつうの形の名前（文書の例のための予約の名前）を使う。
 */
const HTTPS_UPGRADE_PROBE_HOST = 'www.example.com';
/** HTTPS の既定のポート。 */
const HTTPS_DEFAULT_PORT = 443;
/** HTTP の既定のポート。 */
const HTTP_DEFAULT_PORT = 80;
/**
 * 対照の起動に足す `--disable-features`（Playwright の既定の `--disable-features` を上書きする。値は止めても監査に関係のない feature）。
 * 上書きで HttpsUpgrades が効き出すことを、対照で確かめる（DEF-070-research の発見）。
 */
const CONTROL_OVERRIDING_DISABLE_FEATURES_ARG = '--disable-features=AutofillServerCommunication';

/** Interaction の Context の出口の中継が拒んだ記録の理由（DEF-046）。 */
const EGRESS_REJECTION_REASONS: readonly string[] = Object.freeze(['EGRESS_UPSTREAM_DENIED', 'INTERACTION_FROZEN_EGRESS']);

const VIEWPORT: Viewport = Object.freeze({ width: 1280, height: 800 });

/** 試みを表示の形（`CONNECT host:port`）にする。 */
const describeAttempt = (attempt: RecordedEgressAttempt): string => `${attempt.kind} ${egressAttemptAuthority(attempt)}`;

/** loopback でない宛先への試み（表示の形）。 */
const unexpectedAttempts = (attempts: readonly RecordedEgressAttempt[]): string[] => attempts.map(describeAttempt);

/** 出口の中継が上流の方針で拒んだ記録の理由（DEF-085 fix round 2。テストの方針は loopback だけを許すので、loopback でない宛先への試み）。 */
const EGRESS_UPSTREAM_DENIED_REASON = 'EGRESS_UPSTREAM_DENIED';

/**
 * Context の Safety Ledger の、出口の中継が上流の方針で拒んだ記録を、記録用の中継の試みと同じ形にする（DEF-085 fix round 2）。CONNECT の記録の
 * URL は `host:port`、絶対形の要求の記録の URL は、その URL（port がなければ 80）。
 */
function egressDeniedAttempts(ledger: SafetyLedger): RecordedEgressAttempt[] {
  return ledger.snapshot().blockedInteractionRequests
    .filter(({ reason }) => reason === EGRESS_UPSTREAM_DENIED_REASON)
    .map(({ method, url }): RecordedEgressAttempt => {
      const parsed = new URL(method === 'CONNECT' ? `http://${url}` : url);
      return {
        kind: method === 'CONNECT' ? 'CONNECT' : 'HTTP',
        host: parsed.hostname,
        port: parsed.port.length > 0 ? Number(parsed.port) : HTTP_DEFAULT_PORT,
      };
    });
}

/** 起動の引数の変え方（対照と、引数を足す前の起動に使う）。 */
interface LaunchVariation {
  /** CLI の起動の設定から外す引数。 */
  readonly removeArgs?: readonly string[];
  /** 最後に足す引数。 */
  readonly extraArgs?: readonly string[];
}

/**
 * CLI の起動の設定（`variation` で変えたもの）に、記録用の中継と DNS の規則を足して Chromium を起動し、`scenario` を行い、閉じた後に、
 * 中継が記録した試みを返す。中継と Chromium は、必ず片付ける。
 */
async function recordCliChromium(
  scenario: (browser: Browser) => Promise<void>,
  variation: LaunchVariation = {},
): Promise<RecordedEgressAttempt[]> {
  const recorder = await startChromiumEgressRecorder();
  try {
    const options = chromiumLaunchOptions({ headless: true });
    const removeArgs = variation.removeArgs ?? [];
    const browser = await chromium.launch({
      ...options,
      args: [
        ...(options.args ?? []).filter((arg) => !removeArgs.includes(arg)),
        ...recordingChromiumArgs(recorder),
        ...(variation.extraArgs ?? []),
      ],
    });
    try {
      await scenario(browser);
    } finally {
      await browser.close();
    }
    return recorder.attempts();
  } finally {
    await recorder.close();
  }
}

describe('the CLI launch of Chromium does not connect to Google by itself (DEF-070)', () => {
  it('(control) without the DEF-070 args, the same recorder records the attempts of Chromium itself', async () => {
    const attempts = await recordCliChromium(async () => {
      await wait(LAUNCH_ONLY_SETTLE_MS);
    }, { removeArgs: DEF_070_ARGS });

    console.info(`DEF-070 (control) launch only without the DEF-070 args: ${JSON.stringify(attempts.map(describeAttempt))}`);
    expect(attempts.length).toBeGreaterThan(0);
  }, SCENARIO_TIMEOUT_MS);

  it('(a) launch only: no attempt to a non-loopback destination', async () => {
    const attempts = await recordCliChromium(async () => {
      await wait(LAUNCH_ONLY_SETTLE_MS);
    });

    console.info(`DEF-070 (a) launch only: ${JSON.stringify(attempts.map(describeAttempt))}`);
    expect(unexpectedAttempts(attempts)).toEqual([]);
  }, SCENARIO_TIMEOUT_MS);

  it('(b) a Passive Context opening a page with a form: no attempt to a non-loopback destination', async () => {
    const fixture = await startContactFormFixtureServer();
    try {
      let deniedByEgress: RecordedEgressAttempt[] = [];
      const recorded = await recordCliChromium(async (browser) => {
        const factory = new BrowserContextFactory(
          browser,
          createTestConfig(fixture.origin, CONTACT_FORM_FIXTURE_PATHS.contactForm),
          () => new SafetyLedger(),
          TEST_FACTORY_OPTIONS,
        );
        const context = await factory.createPassiveContext(VIEWPORT);
        try {
          const page = await factory.createPassivePage(context);
          await page.goto(`${fixture.origin}${CONTACT_FORM_FIXTURE_PATHS.contactForm}`, { waitUntil: 'load' });
          await wait(PAGE_SETTLE_MS);
          expect(factory.getSafetyLedger(context).snapshot().invariantViolations).toEqual([]);
        } finally {
          await factory.closePassiveContext(context);
          deniedByEgress = egressDeniedAttempts(factory.getSafetyLedger(context));
          await factory.close();
        }
      });
      const attempts = [...recorded, ...deniedByEgress];

      console.info(`DEF-070 (b) passive form: ${JSON.stringify(attempts.map(describeAttempt))}`);
      expect(fixture.requests()).toContain(`GET ${CONTACT_FORM_FIXTURE_PATHS.contactForm}`);
      expect(unexpectedAttempts(attempts)).toEqual([]);
    } finally {
      await fixture.close();
    }
  }, SCENARIO_TIMEOUT_MS);

  it('(c) an Interaction Context: no attempt to a non-loopback destination, and no Google host in the egress proxy records (DEF-046)', async () => {
    const fixture = await startContactFormFixtureServer();
    try {
      let egressRecords: string[] = [];
      const attempts = await recordCliChromium(async (browser) => {
        const factory = new BrowserContextFactory(
          browser,
          createTestConfig(fixture.origin, CONTACT_FORM_FIXTURE_PATHS.contactForm),
          () => new SafetyLedger(),
          TEST_FACTORY_OPTIONS,
        );
        try {
          const session = await factory.createInteractionSession(VIEWPORT);
          try {
            await session.page.goto(`${fixture.origin}${CONTACT_FORM_FIXTURE_PATHS.contactForm}`, { waitUntil: 'load' });
            await wait(PAGE_SETTLE_MS);
            await session.activateInteractionFreeze();
            await wait(FREEZE_SETTLE_MS);
            const snapshot = session.ledger.snapshot();
            egressRecords = snapshot.blockedInteractionRequests
              .filter(({ reason }) => EGRESS_REJECTION_REASONS.includes(reason))
              .map(({ reason, method, url }) => `${reason} ${method} ${url}`);
            expect(snapshot.invariantViolations).toEqual([]);
          } finally {
            await session.close();
          }
        } finally {
          await factory.close();
        }
      });

      console.info(`DEF-070 (c) interaction: ${JSON.stringify({ recorder: attempts.map(describeAttempt), egressRecords })}`);
      expect(fixture.requests()).toContain(`GET ${CONTACT_FORM_FIXTURE_PATHS.contactForm}`);
      expect(unexpectedAttempts(attempts)).toEqual([]);
      // DEF-046: 出口の中継の記録（上流の方針の拒否と、凍結の後の拒否）に、Chromium 自身の Google への接続が出ない（fixture は loopback
      // なので、中継の記録は 0 件になる）。
      expect(egressRecords).toEqual([]);
    } finally {
      await fixture.close();
    }
  }, SCENARIO_TIMEOUT_MS);

  it('(d) a login stage Context opening a page with a password field: no attempt to a non-loopback destination', async () => {
    const fixture = await startLoginFixtureServer();
    try {
      let deniedByEgress: RecordedEgressAttempt[] = [];
      const recorded = await recordCliChromium(async (browser) => {
        const factory = new BrowserContextFactory(
          browser,
          createTestConfig(fixture.originA, LOGIN_FIXTURE_PATHS.login),
          () => new SafetyLedger(),
          TEST_FACTORY_OPTIONS,
        );
        const context = await factory.createLoginStageContext(VIEWPORT, {
          loginPostEndpoints: [{ origin: fixture.originA, path: LOGIN_FIXTURE_PATHS.login }],
          maxLoginPosts: 1,
        });
        try {
          const page = await factory.createPassivePage(context);
          await page.goto(`${fixture.originA}${LOGIN_FIXTURE_PATHS.login}`, { waitUntil: 'load' });
          await wait(PAGE_SETTLE_MS);
          expect(factory.getSafetyLedger(context).snapshot().invariantViolations).toEqual([]);
        } finally {
          await factory.closePassiveContext(context);
          deniedByEgress = egressDeniedAttempts(factory.getSafetyLedger(context));
          await factory.close();
        }
      });
      const attempts = [...recorded, ...deniedByEgress];

      console.info(`DEF-070 (d) login stage: ${JSON.stringify(attempts.map(describeAttempt))}`);
      expect(fixture.requests).toContainEqual({ site: 'A', method: 'GET', path: LOGIN_FIXTURE_PATHS.login });
      expect(unexpectedAttempts(attempts)).toEqual([]);
    } finally {
      await fixture.close();
    }
  }, SCENARIO_TIMEOUT_MS);
});

describe('the CLI launch of Chromium keeps HttpsUpgrades disabled as Playwright does (DEF-070)', () => {
  /** `http://` の名前を開き、中継が記録した、その名前への試み（`kind host:port`）を返す。 */
  async function probeAttempts(extraArgs: readonly string[]): Promise<string[]> {
    const attempts = await recordCliChromium(async (browser) => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await page.goto(`http://${HTTPS_UPGRADE_PROBE_HOST}/`, { timeout: PROBE_NAVIGATION_TIMEOUT_MS }).catch(() => null);
        await wait(HTTPS_UPGRADE_SETTLE_MS);
      } finally {
        await context.close();
      }
    }, { extraArgs });
    return attempts.filter(({ host }) => host === HTTPS_UPGRADE_PROBE_HOST).map(describeAttempt);
  }

  it('the control (overriding the default --disable-features of Playwright) tries :443, and the CLI launch does not', async () => {
    const httpsAttempt = `CONNECT ${HTTPS_UPGRADE_PROBE_HOST}:${HTTPS_DEFAULT_PORT}`;

    const control = await probeAttempts([CONTROL_OVERRIDING_DISABLE_FEATURES_ARG]);
    const cli = await probeAttempts([]);

    console.info(`DEF-070 HttpsUpgrades: ${JSON.stringify({ control, cli })}`);
    expect(control).toContain(httpsAttempt);
    expect(cli).not.toContain(httpsAttempt);
    // CLI の起動は、`http://` のまま中継へ要求した（格上げせずに開こうとした）。
    expect(cli).toContain(`HTTP ${HTTPS_UPGRADE_PROBE_HOST}:${HTTP_DEFAULT_PORT}`);
  }, SCENARIO_TIMEOUT_MS);
});

/** 「Google でログイン」の画面を Passive の Context で開いたときの、監査の Evidence と、ページが読み込んだ Google のアカウントの要求。 */
interface GoogleSignInObservation {
  /** 全体のスクリーンショットの SHA-256。 */
  readonly screenshotSha256: string;
  /** DOM の Evidence（JSON）。 */
  readonly domEvidence: string;
  /** Guard の判定と記録（Safety Ledger の snapshot。JSON）。 */
  readonly safetyLedger: string;
  /** ページが出した、`GOOGLE_SIGN_IN_FIXTURE_HOST` への要求と、その失敗（`request METHOD URL`、`failed URL 理由`）。 */
  readonly pageGoogleAccountRequests: readonly string[];
}

/** 中継の記録から作る、比べの結果の表示。 */
interface GoogleSignInRun {
  readonly observation: GoogleSignInObservation;
  readonly attempts: readonly RecordedEgressAttempt[];
}

const sha256Hex = (buffer: Buffer): string => createHash('sha256').update(buffer).digest('hex');

/** 「Google でログイン」の画面を、CLI の起動の設定（`variation` で変えたもの）の Passive の Context で開いて観測する。 */
async function observeGoogleSignIn(origin: string, variation: LaunchVariation): Promise<GoogleSignInRun> {
  let observation: GoogleSignInObservation | undefined;
  let deniedByEgress: RecordedEgressAttempt[] = [];
  const recorded = await recordCliChromium(async (browser) => {
    const factory = new BrowserContextFactory(
      browser,
      createTestConfig(origin, CONTACT_FORM_FIXTURE_PATHS.googleSignIn),
      () => new SafetyLedger(),
      TEST_FACTORY_OPTIONS,
    );
    const context = await factory.createPassiveContext(VIEWPORT);
    try {
      const page = await factory.createPassivePage(context);
      const pageGoogleAccountRequests: string[] = [];
      const isGoogleAccountUrl = (url: string): boolean => new URL(url).hostname === GOOGLE_SIGN_IN_FIXTURE_HOST;
      page.on('request', (request) => {
        if (isGoogleAccountUrl(request.url())) {
          pageGoogleAccountRequests.push(`request ${request.method()} ${request.url()}`);
        }
      });
      page.on('requestfailed', (request) => {
        if (isGoogleAccountUrl(request.url())) {
          pageGoogleAccountRequests.push(`failed ${request.url()} ${request.failure()?.errorText ?? ''}`);
        }
      });
      await page.goto(`${origin}${CONTACT_FORM_FIXTURE_PATHS.googleSignIn}`, { waitUntil: 'load' });
      await wait(PAGE_SETTLE_MS);
      observation = {
        screenshotSha256: sha256Hex(await page.screenshot({ fullPage: true })),
        domEvidence: JSON.stringify(await collectDomEvidence(page, createPageId(1))),
        safetyLedger: JSON.stringify(factory.getSafetyLedger(context).snapshot()),
        pageGoogleAccountRequests: [...pageGoogleAccountRequests].sort(),
      };
    } finally {
      await factory.closePassiveContext(context);
      deniedByEgress = egressDeniedAttempts(factory.getSafetyLedger(context));
      await factory.close();
    }
  }, variation);
  if (observation === undefined) {
    throw new Error('The Google sign-in page was not observed');
  }
  return { observation, attempts: [...recorded, ...deniedByEgress] };
}

// DEF-070（ユーザーの判断で、起動のときの ListAccounts と GCM の checkin も止める）: `--gaia-url` は、Chromium の Google のアカウントの
// 基の URL を変える。ページが読み込む `accounts.google.com`（「Google でログイン」の script、iframe、リンク）の扱いが変わらないことを、
// 向け先を変える引数（`CHROMIUM_GOOGLE_ENDPOINTS_REDIRECTED_ARGS`）を外した起動（足す前）と、CLI の起動（足した後）で比べて確かめる。
describe('redirecting the Google account and GCM endpoints does not change the audit of a page with a Google sign-in button (DEF-070)', () => {
  it('keeps the screenshot, the DOM Evidence, the Guard records and the requests of the page to the Google accounts host', async () => {
    const fixture = await startContactFormFixtureServer();
    try {
      const before = await observeGoogleSignIn(fixture.origin, { removeArgs: CHROMIUM_GOOGLE_ENDPOINTS_REDIRECTED_ARGS });
      const after = await observeGoogleSignIn(fixture.origin, {});

      console.info(`DEF-070 Google sign-in: ${JSON.stringify({
        before: { attempts: before.attempts.map(describeAttempt), pageRequests: before.observation.pageGoogleAccountRequests },
        after: { attempts: after.attempts.map(describeAttempt), pageRequests: after.observation.pageGoogleAccountRequests },
        sameScreenshot: before.observation.screenshotSha256 === after.observation.screenshotSha256,
        sameDom: before.observation.domEvidence === after.observation.domEvidence,
        sameLedger: before.observation.safetyLedger === after.observation.safetyLedger,
      })}`);
      expect(after.observation).toEqual(before.observation);
      // ページは、どちらの起動でも `accounts.google.com` を読み込もうとし、その要求は中継に届いた（向け先を変える引数で消えていない）。
      expect(after.observation.pageGoogleAccountRequests.length).toBeGreaterThan(0);
      expect(after.attempts.map(describeAttempt)).toContain(`CONNECT ${GOOGLE_SIGN_IN_FIXTURE_HOST}:${HTTPS_DEFAULT_PORT}`);
      // 足した後の中継の記録は、ページが読み込んだ `accounts.google.com` だけ（Chromium 自身の試みはない）。
      expect(after.attempts.filter(({ host }) => host !== GOOGLE_SIGN_IN_FIXTURE_HOST).map(describeAttempt)).toEqual([]);
    } finally {
      await fixture.close();
    }
  }, SCENARIO_TIMEOUT_MS);
});
