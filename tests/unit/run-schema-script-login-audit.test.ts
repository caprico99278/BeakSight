// T35a（Task 35 の設計書 3.4、3.7）: `run.json` の任意の項目（`run.schema.json` の版は上げない。公開の監査の出力は変えない）。
// - `load.approvedServiceOrigins`: 承認したサービスの Origin への要求（数と 1 分あたりの最大。`load.requests.otherOrigins` の内数）。
// - `authentication`: スクリプトで送るログインの監査の段の数だけ（通した登録の手続きの呼び出し、止めた token の更新、止めたそのほかの読み取りでない
//   要求、サービスの Origin からの 401 の数、上限に届いたか）。URL・値は持たない。
// - 未完了の理由（`INCOMPLETE_REASON_CODES`）と、Guard の止めた理由（`BLOCKED_REQUEST_REASONS`）に `SERVICE_REQUEST_LIMIT_REACHED` を足し、表示の
//   カタログに文言を足す。
// 項目のない `run.json`（公開の監査とフォームの送信のログインの監査）は、今のままスキーマに合う。
import { describe, expect, it } from 'vitest';
import { INCOMPLETE_REASON_CODES, type RunSummary } from '../../src/core/contracts.js';
import { BLOCKED_REQUEST_REASONS } from '../../src/core/evidence-types.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import { BLOCKED_REQUEST_REASON_DESCRIPTIONS, INCOMPLETE_REASON_DESCRIPTIONS } from '../../src/presentation/messages.js';
import { runSummary } from '../helpers/audit-run-fixture.js';

const AUTHENTICATION = Object.freeze({
  registeredReadRequestsAllowed: 4,
  tokenRefreshBlocked: 1,
  otherNonReadBlocked: 2,
  serviceUnauthorizedResponses: 0,
  serviceRequestLimitReached: true,
});
const SERVICE_LOAD = Object.freeze({ count: 12, peakPerMinute: 7 });

const withItems = (base: RunSummary): Record<string, unknown> => ({
  ...base,
  authentication: AUTHENTICATION,
  load: { ...base.load, approvedServiceOrigins: SERVICE_LOAD },
  incompleteReasons: [{ code: 'SERVICE_REQUEST_LIMIT_REACHED', detail: null }],
});

const isValidRun = async (value: unknown): Promise<boolean> => (await validateArtifact('run', value)).ok;

describe('T35a: the optional items of run.json for the script login audit', () => {
  it('keeps a run.json without the items valid (the public audit and the form navigation login audit)', async () => {
    const base = runSummary();
    expect(base).not.toHaveProperty('authentication');
    expect(base.load).not.toHaveProperty('approvedServiceOrigins');
    expect(await isValidRun(base)).toBe(true);
  });

  it('accepts the counts of the audit stage, the service origin load and the new incomplete reason', async () => {
    expect(await isValidRun(withItems(runSummary()))).toBe(true);
  });

  it.each([
    ['a negative count', { authentication: { ...AUTHENTICATION, tokenRefreshBlocked: -1 } }],
    ['a fractional count', { authentication: { ...AUTHENTICATION, otherNonReadBlocked: 1.5 } }],
    ['a missing count', { authentication: { ...AUTHENTICATION, serviceUnauthorizedResponses: undefined } }],
    ['a URL in the counts', { authentication: { ...AUTHENTICATION, url: 'http://127.0.0.1:5173/rest/v1/rpc/list' } }],
    ['a limit flag that is not a boolean', { authentication: { ...AUTHENTICATION, serviceRequestLimitReached: 1 } }],
  ] as const)('rejects the counts with %s', async (_name, change) => {
    expect(await isValidRun(JSON.parse(JSON.stringify({ ...withItems(runSummary()), ...change })) as unknown)).toBe(false);
  });

  // DEF-141: 1 分あたりの上限で待った回数と時間（任意の数。前の版の成果物にはない）。セッションの切れの証拠だけの形では持てない。
  it('accepts the counts of the waits by the per minute limit, and rejects them in another shape', async () => {
    const waits = { serviceRequestPacingWaits: 2, serviceRequestPacingWaitMs: 75_000 };
    expect(await isValidRun({ ...withItems(runSummary()), authentication: { ...AUTHENTICATION, ...waits } })).toBe(true);
    for (const change of [{ serviceRequestPacingWaits: -1 }, { serviceRequestPacingWaitMs: 0.5 }, { serviceRequestPacingWaits: '2' }]) {
      expect(await isValidRun({ ...withItems(runSummary()), authentication: { ...AUTHENTICATION, ...waits, ...change } }), JSON.stringify(change))
        .toBe(false);
    }
  });

  it('rejects a service origin load of another shape', async () => {
    const base = runSummary();
    for (const load of [{ count: 1 }, { count: 1, peakPerMinute: 1, url: 'x' }, { count: -1, peakPerMinute: 0 }]) {
      expect(await isValidRun({ ...base, load: { ...base.load, approvedServiceOrigins: load } }), JSON.stringify(load)).toBe(false);
    }
  });

  it('has the limit reason in the closed lists of the incomplete reasons and the blocked requests, with the texts', () => {
    expect(INCOMPLETE_REASON_CODES).toContain('SERVICE_REQUEST_LIMIT_REACHED');
    // T35R-fix（T35R の C-1）: 幅の走査と Interaction の読み込みで、承認したサービスの Origin へ送らなかった理由を足した。
    // DEF-129: ページが始めた main frame の読み込みの上限の理由を足した。DEF-130-fix: 文書でない要求の数の上限の理由を足した。
    // AS-a: 監査の段の送信の扱いで、1 つの読み込みで通す数の上限の理由を足した。
    expect(BLOCKED_REQUEST_REASONS).toEqual([
      'NON_READ_METHOD', 'SERVICE_REQUEST_LIMIT_REACHED', 'SERVICE_ORIGIN_REVISIT', 'PAGE_NAVIGATION_LIMIT_REACHED', 'PAGE_SUBRESOURCE_LIMIT_REACHED',
      'AUDIT_SEND_OVER_LIMIT',
      // T44R の I-1。
      'PAGE_LEAVE_REQUEST_LIMIT_REACHED',
    ]);
    expect(INCOMPLETE_REASON_DESCRIPTIONS.SERVICE_REQUEST_LIMIT_REACHED.length).toBeGreaterThan(0);
    expect(Object.keys(BLOCKED_REQUEST_REASON_DESCRIPTIONS)).toEqual([...BLOCKED_REQUEST_REASONS]);
  });
});
