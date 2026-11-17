// 発見の入口（Task 27 の設計書 3 章、4.2。T27b）。ブラウザの部品（`tests/architecture/discovery-boundary.test.ts` の `BROWSER_DISCOVERY_FILES`）。
// 1 つの画面（Guard の付いた Passive の Context の、ただ 1 つの page）を、読むだけで調べる。次の順に行う。
// 1. 凍結の条件の確かめ（page が開いていて、Context の開いた page がそれだけで、URL が http(s) で、Guard が凍結の前の段階で準備ができている）。
//    満たされなければ、何も読まずに `INCOMPLETE_FREEZE_UNAVAILABLE`（候補 0 件）。凍結を呼ばないので、Guard は無効にならない。
// 2. 落ち着きの待ち（`settle.ts`。進行中の要求 0 が続き、2 回続けて同じ識別の digest の集合）。上限を超えたら `INCOMPLETE_SETTLE_TIMEOUT` を
//    付けて先へ進む。待ちの間に読み込みを足さない。
// 3. Interaction の凍結（`activateInteractionFreeze`。凍結の後は、ページの JS による送信も Guard が止める）。条件をもう一度確かめてから呼ぶ。
//    失敗したら（Guard が Context を無効にする。fail-closed）、読まずに `INCOMPLETE_FREEZE_UNAVAILABLE`。凍結は戻せないので、1 つの Context で
//    1 回だけ呼べる（呼ぶ側は、画面ごとに新しい Context を使う。設計書 4.2）。
// 4. probe（isolated world の 1 回の読み取り。`isolated-read.ts` の `readInIsolatedWorld`。DEF-087）→ JS の結び付き（CDP。main world の
//    objectId で読む。`listeners.ts`）→ T27a の分類（`classifyCandidate`）と指紋（`computeCandidateDigests`）。
//    読み取りが失敗したら、候補を出さずに `INCOMPLETE_READ_FAILED`。
// 5. OP-2 の修正の 1 回目（判断 2）: 候補を読めた画面は、画面の名前（最初の h1 の文字と title）を isolated world の 1 回の読み取りで読み、記録に足す
//    （`discoveryScreenNameOf` の形。標準の prototype の getter で読む。読めなければ足さない。候補・理由・判定は変えない）。
// 6. LU-11（設計書 `2026-11-02-beaksight-list-row-update-design.md` 5.4 の 4、D5。LU-11 fix round 1 の設計者の判断）: probe の後に、主な領域の行の位置を
//    isolated world の 1 回の読み取りで読み（行の決まりの owner `read-executor.ts` の `readListRowPaths`。値と文字は読まない）、フォームの候補に同じ行の
//    開き手（`rowOpener`）を結ぶ（`withRowOpeners`。行の決まりは `listRowOfFormPath`）。読めなければ結ばない（候補・理由・判定は変えない）。
//    OP-K（K1）: 1 の前に、SPA の見出しが後から描かれるのを、上限（`DISCOVERY_SCREEN_HEADING_WAIT_MS`）まで待つ（isolated world で読むだけ。読み込みは足さない）。
// L6/L3-1（設計書 `2026-11-09-beaksight-remove-limits-design.md` 5 の 1）: 凍結の後の読み取り（probe・JS の結び付き・行の位置・画面の名前）と Guard の準備の待ちは、
// 期限を置かない（`openEndedStageDeadline`）。固まった画面は、発見の流れの 1 画面の見張り（`screen-watch.ts`）が終える。L6/L3-1 の続き（T9）: 1 画面の見張りの中の落ち着きの待ちは、時間の上限でなく
// 子の見張りで終える（`waitForDiscoverySettledWatched`。終えたら `INCOMPLETE_SETTLE_TIMEOUT` を付けて候補を読む）。見張りの外は今の時間の上限のまま。
// 画面の記録は、成果物 `discovery.json`（T27d）の 1 画面分の形（純粋な部品 `discovery-result.ts` の `DiscoveryReadPageRecord`。型は 1 つ。
// PRE42-CC 組 5b。CC-070 (a)）: 画面の Origin と path（http(s) でなければ null）、読み切れなかった理由（重複なし、閉じた一覧の順）、候補（どの
// 候補にも、画面の理由を同じく付ける）。候補 0 件の不完全な画面も表せる。
import type { Page } from 'playwright';
import { composeInPage, type StandardReaders } from '../browser/in-page-readers.js';
import { awaitBeforeDeadline, wait } from '../core/deadline.js';
import { PRODUCTION_OBSERVATION_WINDOWS } from '../core/observation-windows.js';
import {
  activateInteractionFreeze,
  assertPassiveRequestGuardActive,
  awaitPassiveRequestGuardReady,
  passiveRequestGuardStageOf,
} from '../safety/passive-request-guard.js';
import {
  INCOMPLETE_REASONS,
  type CandidateJsBinding,
  type CandidateLocation,
  type DiscoveredCandidate,
  type DiscoveryCandidate,
  type IncompleteReason,
} from './candidate-contracts.js';
import { classifyCandidate, type CandidateClassificationPolicy } from './classify.js';
import { discoveryScreenNameOf, type DiscoveryReadPageRecord, type DiscoveryScreenName } from './discovery-result.js';
import { readInIsolatedWorld } from './isolated-read.js';
import { computeCandidateDigests, stateTemplateIdentityDigestOf } from './fingerprint.js';
import { readCandidateListeners } from './listeners.js';
import { locationOfUrl, probePageCandidates, type ProbedCandidate } from './probe.js';
import { isInsideListRow, listRowOfFormPath, readListRowPaths, type ListRowPath } from './read-executor.js';
import { isOpenerOnlySubmitter, submissionProbeOpenerOf } from './submission-probe-contracts.js';
import {
  InFlightRequestCounter, waitForDiscoverySettled, waitForDiscoverySettledWatched, type DiscoverySettlePolicy, DISCOVERY_SETTLE_POLICY,
} from './settle.js';
import { openReadDeadline } from '../orchestration/stage-deadline.js';
import { screenWatchOf, screenWatchQuietLimitOf, trackOnScreen } from './screen-watch.js';

/**
 * 凍結の後の読み取り（probe と、JS の結び付き）の、それぞれの時間の上限（ms）。L6/L3-1（設計書 `2026-11-09-beaksight-remove-limits-design.md` 5 の 1）:
 * 操作さがしの入口（`discoverPageCandidates`・`classifyProbedCandidates`）では使わない（読み取りは進んでいる間は待つ。固まった画面は 1 画面の見張り
 * `screen-watch.ts` が終える）。範囲の外の読み手（入口の確かめ・ログインの段の観察・書き込みの段）が、まだ使う（LZ-1 の報告: 残る期限）。
 */
export const DISCOVERY_READ_TIMEOUT_MS = 10_000;
/** 凍結の条件の確かめで、Guard の準備を待つ上限（ms）。L6/L3-1: 操作さがしの入口では使わない（`settleAndFreezePage` の既定にだけ残る）。 */
export const DISCOVERY_GUARD_READY_TIMEOUT_MS = 5_000;
/** 発見の入口の指定。 */
export interface DiscoverPageOptions {
  /** 分類の決まり（許可 Origin）。 */
  readonly classificationPolicy: CandidateClassificationPolicy;
  /**
   * 進行中の要求の数え方（画面を読み込む前に作ったもの）。省略すると、呼んだ時点から数える（それより前に始まった要求は数えられない）。
   * 渡したものは、呼ぶ側が `dispose` する。
   */
  readonly requestCounter?: InFlightRequestCounter | undefined;
  /** 落ち着きの待ちの指定（試験のための差し替え。本番は省略して `DISCOVERY_SETTLE_POLICY`）。 */
  readonly settlePolicy?: DiscoverySettlePolicy | undefined;
  /**
   * COV-2c（SREV-COV の C-1）: 凍結した Context で読み込んだ画面（操作さがしの押下から生まれた移り先。`BrowserContextFactory.loadFrozenDocument`）を、凍結を
   * 始めずに読む（凍結の段であることを確かめ、落ち着きを待ってから読む）。凍結の段でなければ読まない（`INCOMPLETE_FREEZE_UNAVAILABLE`）。省略すると今どおり凍結する。
   */
  readonly alreadyFrozen?: true | undefined;
}

/** 画面の名前の、ページの中で読む文字の長さの上限（記録の上限より長めに読み、Node の側で形を整える）。 */
const SCREEN_NAME_READ_LENGTH = 1_000;

/**
 * OP-2 の修正の 1 回目（判断 2）: ページの中で動く、画面の名前の読み取り（isolated world。外の値を参照しない）。部品（`R`。`src/browser/in-page-readers.ts`。CC-068）の
 * 標準の prototype の getter とメソッドで、最初の h1 の文字と、題（title）を読む（DOM clobbering を受けない）。
 */
function screenNameReader(R: StandardReaders, maxLength: number): unknown {
  const textOf = (value: unknown): string | null => (typeof value === 'string' ? value.slice(0, maxLength) : null);
  const heading = Document.prototype.querySelector.call(document, 'h1');
  return {
    heading: heading === null ? null : textOf(R.standardProperty(Node.prototype, 'textContent', heading)),
    title: textOf(R.documentProperty('title')),
  };
}
const screenNameInPage = composeInPage(screenNameReader);

/**
 * OP-K（K1。設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1 の指示書 OP-K）: SPA の見出し（h1）が後から描かれるのを、凍結の前に待つ時間の上限（ms）と、
 * 確かめる間隔（ms）。見出しのない画面は、この上限だけ待って先へ進む。読み込みは足さない（今の読み込みの中で、isolated world で読むだけ）。
 * RB-2: 値は観察の窓の一式（`screenHeading`）の本番の値。
 */
export const DISCOVERY_SCREEN_HEADING_WAIT_MS = PRODUCTION_OBSERVATION_WINDOWS.screenHeading.waitMs;
export const DISCOVERY_SCREEN_HEADING_POLL_MS = PRODUCTION_OBSERVATION_WINDOWS.screenHeading.pollMs;

/** 画面の名前を読む（読めなければ null。例外を投げない）。`deadlineAtMs` は読み取りの期限（L6/L3-1: 省略は期限を置かない）。 */
const readScreenName = async (page: Page, deadlineAtMs: number = openReadDeadline()): Promise<DiscoveryScreenName | null> => {
  const outcome = await readInIsolatedWorld(page, screenNameInPage, SCREEN_NAME_READ_LENGTH, deadlineAtMs);
  if (outcome.status !== 'READ' || typeof outcome.value !== 'object' || outcome.value === null) {
    return null;
  }
  const { heading, title } = outcome.value as Record<string, unknown>;
  return discoveryScreenNameOf(heading, title);
};

/**
 * OP-K（K1）: 見出し（h1 の文字。`discoveryScreenNameOf` で空・秘密に見える文でないもの）が見えるまで、`DISCOVERY_SCREEN_HEADING_WAIT_MS` を上限に待つ（凍結の前。
 * ページを操作しない。読めない・閉じたときは待たない）。例外を投げない。
 */
const waitForScreenHeading = async (page: Page): Promise<void> => {
  const deadlineAtMs = Date.now() + DISCOVERY_SCREEN_HEADING_WAIT_MS;
  for (;;) {
    if (page.isClosed()) {
      return;
    }
    const name = await readScreenName(page, deadlineAtMs);
    if (name === null || name.heading !== null || Date.now() + DISCOVERY_SCREEN_HEADING_POLL_MS >= deadlineAtMs) {
      return;
    }
    await wait(DISCOVERY_SCREEN_HEADING_POLL_MS);
  }
};

/** 結び付きの記録の空の値（落ち着きの待ちの digest の計算に使う。識別の digest は結び付きを含まない）。 */
const NO_JS_BINDING: CandidateJsBinding = Object.freeze({
  form: [], submitter: [], ancestor: [], document: [], window: [], inlineHandler: false,
});

/** 理由を、重複なく、閉じた一覧の順に並べる。 */
const orderedReasons = (reasons: ReadonlySet<IncompleteReason>): readonly IncompleteReason[] =>
  INCOMPLETE_REASONS.filter((reason) => reasons.has(reason));

const pageRecord = (
  location: CandidateLocation | null,
  reasons: ReadonlySet<IncompleteReason>,
  candidates: readonly DiscoveryCandidate[],
): DiscoveryReadPageRecord => Object.freeze({ location, incompleteReasons: orderedReasons(reasons), candidates: Object.freeze([...candidates]) });

/** page の URL の画面（http(s) でなければ null）。 */
const pageLocationOf = (page: Page): CandidateLocation | null => {
  const { location, url } = locationOfUrl(page.url());
  return url === null ? null : location;
};

/** probe の候補を、契約の形（結び付きと理由つき）にする。 */
const discoveredOf = (
  location: CandidateLocation,
  probed: ProbedCandidate,
  jsBinding: CandidateJsBinding,
  incompleteReasons: readonly IncompleteReason[],
): DiscoveredCandidate => ({
  page: location,
  kind: probed.kind,
  formMethod: probed.formMethod,
  methodOverride: probed.methodOverride,
  action: probed.action,
  enctype: probed.enctype,
  target: probed.target,
  fields: probed.fields,
  submitterWords: probed.submitterWords,
  jsBinding,
  incompleteReasons,
});

/**
 * probe の候補の識別の digest（結び付きと理由を除いた形で求める。識別の digest は結び付きと理由を含まないので、分類した候補の digest と同じ値）。
 * 落ち着きの待ちの digest の集合と、T37c の送らずに観察する probe の押す前の読み直し（`src/interaction/submission-probe.ts`。同じ候補を探す）が使う。
 */
export const probedCandidateIdentityDigestOf = (location: CandidateLocation, probed: ProbedCandidate): string =>
  computeCandidateDigests(discoveredOf(location, probed, NO_JS_BINDING, [])).identityDigest;

/**
 * COV-2: probe の候補の、状態の型にした識別の digest（`stateTemplateIdentityDigestOf`。番号だけ違う同じ作りの画面の候補で同じ）。送らずに観察する probe が、
 * 状態の構造の鍵と、押す組の鍵に使う（識別の digest は変えない）。
 */
export const probedCandidateStateTemplateDigestOf = (location: CandidateLocation, probed: ProbedCandidate): string =>
  stateTemplateIdentityDigestOf(discoveredOf(location, probed, NO_JS_BINDING, []));

/**
 * L10 の調べの直し（唯一の判定）: 読む文書が消えたか（page が閉じた・場所がない。止めた移動で誤りの画面 `chrome-error://` に替わったときを含む）。落ち着きの待ち
 * と、押す部品が、その文書を使うのをやめる判定に使う。
 */
export const documentGoneOf = (page: Page): boolean => page.isClosed() || pageLocationOf(page) === null;

/**
 * 凍結の条件（`activateInteractionFreeze` の条件と同じ: page がただ 1 つの開いた page で、読み込みの済んだ http(s) の URL で、Guard の準備が
 * でき、凍結の前の段階）。確かめるだけで、ページにも Guard にも何もしない（例外を投げない）。CC-099（T37c fix round 1）: 公開した（落ち着きと凍結の
 * 部品 `settleAndFreezePage` が使う）。
 */
export const freezeConditionsHold = async (
  page: Page,
  /** L6/L3-1: Guard の準備を待つ期限（省略は今から `DISCOVERY_GUARD_READY_TIMEOUT_MS`。操作さがしの入口は期限を置かない値を渡す）。 */
  guardReadyDeadlineAtMs: number = Date.now() + DISCOVERY_GUARD_READY_TIMEOUT_MS,
): Promise<boolean> => {
  if (page.isClosed()) {
    return false;
  }
  const context = page.context();
  const openPages = context.pages().filter((candidate) => !candidate.isClosed());
  if (openPages.length !== 1 || openPages[0] !== page || pageLocationOf(page) === null) {
    return false;
  }
  try {
    assertPassiveRequestGuardActive(context);
  } catch {
    return false;
  }
  // 凍結の後の段階では、準備の確かめが失敗する（凍結を 2 回呼ばない）。
  const ready = await awaitBeforeDeadline(trackOnScreen(page, awaitPassiveRequestGuardReady(page)), guardReadyDeadlineAtMs);
  return ready.status === 'FULFILLED';
};

/**
 * COV-2c（C-1）: 凍結した Context で読み込んだ画面を読む条件（page がただ 1 つの開いた page で、http(s) の場所があり、Guard が凍結の段）。確かめるだけ。
 */
const frozenConditionsHold = (page: Page): boolean => {
  if (page.isClosed()) {
    return false;
  }
  const openPages = page.context().pages().filter((candidate) => !candidate.isClosed());
  try {
    return openPages.length === 1 && openPages[0] === page && pageLocationOf(page) !== null && passiveRequestGuardStageOf(page) === 'FROZEN_ACTIVE';
  } catch {
    return false;
  }
};

/**
 * 落ち着きと凍結の結果（CC-099）。`FROZEN` は凍結した（`location` は凍結の時点の画面）。`UNAVAILABLE` は凍結の条件が満たされない・凍結が失敗した
 * （`reasons` に `INCOMPLETE_FREEZE_UNAVAILABLE`。何も読まない）。どちらも、落ち着きの時間切れなら `INCOMPLETE_SETTLE_TIMEOUT` を持つ。
 */
export type SettledFreezeOutcome =
  | { readonly status: 'FROZEN'; readonly location: CandidateLocation; readonly reasons: ReadonlySet<IncompleteReason> }
  | { readonly status: 'UNAVAILABLE'; readonly location: CandidateLocation | null; readonly reasons: ReadonlySet<IncompleteReason> };

/**
 * 落ち着きの待ちと凍結だけを行う（ファイルの先頭の 1〜3。CC-099（T37c fix round 1）で `discoverPageCandidates` から切り出した。振る舞いは変えない）。
 * 凍結の後の読み取り（probe と JS の結び付き）はしない。入口の確かめ（`src/worker/entry-check-page.ts`）は、候補を読まずに、これだけを使う。例外を
 * 投げない。
 */
export async function settleAndFreezePage(
  page: Page,
  options: Pick<DiscoverPageOptions, 'requestCounter' | 'settlePolicy' | 'alreadyFrozen'>,
  /** L6/L3-1: Guard の準備を待つ期限の決め方（省略は `freezeConditionsHold` の既定。操作さがしの入口は期限を置かない）。 */
  guardReadyDeadlineAtMs?: () => number,
): Promise<SettledFreezeOutcome> {
  const reasons = new Set<IncompleteReason>();
  // COV-2c（C-1）: 凍結した Context で読み込んだ画面は、凍結を始めない（凍結の段で、ただ 1 つの page であることを確かめる）。
  const holds = options.alreadyFrozen === true
    ? (): Promise<boolean> => Promise.resolve(frozenConditionsHold(page))
    : (): Promise<boolean> => freezeConditionsHold(page, guardReadyDeadlineAtMs?.());
  if (!(await holds())) {
    reasons.add('INCOMPLETE_FREEZE_UNAVAILABLE');
    return { status: 'UNAVAILABLE', location: page.isClosed() ? null : pageLocationOf(page), reasons };
  }

  const counter = options.requestCounter ?? new InFlightRequestCounter(page);
  try {
    const readCandidateSet = async (deadlineAtMs: number): Promise<readonly string[] | null> => {
      const location = pageLocationOf(page);
      const probe = await probePageCandidates(page, deadlineAtMs);
      if (location === null || probe.status !== 'READ') {
        return null;
      }
      return probe.candidates.map((probed) => probedCandidateIdentityDigestOf(location, probed));
    };
    const policy = options.settlePolicy ?? DISCOVERY_SETTLE_POLICY;
    // L6/L3-1 の続き（T9。設計者の判断 2026-11-10 の案 A）: 操作さがしの 1 画面の見張りの中では、時間の上限でなく、子の見張り（1 画面の見張りと同じ長さ）で
    // 待ちだけを終える（新しい候補の集合が出る間は待つ）。見張りの外（入口の確かめ・ログインの段の観察）は、今の時間の上限のまま（LZ-1 の報告: 残る期限）。
    // L10 の調べの直し: 読む文書が消えたら（閉じた・止めた移動で誤りの画面 `chrome-error://` に替わった。場所がない）、待たずに待ちを終える（下の確かめで
    // `INCOMPLETE_FREEZE_UNAVAILABLE`。DEF-242 と同じ事実）。待ちが続く間に Chromium が page を閉じると、Guard が印のない閉じとして止める。
    const documentGone = (): boolean => documentGoneOf(page);
    const settled = screenWatchOf(page) === undefined
      ? await waitForDiscoverySettled(counter, readCandidateSet, policy, undefined, documentGone)
      : await waitForDiscoverySettledWatched(counter, readCandidateSet, policy, { quietLimitMs: screenWatchQuietLimitOf(page), documentGone });
    if (settled.status === 'TIMED_OUT') {
      reasons.add('INCOMPLETE_SETTLE_TIMEOUT');
    }
  } finally {
    if (options.requestCounter === undefined) {
      counter.dispose();
    }
  }

  const location = pageLocationOf(page);
  if (location === null || !(await holds())) {
    reasons.add('INCOMPLETE_FREEZE_UNAVAILABLE');
    return { status: 'UNAVAILABLE', location, reasons };
  }
  if (options.alreadyFrozen === true) {
    return { status: 'FROZEN', location, reasons };
  }
  try {
    await trackOnScreen(page, activateInteractionFreeze(page));
  } catch {
    // Guard は、条件が満たされない凍結を違反として記録し、Context を無効にする（fail-closed）。読まない。
    reasons.add('INCOMPLETE_FREEZE_UNAVAILABLE');
    return { status: 'UNAVAILABLE', location, reasons };
  }
  return { status: 'FROZEN', location, reasons };
}

/** LU-4: JS の結び付きの読み取りで分かった、画面の読み切れなさの事実（候補の理由を決めるため）。 */
export interface ProbedCandidateListenerFacts {
  readonly frameFound: boolean;
  readonly closedShadowRootFound: boolean;
}

/**
 * LU-SFIX1 fix round 2（LU-SREV1 の Minor-4 の共通化）: probe の読み取りと JS の結び付きの読み取りで分かった事実から、候補の読み切れなさの理由を足した一覧
 * （閉じた一覧の順。純粋な判定の唯一の置き場所。`page` は frame の数だけを見る）。`base`（すでに分かっている理由）に、別の文書の要素・閉じた shadow root・page の
 * frame が 2 つ以上なら `INCOMPLETE_FRAME_OR_CLOSED_SHADOW` を足す。発見の入口（`discoverPageCandidates`）と、
 * probe の押下の後に開いた窓の中の候補（`src/interaction/submission-probe.ts`）の両方が使う。
 */
export const probedIncompleteReasonsOf = (
  page: Page,
  base: Iterable<IncompleteReason>,
  probe: { readonly frameFound: boolean },
  found: ProbedCandidateListenerFacts,
): readonly IncompleteReason[] => {
  const reasons = new Set<IncompleteReason>(base);
  if (probe.frameFound || found.frameFound || found.closedShadowRootFound || page.frames().length > 1) {
    reasons.add('INCOMPLETE_FRAME_OR_CLOSED_SHADOW');
  }
  // L13（N28〜N30）: probe は数と長さで読み切れないことがなくなったので、`INCOMPLETE_LIMIT_REACHED` は足さない（理由の値は前の記録の読み方のために残す）。
  return orderedReasons(reasons);
};

/**
 * 凍結の後の読み取り（probe の候補）に、JS の結び付き（CDP。`listeners.ts`）を読み、T27a の分類（`classifyCandidate`）と指紋（`computeCandidateDigests`）を
 * 付けた候補にする（候補の順は probe の順）。どの候補にも、`incompleteReasonsOf`（結び付きの読み取りの事実から、画面の理由を決める）の理由を付ける。
 * 結び付きを読めない・件数が合わないときは null（候補を出さない。fail-closed）。LU-4（設計書 `2026-11-02-beaksight-list-row-update-design.md` の K6）:
 * 発見の入口（`discoverPageCandidates`）と、probe の押下の後の読み直し（`src/interaction/submission-probe.ts`。押した後に開いた窓の中の新しいボタン）の
 * 両方が使う唯一の組み立て。
 */
export async function classifyProbedCandidates(
  page: Page,
  location: CandidateLocation,
  probed: readonly ProbedCandidate[],
  policy: CandidateClassificationPolicy,
  incompleteReasonsOf: (facts: ProbedCandidateListenerFacts) => readonly IncompleteReason[],
): Promise<readonly DiscoveryCandidate[] | null> {
  const listeners = await readCandidateListeners(
    page,
    probed.map(({ form, submitter }) => ({ form, submitter })),
    // L6/L3-1: 期限を置かない（固まった画面は 1 画面の見張りが終える）。
    openReadDeadline(),
  );
  if (listeners.status !== 'READ' || listeners.candidates.length !== probed.length) {
    return null;
  }
  const incompleteReasons = incompleteReasonsOf({ frameFound: listeners.frameFound, closedShadowRootFound: listeners.closedShadowRootFound });
  const candidates: DiscoveryCandidate[] = [];
  for (const [index, candidate] of probed.entries()) {
    const kinds = listeners.candidates[index];
    if (kinds === undefined) {
      // 件数は上で確かめているので、ここには来ない。来たら、結び付きの分からない候補を出さない（fail-closed）。
      return null;
    }
    const discovered = discoveredOf(location, candidate, {
      form: kinds.form,
      submitter: kinds.submitter,
      ancestor: kinds.ancestor,
      document: listeners.document,
      window: listeners.window,
      inlineHandler: candidate.inlineHandler,
    }, incompleteReasons);
    candidates.push(Object.freeze({
      ...discovered,
      ...classifyCandidate(discovered, policy),
      ...computeCandidateDigests(discovered),
    }));
  }
  return candidates;
}

/**
 * LU-11: 開き手のボタンの候補か（`BUTTON` で、名前（見える文字・`aria-label`・`title`）があり、送信ボタンの語が開き手の語を持ち、登録の語と削除の語を持たない
 * `isOpenerOnlySubmitter`）。
 */
const isNamedOpener = (probed: ProbedCandidate): boolean =>
  probed.kind === 'BUTTON' && probed.hasSubmitterText && probed.submitter !== null && isOpenerOnlySubmitter(probed.submitterWords);

/**
 * LU-11（設計書 5.4 の 4、D5。LU-11 fix round 1）: フォームの候補に、同じ行の開き手（`rowOpener`）を結んだ写し（純粋。順と、ほかの候補は変えない）。行は
 * 行の決まりの owner の `listRowOfFormPath`（フォームを含む行か、行の下に広がる隠れた行のすぐ前の行）。その行の中の開き手（`isNamedOpener`）がちょうど 1 つの
 * ときだけ結ぶ（0 か 2 以上なら推さない）。`candidates` と `probed` は同じ順の同じ数（違えば結ばない）。行の位置が読めない（null）ときも結ばない。
 */
export const withRowOpeners = (
  candidates: readonly DiscoveryCandidate[],
  probed: readonly ProbedCandidate[],
  rows: readonly ListRowPath[] | null,
): readonly DiscoveryCandidate[] => {
  if (rows === null || rows.length === 0 || candidates.length !== probed.length) {
    return candidates;
  }
  const openers = probed.flatMap((item, index) => {
    const candidate = candidates[index];
    return isNamedOpener(item) && item.submitter !== null && candidate !== undefined
      ? [{ path: item.submitter.path, opener: submissionProbeOpenerOf(candidate.identityDigest, true, item.submitterWords) }]
      : [];
  });
  if (openers.length === 0) {
    return candidates;
  }
  const openersIn = (row: ListRowPath) => openers.filter(({ path }) => isInsideListRow(row, path));
  return candidates.map((candidate, index) => {
    const form = probed[index]?.form ?? null;
    if (candidate.kind !== 'FORM' || form === null) {
      return candidate;
    }
    const row = listRowOfFormPath(rows, form.path, (other) => openersIn(other).length > 0);
    const found = row === null ? [] : openersIn(row);
    const [only] = found;
    return found.length === 1 && only !== undefined ? Object.freeze({ ...candidate, rowOpener: only.opener }) : candidate;
  });
};

/** 欄の形（名前・tag・type）が、並びも含めて同じか。 */
const sameFieldShapes = (left: readonly DiscoveryCandidate['fields'][number][], right: readonly DiscoveryCandidate['fields'][number][]): boolean =>
  left.length === right.length && left.every((field, index) => {
    const other = right[index];
    return other !== undefined && other.name === field.name && other.tag === field.tag && other.type === field.type;
  });

/** 見えていない（hidden の型でない）欄が、押した後に見えるようになったか。 */
const revealsField = (before: readonly DiscoveryCandidate['fields'][number][], after: readonly DiscoveryCandidate['fields'][number][]): boolean =>
  before.some((field, index) => field.type !== 'hidden' && field.hidden && after[index]?.hidden === false);

/**
 * LU-11 fix round 2（設計者の判断。選択肢 1）: 開き手を押した後の読み直し（`reread`。probe の読み直しの候補）で、その開き手に `rowOpener` として結ばれたフォームの
 * 候補のうち、欄が見えるようになったものの欄の見え方（`hidden`）だけを記録し直した写し（純粋。順と、ほかの候補は変えない）。
 * - 対象: 開き手の識別の digest が `openerIdentityDigest` の `rowOpener` を持つ `FORM` の候補で、読み直しに同じ識別の digest の `FORM` の候補がちょうど 1 つあり、
 *   欄の名前・tag・type が並びも含めて同じで、見えていなかった（hidden の型でない）欄が見えるようになったもの。そうしたフォームがちょうど 1 つのときだけ
 *   （押した行のフォーム。2 つ以上なら、どれが押した行か分からないので記録し直さない）。
 * - 記録し直すのは欄の `hidden` だけ。識別の digest は同じであることを確かめ、規則の digest は押した後の形で求め直す。違えば今のまま。
 */
export const withRevealedRowFormFields = (
  candidates: readonly DiscoveryCandidate[],
  location: CandidateLocation,
  openerIdentityDigest: string,
  reread: readonly ProbedCandidate[],
): readonly DiscoveryCandidate[] => {
  const revealed = candidates.flatMap((candidate, index) => {
    if (candidate.kind !== 'FORM' || candidate.rowOpener?.identityDigest !== openerIdentityDigest) {
      return [];
    }
    const matches = reread.filter((probed) => probed.kind === 'FORM' && probedCandidateIdentityDigestOf(location, probed) === candidate.identityDigest);
    const [only] = matches;
    return matches.length === 1 && only !== undefined && sameFieldShapes(candidate.fields, only.fields) && revealsField(candidate.fields, only.fields)
      ? [{ index, fields: only.fields }]
      : [];
  });
  const [target] = revealed;
  if (revealed.length !== 1 || target === undefined) {
    return candidates;
  }
  return candidates.map((candidate, index) => {
    if (index !== target.index) {
      return candidate;
    }
    const fields = Object.freeze(candidate.fields.map((field, position) => Object.freeze({ ...field, hidden: target.fields[position]?.hidden ?? field.hidden })));
    const digests = computeCandidateDigests({ ...candidate, fields });
    return digests.identityDigest === candidate.identityDigest
      ? Object.freeze({ ...candidate, fields, ruleDigest: digests.ruleDigest })
      : candidate;
  });
};

/**
 * 1 つの画面の候補を、読むだけで見つける（例外を投げない）。ページを操作しない。凍結の後に読む。
 */
export async function discoverPageCandidates(page: Page, options: DiscoverPageOptions): Promise<DiscoveryReadPageRecord> {
  // OP-K（K1）: SPA の見出しが後から描かれるのを、凍結の前に、上限まで待つ（凍結の後は、ページの JS が描かない）。
  await waitForScreenHeading(page);
  // L6/L3-1: 凍結の後の読み取りと Guard の準備の待ちは、期限を置かない（固まった画面は 1 画面の見張り `screen-watch.ts` が終える）。
  const frozen = await settleAndFreezePage(page, options, openReadDeadline);
  const reasons = new Set<IncompleteReason>(frozen.reasons);
  if (frozen.status !== 'FROZEN') {
    return pageRecord(frozen.location, reasons, []);
  }
  const { location } = frozen;

  const probe = await probePageCandidates(page, openReadDeadline());
  if (probe.status !== 'READ') {
    reasons.add('INCOMPLETE_READ_FAILED');
    return pageRecord(location, reasons, []);
  }
  const candidates = await classifyProbedCandidates(page, location, probe.candidates, options.classificationPolicy, (found) => {
    // LU-SFIX1 fix round 2: 理由の付け方は `probedIncompleteReasonsOf` の 1 か所（画面の記録の理由にも足す。今のまま）。
    const next = probedIncompleteReasonsOf(page, reasons, probe, found);
    for (const reason of next) reasons.add(reason);
    return next;
  });
  if (candidates === null) {
    reasons.add('INCOMPLETE_READ_FAILED');
    return pageRecord(location, reasons, []);
  }
  // LU-11: フォームの候補に、同じ行の開き手を結ぶ（行の位置が読めなければ結ばない）。
  // L6/L3-1: 1 画面の見張りの中では、行の位置の読み取りは自分で見張らず、その口を使う。
  const rowPaths = await readListRowPaths(page, openReadDeadline(), { progress: screenWatchOf(page) });
  const linked = withRowOpeners(candidates, probe.candidates, rowPaths.status === 'READ' ? rowPaths.rows : null);
  const screenName = await readScreenName(page);
  const record = pageRecord(location, reasons, linked);
  return screenName === null ? record : Object.freeze({ ...record, screenName });
}
