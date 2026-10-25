// DEF-144（指示書 `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/DEF-144-brief.md`）: 発見の probe の押下が画面を変える場面と、違反の中身の記録。
// fixture は 127.0.0.1 の自前のサーバ。発見のジョブは本物の流れ（`executeDiscoveryRun`）で動かす。
// 1. 記録: 押下で違反が起きたら（Shared Worker を許した Chromium で、押下が Shared Worker を作る。factory の自己検査 `SHARED_WORKER_OBSERVED`）、
//    `discovery.json` と `FINISHED` の要約（IPC）に、違反の種類・段（probe の押下）・画面の path・押した候補の識別が残り、値（目印・query の値）は出ない。
//    テストの既定の Chromium と、CLI の起動の設定の両方。
// 2. 調査（`DEF144_INVESTIGATE=1` のときだけ。表を `DEF144_TABLE` のファイルに足す）: 押下の形ごとに発見のジョブを 1 回ずつ動かし、違反（Ledger に記録した
//    不変条件の違反。記録の口を包んで数える）と、サーバに届いた要求を数える。判定はしない（結果は指示書の報告の表）。
import { appendFileSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { afterAll, describe, expect, it } from 'vitest';
import { wait } from '../../src/core/deadline.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import { WORKER_PROTOCOL_VERSION, validateWorkerToParentMessage } from '../../src/control/worker-protocol.js';
import type { AuditConfig } from '../../src/config/types.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import type { DiscoveryDocument } from '../../src/discovery/discovery-result.js';
import type { RunAuthentication } from '../../src/orchestration/authenticated-run.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import type { ReadEvidenceDocument } from '../../src/discovery/read-check-evaluation.js';
import { toDiscoveryFinished, toReadCheckFinished } from '../../src/worker/audit-worker-session.js';
import { executeDiscoveryRun, type DiscoveryRunOutcome } from '../../src/worker/discovery-run.js';
import { executeReadCheckRun } from '../../src/worker/read-check-run.js';
import { launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import { nonReadRequestsOf, READ_METHODS } from '../helpers/leak-places.js';
import { startLoopbackHttpServer } from '../helpers/loopback-server.js';
import { createTestConfig } from '../helpers/test-config.js';
import { TEST_DEFAULT_CHROMIUM_ENVIRONMENT_VARIABLE } from '../helpers/test-run-environment.js';

type SharedWorkers = 'allow' | undefined;
const LAUNCHERS: readonly (readonly [string, (sharedWorkers?: SharedWorkers) => Promise<Browser>])[] = [
  ['default', (sharedWorkers) => launchHeadlessChromium(sharedWorkers === undefined ? {} : { sharedWorkers })],
  ['cli', (sharedWorkers) => launchCliChromium(sharedWorkers === undefined ? {} : { sharedWorkers })],
];
const POLICIES = ['READ_ONLY', 'PASS_EXCEPT_DELETE'] as const;
type Policy = (typeof POLICIES)[number];
const VARIANTS = [
  'pushState',
  'locationAssign',
  'locationHref',
  'anchorClick',
  'anchorBlankClick',
  'windowOpen',
  'formSubmitPost',
  'formRequestSubmitGet',
  'download',
  'dialogAutofocusSubmit',
  'detachBox',
  'windowClose',
  'pushStateManyImages',
  'manyFetches',
  'historyBack',
  'documentWrite',
  'blobNavigation',
  'aboutBlankNavigation',
  'sharedWorker',
  'iframeInsert',
  'reload',
  'sharedWorkerPress',
  'mailtoHref',
  'telHref',
  'mailtoAnchorClick',
  'mailtoWindowOpen',
  'customSchemeHref',
  'mailtoLinkButton',
  'telAnchorButton',
  'formactionCustomScheme',
  'doubleNavigation',
  'navigateThenStop',
  'navigateThenPushState',
  'navigateThenReplace',
  'postThenNavigate',
  // 画面の path に既定の危険な語（`cancel` など）を含めない（含めると読まない画面になる）。
  'editMovesAway',
] as const;
type Variant = (typeof VARIANTS)[number];

const TEST_TIMEOUT_MS = 120_000;
const LATE_REQUEST_WAIT_MS = 1_000;
const QUIET_WAIT_MS = 600;
/** fixture の Shared Worker のスクリプトの path。 */
const WORKER_SCRIPT_PATH = '/admin/worker.js';
/** probe の目印の頭（`submission-probe-contracts.ts` の目印は、この頭を持つ）。 */
const MARKER_PREFIX = 'bsprobe';
/** 画面の URL の query に入れる値の目印（どこにも出てはならない）。 */
const QUERY_MARKER = 'def144querymarker';

/** 押下の形ごとの、押したときの JS。 */
const ACTIONS: Readonly<Record<Variant, string>> = {
  pushState: "history.pushState({}, '', '/admin/after?pushed=1');",
  locationAssign: "location.assign('/admin/after?assigned=1');",
  locationHref: "location.href = '/admin/after?href=1';",
  anchorClick: "const a = document.createElement('a'); a.href = '/admin/after?anchor=1'; document.body.appendChild(a); a.click();",
  anchorBlankClick: "const a = document.createElement('a'); a.href = '/admin/after?blank=1'; a.target = '_blank'; document.body.appendChild(a); a.click();",
  windowOpen: "window.open('/admin/after?opened=1');",
  formSubmitPost: "const f = document.createElement('form'); f.method = 'post'; f.action = '/admin/submit'; const i = document.createElement('input'); i.name = 'v'; i.value = document.getElementById('name').value; f.appendChild(i); document.body.appendChild(f); f.submit();",
  formRequestSubmitGet: "const f = document.createElement('form'); f.method = 'get'; f.action = '/admin/after'; document.body.appendChild(f); f.requestSubmit();",
  download: "const a = document.createElement('a'); a.href = '/admin/export.csv'; a.download = 'x.csv'; document.body.appendChild(a); a.click();",
  dialogAutofocusSubmit: "document.getElementById('dlg').showModal();",
  detachBox: "document.getElementById('box').remove();",
  windowClose: "document.getElementById('box').remove(); window.close();",
  pushStateManyImages: "history.pushState({}, '', '/admin/after?list=1'); for (let n = 0; n < 600; n += 1) { const img = document.createElement('img'); img.src = '/img/' + n + '.png'; document.body.appendChild(img); }",
  manyFetches: "for (let n = 0; n < 600; n += 1) { fetch('/api/item/' + n).catch(() => undefined); }",
  historyBack: 'history.back();',
  documentWrite: "document.open(); document.write('<!doctype html><title>w</title><p>written</p>'); document.close();",
  blobNavigation: "location.href = URL.createObjectURL(new Blob(['<!doctype html><p>blob</p>'], { type: 'text/html' }));",
  aboutBlankNavigation: "location.href = 'about:blank';",
  sharedWorker: "try { new SharedWorker(URL.createObjectURL(new Blob(['onconnect = () => {};'], { type: 'text/javascript' }))); } catch (error) {}",
  iframeInsert: "const f = document.createElement('iframe'); f.src = '/admin/after?frame=1'; document.body.appendChild(f);",
  reload: 'location.reload();',
  sharedWorkerPress: `try { new SharedWorker('${WORKER_SCRIPT_PATH}'); } catch (error) {}`,
  mailtoHref: "location.href = 'mailto:staff@example.invalid';",
  telHref: "location.href = 'tel:0000000000';",
  mailtoAnchorClick: "const a = document.createElement('a'); a.href = 'mailto:staff@example.invalid'; document.body.appendChild(a); a.click();",
  mailtoWindowOpen: "window.open('mailto:staff@example.invalid');",
  customSchemeHref: "location.href = 'ms-teams:/l/chat/0/0?users=staff@example.invalid';",
  // 後半（押す前に見分ける形）: 画面の全体は `CUSTOM_PAGES`。
  mailtoLinkButton: '',
  telAnchorButton: '',
  formactionCustomScheme: '',
  // DEF-145（調査）: 押下で始まった読み取りの移動が、ページの JS で取り消される形。
  doubleNavigation: "location.href = '/admin/after?first=1'; location.href = '/admin/after?second=1';",
  navigateThenStop: "location.href = '/admin/after?stopped=1'; setTimeout(() => window.stop(), 0);",
  navigateThenPushState: "location.href = '/admin/after?edit=1'; history.pushState({}, '', '/admin/v/navigateThenPushState#edit');",
  navigateThenReplace: "location.href = '/admin/after?edit=1'; setTimeout(() => location.replace('/admin/after?replaced=1'), 10);",
  postThenNavigate: "const f = document.createElement('form'); f.method = 'post'; f.action = '/admin/submit'; document.body.appendChild(f); f.submit(); location.href = '/admin/after?post=1';",
  // DEF-145 の受け入れ条件 1 の画面は `CUSTOM_PAGES`（「編集」が遅い編集の画面へ移り、その読み込みをページの JS が次の移動で取り消す）。
  editMovesAway: '',
};

/** 後半: 押す前に見分けて押さない形の画面（外部スキームの `<a>` の中のボタン、`formaction` が独自のスキームの送信ボタン）。押すと違反になる。 */
const externalSchemePage = (title: string, body: string): string => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${title}</title><link rel="icon" href="data:,"></head>
<body><main><h1>${title}</h1>${body}<p><a href="/admin/after">次へ</a></p>
<script>for (const button of document.querySelectorAll('button[data-bound]')) button.addEventListener('click', () => {});
for (const form of document.querySelectorAll('form')) form.addEventListener('submit', (event) => event.preventDefault());</script></main></body></html>`;
/** DEF-145: 遅い編集の画面の path（サーバは応答を遅らせる。取り消されるので、ふつうは応答しない）。 */
const SLOW_EDIT_PATH = '/admin/edit-slow';
const SLOW_EDIT_DELAY_MS = 3_000;
const CUSTOM_PAGES: Partial<Record<Variant, string>> = {
  // DEF-145: 「編集」は遅い編集の画面へ移り、ページの JS が同じ画面への次の移動で最初の読み込みを取り消す。その後ろに「保存」（何も送らない）。
  editMovesAway: `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>edit</title><link rel="icon" href="data:,"></head>
<body><main><h1>edit</h1><div><button type="button" id="edit">編集</button><button type="button" id="save">保存</button></div><p><a href="/admin/after">次へ</a></p>
<script>document.getElementById('edit').addEventListener('click', () => { location.href = '${SLOW_EDIT_PATH}?first=1'; location.href = '${SLOW_EDIT_PATH}?second=1'; });
document.getElementById('save').addEventListener('click', () => {});</script></main></body></html>`,
  mailtoLinkButton: externalSchemePage('mailto', '<a href="mailto:staff@example.invalid"><button type="button" data-bound>保存</button></a>'),
  telAnchorButton: externalSchemePage('tel', '<a href="tel:0000000000"><button type="button" data-bound>追加</button></a>'),
  formactionCustomScheme: externalSchemePage('formaction',
    '<form method="post" action="/admin/items"><input name="name"><button type="submit" formaction="ms-teams:/l/chat/0/0">保存</button></form>'),
};

const variantPage = (variant: Variant): string => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${variant}</title><link rel="icon" href="data:,"></head>
<body><main><h1>${variant}</h1>
<div id="box">
<label>名前 <input id="name" name="name"></label>
<button type="button" id="save">保存</button>
<button type="button" id="add">追加</button>
</div>
<dialog id="dlg"><form method="post" action="/admin/dialog-submit"><input name="q" autofocus id="dq"><button type="submit">登録</button></form></dialog>
<p><a href="/admin/after">次へ</a></p>
<script>
document.getElementById('save').addEventListener('click', () => { ${ACTIONS[variant]} });
document.getElementById('add').addEventListener('click', () => {});
document.getElementById('dq').addEventListener('focus', () => { const f = document.getElementById('dq').form; if (f !== null) f.requestSubmit(); });
</script></main></body></html>`;

interface SeenRequest { readonly method: string; readonly path: string }

interface JobRun {
  readonly outcome: DiscoveryRunOutcome;
  readonly document: DiscoveryDocument | null;
  readonly text: string;
  readonly seen: readonly SeenRequest[];
  /** 記録の口を包んで数えた違反（調査用。種類と文の頭）。 */
  readonly violations: readonly string[];
}

/** 押下の形の画面から、発見のジョブを 1 回動かす（出力先は一時のフォルダ。終わったら消す）。 */
const runJob = async (launch: () => Promise<Browser>, variant: Variant, policy: Policy): Promise<JobRun> => {
  const seen: SeenRequest[] = [];
  const server = await startLoopbackHttpServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    seen.push({ method: request.method ?? '', path: `${url.pathname}${url.search}` });
    request.resume();
    if (url.pathname === `/admin/v/${variant}`) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(CUSTOM_PAGES[variant] ?? variantPage(variant));
      return;
    }
    if (url.pathname === WORKER_SCRIPT_PATH) {
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      response.end('onconnect = () => {};');
      return;
    }
    if (url.pathname === '/admin/export.csv') {
      response.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="x.csv"' });
      response.end('a,b\n');
      return;
    }
    const afterPage = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>after</title><link rel="icon" href="data:,"></head><body><h1>after</h1></body></html>';
    // DEF-145: 遅い編集の画面（応答を遅らせる）。
    if (url.pathname === SLOW_EDIT_PATH) {
      setTimeout(() => {
        if (!response.destroyed) {
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          response.end(afterPage);
        }
      }, SLOW_EDIT_DELAY_MS);
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(afterPage);
  });
  const output = await mkdtemp(join(tmpdir(), 'beaksight-def144-'));
  const violations: string[] = [];
  const original = SafetyLedger.prototype.recordInvariantViolation;
  SafetyLedger.prototype.recordInvariantViolation = function record(this: SafetyLedger, event) {
    violations.push(`${event.code}: ${event.message.replace(/\s+/gu, ' ').slice(0, 160)}`);
    original.call(this, event);
  };
  try {
    const base = createTestConfig(server.origin, `/admin/v/${variant}?page=${QUERY_MARKER}`, {
      crawl: { maxPages: 2, minNavigationIntervalMs: 200 },
      audit: { screenshots: false },
      output: { directory: output },
    });
    const config: AuditConfig = { ...base, audit: { ...base.audit, sendPolicy: policy } };
    const authentication: RunAuthentication = {
      initialState: { cookies: [], origins: [] },
      approvedTestOrigins: [server.origin],
      auditExclusions: { excludedPathPrefixes: ['/logout'], auditPathPrefixes: [], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
      sessionLostPathPrefix: '/login',
      filterState: filterAuthenticatedState,
    };
    const outcome = await executeDiscoveryRun({
      config, jobId: 'job-def144', authentication, launchBrowser: launch, clock: () => new Date(), now: () => Date.now(),
      stopSignal: new AbortController().signal, submissionProbeQuietWaitMs: QUIET_WAIT_MS,
    }, { onRunStarted: () => undefined, onSessionLost: () => undefined });
    await wait(LATE_REQUEST_WAIT_MS);
    const text = outcome.kind === 'RAN' ? readFileSync(join(outcome.runDirectory, 'discovery.json'), 'utf8') : '';
    return { outcome, document: text === '' ? null : JSON.parse(text) as DiscoveryDocument, text, seen: [...seen], violations };
  } finally {
    SafetyLedger.prototype.recordInvariantViolation = original;
    await server.close();
    await rm(output, { recursive: true, force: true });
  }
};

describe.each(LAUNCHERS)('DEF-144: the content of the safety violation of the discovery job (%s)', (_launcherName, launch) => {
  it.each(POLICIES)('keeps the kind, the stage, the page and the pressed candidate in discovery.json and the FINISHED summary with %s', async (policy) => {
    const run = await runJob(() => launch('allow'), 'sharedWorkerPress', policy);
    const { document, outcome } = run;
    if (document === null || outcome.kind !== 'RAN') {
      throw new Error('the discovery did not run');
    }
    const validation = await validateArtifact('discovery', document);
    expect(validation.ok ? [] : validation.errors).toEqual([]);
    expect(document.endReason).toBe('SAFETY_VIOLATION');
    expect(document.runStatus).toBe('ABORTED_BY_SAFETY');
    const page = document.pages.find((entry) => entry.url.includes('/admin/v/'));
    const saveCandidate = page?.state === 'READ' ? page.record.candidates.find((candidate) => candidate.submitterWords.includes('保存')) : undefined;
    if (saveCandidate === undefined) {
      throw new Error('the page with the save button was not read');
    }
    // 違反の中身: 種類、段（probe の押下）、画面の path、押した候補（送信ボタンの語と識別の digest）。
    expect(document.safetyViolation).toMatchObject({
      pagePath: '/admin/v/sharedWorkerPress',
      stage: 'SUBMISSION_PROBE',
      press: { submitterWords: ['保存'], identityDigest: saveCandidate.identityDigest },
    });
    expect(document.safetyViolation?.invariantViolationCount).toBeGreaterThan(0);
    expect(document.safetyViolation?.invariantViolations.map(({ code }) => code)).toContain('SHARED_WORKER_OBSERVED');
    // IPC: `FINISHED` の要約に同じ中身が載り、契約の確かめに通る。
    expect(outcome.summary.safetyViolation).toEqual(document.safetyViolation);
    const finished = toDiscoveryFinished(outcome, join(outcome.runDirectory, '..'));
    expect(finished.discovery?.safetyViolation).toEqual(document.safetyViolation);
    const message = validateWorkerToParentMessage({ protocol: WORKER_PROTOCOL_VERSION, type: 'FINISHED', ...finished });
    expect(message.ok ? [] : message.errors).toEqual([]);
    // 値（probe の目印、画面の URL の query の値）は出ない。
    for (const text of [run.text, JSON.stringify(finished)]) {
      expect(text.includes(MARKER_PREFIX)).toBe(false);
    }
    expect(JSON.stringify(document.safetyViolation).includes(QUERY_MARKER)).toBe(false);
    // サーバに読み取りでない要求は届かない。
    expect(run.seen.filter(({ method }) => !READ_METHODS.has(method))).toEqual([]);
  }, TEST_TIMEOUT_MS);
});

/** 読み込みで Shared Worker を作る画面（READ の確かめの違反の段 `PAGE_LOAD` の fixture）。 */
const SHARED_WORKER_LOAD_PATH = '/admin/worker-on-load';
const SHARED_WORKER_LOAD_PAGE = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>load</title><link rel="icon" href="data:,"></head>
<body><main><h1>load</h1><script>try { new SharedWorker('${WORKER_SCRIPT_PATH}'); } catch (error) {}</script></main></body></html>`;

describe.each(LAUNCHERS)('DEF-144: the content of the safety violation of the READ check job (%s)', (_launcherName, launch) => {
  it('keeps the kind, the stage and the page in read-evidence.json and the FINISHED summary', async () => {
    const seen: SeenRequest[] = [];
    const server = await startLoopbackHttpServer((request: IncomingMessage, response: ServerResponse) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      seen.push({ method: request.method ?? '', path: `${url.pathname}${url.search}` });
      request.resume();
      const script = url.pathname === WORKER_SCRIPT_PATH;
      response.writeHead(200, { 'content-type': script ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(script ? 'onconnect = () => {};' : SHARED_WORKER_LOAD_PAGE);
    });
    const output = await mkdtemp(join(tmpdir(), 'beaksight-def144-read-'));
    try {
      const base = createTestConfig(server.origin, SHARED_WORKER_LOAD_PATH, {
        crawl: { maxPages: 2, minNavigationIntervalMs: 200 }, audit: { screenshots: false }, output: { directory: output },
      });
      const authentication: RunAuthentication = {
        initialState: { cookies: [], origins: [] },
        approvedTestOrigins: [server.origin],
        auditExclusions: { excludedPathPrefixes: ['/logout'], auditPathPrefixes: [], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
        sessionLostPathPrefix: '/login',
        filterState: filterAuthenticatedState,
      };
      const outcome = await executeReadCheckRun({
        config: base, jobId: 'job-def144-read', authentication, launchBrowser: () => launch('allow'),
        readChecks: [{
          readCheckId: 'read-def144', readCheckRevision: 1, targetPage: { origin: server.origin, path: SHARED_WORKER_LOAD_PATH },
          definition: { targetPagePath: SHARED_WORKER_LOAD_PATH, parameters: {}, expectations: [{ kind: 'TEXT_CONTAINS', text: 'load' }] },
        }],
        clock: () => new Date(), now: () => Date.now(), stopSignal: new AbortController().signal,
      }, { onRunStarted: () => undefined, onSessionLost: () => undefined });
      if (outcome.kind !== 'RAN') {
        throw new Error(`the READ check did not run: ${outcome.kind}`);
      }
      await wait(LATE_REQUEST_WAIT_MS);
      const document = JSON.parse(readFileSync(join(outcome.runDirectory, 'read-evidence.json'), 'utf8')) as ReadEvidenceDocument;
      const validation = await validateArtifact('read-evidence', document);
      expect(validation.ok ? [] : validation.errors).toEqual([]);
      expect(document.endReason).toBe('SAFETY_VIOLATION');
      expect(document.safetyViolation).toMatchObject({ pagePath: SHARED_WORKER_LOAD_PATH, press: null });
      expect(['CONTEXT_OPEN', 'PAGE_LOAD', 'CONTEXT_CLOSE']).toContain(document.safetyViolation?.stage);
      expect(document.safetyViolation?.invariantViolations.map(({ code }) => code)).toContain('SHARED_WORKER_OBSERVED');
      expect(outcome.summary.safetyViolation).toEqual(document.safetyViolation);
      const finished = toReadCheckFinished(outcome, output);
      expect(finished.readCheck?.safetyViolation).toEqual(document.safetyViolation);
      const message = validateWorkerToParentMessage({ protocol: WORKER_PROTOCOL_VERSION, type: 'FINISHED', ...finished });
      expect(message.ok ? [] : message.errors).toEqual([]);
      expect(seen.filter(({ method }) => !READ_METHODS.has(method))).toEqual([]);
    } finally {
      await server.close();
      await rm(output, { recursive: true, force: true });
    }
  }, TEST_TIMEOUT_MS);
});

// DEF-144 の後半（設計書 `2026-10-20-beaksight-probe-external-scheme-design.md` 3 章の 1・4）: 送信ボタンか祖先の `<a>` の `href`、または `formaction` が
// http(s) でないスキームを指すボタンは、押さずに `NOT_EXECUTABLE`・`EXTERNAL_SCHEME`（押す回数を使わない）。違反は起きず、発見は次の画面へ進む。
describe.each(LAUNCHERS)('DEF-144: the probe does not press a button that points to an external scheme (%s)', (_launcherName, launch) => {
  const CASES: readonly (readonly [Variant, string])[] = [
    ['mailtoLinkButton', '保存'],
    ['telAnchorButton', '追加'],
  ];
  for (const policy of POLICIES) {
    // `formaction`（と form の `action`）が http(s) でないスキームの送信ボタンは、発見の分類が送信先を許可 Origin の外（`ACTION_OUTSIDE_ALLOWED_ORIGINS`）に
    // するので、probe の対象にならず、押さない（結果を持たない。`EXTERNAL_SCHEME` の数にも入らない）。押す前の読み直しの `formaction`・`action` の見分けは、
    // 読み込みの後に移る先が変わった場合の守り（`pointsToExternalScheme` の単体のテスト）。
    it(`does not press formactionCustomScheme (outside the allowed Origins) with ${policy}`, async () => {
      const run = await runJob(() => launch(), 'formactionCustomScheme', policy);
      const { document } = run;
      if (document === null) {
        throw new Error('the discovery did not run');
      }
      const validation = await validateArtifact('discovery', document);
      expect(validation.ok ? [] : validation.errors).toEqual([]);
      expect(run.violations).toEqual([]);
      expect(document.endReason).not.toBe('SAFETY_VIOLATION');
      const page = document.pages.find((entry) => entry.url.includes('/admin/v/'));
      const candidate = page?.state === 'READ' ? page.record.candidates.find((entry) => entry.submitterWords.includes('保存')) : undefined;
      expect(candidate).toMatchObject({ reasonCode: 'ACTION_OUTSIDE_ALLOWED_ORIGINS' });
      expect(candidate?.submissionProbe).toBeUndefined();
      expect(document.externalSchemeProbes).toEqual({ notPressed: 0, reloadedPages: 0 });
      expect(run.seen.filter(({ method }) => !READ_METHODS.has(method))).toEqual([]);
    }, TEST_TIMEOUT_MS);

    it.each(CASES)(`does not press %s and records EXTERNAL_SCHEME with ${policy}`, async (variant, word) => {
      const run = await runJob(() => launch(), variant, policy);
      const { document } = run;
      if (document === null) {
        throw new Error('the discovery did not run');
      }
      const validation = await validateArtifact('discovery', document);
      expect(validation.ok ? [] : validation.errors).toEqual([]);
      expect(run.violations).toEqual([]);
      expect(document.endReason).not.toBe('SAFETY_VIOLATION');
      const page = document.pages.find((entry) => entry.url.includes('/admin/v/'));
      const candidate = page?.state === 'READ' ? page.record.candidates.find((entry) => entry.submitterWords.includes(word)) : undefined;
      expect(candidate?.submissionProbe).toMatchObject({ result: 'NOT_EXECUTABLE', reason: 'EXTERNAL_SCHEME', nonReadRequestCount: 0 });
      expect(document.externalSchemeProbes).toEqual({ notPressed: 1, reloadedPages: 0 });
      // 次の画面（`/admin/after`）も読んだ。
      expect(document.pages.some((entry) => entry.state === 'READ' && entry.url.includes('/admin/after'))).toBe(true);
      expect(run.seen.filter(({ method }) => !READ_METHODS.has(method))).toEqual([]);
    }, TEST_TIMEOUT_MS);
  }
});

// DEF-145（設計書 `2026-10-21-beaksight-probe-navigation-and-dialog-design.md` 3 章の 1・3）: 「編集」の押下で始まった読み取りの移動（GET）が、ページの JS の
// 次の移動で取り消される（`HTTP_MAIN_FRAME_DELIVERY_FAILED`・`net::ERR_ABORTED`）。発見は止めずに、その候補を `PAGE_CHANGED` にし、違反の中身（失敗した要求の
// method と path）を画面の記録に残し、1 回だけ読み込み直して残り（保存）を押し、次の画面へ進む。
describe.each(LAUNCHERS)('DEF-145: the read navigation of a press that the page cancels does not stop the discovery (%s)', (_launcherName, launch) => {
  it.each(POLICIES)('reloads the page once and presses the rest with %s', async (policy) => {
    const run = await runJob(() => launch(), 'editMovesAway', policy);
    const { document } = run;
    if (document === null) {
      throw new Error('the discovery did not run');
    }
    const validation = await validateArtifact('discovery', document);
    expect(validation.ok ? [] : validation.errors).toEqual([]);
    expect(document.endReason).not.toBe('SAFETY_VIOLATION');
    expect(document.safetyViolation).toBeUndefined();
    const page = document.pages.find((entry) => entry.url.includes('/admin/v/'));
    if (page?.state !== 'READ') {
      throw new Error('the page was not read');
    }
    const probeOf = (word: string): string => {
      const probe = page.record.candidates.find((entry) => entry.submitterWords.includes(word))?.submissionProbe;
      return `${String(probe?.result)} ${String(probe?.reason)}`;
    };
    expect(probeOf('編集')).toBe('NOT_OBSERVED PAGE_CHANGED');
    expect(probeOf('保存')).toBe('NO_REQUEST null');
    expect(page.reloadedForProbe).toBe(true);
    expect(page.safetyViolations?.map((violation) => violation.invariantViolations.map(({ code, request }) => [code, request?.method, request?.path])))
      .toEqual([[['HTTP_MAIN_FRAME_DELIVERY_FAILED', 'GET', SLOW_EDIT_PATH]]]);
    expect(document.externalSchemeProbes).toEqual({ notPressed: 0, reloadedPages: 1 });
    // 画面の読み込みは 2 回（読み込み直しは 1 回）。次の画面も読んだ。
    expect(run.seen.filter(({ method, path }) => method === 'GET' && path.startsWith('/admin/v/editMovesAway'))).toHaveLength(2);
    expect(document.pages.some((entry) => entry.state === 'READ' && entry.url.includes('/admin/after'))).toBe(true);
    expect(run.seen.filter(({ method }) => !READ_METHODS.has(method))).toEqual([]);
  }, TEST_TIMEOUT_MS);
});

describe.runIf(process.env['DEF144_INVESTIGATE'] === '1').each(LAUNCHERS)('DEF-144 investigation: the probe press that changes the page (%s)', (launcherName, launch) => {
  const rows: string[] = [];
  afterAll(() => {
    const outputFile = process.env['DEF144_TABLE'];
    if (outputFile !== undefined) {
      appendFileSync(outputFile, `\n=== DEF-144 ${launcherName} (${TEST_DEFAULT_CHROMIUM_ENVIRONMENT_VARIABLE}=${process.env[TEST_DEFAULT_CHROMIUM_ENVIRONMENT_VARIABLE] ?? ''}) ===\n${rows.join('\n')}\n`);
    }
  });

  const selected = (process.env['DEF144_VARIANTS'] ?? '').split(',').filter((name) => name !== '');
  const policies = (process.env['DEF144_POLICIES'] ?? '').split(',').filter((name) => name !== '');
  for (const policy of POLICIES.filter((name) => policies.length === 0 || policies.includes(name))) {
    for (const variant of VARIANTS.filter((name) => selected.length === 0 || selected.includes(name))) {
      it(`${policy} ${variant}`, async () => {
        const run = await runJob(() => launch(), variant, policy);
        const { document } = run;
        const variantPageEntry = document?.pages.find((page) => page.url.includes('/admin/v/'));
        const probes = variantPageEntry?.state === 'READ'
          ? variantPageEntry.record.candidates
            .map((candidate) => `${candidate.submitterWords.join('|') || '-'}:${candidate.submissionProbe === undefined ? 'none' : `${candidate.submissionProbe.result}/${String(candidate.submissionProbe.reason)}`}`)
            .join(',')
          : `not-read(${variantPageEntry?.state === 'NOT_READ' ? variantPageEntry.reason : '-'})`;
        const nonRead = nonReadRequestsOf(run.seen);
        const pageChangeTargets = run.seen
          .filter(({ path }) => ['/admin/after', '/admin/export', '/admin/submit', '/admin/dialog', WORKER_SCRIPT_PATH].some((prefix) => path.startsWith(prefix)))
          .map(({ method, path }) => `${method} ${path}`);
        rows.push([
          policy, variant, document?.endReason ?? '-', document?.runStatus ?? '-', `violations=[${run.violations.join(' ; ')}]`,
          `safetyViolation=${JSON.stringify(document?.safetyViolation ?? null)}`,`nonRead=[${nonRead.join(' ; ')}]`, `pageChangeTargets=[${pageChangeTargets.join(' ; ')}]`,
          `imgApi=${String(run.seen.filter(({ path }) => path.startsWith('/img/') || path.startsWith('/api/')).length)}`, `probes=[${probes}]`,
        ].join(' | '));
        expect(run.outcome.kind).toBe('RAN');
      }, TEST_TIMEOUT_MS);
    }
  }
});
