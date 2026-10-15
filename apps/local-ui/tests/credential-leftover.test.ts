/**
 * T26g-3（T26g-2 の発見 2）: 資格情報のファイルが残っているかの、サーバの判定（`src/server/credential-service.ts` の `credentialRemainsOf`）。
 * プロファイルの詳細の画面は、認証の方式が自動ログインでなくても、ファイルが残っていれば、資格情報の画面へのリンクを出す（判定はサーバで行い、
 * 画面に渡す）。判定は、資格情報の画面と同じ読み出し（`credentialPageOf`）を使う（読めないファイルも「残っている」）。
 * - 管理データは一時のフォルダ、資格情報のファイルの部品は偽の暗号化の部品（`tests/helpers/test-credential-store.ts`）。本物の DPAPI は使わない。
 */
import { writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SITE_PROFILE_SCHEMA_VERSION, type SiteProfile } from '../../../src/control/contracts.js';
import { credentialFilePathFor } from '../../../src/control/credentials/credential-store.js';
import type { CredentialChangeCheck } from '../../../src/control/job/audit-job-manager.js';
import type { ProfileValidationContext } from '../../../src/control/profile-policy.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../../src/control/store/database-path.js';
import { createProfile } from '../../../src/control/store/profile-store.js';
import { createTestConfig } from '../../../tests/helpers/test-config.js';
import { createTestCredentialStore, type TestCredentialStore } from '../../../tests/helpers/test-credential-store.js';
import { credentialRemainsOf, type CredentialServiceDependencies } from '../src/server/credential-service';

const TEST_ORIGIN = 'https://app.example.invalid';
const MANUAL_PROFILE = 't26g3-manual';
const TARGET_PATH = 'config/targets/t26g3.json';
const FIRST_REVISION = 1;
const RUN = `${process.pid}-${Date.now()}`;

const context: ProfileValidationContext = {
  targetConfig: { ...createTestConfig(TEST_ORIGIN), site: { startUrl: `${TEST_ORIGIN}/`, allowedOrigins: [TEST_ORIGIN] } },
};
const resolveContext = (path: string): ProfileValidationContext | undefined => (path === TARGET_PATH ? context : undefined);

const manualProfile: SiteProfile = {
  schemaVersion: SITE_PROFILE_SCHEMA_VERSION,
  profileId: MANUAL_PROFILE,
  revision: FIRST_REVISION,
  targetConfigPath: TARGET_PATH,
  environment: 'TEST',
  mode: 'TEST_AUTH_PASSIVE',
  auth: 'MANUAL_SESSION',
  approvedTestOrigins: [TEST_ORIGIN],
  environmentEvidenceRef: 'evidence/t26g3',
};

let root = '';
let database: ControlDatabase;
let credentials: TestCredentialStore;

const deps = (): CredentialServiceDependencies => ({
  database,
  store: credentials.store,
  checkCredentialChange: (): CredentialChangeCheck => ({ ok: true }),
  platformSupported: () => true,
  environment: async () => 'AVAILABLE',
  now: () => new Date(Date.UTC(2026, 9, 11, 9, 0, 0)),
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'beaksight-t26g3-leftover-'));
  database = openControlDatabase(resolveControlDatabasePath(root));
  credentials = await createTestCredentialStore();
  expect(createProfile(database, manualProfile, { resolveContext }).ok).toBe(true);
});

afterEach(async () => {
  closeControlDatabase(database);
  await credentials.remove();
  await rm(root, { recursive: true, force: true });
});

describe('T26g-3: whether a credential file remains (judged on the server)', () => {
  it('is false without a file and for a missing profile', async () => {
    expect(await credentialRemainsOf(deps(), MANUAL_PROFILE)).toBe(false);
    expect(await credentialRemainsOf(deps(), 'not-there')).toBe(false);
  });

  it('is true for a file left on a profile that is not an automated login profile', async () => {
    expect(await credentials.store.register({
      profileId: MANUAL_PROFILE, loginOrigin: TEST_ORIGIN, username: `t26g3-user-${RUN}`, password: `t26g3-pass-${RUN}`,
    })).toMatchObject({ credentialRevision: 1 });
    expect(await credentialRemainsOf(deps(), MANUAL_PROFILE)).toBe(true);
  });

  it('is true for a file that cannot be read (it still remains, and the credential screen can remove it)', async () => {
    expect(await credentials.store.register({
      profileId: MANUAL_PROFILE, loginOrigin: TEST_ORIGIN, username: `t26g3-user-${RUN}`, password: `t26g3-pass-${RUN}`,
    })).toMatchObject({ credentialRevision: 1 });
    writeFileSync(credentialFilePathFor(credentials.store.directory, MANUAL_PROFILE), '{');
    expect(await credentialRemainsOf(deps(), MANUAL_PROFILE)).toBe(true);
  });
});
