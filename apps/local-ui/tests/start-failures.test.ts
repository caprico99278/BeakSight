/**
 * 画面のサーバを起動できないときの止まり方（T23h。独立レビュー T23R の I1、M2）。
 * - 開発のサーバ: `--host`（値なし、`0.0.0.0`、`::`、`localhost`）で待ち受けのアドレスを変えようとすると、待ち受けずに、日本語の説明と
 *   0 でない終了コードで止まる（Vite の CLI の指定は設定より優先されるため、守りの plugin が解決した設定を確かめる）。port の使用中も
 *   日本語の説明で止まる。
 * - 本番の起動の部品: port の使用中と、`--port` の誤った値で、日本語の説明と 0 でない終了コードで止まる。
 * - どれも一時の root で行い、リポジトリの `local-data/` を作らない。token の URL は出さない。
 */
import { cpSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LOCAL_UI_START_FAILURE_TEXT } from '../../../src/presentation/messages.js';
import {
  LOOPBACK_HOST,
  createTemporaryUiRoot,
  findFreePort,
  REPO_ROOT,
  runDevServerUntilExit,
  runPreviewUntilExit,
  runLauncherWithArgumentsUntilExit,
  snapshotRepositoryViteCache,
  type ExitedProcess,
  type TemporaryUiRoot,
} from './helpers/local-server.ts';

/** 起動できないときの終了コード。 */
const START_FAILED_EXIT_CODE = 1;

const text = LOCAL_UI_START_FAILURE_TEXT;

let builtRoot: TemporaryUiRoot | undefined;
let sourceRoot: TemporaryUiRoot | undefined;
/** リポジトリの `node_modules/.vite` の、テストの前の様子（M4）。 */
let viteCacheBefore = '';

const rootOf = (root: TemporaryUiRoot | undefined): TemporaryUiRoot => {
  if (root === undefined) {
    throw new Error('一時の root がない');
  }
  return root;
};

/** 127.0.0.1 の port を、ほかのプログラムとして使っておく。 */
const occupyPort = async (): Promise<{ readonly port: number; readonly server: Server }> => {
  const port = await findFreePort();
  const server = createServer();
  await new Promise<void>((resolveListen) => server.listen({ host: LOOPBACK_HOST, port }, () => resolveListen()));
  return { port, server };
};

const expectStopped = (result: ExitedProcess, description: string, action: string): void => {
  expect(result.status, result.output).toBe(START_FAILED_EXIT_CODE);
  expect(result.output).toContain(text.heading);
  expect(result.output).toContain(description);
  expect(result.output).toContain(action);
  expect(result.output).not.toMatch(/token=/u);
  expect(result.output).not.toMatch(/\n\s+at /u);
};

beforeAll(() => {
  viteCacheBefore = snapshotRepositoryViteCache();
  builtRoot = createTemporaryUiRoot('built');
  sourceRoot = createTemporaryUiRoot('source');
});

afterAll(() => {
  builtRoot?.remove();
  sourceRoot?.remove();
});

describe('dev server: the listen address is fixed to 127.0.0.1 (I1)', () => {
  it.each([
    [['--host'], text.allAddresses],
    [['--host', '0.0.0.0'], '0.0.0.0'],
    [['--host', '::'], '::'],
    [['--host', 'localhost'], 'localhost'],
  ] as const)('refuses to start with %j', async (hostArguments, shownHost) => {
    const result = runDevServerUntilExit(rootOf(sourceRoot), ['--port', String(await findFreePort()), ...hostArguments]);
    expectStopped(result, text.hostNotAllowed(shownHost), text.hostNotAllowedAction);
  });
});

describe('vite preview never starts (T23i, N1)', () => {
  it.each([[[] as readonly string[]], [['--host', '0.0.0.0']]])('refuses to start the preview server with %j', async (hostArguments) => {
    // preview が読むビルドの出力を、一時の root に置く（なくても止まることの理由が変わらないように）。
    const root = rootOf(sourceRoot);
    cpSync(`${REPO_ROOT}/apps/local-ui/dist`, `${root.root}/apps/local-ui/dist`, { recursive: true });
    const result = runPreviewUntilExit(root, ['--port', String(await findFreePort()), ...hostArguments]);
    expectStopped(result, text.previewNotSupported, text.previewNotSupportedAction);
    expect(result.output).not.toMatch(/Local:\s+http/u);
  });
});

describe('start failures are explained in Japanese (M2)', () => {
  it('launcher: the port is in use', async () => {
    const { port, server } = await occupyPort();
    try {
      const result = runLauncherWithArgumentsUntilExit(rootOf(builtRoot), ['--port', String(port)]);
      expectStopped(result, text.portInUse(port), text.portInUseAction);
    } finally {
      server.close();
    }
  });

  it.each([['abc'], ['0'], ['65536'], ['1.5']])('launcher: --port %s is not a port number', (value) => {
    const result = runLauncherWithArgumentsUntilExit(rootOf(builtRoot), ['--port', value]);
    expectStopped(result, text.portInvalid(value), text.portInvalidAction);
  });

  it('launcher: --port without a value', () => {
    const result = runLauncherWithArgumentsUntilExit(rootOf(builtRoot), ['--port']);
    expectStopped(result, text.portInvalid(''), text.portInvalidAction);
  });

  it('dev server: the port is in use', async () => {
    const { port, server } = await occupyPort();
    try {
      const result = runDevServerUntilExit(rootOf(sourceRoot), ['--port', String(port)]);
      expectStopped(result, text.portInUse(port), text.portInUseAction);
    } finally {
      server.close();
    }
  });
});

describe('the dev server of the tests does not write into the repository (M4)', () => {
  it('leaves node_modules/.vite of the repository unchanged', () => {
    expect(snapshotRepositoryViteCache()).toBe(viteCacheBefore);
  });
});
