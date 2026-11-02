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
import { createProfile, getProfile, listProfiles } from '../../../src/control/store/profile-store.js';
import { targetConfigCandidatesIn } from '../src/server/target-config';
import {
  createProfileFromRequest,
  createProfileWithGeneratedTarget,
  prepareGeneratedTargetConfig,
  removeWrittenTargetConfig,
  writeNewTargetConfig,
  type GeneratedTargetProfileDependencies,
  type ProfileCreationDependencies,
  type ProfileTargetRequest,
} from '../src/server/target-config-writer';
import type { TargetSiteInput } from '../../../src/config/target-config-draft.js';
import { ISOLATION_UNVERIFIED_EVIDENCE_REF_PREFIX } from '../src/server/isolation-evidence-ref';

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

// MI-1（設計書 `doc/design/2026-10-26-beaksight-minimal-input-ux-design.md` 4.2 の「隠す値」の表、6 章の受け入れ条件 1）: 作成の画面が開始の URL と使い方の
// 2 択だけを送ったとき、隠す値（名前、設定のファイル、テスト環境の Origin、隔離が未確認の参照）を、サーバの作成の流れが決める。承認したサービスの Origin の
// 項目は作らない。作成の画面の「詳しい設定」で直した値（送った項目）は、そのまま使う。
describe('MI-1: creating a profile from the start URL and the usage only', () => {
  const START_ORIGIN = 'https://example.test';
  /** 表示の時間帯（Asia/Tokyo）では 2026-10-26、UTC では 2026-10-25 の時刻（参照の日付は保存した日の表示の日付）。 */
  const SAVED_AT = new Date('2026-10-25T20:00:00Z');
  // MI-F3（MI-R の Minor 12）: 接頭辞は形の owner の定数から作る。日付の部分は、保存した時刻（`SAVED_AT`）の表示の時間帯の日付の期待の値（作成の流れが
  // 日付の関数 `isolationUnverifiedEvidenceRefOf` で作ることを確かめるので、期待をその関数で作らない）。
  const UNVERIFIED_REF = `${ISOLATION_UNVERIFIED_EVIDENCE_REF_PREFIX}20261026`;
  let root = '';
  let database: ControlDatabase | undefined;

  /** 使い方の 2 択だけを決めた入力（名前・設定のファイル・テスト環境の Origin・参照を送らない）。 */
  const usageInput = (usage: 'TEST' | 'PUBLIC', overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    schemaVersion: 'beaksight-profile/1',
    revision: 1,
    ...(usage === 'TEST'
      ? { environment: 'TEST', mode: 'TEST_AUTH_PASSIVE', auth: 'MANUAL_SESSION' }
      : { environment: 'PUBLIC', mode: 'PUBLIC_PASSIVE', auth: 'NONE' }),
    ...overrides,
  });

  /** MI-C: 自動の選び方（作成の画面の既定）。対象の設定の選び方は、入力の明示の項目（`targetChoice`）で決まる。 */
  const auto = (site: TargetSiteInput): ProfileTargetRequest => ({ choice: 'AUTO', site });

  const openStore = (): ControlDatabase => {
    database = openControlDatabase(resolveControlDatabasePath(root));
    return database;
  };

  /** 本物の保存の部品と、`loadConfig` で読む文脈と、一時の root の設定のファイルの候補（画面のサーバと同じ集め方）。 */
  const creationDependenciesOf = (store: ControlDatabase, overrides: Partial<ProfileCreationDependencies> = {}): ProfileCreationDependencies => ({
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
    profileIds: () => listProfiles(store).map((stored) => stored.profile.profileId),
    targetConfigCandidates: () => targetConfigCandidatesIn(root),
    now: () => SAVED_AT,
    ...overrides,
  });

  /** 一時の root に、すでにある設定のファイルを置く（中身を返す）。 */
  const writeExistingTarget = (path: string, startUrl: string, allowedOrigins: readonly string[]): string => {
    const content = `${JSON.stringify({ target: { id: 'existing' }, site: { startUrl, allowedOrigins } })}\n`;
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content, 'utf8');
    return content;
  };

  afterEach(() => {
    if (database !== undefined) {
      closeControlDatabase(database);
      database = undefined;
    }
  });

  it('saves a test profile with the suggested name, the generated file, the test origin and the unverified reference', async () => {
    root = temporaryRoot();
    const store = openStore();
    const outcome = await createProfileFromRequest(usageInput('TEST'), auto(SITE), creationDependenciesOf(store));
    expect(outcome).toMatchObject({ kind: 'SAVED', result: { ok: true } });
    const saved = getProfile(store, 'example-test')?.profile;
    expect(saved).toMatchObject({
      profileId: 'example-test',
      targetConfigPath: PATH,
      environment: 'TEST',
      mode: 'TEST_AUTH_PASSIVE',
      auth: 'MANUAL_SESSION',
      approvedTestOrigins: [START_ORIGIN],
      environmentEvidenceRef: UNVERIFIED_REF,
    });
    // 承認したサービスの Origin の項目は作らない（手動のログインの観察だけが足す）。
    expect(saved === undefined ? true : Object.hasOwn(saved, 'approvedServiceOrigins')).toBe(false);
    expect(existsSync(join(root, PATH))).toBe(true);
  });

  it('copies all the allowed origins of a new file to the test origins, and keeps a public profile without them', async () => {
    root = temporaryRoot();
    const store = openStore();
    const twoOrigins = { startUrl: SITE.startUrl, allowedOrigins: [START_ORIGIN, 'https://static.example.test'] };
    expect(await createProfileFromRequest(usageInput('TEST'), auto(twoOrigins), creationDependenciesOf(store)))
      .toMatchObject({ kind: 'SAVED', result: { ok: true } });
    expect(getProfile(store, 'example-test')?.profile.approvedTestOrigins).toEqual(twoOrigins.allowedOrigins);

    const publicSite = { startUrl: 'https://shop.example.test/', allowedOrigins: ['https://shop.example.test'] };
    expect(await createProfileFromRequest(usageInput('PUBLIC'), auto(publicSite), creationDependenciesOf(store)))
      .toMatchObject({ kind: 'SAVED', result: { ok: true } });
    expect(getProfile(store, 'shop-example-test')?.profile).toMatchObject({ approvedTestOrigins: [], environmentEvidenceRef: null });
  });

  it('uses the one existing file that allows the start origin and starts at the same URL, without creating or changing any file', async () => {
    root = temporaryRoot();
    const store = openStore();
    const existingPath = 'config/targets/shop.json';
    // MI-C: ファイルの開始の URL は、入れた開始の URL と、監査の開始と同じ正規化（`normalizeUrl`。追跡の引数を外す）で一致する。
    const content = writeExistingTarget(existingPath, `${SITE.startUrl}?utm_source=mail`, ['https://cdn.example.test', START_ORIGIN]);
    // 開始の Origin を含まないファイルと、読めないファイルは、候補にしない。
    const otherContent = writeExistingTarget('local/targets/other.json', 'https://other.example.test/', ['https://other.example.test']);
    writeFileSync(join(root, 'local/targets/broken.json'), '{ not json\n', 'utf8');

    const outcome = await createProfileFromRequest(usageInput('TEST'), auto(SITE), creationDependenciesOf(store));
    expect(outcome).toMatchObject({ kind: 'SAVED', result: { ok: true } });
    expect(getProfile(store, 'example-test')?.profile).toMatchObject({
      targetConfigPath: existingPath,
      // テスト環境の Origin は、そのファイルの許可 Origin のうち、開始の URL の Origin。
      approvedTestOrigins: [START_ORIGIN],
      environmentEvidenceRef: UNVERIFIED_REF,
    });
    // 新しい名前のファイルを作らない。すでにあるファイルの中身を書き換えない。
    expect(existsSync(join(root, PATH))).toBe(false);
    expect(readFileSync(join(root, existingPath), 'utf8')).toBe(content);
    expect(readFileSync(join(root, 'local/targets/other.json'), 'utf8')).toBe(otherContent);
    expect(readdirSync(join(root, 'local/targets')).sort()).toEqual(['broken.json', 'other.json']);
  });

  it('stops with the reason when two or more existing files allow the start origin and start at the same URL, and saves nothing', async () => {
    root = temporaryRoot();
    const store = openStore();
    writeExistingTarget('config/targets/shop.json', SITE.startUrl, [START_ORIGIN]);
    writeExistingTarget('local/targets/shop-copy.json', SITE.startUrl, [START_ORIGIN]);
    // 開始の URL が違うファイルは、候補に入れない。
    writeExistingTarget('local/targets/shop-top.json', 'https://example.test/top/', [START_ORIGIN]);
    expect(await createProfileFromRequest(usageInput('TEST'), auto(SITE), creationDependenciesOf(store))).toEqual({
      kind: 'TARGET_AMBIGUOUS',
      candidates: ['config/targets/shop.json', 'local/targets/shop-copy.json'],
    });
    expect(listProfiles(store)).toEqual([]);
    expect(existsSync(join(root, PATH))).toBe(false);
  });

  // MI-C（MI-1 の報告。設計者の判断）: 自動の選び方で既存のファイルを使うのは、開始の URL も一致するときだけ。同じ Origin のファイルがあるのに開始の URL が
  // 一致しないときは、新しいファイルを作らずに止め、理由と候補（同じ Origin のファイル）を返す。
  it('stops without creating a file when the files of the same origin start at another URL, and gives them as the candidates', async () => {
    root = temporaryRoot();
    const store = openStore();
    const topContent = writeExistingTarget('config/targets/shop.json', 'https://example.test/', [START_ORIGIN]);
    writeExistingTarget('local/targets/shop-top.json', 'https://example.test/top/', ['https://cdn.example.test', START_ORIGIN]);
    expect(await createProfileFromRequest(usageInput('TEST'), auto(SITE), creationDependenciesOf(store))).toEqual({
      kind: 'TARGET_START_URL_MISMATCH',
      candidates: ['config/targets/shop.json', 'local/targets/shop-top.json'],
    });
    expect(listProfiles(store)).toEqual([]);
    expect(existsSync(join(root, PATH))).toBe(false);
    expect(readFileSync(join(root, 'config/targets/shop.json'), 'utf8')).toBe(topContent);
    expect(readdirSync(join(root, 'local/targets')).sort()).toEqual(['shop-top.json']);

    // 開始の URL も一致するファイルがちょうど 1 つ加わると、開始の URL が違うファイルがあっても、そのファイルを使う。
    writeExistingTarget('local/targets/shop-admin.json', SITE.startUrl, [START_ORIGIN]);
    expect(await createProfileFromRequest(usageInput('TEST'), auto(SITE), creationDependenciesOf(store)))
      .toMatchObject({ kind: 'SAVED', result: { ok: true } });
    expect(getProfile(store, 'example-test')?.profile.targetConfigPath).toBe('local/targets/shop-admin.json');
  });

  it('adds -2 to a suggested name taken by a profile or by a file to create', async () => {
    root = temporaryRoot();
    const store = openStore();
    expect(await createProfileFromRequest(usageInput('TEST'), auto(SITE), creationDependenciesOf(store)))
      .toMatchObject({ kind: 'SAVED', result: { ok: true } });
    // 2 つ目: 同じ開始の Origin のファイル（1 つ目が作った local/targets/example-test.json）を使い、名前に -2 を付ける。
    expect(await createProfileFromRequest(usageInput('PUBLIC'), auto(SITE), creationDependenciesOf(store)))
      .toMatchObject({ kind: 'SAVED', result: { ok: true } });
    expect(getProfile(store, 'example-test-2')?.profile.targetConfigPath).toBe(PATH);
    // 作るファイルの名前（local/targets/<名前>.json）が、ほかのサイトのファイルとして既にあれば、その名前も使わない。
    const otherSite = { startUrl: 'https://other.example.test/', allowedOrigins: ['https://other.example.test'] };
    writeExistingTarget('local/targets/other-example-test.json', 'https://kept.example.test/', ['https://kept.example.test']);
    expect(await createProfileFromRequest(usageInput('PUBLIC'), auto(otherSite), creationDependenciesOf(store)))
      .toMatchObject({ kind: 'SAVED', result: { ok: true } });
    expect(getProfile(store, 'other-example-test-2')?.profile.targetConfigPath).toBe('local/targets/other-example-test-2.json');
  });

  // PL-U（設計書 14.1 の U7）: 名前は自動で作るので、作るファイルの名前が Windows の予約名に当たるときは、拒まずに番号を付けた名前にする（予約名の判定は
  // `isReservedTargetConfigName` の 1 か所。名前の案の部品 `uniqueProfileIdOf` が使う）。
  it('gives a numbered name instead of rejecting when the name of the new file would be a Windows reserved name', async () => {
    root = temporaryRoot();
    const store = openStore();
    const reservedSite: TargetSiteInput = { startUrl: 'https://con/', allowedOrigins: ['https://con'] };
    expect(await createProfileFromRequest(usageInput('TEST'), auto(reservedSite), creationDependenciesOf(store)))
      .toMatchObject({ kind: 'SAVED', result: { ok: true } });
    expect(getProfile(store, 'con-2')?.profile.targetConfigPath).toBe('local/targets/con-2.json');
    for (const name of ['nul', 'com1', 'lpt9']) {
      expect(await createProfileFromRequest(usageInput('TEST', { profileId: name }), { choice: 'NEW', site: SITE }, creationDependenciesOf(store)), name)
        .toMatchObject({ kind: 'SAVED', result: { ok: true } });
      expect(getProfile(store, name), name).toBeNull();
      expect(getProfile(store, `${name}-2`)?.profile.targetConfigPath, name).toBe(`local/targets/${name}-2.json`);
    }
  });

  it('uses the values sent from the advanced settings as they are', async () => {
    root = temporaryRoot();
    const store = openStore();
    writeExistingTarget('config/targets/shop.json', SITE.startUrl, [START_ORIGIN]);
    // 名前と、新しく作る選び方（MI-C: 明示の `NEW`。設定のファイルのパスの項目を印に使わない）と、確かめた記録の参照を、利用者が決めた。
    const input = usageInput('TEST', { profileId: 'my-own', environmentEvidenceRef: 'isolation-checked-ref' });
    expect(await createProfileFromRequest(input, { choice: 'NEW', site: SITE }, creationDependenciesOf(store))).toMatchObject({ kind: 'SAVED', result: { ok: true } });
    expect(getProfile(store, 'my-own')?.profile).toMatchObject({
      targetConfigPath: 'local/targets/my-own.json',
      environmentEvidenceRef: 'isolation-checked-ref',
      approvedTestOrigins: [START_ORIGIN],
    });
    // 名前を決めて重なったときは、番号を付けずに拒む（ファイルも作らない）。
    expect(await createProfileFromRequest(usageInput('TEST', { profileId: 'my-own' }), { choice: 'NEW', site: SITE }, creationDependenciesOf(store)))
      .toMatchObject({ kind: 'PROFILE_REJECTED', reason: 'PROFILE_ALREADY_EXISTS' });
    // 自動の選び方では、同じ Origin で開始の URL も同じファイルが 2 つ（すでにあるものと、今作ったもの）になったので、選ばずに止める。
    expect(await createProfileFromRequest(usageInput('TEST'), auto(SITE), creationDependenciesOf(store)))
      .toMatchObject({ kind: 'TARGET_AMBIGUOUS', candidates: ['config/targets/shop.json', 'local/targets/my-own.json'] });
    // すでにある設定のファイルを選んだとき（開始の URL を送らない）は、名前とテスト環境の Origin を、そのファイルの開始の URL から決める。
    const chosen = usageInput('TEST', { targetConfigPath: 'config/targets/shop.json' });
    expect(await createProfileFromRequest(chosen, { choice: 'EXISTING' }, creationDependenciesOf(store))).toMatchObject({ kind: 'SAVED', result: { ok: true } });
    expect(getProfile(store, 'example-test')?.profile).toMatchObject({
      targetConfigPath: 'config/targets/shop.json',
      approvedTestOrigins: [START_ORIGIN],
      environmentEvidenceRef: UNVERIFIED_REF,
    });
  });
});
