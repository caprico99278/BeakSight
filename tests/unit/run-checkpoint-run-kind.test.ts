// T25g-2（独立レビュー T25R の Important I1）: 認証つきの Run と公開監査の Run は、互いに再開しない。保存（checkpoint）に、Run の種類
// （認証つきかどうかと、認証の設定を区別する値。秘密を含まない）を記録し、再開する Run を選ぶ比べ（`selectRunToResume`）で比べる。違えば
// `CONFIG_DIFFERS`（違う項目は `authentication`）。項目のない古い保存は、公開監査の Run とみなす。
import { describe, expect, it } from 'vitest';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/control/auth/auth-setup-contracts.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import { createRunId } from '../../src/core/ids.js';
import { runCheckpointAuthenticationOf, type RunAuthentication } from '../../src/orchestration/authenticated-run.js';
import {
  createRunCheckpoint,
  RUN_KIND_DIFFERENCE_PATH,
  selectRunToResume,
  type RunCheckpoint,
  type RunCheckpointAuthentication,
  type RunResumeCandidate,
} from '../../src/orchestration/run-checkpoint.js';
import { sampleRunCheckpoint } from '../helpers/run-checkpoint-samples.js';

/** 秘密の目印（状態の値。区別の値に現れてはならない）。 */
const SECRET_MARKER = 'secret-marker-4b2e91';
const ORIGIN = 'http://127.0.0.1:4173';

const settings = (overrides: Partial<Pick<RunAuthentication, 'approvedTestOrigins' | 'sessionLostPathPrefix'>> & {
  readonly excludedPathPrefixes?: readonly string[];
} = {}): Pick<RunAuthentication, 'approvedTestOrigins' | 'auditExclusions' | 'sessionLostPathPrefix'> & Pick<RunAuthentication, 'initialState'> => ({
  initialState: {
    cookies: [{ name: 'sid', value: SECRET_MARKER, domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }],
    origins: [{ origin: ORIGIN, localStorage: [{ name: 'tok', value: SECRET_MARKER }] }],
  },
  approvedTestOrigins: overrides.approvedTestOrigins ?? [ORIGIN],
  auditExclusions: {
    excludedPathPrefixes: overrides.excludedPathPrefixes ?? ['/admin/logout'],
    auditPathPrefixes: ['/admin'],
    dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS,
  },
  sessionLostPathPrefix: overrides.sessionLostPathPrefix ?? '/login',
});

/** 保存に Run の種類を加えた（`authentication` が `null` なら、項目のない古い形の）保存。 */
const withKind = (checkpoint: RunCheckpoint, authentication: RunCheckpointAuthentication | null): RunCheckpoint => {
  const { authentication: _omitted, ...rest } = checkpoint;
  return createRunCheckpoint({ ...rest, ...(authentication === null ? {} : { authentication }) });
};

const candidateOf = (checkpoint: RunCheckpoint): RunResumeCandidate => {
  const runId = createRunId(1);
  return { runId, runDirectory: `output/${runId}`, checkpoint };
};

describe('T25g-2: the kind of the Run in the checkpoint', () => {
  it('derives a value without secrets that tells the authentication settings apart', () => {
    const base = runCheckpointAuthenticationOf(settings());
    expect(base.settingsDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(JSON.stringify(base)).not.toContain(SECRET_MARKER);
    // 同じ設定なら同じ値。状態（秘密）が違っても同じ値（状態は Run の種類ではない）。
    const withOtherState: Pick<RunAuthentication, 'approvedTestOrigins' | 'auditExclusions' | 'sessionLostPathPrefix' | 'initialState'> = {
      ...settings(),
      initialState: { cookies: [], origins: [] },
    };
    expect(runCheckpointAuthenticationOf(withOtherState)).toEqual(base);
    // 許可 Origin、除外、セッションの切れの path のどれかが違えば、違う値。
    expect(runCheckpointAuthenticationOf(settings({ approvedTestOrigins: [ORIGIN, 'http://127.0.0.1:4174'] }))).not.toEqual(base);
    expect(runCheckpointAuthenticationOf(settings({ excludedPathPrefixes: ['/admin/logout', '/admin/purge'] }))).not.toEqual(base);
    expect(runCheckpointAuthenticationOf(settings({ sessionLostPathPrefix: '/signin' }))).not.toEqual(base);
  });

  it('writes the kind only for an authenticated Run, and the checkpoint schema accepts both forms', async () => {
    const kind = runCheckpointAuthenticationOf(settings());
    const authenticated = withKind(sampleRunCheckpoint(), kind);
    const legacy = withKind(sampleRunCheckpoint(), null);
    expect(authenticated.authentication).toEqual(kind);
    expect(Object.hasOwn(legacy, 'authentication')).toBe(false);
    await expect(validateArtifact('checkpoint', JSON.parse(JSON.stringify(authenticated)) as unknown)).resolves.toEqual({ ok: true });
    await expect(validateArtifact('checkpoint', JSON.parse(JSON.stringify(legacy)) as unknown)).resolves.toEqual({ ok: true });
    await expect(validateArtifact('checkpoint', JSON.parse(JSON.stringify({ ...legacy, authentication: { settingsDigest: 'x' } })) as unknown))
      .resolves.toMatchObject({ ok: false });
  });

  it.each([
    ['an authenticated Run is not resumed by a public Run', 'AUTH', null],
    ['a public Run (an old checkpoint without the kind) is not resumed by an authenticated Run', null, 'AUTH'],
    ['an authenticated Run is not resumed with different authentication settings', 'AUTH', 'OTHER_AUTH'],
  ] as const)('%s (CONFIG_DIFFERS with the kind)', (_case, saved, current) => {
    const kinds = {
      AUTH: runCheckpointAuthenticationOf(settings()),
      OTHER_AUTH: runCheckpointAuthenticationOf(settings({ sessionLostPathPrefix: '/signin' })),
    };
    const checkpoint = withKind(sampleRunCheckpoint(), saved === null ? null : kinds[saved]);
    const selection = selectRunToResume([candidateOf(checkpoint)], checkpoint.effectiveConfig, current === null ? null : kinds[current]);
    expect(selection).toMatchObject({ kind: 'CONFIG_DIFFERS', differences: [RUN_KIND_DIFFERENCE_PATH] });
  });

  it('resumes the same kind as before (public with an old checkpoint, and the same authentication settings)', () => {
    const kind = runCheckpointAuthenticationOf(settings());
    const legacy = withKind(sampleRunCheckpoint(), null);
    expect(selectRunToResume([candidateOf(legacy)], legacy.effectiveConfig)).toMatchObject({ kind: 'RESUME' });
    expect(selectRunToResume([candidateOf(legacy)], legacy.effectiveConfig, null)).toMatchObject({ kind: 'RESUME' });
    const authenticated = withKind(sampleRunCheckpoint(), kind);
    expect(selectRunToResume([candidateOf(authenticated)], authenticated.effectiveConfig, runCheckpointAuthenticationOf(settings())))
      .toMatchObject({ kind: 'RESUME' });
  });

  it('lists the kind after the differences of the effective configuration', () => {
    const checkpoint = withKind(sampleRunCheckpoint(), runCheckpointAuthenticationOf(settings()));
    const current = { ...checkpoint.effectiveConfig, crawl: { ...checkpoint.effectiveConfig.crawl, maxPages: 7 } };
    expect(selectRunToResume([candidateOf(checkpoint)], current, null))
      .toMatchObject({ kind: 'CONFIG_DIFFERS', differences: ['crawl.maxPages', RUN_KIND_DIFFERENCE_PATH] });
  });
});
