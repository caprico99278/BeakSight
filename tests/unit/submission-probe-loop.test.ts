// RB-13（再構築の設計書 3 章。案 2 章の 8）: 操作さがしの押す輪（`probeDiscoveredSubmissionsWith`）と、1 つの対象を押すかの決め（`probeStepOf`）。
// 偽の口（メモリの中の画面）で確かめる（ブラウザを使わない）。前は discovery-submission-probe・discovery-probe-scenes・discovery-probe-stages の結合
// （本物の Chromium）で確かめていた、押す順・見えないボタン・凍結の外では押さない・外部スキーム・開いた窓の保存・同じ語・同じ識別の開き手・画面の移り・
// 段の読み直しの場面。本物の読み取りと、凍結の後に何も届かないことは、結合の代表（両方の Chromium）が確かめる。
import { describe, expect, it, vi } from 'vitest';
import { createSha256Fingerprint } from '../../src/core/ids.js';
import { observationWindowsOrProduction } from '../../src/core/observation-windows.js';
import type { CandidateLocation, DiscoveryCandidate } from '../../src/discovery/candidate-contracts.js';
import { CoverageQueue } from '../../src/discovery/coverage-queue.js';
import { probedCandidateIdentityDigestOf } from '../../src/discovery/discover-page.js';
import type { DiscoveryReadPageRecord } from '../../src/discovery/discovery-result.js';
import { submitterTextShapeOf, type ProbedCandidate } from '../../src/discovery/probe.js';
import { observedSubmissionProbeOf, type SubmissionProbeRecord } from '../../src/discovery/submission-probe-contracts.js';
import {
  pressReadyOf,
  probeDiscoveredSubmissionsWith,
  probeStepOf,
  probedReadOf,
  type PressOutcome,
  type ProbeLoopState,
  type ProbeTargetFacts,
  type InputCheckField,
  type ReadinessMemoEntry,
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
type PressEffect = 'NO_REQUEST' | 'SENT' | 'EXTERNAL_SCHEME' | 'MOVE' | 'REVEAL' | 'NEXT_STATE' | 'SENT_NEXT_STATE' | 'TOGGLE' | 'UNUSABLE' | 'LOSE_FREEZE'
  | 'NEVER_RETURNS' | 'AI_SENT' | 'NOT_READY_THEN_HIDDEN';

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

/** ISKIP: 入力の確かめの欄（打つだけの文字の欄か、選べる欄。`frame` は共通の枠の鍵の元）。欄の識別は、種類・名前・選択肢の並び。 */
interface FakeInput {
  readonly kind: 'TEXT' | 'SELECT';
  readonly name: string;
  readonly options?: readonly string[];
  readonly frame?: string;
}

const inputCheckOf = (input: FakeInput): InputCheckField => ({
  identityDigest: createSha256Fingerprint(JSON.stringify([input.kind, input.name, input.options ?? []])),
  layoutKey: input.frame === undefined ? null : createSha256Fingerprint(input.frame),
});

/** SLK-1: 共通の枠のボタンの識別の digest。 */
const LAYOUT_DIGEST = `sha256:${'e'.repeat(64)}`;

const discoveredOf = (text: string, location: CandidateLocation = LOCATION) => sampleButton({ page: location, submitterText: text });

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
  // CALDAY fix round 1: 押す組の決めだけに使う文字の型（偽の画面では、文字がそのまま見える文字）。
  submitterTextShape: submitterTextShapeOf(text),
  inlineHandler: false,
  form: null,
  submitter: { path: [0, id], localName: 'button' },
});

/** 発見の入口の記録の候補（押す対象の分類。識別の digest は読み直しと同じ作り方）。 */
const recordCandidateOf = (text: string, location: CandidateLocation = LOCATION): DiscoveryCandidate => ({
  ...candidateOf(discoveredOf(text, location)),
  classification: 'NEEDS_BINDING',
  identityDigest: probedCandidateIdentityDigestOf(location, probedOf(text, 0)),
});

/** 偽の画面と口（押した順を `log` に記録する）。 */
const fakePageOf = (buttons: readonly FakeButton[], options: {
  readonly frozen?: boolean;
  readonly observationActive?: boolean;
  /** SLK-1: 画面全体の構造の鍵の頭と、共通の枠の部分の構造の鍵。 */
  readonly screen?: string;
  readonly layout?: string;
  /** DEF-295: 選択肢を選ぶ手が返らない。 */
  readonly surveyNeverReturns?: boolean;
  /** PSKIP: 画面の場所（既定 `LOCATION`）。 */
  readonly location?: CandidateLocation;
  /** ISKIP: 入力の確かめの欄（確かめた欄を `checked` に記録する）。 */
  readonly inputs?: readonly FakeInput[];
} = {}) => {
  const location = options.location ?? LOCATION;
  const log: string[] = [];
  const checked: string[] = [];
  const checkInputs = (kind: FakeInput['kind'], isFirst: (field: InputCheckField) => boolean): void => {
    for (const input of options.inputs ?? []) if (input.kind === kind && isFirst(inputCheckOf(input))) checked.push(input.name);
  };
  let surveying = false;
  let state = 0;
  let frozen = options.frozen ?? true;
  let unusable = false;
  let aiSent = false;
  let url = `${SAMPLE_ORIGIN}${location.path}`;
  const revealed = new Set<number>();
  const notReadyOnce = new Set<number>();
  const idOf =(index: number): number => index + 1;
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
      return probedReadOf(location, {
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
      // 構造の鍵は digest（操作さがし全体の押した組の記録 `CoverageQueue` が受ける形）。
      const key = createSha256Fingerprint(`${options.screen ?? ''}state-${String(state)}`);
      const layout = options.layout;
      const layouts = new Map(layout === undefined ? [] : inDocument().flatMap((index) => (buttons[index]?.frame === true ? [[idOf(index), layout] as const] : [])));
      return { full: key, withoutWords: key, layouts };
    },
    // 状態ごとの作りの印（前の状態の印を含む。戻った状態では新しい印が出ない）。
    structureSignatures: async () => Array.from({ length: state + 1 }, (_value, at) => `structure-${String(at)}`),
    readInOpenDialog: async (ids) => ids.map(() => true),
    classifyProbed: async (_location, _record, _reread, probed) => probed.map((candidate) => recordCandidateOf(buttonOf(candidate.submitter?.path[1])?.text ?? '', location)),
    chooseAndSettle: async () => false,
    surveyOptions: async (_location, context) => {
      surveying = true;
      if (options.surveyNeverReturns === true) return new Promise<never>(() => undefined);
      checkInputs('SELECT', context.isFirstSurvey);
      return { records: [], stages: [], stopped: false };
    },
    typeLoneFields: async (_location, _markers, _afterPress, _filledOriginals, _shouldStop, isFirstTyping) => {
      checkInputs('TEXT', isFirstTyping);
      return [];
    },
    watchAiRequests: () => {
      aiSent = false;
      return { stop: () => aiSent };
    },
    replayStep: async () => {
      log.push('(replay)');
      return null;
    },
    pressTarget: async (_location, target, _markers, _afterPress, onPress) => {
      const button = buttonOf(target.nodeId);
      if (button === undefined || !visible(target.nodeId)) {
        return { kind: 'NOT_OBSERVED', reason: 'TARGET_NOT_FOUND', fields: NO_FIELDS, inputFields: [] };
      }
      if (button.onPress === 'EXTERNAL_SCHEME') return { kind: 'EXTERNAL_SCHEME' };
      if (button.onPress === 'NOT_READY_THEN_HIDDEN') {
        // PREADY: 1 回目は準備の確かめ（hover）が済まず、2 回目からは見えない（押していない）。
        const first = !notReadyOnce.has(target.nodeId ?? 0);
        notReadyOnce.add(target.nodeId ?? 0);
        return first
          ? { kind: 'NOT_OBSERVED', reason: 'TARGET_NOT_STABLE', readinessFailed: true, fields: NO_FIELDS, inputFields: [] }
          : { kind: 'NOT_OBSERVED', reason: 'TARGET_NOT_VISIBLE', fields: NO_FIELDS, inputFields: [] };
      }
      onPress?.();
      log.push(button.text === '' ? '(icon)' : button.text);
      switch (button.onPress ?? 'NO_REQUEST') {
        case 'SENT':
          return observed(SENT);
        case 'AI_SENT':
          // AIW の 4: 押下で AI の送信（path の AI の語・流し続ける答え）が出た。
          aiSent = true;
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
        case 'SENT_NEXT_STATE':
          state = 1;
          return observed(SENT);
        case 'TOGGLE':
          state = state === 0 ? 1 : 0;
          return observed(NO_REQUEST);
        case 'UNUSABLE':
          unusable = true;
          return observed(NO_REQUEST);
        case 'LOSE_FREEZE':
          frozen = false;
          return observed(NO_REQUEST);
        case 'NEVER_RETURNS':
          return new Promise<PressOutcome>(() => undefined);
        default:
          return observed(NO_REQUEST);
      }
    },
  };
  return { port, log, checked, documentUnusable: (): boolean => unusable, surveying: (): boolean => surveying };
};

/** 偽の画面で押す輪を流し、記録の候補ごとの `<結果> <理由>`、押した順、作り直して押す候補を返す。 */
const probe = async (
  buttons: readonly FakeButton[],
  overrides: Partial<SubmissionProbeOptions> = {},
  pageOptions: Parameters<typeof fakePageOf>[1] = {},
) => {
  const page = fakePageOf(buttons, pageOptions);
  const location = pageOptions.location ?? LOCATION;
  const record: DiscoveryReadPageRecord = {
    location,
    incompleteReasons: [],
    candidates: buttons.filter((button) => (button.fromState ?? 0) === 0).map((button) => recordCandidateOf(button.text, location)),
  };
  const leftBehind: number[] = [];
  const probed = await probeDiscoveredSubmissionsWith(page.port, record, {
    targetPolicy: POLICY,
    onLeftBehind: (index) => leftBehind.push(index),
    documentUnusable: page.documentUnusable,
    ...overrides,
  });
  const results = probed.candidates.map(({ submissionProbe }) => `${String(submissionProbe?.result)} ${String(submissionProbe?.reason)}`);
  return { results, log: page.log, checked: page.checked, leftBehind, probed };
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
    // DEF-295（T-1）: 押す前に見えないので除いた対象は、見つからなかった（`TARGET_NOT_FOUND`）と分ける。
    expect(results).toEqual(['NO_REQUEST null', 'NO_REQUEST null', 'API_CREATE null', 'undefined undefined', 'NOT_OBSERVED TARGET_NOT_VISIBLE']);
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

  it('PREADY 2.2: does not send the target whose own readiness check failed to a reload for the hover residue', async () => {
    const { results, log, leftBehind } = await probe([{ text: '登録', onPress: 'NOT_READY_THEN_HIDDEN' }, { text: 'メニュー' }]);
    expect(log).toEqual(['メニュー']);
    expect(results[0]).toBe('NOT_OBSERVED TARGET_NOT_VISIBLE');
    expect(leftBehind).toEqual([]);
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

  // CALDAY（設計書 `2026-11-25-beaksight-discovery-sibling-press-design.md` 2.1）: 番号だけ違う同じ形の兄弟は、代表を押して違いが出なければ残りを押さない。
  it('CALDAY: presses only the first of the same-shaped siblings when it sent nothing and left the state, and all of them when the first sent a request', async () => {
    const quiet = await probe([{ text: '' }, { text: '' }, { text: '' }]);
    expect(quiet.log).toEqual(['(icon)']);
    expect(quiet.results).toEqual(['NO_REQUEST null', 'NOT_OBSERVED SAME_SHAPE_NO_CHANGE', 'NOT_OBSERVED SAME_SHAPE_NO_CHANGE']);
    expect(quiet.leftBehind).toEqual([]);

    const differs = await probe([{ text: '', onPress: 'SENT' }, { text: '' }, { text: '' }]);
    expect(differs.log).toEqual(['(icon)', '(icon)', '(icon)']);
  });

  // CALDAY fix round 1（設計者の判断 1）: 組の鍵に文字の型（数字だけを `{n}` にした型）を足す。文字の違うボタンは見えた違いなので、代表で済ませない。
  it('CALDAY fix round 1: keeps buttons of other texts apart, and groups only the buttons whose texts differ in the numbers', async () => {
    const apart = await probe([{ text: '前の月' }, { text: '次の月' }, { text: 'メニュー' }, { text: '' }, { text: 'ヘルプ' }, { text: 'お知らせ' }]);
    expect([...apart.log].sort()).toEqual(['(icon)', 'お知らせ', 'ヘルプ', 'メニュー', '前の月', '次の月'].sort());

    const days = await probe([{ text: '1' }, { text: '2' }, { text: '31' }]);
    expect(days.log).toEqual(['1']);
    expect(days.results.slice(1)).toEqual(['NOT_OBSERVED SAME_SHAPE_NO_CHANGE', 'NOT_OBSERVED SAME_SHAPE_NO_CHANGE']);
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

  it('DEF-289 案 5: gives a button that appeared hidden in a later state, and so was never pressed, the reason NOT_REACHED', async () => {
    const { results, log } = await probe([{ text: '保存', onPress: 'SENT_NEXT_STATE' }, { text: '登録', fromState: 1, hidden: true }]);

    expect(log).toEqual(['保存', '保存']);
    expect(results).toEqual(['API_CREATE null', 'NOT_OBSERVED NOT_REACHED']);
  });

  it('DEF-289 案 3: when the page watch ends during a press, gives the end reason to that target only and hands the rest over to press after a reload', async () => {
    const buttons: readonly FakeButton[] = [{ text: '保存', onPress: 'NEVER_RETURNS' }, { text: '登録', onPress: 'SENT' }];
    const page = fakePageOf(buttons);
    let snapshot: Parameters<NonNullable<SubmissionProbeOptions['onRecordSnapshot']>>[0] | undefined;
    void probeDiscoveredSubmissionsWith(page.port, { location: LOCATION, incompleteReasons: [], candidates: buttons.map((button) => recordCandidateOf(button.text)) }, {
      targetPolicy: POLICY, onRecordSnapshot: (taken) => { snapshot = taken; },
    });
    await vi.waitFor(() => expect(page.log).toEqual(['保存']));

    const ended = snapshot?.('STAGE_NEVER_QUIET');
    expect(ended?.record.candidates.map(({ submissionProbe }) => `${String(submissionProbe?.result)} ${String(submissionProbe?.reason)}`))
      .toEqual(['NOT_OBSERVED STAGE_NEVER_QUIET', 'NOT_OBSERVED PAGE_CHANGED']);
    expect([...(ended?.leftBehind ?? [])]).toEqual([[1, []]]);
  });

  it('DEF-295 案 3′: when the page watch ends while choosing an option outside a press, gives no target the end reason and hands all of them over to press after a reload', async () => {
    const buttons: readonly FakeButton[] = [{ text: '保存', onPress: 'SENT' }, { text: '登録', onPress: 'SENT' }];
    const page = fakePageOf(buttons, { surveyNeverReturns: true });
    let snapshot: Parameters<NonNullable<SubmissionProbeOptions['onRecordSnapshot']>>[0] | undefined;
    void probeDiscoveredSubmissionsWith(page.port, { location: LOCATION, incompleteReasons: [], candidates: buttons.map((button) => recordCandidateOf(button.text)) }, {
      targetPolicy: POLICY, onRecordSnapshot: (taken) => { snapshot = taken; }, onOptionStage: () => undefined,
    });
    await vi.waitFor(() => expect(page.surveying()).toBe(true));

    const ended = snapshot?.('STAGE_NEVER_QUIET');
    expect(ended?.record.candidates.map(({ submissionProbe }) => `${String(submissionProbe?.result)} ${String(submissionProbe?.reason)}`))
      .toEqual(['NOT_OBSERVED PAGE_CHANGED', 'NOT_OBSERVED PAGE_CHANGED']);
    expect([...(ended?.leftBehind ?? [])]).toEqual([[0, []], [1, []]]);
  });

  it('DEF-295（T-3）: when the state of a reloaded page cannot be rebuilt, gives the rest a reason apart from TARGET_NOT_FOUND', async () => {
    const { results, log } = await probe([{ text: '保存' }, { text: '登録' }], { replay: [{ index: 0, matchKey: 'gone', ordinal: 0 }] });

    expect(log).toEqual(['(replay)']);
    expect(results).toEqual(['NOT_OBSERVED STATE_NOT_REBUILT', 'NOT_OBSERVED STATE_NOT_REBUILT']);
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

  // PSKIP: データで構造の鍵が変わる、data を除いた path が同じ画面では、前の画面で押した候補を押し直さない（続きでも持ち越す）。
  it('PSKIP: does not press again on /x/2 the button pressed on /x/1, even after a continuation, and presses a button only /x/2 has and the same button on /y/1', async () => {
    const registry = new CoverageQueue();
    const save: FakeButton = { text: '保存', onPress: 'SENT' };
    expect((await probe([save], { pressRegistry: registry }, { location: { origin: SAMPLE_ORIGIN, path: '/x/1' }, screen: 'x1-' })).log).toEqual(['保存']);
    const continued = CoverageQueue.restore(JSON.parse(JSON.stringify(registry.snapshot())));

    const other = await probe([save, { text: '登録' }], { pressRegistry: continued }, { location: { origin: SAMPLE_ORIGIN, path: '/x/2' }, screen: 'x2-' });
    expect(other.log).toEqual(['登録']);
    expect(other.results[0]).toBe('NOT_OBSERVED SAME_STATE_PRESSED');
    expect((await probe([save], { pressRegistry: continued }, { location: { origin: SAMPLE_ORIGIN, path: '/y/1' }, screen: 'y1-' })).log).toEqual(['保存']);
  });

  // ISKIP: 入力の確かめ（打つだけの欄に目印を入れる・選択肢を選ぶ）は、欄ごとに 1 回（共通の枠の欄は path を問わず、ほかは data を除いた path ごと）。
  it('ISKIP: checks each input once per data-free path, a shared layout input once on any path, and a new or changed input again', async () => {
    const registry = new CoverageQueue();
    const at = (path: string, inputs: readonly FakeInput[], origin = SAMPLE_ORIGIN) =>
      probe([], { pressRegistry: registry, onOptionStage: () => undefined }, { location: { origin, path }, screen: path, inputs });
    const word: FakeInput = { kind: 'TEXT', name: 'word' };
    const kind: FakeInput = { kind: 'SELECT', name: 'kind', options: ['a', 'b'] };
    const menu: FakeInput = { kind: 'TEXT', name: 'menu', frame: 'side' };

    expect((await at('/x/1', [word, kind, menu])).checked).toEqual(['kind', 'word', 'menu']);
    expect((await at('/x/2', [word, kind, menu])).checked).toEqual([]);
    expect((await at('/x/3', [word, { ...kind, options: ['b', 'a'] }, { kind: 'TEXT', name: 'note' }, menu])).checked).toEqual(['kind', 'note']);
    expect((await at('/y/1', [word, menu])).checked).toEqual(['word']);
    // data を除いた path が求まらない画面は、画面の path ごと。
    expect((await at('/x/1', [word], 'not-a-url')).checked).toEqual(['word']);
    expect((await at('/x/2', [word], 'not-a-url')).checked).toEqual(['word']);
    expect((await at('/x/2', [word], 'not-a-url')).checked).toEqual([]);
  });
});

// AIW の 4: 押下で AI の送信が出た候補は、登録・更新を試せる形にせず、覚えて（続きでも）同じ識別の候補を押さず、状態の作り直しでも押さない。
describe('AIW: a press that made an AI request', () => {
  const ai: FakeButton = { text: '下書き', onPress: 'AI_SENT' };

  it('is not a create candidate, and is not pressed again on a later read after a continuation nor in a state rebuild', async () => {
    const registry = new CoverageQueue();
    const first = await probe([ai], { pressRegistry: registry }, { screen: 'a-' });
    expect(first.log).toEqual(['下書き']);
    expect(first.probed.candidates[0]?.submissionProbe).toMatchObject({ result: 'NOT_EXECUTABLE', reason: 'AI_GENERATION_REQUEST' });
    const continued = CoverageQueue.restore(JSON.parse(JSON.stringify(registry.snapshot())));

    const again = await probe([ai, { text: '保存' }], { pressRegistry: continued }, { screen: 'b-' });
    expect(again.log).toEqual(['保存']);
    expect(again.results[0]).toBe('NOT_OBSERVED AI_ACTION_SKIPPED');

    const matchKey = (await fakePageOf([ai]).port.readProbed(LOCATION))?.keys.match[0] ?? '';
    const rebuilt = await probe([ai, { text: '保存' }], { pressRegistry: continued, replay: [{ index: 0, matchKey, ordinal: 0 }] }, { screen: 'c-' });
    expect(rebuilt.log).toEqual([]);
    expect(rebuilt.results[1]).toBe('NOT_OBSERVED STATE_NOT_REBUILT');
  });
});

describe('PSKIP: pressReadyOf (the cover check before the readiness check)', () => {
  const WINDOW_MS = observationWindowsOrProduction(undefined).pageSettle.openDataRequestQuietMs;
  /** 準備の確かめ: 窓の長さを待ってから、覆われていたと返す（偽の時計）。届くなら、すぐ済む。 */
  /** hit-test は、見えないボタンも覆われていると返す（点の上にほかの要素がある）。 */
  const portOf = (hit: 'COVERED' | 'HIDDEN' | 'CORNER') => ({
    hit: async () => (hit === 'CORNER' ? { kind: 'REACHABLE' as const, position: { x: 1, y: 1 } } : { kind: 'COVERED' as const }),
    scrollTo: async () => true,
    role: 'SUBMITTER' as const,
    moving: async () => false,
    facts: async () => null,
    memo: { get: () => undefined, set: () => undefined },
    visible: async () => hit !== 'HIDDEN',
    readiness: (): Promise<{ readonly ready: true } | { readonly ready: false; readonly reason: 'COVERED_BY_OTHER' }> => (hit === 'CORNER'
      ? Promise.resolve({ ready: true })
      : new Promise((resolve) => { setTimeout(() => resolve({ ready: false, reason: 'COVERED_BY_OTHER' }), WINDOW_MS); })),
  });

  it('gives COVERED_BY_OTHER or TARGET_NOT_VISIBLE without waiting for the readiness window to a button covered even after scrolling, and readies a button reachable at a corner', async () => {
    vi.useFakeTimers();
    try {
      for (const [hit, reason] of [['COVERED', 'COVERED_BY_OTHER'], ['HIDDEN', 'TARGET_NOT_VISIBLE']] as const) {
        let ready: unknown;
        void pressReadyOf(portOf(hit)).then((given) => { ready = given; });
        // 窓の長さが過ぎる前に、答えが出ている。
        await vi.advanceTimersByTimeAsync(WINDOW_MS - 1);
        expect(ready, hit).toMatchObject({ ready: false, reason });
      }
    } finally {
      vi.useRealTimers();
    }
    expect(await pressReadyOf(portOf('CORNER'))).toMatchObject({ ready: true, position: { x: 1, y: 1 } });
  });

  /** PREADY: 届く対象（準備の確かめは、すぐ済まなかったと返す。呼んだ数を数える）。 */
  const reachableOf = (role: 'SUBMITTER' | 'RADIO', moving: boolean, facts: () => string) => {
    let kept: ReadinessMemoEntry | undefined;
    const port = {
      hit: async () => ({ kind: 'REACHABLE' as const, position: undefined }),
      scrollTo: async () => true,
      role,
      moving: async () => moving,
      visible: async () => true,
      checks: 0,
      readiness: async () => {
        port.checks += 1;
        return { ready: false as const, reason: 'TARGET_NOT_STABLE' as const };
      },
      facts: async () => facts(),
      memo: { get: () => kept, set: (entry: ReadinessMemoEntry | undefined) => { kept = entry; } },
    };
    return port;
  };

  it('PREADY 2.1: gives TARGET_NOT_STABLE to a moving radio without the readiness check', async () => {
    const port = reachableOf('RADIO', true, () => 'same');
    expect(await pressReadyOf(port)).toMatchObject({ ready: false, reason: 'TARGET_NOT_STABLE', hovered: false });
    expect(port.checks).toBe(0);
  });

  it('PREADY 2.2: checks a target that was not ready again only after one of its cheap facts changed', async () => {
    let facts = 'before';
    const port = reachableOf('SUBMITTER', false, () => facts);
    expect(await pressReadyOf(port)).toMatchObject({ ready: false, reason: 'TARGET_NOT_STABLE', hovered: true });
    expect(await pressReadyOf(port)).toMatchObject({ ready: false, reason: 'TARGET_NOT_STABLE', hovered: false });
    expect(port.checks).toBe(1);
    facts = 'after';
    await pressReadyOf(port);
    expect(port.checks).toBe(2);
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
