// RB-11（再構築の設計書 3 章。plan の 2 章の 10・11・14）: 書き込みの段の、観察から次の一手を決める純粋な判定。ブラウザを使わない（判定の場面は
// ここで確かめ、本物の Chromium の結合は流れの代表だけにする）。
import { describe, expect, it } from 'vitest';
import { inspectAgainStepOf, pressRetryStepOf, refillStepOf } from '../../src/browser/api-write-submitter.js';
import {
  formResultStepOf,
  rowFormCandidateOf,
  rowFormLocationStepOf,
  submissionEndedWithoutResponseOf,
  submissionWindowVerdictOf,
  writeResponseStepOf,
  type FormResultObservation,
} from '../../src/worker/write-create-run.js';

describe('RB-11: the wait for the response of the approved submission', () => {
  it('ends without a response before it looks at the response, then waits until the page is gone', () => {
    expect(writeResponseStepOf({ endedWithoutResponse: true, responseReceived: true, pageGone: false })).toBe('ENDED_WITHOUT_RESPONSE');
    expect(writeResponseStepOf({ endedWithoutResponse: false, responseReceived: true, pageGone: true })).toBe('RESPONDED');
    expect(writeResponseStepOf({ endedWithoutResponse: false, responseReceived: false, pageGone: true })).toBe('NOT_RESPONDED');
    expect(writeResponseStepOf({ endedWithoutResponse: false, responseReceived: false, pageGone: false })).toBe('WAIT');
  });

  it.each([
    ['blocked by the payload check', { submission: 'NOT_SENT', sendOutcome: null }, { payloadBlocked: true, guardClosed: false }, true],
    ['the Guard closed the Context', { submission: 'NOT_SENT', sendOutcome: null }, { payloadBlocked: false, guardClosed: true }, true],
    ['the sender stopped before writing', { submission: 'NOT_SENT', sendOutcome: 'NOT_WRITTEN' }, { payloadBlocked: false, guardClosed: false }, true],
    ['no response after writing', { submission: 'SENT', sendOutcome: 'NO_RESPONSE' }, { payloadBlocked: false, guardClosed: false }, true],
    ['not sent yet', { submission: 'NOT_SENT', sendOutcome: null }, { payloadBlocked: false, guardClosed: false }, false],
    ['sent and waiting', { submission: 'SENT', sendOutcome: null }, { payloadBlocked: true, guardClosed: true }, false],
  ] as const)('decides whether the submission ended without a response: %s', (_name, report, facts, ended) => {
    expect(submissionEndedWithoutResponseOf(report, facts)).toBe(ended);
  });
});

describe('RB-11: the submission window after the fill', () => {
  it('does not press when the Guard stopped another request, then when asked to stop', () => {
    expect(submissionWindowVerdictOf({ unexpectedRequestCount: 1, stopped: true })).toBe('UNEXPECTED_REQUEST');
    expect(submissionWindowVerdictOf({ unexpectedRequestCount: 0, stopped: true })).toBe('STOPPED');
    expect(submissionWindowVerdictOf({ unexpectedRequestCount: 0, stopped: false })).toBeNull();
  });
});

describe('RB-11: the location of the form in the chosen row', () => {
  const inRow = (formPath: readonly number[]): boolean => formPath[0] === 1;

  it.each([
    ['unreadable rows', { rowsRead: false, forms: [{ path: [1], visible: true }] }, { ok: false, reason: 'FORM_UNREADABLE' }],
    ['unreadable forms', { rowsRead: true, forms: null }, { ok: false, reason: 'FORM_UNREADABLE' }],
    ['two forms', { rowsRead: true, forms: [{ path: [1], visible: true }, { path: [1, 2], visible: true }] }, { ok: false, reason: 'FORM_AMBIGUOUS' }],
    ['no form', { rowsRead: true, forms: [] }, { ok: false, reason: 'FORM_NOT_FOUND' }],
    ['a hidden form', { rowsRead: true, forms: [{ path: [1], visible: false }] }, { ok: false, reason: 'FORM_NOT_FOUND' }],
    ['a form in another row', { rowsRead: true, forms: [{ path: [2], visible: true }] }, { ok: false, reason: 'FORM_NOT_FOUND' }],
    ['the form in the row', { rowsRead: true, forms: [{ path: [1, 0], visible: true }] }, { ok: true, formPath: [1, 0] }],
  ] as const)('decides %s', (_name, facts, expected) => {
    expect(rowFormCandidateOf({ ...facts, inSelectedRow: inRow })).toEqual(expected);
  });

  it('reads again only while the form is not drawn yet and the page is there', () => {
    expect(rowFormLocationStepOf({ ok: false, reason: 'FORM_NOT_FOUND' }, { pageGone: false })).toBe('READ_AGAIN');
    expect(rowFormLocationStepOf({ ok: false, reason: 'FORM_NOT_FOUND' }, { pageGone: true })).toBe('DONE');
    expect(rowFormLocationStepOf({ ok: false, reason: 'FORM_AMBIGUOUS' }, { pageGone: false })).toBe('DONE');
    expect(rowFormLocationStepOf({ ok: true, formPath: [1], submitterWords: [] }, { pageGone: false })).toBe('DONE');
  });
});

describe('RB-11: the next step of the result of a form write', () => {
  const responded = (notDelivered: readonly boolean[], extra: Partial<FormResultObservation> = {}): FormResultObservation =>
    ({ response: 'RESPONDED', responseStatus: 200, notDelivered, ...extra });
  const afterRead = (finalStatus: number | null, sessionLost = false): Partial<FormResultObservation> => ({ afterRead: { finalStatus, sessionLost } });

  it('settles, then reads, then observes the page in this order', () => {
    expect(formResultStepOf(responded([false]))).toEqual({ kind: 'SETTLE' });
    expect(formResultStepOf(responded([false, false]))).toEqual({ kind: 'READ' });
    expect(formResultStepOf(responded([false, false, false], afterRead(200)))).toEqual({ kind: 'OBSERVE_PAGE', httpStatus: 200 });
  });

  it.each([
    ['no response', { response: 'ENDED_WITHOUT_RESPONSE', responseStatus: null, notDelivered: [] }, null],
    ['a repost redirect before the delivery check', responded([true], { responseStatus: 307 }), 'REPOST_REDIRECT'],
    ['not delivered after the response', responded([true]), 'RESPONSE_NOT_DELIVERED'],
    ['not delivered after the read', responded([false, false, true], afterRead(200, true)), 'RESPONSE_NOT_DELIVERED'],
    ['no document status', responded([false, false, false], afterRead(null)), 'NO_CONDITION_MATCHED'],
    ['a lost session on a structure status', responded([false, false, false], afterRead(302, true)), 'SESSION_LOST'],
  ] as const)('decides %s', (_name, observation, judgement) => {
    expect(formResultStepOf(observation)).toEqual({ kind: 'DECIDED', judgement });
  });

  it('does not say SESSION_LOST for an error status (the structure judgement decides it)', () => {
    expect(formResultStepOf(responded([false, false, false], afterRead(500, true)))).toEqual({ kind: 'OBSERVE_PAGE', httpStatus: 500 });
  });
});

describe('RB-11: the wait for the fields that the SPA draws late (OP-L L1)', () => {
  it('inspects again only while a field or the submitter may still be drawn, the page is there and the limit is not reached', () => {
    const facts = { pageGone: false, limitReached: false };
    expect(inspectAgainStepOf({ ok: false, reason: 'FIELD_NOT_FOUND' }, facts)).toBe('INSPECT_AGAIN');
    expect(inspectAgainStepOf({ ok: false, reason: 'SUBMITTER_NOT_FOUND' }, facts)).toBe('INSPECT_AGAIN');
    expect(inspectAgainStepOf({ ok: false, reason: 'FIELD_NOT_VISIBLE' }, facts)).toBe('INSPECT_AGAIN');
    expect(inspectAgainStepOf({ ok: false, reason: 'FIELD_AMBIGUOUS' }, facts)).toBe('DONE');
    expect(inspectAgainStepOf({ ok: false, reason: 'FIELD_NOT_FOUND' }, { pageGone: true, limitReached: false })).toBe('DONE');
    expect(inspectAgainStepOf({ ok: false, reason: 'FIELD_NOT_FOUND' }, { pageGone: false, limitReached: true })).toBe('DONE');
  });
});

describe('RB-11: the refill and the press of the API write input', () => {
  it('refills only a rebuilt field or a changed value while the page is there', () => {
    expect(refillStepOf({ ok: false, reason: 'ELEMENT_CHANGED' }, { pageGone: false })).toBe('REFILL');
    expect(refillStepOf({ ok: false, reason: 'VALUE_CHANGED' }, { pageGone: false })).toBe('REFILL');
    expect(refillStepOf({ ok: false, reason: 'VALUE_CHANGED' }, { pageGone: true })).toBe('DONE');
    expect(refillStepOf({ ok: false, reason: 'INPUT_FAILED' }, { pageGone: false })).toBe('DONE');
    expect(refillStepOf({ ok: true }, { pageGone: false })).toBe('DONE');
  });

  it('inspects again only when the elements were rebuilt before the press, and never after a press', () => {
    const stopped = { ok: false, reason: 'VALUE_CHANGED', clickAttempted: false } as const;
    expect(pressRetryStepOf({ status: 'DONE' }, { pageGone: true })).toEqual({ kind: 'END', result: { ok: true } });
    expect(pressRetryStepOf({ status: 'STOPPED', result: stopped }, { pageGone: false })).toEqual({ kind: 'END', result: stopped });
    expect(pressRetryStepOf({ status: 'CHANGED' }, { pageGone: false })).toEqual({ kind: 'REINSPECT' });
    expect(pressRetryStepOf({ status: 'CHANGED' }, { pageGone: true }))
      .toEqual({ kind: 'END', result: { ok: false, reason: 'ELEMENT_CHANGED', clickAttempted: false } });
  });
});
