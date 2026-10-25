/**
 * TS-g（設計書 `2026-10-24-beaksight-test-suite-tiers-design.md` 6 章の TS-g の行。ユーザーの指示「テストでheadedで動作させているものはheadlessに
 * 変えてもいい。監査本体はheadedのままで」）: 画面のテストのジョブのブラウザを headless に保つ Gate。
 * - 画面のテスト（`apps/local-ui/tests/**`）が一時の root に書くワーカーの入口で、`runAuditWorkerProcess(process, {…})` を呼ぶものは、テストだけの口
 *   `hideJobBrowser: true` を持つ（口のない `runAuditWorkerProcess(process)` も誤り）。プロファイルの表示の設定の既定は「表示」（FM-2）なので、口が
 *   ないと、ジョブのブラウザが headed で開く（TS-g の調べで、8 ファイルが headed で開いていた）。
 * - 入口の本文を作る共用の補助（`tests/helpers/test-login-worker-entry.ts` の `testLoginWorkerEntrySource`、`tests/helpers/auto-login-worker-entry.ts` の
 *   `autoLoginWorkerEntrySource`）を画面のテストから呼ぶときも、引数に `hideJobBrowser: true` を持つ（`additionalHooks` で渡す）。
 * - 製品の既定（ジョブのブラウザの表示、手動のログインの画面の headed）は変えない（`tests/unit/worker-login-browser-launch.test.ts` などが確かめる）。
 * - 判定は、コメントを除いた本文（`source-scan.ts` の `code`。文字列は残す）の正規表現と文字列の検索だけ（近似）。1 秒以内に終える。
 */
import { describe, expect, it } from 'vitest';
import { MAX_GATE_MS, readTypeScriptFilesUnder, scanSource, startCpuStopwatch } from './source-scan.js';

const UI_TESTS_DIRECTORY = 'apps/local-ui/tests';
/**
 * ワーカーの process の組み立ての呼び出し（入口の本文の中。文字列の中にも現れる）。文字列の中の改行の書き方（`\n`）の直後も数える（`\nrunAudit…` は
 * `\b` で区切れないため）。
 */
const ENTRY_CALL = /(?:(?<=\\n)|(?<![\w$]))runAuditWorkerProcess\s*\(\s*process\b/gu;
/** 入口の本文を作る共用の補助の呼び出し。 */
const ENTRY_BUILDER_CALL = /\b(?:testLoginWorkerEntrySource|autoLoginWorkerEntrySource)\s*\(/gu;
/** テストだけの口（ジョブのブラウザを表示しない）。 */
const HIDE_JOB_BROWSER = /\bhideJobBrowser\s*:\s*true\b/u;
/** 呼び出しの終わりの目安（オブジェクトの引数を閉じる `});`）。 */
const CALL_END = '});';

/** 1 つの呼び出しの場所と、口を持つか。 */
interface EntryCallSite {
  readonly place: string;
  readonly hidesJobBrowser: boolean;
}

/** 呼び出しの始まりから、引数の終わりの目安までの本文（口のない `(process)` は空）。 */
const callTextAt = (code: string, start: number, matchedLength: number): string => {
  const rest = code.slice(start + matchedLength);
  if (/^\s*\)/u.test(rest)) {
    return '';
  }
  const end = code.indexOf(CALL_END, start);
  return end < 0 ? code.slice(start) : code.slice(start, end + CALL_END.length);
};

/** 本文（コメントを除いたもの）の中の、入口の呼び出しと、入口の本文を作る補助の呼び出しの一覧。 */
export const findEntryCallSites = (path: string, code: string): readonly EntryCallSite[] => {
  const sites: EntryCallSite[] = [];
  for (const pattern of [ENTRY_CALL, ENTRY_BUILDER_CALL]) {
    for (const match of code.matchAll(pattern)) {
      const line = code.slice(0, match.index).split('\n').length;
      sites.push({ place: `${path}:${line}`, hidesJobBrowser: HIDE_JOB_BROWSER.test(callTextAt(code, match.index, match[0].length)) });
    }
  }
  return sites;
};

describe('TS-g: the workers of the UI tests launch the job browser headless', () => {
  it('finds the entry calls and whether they hide the job browser (self-check of the finder)', () => {
    const code = [
      "const a = 'import { runAuditWorkerProcess } from \\'./x.js\\';\\nrunAuditWorkerProcess(process, { hideJobBrowser: true });';",
      'const b = String.raw`',
      'runAuditWorkerProcess(process, {',
      '  loginStage: { launchLoginBrowser: async () => { throw new Error(\'no\'); } },',
      '});',
      '`;',
      "const c = 'runAuditWorkerProcess(process);';",
      "const d = testLoginWorkerEntrySource({ distPrefix: './', additionalHooks: '\\n  hideJobBrowser: true,' });",
      "const e = testLoginWorkerEntrySource({ distPrefix: './' });",
      "const f = autoLoginWorkerEntrySource({ launch: 'cli' });",
    ].join('\n');
    expect(findEntryCallSites('sample.ts', code)).toEqual([
      { place: 'sample.ts:1', hidesJobBrowser: true },
      { place: 'sample.ts:3', hidesJobBrowser: false },
      { place: 'sample.ts:7', hidesJobBrowser: false },
      { place: 'sample.ts:8', hidesJobBrowser: true },
      { place: 'sample.ts:9', hidesJobBrowser: false },
      { place: 'sample.ts:10', hidesJobBrowser: false },
    ]);
    // コメントの中の呼び出しは数えない（`code` はコメントを空白にする）。
    expect(findEntryCallSites('comment.ts', scanSource('// runAuditWorkerProcess(process, {\nconst x = 1;\n').code)).toEqual([]);
  });

  it('every worker entry written by the UI tests passes hideJobBrowser: true', () => {
    const stopwatch = startCpuStopwatch();
    const sites = readTypeScriptFilesUnder(UI_TESTS_DIRECTORY)
      .filter(({ content }) => content.includes('runAuditWorkerProcess') || content.includes('WorkerEntrySource'))
      .flatMap(({ path, content }) => findEntryCallSites(path, scanSource(content).code));
    // 近似の検査が空回りしないこと（今の入口の 3 か所: 表示しない既定の入口、手動のログインの入口、自動ログインの入口）。
    const places = sites.map(({ place }) => place.replace(/:\d+$/u, ''));
    expect(places).toEqual(expect.arrayContaining([
      `${UI_TESTS_DIRECTORY}/helpers/local-server.ts`,
      `${UI_TESTS_DIRECTORY}/helpers/auth-worker.ts`,
    ]));
    expect(places.filter((place) => place === `${UI_TESTS_DIRECTORY}/helpers/auth-worker.ts`)).toHaveLength(2);
    expect(sites.filter(({ hidesJobBrowser }) => !hidesJobBrowser).map(({ place }) => place)).toEqual([]);
    expect(stopwatch.elapsedMs()).toBeLessThan(MAX_GATE_MS);
  });
});
