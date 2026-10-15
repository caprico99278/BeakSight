// CC-091（T32k）: 自動ログインを使うワーカーの fork のテストの入口の本文（`tests/helpers/auto-login-worker-entry.ts`）の組み立て。本物の fork の
// テスト（`audit-worker-automated-login-fork`・`auth-mode-contrast`）は一時のビルドと Chromium が要るので、ここでは本文の形だけを速く確かめる。
// - どの組み合わせでも JavaScript として読める（import の行を除いた本体を関数として組み立てる）。置き換えの印（`__KEY__` など）が残らない。
// - 手動のログインの段: REJECT は呼ばれたら記録して失敗し、標準入力を読まない。SESSION_HANDOFF は標準入力のセッションを入れ、待つ時間を渡す。
// - `test-default` だけが自動ログインの段の Browser を替える。偽の暗号化の部品は、指定したときだけ資格情報の部品に渡す。
import { describe, expect, it } from 'vitest';
import {
  AUTO_LOGIN_ENTRY_LAUNCHES,
  autoLoginWorkerEntrySource,
  type AutoLoginWorkerEntryOptions,
  type ManualLoginStageOfEntry,
} from '../helpers/auto-login-worker-entry.js';

const KEY = 'ab'.repeat(32);
const RECORD = 'C:\\work\\manual-login-stage.log';
const LOGIN_TIMEOUT_MS = 60_000;
const STAGES: readonly ManualLoginStageOfEntry[] = [{ kind: 'REJECT' }, { kind: 'SESSION_HANDOFF', loginTimeoutMs: LOGIN_TIMEOUT_MS }];

const sourceOf = (overrides: Partial<AutoLoginWorkerEntryOptions> = {}): string => autoLoginWorkerEntrySource({
  launch: 'test-default',
  manualStageRecord: RECORD,
  protectorKey: KEY,
  portableCredentialStore: true,
  manualStage: { kind: 'REJECT' },
  ...overrides,
});

/** import の行を除いた本体（ESM の import は関数の中に書けないので除く）。 */
const bodyOf = (source: string): string => source.split('\n').filter((line) => !line.startsWith('import ')).join('\n');

describe('the test entry of a worker that uses the automated login (CC-091)', () => {
  it.each(AUTO_LOGIN_ENTRY_LAUNCHES.flatMap((launch) => STAGES.flatMap((manualStage) => [true, false].map((portable) => ({ launch, manualStage, portable })))))(
    'is valid JavaScript without a placeholder: %o',
    ({ launch, manualStage, portable }) => {
      const source = sourceOf({ launch, manualStage, portableCredentialStore: portable });
      expect(() => new Function(bodyOf(source))).not.toThrow();
      expect(source).not.toMatch(/__[A-Z_]+__/u);
      expect(source).toContain(`const MANUAL_RECORD = ${JSON.stringify(RECORD)};`);
      expect(source).toContain(`Buffer.from(${JSON.stringify(KEY)}, 'hex')`);
    },
  );

  it('fails the manual login stage when it is called, without reading the standard input (REJECT)', () => {
    const source = sourceOf({ manualStage: { kind: 'REJECT' } });
    expect(source).toContain("throw new Error('the manual login stage must not run');");
    expect(source).toContain("onLoginPageReady: async () => manualStageCalled('onLoginPageReady'),");
    expect(source).not.toContain('process.stdin');
    expect(source).not.toContain('loginTimeoutMs');
  });

  it('hands the session from the standard input to the login page, with the login timeout (SESSION_HANDOFF)', () => {
    const source = sourceOf({ manualStage: { kind: 'SESSION_HANDOFF', loginTimeoutMs: LOGIN_TIMEOUT_MS } });
    expect(source).toContain("process.stdin.on('end', () => resolve(text === '' ? null : JSON.parse(text)));");
    expect(source).toContain(`loginTimeoutMs: ${LOGIN_TIMEOUT_MS},`);
    expect(source).toContain('await page.context().addCookies([given.cookie]);');
    expect(source).toContain('return launchLoginBrowser();');
    expect(source).not.toContain('the manual login stage must not run');
  });

  it('replaces the automated login Browser only for the test default launch, and the credential store only when it is portable', () => {
    expect(sourceOf({ launch: 'test-default' })).toContain('automatedLoginStage: { launchAutomatedLoginBrowser: launchLoginBrowser },');
    expect(sourceOf({ launch: 'test-default' })).toContain('chromium.launch({ headless: true, args: [...CHROMIUM_SHARED_WORKERS_DISABLED_ARGS] })');
    expect(sourceOf({ launch: 'cli' })).not.toContain('automatedLoginStage');
    expect(sourceOf({ launch: 'cli' })).toContain('chromium.launch(chromiumLaunchOptions({ headless: true }))');
    expect(sourceOf({ portableCredentialStore: true })).toContain('protector: portableProtector,');
    expect(sourceOf({ portableCredentialStore: false })).not.toContain('openCredentialStore');
  });
});
