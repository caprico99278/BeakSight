/**
 * T30b（Task 30 の設計書 `2026-10-13-beaksight-task-30-approved-create-design.md` 4 章の「Gate」、5 章）: 書き込みの段の境界の Architecture Gate。
 * 判定は `fs`、正規表現、文字列の走査だけ（`source-scan.ts` を共用する）。近似の検査である（実行時に組み立てた名前・文字列は検出できない）。
 * - (a) `src/` で Playwright の `APIRequestContext` を使わない（`context.request`・`page.request` の参照、`request.newContext`、
 *   `….request.post(…)` などの呼び出し、`APIRequestContext`・`APIRequest` の名前、`playwright` からの `request` の import、`{ request } = page` の
 *   分割代入）。この要求は Guard にも出口の中継の要求の方針にも見えない（T30 の調査の実験）ため。
 * - (b) 送る中身の照合（要求の本文の解釈）を owner（`src/safety/write-payload-policy.ts`）の外に書かない: 本文の解釈に使う文字列
 *   （`Content-Disposition`、`form-data;`、`boundary=`、`getRequestPostData`）は owner だけ。CDP の本文の項目（`postData`・`postDataEntries`・
 *   `hasPostData`）を読むのは owner と Guard（`src/safety/passive-request-guard.ts`。事実を owner に渡すだけ）だけ。照合の関数
 *   （`checkWritePayload`）を定義するのは owner だけで、呼ぶのは Guard だけ。
 * - (c) 書き込みの段の口（`writeStage`、`WriteStagePolicy`、`GuardWriteStage`、`WriteStageMonitor`、`isAcceptableGuardWriteStage`、
 *   `createWriteStageContext`）を、決めたファイルのほかから参照しない。入口の `createWriteStageContext(…)` を呼ぶのと、`new WriteStageMonitor(…)` で
 *   部品を作るのは、ワーカーの書き込みの流れ（`WRITE_STAGE_WORKER_FLOW`。T30f が作る）だけ。一覧はここで閉じる（増やすときは設計書を直してから）。
 *   T30c: 書き込みの入力の部品（`src/browser/write-form-submitter.ts`）を一覧に足した（送信の窓を開くために `WriteStageMonitor` の型を受ける。
 *   部品は作らない）。
 * - (d) T30c: 書き込みの入力の部品（`write-form-submitter`）を参照する（import、動的 import、`require`、文字列）のは、ワーカーの書き込みの流れ
 *   （`WRITE_STAGE_WORKER_FLOW`）だけ（ログインの入力の部品の `worker-login-hooks.test.ts` の (x) と同じ形）。
 * - (e) DEF-099 fix: ブラウザの外から通信を送る口（`node:http` の `request`・`get`・`Agent`、`node:https`、`node:http2`、`node:net` の
 *   `connect`・`createConnection`・`Socket`、`node:tls` の `connect`、`undici`、`fetch(…)` の呼び出し）を使うのは、出口の中継
 *   （`src/safety/egress-proxy.ts`。転送）と、書き込みの送信の送り手（`src/safety/write-submission-sender.ts`）だけ（`apps/local-ui/src/**` も
 *   調べる）。送り手は、中継を通さずに送らない: TCP の接続（`netConnect(…)`）は 1 か所だけで、引数は中継の口（`options.proxy`）。TLS は
 *   中継の上の接続（`socket:`）にだけ張り、`node:https` を使わない。
 *   T30R-fix-1（I-1）: 検出を広げた。`node:http`・`node:net`・`node:tls` は、送る口の名前つきの import（`export { … } from` を含む）に加えて、
 *   既定の import（`import http from`）と、モジュールの全体を受け取る形（`import * as`、`export *`、動的 import、`require`、`createRequire`、
 *   `getBuiltinModule`）も送る口とみなす。`node:https`・`node:http2`・`node:dgram`・`undici` は、どの形でも（型だけの import を除く）。
 *   メンバの呼び出し（`http.request(`・`https.get(`・`net.connect(`・`tls.connect(`・`dgram.createSocket(` など。名前空間の名前を前に置いた形）、
 *   大域の `fetch(`（`globalThis.fetch(` を含む）、大域の `WebSocket`・`EventSource` の参照も検出する。型だけの import、
 *   `require.resolve`、送る口でない名前（`STATUS_CODES`・`isIP` など）、コメント、メソッドの呼び出し（`x.fetch(`、`x.http.request(`）は数えない。
 *   T30R2-fix-1（M-a）: 名前の一覧に `node:http` の `ClientRequest`、`node:net` の `Stream`（`Socket` の別名）を足した。大域の口の、
 *   文字列の添え字での参照（`globalThis['fetch']`・`window["WebSocket"]` など）と、`fetch` を呼ばずに値として使う参照（別名を作る
 *   `const f = fetch`、`const { fetch } = globalThis`、`globalThis.fetch` を呼ばずに渡す）も検出する。
 * - (e2) T30R2-fix-1（M-a）: 指定子を組み立てて読み込む呼び出し（`require(name)`、`import(expr)`、`getBuiltinModule(name)`、
 *   `createRequire(…)(name)` と `createRequire(…)` を入れた変数の呼び出し。第 1 引数が文字列のリテラル（`${…}` のないテンプレートを含む）で
 *   ないもの）は、何を読むか分からないので止める側（違反）にする。`src/`・`apps/local-ui/src/` の正当な使い方は、閉じた例外の一覧
 *   （`CONSTRUCTED_MODULE_LOAD_EXCEPTIONS`。ファイルと書いたままの形）にする。
 * - (e3) T30R2-fix-1（M-a）: 子 process を起動する `node:child_process` を実行時に参照する（型だけの import を除く）のは、閉じた一覧のファイル
 *   （ワーカーを起動するジョブの管理と、DPAPI の子 process を起動する資格情報の保護）だけ（子 process からサイトへ送る口を作らないため）。
 * - (f) DEF-099 fix: 送り手（`sendWriteSubmissionOnce`）を呼ぶのは Guard の書き込みの段（`src/safety/passive-request-guard.ts`）だけ。
 * - `src/**` の読み込みと走査は、このファイルの読み込み時に 1 回だけ。ファイル全体を 1 秒以内に終える。
 */
import { describe, expect, it } from 'vitest';
import {
  PLAYWRIGHT_PACKAGE_PATTERN,
  findCallSites,
  findModuleReferences,
  findModuleSpecifiers,
  findNamedImports,
  loadLocalUiSourceFiles,
  loadSourceFiles,
  matchingParenthesis,
  scanSource,
  splitTopLevelArguments,
  type ScannedSource,
  type SourceFile,
} from './source-scan.js';

const SOURCE_FILES = loadSourceFiles();

const PAYLOAD_OWNER = 'src/safety/write-payload-policy.ts';
const GUARD = 'src/safety/passive-request-guard.ts';
const REQUEST_POLICY = 'src/safety/request-policy.ts';
const FACTORY = 'src/browser/context-factory.ts';
/** ワーカーの書き込みの流れ（T30f で作った）。書き込みの段の入口を呼び、部品を作る唯一のファイル。 */
const WRITE_STAGE_WORKER_FLOW = 'src/worker/write-create-run.ts';
/** T30c: 書き込みの入力の部品。 */
const WRITE_FORM_SUBMITTER = 'src/browser/write-form-submitter.ts';

/** (c) 書き込みの段の口を参照してよいファイル（閉じた一覧）。 */
const WRITE_STAGE_REFERENCE_FILES: readonly string[] = [
  REQUEST_POLICY,
  GUARD,
  PAYLOAD_OWNER,
  FACTORY,
  WRITE_FORM_SUBMITTER,
  WRITE_STAGE_WORKER_FLOW,
];
/** (d) 書き込みの入力の部品のモジュールの名前（指定子と文字列。コメントは数えない）。 */
const WRITE_FORM_SUBMITTER_MODULE = /write-form-submitter/u;
const refersToWriteFormSubmitter = (source: ScannedSource): boolean => WRITE_FORM_SUBMITTER_MODULE.test(source.code);
/** (c) 書き込みの段の口の名前。 */
const WRITE_STAGE_NAMES: readonly string[] = [
  'writeStage',
  'WriteStagePolicy',
  'GuardWriteStage',
  'WriteStageMonitor',
  'isAcceptableGuardWriteStage',
  'createWriteStageContext',
];
const WRITE_STAGE_NAME_PATTERN = new RegExp(String.raw`(?<![\w$])(?:${WRITE_STAGE_NAMES.join('|')})(?![\w$])`, 'gu');

// ---------------------------------------------------------------------------------------------------------------
// 検出の関数（近似）
// ---------------------------------------------------------------------------------------------------------------

/** (a) `APIRequestContext` の使い方（`bare`。コメントと文字列の中を除く）。 */
const API_REQUEST_PATTERNS: readonly RegExp[] = [
  /(?<![\w$])APIRequest(?:Context)?(?![\w$])/gu,
  /(?<![\w$])request\s*\.\s*newContext\s*\(/gu,
  /[\w$#]*(?:context|Context|page|Page)\s*\??\.\s*request(?![\w$])(?!\s*\()/gu,
  /\.\s*request\s*\??\.\s*(?:get|post|put|patch|delete|head|fetch|dispose|storageState)\s*\(/gu,
  /\{[^{}]*(?<![\w$.])request(?![\w$])[^{}]*\}\s*=\s*[\w$#.]*(?:context|Context|page|Page)(?![\w$])/gu,
];
const findApiRequestUses = (source: ScannedSource): readonly string[] => [
  ...API_REQUEST_PATTERNS.flatMap((pattern) => [...source.bare.matchAll(pattern)].map((match) => match[0].replace(/\s+/gu, ' ').trim())),
  ...findNamedImports(source.code)
    // Playwright のパッケージの名前は `source-scan.ts` の 1 か所（CCX-27。前の `playwright`・`playwright-core`・`@playwright/test` を含む広い側）。
    .filter(({ specifier }) => PLAYWRIGHT_PACKAGE_PATTERN.test(specifier))
    .flatMap(({ names }) => names.filter((name) => /^(?:request|APIRequest(?:Context)?)(?:\s+as\s+[\w$]+)?$/u.test(name)))
    .map((name) => `import ${name}`),
];

/** (b) 本文の解釈に使う文字列（文字列リテラルの中。大文字と小文字を区別しない）。 */
const BODY_PARSING_LITERAL = /content-disposition|form-data;|boundary=|getRequestPostData/iu;
const findBodyParsingLiterals = (source: ScannedSource): readonly string[] =>
  source.literals.filter((literal) => BODY_PARSING_LITERAL.test(literal));
/** (b) CDP の本文の項目の参照（`bare`）。 */
const BODY_FIELD_PATTERN = /(?<![\w$])(?:postData|postDataEntries|hasPostData)(?![\w$])/gu;
const findBodyFieldReads = (source: ScannedSource): readonly string[] => [...source.bare.matchAll(BODY_FIELD_PATTERN)].map((match) => match[0]);
/** (b) 照合の関数の定義（`bare`）。 */
const PAYLOAD_CHECK_DEFINITION = /\b(?:function\s*\*?\s*checkWritePayload\b|(?:const|let|var)\s+checkWritePayload\s*[=:])/gu;
const findPayloadCheckDefinitions = (source: ScannedSource): readonly string[] =>
  [...source.bare.matchAll(PAYLOAD_CHECK_DEFINITION)].map((match) => match[0].replace(/\s+/gu, ' ').trim());
const findPayloadCheckCalls = (source: ScannedSource): readonly string[] =>
  findCallSites(source.bare, 'checkWritePayload').map(() => 'checkWritePayload(…)');

/** (c) 書き込みの段の口の参照（`bare`）。 */
const findWriteStageReferences = (source: ScannedSource): readonly string[] =>
  [...source.bare.matchAll(WRITE_STAGE_NAME_PATTERN)].map((match) => match[0]);
/** (c) 入口の呼び出しと、部品の作成（`bare`）。 */
const findWriteStageEntries = (source: ScannedSource): readonly string[] => [
  ...findCallSites(source.bare, 'createWriteStageContext').map(() => 'createWriteStageContext(…)'),
  ...[...source.bare.matchAll(/\bnew\s+WriteStageMonitor\b/gu)].map(() => 'new WriteStageMonitor'),
];

const violationsOf = (files: readonly SourceFile[], find: (file: SourceFile) => readonly string[]): readonly string[] =>
  files.flatMap((file) => find(file).map((match) => `${file.path}: ${match}`));

const sample = (path: string, content: string): SourceFile => ({ path, content, ...scanSource(content) });

// ---------------------------------------------------------------------------------------------------------------
// 検出の関数の確かめ（違反の例で RED、正しい書き方と、コメント・文字列は数えない）
// ---------------------------------------------------------------------------------------------------------------

describe('T30b write stage boundary detectors', () => {
  it('(a) detects the APIRequestContext uses, and ignores the Guard event fields, route.request() and comments', () => {
    const file = sample('src/worker/sample.ts', [
      "import { chromium, request } from 'playwright';",
      "import { type APIRequestContext } from 'playwright';",
      'const api = await request.newContext();',
      "const response = await context.request.post(url, { form: { a: '1' } });",
      'const viaPage = page.request;',
      'const viaOwned = this.#context.request;',
      'await pageRequest.request.get(url);',
      'const { request: api2 } = writeContext;',
      'let typed: APIRequestContext;',
      'const method = event.request.method;',
      'const headers = event.request.headers;',
      'const routed = route.request();',
      'const pending = page.waitForRequest(url);',
      '// const forbidden = context.request;',
      "const label = 'context.request.post';",
    ].join('\n'));

    expect(findApiRequestUses(file)).toEqual([
      'APIRequestContext',
      'APIRequestContext',
      'request.newContext(',
      'context.request',
      'page.request',
      '#context.request',
      '.request.post(',
      '.request.get(',
      '{ request: api2 } = writeContext',
      'import request',
      'import APIRequestContext',
    ]);
  });

  it('(b) detects body parsing outside the owner: the literals, the CDP body fields, and the definitions and calls of the check', () => {
    const file = sample('src/browser/sample.ts', [
      "const header = 'Content-Disposition: form-data; name=\"x\"';",
      "const type = `multipart/form-data; boundary=${boundary}`;",
      "await session.send('Network.getRequestPostData', { requestId });",
      'const body = event.request.postData;',
      'const entries = event.request.postDataEntries ?? [];',
      'if (event.request.hasPostData) {}',
      'export function checkWritePayload(): string { return "ALLOW"; }',
      'const decision = checkWritePayload(expectation, facts);',
      '// event.request.postData',
      "const enctype = 'multipart/form-data';",
    ].join('\n'));

    expect(findBodyParsingLiterals(file)).toEqual([
      'Content-Disposition: form-data; name="x"',
      'multipart/form-data; boundary=',
      'Network.getRequestPostData',
    ]);
    expect(findBodyFieldReads(file)).toEqual(['postData', 'postDataEntries', 'hasPostData']);
    expect(findPayloadCheckDefinitions(file)).toEqual(['function checkWritePayload']);
    expect(findPayloadCheckCalls(file)).toEqual(['checkWritePayload(…)']);
  });

  it('(c) detects the references to the write stage, the entry calls and the monitor creations', () => {
    const file = sample('src/orchestration/sample.ts', [
      "import { WriteStageMonitor, type GuardWriteStage } from '../safety/passive-request-guard.js';",
      'const monitor = new WriteStageMonitor();',
      'const context = await factory.createWriteStageContext(viewport, { expectation, monitor });',
      'const options = { writeStage: stage };',
      '// createWriteStageContext(viewport, stage)',
      "const label = 'writeStage';",
      'const writeStageCount = 1;',
    ].join('\n'));

    expect(findWriteStageReferences(file)).toEqual([
      'WriteStageMonitor',
      'GuardWriteStage',
      'WriteStageMonitor',
      'createWriteStageContext',
      'writeStage',
    ]);
    expect(findWriteStageEntries(file)).toEqual(['createWriteStageContext(…)', 'new WriteStageMonitor']);
  });

  it('(d) detects the references to the write form submitter, and ignores comments', () => {
    for (const line of [
      "import { fillWriteForm } from '../browser/write-form-submitter.js';",
      "const submitter = await import('../browser/write-form-submitter.js');",
      "export * from '../browser/write-form-submitter.js';",
    ]) {
      expect(refersToWriteFormSubmitter(scanSource(line)), line).toBe(true);
    }
    expect(refersToWriteFormSubmitter(scanSource('// the write-form-submitter is the only owner'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------------------------------------------

describe('T30b Gate: the write stage boundary', () => {
  it('reads the source files once, and the owners exist', () => {
    for (const path of [PAYLOAD_OWNER, GUARD, REQUEST_POLICY, FACTORY]) {
      expect(SOURCE_FILES.some((file) => file.path === path), path).toBe(true);
    }
  });

  it('closes the list of the files that may refer to the write stage', () => {
    expect(WRITE_STAGE_REFERENCE_FILES).toEqual([
      'src/safety/request-policy.ts',
      'src/safety/passive-request-guard.ts',
      'src/safety/write-payload-policy.ts',
      'src/browser/context-factory.ts',
      'src/browser/write-form-submitter.ts',
      'src/worker/write-create-run.ts',
    ]);
  });

  it('(a) src/ does not use the Playwright APIRequestContext', () => {
    expect(violationsOf(SOURCE_FILES, findApiRequestUses)).toEqual([]);
  });

  it('(b) only the owner parses the request body; only the owner and the Guard read the CDP body fields; only the Guard calls the check', () => {
    const others = SOURCE_FILES.filter((file) => file.path !== PAYLOAD_OWNER);
    expect(violationsOf(others, findBodyParsingLiterals)).toEqual([]);
    expect(violationsOf(SOURCE_FILES.filter((file) => file.path !== PAYLOAD_OWNER && file.path !== GUARD), findBodyFieldReads)).toEqual([]);
    expect(violationsOf(others, findPayloadCheckDefinitions)).toEqual([]);
    expect(violationsOf(SOURCE_FILES, findPayloadCheckDefinitions)).toEqual([`${PAYLOAD_OWNER}: function checkWritePayload`]);
    expect(violationsOf(SOURCE_FILES.filter((file) => file.path !== GUARD), findPayloadCheckCalls)).toEqual([]);
    expect(violationsOf(SOURCE_FILES.filter((file) => file.path === GUARD), findPayloadCheckCalls).length).toBeGreaterThan(0);
  });

  it('(c) only the decided files refer to the write stage, and only the worker flow calls the entry and creates the monitor', () => {
    const others = SOURCE_FILES.filter((file) => !WRITE_STAGE_REFERENCE_FILES.includes(file.path));
    expect(violationsOf(others, findWriteStageReferences)).toEqual([]);
    expect(violationsOf(SOURCE_FILES.filter((file) => file.path !== WRITE_STAGE_WORKER_FLOW), findWriteStageEntries)).toEqual([]);
    expect(violationsOf(SOURCE_FILES.filter((file) => file.path === FACTORY), findWriteStageReferences).length).toBeGreaterThan(0);
    // T30f: 書き込みの流れが、入口を実際に呼ぶ（一覧の名前だけが残って、検出が空回りしない）。
    expect(violationsOf(SOURCE_FILES.filter((file) => file.path === WRITE_STAGE_WORKER_FLOW), findWriteStageEntries).length).toBeGreaterThan(0);
  });

  it('(d) only the worker flow refers to the write form submitter', () => {
    expect(SOURCE_FILES.some((file) => file.path === WRITE_FORM_SUBMITTER)).toBe(true);
    const referrers = SOURCE_FILES
      .filter((file) => file.path !== WRITE_FORM_SUBMITTER && refersToWriteFormSubmitter(file))
      .map(({ path }) => path);
    expect(referrers.filter((path) => path !== WRITE_STAGE_WORKER_FLOW)).toEqual([]);
    // T30f: 書き込みの流れが、入力の部品を実際に参照する。
    expect(referrers).toContain(WRITE_STAGE_WORKER_FLOW);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// DEF-099 fix: ブラウザの外から送る口と、書き込みの送信の送り手
// ---------------------------------------------------------------------------------------------------------------

const EGRESS_PROXY = 'src/safety/egress-proxy.ts';
const WRITE_SUBMISSION_SENDER = 'src/safety/write-submission-sender.ts';
/** (e) ブラウザの外から送る口を使ってよいファイル（閉じた一覧）。 */
const OUTBOUND_CLIENT_FILES: readonly string[] = [EGRESS_PROXY, WRITE_SUBMISSION_SENDER];
/** (e) 送る口の名前（モジュールごと）。`node:https`・`node:http2`・`undici` は、何を import しても送る口とみなす。 */
const OUTBOUND_NAMED_IMPORTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'node:http': ['request', 'get', 'Agent', 'globalAgent', 'ClientRequest'],
  http: ['request', 'get', 'Agent', 'globalAgent', 'ClientRequest'],
  'node:net': ['connect', 'createConnection', 'Socket', 'Stream'],
  net: ['connect', 'createConnection', 'Socket', 'Stream'],
  'node:tls': ['connect'],
  tls: ['connect'],
});
const OUTBOUND_MODULES = /^(?:node:)?(?:https|http2|dgram)$|^undici$/u;
/** (e) 大域の `fetch(…)` の呼び出し（`bare`。メソッドの呼び出し `x.fetch(` は除く。T30R-fix-1: `globalThis.fetch(` などを足した）。 */
const GLOBAL_FETCH_CALL = /(?<![\w$.])(?:(?:globalThis|window|self)\s*\.\s*)?fetch\s*\(/gu;
/**
 * (e) T30R-fix-1（I-1）: 送る口のモジュールの名前空間の名前を前に置いたメンバの呼び出し（`bare`。`new net.Socket(` を含む。
 * `x.http.request(` のように前に `.` があるものは除く）。
 */
const OUTBOUND_MEMBER_CALL =
  /(?<![\w$.])(?:https?|http2|net|tls|dgram)\s*\.\s*(?:request|get|connect|createConnection|createSocket|Socket|Stream|Agent|ClientRequest)\s*\(/gu;
/** (e) T30R-fix-1（I-1）: 大域の `WebSocket`・`EventSource` の参照（`bare`。`new WebSocket(`、`globalThis.EventSource` など）。 */
const GLOBAL_BROWSER_CLIENT = /(?<![\w$.])(?:(?:globalThis|window|self)\s*\.\s*)?(WebSocket|EventSource)(?![\w$])/gu;
/**
 * (e) T30R2-fix-1（M-a）: 大域の口の、文字列の添え字での参照（`code`。`globalThis['fetch']`、`window["WebSocket"]` など。添え字が組み立てた
 * 式のもの（`globalThis[name]`）は検出できない）。
 */
const GLOBAL_CLIENT_SUBSCRIPT = /(?<![\w$.])(?:globalThis|window|self)\s*\[\s*(['"`])(fetch|WebSocket|EventSource)\1\s*\]/gu;
/** (e) T30R2-fix-1（M-a）: `fetch` を呼ばずに値として使う参照（`bare`。別名を作る、分割代入で取り出す、渡す）。 */
const FETCH_REFERENCE = /(?<![\w$.])fetch(?![\w$])(?!\s*\()|(?<![\w$.])(?:globalThis|window|self)\s*\.\s*fetch(?![\w$])(?!\s*\()/gu;

/** (e) 送る口のモジュールの参照（import・export・`require` など。型だけの参照と `require.resolve` は除く）。 */
const findOutboundModuleReferences = (code: string): readonly string[] => findModuleReferences(code)
  .filter((reference) => !reference.typeOnly && reference.form !== 'file-url')
  .flatMap((reference): readonly string[] => {
    const named = OUTBOUND_NAMED_IMPORTS[reference.specifier];
    if (OUTBOUND_MODULES.test(reference.specifier)) {
      return reference.form === 'require' && !reference.wholeModule ? [] : [`${reference.form} ${reference.specifier}`];
    }
    if (named === undefined) {
      return [];
    }
    if (reference.wholeModule) {
      return [`${reference.form} ${reference.specifier} (whole module)`];
    }
    if (reference.form !== 'static') {
      return [];
    }
    // 節（`import`・`export` の後から `from` の前まで）の見分けは、`source-scan.ts` の `ModuleReference` の `statement`・`defaultBinding`・
    // `namedBindings`（CCX-27。CC-088）。
    const keyword = reference.statement?.keyword ?? 'import';
    return [
      ...(reference.defaultBinding === null ? [] : [`import default from ${reference.specifier}`]),
      ...named.filter((name) => reference.namedBindings.some((item) => item === name || item.startsWith(`${name} as `)))
        .map((name) => `${keyword} ${name} from ${reference.specifier}`),
    ];
  });

/** (e) ブラウザの外から送る口の使い方（import・export・`require` などと、呼び出しと、大域の口の参照）。 */
const findOutboundClients = (source: ScannedSource): readonly string[] => [
  ...findOutboundModuleReferences(source.code),
  ...[...source.bare.matchAll(GLOBAL_FETCH_CALL)].map(() => 'fetch(…)'),
  ...[...source.bare.matchAll(OUTBOUND_MEMBER_CALL)].map((match) => `${match[0].replace(/\s+/gu, '')}…)`),
  ...[...source.bare.matchAll(GLOBAL_BROWSER_CLIENT)].map((match) => `global ${match[1] ?? ''}`),
  ...[...source.code.matchAll(GLOBAL_CLIENT_SUBSCRIPT)].map((match) => `global ${match[2] ?? ''} (subscript)`),
  ...[...source.bare.matchAll(FETCH_REFERENCE)].map(() => 'fetch (reference)'),
];

/** (e2) 第 1 引数が、文字列のリテラル（`bare` では中身が空。`${…}` のないテンプレートを含む）か。 */
const isLiteralSpecifier = (argumentText: string): boolean => /^(?:''|""|`[^`$]*`)$/u.test((splitTopLevelArguments(argumentText)[0] ?? '').trim());
/** (e2) `createRequire(…)` を入れた変数の名前（`createRequire` の呼び出しの直前の `const load =` など）。 */
const CREATE_REQUIRE_BINDING_BEFORE = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:[\w$]+\s*\.\s*)?$/u;
/** (e2) `createRequire` の呼び出しの前に、変数に入れる形を探す長さ（文字）。 */
const CREATE_REQUIRE_BINDING_LOOKBEHIND = 80;
/** (e2) 呼び出しの直後の、もう 1 つの呼び出しの開き括弧。 */
const IMMEDIATE_CALL = /^\s*\(/u;
/** (e2) `createRequire(…)` で作った読み込みの関数に渡した引数（即時の呼び出しと、変数に入れた関数の呼び出し）。 */
const createRequireLoadArgumentsOf = (bare: string): readonly string[] => findCallSites(bare, 'createRequire').flatMap((site) => {
  const open = bare.indexOf('(', site.index);
  const close = matchingParenthesis(bare, open);
  const immediate = close < 0 ? null : IMMEDIATE_CALL.exec(bare.slice(close + 1));
  if (immediate !== null) {
    const argumentOpen = close + immediate[0].length;
    const argumentClose = matchingParenthesis(bare, argumentOpen);
    return argumentClose < 0 ? [] : [bare.slice(argumentOpen + 1, argumentClose)];
  }
  const binding = CREATE_REQUIRE_BINDING_BEFORE.exec(bare.slice(Math.max(0, site.index - CREATE_REQUIRE_BINDING_LOOKBEHIND), site.index))?.[1];
  return binding === undefined ? [] : findCallSites(bare, binding).map(({ argumentText }) => argumentText);
});
/** (e2) 指定子を組み立てて読み込む呼び出し（`<形>(<第 1 引数>)`。第 1 引数は前後の空白を除き、空白を 1 つにそろえる）。 */
const findConstructedModuleLoads = (source: ScannedSource): readonly string[] => [
  ...(['require', 'import', 'getBuiltinModule'] as const).flatMap((name) => findCallSites(source.bare, name).map(({ argumentText }) => [name, argumentText] as const)),
  ...createRequireLoadArgumentsOf(source.bare).map((argumentText) => ['createRequire', argumentText] as const),
].filter(([, argumentText]) => !isLiteralSpecifier(argumentText))
  .map(([name, argumentText]) => `${name}(${(splitTopLevelArguments(argumentText)[0] ?? '').replace(/\s+/gu, ' ').trim()})`);
/** (e2) 指定子を組み立てて読み込む、正当な使い方（閉じた一覧。`<ファイル>: <形>(<第 1 引数>)`）。 */
const CONSTRUCTED_MODULE_LOAD_EXCEPTIONS: readonly string[] = [
  // node:sqlite を、名前つきの定数の指定子で読む（`process.getBuiltinModule`。送る口ではない）。
  'src/control/store/sqlite-module.ts: getBuiltinModule(NODE_SQLITE_MODULE_ID)',
  // Playwright の package.json を、名前つきの定数の指定子で読む（版の確かめ。送る口ではない）。
  'src/orchestration/environment.ts: createRequire(PLAYWRIGHT_PACKAGE_JSON)',
];

/** (e3) 子 process を起動するモジュール。 */
const CHILD_PROCESS_MODULE = /^(?:node:)?child_process$/u;
/** (e3) `node:child_process` を実行時に参照してよいファイル（閉じた一覧）。 */
const CHILD_PROCESS_FILES: readonly string[] = ['src/control/job/audit-job-manager.ts', 'src/control/credentials/dpapi-protector.ts'];
/** (e3) `node:child_process` の実行時の参照（型だけの参照を除く）。 */
const findChildProcessReferences = (source: ScannedSource): readonly string[] => findModuleReferences(source.code)
  .filter((reference) => !reference.typeOnly && CHILD_PROCESS_MODULE.test(reference.specifier))
  .map((reference) => `${reference.form} ${reference.specifier}`);

/** (f) 送り手の参照（`bare`）。 */
const findSenderReferences = (source: ScannedSource): readonly string[] =>
  [...source.bare.matchAll(/(?<![\w$])sendWriteSubmissionOnce(?![\w$])/gu)].map((match) => match[0]);

const OUTBOUND_SOURCE_FILES: readonly SourceFile[] = [...SOURCE_FILES, ...loadLocalUiSourceFiles()];

describe('DEF-099 fix: write submission boundary detectors', () => {
  it('(e) detects the outbound client APIs, and ignores comments, other names and method calls', () => {
    expect(findOutboundClients(sample('x.ts', [
      "import { request as httpRequest, createServer } from 'node:http';",
      "import https from 'node:https';",
      "import { connect } from 'node:net';",
      "import { connect as tlsConnect } from 'node:tls';",
      'const response = await fetch(url);',
      '// fetch(url)',
      'page.fetch(url);',
      "import { isIP } from 'node:net';",
      "import { STATUS_CODES } from 'node:http';",
    ].join('\n')))).toEqual([
      'import request from node:http',
      'static node:https',
      'import connect from node:net',
      'import connect from node:tls',
      'fetch(…)',
    ]);
  });

  // T30R-fix-1（I-1）: T30R の E4 で見逃した書き方（既定の import、名前空間の import、動的 import、`require`、`createRequire`、メンバの呼び出し、
  // `node:dgram`）と、大域の `WebSocket`・`EventSource`。1 つずつ、検出されることを対照にする。
  it.each([
    ['a default import and its member call', "import http from 'node:http';\nhttp.request(url);", ['import default from node:http', 'http.request(…)']],
    ['a namespace import and its member call', "import * as net from 'node:net';\nnet.connect(port);", ['static node:net (whole module)', 'net.connect(…)']],
    ['a dynamic import', "const http = await import('node:http');", ['dynamic-import node:http (whole module)']],
    ['require', "const tls = require('node:tls');", ['require node:tls (whole module)']],
    ['createRequire', "const load = createRequire(import.meta.url);\nconst net = load('net');", ['create-require net (whole module)']],
    ['createRequire called at once', "const http = createRequire(import.meta.url)('node:http');", ['create-require node:http (whole module)']],
    ['getBuiltinModule', "const net = process.getBuiltinModule('node:net');", ['builtin-module node:net (whole module)']],
    ['node:dgram', "import { createSocket } from 'node:dgram';", ['static node:dgram']],
    ['a member call of https', 'https.get(url, onResponse);', ['https.get(…)']],
    ['a new socket', 'const socket = new net.Socket();', ['net.Socket(…)']],
    ['a re-export of a client API', "export { request } from 'node:http';", ['export request from node:http']],
    ['a default import together with a named import', "import http, { STATUS_CODES } from 'node:http';", ['import default from node:http']],
    ['the global WebSocket', 'const socket = new WebSocket(url);', ['global WebSocket']],
    ['the global EventSource', 'const events = new globalThis.EventSource(url);', ['global EventSource']],
    ['globalThis.fetch', 'await globalThis.fetch(url);', ['fetch(…)']],
  ])('(e) detects %s', (_name, content, expected) => {
    expect(findOutboundClients(sample('x.ts', content))).toEqual(expected);
  });

  // T30R2-fix-1（M-a）: 足した名前と、大域の口の文字列の添え字、`fetch` の別名。
  it.each([
    ['ClientRequest of node:http', "import { ClientRequest } from 'node:http';", ['import ClientRequest from node:http']],
    ['Stream of node:net (the alias of Socket)', "import { Stream as RawSocket } from 'node:net';", ['import Stream from node:net']],
    ['a new net.Stream', 'const socket = new net.Stream();', ['net.Stream(…)']],
    ['globalThis subscripted with fetch', "await globalThis['fetch'](url);", ['global fetch (subscript)']],
    ['window subscripted with WebSocket', 'const socket = new window["WebSocket"](url);', ['global WebSocket (subscript)']],
    ['an alias of fetch', 'const send = fetch;\nawait send(url);', ['fetch (reference)']],
    ['fetch taken out of globalThis', 'const { fetch: send } = globalThis;', ['fetch (reference)']],
    ['globalThis.fetch passed as a value', 'run(globalThis.fetch);', ['fetch (reference)']],
  ])('(e) detects %s', (_name, content, expected) => {
    expect(findOutboundClients(sample('x.ts', content))).toEqual(expected);
  });

  it('(e) does not count the local names window and fetch-like words, property names, and strings', () => {
    expect(findOutboundClients(sample('x.ts', [
      'while (window.length > 0 && window[0] !== undefined) { window.shift(); }',
      "const category = 'fetch-xhr';",
      "switch (type) { case 'fetch': break; }",
      'client.fetch(url); client.fetch;',
      "const label = globalThis['location'];",
    ].join('\n')))).toEqual([]);
  });

  it.each([
    ['require with a name', 'const module = require(name);', ['require(name)']],
    ['require with a concatenation', "const module = require('node:' + name);", ["require('' + name)"]],
    ['a dynamic import with an expression', 'const module = await import(specifier);', ['import(specifier)']],
    ['a dynamic import with a template with an expression', 'const module = await import(`node:${name}`);', ['import(`${name}`)']],
    ['getBuiltinModule with a name', 'const module = process.getBuiltinModule(name);', ['getBuiltinModule(name)']],
    ['createRequire called at once with a name', 'const module = createRequire(import.meta.url)(name);', ['createRequire(name)']],
    ['a createRequire binding called with a name', 'const load = createRequire(import.meta.url);\nconst module = load(name);', ['createRequire(name)']],
  ])('(e2) detects a constructed specifier: %s', (_name, content, expected) => {
    expect(findConstructedModuleLoads(sample('x.ts', content))).toEqual(expected);
  });

  it('(e2) ignores literal specifiers, templates without expressions, require.resolve and comments', () => {
    expect(findConstructedModuleLoads(sample('x.ts', [
      "const http = require('node:http');",
      'const module = await import(`./module.js`);',
      "const net = process.getBuiltinModule('node:net');",
      "const load = createRequire(import.meta.url);\nconst manifest = load('../package.json');",
      "const path = require.resolve(name);",
      '// require(name); import(specifier);',
      "type Module = typeof import('node:http');",
    ].join('\n')))).toEqual([]);
  });

  it('(e3) detects the runtime references to node:child_process, and ignores type-only imports', () => {
    expect(findChildProcessReferences(sample('x.ts', [
      "import { spawn } from 'node:child_process';",
      "const childProcess = await import('child_process');",
      "import type { ChildProcess } from 'node:child_process';",
    ].join('\n')))).toEqual(['static node:child_process', 'dynamic-import child_process']);
  });

  it('(e) ignores type-only imports, names that do not send, require.resolve, other modules, comments and members of other objects', () => {
    expect(findOutboundClients(sample('x.ts', [
      "import type { IncomingMessage } from 'node:http';",
      "import type * as http from 'node:http';",
      "import { createServer, STATUS_CODES, type Server } from 'node:http';",
      "import { isIP } from 'node:net';",
      "const path = require.resolve('node:http');",
      "const load = createRequire(import.meta.url);",
      "const manifest = load('../package.json');",
      "import { readFile } from 'node:fs';",
      '// http.request(url); new WebSocket(url); import net from "node:net";',
      'client.http.request(url);',
      "const label = 'WebSocket';",
      'const isWebSocketLike = (value: unknown): boolean => value !== null;',
    ].join('\n')))).toEqual([]);
  });

  it('(f) detects the references to the sender', () => {
    expect(findSenderReferences(sample('x.ts', 'await sendWriteSubmissionOnce(request, options); // sendWriteSubmissionOnce'))).toEqual([
      'sendWriteSubmissionOnce',
    ]);
  });
});

describe('DEF-099 fix Gate: the write submission boundary', () => {
  it('(e) only the egress proxy and the write submission sender send outside the browser', () => {
    expect(OUTBOUND_SOURCE_FILES.some((file) => file.path === WRITE_SUBMISSION_SENDER)).toBe(true);
    expect(violationsOf(OUTBOUND_SOURCE_FILES.filter((file) => !OUTBOUND_CLIENT_FILES.includes(file.path)), findOutboundClients)).toEqual([]);
  });

  it('(e2) no file loads a module by a constructed specifier, except the closed list', () => {
    const found = OUTBOUND_SOURCE_FILES.flatMap((file) => findConstructedModuleLoads(file).map((load) => `${file.path}: ${load}`));
    expect(found.filter((load) => !CONSTRUCTED_MODULE_LOAD_EXCEPTIONS.includes(load))).toEqual([]);
    // 例外の一覧は、今も使われている形だけ（使われなくなった例外を残さない）。
    expect(CONSTRUCTED_MODULE_LOAD_EXCEPTIONS.filter((exception) => !found.includes(exception))).toEqual([]);
  });

  it('(e3) only the closed list of files refers to node:child_process at run time', () => {
    const referrers = OUTBOUND_SOURCE_FILES.filter((file) => findChildProcessReferences(file).length > 0).map(({ path }) => path);
    expect([...referrers].sort()).toEqual([...CHILD_PROCESS_FILES].sort());
  });

  it('(e) the sender connects only to the egress proxy, and lays TLS only over that connection', () => {
    const sender = SOURCE_FILES.find((file) => file.path === WRITE_SUBMISSION_SENDER);
    const bare = sender?.bare ?? '';
    const connects = findCallSites(bare, 'netConnect');
    expect(connects).toHaveLength(1);
    expect(connects[0]?.argumentText.replace(/\s+/gu, ' ').trim()).toBe('{ host: options.proxy.host, port: options.proxy.port }');
    const tls = findCallSites(bare, 'tlsConnect');
    expect(tls).toHaveLength(1);
    expect(tls[0]?.argumentText).toMatch(/socket:\s*proxySocket/u);
    expect(findModuleSpecifiers(sender?.code ?? '').filter((specifier) => OUTBOUND_MODULES.test(specifier))).toEqual([]);
  });

  it('(f) only the write stage of the Guard calls the sender', () => {
    const referrers = SOURCE_FILES.filter((file) => file.path !== WRITE_SUBMISSION_SENDER && findSenderReferences(file).length > 0).map(({ path }) => path);
    expect(referrers).toEqual([GUARD]);
  });
});
