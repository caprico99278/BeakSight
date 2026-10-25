/**
 * テストの組を流す起動の部品（TS-a。設計書 `doc/design/2026-10-24-beaksight-test-suite-tiers-design.md` 3.1）。
 * 使い方: `node tests/run-suite.mjs <safety|full> [Vitest の引数...]`（npm の `test:safety`・`test:full` から呼ぶ）。
 *
 * - ファイルの一覧は `tests/suites.ts`、CLI の回と全部の組の環境変数は `tests/helpers/test-run-environment.ts` から読む（Node の型の取り除きで、
 *   そのまま読む）。scripts に書き写さない。
 * - 環境変数は、この部品が子のプロセスに渡す（`cross-env` などの依存を足さず、Git Bash と PowerShell の両方で同じに動く）。既定の Chromium の回では、
 *   呼び出した側に CLI の回の環境変数があっても外す。TS-b: 全部の組（`full`）は、どの回にも全部の組の環境変数（`BEAKSIGHT_TEST_TIER=full`。回数を
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
import { CLI_CHROMIUM_TEST_FILES, SAFETY_TEST_FILES } from './suites.ts';
import { CLI_CHROMIUM_RUN_ENVIRONMENT, FULL_TEST_TIER_RUN_ENVIRONMENT } from './helpers/test-run-environment.ts';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VITEST_ENTRY = join(dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs');
const UI_CONFIG = 'apps/local-ui/vitest.config.ts';

const CLI_RUN = { id: 'safety-cli', label: 'CLI の回（CLI の Chromium）', args: [...CLI_CHROMIUM_TEST_FILES], environment: CLI_CHROMIUM_RUN_ENVIRONMENT };

/** 回の一覧の、どの回にも `environment` を足す（同じ名前があれば、回の値を使う）。 */
const withEnvironment = (environment, steps) => steps.map((step) => ({ ...step, environment: { ...environment, ...step.environment } }));

/** 組ごとの回（順に流す）。 */
const SUITES = {
  safety: [{ id: 'safety-default', label: '安全の一覧（既定の Chromium）', args: [...SAFETY_TEST_FILES], environment: {} }, CLI_RUN],
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
  for (const name of Object.keys(CLI_CHROMIUM_RUN_ENVIRONMENT)) {
    delete merged[name];
  }
  return { ...merged, ...environment };
}

let interrupted = false;
process.on('SIGINT', () => {
  interrupted = true;
});

function runStep(step, extra) {
  const args = [VITEST_ENTRY, 'run', ...step.args, ...argumentsForStep(extra, step.id)];
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

const [suiteName, ...extra] = process.argv.slice(2);
const steps = SUITES[suiteName];
if (steps === undefined) {
  console.error(`[run-suite] 組の名前が違います: ${suiteName ?? '(なし)'}（${Object.keys(SUITES).join('・')} のどれか）`);
  process.exit(2);
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
