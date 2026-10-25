// AS-b（設計書 `doc/design/2026-10-19-beaksight-audit-send-policy-design.md` 2.1、5 章の AS-b の Blocker の行）: 監査の段の送信の扱いの実効の設定。
// - 値の一覧は `src/core/audit-send-policy.ts` の 1 か所（`READ_ONLY` と `PASS_EXCEPT_DELETE`）。既定は `READ_ONLY`。Guard の口の値は同じ定数を指す。
// - 設定ファイルの `audit.sendPolicy` は一覧の値だけを受ける。持たない設定（古い保存・`run.json` と、項目のない設定の値）は `READ_ONLY` と読む。
// - 危険な語の一覧（`DEFAULT_EXCLUDED_URL_WORDS`）の定義は `src/core/`（値は変えない。LG-4F で認証の設定の契約からの公開し直しを捨てた）。
// - factory へ渡す口の組み立て（`auditSendOptionsOf`）は `src/orchestration/` の 1 か所。`PASS_EXCEPT_DELETE` のときだけ口を作る。
// - 再開の比べは、読み替えずに行う（LG-4: 項目を持たない古い途中の Run は `CONFIG_DIFFERS`）。
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import { loadConfig } from '../../src/config/load-config.js';
import { validateConfig } from '../../src/config/validate-config.js';
import {
  AUDIT_SEND_PASS_EXCEPT_DELETE,
  AUDIT_SEND_POLICIES,
  AUDIT_SEND_READ_ONLY,
  DEFAULT_AUDIT_SEND_POLICY,
  auditSendPolicyOf,
  isAuditSendPolicyName,
} from '../../src/core/audit-send-policy.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import { createRunId } from '../../src/core/ids.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import { auditSendOptionsOf } from '../../src/orchestration/audit-send-options.js';
import {
  RESUME_CONFIG_IGNORED_PATHS,
  createRunCheckpoint,
  effectiveConfigDifferences,
  selectRunToResume,
  type RunCheckpoint,
} from '../../src/orchestration/run-checkpoint.js';
import { AUDIT_SEND_PASS_EXCEPT_DELETE as GUARD_PASS_EXCEPT_DELETE, isGuardAuditSend } from '../../src/safety/passive-request-guard.js';
import { sampleRunCheckpoint } from '../helpers/run-checkpoint-samples.js';
import { createTestConfig } from '../helpers/test-config.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

const SERVICE_ORIGIN = 'http://127.0.0.1:5173';

/** `audit.sendPolicy` を持たない（AS-b の前の）実効の設定。 */
const withoutSendPolicy = <T extends { readonly audit: object }>(config: T): T => {
  const { sendPolicy: _omitted, ...audit } = config.audit as { readonly sendPolicy?: unknown };
  return { ...config, audit } as T;
};

/** 保存の実効の設定を置き換えた保存。 */
const withEffectiveConfig = (checkpoint: RunCheckpoint, effectiveConfig: RunCheckpoint['effectiveConfig']): RunCheckpoint =>
  createRunCheckpoint({ ...checkpoint, effectiveConfig });

const candidateOf = (checkpoint: RunCheckpoint) => {
  const runId = createRunId(1);
  return { runId, runDirectory: `output/${runId}`, checkpoint };
};

describe('AS-b: the values of the audit send policy', () => {
  it('lists READ_ONLY and PASS_EXCEPT_DELETE in one place, defaults to READ_ONLY, and the Guard uses the same value', () => {
    expect(AUDIT_SEND_POLICIES).toEqual(['READ_ONLY', 'PASS_EXCEPT_DELETE']);
    expect(AUDIT_SEND_READ_ONLY).toBe('READ_ONLY');
    expect(AUDIT_SEND_PASS_EXCEPT_DELETE).toBe('PASS_EXCEPT_DELETE');
    expect(DEFAULT_AUDIT_SEND_POLICY).toBe(AUDIT_SEND_READ_ONLY);
    expect(GUARD_PASS_EXCEPT_DELETE).toBe(AUDIT_SEND_PASS_EXCEPT_DELETE);
    expect(Object.isFrozen(AUDIT_SEND_POLICIES)).toBe(true);
    expect(AUDIT_SEND_POLICIES.every(isAuditSendPolicyName)).toBe(true);
    for (const value of ['read_only', 'PASS_ALL', '', null, undefined, 1]) {
      expect(isAuditSendPolicyName(value), String(value)).toBe(false);
    }
  });

  it('reads a configuration without the item as READ_ONLY', () => {
    const config = createTestConfig('http://127.0.0.1:4173');
    expect(auditSendPolicyOf(withoutSendPolicy(config))).toBe('READ_ONLY');
    expect(auditSendPolicyOf({ ...config, audit: { ...config.audit, sendPolicy: 'PASS_EXCEPT_DELETE' } })).toBe('PASS_EXCEPT_DELETE');
    expect(auditSendPolicyOf({ ...config, audit: { ...config.audit, sendPolicy: 'READ_ONLY' } })).toBe('READ_ONLY');
  });
});

describe('AS-b: audit.sendPolicy in the configuration file', () => {
  it('defaults to READ_ONLY', () => {
    expect(DEFAULT_CONFIG.audit.sendPolicy).toBe('READ_ONLY');
  });

  it('accepts the listed values and rejects any other value', () => {
    const config = createTestConfig('http://127.0.0.1:4173');
    for (const sendPolicy of AUDIT_SEND_POLICIES) {
      expect(validateConfig({ ...config, audit: { ...config.audit, sendPolicy } }).ok, sendPolicy).toBe(true);
    }
    for (const sendPolicy of ['PASS_ALL', 'read_only', '', true, null, 0]) {
      const result = validateConfig({ ...config, audit: { ...config.audit, sendPolicy } });
      expect(result.ok, String(sendPolicy)).toBe(false);
      expect(result.ok ? [] : result.errors).toContain('audit.sendPolicy must be one of READ_ONLY, PASS_EXCEPT_DELETE');
    }
  });

  it('reads the value of the file, READ_ONLY when the file does not have it, and applies an override', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'beaksight-audit-send-config-'));
    temporaryDirectories.push(directory);
    const write = async (name: string, audit: Record<string, unknown> | null): Promise<string> => {
      const path = join(directory, `${name}.json`);
      await writeFile(path, JSON.stringify({
        target: { id: name },
        site: { startUrl: 'http://127.0.0.1:4173/', allowedOrigins: ['http://127.0.0.1:4173'] },
        ...(audit === null ? {} : { audit }),
      }), 'utf8');
      return path;
    };
    expect((await loadConfig(await write('plain', null))).audit.sendPolicy).toBe('READ_ONLY');
    expect((await loadConfig(await write('passing', { sendPolicy: 'PASS_EXCEPT_DELETE' }))).audit.sendPolicy).toBe('PASS_EXCEPT_DELETE');
    const overridden = await loadConfig(await write('overridden', null), { audit: { sendPolicy: 'PASS_EXCEPT_DELETE' } });
    expect(overridden.audit).toEqual({ ...DEFAULT_CONFIG.audit, sendPolicy: 'PASS_EXCEPT_DELETE' });
    await expect(loadConfig(await write('broken', { sendPolicy: 'PASS_ALL' }))).rejects.toMatchObject({ kind: 'CONFIG_INVALID' });
  });

  it('keeps run.json and the checkpoint without the item valid, and rejects another value', async () => {
    const checkpoint = sampleRunCheckpoint();
    const old = withEffectiveConfig(checkpoint, withoutSendPolicy(checkpoint.effectiveConfig));
    expect((await validateArtifact('checkpoint', old)).ok).toBe(true);
    for (const sendPolicy of AUDIT_SEND_POLICIES) {
      const current = withEffectiveConfig(checkpoint, { ...checkpoint.effectiveConfig, audit: { ...checkpoint.effectiveConfig.audit, sendPolicy } });
      expect((await validateArtifact('checkpoint', current)).ok, sendPolicy).toBe(true);
    }
    const broken = { ...checkpoint, effectiveConfig: { ...checkpoint.effectiveConfig, audit: { ...checkpoint.effectiveConfig.audit, sendPolicy: 'PASS_ALL' } } };
    expect((await validateArtifact('checkpoint', broken)).ok).toBe(false);
  });
});

describe('AS-b: the dangerous words moved to src/core/', () => {
  // LG-4F: 認証の設定の契約からの公開し直しは捨てた（呼び出し側は `src/core/` を直接読む）。
  it('keeps the same list (same values), frozen', () => {
    expect(DEFAULT_EXCLUDED_URL_WORDS).toEqual(['logout', 'signout', 'sign-out', 'log-out', 'delete', 'remove', 'destroy', 'cancel']);
    expect(Object.isFrozen(DEFAULT_EXCLUDED_URL_WORDS)).toBe(true);
  });
});

describe('AS-b: auditSendOptionsOf (the one place that builds the factory option)', () => {
  it('gives no option for READ_ONLY and for a configuration without the item', () => {
    const config = createTestConfig('http://127.0.0.1:4173');
    expect(auditSendOptionsOf({ ...config, audit: { ...config.audit, sendPolicy: 'READ_ONLY' } }, [SERVICE_ORIGIN])).toEqual({});
    expect(auditSendOptionsOf(withoutSendPolicy(config), [SERVICE_ORIGIN])).toEqual({});
  });

  it('gives the Guard option with the approved service origins and the dangerous words for PASS_EXCEPT_DELETE', () => {
    const config = createTestConfig('http://127.0.0.1:4173');
    const passing = { ...config, audit: { ...config.audit, sendPolicy: 'PASS_EXCEPT_DELETE' as const } };
    const authenticated = auditSendOptionsOf(passing, [SERVICE_ORIGIN]);
    expect(authenticated).toEqual({
      // AS-c fix round 1（M-1）: 送信の扱いの口にだけ `sign_out`・`log_out` を足す。
      auditSend: {
        policy: 'PASS_EXCEPT_DELETE',
        approvedServiceOrigins: [SERVICE_ORIGIN],
        dangerousTerms: [...DEFAULT_EXCLUDED_URL_WORDS, 'sign_out', 'log_out'],
      },
    });
    expect(isGuardAuditSend(authenticated.auditSend)).toBe(true);
    const publicAudit = auditSendOptionsOf(passing, []);
    expect(publicAudit.auditSend?.approvedServiceOrigins).toEqual([]);
    expect(isGuardAuditSend(publicAudit.auditSend)).toBe(true);
  });
});

// LG-4（テストの組の設計書 3.7.3、3.7.5）: 項目を持たない前の保存（AS-b の前）は、読み替えずに「設定が違う」とする（黙って前の方針で再開しない）。
describe('AS-b: the resume comparison compares audit.sendPolicy, and does not read a missing item as READ_ONLY (LG-4)', () => {
  it('compares audit.sendPolicy (it is not an ignored path)', () => {
    expect(RESUME_CONFIG_IGNORED_PATHS).not.toContain('audit.sendPolicy');
  });

  it('does not resume an old Run without the item, with either policy (CONFIG_DIFFERS)', () => {
    const checkpoint = sampleRunCheckpoint();
    const old = withEffectiveConfig(checkpoint, withoutSendPolicy(checkpoint.effectiveConfig));
    const readOnly = { ...checkpoint.effectiveConfig, audit: { ...checkpoint.effectiveConfig.audit, sendPolicy: 'READ_ONLY' as const } };
    const passing = { ...checkpoint.effectiveConfig, audit: { ...checkpoint.effectiveConfig.audit, sendPolicy: 'PASS_EXCEPT_DELETE' as const } };
    expect(effectiveConfigDifferences(old.effectiveConfig, readOnly)).toEqual(['audit.sendPolicy']);
    expect(effectiveConfigDifferences(old.effectiveConfig, passing)).toEqual(['audit.sendPolicy']);
    expect(selectRunToResume([candidateOf(old)], readOnly)).toMatchObject({ kind: 'CONFIG_DIFFERS', differences: ['audit.sendPolicy'] });
    expect(selectRunToResume([candidateOf(old)], passing)).toMatchObject({ kind: 'CONFIG_DIFFERS', differences: ['audit.sendPolicy'] });
  });

  it('does not resume a Run saved with another policy', () => {
    const checkpoint = sampleRunCheckpoint();
    const readOnly = { ...checkpoint.effectiveConfig, audit: { ...checkpoint.effectiveConfig.audit, sendPolicy: 'READ_ONLY' as const } };
    const passing = { ...checkpoint.effectiveConfig, audit: { ...checkpoint.effectiveConfig.audit, sendPolicy: 'PASS_EXCEPT_DELETE' as const } };
    const saved = withEffectiveConfig(checkpoint, passing);
    expect(selectRunToResume([candidateOf(saved)], passing)).toMatchObject({ kind: 'RESUME' });
    expect(selectRunToResume([candidateOf(saved)], readOnly)).toMatchObject({ kind: 'CONFIG_DIFFERS', differences: ['audit.sendPolicy'] });
  });
});
