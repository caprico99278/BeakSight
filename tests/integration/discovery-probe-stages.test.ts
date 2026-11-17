// COV-1・COV-3（網羅の設計書 `2026-11-09-beaksight-coverage-by-state-design.md` 3.2 の 1・3.3・5 の COV-1、DEF-238 の設計書 3.1）: 操作さがしの段。
// 押して画面が変わったら、打ち切らずに新しい段として読み直して続けて押し、状態の鍵（構造の鍵）で終える。select・radio の選択肢を 1 つずつ（凍結の中で）選び、
// 画面の構造の鍵が、まだ見ていないものに変わった選択肢を新しい段にする（読み込み直して、選んだ選択肢をたどり直し、その段で押す）。本物の発見の流れ
// （`executeDiscoveryRun`。Guard・凍結・押す部品）と、127.0.0.1 の仮のサイト（`tests/helpers/staged-probe-site.ts`・`option-stage-site.ts`。一般の文言）で
// 確かめる。既定の Chromium と本番の既定の送信の扱い（PASS_EXCEPT_DELETE）だけ。
// - RB-13: 押下の段（段の番号と前の押下の並び、状態が繰り返す画面で終わる）は、偽の口の単体（`submission-probe-loop.test.ts`）へ移した。
// - 種別の select で「法人」を選ぶと出る「登録」の送信の形が記録される。radio の組で「その他」を選ぶと出る自由記入の欄の段がある。選ぶと読み取りの GET と
//   POST を出す select: GET は届き、POST は届かない。画面の読み込みは、構造の変わる選択肢の段の数だけ増える。
// - どの場面も、サーバに届いた読み取りでない要求は 0（名前つきの時間だけ待ってから数え直す）。
// SLIM BD-2: 前の discovery-option-stages を取り込んだ。押す回数・選択肢の数の上限がないことを数（70・250 のボタン、300 の選択肢）で確かめる場面は外した
// （上限の撤廃は SPEC-1 で作りから消えた。選択肢の段の決めは単体 `submission-probe-choice-step.test.ts`）。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import type { DiscoveryCandidate } from '../../src/discovery/candidate-contracts.js';
import type { DiscoveryDocument, DiscoveryOptionChoiceRecord } from '../../src/discovery/discovery-result.js';
import type { RunAuthentication } from '../../src/orchestration/authenticated-run.js';
import { executeDiscoveryRun } from '../../src/worker/discovery-run.js';
import { launchHeadlessChromium, useSharedRunBrowser } from '../helpers/chromium.js';
import { READ_METHODS } from '../helpers/leak-places.js';
import { settleLateDeliveries, startLoopbackHttpServer } from '../helpers/loopback-server.js';
import { optionSiteHandler } from '../helpers/option-stage-site.js';
import type { SeenRequest } from '../helpers/staged-probe-site.js';
import { createTestConfig } from '../helpers/test-config.js';
import { TEST_OBSERVATION_WINDOWS } from '../helpers/test-waits.js';

const TEST_TIMEOUT_MS = 240_000;
/** 読み込みの最小の間隔（ms。ループバックの fixture なので短くする）。 */
const NAVIGATION_INTERVAL_MS = 200;
/** 全部の後に、遅れて届く要求を待つ時間（ms）。 */
const LATE_DELIVERY_SETTLE_MS = 1_000;

/** 届いた要求を `seen` に記録するサイトの口を作る（`optionSiteHandler`）。 */
type SiteHandlerOf = (seen: SeenRequest[]) => (request: IncomingMessage, response: ServerResponse) => void;

const nonReadsOf = (seen: readonly SeenRequest[]): readonly string[] =>
  seen.filter(({ method }) => !READ_METHODS.has(method) && method !== 'OPTIONS').map(({ method, path }) => `${method} ${path}`);
const pageLoadsOf = (seen: readonly SeenRequest[], path: string): number => seen.filter(({ method, path: seenPath }) => method === 'GET' && seenPath === path).length;
const readRecordOf = (document: DiscoveryDocument, path: string): { candidates: readonly DiscoveryCandidate[]; choices: readonly DiscoveryOptionChoiceRecord[] } => {
  const pages = document.pages.flatMap((page) => (page.state === 'READ' && page.record.location?.path === path ? [page.record] : []));
  expect(pages).toHaveLength(1);
  return { candidates: pages[0]?.candidates ?? [], choices: pages[0]?.optionChoices ?? [] };
};
/** 記録された送信の形のうち、path の形が `pathShape` のもの（なければ undefined）。 */
const shapeOf = (candidates: readonly DiscoveryCandidate[], pathShape: string): NonNullable<DiscoveryCandidate['submissionProbe']>['shape'] | undefined =>
  candidates.find((candidate) => candidate.submissionProbe?.shape?.pathShape === pathShape)?.submissionProbe?.shape;
/** 最初の状態（1 段目）で選んだ欄の記録。 */
const firstStageChoiceOf = (choices: readonly DiscoveryOptionChoiceRecord[], kind: 'SELECT' | 'RADIO', name: string): DiscoveryOptionChoiceRecord | undefined =>
  choices.find((choice) => choice.stage === 1 && choice.field.kind === kind && choice.field.name === name);

describe('COV-1 and COV-3: the stages of the submission probe (the default test Chromium, PASS_EXCEPT_DELETE)', () => {
  const launch = useSharedRunBrowser(() => launchHeadlessChromium());

  /** 仮のサイトの 1 画面を、本物の発見の流れで読む（1 画面だけ）。 */
  const discover = async (handlerOf: SiteHandlerOf, startPath: string): Promise<{ readonly document: DiscoveryDocument; readonly seen: readonly SeenRequest[] }> => {
    const seen: SeenRequest[] = [];
    const server = await startLoopbackHttpServer(handlerOf(seen));
    const directory = await mkdtemp(join(tmpdir(), 'beaksight-probe-stages-'));
    try {
      const config = createTestConfig(server.origin, startPath, {
        crawl: { maxPages: 1, minNavigationIntervalMs: NAVIGATION_INTERVAL_MS },
        audit: { screenshots: false, sendPolicy: 'PASS_EXCEPT_DELETE' }, output: { directory },
      });
      const authentication: RunAuthentication = {
        initialState: { cookies: [], origins: [] },
        approvedTestOrigins: [server.origin],
        auditExclusions: { excludedPathPrefixes: [], auditPathPrefixes: [], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
        sessionLostPathPrefix: null,
        filterState: filterAuthenticatedState,
      };
      const outcome = await executeDiscoveryRun({
        config, jobId: 'probe-stages', authentication, launchBrowser: launch,
        clock: () => new Date(), now: () => Date.now(), stopSignal: new AbortController().signal, observationWindows: TEST_OBSERVATION_WINDOWS,
      }, { onRunStarted: () => undefined, onSessionLost: () => undefined });
      if (outcome.kind !== 'RAN') throw new Error(`the discovery job did not run: ${outcome.kind}`);
      const document = JSON.parse(readFileSync(join(outcome.runDirectory, 'discovery.json'), 'utf8')) as DiscoveryDocument;
      // SLIM-2（X1）: 流れは Browser の Context を閉じて終わる。閉じた後の待ちは、サーバが静まるまで。
      await settleLateDeliveries(LATE_DELIVERY_SETTLE_MS, server);
      return { document, seen: [...seen] };
    } finally {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  };

  // RB-13: COV-1 の段の読み直し（予約の画面）と、状態が繰り返す画面で終わる場面は、偽の口の単体（`tests/unit/submission-probe-loop.test.ts`）へ移した。

  it('COV-3 kind: records the shape of the register that the option of the select shows, and nothing reaches the site', async () => {
    const { document, seen } = await discover(optionSiteHandler, '/opt/kind');
    const { candidates, choices } = readRecordOf(document, '/opt/kind');
    expect(shapeOf(candidates, '/opt/kind/api/corp')).toMatchObject({ method: 'POST' });
    expect(shapeOf(candidates, '/opt/kind/api/person')).toMatchObject({ method: 'POST' });
    const kind = firstStageChoiceOf(choices, 'SELECT', 'kind');
    expect(kind).toMatchObject({ optionCount: 3, chosenCount: 3 });
    // 「法人」（3 つ目の選択肢）だけが新しい段を作る。段の分だけ読み込み直す（最初の読み込みと、法人の段の 1 回）。
    expect(kind?.changed.filter(({ newStage }) => newStage).map(({ optionIndex }) => optionIndex)).toEqual([2]);
    expect(pageLoadsOf(seen, '/opt/kind')).toBe(2);
    expect(nonReadsOf(seen)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('COV-3 radio: makes the stage of the free text field that the last option of the radio group shows', async () => {
    const { document, seen } = await discover(optionSiteHandler, '/opt/radio');
    const { candidates, choices } = readRecordOf(document, '/opt/radio');
    const kind = firstStageChoiceOf(choices, 'RADIO', 'kind');
    expect(kind).toMatchObject({ optionCount: 3, chosenCount: 3 });
    expect(kind?.changed.filter(({ newStage }) => newStage).map(({ optionIndex }) => optionIndex)).toEqual([2]);
    expect(shapeOf(candidates, '/opt/radio/api/apply')).toMatchObject({ method: 'POST' });
    expect(pageLoadsOf(seen, '/opt/radio')).toBe(2);
    expect(nonReadsOf(seen)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('COV-3 change: lets the read of the option through and stops its POST', async () => {
    const { document, seen } = await discover(optionSiteHandler, '/opt/change');
    const { choices } = readRecordOf(document, '/opt/change');
    expect(firstStageChoiceOf(choices, 'SELECT', 'area')).toMatchObject({ optionCount: 3, chosenCount: 3, unchangedCount: 3, changed: [] });
    expect(seen.filter(({ method, path }) => method === 'GET' && path === '/opt/change/api/cities').length).toBeGreaterThan(0);
    expect(seen.filter(({ path }) => path === '/opt/change/api/track')).toEqual([]);
    expect(nonReadsOf(seen)).toEqual([]);
    // 構造の変わる選択肢がないので、読み込み直さない。
    expect(pageLoadsOf(seen, '/opt/change')).toBe(1);
  }, TEST_TIMEOUT_MS);
});
