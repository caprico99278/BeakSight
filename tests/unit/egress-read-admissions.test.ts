// 中継の読み取りの写し（`src/browser/context-factory.ts` の `EgressReadAdmissions`）。要求を出し続ける画面（`?t=乱数` の読み取り）でメモリが増え続けた件:
// 写しを Context の寿命まで持っていた（N21 で上限を外した後）。照らし合わせた写しは捨て、中継が照らさない写し（https。CONNECT の中は中継から見えない）は持たない。
// 件数で打ち切る形には戻さない。SD-2 から、写しは書き込みの段の押した後の読み取りの照らしだけに使う（BN-0 の例外の形の 2 段目は外した）。
import { describe, expect, it } from 'vitest';
import { EgressReadAdmissions, passiveEgressRequestPolicy } from '../../src/browser/context-factory.js';

const ORIGIN = 'http://127.0.0.1:43210';
const HTTPS_ORIGIN = 'https://example.test';
/** 監査の段の除外の読まないパス（SD-2: main frame の文書の読み込みだけに当たる）。 */
const EXCLUSIONS = Object.freeze({ excludedPathPrefixes: Object.freeze(['/private']), auditPathPrefixes: Object.freeze([]), dangerousTerms: Object.freeze([]) });

const policyWith = (admissions: EgressReadAdmissions) =>
  passiveEgressRequestPolicy(new Set([ORIGIN, HTTPS_ORIGIN]), {}, EXCLUSIONS, undefined, 'PRIMARY', undefined, admissions);

describe('EgressReadAdmissions: the copies of the reads the Guard admitted', () => {
  it('drops each copy once the egress proxy has matched it, for every random query', () => {
    const admissions = new EgressReadAdmissions();
    const policy = policyWith(admissions);
    for (let index = 0; index < 1_000; index += 1) {
      const url = `${ORIGIN}/data?t=${index}`;
      admissions.admit('GET', url);
      admissions.admit('GET', url);
      expect(policy('GET', url)).toBe(true);
    }

    expect(admissions.size).toBe(0);
  });

  it('does not keep the copies of https reads, which the proxy never matches (it sees only the CONNECT)', () => {
    const admissions = new EgressReadAdmissions();
    for (let index = 0; index < 100; index += 1) admissions.admit('GET', `${HTTPS_ORIGIN}/data?t=${index}`);

    expect(admissions.size).toBe(0);
  });

  // SD-2（設計書 `2026-11-16-beaksight-action-based-delete-guard-design.md` 2.4）: 監査の段の除外は main frame の文書の読み込みだけに当てるので、中継は、Guard と
  // 同じ方針で、写しがなくても読まないパスへのページの読み取りを通す（前の BN-0 の例外の形の 2 段目は外した）。写しは、照らし合わせたら捨てる。
  it('passes a page read to an excluded path without a copy, as the Guard does, and still drops a copy once matched', () => {
    const admissions = new EgressReadAdmissions();
    const policy = policyWith(admissions);
    const url = `${ORIGIN}/private/item.json`;

    expect(policy('GET', url)).toBe(true);
    admissions.admit('GET', url);
    expect(policy('GET', url)).toBe(true);
    expect(admissions.size).toBe(0);
  });
});
