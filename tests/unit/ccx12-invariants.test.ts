// CCX-12（台帳の CC-073、CC-076、CC-078 の後半）: 共通化の前と後で、結果が変わらないことを固定する表。
// - CC-073: 誤りのコードの取り出し。置き換える前のインラインの式（`isRecord(error) && error.code === …`）と、`errorCodeOf` を使う式が、どの値でも
//   同じ判定になる。置き換えた所（Run のファイルの読み込み、Run のディレクトリの作成と一覧、プロセスの生死、設定の読み込み）の結果も固定する。
// - CC-076: 実際の method の式と、`_method` の欄の名前の判定（畳み込みで比べる）。分類とシナリオの下書きの確かめの結果を、畳み込みの変種でも固定する。
// - CC-078 の後半: 鍵を並べた JSON から求める 2 つの digest の値を固定する（置き換えの前の値）。
// 例の値は、匿名の値（`127.0.0.1`、`example`）だけを使う。
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { artifactFileReader } from '../../src/cli/audit-run.js';
import { ConfigError } from '../../src/config/config-error.js';
import { loadConfig } from '../../src/config/load-config.js';
import { validateScenarioDraft } from '../../src/control/approval/scenario-policy.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../helpers/auth-setup-samples.js';
import {type AuthSetup } from '../../src/control/auth/auth-setup-contracts.js';
import { authSetupDigestOf } from '../../src/control/auth/auth-setup-digest.js';
import { workerAuthenticationDigestOf } from '../../src/control/worker-protocol.js';
import { createRunArtifactDirectory, listRunDirectories } from '../../src/core/artifact-layout.js';
import { errorCodeOf } from '../../src/core/errors.js';
import { isRecord } from '../../src/core/guards.js';
import { createRunId } from '../../src/core/ids.js';
import { isProcessRunning } from '../../src/core/process-lock.js';
import { foldNfkcCase } from '../../src/core/text.js';
import {
  FORM_METHODS,
  METHOD_OVERRIDE_FIELD_NAME,
  METHOD_OVERRIDE_VALUES,
  effectiveFormMethodOf,
  isMethodOverrideFieldName,
  type FormMethod,
  type MethodOverride,
} from '../../src/discovery/candidate-contracts.js';
import { classifyCandidate } from '../../src/discovery/classify.js';
import { CREATE_CANDIDATE, READ_CHECK_FACTS, candidateOf, sampleDraft } from './approval-samples.js';
import { SAMPLE_ALLOWED_ORIGINS, sampleField, sampleForm } from './discovery-candidate-samples.js';

const temporaryDirectories: string[] = [];
const createTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'beaksight-ccx12-'));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true })));
});

describe('CC-073: the error code readers keep their decisions', () => {
  /** 数の `code`（文字列でない。どの判定にも当たらない）。 */
  const NUMERIC_ERROR_CODE = -2;
  const errorWithCode = (code: unknown): Error => Object.assign(new Error('example'), { code });

  /** 誤りの値と、取り出すコード（文字列でなければ null）。 */
  const ERROR_CODE_TABLE: readonly (readonly [label: string, error: unknown, code: string | null])[] = [
    ['an ENOENT error', errorWithCode('ENOENT'), 'ENOENT'],
    ['an EEXIST error', errorWithCode('EEXIST'), 'EEXIST'],
    ['an EPERM error', errorWithCode('EPERM'), 'EPERM'],
    ['an ENOTDIR error', errorWithCode('ENOTDIR'), 'ENOTDIR'],
    ['an EISDIR error', errorWithCode('EISDIR'), 'EISDIR'],
    ['a plain object with a code', { code: 'ENOENT' }, 'ENOENT'],
    ['an error with a numeric code', errorWithCode(NUMERIC_ERROR_CODE), null],
    ['an error with a lower-case code', errorWithCode('enoent'), 'enoent'],
    ['an error without a code', new Error('example'), null],
    ['an array with a code', Object.assign(['example'], { code: 'ENOENT' }), null],
    ['a function with a code', Object.assign(() => undefined, { code: 'ENOENT' }), null],
    ['a string', 'ENOENT', null],
    ['null', null, null],
    ['undefined', undefined, null],
  ];

  /** 置き換える前のインラインの式（`audit-run.ts`、`load-config.ts`、`artifact-layout.ts`、`process-lock.ts`）の写し。 */
  const MISSING_OUTPUT_DIRECTORY_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR']);
  const LEGACY_DECISIONS: readonly (readonly [site: string, legacy: (error: unknown) => boolean, current: (error: unknown) => boolean])[] = [
    ['ENOENT (audit-run, load-config)', (error) => isRecord(error) && error.code === 'ENOENT', (error) => errorCodeOf(error) === 'ENOENT'],
    ['EEXIST (artifact-layout)', (error) => isRecord(error) && error.code === 'EEXIST', (error) => errorCodeOf(error) === 'EEXIST'],
    ['EPERM (process-lock)', (error) => isRecord(error) && error.code === 'EPERM', (error) => errorCodeOf(error) === 'EPERM'],
    [
      'a missing output directory (artifact-layout)',
      (error) => isRecord(error) && typeof error.code === 'string' && MISSING_OUTPUT_DIRECTORY_CODES.has(error.code),
      (error) => {
        const code = errorCodeOf(error);
        return code !== null && MISSING_OUTPUT_DIRECTORY_CODES.has(code);
      },
    ],
  ];

  it.each(ERROR_CODE_TABLE)('reads the code of %s', (_label, error, code) => {
    expect(errorCodeOf(error)).toBe(code);
  });

  it.each(LEGACY_DECISIONS)('decides %s the same way as the inline expression', (_site, legacy, current) => {
    for (const [label, error] of ERROR_CODE_TABLE) {
      expect(current(error), label).toBe(legacy(error));
    }
  });

  it.each(ERROR_CODE_TABLE)('treats a process as running only when signalling it fails with EPERM (%s)', (_label, error, code) => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw error;
    });
    expect(isProcessRunning(process.pid)).toBe(code === 'EPERM');
  });

  it('reads a missing run file as null, and rethrows the other failures', async () => {
    const runDirectory = await createTemporaryDirectory();
    await mkdir(join(runDirectory, 'folder'));
    await writeFile(join(runDirectory, 'run.json'), '{}');
    const read = artifactFileReader(runDirectory);
    expect(await read('missing.json')).toBeNull();
    const content = await read('run.json');
    expect(content === null ? null : new TextDecoder().decode(content)).toBe('{}');
    const failure = await read('folder').then(() => null, (error: unknown) => error);
    expect(errorCodeOf(failure)).not.toBeNull();
    expect(errorCodeOf(failure)).not.toBe('ENOENT');
  });

  it('marks an existing run directory, and lists a missing output directory or a file as empty', async () => {
    const outputDirectory = await createTemporaryDirectory();
    const runId = createRunId(1);
    expect(await createRunArtifactDirectory(outputDirectory, runId)).toMatchObject({ ok: true });
    expect(await createRunArtifactDirectory(outputDirectory, runId)).toMatchObject({ ok: false, alreadyExists: true });
    const file = join(outputDirectory, 'file.txt');
    await writeFile(file, 'example');
    expect(await createRunArtifactDirectory(file, runId)).toMatchObject({ ok: false, alreadyExists: false });
    expect(await listRunDirectories(join(outputDirectory, 'missing'))).toEqual([]);
    expect(await listRunDirectories(file)).toEqual([]);
    expect(await listRunDirectories(join(file, 'below'))).toEqual([]);
    expect((await listRunDirectories(outputDirectory)).map((entry) => entry.runId)).toEqual([runId]);
  });

  it('reports a missing config file as not found, and a directory as unreadable', async () => {
    const directory = await createTemporaryDirectory();
    const kindOf = async (path: string): Promise<string> =>
      loadConfig(path).then(() => 'LOADED', (error: unknown) => (error instanceof ConfigError ? error.kind : 'OTHER'));
    expect(await kindOf(join(directory, 'missing.json'))).toBe('CONFIG_FILE_NOT_FOUND');
    expect(await kindOf(directory)).toBe('CONFIG_FILE_UNREADABLE');
  });
});

describe('CC-076: the effective method and the _method field name keep their results', () => {
  /** 置き換える前の式（`classify.ts` の実際の method と、`_method` の欄の名前の判定）の写し。 */
  const legacyEffectiveMethod = (formMethod: FormMethod | null, methodOverride: MethodOverride | null): FormMethod | MethodOverride | null =>
    formMethod === 'POST' && methodOverride !== null ? methodOverride : formMethod;
  const legacyIsMethodOverrideFieldName = (name: string): boolean => foldNfkcCase(name) === METHOD_OVERRIDE_FIELD_NAME;

  const EFFECTIVE_METHOD_TABLE: readonly (readonly [FormMethod | null, MethodOverride | null, FormMethod | MethodOverride | null])[] = [
    ['POST', null, 'POST'],
    ['POST', 'PUT', 'PUT'],
    ['POST', 'PATCH', 'PATCH'],
    ['POST', 'DELETE', 'DELETE'],
    ['GET', null, 'GET'],
    ['GET', 'PUT', 'GET'],
    ['GET', 'DELETE', 'GET'],
    ['DIALOG', 'PATCH', 'DIALOG'],
    [null, null, null],
    [null, 'PUT', null],
  ];

  /** 欄の名前と、`_method` の欄か（NFKC と大文字小文字の畳み込みで比べる）。 */
  const FIELD_NAME_TABLE: readonly (readonly [string, boolean])[] = [
    ['_method', true],
    ['_METHOD', true],
    ['_Method', true],
    ['\uFF3F\uFF4D\uFF45\uFF54\uFF48\uFF4F\uFF44', true],
    ['method', false],
    ['_methods', false],
    [' _method', false],
    ['_method ', false],
    ['', false],
  ];

  it.each(EFFECTIVE_METHOD_TABLE)('keeps the effective method of %s with the override %s', (formMethod, methodOverride, expected) => {
    expect(legacyEffectiveMethod(formMethod, methodOverride)).toBe(expected);
    expect(effectiveFormMethodOf({ formMethod, methodOverride })).toBe(expected);
  });

  it('covers every form method and override in the effective method table', () => {
    for (const formMethod of [...FORM_METHODS, null]) {
      for (const methodOverride of [...METHOD_OVERRIDE_VALUES, null]) {
        const expected = formMethod === 'POST' && methodOverride !== null ? methodOverride : formMethod;
        expect(legacyEffectiveMethod(formMethod, methodOverride), `${String(formMethod)} ${String(methodOverride)}`).toBe(expected);
        expect(effectiveFormMethodOf({ formMethod, methodOverride }), `${String(formMethod)} ${String(methodOverride)}`).toBe(expected);
      }
    }
  });

  it.each(FIELD_NAME_TABLE)('decides whether %j is the _method field (%s)', (name, expected) => {
    expect(legacyIsMethodOverrideFieldName(name)).toBe(expected);
    expect(isMethodOverrideFieldName(name)).toBe(expected);
  });

  const classified = (formMethod: FormMethod, fieldName: string, type: 'text' | 'hidden') =>
    classifyCandidate(
      sampleForm({ formMethod, fields: [sampleField(fieldName, type, { hasValue: type === 'hidden' })], submitterText: formMethod === 'GET' ? '検索' : '更新' }),
      { allowedOrigins: SAMPLE_ALLOWED_ORIGINS },
    );

  it.each(FIELD_NAME_TABLE)('classifies GET and POST forms with the field %j the same way (%s)', (name, isOverrideField) => {
    if (name === '') {
      return;
    }
    expect(classified('GET', name, 'text')).toMatchObject(isOverrideField
      ? { classification: 'NOT_EXECUTABLE', reasonCode: 'DESTRUCTIVE' }
      : { classification: 'READ', reasonCode: 'READ_GET_FORM' });
    expect(classified('POST', name, 'hidden')).toMatchObject(isOverrideField
      ? { classification: 'DISPLAY_ONLY', reasonCode: 'METHOD_OVERRIDE_UNRECOGNIZED' }
      : { classification: 'UPDATE', reasonCode: 'UPDATE_WORD' });
  });

  it.each(FIELD_NAME_TABLE)('never lets a scenario draft send the _method field %j (%s)', (name, isOverrideField) => {
    if (name === '') {
      return;
    }
    // 下書きは `CREATE_CANDIDATE` の識別の digest を指すので、欄だけを変えた候補にその digest を持たせる。
    const candidate = candidateOf(sampleForm({ submitterText: '登録', fields: [sampleField('name'), sampleField(name)] }));
    expect(candidate.classification).toBe('CREATE');
    const result = validateScenarioDraft(
      sampleDraft({ fieldNames: ['name', name] }),
      { ...candidate, identityDigest: CREATE_CANDIDATE.identityDigest },
      READ_CHECK_FACTS,
    );
    expect(result.ok ? [] : result.errors.map(({ code, fieldName }) => [code, fieldName]))
      .toEqual(isOverrideField ? [['SCENARIO_FIELD_NOT_ALLOWED', name]] : []);
  });
});

describe('CC-078: the digests made from the sorted-keys JSON keep their values', () => {
  const ORIGIN = 'http://127.0.0.1:4173';
  const SETUP: AuthSetup = Object.freeze({
    ...FORM_NAVIGATION_SETUP_ITEMS,
    profileId: 'example-auth',
    profileRevision: 1,
    loginStartUrl: `${ORIGIN}/login`,
    loginPostEndpoints: [{ origin: ORIGIN, path: '/login' }],
    successCondition: { pathPrefix: '/admin', selector: '#admin-ok' },
    sessionLostCondition: { pathPrefix: null },
    excludedPaths: ['/admin/logout'],
    auditPathPrefixes: ['/admin'],
    maxLoginAttempts: 1,
    allowedIdpOrigins: [],
    automatedLogin: {
      usernameSelector: '#user',
      passwordSelector: '#pass',
      submitSelector: '#go',
      failureConditions: {
        invalidCredentials: { pathPrefix: '/login', selector: '#login-failed' },
        accountLocked: null,
        mfaRequired: null,
        credentialExpired: null,
      },
    },
  });
  const CREDENTIAL_REVISION = 2;
  const reordered = (setup: AuthSetup): AuthSetup => Object.fromEntries(Object.entries(setup).reverse()) as unknown as AuthSetup;
  const stored = (setup: AuthSetup) => ({ setup });

  // T28R-fix-1（独立レビュー T28R の I-1）: 認証の設定の digest に、資格情報の変更の最後の出来事の id を足し、形の印を版 2 に上げた（意図した値の
  // 変化）。前の値（版 1）は `sha256:86d0ab6a…`・`sha256:cf94991c…` だった。新しい値は、T28R-fix-1 の build の `dist` から求めた。
  // LG-3b（2026-10-24 のテストの組の設計 3.7.2）: 見本の設定を版 2 から版 3（フォームの送信）に替えたので、下の 4 つの値は版 3 の見本の値に置き換えた
  // （digest の求め方は変えていない。版 3 の値が前と同じことは `auth-setup-digest.test.ts` の、変更の前のコードで固定した値で確かめる）。前の版 2 の見本の値は
  // `sha256:c7749d84…`・`sha256:0055b842…`・`fdc37868…`・`4ea842b8…` だった。
  const CREDENTIAL_EVENT_ID = 3;
  it('keeps the auth setup digest', () => {
    expect(authSetupDigestOf(stored(SETUP), { credentialRevision: CREDENTIAL_REVISION, lastCredentialEventId: CREDENTIAL_EVENT_ID }))
      .toBe('sha256:c092f3d2497f79d58e2d2eac63707fef1918cf2358993b12ea32266497e66233');
    expect(authSetupDigestOf(stored(reordered(SETUP)), null)).toBe('sha256:b6ea842f23884cd44faf0c67cdd69e9083c46e729395be2c040228e1250457c7');
  });

  it('keeps the worker authentication digest', () => {
    expect(workerAuthenticationDigestOf(SETUP, [ORIGIN], { jobKind: 'AUDIT', automatedLogin: null })).toBe('9c3cbd766a39d9d9e03f6c3fd5826e7117d0153fbc34d1e596662545c5cc8e88');
    expect(workerAuthenticationDigestOf(reordered(SETUP), [ORIGIN, 'http://localhost:4173'], {
      jobKind: 'LOGIN_CHECK',
      automatedLogin: { credentialRevision: CREDENTIAL_REVISION, credentialRoot: 'C:\\example-root' },
    })).toBe('798b85da7070fd656bc741ab5d17622855ed5edbef80d9ff7ffc7fc67112ab85');
  });
});
