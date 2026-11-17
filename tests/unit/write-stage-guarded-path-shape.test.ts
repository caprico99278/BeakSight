// LU-SFIX4（LU-REV の Minor-1。設計書 `2026-11-02-beaksight-list-row-update-design.md` 5.5 の 6）: 一覧の行から開くフォームの更新の書き込みの段（前の値を後から
// 入れる印 `deferredPriorValues` のある期待）は、窓の前（N2）に守る送信先の型（`guardedPathShape`）を必須にする。渡されなければ、Guard は書き込みの段を受けない
// （`guardWriteStageCopyOf` が null。factory は Context を作らず、窓を開かない。fail closed）。登録の期待と、印のない更新の期待は今のまま。
// ブラウザは使わない（受け付けの確かめだけ）。値は合成のテストデータだけ。
import { describe, expect, it } from 'vitest';
import { WriteStageMonitor, guardWriteStageCopyOf, type GuardWriteStage } from '../../src/safety/passive-request-guard.js';
import type { WritePayloadExpectation } from '../../src/safety/write-payload-policy.js';

const ORIGIN = 'http://127.0.0.1:8080';
const REQUEST = Object.freeze({ origin: ORIGIN, path: '/items/2', enctype: 'application/x-www-form-urlencoded' as const });

/** 前の値を後から入れる印のある期待（保つ見える欄 `email`）。 */
const DEFERRED: WritePayloadExpectation = Object.freeze({
  request: REQUEST,
  submittedFields: [{ name: 'title', value: '新しい題名' }],
  passthroughFieldNames: [],
  emptyFileFieldNames: [],
  methodOverride: null,
  absentFieldNames: [],
  checkedPassthroughFields: [],
  checkboxPairs: [],
  deferredPriorValues: { keptFieldNames: ['email'], checkedPassthroughNames: [], keptCheckboxPairNames: [], changedCheckboxPairs: [], nullableFieldNames: [] },
});
/** 印のない期待（登録と同じ形）。 */
const PLAIN: WritePayloadExpectation = Object.freeze({
  request: REQUEST, submittedFields: [{ name: 'title', value: '題名' }], passthroughFieldNames: [], emptyFileFieldNames: [],
});

const stageOf = (expectation: WritePayloadExpectation, guardedPathShape?: string): GuardWriteStage =>
  (guardedPathShape === undefined ? { expectation, monitor: new WriteStageMonitor() } : { expectation, monitor: new WriteStageMonitor(), guardedPathShape });

describe('LU-SFIX4 M-1: the guarded path shape of a list row form update write stage', () => {
  it('refuses the write stage of a deferred prior values expectation without the guarded path shape', () => {
    expect(guardWriteStageCopyOf(stageOf(DEFERRED))).toBeNull();
  });

  it('accepts it with the guarded path shape of the request path', () => {
    expect(guardWriteStageCopyOf(stageOf(DEFERRED, '/items/{id}'))).toMatchObject({ guardedPathShape: '/items/{id}' });
  });

  it('keeps an expectation without the mark as it was (with or without the guarded path shape)', () => {
    expect(guardWriteStageCopyOf(stageOf(PLAIN))).not.toBeNull();
    expect(guardWriteStageCopyOf(stageOf(PLAIN, '/items/{id}'))).not.toBeNull();
  });
});
