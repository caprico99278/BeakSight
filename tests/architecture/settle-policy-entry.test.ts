/**
 * 落ち着きの待ちの指定（`settlePolicy`。`DiscoverySettlePolicy`）の本番の入口の Architecture Gate（SR-1-F。PRE42 の安全の組の独立のレビュー SR-1 の
 * Minor-2）。TS-bc で、落ち着きの期限をテストだけが渡す任意の `settlePolicy` で注入できるようにした。本番の側で、その値を IPC やほかの外の値から
 * 作らないこと（製品の既定 5 秒を変えない）を止める。判定は `fs`、正規表現、文字列の走査だけ（`source-scan.ts`）。近似の検査である。
 * - (a) `src/` で `settlePolicy` の名前を書くのは、閉じた一覧（`SETTLE_POLICY_FILES`）のファイルだけ。一覧のファイルは、どれも今も書く（使われなく
 *   なった一覧の行は誤り）。ワーカーの入口や IPC の受け取り（`src/worker/audit-worker-session.ts` など）は、一覧にない。
 * - (b) `settlePolicy:` の値は、既定の定数（`…SETTLE_POLICY` の名前）、`request.settlePolicy`・`options.settlePolicy` の受け渡し、条件で既定の定数か
 *   `undefined` のどちらかを選ぶ式、だけ。型の注釈（`DiscoverySettlePolicy`、`| undefined`）と、既定の定数を既定の値にした引数は、値の決まりの外。
 *   `settlePolicy` という名前の変数を宣言しない（省略の形 `{ settlePolicy }` で、作った値を渡さない）。
 * - (c) 落ち着きの待ちの指定の値（`DiscoverySettlePolicy = Object.freeze(`）を作るのは、モジュールの先頭の、大文字の名前の定数だけ。
 * - (d) IPC の契約（`src/control/worker-protocol.ts`）と、ワーカーの IPC の Schema（`schemas/control/worker-message.schema.json`）に、落ち着きの待ちの
 *   項目がない（`settle` の語を含まない）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPOSITORY_ROOT, loadSourceFiles, scanSource, sourceFileAt, type SourceFile } from './source-scan.js';

const SOURCE_FILES = loadSourceFiles();

/** (a) `settlePolicy` の名前を書いてよいファイル（発見・READ・入口の確かめ・書き込みの流れの、落ち着きの待ちの受け渡し）。 */
const SETTLE_POLICY_FILES: readonly string[] = Object.freeze([
  'src/discovery/discover-page.ts',
  'src/discovery/read-executor.ts',
  'src/worker/discovery-run.ts',
  'src/worker/entry-check-page.ts',
  'src/worker/entry-check-run.ts',
  'src/worker/read-check-run.ts',
  'src/worker/write-create-run.ts',
]);
/** (d) IPC の契約と、ワーカーの IPC の Schema。 */
const WORKER_PROTOCOL = 'src/control/worker-protocol.ts';
const WORKER_MESSAGE_SCHEMA = 'schemas/control/worker-message.schema.json';

const SETTLE_POLICY_NAME = /\bsettlePolicy\b/u;
/** (b) `settlePolicy:`（`?:` を含む）の右側（`bare` に当てる。`,`・`;`・`)`・`}`・行の終わりまで）。 */
const SETTLE_POLICY_MEMBER = /\bsettlePolicy\s*\??\s*:\s*([^,;)}\n]+)/gu;
/** (b) 型の注釈の形（既定の値は、既定の定数だけ）。 */
const TYPE_FORM = /^DiscoverySettlePolicy(?:\s*\|\s*undefined)?(?:\s*=\s*[A-Z][A-Z0-9_]*SETTLE_POLICY)?$/u;
/** (b) 値の形。 */
const VALUE_FORMS: readonly RegExp[] = [
  /^[A-Z][A-Z0-9_]*SETTLE_POLICY$/u,
  /^(?:request|options)\.settlePolicy$/u,
  /^[\w$.]+\s*\?\s*[A-Z][A-Z0-9_]*SETTLE_POLICY\s*:\s*undefined$/u,
];
/** (b) `settlePolicy` という名前の変数の宣言。 */
const SETTLE_POLICY_DECLARATION = /\b(?:const|let|var)\s+settlePolicy\b/gu;
/** (c) 落ち着きの待ちの指定の値を作る所と、そのうちモジュールの先頭の大文字の名前の定数。 */
const POLICY_CONSTRUCTION = /\bDiscoverySettlePolicy\s*=\s*Object\.freeze\s*\(/gu;
const POLICY_CONSTANT = /^(?:export\s+)?const\s+[A-Z][A-Z0-9_]*\s*:\s*DiscoverySettlePolicy\s*=\s*Object\.freeze\s*\(/gmu;

/** (b) 決まりに反する `settlePolicy:` の右側の一覧（`<ファイル>: <右側>`）。 */
const memberViolations = (files: readonly Pick<SourceFile, 'path' | 'bare'>[]): readonly string[] =>
  files.flatMap((file) => [
    ...[...file.bare.matchAll(SETTLE_POLICY_MEMBER)]
      .map(([, value = '']) => value.trim())
      .filter((value) => !TYPE_FORM.test(value) && !VALUE_FORMS.some((form) => form.test(value)))
      .map((value) => `${file.path}: settlePolicy: ${value}`),
    ...[...file.bare.matchAll(SETTLE_POLICY_DECLARATION)].map(() => `${file.path}: a variable named settlePolicy`),
  ]);

/** (c) モジュールの先頭の定数でない所で作る、落ち着きの待ちの指定の数（`<ファイル>: <数>`）。 */
const constructionViolations = (files: readonly Pick<SourceFile, 'path' | 'bare'>[]): readonly string[] =>
  files.flatMap((file) => {
    const extra = [...file.bare.matchAll(POLICY_CONSTRUCTION)].length - [...file.bare.matchAll(POLICY_CONSTANT)].length;
    return extra > 0 ? [`${file.path}: ${String(extra)}`] : [];
  });

/** (a) 一覧の外で `settlePolicy` の名前を書くファイル。 */
const outsideFiles = (files: readonly Pick<SourceFile, 'path' | 'bare'>[]): readonly string[] =>
  files.filter((file) => !SETTLE_POLICY_FILES.includes(file.path) && SETTLE_POLICY_NAME.test(file.bare)).map((file) => file.path);

const asFile = (path: string, source: string): Pick<SourceFile, 'path' | 'bare'> => ({ path, bare: scanSource(source).bare });

describe('settle policy entry detectors (SR-1-F)', () => {
  it('detects a settle policy taken from the worker message or built in place', () => {
    const fromMessage = asFile('src/worker/audit-worker-session.ts', [
      'const request: DiscoveryRunRequest = {',
      '  config, jobId: message.jobId, settlePolicy: message.settlePolicy,',
      '};',
    ].join('\n'));
    expect(outsideFiles([fromMessage])).toEqual(['src/worker/audit-worker-session.ts']);
    expect(memberViolations([fromMessage])).toEqual(['src/worker/audit-worker-session.ts: settlePolicy: message.settlePolicy']);
    const built = asFile('src/worker/discovery-run.ts', [
      'await readCandidatePage(page, { requestCounter: counter, settlePolicy: { ...DISCOVERY_SETTLE_POLICY, timeoutMs: 1 } });',
      'const settlePolicy = Object.freeze({ timeoutMs: 1 });',
      'const quick: DiscoverySettlePolicy = Object.freeze({ ...DISCOVERY_SETTLE_POLICY, timeoutMs: 1 });',
      'function read(policy: DiscoverySettlePolicy = Object.freeze({ ...DISCOVERY_SETTLE_POLICY })) {}',
    ].join('\n'));
    expect(memberViolations([built])).toEqual([
      'src/worker/discovery-run.ts: settlePolicy: { ...DISCOVERY_SETTLE_POLICY',
      'src/worker/discovery-run.ts: a variable named settlePolicy',
    ]);
    expect(constructionViolations([built])).toEqual(['src/worker/discovery-run.ts: 2']);
  });

  it('allows the default constants, the pass-through of the request, the type annotations, and ignores comments and strings', () => {
    const allowed = asFile('src/worker/read-check-run.ts', [
      'type Options = Visit & { readonly settlePolicy?: DiscoverySettlePolicy | undefined };',
      'function settle(page: Page, settlePolicy: DiscoverySettlePolicy = DISCOVERY_SETTLE_POLICY) {}',
      'const options = { settlePolicy: request.settlePolicy, other: options.settlePolicy };',
      'await read(page, { requestCounter: counter, settlePolicy: options.settlePolicy });',
      'await read(page, { settlePolicy: quiet.quietTimedOut ? BUSY_PAGE_CANDIDATE_SETTLE_POLICY : undefined });',
      'await read(page, { settlePolicy: DISCOVERY_SETTLE_POLICY });',
      'const BUSY_SETTLE_POLICY: DiscoverySettlePolicy = Object.freeze({ ...DISCOVERY_SETTLE_POLICY, timeoutMs: 1 });',
      '// settlePolicy: message.settlePolicy',
      "const text = 'settlePolicy: { timeoutMs: 1 }';",
    ].join('\n'));
    expect(memberViolations([allowed])).toEqual([]);
    expect(constructionViolations([allowed])).toEqual([]);
  });
});

describe('settle policy entry (SR-1-F)', () => {
  it('(a) only the closed list of files names settlePolicy in src/, and every file in the list still does', () => {
    expect(outsideFiles(SOURCE_FILES)).toEqual([]);
    expect(SETTLE_POLICY_FILES.filter((path) => !SETTLE_POLICY_NAME.test(sourceFileAt(SOURCE_FILES, path).bare))).toEqual([]);
  });

  it('(b) gives settlePolicy only a default constant or the value of the request, and (c) builds settle policies only as named constants', () => {
    expect(memberViolations(SOURCE_FILES)).toEqual([]);
    expect(constructionViolations(SOURCE_FILES)).toEqual([]);
    // 走査が空でない（受け渡しと、既定の定数を選ぶ式がある）。
    const members = SETTLE_POLICY_FILES.flatMap((path) => [...sourceFileAt(SOURCE_FILES, path).bare.matchAll(SETTLE_POLICY_MEMBER)]);
    expect(members.some(([, value = '']) => value.trim() === 'request.settlePolicy')).toBe(true);
    expect(members.some(([, value = '']) => VALUE_FORMS[2]?.test(value.trim()) === true)).toBe(true);
  });

  it('(d) the IPC contract and the worker message schema have no settle item', () => {
    expect(/settle/iu.test(sourceFileAt(SOURCE_FILES, WORKER_PROTOCOL).content)).toBe(false);
    expect(/settle/iu.test(readFileSync(join(REPOSITORY_ROOT, WORKER_MESSAGE_SCHEMA), 'utf8'))).toBe(false);
  });
});
