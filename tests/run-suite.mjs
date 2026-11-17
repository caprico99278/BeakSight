/**
 * テストの組を流す起動の部品（TS-a。設計書 `doc/design/2026-10-24-beaksight-test-suite-tiers-design.md` 3.1）。
 * 使い方: `node tests/run-suite.mjs <safety|full|chromium-upgrade> [Vitest の引数...]`（npm の `test:safety`・`test:full` から呼ぶ。`chromium-upgrade` は
 * Chromium・Playwright の版を上げるときに流す）。
 * TEST-TIME-A: `node tests/run-suite.mjs related [--list] [変えたファイル...]` は、変えたファイルに関係するテストだけを流す（下の `relatedSteps`）。
 *
 * - ファイルの一覧は `tests/suites.ts`、CLI の回と全部の組の環境変数は `tests/helpers/test-run-environment.ts` から読む（Node の型の取り除きで、
 *   そのまま読む）。scripts に書き写さない。
 * - 環境変数は、この部品が子のプロセスに渡す（`cross-env` などの依存を足さず、Git Bash と PowerShell の両方で同じに動く）。既定の Chromium の回では、
 *   呼び出した側に CLI の回の環境変数があっても外す（SLIM-B0: 両方の Chromium に広げる環境変数も、呼び出した側の値を外し、広げる回だけ渡す）。TS-b: 全部の組（`full`）は、どの回にも全部の組の環境変数（`BEAKSIGHT_TEST_TIER=full`。回数を
 *   重ねるテストを今の回数で流す）を渡す。`safety` は渡さない（呼び出した側の値を、そのまま子に渡す）。
 * - 回を順に流し、途中の回が失敗しても残りの回を流す。終わりに回ごとの終了コードを出し、どれかが失敗すれば 1 で終わる。中断（Ctrl+C）の後は、
 *   次の回を始めない。
 * - 後ろに付けた引数は、どの回の Vitest にも渡す。`--outputFile=<path>`（`--outputFile.<reporter>=<path>` と、値を次の引数に置く形を含む）は、
 *   回ごとに別のファイルになるよう、拡張子の前に回の名前を足す（例: `out.json` → `out.safety-cli.json`）。
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BOTH_CHROMIUM_LEAK_CHECK_FILES,
  CHROMIUM_UPGRADE_TEST_FILES,
  CLI_CHROMIUM_TEST_FILES,
  CONTRACT_PATH_TEST_FILES,
  CONTRACT_PORT_TEST_FILES,
  SAFETY_TEST_FILES,
} from './suites.ts';
import { changedFilesOf, selectRelatedTests } from './related-tests.mjs';
import { BOTH_CHROMIUM_RUN_ENVIRONMENT, CLI_CHROMIUM_RUN_ENVIRONMENT, FULL_TEST_TIER_RUN_ENVIRONMENT } from './helpers/test-run-environment.ts';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VITEST_ENTRY = join(dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs');
const UI_CONFIG = 'apps/local-ui/vitest.config.ts';

const CLI_RUN = { id: 'safety-cli', label: 'CLI の回（CLI の Chromium）', args: [...CLI_CHROMIUM_TEST_FILES], environment: CLI_CHROMIUM_RUN_ENVIRONMENT };

/** 回の一覧の、どの回にも `environment` を足す（同じ名前があれば、回の値を使う）。 */
const withEnvironment = (environment, steps) => steps.map((step) => ({ ...step, environment: { ...environment, ...step.environment } }));

const SAFETY_DEFAULT_RUN = { id: 'safety-default', label: '安全の一覧（既定の Chromium）', args: [...SAFETY_TEST_FILES], environment: {} };

/**
 * 組ごとの回（順に流す）。SLIM-B0: `safety` は、2 つの Chromium の組を両方に広げる（`BOTH_CHROMIUM_RUN_ENVIRONMENT`）。`full` は広げない（組は CLI の
 * 起動の設定の 1 つ）。SLIM-GROUP: `chromium-upgrade`（Chromium・Playwright の版を上げるとき）は、版を上げるときの束（`CHROMIUM_UPGRADE_TEST_FILES`。
 * 区切りの遅い組では流さない「誤って違反・失敗にしない」確かめ）と、安全の一覧の 2 回を、両方の Chromium に広げて流す。
 * RB-3: 初めに、ずれの確かめ（`tests/contract/`）を流す。口の操作ごとは、テストの既定の Chromium の回と CLI の Chromium の回の 2 回、通り道ごとは
 * 両方に広げた 1 回（ファイルの中で 2 つの Chromium）。
 */
const SUITES = {
  safety: withEnvironment(BOTH_CHROMIUM_RUN_ENVIRONMENT, [SAFETY_DEFAULT_RUN, CLI_RUN]),
  'chromium-upgrade': withEnvironment(BOTH_CHROMIUM_RUN_ENVIRONMENT, [
    { id: 'contract', label: 'ずれの確かめ（既定の Chromium。通り道ごとは両方の Chromium）', args: [...CONTRACT_PORT_TEST_FILES, ...CONTRACT_PATH_TEST_FILES], environment: {} },
    { id: 'contract-cli', label: 'ずれの確かめの口の操作ごと（CLI の Chromium）', args: [...CONTRACT_PORT_TEST_FILES], environment: CLI_CHROMIUM_RUN_ENVIRONMENT },
    { id: 'chromium-upgrade', label: 'Chromium の版を上げるときの束', args: [...CHROMIUM_UPGRADE_TEST_FILES], environment: {} },
    SAFETY_DEFAULT_RUN,
    CLI_RUN,
  ]),
  full: withEnvironment(FULL_TEST_TIER_RUN_ENVIRONMENT, [
    { id: 'root', label: 'ルートの全部（unit・integration・heavy。既定の Chromium）', args: [], environment: {} },
    CLI_RUN,
    { id: 'ui', label: '画面のテスト', args: ['--config', UI_CONFIG], environment: {} },
  ]),
};

const OUTPUT_FILE_OPTION = /^(--outputFile(?:\.[A-Za-z-]+)?)(=(.*))?$/u;

function withStepName(path, stepId) {
  const extension = extname(path);
  return `${path.slice(0, path.length - extension.length)}.${stepId}${extension}`;
}

/** 後ろに付けた引数の、出力のファイルの指定を回ごとに分ける。 */
function argumentsForStep(extra, stepId) {
  const result = [];
  for (let index = 0; index < extra.length; index += 1) {
    const argument = extra[index];
    const match = OUTPUT_FILE_OPTION.exec(argument);
    if (match === null) {
      result.push(argument);
    } else if (match[2] !== undefined) {
      result.push(`${match[1]}=${withStepName(match[3], stepId)}`);
    } else if (index + 1 < extra.length) {
      result.push(argument, withStepName(extra[index + 1], stepId));
      index += 1;
    } else {
      result.push(argument);
    }
  }
  return result;
}

function environmentForStep(environment) {
  const merged = { ...process.env };
  for (const name of [...Object.keys(CLI_CHROMIUM_RUN_ENVIRONMENT), ...Object.keys(BOTH_CHROMIUM_RUN_ENVIRONMENT)]) {
    delete merged[name];
  }
  return { ...merged, ...environment };
}

let interrupted = false;
process.on('SIGINT', () => {
  interrupted = true;
});

function runStep(step, extra) {
  const args = [VITEST_ENTRY, step.command ?? 'run', ...step.args, ...argumentsForStep(extra, step.id)];
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, args, { cwd: REPOSITORY_ROOT, env: environmentForStep(step.environment), stdio: 'inherit' });
    child.on('error', (error) => {
      console.error(`[run-suite] ${step.label}: Vitest を起動できませんでした: ${error.message}`);
      resolvePromise(1);
    });
    child.on('exit', (code, signal) => {
      if (signal !== null) {
        interrupted = true;
      }
      resolvePromise(code ?? 1);
    });
  });
}

/**
 * TEST-TIME-A・SLIM-1: `related` の組（変えたファイルに関係するテスト。選び方は `related-tests.mjs`）。`--` で始まらない引数は変えたファイル（省略は
 * Git の表示から）。既定は速い組だけを流す。`--slow` は遅い組だけ（区切りに流す。CLI の回を含む）、`--with-safety` は安全の一覧を必ず足して遅い組を
 * 流す（安全の不具合の束）。`--list` は、速い組と遅い組の一覧を出すだけで流さない。ほかの `--` の引数（`--reporter=verbose` のように値を `=` で
 * つなぐ）は、どの回の Vitest にも渡す。
 * SLIM-B0: 遅い組の 2 つの Chromium の組（`tests/helpers/chromium.ts` の `chromiumRunsOf`）は、CLI の起動の設定（本番）の 1 つだけで流す。
 * `--both-chromium`（Guard・中継・起動の部品を変えた束、Chromium の版を上げるとき）と `--with-safety`（安全の不具合の束）は、両方の Chromium に
 * 広げて遅い組を流す（どの回にも `BOTH_CHROMIUM_RUN_ENVIRONMENT` を渡す）。
 */
const RELATED_FLAGS = Object.freeze(['--list', '--slow', '--with-safety', '--both-chromium']);

async function relatedSteps(args) {
  const listOnly = args.includes('--list');
  const withSafety = args.includes('--with-safety');
  const bothChromium = withSafety || args.includes('--both-chromium');
  const runSlow = bothChromium || args.includes('--slow');
  const files = args.filter((argument) => !argument.startsWith('--'));
  const changed = changedFilesOf(REPOSITORY_ROOT, files);
  const selection = await selectRelatedTests(REPOSITORY_ROOT, changed, UI_CONFIG, { withSafety });
  const noteOf = (file) => {
    if (SAFETY_TEST_FILES.includes(file)) {
      return '（安全の一覧）';
    }
    return BOTH_CHROMIUM_LEAK_CHECK_FILES.includes(file) ? '（漏れの確かめの一覧。両方に広げる回では、ファイルの中で 2 つの Chromium を流す）' : '';
  };
  const cliFiles = [...selection.fast.root, ...selection.slow.root].filter((file) => CLI_CHROMIUM_TEST_FILES.includes(file));
  console.log(`[run-suite] related: 変えたファイル ${changed.length} 件`);
  if (selection.ledgerMatched.length > 0) {
    console.log(`[run-suite] related: 台帳の部品に入るファイル ${selection.ledgerMatched.length} 件は、台帳の組だけを選びました（${selection.ledgerMatched.join('・')}）。`);
  }
  for (const [name, group] of [['速い組', selection.fast], ['遅い組', selection.slow]]) {
    console.log(`[run-suite] related: ${name} ルートのテスト ${group.root.length} 件、画面のテスト ${group.ui.length} 件`);
    for (const file of [...group.root, ...group.ui]) {
      console.log(`  ${file}${noteOf(file)}`);
    }
  }
  if (selection.upgrade.length > 0) {
    console.log(bothChromium
      ? `[run-suite] related: Chromium の版を上げるときの束 ${selection.upgrade.length} 件も、遅い組に足して両方の Chromium で流します（${selection.upgrade.join('・')}）。`
      : `[run-suite] related: Chromium の版を上げるときの束 ${selection.upgrade.length} 件は流しません（--both-chromium か chromium-upgrade で流します。${selection.upgrade.join('・')}）。`);
  }
  if (selection.builtProductTests.length > 0) {
    console.log(`[run-suite] related: ビルドした本番を動かすテスト ${selection.builtProductTests.length} 件は、通る部品の印か、本番の入口からのたどりで選びました。`);
  }
  if (cliFiles.length > 0) {
    console.log(`[run-suite] related: CLI の回の一覧のファイル ${cliFiles.length} 件は、遅い組で CLI の Chromium の回でも流します。`);
  }
  if (selection.fast.ui.length + selection.slow.ui.length > 0) {
    console.log('[run-suite] related: 画面のテストを流す前に、`npm run build` と `npm run build:ui` が要ります。');
  }
  if (runSlow) {
    console.log(bothChromium
      ? '[run-suite] related: 2 つの Chromium の組は、両方の Chromium で流します（--both-chromium・--with-safety）。'
      : '[run-suite] related: 2 つの Chromium の組は、CLI の起動の設定の 1 つだけで流します（両方に広げるのは --both-chromium・--with-safety）。');
  }
  if (listOnly) {
    return [];
  }
  const absolute = (paths) => paths.map((path) => resolve(REPOSITORY_ROOT, path).replaceAll('\\', '/'));
  const stepsOf = (id, label, group) => [
    ...(group.root.length > 0 ? [{ id: `${id}-root`, label: `${label}（ルート。既定の Chromium）`, args: absolute(group.root), environment: {} }] : []),
    ...(group.ui.length > 0 ? [{ id: `${id}-ui`, label: `${label}（画面）`, args: [...absolute(group.ui), '--config', UI_CONFIG], environment: {} }] : []),
  ];
  // SLIM-GROUP: 両方に広げる回では、選ばれた Chromium の版を上げるときの束も、遅い組のルートの回に足す。
  const slowGroup = bothChromium ? { root: [...selection.slow.root, ...selection.upgrade], ui: selection.slow.ui } : selection.slow;
  const slowSteps = [...stepsOf('related-slow', '関係する遅い組', slowGroup), ...(cliFiles.length > 0 ? [{ ...CLI_RUN, id: 'related-cli', args: cliFiles }] : [])];
  if (!runSlow) {
    return stepsOf('related-fast', '関係する速い組', selection.fast);
  }
  return bothChromium ? withEnvironment(BOTH_CHROMIUM_RUN_ENVIRONMENT, slowSteps) : slowSteps;
}

const [suiteName, ...arguments_] = process.argv.slice(2);
const isRelated = suiteName === 'related';
const extra = isRelated ? arguments_.filter((argument) => argument.startsWith('--') && !RELATED_FLAGS.includes(argument)) : arguments_;
const steps = isRelated ? await relatedSteps(arguments_) : SUITES[suiteName];
if (steps === undefined) {
  console.error(`[run-suite] 組の名前が違います: ${suiteName ?? '(なし)'}（${[...Object.keys(SUITES), 'related'].join('・')} のどれか）`);
  process.exit(2);
}
if (steps.length === 0) {
  process.exit(0);
}

const results = [];
for (const step of steps) {
  if (interrupted) {
    break;
  }
  const environmentText = Object.entries(step.environment).map(([name, value]) => `${name}=${value}`).join(' ');
  console.log(`\n[run-suite] ${suiteName}: ${step.label}${environmentText === '' ? '' : `（${environmentText}）`}`);
  results.push({ step, code: await runStep(step, extra) });
}

console.log(`\n[run-suite] ${suiteName} の結果:`);
for (const { step, code } of results) {
  console.log(`  ${code === 0 ? 'PASS' : 'FAIL'}  ${step.label}（終了コード ${code}）`);
}
if (interrupted) {
  console.log('  中断したので、残りの回は流していません。');
  process.exit(130);
}
process.exit(results.every(({ code }) => code === 0) && results.length === steps.length ? 0 : 1);
