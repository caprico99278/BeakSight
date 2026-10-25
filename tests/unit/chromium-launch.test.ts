// EL-12（設計書 `2026-10-24-beaksight-external-launch-block-design.md` 3.1・3.2・3.5）: 外部のアプリの起動を止める起動の部品（`launchChromiumWith`）を、
// 起動の部品の差し替え（偽の persistent の Chromium。本物の Browser は起動しない。TS-g: headed は窓を開かずに確かめる）で確かめる。
// - 一時のプロファイルを作り、Preferences を書いてから、`chromiumLaunchOptions` の値のまま `launchPersistentContext` に渡し、その `browser()` を返す。
// - 自己検査: `ERR_BLOCKED_BY_ADMINISTRATOR` だけを合格にする。EL-F（M1）: 続けて、許した種類（http・https・data:）が止まっていないことを確かめ、内部の
//   窓の頁にする。不合格は `EXTERNAL_LAUNCH_BLOCK_UNAVAILABLE` で、Browser を閉じ、プロファイルを消す。
// - EL-F（M2）: 既定の Context は、すべての要求を止める（route と offline）。既定の頁: headless は閉じる。headed は残して最小化する。
// - EL-F（M3）: 起動のときに、古い一時のプロファイルを消す（使っているもの・消せないものは飛ばす）。
// - 後片付け: `browser.close()` が返った後（プロセスの終わりの後）と、予期しない切断の直後と少し後に、プロファイルを消す。起動の失敗でも消す。
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CHROMIUM_LAUNCH_REFUSAL_REASONS,
  CHROMIUM_PROFILE_DIRECTORY_PREFIX,
  CHROMIUM_PROFILE_IN_USE_FILE,
  CHROMIUM_PROFILE_REMOVE_AFTER_DISCONNECT_MS,
  CHROMIUM_STALE_PROFILE_AGE_MS,
  chromiumLaunchOptions,
  EXTERNAL_LAUNCH_ALLOWED_PROBE_URLS,
  EXTERNAL_LAUNCH_ALLOWED_URL_PATTERNS,
  EXTERNAL_LAUNCH_BLOCKED_ERROR_TEXT,
  EXTERNAL_LAUNCH_SELF_CHECK_URL,
  externalLaunchBlockPreferences,
  isChromiumLaunchRefused,
  launchChromiumWith,
  removeStaleProfileDirectoriesIn,
  type ChromiumLaunchDependencies,
} from '../../src/browser/chromium-launch.js';
import { NON_EXTERNAL_NAVIGATION_SCHEMES } from '../../src/core/evidence-types.js';
import {
  FAKE_INTERNAL_WINDOW_CALL,
  FAKE_SELF_CHECK_ABORTED_ERROR,
  fakePersistentChromium,
  type FakePersistentChromium,
} from '../helpers/fake-persistent-chromium.js';

const PROFILE = 'C:/fake/beaksight-chromium-profile-x';

/** 偽の依存（プロファイルの操作を記録する）。 */
function fakeDependencies(fake: FakePersistentChromium | Error): { dependencies: ChromiumLaunchDependencies; steps: string[]; launchOptions: unknown[] } {
  const steps: string[] = [];
  const launchOptions: unknown[] = [];
  return {
    steps,
    launchOptions,
    dependencies: {
      removeStaleProfileDirectories: async () => {
        steps.push('stale');
      },
      createProfileDirectory: async () => {
        steps.push('create');
        return PROFILE;
      },
      writeProfilePreferences: async (directory) => {
        steps.push(`write:${directory}`);
      },
      launchPersistentContext: async (directory, options) => {
        steps.push(`launch:${directory}`);
        launchOptions.push(options);
        if (fake instanceof Error) throw fake;
        return fake.context;
      },
      removeProfileDirectory: async (directory) => {
        steps.push(`remove:${directory}`);
      },
    },
  };
}

/** 自己検査の合格の操作の並び（EL-F の M1 の確かめを含む）と、既定の Context の止め方（M2）。 */
const PASSING_SELF_CHECK_CALLS = [
  `goto[0]:${EXTERNAL_LAUNCH_SELF_CHECK_URL}`,
  'waitForURL[0]',
  `goto[0]:${FAKE_INTERNAL_WINDOW_CALL}`,
  ...EXTERNAL_LAUNCH_ALLOWED_PROBE_URLS.flatMap((url) => [`goto[0]:${url}`, 'waitForURL[0]', `goto[0]:${FAKE_INTERNAL_WINDOW_CALL}`]),
  'context.route:**',
  'context.setOffline:true',
];

describe('EL-12: the launch component blocks external applications in a temporary profile', () => {
  it('writes the closed allow list of the design (http, https and the internal schemes that the Guard treats as not external)', () => {
    expect(externalLaunchBlockPreferences()).toEqual({
      policy: { url_blocklist: ['*'], url_allowlist: ['http://*', 'https://*', 'about:*', 'data:*', 'blob:*'] },
    });
    expect(EXTERNAL_LAUNCH_ALLOWED_URL_PATTERNS.map((pattern) => pattern.replace(/(?:\/\/)?\*$/u, ''))).toEqual([...NON_EXTERNAL_NAVIGATION_SCHEMES]);
    expect(CHROMIUM_LAUNCH_REFUSAL_REASONS).toEqual(['EXTERNAL_LAUNCH_BLOCK_UNAVAILABLE']);
    // M1: 許した種類の確かめは、接続しない宛先（危ないポートの 9 番）だけ。
    expect(EXTERNAL_LAUNCH_ALLOWED_PROBE_URLS).toEqual(['http://127.0.0.1:9/', 'https://127.0.0.1:9/']);
  });

  it('launches headless with the CLI launch options unchanged, passes the self-check, blocks the default Context and closes the default page', async () => {
    const fake = fakePersistentChromium();
    const { dependencies, steps, launchOptions } = fakeDependencies(fake);
    const options = chromiumLaunchOptions({ headless: true });

    await expect(launchChromiumWith(options, dependencies)).resolves.toBe(fake.browser);

    expect(steps).toEqual(['stale', 'create', `write:${PROFILE}`, `launch:${PROFILE}`]);
    expect(launchOptions).toEqual([options]);
    expect(fake.calls).toEqual([...PASSING_SELF_CHECK_CALLS, 'page.close[0]']);
    // `browser.close()` が返った後（Chromium のプロセスが終わった後）に、プロファイルを消している。
    expect(steps.filter((step) => step.startsWith('remove:'))).toEqual([]);
    await fake.browser.close();
    expect(steps.at(-1)).toBe(`remove:${PROFILE}`);
    expect(fake.calls.at(-1)).toBe('browser.close');
  });

  it('removes the profile right after an unexpected disconnect, and again after the browser had time to exit', async () => {
    vi.useFakeTimers();
    try {
      const fake = fakePersistentChromium();
      const { dependencies, steps } = fakeDependencies(fake);
      await launchChromiumWith(chromiumLaunchOptions({ headless: true }), dependencies);

      fake.disconnect();
      expect(steps.filter((step) => step.startsWith('remove:'))).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(CHROMIUM_PROFILE_REMOVE_AFTER_DISCONNECT_MS);
      expect(steps.filter((step) => step.startsWith('remove:'))).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the default page as the internal window of BeakSight, blocks the default Context, and minimizes it when headed', async () => {
    const fake = fakePersistentChromium();
    const { dependencies } = fakeDependencies(fake);

    await expect(launchChromiumWith(chromiumLaunchOptions({ headless: false }), dependencies)).resolves.toBe(fake.browser);

    expect(fake.calls).toEqual([
      ...PASSING_SELF_CHECK_CALLS,
      'cdp.open[0]',
      'cdp:Browser.getWindowForTarget',
      'cdp:Browser.setWindowBounds:minimized',
      'cdp.detach',
    ]);
  });

  it('keeps the headed browser when minimizing fails (minimizing is not a safety check)', async () => {
    const fake = fakePersistentChromium({ cdpFails: true });
    const { dependencies } = fakeDependencies(fake);

    await expect(launchChromiumWith(chromiumLaunchOptions({ headless: false }), dependencies)).resolves.toBe(fake.browser);
    expect(fake.calls).not.toContain('browser.close');
    expect(fake.calls).toContain('cdp.detach');
  });

  it('fails the launch and closes the browser when the default Context cannot be blocked (M2)', async () => {
    const fake = fakePersistentChromium({ routeFails: true });
    const { dependencies, steps } = fakeDependencies(fake);

    await expect(launchChromiumWith(chromiumLaunchOptions({ headless: false }), dependencies)).rejects.toThrow('route failed');
    expect(fake.calls).toContain('browser.close');
    expect(fake.calls).not.toContain('cdp:Browser.setWindowBounds:minimized');
    expect(steps.at(-1)).toBe(`remove:${PROFILE}`);
  });

  it('closes the extra default pages and opens a page when there is none', async () => {
    const extra = fakePersistentChromium({ pageCount: 2 });
    await launchChromiumWith(chromiumLaunchOptions({ headless: false }), fakeDependencies(extra).dependencies);
    expect(extra.calls.filter((call) => call.startsWith('page.close'))).toEqual(['page.close[1]']);

    const none = fakePersistentChromium({ pageCount: 0 });
    await launchChromiumWith(chromiumLaunchOptions({ headless: true }), fakeDependencies(none).dependencies);
    expect(none.calls.slice(0, 2)).toEqual(['context.newPage', `goto[0]:${EXTERNAL_LAUNCH_SELF_CHECK_URL}`]);
  });

  it.each([
    ['the navigation is aborted (the profile policy is not effective)', { selfCheckError: FAKE_SELF_CHECK_ABORTED_ERROR }],
    ['the navigation times out', { selfCheckError: 'page.goto: Timeout 10000ms exceeded.' }],
    ['the navigation succeeds', { selfCheckError: null }],
    // EL-F（M1）: 許す一覧が上書きされ、http・https が止まる。
    ['an allowed scheme (http, https) is blocked', { allowedProbeError: (url: string) => `page.goto: ${EXTERNAL_LAUNCH_BLOCKED_ERROR_TEXT} at ${url}` }],
    // EL-F（M1）: 許した種類の `data:` が止まる。
    ['the data: internal window is blocked', { internalWindowError: `page.goto: ${EXTERNAL_LAUNCH_BLOCKED_ERROR_TEXT} at data:` }],
  ] as const)('refuses with EXTERNAL_LAUNCH_BLOCK_UNAVAILABLE, closes the browser and removes the profile when %s', async (_label, fakeOptions) => {
    const fake = fakePersistentChromium(fakeOptions);
    const { dependencies, steps } = fakeDependencies(fake);

    const failure = await launchChromiumWith(chromiumLaunchOptions({ headless: true }), dependencies).then(() => null, (error: unknown) => error);

    expect(isChromiumLaunchRefused(failure, 'EXTERNAL_LAUNCH_BLOCK_UNAVAILABLE')).toBe(true);
    expect(fake.calls).toContain('browser.close');
    // 断ったときは、既定の Context の止め方まで進まない（Browser を閉じる）。
    expect(fake.calls).not.toContain('context.route:**');
    // Browser を閉じた後に、プロファイルを消している。
    expect(steps.at(-1)).toBe(`remove:${PROFILE}`);
  });

  it('fails the launch (not the refusal reason) when the internal window cannot be opened for another reason', async () => {
    const fake = fakePersistentChromium({ internalWindowError: 'page.goto: net::ERR_FAILED at data:' });
    const failure = await launchChromiumWith(chromiumLaunchOptions({ headless: true }), fakeDependencies(fake).dependencies).then(() => null, (error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(isChromiumLaunchRefused(failure)).toBe(false);
    expect(fake.calls).toContain('browser.close');
  });

  it('removes the profile and rethrows when the launch fails, and closes the context when it has no browser', async () => {
    const launchFailure = new Error('launch failed');
    const failed = fakeDependencies(launchFailure);
    await expect(launchChromiumWith(chromiumLaunchOptions({ headless: true }), failed.dependencies)).rejects.toBe(launchFailure);
    expect(failed.steps).toEqual(['stale', 'create', `write:${PROFILE}`, `launch:${PROFILE}`, `remove:${PROFILE}`]);

    const noBrowser = fakePersistentChromium({ noBrowser: true });
    const missing = fakeDependencies(noBrowser);
    await expect(launchChromiumWith(chromiumLaunchOptions({ headless: true }), missing.dependencies)).rejects.toThrow('has no browser');
    expect(noBrowser.calls).toEqual(['context.close']);
    expect(missing.steps.at(-1)).toBe(`remove:${PROFILE}`);
  });

  it('keeps launching when removing the stale profiles fails (M3)', async () => {
    const fake = fakePersistentChromium();
    const { dependencies } = fakeDependencies(fake);
    const failingStale: ChromiumLaunchDependencies = {
      ...dependencies,
      removeStaleProfileDirectories: () => Promise.reject(new Error('readdir failed')),
    };
    await expect(launchChromiumWith(chromiumLaunchOptions({ headless: true }), failingStale)).resolves.toBe(fake.browser);
  });

  it('does not treat other errors as the closed refusal reason', () => {
    expect(isChromiumLaunchRefused(new Error('EXTERNAL_LAUNCH_BLOCK_UNAVAILABLE'))).toBe(false);
  });
});

// EL-F（EL-R の M3）: 古い一時のプロファイルを消す。本物のファイルの部品で、一時のフォルダの下に作った親のフォルダの中だけで確かめる。
describe('EL-F: removeStaleProfileDirectoriesIn removes only the old, unused temporary profiles', () => {
  const parents: string[] = [];
  afterEach(async () => {
    await Promise.all(parents.splice(0).map((parent) => rm(parent, { recursive: true, force: true })));
  });

  it('removes the old profiles, and skips the new ones, the ones in use, the ones it cannot remove and other folders', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'beaksight-stale-profile-test-'));
    parents.push(parent);
    const now = Date.now();
    const old = new Date(now - CHROMIUM_STALE_PROFILE_AGE_MS - 60_000);
    const make = async (name: string, options: { readonly mtime?: Date; readonly inUse?: boolean } = {}): Promise<void> => {
      const directory = join(parent, name);
      await mkdir(directory);
      await writeFile(join(directory, 'Local State'), '{}');
      if (options.inUse === true) await writeFile(join(directory, CHROMIUM_PROFILE_IN_USE_FILE), '');
      if (options.mtime !== undefined) await utimes(directory, options.mtime, options.mtime);
    };
    await make(`${CHROMIUM_PROFILE_DIRECTORY_PREFIX}old`, { mtime: old });
    await make(`${CHROMIUM_PROFILE_DIRECTORY_PREFIX}new`);
    await make(`${CHROMIUM_PROFILE_DIRECTORY_PREFIX}in-use`, { mtime: old, inUse: true });
    await make(`${CHROMIUM_PROFILE_DIRECTORY_PREFIX}locked`, { mtime: old });
    await make('another-tool-profile-old', { mtime: old });

    const removed = await removeStaleProfileDirectoriesIn(parent, now, async (directory) => {
      if (directory.endsWith('locked')) throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' });
      await rm(directory, { recursive: true, force: true });
    });

    expect(removed).toEqual([`${CHROMIUM_PROFILE_DIRECTORY_PREFIX}old`]);
    expect((await readdir(parent)).sort()).toEqual([
      `${CHROMIUM_PROFILE_DIRECTORY_PREFIX}in-use`,
      `${CHROMIUM_PROFILE_DIRECTORY_PREFIX}locked`,
      `${CHROMIUM_PROFILE_DIRECTORY_PREFIX}new`,
      'another-tool-profile-old',
    ].sort());
  });

  it('does nothing when the parent folder cannot be read', async () => {
    await expect(removeStaleProfileDirectoriesIn(join(tmpdir(), 'beaksight-no-such-parent-folder'), Date.now())).resolves.toEqual([]);
  });
});
