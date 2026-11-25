// WBF（DEF-291 の A・C。`defects.md`）: 名前のない欄の、操作さがしの識別（位置から作る構造の CSS）で、書き込みの段が同じ欄を見つけ直して入れ、承認した書き込みを
// 送る口へ渡すこと。帯の欄を足して位置をずらした画面では、違う欄に入った値の送信を Guard が送る前に止め、サーバに書き込みが届かないこと（安全の場面。両方の
// Chromium）。入れた後に遅れて値を持つ欄（C）も、押す前の落ち着きの待ちで、承認した値のまま渡ること。
// 通す部品（どれも本物）: 操作さがし（凍結の Context の押下。`probeSceneOf`）、認証つきの factory の書き込みの段の Context（送り方 API。Guard の照合）、書き込みの
// 入力の部品（`inspectApiWriteInput`・`fillApiWriteInput`・`submitApiWriteInput`）。送る口は偽物（照合を通った要求の本文を覚える）。サイトは 127.0.0.1 の仮のサイト。
import type { Browser, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  fillApiWriteInput,
  inspectApiWriteInput,
  submitApiWriteInput,
  type ApiWriteInputSpec,
} from '../../src/browser/api-write-submitter.js';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import type { AuditConfig, Viewport } from '../../src/config/types.js';
import { scenarioApiFieldIdentityOf } from '../../src/control/approval/scenario-contracts.js';
import { createServiceRequestBudget } from '../../src/crawl/service-request-budget.js';
import { probedCandidateIdentityDigestOf } from '../../src/discovery/discover-page.js';
import { locationOfUrl, probePageCandidates } from '../../src/discovery/probe.js';
import { submissionProbeKeyFieldsOf } from '../../src/discovery/submission-probe-contracts.js';
import type { ApiWritePayloadExpectation } from '../../src/safety/api-write-payload-policy.js';
import { AuditStageMonitor, WriteStageMonitor, type AdmittedApiWriteRequest } from '../../src/safety/passive-request-guard.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import type { WriteSubmissionOutcome } from '../../src/safety/write-submission-sender.js';
import { BOTH_CHROMIUM_LAUNCHERS, closeTestContexts } from '../helpers/chromium.js';
import {
  nonReadHitsOf,
  probeSceneOf,
  settleProbeSceneSite,
  startProbeSceneSite,
  type ProbeSceneSite,
} from '../helpers/probe-scene-site.js';
import { fastRunConfig } from '../helpers/run-harness.js';
import { TEST_FACTORY_OPTIONS } from '../helpers/test-config.js';

const SAVE_WORD = '保存';
const VIEWPORT: Viewport = Object.freeze({ width: 1280, height: 800 });
/** L12b: 見張りの反応なしの長さ（テストだけ短くする）。 */
const TEST_WATCH = Object.freeze({ quietLimitMs: 3_000 });
const ITEMS_PATH = '/api/items';
/** 生成した値（テストの仮の値）。 */
const VALUES = Object.freeze({ title: 'WBF 題', memo: 'WBF メモ' });

const SEND = `const send = (o) => fetch(API + '${ITEMS_PATH}', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(o) });`;
/** 名前のない制御された欄の登録の画面（`banner` は、題の前に帯の欄を足して、欄の位置をずらす）。 */
const namelessPage = (banner: boolean): string => `<main><h1>品目の登録</h1>
${banner ? '<div><label>お知らせ <input type="text"></label></div>' : ''}<div><label>題 <input type="text" class="f"></label></div>
<div><label>メモ <input type="text" class="f"></label></div><button type="button" id="save">${SAVE_WORD}</button></main>
<script>${SEND} const s = { title: '', memo: '' }; const k = ['title', 'memo'];
document.querySelectorAll('input.f').forEach((el, i) => el.addEventListener('input', (e) => { s[k[i]] = e.target.value; }));
document.getElementById('save').addEventListener('click', () => send(s));</script>`;
/** 入れた後に遅れて値を持つ欄（題は入力の 300ms 後に値を持つ）。 */
const LATER_PAGE = `<main><h1>品目の登録</h1><label>題 <input type="text" name="title"></label><label>メモ <input type="text" name="memo"></label>
<button type="button" id="save">${SAVE_WORD}</button></main>
<script>${SEND} const s = { title: '', memo: '' }; let t = null;
document.querySelector('[name=title]').addEventListener('input', (e) => { clearTimeout(t); const v = e.target.value; t = setTimeout(() => { s.title = v; }, 300); });
document.querySelector('[name=memo]').addEventListener('input', (e) => { s.memo = e.target.value; });
document.getElementById('save').addEventListener('click', () => send(s));</script>`;
const PAGES: Readonly<Record<string, string>> = Object.freeze({
  '/wbf/nameless': namelessPage(false),
  '/wbf/nameless-banner': namelessPage(true),
  '/wbf/later': LATER_PAGE,
});

/** 承認した API の指定（仮のサイトの登録の型）と、生成した値。 */
const expectationOf = (site: ProbeSceneSite): ApiWritePayloadExpectation => ({
  spec: {
    request: { method: 'POST', origin: site.apiOrigin, pathShape: ITEMS_PATH, queryNames: [], contentType: 'application/json', prefer: [] },
    keyFields: [{ key: 'memo', type: 'string' }, { key: 'title', type: 'string' }],
    pageKeys: [],
    headerNames: ['content-type'],
    filterName: null,
  },
  values: VALUES,
  recordId: null,
});

describe.each(BOTH_CHROMIUM_LAUNCHERS)('WBF: the write stage finds the nameless fields again with %s', (_label, launch) => {
  let browser: Browser;
  let site: ProbeSceneSite;
  const factories: BrowserContextFactory[] = [];

  beforeAll(async () => {
    browser = await launch();
    site = await startProbeSceneSite(PAGES, 'http');
  });

  afterEach(async () => {
    await Promise.all(factories.splice(0).map((factory) => factory.close()));
    await closeTestContexts(browser);
  });

  afterAll(async () => {
    await site?.close();
    await browser?.close();
  });

  /** 操作さがしで見つけた、鍵ごとの欄の識別（`path` の画面で押した記録から）。 */
  const probedFieldsOf = async (path: string): Promise<ApiWriteInputSpec['fields']> => {
    const { probed } = await probeSceneOf(browser, site, path, { sendPolicy: 'PASS_EXCEPT_DELETE' });
    const probe = probed.candidates.find((candidate) => candidate.submitterWords.includes(SAVE_WORD))?.submissionProbe;
    const keyFields = probe === undefined ? [] : submissionProbeKeyFieldsOf(probe);
    return (['title', 'memo'] as const).map((key) => {
      const field = keyFields.find((keyField) => keyField.key === key)?.field ?? null;
      const identity = field === null ? null : scenarioApiFieldIdentityOf(field);
      if (identity === null) throw new Error(`the key ${key} has no field identity`);
      return { field: identity, value: VALUES[key] };
    });
  };

  /** 書き込みの段の Context で `path` を開き、確かめ・入力・押下を行う。送る口に渡った要求の本文と、Guard が止めた理由を返す。 */
  const writeOn = async (path: string, fields: ApiWriteInputSpec['fields']) => {
    const base = fastRunConfig(site.appOrigin, path);
    const config: AuditConfig = { ...base, site: { startUrl: `${site.appOrigin}${path}`, allowedOrigins: [site.appOrigin] } };
    const factory = new BrowserContextFactory(browser, config, () => new SafetyLedger(), {
      ...TEST_FACTORY_OPTIONS,
      authentication: {
        initialState: { cookies: [], origins: [] },
        filterState: (state) => state,
        auditExclusions: { excludedPathPrefixes: [], auditPathPrefixes: [], dangerousTerms: [] },
        auditStage: { approvedServiceOrigins: [site.apiOrigin], auditReadRequests: [], scriptLogin: { origin: site.apiOrigin, path: '/token', requiredQuery: [] } },
      },
      serviceRequestBudget: createServiceRequestBudget({ now: () => Date.now() }),
      auditStageMonitor: new AuditStageMonitor(),
    });
    factories.push(factory);
    const monitor = new WriteStageMonitor();
    const admitted: Record<string, unknown>[] = [];
    const handoff = async (request: AdmittedApiWriteRequest): Promise<WriteSubmissionOutcome> => {
      admitted.push(JSON.parse(request.body.toString('utf8')) as Record<string, unknown>);
      return {
        kind: 'RESPONDED', status: 201, decoded: true, body: Buffer.from('{"id":1}'),
        headers: [{ name: 'content-type', value: 'application/json' }, { name: 'access-control-allow-origin', value: site.appOrigin }],
      };
    };
    const context = await factory.createWriteStageContext(VIEWPORT, { transport: 'API', expectation: expectationOf(site), monitor, handoff });
    const page: Page = await factory.createPassivePage(context);
    await page.goto(`${site.appOrigin}${path}`);
    const read = await probePageCandidates(page, Date.now() + 15_000);
    const found = read.status === 'READ' ? read.candidates.find((candidate) => candidate.submitterWords.includes(SAVE_WORD)) : undefined;
    if (found === undefined) throw new Error('the screen has no save candidate');
    const spec: ApiWriteInputSpec = { submitterIdentityDigest: probedCandidateIdentityDigestOf(locationOfUrl(page.url()).location, found), fields };
    const inspected = await inspectApiWriteInput(page, spec);
    if (!inspected.ok) throw new Error(`the inspection failed: ${inspected.reason}`);
    const filled = await fillApiWriteInput(page, inspected.input, monitor, undefined, TEST_WATCH);
    if (!filled.ok) throw new Error(`the fill failed: ${filled.reason}`);
    const submitted = await submitApiWriteInput(page, inspected.input, undefined, TEST_WATCH);
    await expect.poll(() => admitted.length + Object.values(monitor.snapshot().blockedByPayloadReason).reduce((sum, count) => sum + count, 0)).toBeGreaterThan(0);
    return { submitted: submitted.ok, admitted, blocked: monitor.snapshot().blockedByPayloadReason };
  };

  it('fills the fields found by the probe and hands the approved write with the values in their keys', async () => {
    const outcome = await writeOn('/wbf/nameless', await probedFieldsOf('/wbf/nameless'));
    expect(outcome.admitted).toEqual([{ title: VALUES.title, memo: VALUES.memo }]);
    await settleProbeSceneSite(site);
    expect(nonReadHitsOf(site.hits)).toEqual([]);
  });

  it('stops before the send when a banner field shifts the positions, and no write reaches the server', async () => {
    const outcome = await writeOn('/wbf/nameless-banner', await probedFieldsOf('/wbf/nameless'));
    expect(outcome.admitted).toEqual([]);
    expect(outcome.blocked).toMatchObject({ BODY_VALUE_MISMATCH: 1 });
    await settleProbeSceneSite(site);
    expect(nonReadHitsOf(site.hits)).toEqual([]);
  });

  it('waits after the fill until the page settles, so the field that takes its value later is sent with the approved value', async () => {
    const outcome = await writeOn('/wbf/later', await probedFieldsOf('/wbf/later'));
    expect(outcome.admitted).toEqual([{ title: VALUES.title, memo: VALUES.memo }]);
    await settleProbeSceneSite(site);
    expect(nonReadHitsOf(site.hits)).toEqual([]);
  });
});
