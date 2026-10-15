/**
 * 画面の Server Functions を、ビルドした画面のサーバ（一時の root）に HTTP で直接送って確かめる（Task 23 設計書 4.3、4.4、4.6、7 章「画面」。T23f）。
 * - 入力の検証（スキーマに合わない入力は 400 で拒否し、保存しない）、作成・一覧・取得・更新・取り消し、改訂の衝突、受けないパス、
 *   設定のファイルの候補と確かめ、環境の状態、起動し直しても残ること、管理データの準備の失敗で起動が止まること。
 * - 管理データは、一時の root の `local-data/` にだけできる（リポジトリの `local-data/` を作らない）。設定のファイルは
 *   `config/targets/example.json` の写しだけを使う（`local/` を使わない）。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONTROL_SCHEMA_VERSION } from '../../../src/control/store/migrations.js';
import { CONTROL_STORE_FAILURE_DESCRIPTIONS } from '../../../src/presentation/messages.js';
import { snapshotDirectory } from '../../../tests/helpers/temporary-build.js';
import {
  REPO_ROOT,
  createTemporaryUiRoot,
  findFreePort,
  parseSetCookie,
  rawRequest,
  runLauncherUntilExit,
  startLauncher,
  stopServer,
  type StartedServer,
  type TemporaryUiRoot,
} from './helpers/local-server.ts';
import { callServerFunction, readServerFunctionIds, type ServerFunctionCall } from './helpers/server-functions.ts';

/** HTTP の状態。 */
const STATUS = Object.freeze({ OK: 200, BAD_REQUEST: 400 });
/** 起動の部品が準備の失敗で止まるときの終了コード。 */
const PREPARATION_FAILED_EXIT_CODE = 1;
/** 管理データの場所（一時の root からの相対）。 */
const DATABASE_LOCATION = 'local-data/beaksight-control.sqlite';
/** テストの値（匿名）。 */
const PROFILE_ID = 't23f-public';

const validProfile = (overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> => ({
  schemaVersion: 'beaksight-profile/1',
  profileId: PROFILE_ID,
  revision: 1,
  targetConfigPath: 'config/targets/example.json',
  environment: 'PUBLIC',
  mode: 'PUBLIC_PASSIVE',
  auth: 'NONE',
  approvedTestOrigins: [],
  environmentEvidenceRef: null,
  ...overrides,
});

let root: TemporaryUiRoot | undefined;
let server: StartedServer | undefined;
let cookie = '';
let ids: ReadonlyMap<string, string> = new Map();

const startOn = async (temporaryRoot: TemporaryUiRoot): Promise<StartedServer> => {
  const started = await startLauncher(temporaryRoot, await findFreePort());
  const exchange = await rawRequest(started.port, `${started.tokenUrl.pathname}${started.tokenUrl.search}`);
  cookie = parseSetCookie(exchange.headers['set-cookie'])?.pair ?? '';
  return started;
};

const call = (name: string, method: 'GET' | 'POST', data?: unknown, rawPayload?: string): Promise<ServerFunctionCall> => {
  if (server === undefined) {
    throw new Error('サーバが起動していない');
  }
  return callServerFunction({ port: server.port, origin: server.origin, cookie, ids }, name, method, data, rawPayload);
};

const listedIds = async (): Promise<readonly string[]> => {
  const result = await call('listProfilesFn', 'GET');
  expect(result.response.status).toBe(STATUS.OK);
  return (result.value as readonly { profileId: string }[]).map((row) => row.profileId);
};

/**
 * リポジトリの `local-data/` の様子（T24g）。ある・なし、ファイルとフォルダの一覧、更新の時刻、大きさだけ（中身は読まない）。テストの前に
 * 1 回取り、テストの間に作られない・変えられないことを確かめる（リポジトリに `local-data/` があってもなくても同じに確かめる）。
 */
const REPOSITORY_LOCAL_DATA = `${REPO_ROOT}/local-data`;
let repositoryLocalDataBefore: Awaited<ReturnType<typeof snapshotDirectory>> | undefined;

beforeAll(async () => {
  repositoryLocalDataBefore = await snapshotDirectory(REPOSITORY_LOCAL_DATA);
  root = createTemporaryUiRoot('built');
  ids = readServerFunctionIds(`${root.root}/apps/local-ui/dist/server/server.js`);
  server = await startOn(root);
});

afterAll(async () => {
  await stopServer(server);
  root?.remove();
  // 起動し直しと、準備の失敗の場面の後も、リポジトリの `local-data/` は作られず、変わっていない。
  expect(await snapshotDirectory(REPOSITORY_LOCAL_DATA)).toEqual(repositoryLocalDataBefore);
});

describe('Server Functions: preparation and environment', () => {
  it('prepares local-data/ under the temporary root before listening (and does not create or change the repository local-data/)', async () => {
    expect(existsSync(`${root?.root}/${DATABASE_LOCATION}`)).toBe(true);
    // T24g: リポジトリに `local-data/` がある環境でも確かめられるよう、「ない」ではなく「テストの前と同じ」を確かめる（なければ、ないまま）。
    // 前提: テストの間、利用者が自分の画面のサーバ（リポジトリの `local-data/` を使うもの）を動かしていないこと（動かしていると、その書き込みで揺れうる）。
    expect(repositoryLocalDataBefore).not.toBeUndefined();
    expect(await snapshotDirectory(REPOSITORY_LOCAL_DATA)).toEqual(repositoryLocalDataBefore);
  });

  it('lists every Server Function by name', () => {
    expect([...ids.keys()].sort()).toEqual([
      // T28e: シナリオの画面の Server Functions（Task 28 の設計書 4.6）。シナリオの画面の関数は、実行の許可を出さない。T30g から、実行の許可を
      // 出すのは、書き込みの開始の 2 つ（`writeStartPageFn`・`startWriteCreateFn`。`write-job-functions.ts`）のうち、開始の `startWriteCreateFn`
      // だけである（`writeStartPageFn` は読むだけ）。画面のコードで実行の許可の発行を参照するのが、その 1 ファイルだけであることは、Gate
      // `approval-ssot` の (e) で確かめる。
      'approveScenarioFn',
      // T24f: 監査のジョブの Server Functions（Task 24 の設計書 4.8）。
      'auditStartSummaryFn',
      // T32g: 監査済みデータの台帳の画面の Server Function（Task 32 の設計書 4.1。読むだけ。`ledger-functions.ts`）。
      'auditedDataLedgerPageFn',
      // T27f: 操作の候補と READ の確かめの Server Functions（Task 27 の設計書 4.7）。
      'cancelReadCheckFn',
      // T26e: 資格情報の画面と、ログインの確かめの Server Functions（Task 26 の設計書 4.2、4.6）。
      'changeCredentialFn',
      'checkTargetConfigFn',
      'clearAutoLoginHoldFn',
      'createProfileFn',
      'createReadCheckFn',
      'createScenarioFn',
      // T29e: 入力の規則の画面の Server Functions（Task 29 の設計書 4.4。実行の許可を出す関数はない）。
      'dataRulePageFn',
      'discoveryPageFn',
      'environmentStatusFn',
      'getAuditJobFn',
      // T25e: 認証の設定の Server Functions（Task 25 の設計書 4.5）。
      'getAuthSetupFn',
      'getCredentialPageFn',
      'getProfileFn',
      'listAuditJobsFn',
      'listProfilesFn',
      'readCheckPageFn',
      'registerCredentialFn',
      'removeCredentialFn',
      'replaceCredentialFn',
      'retireProfileFn',
      'revokeScenarioFn',
      'saveAuthSetupFn',
      'saveDataRulesFn',
      'scenarioDetailPageFn',
      'scenarioFormPageFn',
      'scenarioListPageFn',
      'startAuditJobFn',
      'startDiscoveryFn',
      'startLoginCheckFn',
      'startReadCheckFn',
      // T30g: 書き込みの開始の Server Functions（Task 30 の設計書 3 章。実行の許可を出すのは `startWriteCreateFn` だけ。上の T28e の説明）。
      // T31h-2: UPDATE の開始の `startWriteUpdateFn` も許可を出す（同じ `write-job-functions.ts`。Gate `approval-ssot` の (e)）。
      'startWriteCreateFn',
      'startWriteUpdateFn',
      'stopAuditJobFn',
      'targetConfigCandidatesFn',
      'updateProfileFn',
      'updateReadCheckFn',
      'updateScenarioFn',
      'writeStartPageFn',
    ]);
  });

  it('returns the environment status with the relative database location only', async () => {
    const result = await call('environmentStatusFn', 'GET');
    expect(result.response.status).toBe(STATUS.OK);
    expect(result.value).toMatchObject({
      nodeVersion: process.versions.node,
      databaseLocation: DATABASE_LOCATION,
      // T24f: 管理データの版は、版の管理の最新（`CONTROL_SCHEMA_VERSION`。Task 24 で版 2）。新しく作った管理データは最新の版になる。
      schemaVersion: CONTROL_SCHEMA_VERSION,
      latestSchemaVersion: CONTROL_SCHEMA_VERSION,
      quickCheckOk: true,
      listenHost: '127.0.0.1',
    });
    expect(result.response.body).not.toContain(root?.root ?? '');
  });

  it('lists the target configuration candidates (config/targets/ only in the temporary root) and checks them', async () => {
    expect((await call('targetConfigCandidatesFn', 'GET')).value).toEqual(['config/targets/example.json']);
    expect((await call('checkTargetConfigFn', 'GET', { targetConfigPath: 'config/targets/example.json' })).value).toEqual({ ok: true });
    expect((await call('checkTargetConfigFn', 'GET', { targetConfigPath: 'config/targets/missing.json' })).value).toEqual({
      ok: false,
      pathAccepted: true,
      configError: 'CONFIG_FILE_NOT_FOUND',
    });
    expect((await call('checkTargetConfigFn', 'GET', { targetConfigPath: '../outside.json' })).value).toEqual({ ok: false, pathAccepted: false });
  });
});

describe('Server Functions: input validation (schemas/control/ui-*)', () => {
  it('rejects inputs that do not match the schema with 400, and saves nothing', async () => {
    const rejected: readonly [string, 'GET' | 'POST', unknown][] = [
      ['createProfileFn', 'POST', { profile: 'not an object' }],
      ['createProfileFn', 'POST', {}],
      ['createProfileFn', 'POST', { profile: validProfile(), extra: true }],
      ['updateProfileFn', 'POST', { profile: validProfile({ revision: 2 }), expectedRevision: '1' }],
      ['updateProfileFn', 'POST', { profile: validProfile({ revision: 2 }) }],
      ['retireProfileFn', 'POST', { profileId: 'NOT A VALID ID', expectedRevision: 1 }],
      ['retireProfileFn', 'POST', { profileId: PROFILE_ID, expectedRevision: 0 }],
      ['getProfileFn', 'GET', { profileId: '' }],
      ['checkTargetConfigFn', 'GET', { targetConfigPath: 1 }],
    ];
    for (const [name, method, data] of rejected) {
      const result = await call(name, method, data);
      expect(result.response.status, `${name} ${JSON.stringify(data)}`).toBe(STATUS.BAD_REQUEST);
      expect(result.response.headers['cache-control']).toBe('no-store');
    }
    expect(await listedIds()).toEqual([]);
  });
});

describe('Server Functions: create, list, get, update, retire', () => {
  it('creates a profile, lists it and gets it', async () => {
    const created = await call('createProfileFn', 'POST', { profile: validProfile() });
    expect(created.response.status).toBe(STATUS.OK);
    expect(created.value).toMatchObject({ ok: true, detail: { status: 'ACTIVE', profile: { profileId: PROFILE_ID, revision: 1 } } });
    expect(await listedIds()).toEqual([PROFILE_ID]);
    const detail = await call('getProfileFn', 'GET', { profileId: PROFILE_ID });
    expect(detail.value).toMatchObject({ status: 'ACTIVE', profile: validProfile() });
    expect((detail.value as { updatedAt: string }).updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u);
    expect((await call('getProfileFn', 'GET', { profileId: 'not-there' })).value).toBeNull();
  });

  it('rejects an invalid profile with the Task 22 codes, a path that is not accepted, and a missing target configuration', async () => {
    const invalid = await call('createProfileFn', 'POST', { profile: validProfile({ profileId: 't23f-invalid', mode: 'TEST_AUTH_PASSIVE' }) });
    expect(invalid.value).toMatchObject({ ok: false, reason: 'PROFILE_INVALID' });
    expect((invalid.value as { errorCodes: string[] }).errorCodes).toContain('PROFILE_MODE_ENVIRONMENT_MISMATCH');

    const pathNotAccepted = await call('createProfileFn', 'POST', { profile: validProfile({ profileId: 't23f-path', targetConfigPath: '../outside.json' }) });
    expect(pathNotAccepted.value).toMatchObject({ ok: false, reason: 'PROFILE_INVALID', errorCodes: ['PROFILE_TARGET_PATH_INVALID'], configError: null });

    const missing = await call('createProfileFn', 'POST', {
      profile: validProfile({ profileId: 't23f-missing', targetConfigPath: 'config/targets/missing.json' }),
    });
    expect(missing.value).toMatchObject({ ok: false, reason: 'TARGET_CONFIG_UNAVAILABLE', configError: 'CONFIG_FILE_NOT_FOUND' });

    const duplicate = await call('createProfileFn', 'POST', { profile: validProfile() });
    expect(duplicate.value).toMatchObject({ ok: false, reason: 'PROFILE_ALREADY_EXISTS' });
    expect(await listedIds()).toEqual([PROFILE_ID]);
  });

  it('updates to the next revision, and rejects a stale expected revision as a conflict', async () => {
    const updated = await call('updateProfileFn', 'POST', { profile: validProfile({ revision: 2 }), expectedRevision: 1 });
    expect(updated.value).toMatchObject({ ok: true, detail: { profile: { revision: 2 } } });
    const stale = await call('updateProfileFn', 'POST', { profile: validProfile({ revision: 2 }), expectedRevision: 1 });
    expect(stale.value).toMatchObject({ ok: false, reason: 'PROFILE_REVISION_CONFLICT' });
  });

  it('retires the profile (a new revision), and then refuses changes and reuse of the profileId', async () => {
    const retired = await call('retireProfileFn', 'POST', { profileId: PROFILE_ID, expectedRevision: 2 });
    expect(retired.value).toMatchObject({ ok: true, detail: { status: 'RETIRED', profile: { revision: 3 } } });
    expect((await call('updateProfileFn', 'POST', { profile: validProfile({ revision: 4 }), expectedRevision: 3 })).value)
      .toMatchObject({ ok: false, reason: 'PROFILE_RETIRED' });
    expect((await call('createProfileFn', 'POST', { profile: validProfile() })).value).toMatchObject({ ok: false, reason: 'PROFILE_ALREADY_EXISTS' });
  });

  it('keeps the profiles after the server restarts', async () => {
    await stopServer(server);
    if (root === undefined) {
      throw new Error('一時の root がない');
    }
    server = await startOn(root);
    const detail = await call('getProfileFn', 'GET', { profileId: PROFILE_ID });
    expect(detail.value).toMatchObject({ status: 'RETIRED', profile: { revision: 3 } });
  });
});

describe('Launcher: the control data preparation stops the start', () => {
  it('does not listen and exits non-zero with the setup:local explanation when the database is not a SQLite file', async () => {
    const broken = createTemporaryUiRoot('built');
    try {
      mkdirSync(`${broken.root}/local-data`);
      const databasePath = `${broken.root}/${DATABASE_LOCATION}`;
      writeFileSync(databasePath, 'a note that the user saved here\n');
      const before = createHash('sha256').update(readFileSync(databasePath)).digest('hex');
      const result = runLauncherUntilExit(broken, await findFreePort());
      expect(result.status).toBe(PREPARATION_FAILED_EXIT_CODE);
      expect(result.output).toContain(CONTROL_STORE_FAILURE_DESCRIPTIONS.NOT_A_SQLITE_FILE.description);
      expect(result.output).toContain(CONTROL_STORE_FAILURE_DESCRIPTIONS.NOT_A_SQLITE_FILE.action);
      expect(result.output).toContain(DATABASE_LOCATION);
      expect(result.output).not.toMatch(/token=/u);
      expect(createHash('sha256').update(readFileSync(databasePath)).digest('hex')).toBe(before);
    } finally {
      broken.remove();
    }
  });
});
