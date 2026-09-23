import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const rootDirectory = process.cwd();
const cliPath = resolve(rootDirectory, 'dist/cli/index.js');

const invokeCli = (...arguments_: string[]) => spawnSync(process.execPath, [cliPath, ...arguments_], {
  cwd: rootDirectory,
  encoding: 'utf8',
});

beforeAll(() => {
  const compilerPath = resolve(rootDirectory, 'node_modules/typescript/bin/tsc');
  const build = spawnSync(process.execPath, [compilerPath, '-p', 'tsconfig.build.json'], {
    cwd: rootDirectory,
    encoding: 'utf8',
  });
  expect(build.status, build.stderr).toBe(0);
});

describe('CLI', () => {
  it('delegates validate-config to the config loader and preserves command exit behavior', () => {
    const validation = invokeCli('validate-config');
    const run = invokeCli('run');
    const usage = invokeCli('unexpected-command');

    expect(validation.status).toBe(0);
    expect(validation.stdout).toBe('configuration valid\n');
    expect(run.status).toBe(1);
    expect(run.stderr).toBe('run coordinator is not wired yet\n');
    expect(usage.status).toBe(4);
    expect(usage.stderr).toBe('usage: beaksight <run|validate-config> [options]\n');
  });
});
