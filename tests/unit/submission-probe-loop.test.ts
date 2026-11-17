// RB-13（再構築の設計書 3 章。案 2 章の 8）: 操作さがしの押す輪（`probeDiscoveredSubmissionsWith`）と、1 つの対象を押すかの決め（`probeStepOf`）。
// 偽の口（メモリの中の画面）で確かめる（ブラウザを使わない）。前は discovery-submission-probe・discovery-probe-scenes・discovery-probe-stages の結合
// （本物の Chromium）で確かめていた、押す順・見えないボタン・凍結の外では押さない・外部スキーム・開いた窓の保存・同じ語・同じ識別の開き手・画面の移り・
// 段の読み直しの場面。本物の読み取りと、凍結の後に何も届かないことは、結合の代表（両方の Chromium）が確かめる。
import { describe, expect, it } from 'vitest';
import { createSha256Fingerprint } from '../../src/core/ids.js';
import type { DiscoveryCandidate } from '../../src/discovery/candidate-contracts.js';
import { probedCandidateIdentityDigestOf } from '../../src/discovery/discover-page.js';
import type { DiscoveryReadPageRecord } from '../../src/discovery/discovery-result.js';
import type { ProbedCandidate } from '../../src/discovery/probe.js';
import { observedSubmissionProbeOf, type SubmissionProbeRecord } from '../../src/discovery/submission-probe-contracts.js';
import {
  probeDiscoveredSubmissionsWith,
  probeStepOf,
  probedReadOf,
  type PressOutcome,
  type ProbeLoopState,
  type ProbeTargetFacts,
  type SubmissionProbeLoopPort,
  type SubmissionProbeOptions,
} from '../../src/interaction/submission-probe.js';
import { candidateOf } from './approval-samples.js';
import { SAMPLE_ORIGIN, sampleButton } from './discovery-candidate-samples.js';

const LOCATION = Object.freeze({ origin: SAMPLE_ORIGIN, path: '/page' });
const POLICY = Object.freeze({ allowedOrigins: new Set([SAMPLE_ORIGIN]), isExcludedPage: () => false });
const NO_FIELDS = Object.freeze({ filledFieldCount: 0, skippedFieldCount: 0 });
const NO_REQUEST = observedSubmissionProbeOf({ shapes: [], nonReadRequestCount: 0, readRequestCount: 0, unrecordedShapeCount: 0 }, NO_FIELDS);
/** 押して読み取りでない送信を観察した記録（形は輪の決めに関わらないので、結果の名前だけ）。 */
const SENT: SubmissionProbeRecord = Object.freeze({ ...NO_REQUEST, result: 'API_CREATE', nonReadRequestCount: 1 });

/**
 * 押したときの動き: 何も送らない・送る（観察）・押す前に外部スキームと見分ける・画面が移る・隠れたボタンを見せる（窓を開く）・次の状態へ・状態を行き来する・
 * Safety の記録がこの文書を使うのをやめる・凍結が解ける。
 */
type PressEffect = 'NO_REQUEST' | 'SENT' | 'EXTERNAL_SCHEME' | 'MOVE' | 'REVEAL' | 'NEXT_STATE' | 'TOGGLE' | 'UNUSABLE' | 'LOSE_FREEZE';

interface FakeButton {
  /** 文言（空はアイコンのボタン）。 */
  readonly text: string;
  /** 見えない（`REVEAL` の押下で見える）。 */
  readonly hidden?: boolean;
  /** この状態の番号から画面に出る（既定 0）。 */
  readonly fromState?: number;
  readonly onPress?: PressEffect;
  /** 共通の枠のボタン（SLK-1）。 */
  readonly frame?: boolean;
}

/** SLK-1: 共通の枠のボタンの識別の digest。 */
const LAYOUT_DIGEST = `sha256:${'e'.repeat(64)}`;

const discoveredOf = (text: string) => sampleButton({ page: LOCATION, submitterText: text });

const probedOf = (text: string, id: number): ProbedCandidate => ({
  kind: 'BUTTON',
  formMethod: null,
  methodOverride: null,
  action: null,
  enctype: null,
  target: null,
  fields: [],
  submitterWords: discoveredOf(text).submitterWords,
  hasSubmitterText: text !== '',
  hasSubmitWord: false,
  inlineHandler: false,
  form: null,
  submitter: { path: [0, id], localName: 'button' },
});

/** 発見の入口の記録の候補（押す対象の分類。識別の digest は読み直しと同じ作り方）。 */
const recordCandidateOf = (text: string): DiscoveryCandidate => ({
  ...candidateOf(discoveredOf(text)),
  classification: 'NEEDS_BINDING',
  identityDigest: probedCandidateIdentityDigestOf(LOCATION, probedOf(text, 0)),
});

/** 偽の画面と口（押した順を `log` に記録する）。 */
const fakePageOf = (buttons: readonly FakeButton[], options: {
  readonly frozen?: boolean;
  readonly observationActive?: boolean;
  /** SLK-1: 画面全体の構造の鍵の頭と、共通の枠の部分の構造の鍵。 */
  readonly screen?: string;
  readonly layout?: string;
} = {}) => {
  const log: string[] = [];
  let state = 0;
  let frozen = options.frozen ?? true;
  let unusable = false;
  let url = `${SAMPLE_ORIGIN}${LOCATION.path}`;
  const revealed = new Set<number>();
  const idOf = (index: number): number => index + 1;
  const buttonOf = (id: number | undefined): FakeButton | undefined => buttons[(id ?? 0) - 1];
  const inDocument = (): number[] => buttons.flatMap((button, index) => ((button.fromState ?? 0) <= state ? [index] : []));
  const visible = (id: number | undefined): boolean => buttonOf(id)?.hidden !== true || revealed.has(id ?? 0);
  const observed = (record: SubmissionProbeRecord): PressOutcome => ({ kind: 'OBSERVED', record });
  const port: SubmissionProbeLoopPort = {
    observationActive: () => options.observationActive === true,
    endObservation: () => undefined,
    freezeHolds: async () => frozen,
    guardClosedContext: () => false,
    documentGone: () => false,
    screenWatchEnded: () => false,
    mainFrameUrl: () => url,
    documentMarker: async () => 1,
    sameDocumentMovedUrl: async () => null,
    movedUrl: () => null,
    watchNavigations: () => ({ lastUrl: () => null, lastBlockedMoveUrl: () => null, stop: () => undefined }),
    readProbed: async () => {
      const present = inDocument();
      return probedReadOf(LOCATION, {
        status: 'READ',
        candidates: present.map((index) => probedOf(buttons[index]?.text ?? '', idOf(index))),
        frameFound: false,
        chosen: present.map((index, at) => ({ candidateIndex: at, element: { backendNodeId: idOf(index), path: [0, idOf(index)] } })),
      }, new Map());
    },
    splitByVisibility: async (targets) => ({
      visible: targets.filter((target) => visible(target.nodeId)),
      invisible: targets.filter((target) => !visible(target.nodeId)),
    }),
    targetContexts: async (targets) => ({
      digests: new Map(targets.flatMap((target) => (buttonOf(target.nodeId)?.frame === true ? [[target.index, LAYOUT_DIGEST] as const] : []))),
      scopes: new Map(),
    }),
    stateStructureKeys: async () => {
      const key = `${options.screen ?? ''}state-${String(state)}`;
      const layout = options.layout;
      const layouts = new Map(layout === undefined ? [] : inDocument().flatMap((index) => (buttons[index]?.frame === true ? [[idOf(index), layout] as const] : [])));
      return { full: key, withoutWords: key, layouts };
    },
    // 状態ごとの作りの印（前の状態の印を含む。戻った状態では新しい印が出ない）。
    structureSignatures: async () => Array.from({ length: state + 1 }, (_value, at) => `structure-${String(at)}`),
    readInOpenDialog: async (ids) => ids.map(() => true),
    classifyProbed: async (_location, _record, _reread, probed) => probed.map((candidate) => recordCandidateOf(buttonOf(candidate.submitter?.path[1])?.text ?? '')),
    chooseAndSettle: async () => false,
    surveyOptions: async () => ({ records: [], stages: [], stopped: false }),
    replayStep: async () => null,
    pressTarget: async (_location, target, _markers, _afterPress, onPress) => {
      const button = buttonOf(target.nodeId);
      if (button === undefined || !visible(target.nodeId)) {
        return { kind: 'NOT_OBSERVED', reason: 'TARGET_NOT_FOUND', fields: NO_FIELDS, inputFields: [] };
      }
      if (button.onPress === 'EXTERNAL_SCHEME') return { kind: 'EXTERNAL_SCHEME' };
      onPress?.();
      log.push(button.text === '' ? '(icon)' : button.text);
      switch (button.onPress ?? 'NO_REQUEST') {
        case 'SENT':
          return observed(SENT);
        case 'MOVE':
          url = `${SAMPLE_ORIGIN}/other`;
          return observed(NO_REQUEST);
        case 'REVEAL':
          for (const [index, other] of buttons.entries()) if (other.hidden === true) revealed.add(idOf(index));
          return observed(NO_REQUEST);
        case 'NEXT_STATE':
          // 状態 1 へ進む（状態 1 で押しても状態は変わらない。押すたびに増え続ける画面にしない）。
          state = 1;
          return observed(NO_REQUEST);
        case 'TOGGLE':
          state = state === 0 ? 1 : 0;
          return observed(NO_REQUEST);
        case 'UNUSABLE':
          unusable = true;
          return observed(NO_REQUEST);
        case 'LOSE_FREEZE':
          frozen = false;
          return observed(NO_REQUEST);
        default:
          return observed(NO_REQUEST);
      }
    },
  };
  return { port, log, documentUnusable: (): boolean => unusable };
};

/** 偽の画面で押す輪を流し、記録の候補ごとの `<結果> <理由>`、押した順、作り直して押す候補を返す。 */
const probe = async (
  buttons: readonly FakeButton[],
  overrides: Partial<SubmissionProbeOptions> = {},
  pageOptions: Parameters<typeof fakePageOf>[1] = {},
) => {
  const page = fakePageOf(buttons, pageOptions);
  const record: DiscoveryReadPageRecord = {
    location: LOCATION,
    incompleteReasons: [],
    candidates: buttons.filter((button) => (button.fromState ?? 0) === 0).map((button) => recordCandidateOf(button.text)),
  };
  const leftBehind: number[] = [];
  const probed = await probeDiscoveredSubmissionsWith(page.port, record, {
    targetPolicy: POLICY,
    onLeftBehind: (index) => leftBehind.push(index),
    documentUnusable: page.documentUnusable,
    ...overrides,
  });
  const results = probed.candidates.map(({ submissionProbe }) => `${String(submissionProbe?.result)} ${String(submissionProbe?.reason)}`);
  return { results, log: page.log, leftBehind, probed };
};

describe('RB-13: the press loop of the submission probe (a fake port)', () => {
  it('DEF-142, T44c, COV-1: presses the save first, then the text and icon buttons, never the delete button, and skips an invisible button without a press', async () => {
    const { results, log } = await probe([
      { text: '' },
      { text: 'メニュー' },
      { text: '保存', onPress: 'SENT' },
      { text: '削除' },
      { text: '登録', hidden: true },
    ]);

    expect(log).toEqual(['保存', 'メニュー', '(icon)']);
    expect(results).toEqual(['NO_REQUEST null', 'NO_REQUEST null', 'API_CREATE null', 'undefined undefined', 'NOT_OBSERVED TARGET_NOT_FOUND']);
  });

  it('never presses outside the frozen stage: not frozen, the observation still open, or the freeze lost after a press (PRESS_FAILED)', async () => {
    const buttons: readonly FakeButton[] = [{ text: '保存' }, { text: '登録' }];
    for (const pageOptions of [{ frozen: false }, { observationActive: true }]) {
      const { results, log } = await probe(buttons, {}, pageOptions);
      expect(log).toEqual([]);
      expect(results).toEqual(['NOT_OBSERVED PRESS_FAILED', 'NOT_OBSERVED PRESS_FAILED']);
    }
    const lost = await probe([{ text: '保存', onPress: 'LOSE_FREEZE' }, { text: '登録' }]);
    expect(lost.log).toEqual(['保存']);
    expect(lost.results).toEqual(['NO_REQUEST null', 'NOT_OBSERVED PRESS_FAILED']);
  });

  it('DEF-144 and L10: records an external scheme target without a press and goes on; stops pressing once the Safety record makes the document unusable', async () => {
    const external = await probe([{ text: '登録', onPress: 'EXTERNAL_SCHEME' }, { text: '保存', onPress: 'SENT' }]);
    expect(external.log).toEqual(['保存']);
    expect(external.results).toEqual(['NOT_EXECUTABLE EXTERNAL_SCHEME', 'API_CREATE null']);

    const unusable = await probe([{ text: '登録', onPress: 'UNUSABLE' }, { text: '保存', onPress: 'SENT' }]);
    expect(unusable.log).toEqual(['登録']);
    expect(unusable.results).toEqual(['NO_REQUEST null', 'NOT_OBSERVED PAGE_CHANGED']);
    // 残りは、呼ぶ側が新しい Context で読み込み直して押す。
    expect(unusable.leftBehind).toEqual([1]);
  });

  it('DEF-145: after a press that sends nothing, presses the save that the press made visible', async () => {
    const { results, log } = await probe([{ text: '保存', hidden: true, onPress: 'SENT' }, { text: 'メニュー', onPress: 'REVEAL' }]);

    expect(log).toEqual(['メニュー', '保存']);
    expect(results).toEqual(['API_CREATE null', 'NO_REQUEST null']);
  });

  it('DEF-208-2 and LU-4: presses only the first of the same words that sent nothing, and the first of the same named openers', async () => {
    const words = await probe([{ text: '追加' }, { text: '追加' }, { text: '追加' }, { text: '保存', onPress: 'SENT' }]);
    expect(words.log).toEqual(['保存', '追加']);
    expect(words.results).toEqual(['NO_REQUEST null', 'NOT_OBSERVED SAME_WORDS_NO_REQUEST', 'NOT_OBSERVED SAME_WORDS_NO_REQUEST', 'API_CREATE null']);

    const openers = await probe([{ text: '編集' }, { text: '編集' }, { text: '編集' }]);
    expect(openers.log).toEqual(['編集']);
    expect(openers.results).toEqual(['NO_REQUEST null', 'NOT_OBSERVED SAME_IDENTITY_PRESSED', 'NOT_OBSERVED SAME_IDENTITY_PRESSED']);
  });

  it('DEF-144 and COV-2: after a press that moves the page, does not press the rest and hands it over to press after a reload', async () => {
    const { results, log, leftBehind } = await probe([{ text: '保存', onPress: 'MOVE' }, { text: 'メニュー' }]);

    expect(log).toEqual(['保存']);
    expect(results).toEqual(['NOT_OBSERVED PAGE_CHANGED', 'NOT_OBSERVED PAGE_CHANGED']);
    expect(leftBehind).toEqual([1]);
  });

  it('COV-1: reads the new state after a press as a new stage, adds the new button and records its stage and the presses before it', async () => {
    const { probed, log } = await probe([{ text: 'メニュー', onPress: 'NEXT_STATE' }, { text: '保存', fromState: 1, onPress: 'SENT' }]);

    // 新しい段では、まだ押していない対象を先に押す（前の段で押した「メニュー」は、その状態でもう一度押す）。
    expect(log).toEqual(['メニュー', '保存', 'メニュー']);
    expect(probed.candidates).toHaveLength(2);
    expect(probed.candidates[1]?.submissionProbe).toMatchObject({ result: 'API_CREATE', stage: { number: 2 } });
    expect(probed.candidates[1]?.submissionProbe?.stage?.priorPresses).toHaveLength(1);
  });

  it('COV-1: ends on a screen whose states repeat, pressing once in each state, with a result on every candidate', async () => {
    const { results, log } = await probe([{ text: 'メニュー', onPress: 'TOGGLE' }]);

    expect(log).toEqual(['メニュー', 'メニュー']);
    expect(results).toEqual(['NO_REQUEST null']);
  });

  // SLK-1（網羅の設計書 6 章の 2026-11-16）: 共通の枠のボタンの押した印は、枠の部分の構造の鍵と識別の組。
  it('SLK-1: does not press a shared layout button again on a screen of another structure with the same layout part, and presses it when the layout part differs', async () => {
    const buttons: readonly FakeButton[] = [{ text: 'メニュー', frame: true }, { text: '保存', onPress: 'SENT' }];
    const pressed: string[] = [];
    const sharedLayout = (earlier: readonly string[]): SubmissionProbeOptions['sharedLayout'] => ({ pressed: new Set(earlier), onPressed: (key) => { pressed.push(key); } });

    expect((await probe(buttons, { sharedLayout: sharedLayout([]) }, { screen: 'a-', layout: 'layout-1' })).log).toEqual(['保存', 'メニュー']);
    const same = await probe(buttons, { sharedLayout: sharedLayout([...pressed]) }, { screen: 'b-', layout: 'layout-1' });
    expect(same.log).toEqual(['保存']);
    expect(same.results[0]).toBe('NOT_OBSERVED SHARED_LAYOUT_PRESSED');
    expect((await probe(buttons, { sharedLayout: sharedLayout([...pressed]) }, { screen: 'c-', layout: 'layout-2' })).log).toEqual(['保存', 'メニュー']);
    // 前の版の印（画面全体の構造の鍵との組）は使わない（押し直す側）。
    const earlierFormat = createSha256Fingerprint(JSON.stringify(['beaksight-shared-layout-state/1', 'b-state-0', LAYOUT_DIGEST]));
    expect((await probe(buttons, { sharedLayout: sharedLayout([earlierFormat]) }, { screen: 'b-', layout: 'layout-1' })).log).toEqual(['保存', 'メニュー']);
  });
});

describe('RB-13: probeStepOf (whether to press one target)', () => {
  const EMPTY: ProbeLoopState = { processed: new Set(), pressedEarlierLayouts: new Set(), noRequestWords: new Set() };
  const CLEAR: ProbeTargetFacts = {
    stageKey: 'k', layoutKey: undefined, wordsKey: null, pageState: 'SAME', pressedInSameState: false, recorded: false, openerInMarkedDocument: false,
  };

  it('reads the freeze only after the other checks, and presses only in the frozen stage', () => {
    expect(probeStepOf({ ...EMPTY, processed: new Set(['k']) }, CLEAR)).toEqual({ kind: 'SKIP_PROCESSED' });
    expect(probeStepOf(EMPTY, { ...CLEAR, pageState: 'CLOSED_BY_GUARD' })).toEqual({ kind: 'SKIP', reason: 'CONTEXT_CLOSED_BY_GUARD', leftBehind: 'QUEUE' });
    expect(probeStepOf(EMPTY, { ...CLEAR, pressedInSameState: true, recorded: true })).toEqual({ kind: 'SKIP', reason: null, leftBehind: null });
    expect(probeStepOf(EMPTY, CLEAR)).toEqual({ kind: 'READ_FREEZE' });
    expect(probeStepOf(EMPTY, { ...CLEAR, freeze: 'NOT_HOLDING' })).toEqual({ kind: 'SKIP', reason: 'PRESS_FAILED', leftBehind: null });
    expect(probeStepOf(EMPTY, { ...CLEAR, freeze: 'CLOSED_BY_GUARD' })).toEqual({ kind: 'SKIP', reason: 'CONTEXT_CLOSED_BY_GUARD', leftBehind: 'QUEUE' });
    expect(probeStepOf(EMPTY, { ...CLEAR, freeze: 'HOLDS', openerInMarkedDocument: true })).toEqual({ kind: 'SKIP', reason: 'PAGE_CHANGED', leftBehind: 'DOCUMENT' });
    expect(probeStepOf(EMPTY, { ...CLEAR, freeze: 'HOLDS' })).toEqual({ kind: 'PRESS' });
  });

  // REV-RB13 の Minor: 前半の決めの順（共通の枠 → 同じ語 → 画面が移った → ほかの画面で押した組）。同時に当たるときは、前の理由になる。
  it('when several reasons hold, gives the earlier one: the shared layout, then the same words, then the page change, then the same state', () => {
    const seen: ProbeLoopState = { ...EMPTY, pressedEarlierLayouts: new Set(['layout']), noRequestWords: new Set(['words']) };
    expect(probeStepOf(seen, { ...CLEAR, layoutKey: 'layout', wordsKey: 'words' }))
      .toEqual({ kind: 'SKIP', reason: 'SHARED_LAYOUT_PRESSED', leftBehind: null });
    expect(probeStepOf(seen, { ...CLEAR, wordsKey: 'words', pageState: 'CHANGED' }))
      .toEqual({ kind: 'SKIP', reason: 'SAME_WORDS_NO_REQUEST', leftBehind: null });
    expect(probeStepOf(seen, { ...CLEAR, pageState: 'CHANGED', pressedInSameState: true }))
      .toEqual({ kind: 'SKIP', reason: 'PAGE_CHANGED', leftBehind: 'QUEUE' });
  });
});
