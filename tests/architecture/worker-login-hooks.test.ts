/**
 * T25d（Task 25 の設計書 4.4、指示書の「本番の経路に、資格情報を自動で入れる処理を作らない」）: ワーカーのログインの段の、テストだけの口が
 * 本番の経路から使えないことの Architecture Gate。T26d-1（Task 26 の設計書 4.4 の「入力の部品」）: 値を入れる部品を 1 つに閉じ込める。
 * 判定は `fs`、正規表現、文字列の走査だけ（`source-scan.ts` を共用する）。近似の検査である。
 * - (n) 本番の入口（`src/worker/audit-worker.ts`）は、`runAuditWorkerProcess(process)` を、指定（テストだけの口）なしで 1 回だけ呼ぶ。
 * - (o) `src/worker/` は、環境変数と起動の引数（`process.env`、`process.argv`）を読まない（テストだけの口を、IPC・設定・環境変数から渡す経路を
 *   作らない）。
 * - (p) テストだけの口の名前（`onLoginPageReady`、`launchLoginBrowser`）は、ログインの段（`authenticated-login.ts`）と process の組み立て
 *   （`audit-worker-process.ts`）の外のコードに現れない（流れ `audit-worker-session.ts` と契約は、口を知らない）。T26d-2: 自動ログインの口
 *   （自動ログイン用の Browser の起動 `launchAutomatedLoginBrowser`、資格情報のファイルの部品の作り方 `openCredentialStore`）を足し、持ち主に自動
 *   ログインの段（`automated-login.ts`）を足した（`src/worker/` の外の `src/` にも現れないことを確かめる）。
 * - (q) `src/` は、ページの入力の欄に値を入れる操作（`fill`、`type`、`press`、`pressSequentially`、`keyboard`、`insertText`、`setInputFiles`、
 *   `check`、`selectOption`）を行わない。例外は、入力の部品（`src/browser/login-form-submitter.ts`）だけ（T26d-1 で範囲を `src/worker/` から
 *   `src/` 全体に広げ、`insertText` を足した）。`type` は引数のある呼び出しだけを数える（Playwright の `type` は必ず文字列を受ける。引数のない
 *   `message.type()`（console の種類の読み取り）は入力の操作でない）。T26g-1（T26R の M2）: `click` を足した。`click` の例外は、入力の部品と、
 *   既存の Interaction の部品（`src/interaction/isolated-auditor.ts`。隔離した Context で、読み取りだけの操作の候補を押す。値は入れない。
 *   Interaction の Guard が要求を止める）だけ。
 *   T30c（Task 30 の設計書 5 章）: 入力の部品を、ログインの入力の部品と書き込みの入力の部品（`src/browser/write-form-submitter.ts`）の 2 つに
 *   広げた。数える操作に、`uncheck`、`setChecked`、`dispatchEvent`、`dblclick`、`tap`、`dragTo` を足した（`click` の例外のファイルでも、これらは
 *   許さない）。
 *   T37c（Task 37 の設計書 3.2 の「押下」）: 入力の部品に、送らずに観察する probe の押す部品（`src/interaction/submission-probe.ts`。凍結した Context で
 *   合成の目印を入れ、`select` を選び、押す）を足した（ちょうど 3 つ）。この部品は `fill`・`selectOption`・`click` だけを使う。
 *   T39d（Task 39 の設計書 3.5）: API のシナリオの書き込みの入力と押下の部品（`src/browser/api-write-submitter.ts`）を足した（ちょうど 4 つ）。この部品も
 *   `fill`・`selectOption`・`click` だけを使う。
 * - (x) 入力の部品（`login-form-submitter`）を参照する（import、動的 import、`require`、文字列）のは、自動ログインの段
 *   （`src/worker/automated-login.ts`）だけ。手動のログインの段（`authenticated-login.ts`）は参照しない。書き込みの入力の部品を参照してよい
 *   ファイルは、`write-stage-boundary.test.ts` の (d) が決める。
 * - (y) 自動ログインの段は、headed の起動を参照しない（`LOGIN_BROWSER_HEADLESS`、`headless` の指定、`chromium` の起動、
 *   `chromiumLaunchOptions`、`launchPersistentContext`、手動のログインの段のファイル）。ログイン用の Browser は、呼ぶ側が渡す。
 * - (z) 入力の部品の中で、値を受ける引数（`LOGIN_SECRET_PARAMETER`）が現れるのは、その宣言（`loginSecret:`）と `.fill(` の引数の中だけ
 *   （`evaluate` などに渡さない。別の名前に移さない）。
 * - ファイル全体を 1 秒以内に終える。
 */
import { describe, expect, it } from 'vitest';
import { countIdentifier, findCallSites, loadSourceFiles, scanSource, type ScannedSource } from './source-scan.js';

const WORKER_DIRECTORY = 'src/worker/';
const ENTRY_PATH = 'src/worker/audit-worker.ts';
const HOOK_OWNER_PATHS: ReadonlySet<string> = new Set([
  'src/worker/authenticated-login.ts',
  'src/worker/audit-worker-process.ts',
  // T26d-2: 自動ログインの段（`launchAutomatedLoginBrowser` を依存として受ける）。
  'src/worker/automated-login.ts',
]);
// FM-2: ジョブのブラウザを表示しないテストだけの口（`hideJobBrowser`。process の組み立てだけが持つ）を足した。
const TEST_ONLY_HOOK_NAMES: readonly string[] = ['onLoginPageReady', 'launchLoginBrowser', 'launchAutomatedLoginBrowser', 'openCredentialStore', 'hideJobBrowser'];
const ENTRY_CALL = /\brunAuditWorkerProcess\s*\(([^)]*)\)/gu;
const ENVIRONMENT_READS = /\bprocess\s*\.\s*(?:env|argv)\b/gu;
/**
 * (q) 入力の操作。`type` は、引数のある呼び出しだけ（`type()` は数えない）。T26g-1: `click` を足した。T30c: `uncheck`、`setChecked`、
 * `dispatchEvent`、`dblclick`、`tap`、`dragTo` を足した。
 */
const INPUT_OPERATIONS = /\.\s*(?:fill|press|pressSequentially|setInputFiles|check|uncheck|setChecked|selectOption|insertText|click|dblclick|tap|dragTo|dispatchEvent)\s*\(|\.\s*type\s*\((?!\s*\))|\bkeyboard\b/gu;
/** (q) の例外（ログインの入力の部品）。 */
const FORM_SUBMITTER_PATH = 'src/browser/login-form-submitter.ts';
/** (q) の例外（T30c: 書き込みの入力の部品）。 */
const WRITE_FORM_SUBMITTER_PATH = 'src/browser/write-form-submitter.ts';
/**
 * (q) の例外（T37c: 送らずに観察する probe の押す部品。凍結した Context で、候補の範囲の欄に合成の目印を入れ、`select` を選び、押す。Guard が凍結の段で
 * すべての要求を止める）。
 */
const SUBMISSION_PROBE_PATH = 'src/interaction/submission-probe.ts';
/**
 * (q) の例外（T39d: API のシナリオの書き込みの入力と押下の部品。書き込みの段の Context で、確かめた欄に値を入れ、`select` を選び、送信の要素を押す。
 * Guard の書き込みの段が送る中身を照らす）。
 */
const API_WRITE_SUBMITTER_PATH = 'src/browser/api-write-submitter.ts';
/** (q) 入力の操作を許すファイル（閉じた一覧。ちょうど 4 つ）。 */
const INPUT_OPERATION_OWNERS: ReadonlySet<string> = new Set([
  FORM_SUBMITTER_PATH, WRITE_FORM_SUBMITTER_PATH, SUBMISSION_PROBE_PATH, API_WRITE_SUBMITTER_PATH,
]);
/**
 * (q) `click` だけの例外（T26g-1）: 既存の Interaction の部品。隔離した Context で、読み取りだけの操作の候補を押す（値を入れない。要求は
 * Interaction の Guard が止める）。ここでも `click` のほかの入力の操作は許さない。
 */
const CLICK_ONLY_EXCEPTION_PATH = 'src/interaction/isolated-auditor.ts';
const CLICK_OPERATION = /^\.\s*click\s*\($/u;
/** (x) 入力の部品を参照してよいファイル（自動ログインの段）。 */
const AUTOMATED_LOGIN_PATH = 'src/worker/automated-login.ts';
const MANUAL_LOGIN_PATH = 'src/worker/authenticated-login.ts';
/** (x) 入力の部品のモジュールの名前。 */
const FORM_SUBMITTER_MODULE = /login-form-submitter/u;
/** (y) 自動ログインの段が参照しない、headed の起動にあたる識別子と参照（`bare` と `code` から）。 */
const HEADED_LAUNCH_BARE = /\b(?:LOGIN_BROWSER_HEADLESS|headless|chromium|chromiumLaunchOptions|launchPersistentContext)\b/gu;
const HEADED_LAUNCH_CODE = /authenticated-login|chromium-launch/gu;
/** (z) 入力の部品の、値を受ける引数の名前（固定）。 */
const LOGIN_SECRET_PARAMETER = 'loginSecret';
/** (z) 引数の宣言（`loginSecret: <型>`）。 */
const LOGIN_SECRET_DECLARATION = new RegExp(`(?<![\\w$.])${LOGIN_SECRET_PARAMETER}\\s*:`, 'gu');

const SOURCE_FILES = loadSourceFiles();
const WORKER_FILES = SOURCE_FILES.filter((file) => file.path.startsWith(WORKER_DIRECTORY));

/** (q) 入力の操作の一覧。 */
const findInputOperations = (source: ScannedSource): readonly string[] => [...source.bare.matchAll(INPUT_OPERATIONS)].map((match) => match[0]);

/** (x) 入力の部品への参照（コメントを除いた本文の、指定子と文字列）。 */
const refersToFormSubmitter = (source: ScannedSource): boolean => FORM_SUBMITTER_MODULE.test(source.code);

/** (y) headed の起動にあたる参照。 */
const findHeadedLaunchReferences = (source: ScannedSource): readonly string[] => [
  ...[...source.bare.matchAll(HEADED_LAUNCH_BARE)].map((match) => match[0]),
  ...[...source.code.matchAll(HEADED_LAUNCH_CODE)].map((match) => match[0]),
];

/**
 * (z) 値を受ける引数の、宣言と `.fill(` の引数の外での出現の数。宣言がなければ、引数の名前が変わった（検査が働かない）として 1 と数える。
 */
const countLoginSecretLeaks = (source: ScannedSource): number => {
  const declarations = [...source.bare.matchAll(LOGIN_SECRET_DECLARATION)].length;
  const insideFill = findCallSites(source.bare, 'fill')
    .filter(({ index }) => /\.\s*$/u.test(source.bare.slice(Math.max(0, index - 4), index)))
    .reduce((total, { argumentText }) => total + countIdentifier(argumentText, LOGIN_SECRET_PARAMETER), 0);
  const total = countIdentifier(source.bare, LOGIN_SECRET_PARAMETER);
  return declarations === 0 ? 1 : total - declarations - insideFill;
};

describe('Worker login hooks (T25d) and the single form input owner (T26d-1)', () => {
  it('reads the worker files, the login stages, and the form input owner', () => {
    expect(WORKER_FILES.map(({ path }) => path)).toEqual(expect.arrayContaining([ENTRY_PATH, ...HOOK_OWNER_PATHS, AUTOMATED_LOGIN_PATH]));
    expect(SOURCE_FILES.map(({ path }) => path)).toContain(FORM_SUBMITTER_PATH);
    expect(SOURCE_FILES.map(({ path }) => path)).toContain(WRITE_FORM_SUBMITTER_PATH);
  });

  it('(n) the production entry starts the worker process with no options (no test-only hook)', () => {
    const entry = WORKER_FILES.find(({ path }) => path === ENTRY_PATH);
    const calls = [...(entry?.bare ?? '').matchAll(ENTRY_CALL)].map((match) => (match[1] ?? '').trim());
    expect(calls).toEqual(['process']);
  });

  it('(o) src/worker/ reads neither environment variables nor process arguments', () => {
    const reads = WORKER_FILES.flatMap(({ path, bare }) => [...bare.matchAll(ENVIRONMENT_READS)].map((match) => `${path}: ${match[0]}`));
    expect(reads).toEqual([]);
  });

  it('(p) the test-only hook names appear only in the login stage and the process assembly', () => {
    // T26d-2: `src/worker/` の外の `src/`（契約、ジョブの管理など）にも現れない。
    const leaks = SOURCE_FILES
      .filter(({ path }) => !HOOK_OWNER_PATHS.has(path))
      .flatMap(({ path, bare }) => TEST_ONLY_HOOK_NAMES.filter((name) => new RegExp(`\\b${name}\\b`, 'u').test(bare)).map((name) => `${path}: ${name}`));
    expect(leaks).toEqual([]);
  });

  it('(q) src/ never types into the page, except the four input owners (login, write, the submission probe and the API write)', () => {
    expect([...INPUT_OPERATION_OWNERS]).toEqual([
      'src/browser/login-form-submitter.ts', 'src/browser/write-form-submitter.ts', 'src/interaction/submission-probe.ts',
      'src/browser/api-write-submitter.ts',
    ]);
    const operations = SOURCE_FILES
      .filter(({ path }) => !INPUT_OPERATION_OWNERS.has(path))
      .flatMap((file) => findInputOperations(file)
        .filter((operation) => !(file.path === CLICK_ONLY_EXCEPTION_PATH && CLICK_OPERATION.test(operation)))
        .map((operation) => `${file.path}: ${operation}`));
    expect(operations).toEqual([]);
    // click の例外のファイルが、実際に click を使う（例外の一覧が古くなっていない）。
    const clickOwner = SOURCE_FILES.find(({ path }) => path === CLICK_ONLY_EXCEPTION_PATH);
    expect(findInputOperations(clickOwner ?? scanSource('')).some((operation) => CLICK_OPERATION.test(operation))).toBe(true);
    // 例外のファイルが、実際に値を入れる（例外の一覧が古くなっていない）。
    const owner = SOURCE_FILES.find(({ path }) => path === FORM_SUBMITTER_PATH);
    expect(findInputOperations(owner ?? scanSource(''))).toContain('.fill(');
    expect(findInputOperations(owner ?? scanSource(''))).toContain('.click(');
    // T30c: 書き込みの入力の部品も、実際に値を入れて押す（例外の一覧が古くなっていない）。
    const writeOwner = SOURCE_FILES.find(({ path }) => path === WRITE_FORM_SUBMITTER_PATH);
    for (const operation of ['.fill(', '.selectOption(', '.check(', '.uncheck(', '.click(']) {
      expect(findInputOperations(writeOwner ?? scanSource('')), operation).toContain(operation);
    }
    // T37c: 送らずに観察する probe の押す部品も、実際に目印を入れ、選び、押す（例外の一覧が古くなっていない）。ほかの入力の操作（check など）は使わない。
    const probeOwner = SOURCE_FILES.find(({ path }) => path === SUBMISSION_PROBE_PATH);
    expect([...new Set(findInputOperations(probeOwner ?? scanSource('')))].sort()).toEqual(['.click(', '.fill(', '.selectOption(']);
    // T39d: API の書き込みの入力と押下の部品も、`fill`・`selectOption`・`click` だけを使う（ほかの入力の操作は使わない）。
    const apiWriteOwner = SOURCE_FILES.find(({ path }) => path === API_WRITE_SUBMITTER_PATH);
    expect([...new Set(findInputOperations(apiWriteOwner ?? scanSource('')))].sort()).toEqual(['.click(', '.fill(', '.selectOption(']);
  });

  it('(x) only the automated login stage refers to the form input owner (the manual login stage does not)', () => {
    const referrers = SOURCE_FILES
      .filter((file) => file.path !== FORM_SUBMITTER_PATH && refersToFormSubmitter(file))
      .map(({ path }) => path);
    expect(referrers).toEqual([AUTOMATED_LOGIN_PATH]);
    expect(referrers).not.toContain(MANUAL_LOGIN_PATH);
  });

  it('(y) the automated login stage never refers to the headed launch', () => {
    const automated = SOURCE_FILES.find(({ path }) => path === AUTOMATED_LOGIN_PATH);
    expect(automated).toBeDefined();
    expect(findHeadedLaunchReferences(automated ?? scanSource(''))).toEqual([]);
  });

  it('(z) the secret parameter of the form input owner appears only in its declaration and in .fill( arguments', () => {
    const owner = SOURCE_FILES.find(({ path }) => path === FORM_SUBMITTER_PATH);
    expect(owner).toBeDefined();
    expect(countLoginSecretLeaks(owner ?? scanSource(''))).toBe(0);
    expect(countIdentifier(owner?.bare ?? '', LOGIN_SECRET_PARAMETER)).toBeGreaterThan(0);
  });

  it('detects the patterns (detector self-check)', () => {
    expect('process.env.X'.match(ENVIRONMENT_READS)).toHaveLength(1);
    expect([...'runAuditWorkerProcess(process, { loginStage })'.matchAll(ENTRY_CALL)].map((match) => match[1])).toEqual(['process, { loginStage }']);
    // (q) 違反の例（RED になる）と、違反でない例。
    for (const line of [
      "await page.fill('#pass', value);",
      "await locator.type('x');",
      'await page.keyboard.type("x");',
      'await page.keyboard.insertText(value);',
      "await page.press('#user', 'Enter');",
      "await locator.pressSequentially('x');",
      'await locator.check();',
      "await locator.selectOption('a');",
      "await locator.setInputFiles('a.txt');",
      'await locator . fill ( value );',
      // T26g-1（M2）: click
      "await page.click('#go');",
      'await target.submit.click({ timeout });',
      'await locator . click ( );',
      // T30c: uncheck、setChecked、dispatchEvent、dblclick、tap、dragTo
      'await locator.uncheck();',
      'await locator.setChecked(true);',
      "await locator.dispatchEvent('click');",
      'await locator.dblclick();',
      'await locator.tap();',
      'await locator.dragTo(target);',
    ]) {
      expect(findInputOperations(scanSource(line)).length, line).toBeGreaterThan(0);
    }
    for (const line of [
      'const kind = message.type();',
      "const name = 'keyboard';",
      '// await page.fill(value);',
      'const filled = isFilled(value);',
    ]) {
      expect(findInputOperations(scanSource(line)), line).toEqual([]);
    }
    // (x)
    for (const line of [
      "import { inspectLoginForm } from '../browser/login-form-submitter.js';",
      "const m = await import('../browser/login-form-submitter.js');",
      "export * from '../browser/login-form-submitter.js';",
    ]) {
      expect(refersToFormSubmitter(scanSource(line)), line).toBe(true);
    }
    expect(refersToFormSubmitter(scanSource('// the login-form-submitter is the only owner'))).toBe(false);
    // (y)
    for (const line of [
      "import { LOGIN_BROWSER_HEADLESS } from './authenticated-login.js';",
      'const browser = await chromium.launch({ headless: false });',
      'const options = chromiumLaunchOptions({ headless: false });',
      "import { chromiumLaunchOptions } from '../browser/chromium-launch.js';",
    ]) {
      expect(findHeadedLaunchReferences(scanSource(line)).length, line).toBeGreaterThan(0);
    }
    expect(findHeadedLaunchReferences(scanSource('const browser = await dependencies.launchAutomatedLoginBrowser(); // headless'))).toEqual([]);
    // (z)
    const ok = scanSource([
      'export async function fillLoginForm(target: LoginFormTarget, loginSecret: LoginFormSecret): Promise<void> {',
      '  await target.username.fill(loginSecret.username, { timeout });',
      '  await target.password.fill(loginSecret.password, { timeout });',
      '}',
    ].join('\n'));
    expect(countLoginSecretLeaks(ok)).toBe(0);
    for (const line of [
      'await page.evaluate((value) => { input.value = value; }, loginSecret.password);',
      'const { username } = loginSecret;',
      'const copy = loginSecret;',
      'await target.username.fill(other.username); keep(loginSecret);',
      'await target.username.fill(loginSecret.username); send(loginSecret.password);',
    ]) {
      const source = scanSource(`function f(loginSecret: LoginFormSecret) {\n${line}\n}`);
      expect(countLoginSecretLeaks(source), line).toBeGreaterThan(0);
    }
    // 引数の名前を変えた（宣言がない）なら、検査が働かないので違反とする。
    expect(countLoginSecretLeaks(scanSource('function f(value: LoginFormSecret) { return value; }'))).toBeGreaterThan(0);
  });
});
