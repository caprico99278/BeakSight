/**
 * T43b（Task 43 の設計書 4.2）: 画面のサーバが対象の設定のファイルを作る部品（`src/server/target-config-writer.ts`）。root は一時のフォルダ
 * （実際の `local/` に書かない）。
 * - 組み立て: 開始の URL と許可 Origin の誤りでは作らない（`TARGET_SITE_INVALID`）。作る中身は `validateConfig` を通り、その結果（検証の文脈に使う
 *   設定）を返す。
 * - 書き込み: `local/targets/<id>.json` の形のパスだけに書く。同じ名前のファイルがあれば上書きせず `TARGET_CONFIG_EXISTS`。一時のファイルに
 *   書いてから名前を付けるので、途中で壊れた本体のファイルを残さない。一時のファイルは残らない。
 * - 片付け: 書いた中身と同じときだけ消す（ほかの中身のファイルは消さない）。
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isConfigError } from '../../../src/config/config-error.js';
import { loadConfig } from '../../../src/config/load-config.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../../src/control/store/database-path.js';
import { createProfile, getProfile } from '../../../src/control/store/profile-store.js';
import {
  createProfileWithGeneratedTarget,
  prepareGeneratedTargetConfig,
  removeWrittenTargetConfig,
  writeNewTargetConfig,
  type GeneratedTargetProfileDependencies,
} from '../src/server/target-config-writer';

const roots: string[] = [];

const temporaryRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'beaksight-t43b-writer-'));
  roots.push(root);
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const SITE = Object.freeze({ startUrl: 'https://example.test/admin/', allowedOrigins: ['https://example.test'] });
const PATH = 'local/targets/example-test.json';

/** フォルダの中の、一時のファイルの名前。 */
const temporaryFilesIn = (directory: string): readonly string[] =>
  existsSync(directory) ? readdirSync(directory).filter((name) => name.endsWith('.tmp')) : [];

describe('T43b: preparing the generated target configuration', () => {
  it('builds the content that passes validateConfig and gives the validated configuration', () => {
    const prepared = prepareGeneratedTargetConfig('example-test', SITE);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) {
      return;
    }
    expect(JSON.parse(prepared.content)).toMatchObject({ target: { id: 'example-test' }, site: SITE });
    expect(prepared.content.endsWith('}\n')).toBe(true);
    expect(prepared.targetConfig.site).toEqual(SITE);
    expect(prepared.targetConfig.target.id).toBe('example-test');
  });

  it('rejects the site problems without building anything', () => {
    expect(prepareGeneratedTargetConfig('example-test', { startUrl: 'https://example.test/#x', allowedOrigins: [] }))
      .toEqual({ ok: false, reason: 'TARGET_SITE_INVALID', siteProblems: ['START_URL_HAS_FRAGMENT', 'ALLOWED_ORIGINS_REQUIRED'] });
    expect(prepareGeneratedTargetConfig('example-test', { startUrl: 'https://example.test/', allowedOrigins: ['https://other.example.test'] }))
      .toEqual({ ok: false, reason: 'TARGET_SITE_INVALID', siteProblems: ['ALLOWED_ORIGINS_MISSING_START'] });
  });
});

describe('T43b: writing the generated target configuration', () => {
  it('writes local/targets/<id>.json under the root, readable by loadConfig, without leaving a temporary file', async () => {
    const root = temporaryRoot();
    const prepared = prepareGeneratedTargetConfig('example-test', SITE);
    if (!prepared.ok) {
      throw new Error('組み立てに失敗した');
    }
    expect(await writeNewTargetConfig(root, PATH, prepared.content)).toEqual({ ok: true });
    expect(readFileSync(join(root, PATH), 'utf8')).toBe(prepared.content);
    expect((await loadConfig(join(root, PATH))).site).toEqual(SITE);
    expect(temporaryFilesIn(join(root, 'local/targets'))).toEqual([]);
  });

  it('does not overwrite a file with the same name', async () => {
    const root = temporaryRoot();
    mkdirSync(join(root, 'local/targets'), { recursive: true });
    writeFileSync(join(root, PATH), 'kept\n', 'utf8');
    expect(await writeNewTargetConfig(root, PATH, '{"new":true}\n')).toEqual({ ok: false, reason: 'TARGET_CONFIG_EXISTS' });
    expect(readFileSync(join(root, PATH), 'utf8')).toBe('kept\n');
    expect(temporaryFilesIn(join(root, 'local/targets'))).toEqual([]);
  });

  it('writes nowhere for a path that is not local/targets/<id>.json', async () => {
    const root = temporaryRoot();
    for (const path of ['config/targets/example-test.json', 'local/targets/../escape.json', 'local/targets/a/b.json', 'local/escape.json', 'local/targets/x.txt']) {
      expect(await writeNewTargetConfig(root, path, '{}\n'), path).toEqual({ ok: false, reason: 'TARGET_CONFIG_WRITE_FAILED' });
    }
    expect(readdirSync(root)).toEqual([]);
  });
});

describe('T43b: removing the written file after the profile was not saved', () => {
  it('removes the file only when it still has the written content', async () => {
    const root = temporaryRoot();
    expect(await writeNewTargetConfig(root, PATH, 'written\n')).toEqual({ ok: true });
    writeFileSync(join(root, PATH), 'changed\n', 'utf8');
    expect(await removeWrittenTargetConfig(root, PATH, 'written\n')).toBe(false);
    expect(existsSync(join(root, PATH))).toBe(true);
    writeFileSync(join(root, PATH), 'written\n', 'utf8');
    expect(await removeWrittenTargetConfig(root, PATH, 'written\n')).toBe(true);
    expect(existsSync(join(root, PATH))).toBe(false);
    // ないファイルは消せない（誤りにしない）。
    expect(await removeWrittenTargetConfig(root, PATH, 'written\n')).toBe(false);
  });
});

describe('T43b fix round 1: the paths without an automatic test before', () => {
  it('returns TARGET_CONFIG_INVALID when validateConfig rejects what the field checks accepted (through the test seam)', () => {
    expect(prepareGeneratedTargetConfig('example-test', SITE, () => ({ ok: false, errors: ['rejected by the test'] })))
      .toEqual({ ok: false, reason: 'TARGET_CONFIG_INVALID', siteProblems: [] });
  });

  it('returns TARGET_CONFIG_WRITE_FAILED when the hard link cannot be made, and leaves no file (through the test seam)', async () => {
    const root = temporaryRoot();
    const failingLink = async (): Promise<void> => {
      throw Object.assign(new Error('hard links are not supported here'), { code: 'EPERM' });
    };
    expect(await writeNewTargetConfig(root, PATH, 'written\n', failingLink)).toEqual({ ok: false, reason: 'TARGET_CONFIG_WRITE_FAILED' });
    expect(existsSync(join(root, PATH))).toBe(false);
    expect(temporaryFilesIn(join(root, 'local/targets'))).toEqual([]);
  });
});

describe('T43b fix round 1: creating the profile after writing the file', () => {
  const PROFILE_ID = 'example-test';
  let root = '';
  let database: ControlDatabase | undefined;

  /** 公開の監査のプロファイルの文書（パスはサーバが決め直す）。 */
  const profileInput = (): Record<string, unknown> => ({
    schemaVersion: 'beaksight-profile/1',
    profileId: PROFILE_ID,
    revision: 1,
    targetConfigPath: '',
    environment: 'PUBLIC',
    mode: 'PUBLIC_PASSIVE',
    auth: 'NONE',
    approvedTestOrigins: [],
    environmentEvidenceRef: null,
  });

  const openStore = (): ControlDatabase => {
    database = openControlDatabase(resolveControlDatabasePath(root));
    return database;
  };

  /** 本物の保存の部品と、`loadConfig` で読む文脈（画面のサーバと同じ組み立て。root だけ一時のフォルダ）。 */
  const dependenciesOf = (store: ControlDatabase, overrides: Partial<GeneratedTargetProfileDependencies> = {}): GeneratedTargetProfileDependencies => ({
    root,
    profileExists: (profileId) => getProfile(store, profileId) !== null,
    loadContext: async (targetConfigPath) => {
      try {
        return { context: { targetConfig: await loadConfig(join(root, targetConfigPath)) }, configError: null };
      } catch (error) {
        if (isConfigError(error)) {
          return { context: undefined, configError: error.kind };
        }
        throw error;
      }
    },
    saveProfile: (profile, resolveContext) => createProfile(store, profile, { resolveContext }),
    ...overrides,
  });

  const generatedFile = (): string => join(root, PATH);

  afterEach(() => {
    if (database !== undefined) {
      closeControlDatabase(database);
      database = undefined;
    }
  });

  it('writes the file and saves the profile that points to it', async () => {
    root = temporaryRoot();
    const store = openStore();
    const outcome = await createProfileWithGeneratedTarget(profileInput(), SITE, dependenciesOf(store));
    expect(outcome).toMatchObject({ kind: 'SAVED', removedAfterFailure: false, configError: null, result: { ok: true } });
    expect(existsSync(generatedFile())).toBe(true);
    expect(getProfile(store, PROFILE_ID)?.profile.targetConfigPath).toBe(PATH);
  });

  it('removes the written file when the profile save is rejected after writing (another creation came first)', async () => {
    root = temporaryRoot();
    const store = openStore();
    // 確かめの後、保存の前に、同じ名前のプロファイルが別に作られた（すでにある設定のファイルを使うもの）。
    const prepared = prepareGeneratedTargetConfig(PROFILE_ID, SITE);
    if (!prepared.ok) {
      throw new Error('組み立てに失敗した');
    }
    const other = { ...profileInput(), targetConfigPath: 'config/targets/example.json' };
    expect(createProfile(store, other, { resolveContext: () => ({ targetConfig: prepared.targetConfig }) }).ok).toBe(true);
    const outcome = await createProfileWithGeneratedTarget(profileInput(), SITE, dependenciesOf(store, { profileExists: () => false }));
    expect(outcome).toMatchObject({ kind: 'SAVED', removedAfterFailure: true, result: { ok: false, reason: 'PROFILE_ALREADY_EXISTS' } });
    expect(existsSync(generatedFile())).toBe(false);
    expect(temporaryFilesIn(join(root, 'local/targets'))).toEqual([]);
    // 先に作られたプロファイルは、そのまま（作ったファイルを指さない）。
    expect(getProfile(store, PROFILE_ID)?.profile.targetConfigPath).toBe('config/targets/example.json');
  });

  it('removes the written file and leaves no profile when the profile save throws after writing', async () => {
    root = temporaryRoot();
    const store = openStore();
    const closingSave: GeneratedTargetProfileDependencies['saveProfile'] = (profile, resolveContext) => {
      // 管理データが使えなくなった（保存の部品が投げる）。
      closeControlDatabase(store);
      return createProfile(store, profile, { resolveContext });
    };
    await expect(createProfileWithGeneratedTarget(profileInput(), SITE, dependenciesOf(store, { saveProfile: closingSave }))).rejects.toThrow();
    expect(existsSync(generatedFile())).toBe(false);
    const reopened = openStore();
    expect(getProfile(reopened, PROFILE_ID)).toBeNull();
  });

  it('saves no profile when the file cannot be written (through the test seam)', async () => {
    root = temporaryRoot();
    const store = openStore();
    const failingLink = async (): Promise<void> => {
      throw Object.assign(new Error('hard links are not supported here'), { code: 'EPERM' });
    };
    expect(await createProfileWithGeneratedTarget(profileInput(), SITE, dependenciesOf(store, { link: failingLink })))
      .toEqual({ kind: 'TARGET_REJECTED', reason: 'TARGET_CONFIG_WRITE_FAILED', siteProblems: [] });
    expect(existsSync(generatedFile())).toBe(false);
    expect(getProfile(store, PROFILE_ID)).toBeNull();
  });

  it('writes nothing for a profile that is rejected before writing, or that already exists', async () => {
    root = temporaryRoot();
    const store = openStore();
    // 公開の監査のモードに、手動のログインの認証の方式（組み合わせの表の外）。
    expect(await createProfileWithGeneratedTarget({ ...profileInput(), auth: 'MANUAL_SESSION' }, SITE, dependenciesOf(store)))
      .toEqual({ kind: 'PROFILE_REJECTED', reason: 'PROFILE_INVALID', errorCodes: ['PROFILE_AUTH_MISMATCH'] });
    expect(await createProfileWithGeneratedTarget({ ...profileInput(), profileId: '../escape' }, SITE, dependenciesOf(store)))
      .toEqual({ kind: 'PROFILE_REJECTED', reason: 'PROFILE_INVALID', errorCodes: ['PROFILE_ID_INVALID'] });
    expect(await createProfileWithGeneratedTarget(profileInput(), SITE, dependenciesOf(store, { profileExists: () => true })))
      .toEqual({ kind: 'PROFILE_REJECTED', reason: 'PROFILE_ALREADY_EXISTS', errorCodes: [] });
    expect(existsSync(join(root, 'local'))).toBe(false);
  });

  // 予約名の判定そのものは、CC-101 で `target-config-draft.ts` に移した（`tests/unit/target-config-draft.test.ts` が同じ名前で確かめる）。
  // T43R-fix-D（M-6）: Windows の予約名の名前は、作成の確かめで理由つきで拒む（ファイルを作らない。プロファイルも作らない）。
  it('rejects a Windows reserved name with its own reason, and writes nothing', async () => {
    root = temporaryRoot();
    const store = openStore();
    for (const name of ['con', 'nul', 'aux', 'prn', 'com1', 'lpt9']) {
      expect(await createProfileWithGeneratedTarget({ ...profileInput(), profileId: name }, SITE, dependenciesOf(store)), name)
        .toEqual({ kind: 'TARGET_REJECTED', reason: 'TARGET_CONFIG_NAME_RESERVED', siteProblems: [] });
      expect(getProfile(store, name), name).toBeNull();
    }
    expect(existsSync(join(root, 'local'))).toBe(false);
  });
});

describe('T43R-fix-D (M-6): the place of the file must not be a reparse point (junction, symlink)', () => {
  const junctions: string[] = [];

  /** 一時のフォルダの中に、外のフォルダ（`outside`）を指す junction を `linkPath` に作る（片付けで、先をたどらずに先に外す）。 */
  const makeJunction = (outside: string, linkPath: string): void => {
    mkdirSync(dirname(linkPath), { recursive: true });
    symlinkSync(outside, linkPath, 'junction');
    junctions.push(linkPath);
  };

  afterEach(() => {
    for (const linkPath of junctions.splice(0)) {
      unlinkSync(linkPath);
    }
  });

  for (const [label, linked] of [['local/targets', 'local/targets'], ['local', 'local']] as const) {
    it(`stops without writing when ${label} is a junction`, async () => {
      const root = temporaryRoot();
      const outside = temporaryRoot();
      makeJunction(outside, join(root, linked));
      expect(await writeNewTargetConfig(root, PATH, 'written\n')).toEqual({ ok: false, reason: 'TARGET_CONFIG_LOCATION_UNSAFE' });
      // junction の先（一時のフォルダの外の場所）に、何も書かない（一時のファイルも作らない）。
      expect(readdirSync(outside, { recursive: true })).toEqual([]);
    });
  }

  it('stops when local/targets is not a folder', async () => {
    const root = temporaryRoot();
    mkdirSync(join(root, 'local'), { recursive: true });
    writeFileSync(join(root, 'local/targets'), 'not a folder\n', 'utf8');
    expect(await writeNewTargetConfig(root, PATH, 'written\n')).toEqual({ ok: false, reason: 'TARGET_CONFIG_LOCATION_UNSAFE' });
    expect(readFileSync(join(root, 'local/targets'), 'utf8')).toBe('not a folder\n');
  });

  it('does not remove a file through a junction', async () => {
    const root = temporaryRoot();
    const outside = temporaryRoot();
    writeFileSync(join(outside, 'example-test.json'), 'written\n', 'utf8');
    makeJunction(outside, join(root, 'local/targets'));
    expect(await removeWrittenTargetConfig(root, PATH, 'written\n')).toBe(false);
    expect(readFileSync(join(outside, 'example-test.json'), 'utf8')).toBe('written\n');
  });

  it('stops the whole creation without a profile when the place is a junction', async () => {
    const root = temporaryRoot();
    const outside = temporaryRoot();
    makeJunction(outside, join(root, 'local/targets'));
    const database = openControlDatabase(resolveControlDatabasePath(root));
    try {
      const outcome = await createProfileWithGeneratedTarget({
        schemaVersion: 'beaksight-profile/1',
        profileId: 'example-test',
        revision: 1,
        targetConfigPath: '',
        environment: 'PUBLIC',
        mode: 'PUBLIC_PASSIVE',
        auth: 'NONE',
        approvedTestOrigins: [],
        environmentEvidenceRef: null,
      }, SITE, {
        root,
        profileExists: (profileId) => getProfile(database, profileId) !== null,
        loadContext: async () => ({ context: undefined, configError: null }),
        saveProfile: (profile, resolveContext) => createProfile(database, profile, { resolveContext }),
      });
      expect(outcome).toEqual({ kind: 'TARGET_REJECTED', reason: 'TARGET_CONFIG_LOCATION_UNSAFE', siteProblems: [] });
      expect(getProfile(database, 'example-test')).toBeNull();
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      closeControlDatabase(database);
    }
  });
});
