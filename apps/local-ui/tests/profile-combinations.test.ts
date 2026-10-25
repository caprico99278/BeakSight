/**
 * T43a fix round 1（Task 43 の設計書 4.1。設計者の判断 1）: プロファイルの作成の欄が使う、組み合わせの表の初めの値を固定する（ブラウザとビルドを
 * 使わない純粋な部品の確かめ）。
 * - 初めの値（`defaultEnvironmentAndAuthOf`）は、組み合わせの表（`src/control/profile-combinations.ts`）の先頭の値で、プロファイルの検証
 *   （`validateSiteProfile`）が組み合わせの誤りを返さない。
 * - 表は 1 か所だけ（`profile-policy.ts` は、このファイルの表を使う。写しを持たない）。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AUDIT_MODES, type SiteProfile } from '../../../src/control/contracts.js';
import {
  AUTH_STRATEGIES_BY_MODE,
  ENVIRONMENTS_BY_MODE,
  TEST_ORIGIN_MODES,
  defaultEnvironmentAndAuthOf,
  environmentAcceptsEvidence,
} from '../../../src/control/profile-combinations.js';
import { validateSiteProfile } from '../../../src/control/profile-policy.js';
import { REPO_ROOT } from './helpers/local-server.ts';

/** 検証の文脈（テスト環境の Origin を受けるターゲット設定の要点だけ）。 */
const CONTEXT = { targetConfig: { site: { allowedOrigins: ['http://127.0.0.1:9'] } } } as unknown as Parameters<typeof validateSiteProfile>[1];

describe('T43a fix round 1: the first values of the combination table', () => {
  it('takes the first environment and the first auth of the table for each mode', () => {
    expect(defaultEnvironmentAndAuthOf('PUBLIC_PASSIVE')).toEqual({ environment: 'PUBLIC', auth: 'NONE' });
    expect(defaultEnvironmentAndAuthOf('TEST_AUTH_PASSIVE')).toEqual({ environment: 'TEST', auth: 'MANUAL_SESSION' });
    expect(defaultEnvironmentAndAuthOf('TEST_APPROVED_WRITE')).toEqual({ environment: 'TEST', auth: 'MANUAL_SESSION' });
    for (const mode of AUDIT_MODES) {
      const { environment, auth } = defaultEnvironmentAndAuthOf(mode);
      expect(ENVIRONMENTS_BY_MODE[mode][0]).toBe(environment);
      expect(AUTH_STRATEGIES_BY_MODE[mode][0]).toBe(auth);
    }
  });

  it('gives values that the profile validation accepts as a combination', () => {
    for (const mode of AUDIT_MODES) {
      const testFields = TEST_ORIGIN_MODES.includes(mode);
      const profile: SiteProfile = {
        schemaVersion: 'beaksight-profile/1',
        profileId: 't43a-combination',
        revision: 1,
        targetConfigPath: 'config/targets/example.json',
        ...defaultEnvironmentAndAuthOf(mode),
        mode,
        approvedTestOrigins: testFields ? ['http://127.0.0.1:9'] : [],
        environmentEvidenceRef: testFields ? 't43a-evidence' : null,
      };
      const result = validateSiteProfile(profile, CONTEXT);
      expect(result.ok ? [] : result.errors.map(({ code }) => code), mode).toEqual([]);
    }
  });

  it('accepts the evidence reference only in the test environment', () => {
    expect(environmentAcceptsEvidence('TEST')).toBe(true);
    expect(environmentAcceptsEvidence('PUBLIC')).toBe(false);
  });

  it('keeps the tables in one place (profile-policy.ts does not copy them)', () => {
    const policy = readFileSync(`${REPO_ROOT}/src/control/profile-policy.ts`, 'utf8');
    expect(policy).toContain("from './profile-combinations.js'");
    expect(policy).not.toMatch(/const (?:ENVIRONMENTS_BY_MODE|AUTH_STRATEGIES_BY_MODE|TEST_ORIGIN_MODES)\b/u);
  });
});
