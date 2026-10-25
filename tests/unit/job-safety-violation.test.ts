// DEF-144（指示書 `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/DEF-144-brief.md`）: 発見と READ の確かめのジョブで違反が起きたときに残す中身。
// - Safety Ledger: 違反が 1 つの要求に結びつくときは、その method と、URL から取り出した Origin と path を残す（query・fragment・値は残さない）。`run.json` の
//   `safety.invariantViolations` の写し（`summarizeRunSafety`）にも同じ形で載る。
// - 違反の中身（`jobSafetyViolationOf`）: `run.json` と同じ部品（`summarizePageSafety`）の形に、段・画面の path・押した候補を足す。文は 1 行にし、URL の値を伏せる。
import { describe, expect, it } from 'vitest';
import { validateArtifact } from '../../src/core/schema-validator.js';
import { summarizeRunSafety } from '../../src/orchestration/run-aggregation.js';
import { pointsToExternalScheme } from '../../src/interaction/submission-probe.js';
import {
  JOB_SAFETY_VIOLATION_STAGES,
  MAX_JOB_SAFETY_VIOLATION_ENTRIES,
  probeViolationContinuationOf,
  jobSafetyViolationOf,
} from '../../src/safety/job-safety-violation.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';

/** 値の目印（どこにも出てはならない）。 */
const MARKER = 'def144secretmarker';
const ORIGIN = 'https://example.test';

describe('DEF-144: the request of an invariant violation in the Safety Ledger', () => {
  it('keeps the method, the Origin and the path of the request, without the query, the fragment or a value', () => {
    const ledger = new SafetyLedger();
    ledger.recordInvariantViolation({
      code: 'PASSIVE_GUARD_PAGE_NOT_READY',
      message: 'Navigation started before explicit page readiness',
      request: { method: 'post', url: `${ORIGIN}/admin/staff/edit?token=${MARKER}#${MARKER}` },
    });
    ledger.recordInvariantViolation({ code: 'GUARD_TASK_LIMIT_REACHED', message: 'requestfailed callback' });
    ledger.recordInvariantViolation({ code: 'CDP_REQUEST_PHASE_INVALID', message: 'x', request: { method: 'GET', url: 'blob:not-an-http-origin' } });
    const { invariantViolations } = ledger.snapshot();
    expect(invariantViolations).toEqual([
      { code: 'PASSIVE_GUARD_PAGE_NOT_READY', message: 'Navigation started before explicit page readiness', request: { method: 'POST', origin: ORIGIN, path: '/admin/staff/edit' } },
      { code: 'GUARD_TASK_LIMIT_REACHED', message: 'requestfailed callback' },
      { code: 'CDP_REQUEST_PHASE_INVALID', message: 'x', request: { method: 'GET', origin: null, path: '' } },
    ]);
    expect(JSON.stringify(invariantViolations).includes(MARKER)).toBe(false);
  });

  it('copies the request to the safety summary of run.json in the same shape', async () => {
    const ledger = new SafetyLedger();
    ledger.recordInvariantViolation({ code: 'HTTP_ROUTE_PHASE_INVALID', message: 'HTTP route observed during INSTALLING', request: { method: 'GET', url: `${ORIGIN}/a?q=1` } });
    const safety = summarizeRunSafety({ guardEnabled: true, snapshots: [ledger.snapshot()], auditSendPolicy: 'READ_ONLY' });
    expect(safety.invariantViolations).toEqual([
      { code: 'HTTP_ROUTE_PHASE_INVALID', message: 'HTTP route observed during INSTALLING', request: { method: 'GET', origin: ORIGIN, path: '/a' } },
    ]);
  });
});

describe('DEF-144: the safety violation of a discovery or READ check job (jobSafetyViolationOf)', () => {
  // 候補の識別の digest の形（`schemas/control/candidate.schema.json` の `$defs/digest`）。
  const press = { submitterWords: ['保存'], identityDigest: `sha256:${'a'.repeat(64)}` } as const;

  it('uses the shape of the run.json safety summary, adds the stage, the page and the pressed candidate, and keeps no value', () => {
    const ledger = new SafetyLedger();
    ledger.recordInvariantViolation({
      code: 'GUARDED_CONTEXT_CLOSE_FAILED',
      message: `close failed\nat ${ORIGIN}/admin/staff?token=${MARKER} and https://other.test/x?q=${MARKER}`,
      request: { method: 'GET', url: `${ORIGIN}/admin/staff?token=${MARKER}` },
    });
    const violation = jobSafetyViolationOf({
      url: `${ORIGIN}/admin/staff?page=${MARKER}`,
      snapshot: ledger.snapshot(),
      stage: 'SUBMISSION_PROBE',
      press,
    });
    expect(violation).toMatchObject({
      // 画面は path だけ（query・値は持たない）。
      pagePath: '/admin/staff',
      stage: 'SUBMISSION_PROBE',
      press,
      invariantViolationCount: 1,
      recordTruncated: false,
      invariantViolations: [{ code: 'GUARDED_CONTEXT_CLOSE_FAILED', request: { method: 'GET', origin: ORIGIN, path: '/admin/staff' } }],
    });
    const text = JSON.stringify(violation);
    expect(text.includes(MARKER)).toBe(false);
    expect(violation.invariantViolations[0]?.message.includes('\n')).toBe(false);
    expect(JOB_SAFETY_VIOLATION_STAGES).toEqual(['CONTEXT_OPEN', 'PAGE_LOAD', 'SUBMISSION_PROBE', 'CONTEXT_CLOSE']);
  });

  it('lists at most the named number of violations and keeps the total count', () => {
    const ledger = new SafetyLedger();
    for (let index = 0; index < MAX_JOB_SAFETY_VIOLATION_ENTRIES + 3; index += 1) {
      ledger.recordInvariantViolation({ code: `CODE_${String(index)}`, message: 'm' });
    }
    const violation = jobSafetyViolationOf({ url: `${ORIGIN}/a`, snapshot: ledger.snapshot(), stage: 'PAGE_LOAD', press: null });
    expect(violation.invariantViolations).toHaveLength(MAX_JOB_SAFETY_VIOLATION_ENTRIES);
    expect(violation.invariantViolationCount).toBe(MAX_JOB_SAFETY_VIOLATION_ENTRIES + 3);
  });

  // DEF-144 の後半（設計書 `2026-10-20-beaksight-probe-external-scheme-design.md` 2.2）: 発見を続けてよい違反は、probe の段の、外部スキームへの移動
  // （と、あわせて記録される frame の判定の失敗）だけ。
  // DEF-145（設計書 `2026-10-21-beaksight-probe-navigation-and-dialog-design.md` 2.1）: 押下で始まった読み取り（GET・HEAD）の main frame の移動の配送の失敗
  // （`HTTP_MAIN_FRAME_DELIVERY_FAILED`）も続ける。method が分からないものと、GET・HEAD でないものは止める。
  it('continues the discovery only for the external scheme and the canceled read navigation in the submission probe', () => {
    type Entry = string | { readonly code: string; readonly method: string };
    const violationOf = (entries: readonly Entry[], stage: 'SUBMISSION_PROBE' | 'PAGE_LOAD' = 'SUBMISSION_PROBE') => {
      const ledger = new SafetyLedger();
      for (const entry of entries) {
        ledger.recordInvariantViolation(typeof entry === 'string'
          ? { code: entry, message: 'm' }
          : { code: entry.code, message: 'net::ERR_ABORTED', request: { method: entry.method, url: `${ORIGIN}/admin/edit?token=${MARKER}` } });
      }
      return jobSafetyViolationOf({ url: `${ORIGIN}/a`, snapshot: ledger.snapshot(), stage, press: null });
    };
    const continuationOf = (entries: readonly Entry[], stage?: 'SUBMISSION_PROBE' | 'PAGE_LOAD') => probeViolationContinuationOf(violationOf(entries, stage));
    const DELIVERY = 'HTTP_MAIN_FRAME_DELIVERY_FAILED';
    expect(continuationOf(['EXTERNAL_SCHEME_NAVIGATION_ATTEMPTED'])).toBe('EXTERNAL_SCHEME');
    expect(continuationOf(['EXTERNAL_SCHEME_NAVIGATION_ATTEMPTED', 'FRAME_CLASSIFICATION_FAILED'])).toBe('EXTERNAL_SCHEME');
    expect(continuationOf(['FRAME_CLASSIFICATION_FAILED'])).toBeNull();
    expect(continuationOf(['EXTERNAL_SCHEME_NAVIGATION_ATTEMPTED', 'SHARED_WORKER_OBSERVED'])).toBeNull();
    expect(continuationOf(['SHARED_WORKER_OBSERVED'])).toBeNull();
    expect(continuationOf(['EXTERNAL_SCHEME_NAVIGATION_ATTEMPTED'], 'PAGE_LOAD')).toBeNull();
    // 一覧に載せきれなかった（数と一覧が違う）ときは続けない。
    expect(continuationOf(Array.from({ length: 17 }, () => 'EXTERNAL_SCHEME_NAVIGATION_ATTEMPTED'))).toBeNull();
    // DEF-145: 読み取りの main frame の移動の配送の失敗。
    expect(continuationOf([{ code: DELIVERY, method: 'GET' }])).toBe('READ_NAVIGATION_CANCELED');
    expect(continuationOf([{ code: DELIVERY, method: 'head' }])).toBe('READ_NAVIGATION_CANCELED');
    expect(continuationOf([{ code: DELIVERY, method: 'POST' }])).toBeNull();
    expect(continuationOf([{ code: DELIVERY, method: 'GET' }, { code: DELIVERY, method: 'POST' }])).toBeNull();
    expect(continuationOf([DELIVERY])).toBeNull();
    expect(continuationOf([{ code: DELIVERY, method: 'GET' }], 'PAGE_LOAD')).toBeNull();
    expect(continuationOf([{ code: DELIVERY, method: 'GET' }, 'SHARED_WORKER_OBSERVED'])).toBeNull();
    expect(JSON.stringify(violationOf([{ code: DELIVERY, method: 'GET' }])).includes(MARKER)).toBe(false);
  });

  // DEF-144 の後半（設計書 2.1）: 押す前の見分け（送信ボタンと祖先の `<a>`・`<area>` の `href`、`formaction`、form の `action`）。Guard の判定
  // （`externalNavigationScheme`）を使い、`javascript:`・相対の URL・http(s)・about・data・blob は今の扱いのまま（押す）。
  it('tells the targets that point to an external scheme before the press', () => {
    const base = `${ORIGIN}/admin/staff`;
    for (const target of ['mailto:staff@example.invalid', 'tel:0000', 'sms:0000', 'ms-teams:/l/chat/0/0', ' MAILTO:x@example.invalid ']) {
      expect(pointsToExternalScheme([target], base), target).toBe(true);
    }
    for (const target of ['javascript:void(0)', '/admin/after', '?page=2', '#top', 'https://other.test/x', 'about:blank', 'data:text/plain,x', '', 'http://[']) {
      expect(pointsToExternalScheme([target], base), target).toBe(false);
    }
    expect(pointsToExternalScheme(['/admin/items', 'mailto:x@example.invalid'], base)).toBe(true);
  });

  it('passes the schemas of discovery.json and read-evidence.json as the optional safetyViolation', async () => {
    const ledger = new SafetyLedger();
    ledger.recordInvariantViolation({ code: 'SHARED_WORKER_OBSERVED', message: 'Shared Worker target observed' });
    // 押した候補つき（probe の段）でも、スキーマに通る（識別の digest は候補と同じ形）。
    const safetyViolation = jobSafetyViolationOf({ url: `${ORIGIN}/admin`, snapshot: ledger.snapshot(), stage: 'SUBMISSION_PROBE', press });
    const common = { jobId: 'job-def144', runId: 'RUN-20261020010101', startedAt: '20261020010101', finishedAt: '20261020010102', runStatus: 'ABORTED_BY_SAFETY' };
    const discovery = await validateArtifact('discovery', {
      schemaVersion: 'discovery-schema/1.1', ...common, endReason: 'SAFETY_VIOLATION', maxPages: 1,
      pages: [{ url: `${ORIGIN}/admin`, state: 'NOT_READ', reason: 'NAVIGATION_FAILED' }], omittedUnreadPages: 0, safetyViolation,
    });
    expect(discovery.ok ? [] : discovery.errors).toEqual([]);
    const readEvidence = await validateArtifact('read-evidence', {
      schemaVersion: 'read-evidence-schema/1.2', ...common, endReason: 'SAFETY_VIOLATION', checks: [], safetyViolation,
    });
    expect(readEvidence.ok ? [] : readEvidence.errors).toEqual([]);
  });
});
