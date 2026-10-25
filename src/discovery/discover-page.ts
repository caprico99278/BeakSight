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
// 画面の記録は、成果物 `discovery.json`（T27d）の 1 画面分の形（純粋な部品 `discovery-result.ts` の `DiscoveryReadPageRecord`。型は 1 つ。
// PRE42-CC 組 5b。CC-070 (a)）: 画面の Origin と path（http(s) でなければ null）、読み切れなかった理由（重複なし、閉じた一覧の順）、候補（どの
// 候補にも、画面の理由を同じく付ける）。候補 0 件の不完全な画面も表せる。
import type { Page } from 'playwright';
import { awaitBeforeDeadline } from '../core/deadline.js';
import {
  activateInteractionFreeze,
  assertPassiveRequestGuardActive,
  awaitPassiveRequestGuardReady,
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
import type { DiscoveryReadPageRecord } from './discovery-result.js';
import { computeCandidateDigests } from './fingerprint.js';
import { readCandidateListeners } from './listeners.js';
import { locationOfUrl, probePageCandidates, type ProbedCandidate } from './probe.js';
import { InFlightRequestCounter, waitForDiscoverySettled, type DiscoverySettlePolicy, DISCOVERY_SETTLE_POLICY } from './settle.js';

/** 凍結の後の読み取り（probe と、JS の結び付き）の、それぞれの時間の上限（ms）。 */
export const DISCOVERY_READ_TIMEOUT_MS = 10_000;
/** 凍結の条件の確かめで、Guard の準備を待つ上限（ms）。 */
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
}

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
 * 凍結の条件（`activateInteractionFreeze` の条件と同じ: page がただ 1 つの開いた page で、読み込みの済んだ http(s) の URL で、Guard の準備が
 * でき、凍結の前の段階）。確かめるだけで、ページにも Guard にも何もしない（例外を投げない）。CC-099（T37c fix round 1）: 公開した（落ち着きと凍結の
 * 部品 `settleAndFreezePage` が使う）。
 */
export const freezeConditionsHold = async (page: Page): Promise<boolean> => {
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
  const ready = await awaitBeforeDeadline(awaitPassiveRequestGuardReady(page), Date.now() + DISCOVERY_GUARD_READY_TIMEOUT_MS);
  return ready.status === 'FULFILLED';
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
  options: Pick<DiscoverPageOptions, 'requestCounter' | 'settlePolicy'>,
): Promise<SettledFreezeOutcome> {
  const reasons = new Set<IncompleteReason>();
  if (!(await freezeConditionsHold(page))) {
    reasons.add('INCOMPLETE_FREEZE_UNAVAILABLE');
    return { status: 'UNAVAILABLE', location: page.isClosed() ? null : pageLocationOf(page), reasons };
  }

  const counter = options.requestCounter ?? new InFlightRequestCounter(page);
  try {
    const settled = await waitForDiscoverySettled(counter, async (deadlineAtMs) => {
      const location = pageLocationOf(page);
      const probe = await probePageCandidates(page, deadlineAtMs);
      if (location === null || probe.status !== 'READ') {
        return null;
      }
      return probe.candidates.map((probed) => probedCandidateIdentityDigestOf(location, probed));
    }, options.settlePolicy ?? DISCOVERY_SETTLE_POLICY);
    if (settled.status === 'TIMED_OUT') {
      reasons.add('INCOMPLETE_SETTLE_TIMEOUT');
    }
  } finally {
    if (options.requestCounter === undefined) {
      counter.dispose();
    }
  }

  const location = pageLocationOf(page);
  if (location === null || !(await freezeConditionsHold(page))) {
    reasons.add('INCOMPLETE_FREEZE_UNAVAILABLE');
    return { status: 'UNAVAILABLE', location, reasons };
  }
  try {
    await activateInteractionFreeze(page);
  } catch {
    // Guard は、条件が満たされない凍結を違反として記録し、Context を無効にする（fail-closed）。読まない。
    reasons.add('INCOMPLETE_FREEZE_UNAVAILABLE');
    return { status: 'UNAVAILABLE', location, reasons };
  }
  return { status: 'FROZEN', location, reasons };
}

/**
 * 1 つの画面の候補を、読むだけで見つける（例外を投げない）。ページを操作しない。凍結の後に読む。
 */
export async function discoverPageCandidates(page: Page, options: DiscoverPageOptions): Promise<DiscoveryReadPageRecord> {
  const frozen = await settleAndFreezePage(page, options);
  const reasons = new Set<IncompleteReason>(frozen.reasons);
  if (frozen.status !== 'FROZEN') {
    return pageRecord(frozen.location, reasons, []);
  }
  const { location } = frozen;

  const probe = await probePageCandidates(page, Date.now() + DISCOVERY_READ_TIMEOUT_MS);
  if (probe.status !== 'READ') {
    reasons.add('INCOMPLETE_READ_FAILED');
    return pageRecord(location, reasons, []);
  }
  const listeners = await readCandidateListeners(
    page,
    probe.candidates.map(({ form, submitter }) => ({ form, submitter })),
    Date.now() + DISCOVERY_READ_TIMEOUT_MS,
  );
  if (listeners.status !== 'READ' || listeners.candidates.length !== probe.candidates.length) {
    reasons.add('INCOMPLETE_READ_FAILED');
    return pageRecord(location, reasons, []);
  }
  if (probe.frameFound || listeners.frameFound || listeners.closedShadowRootFound || page.frames().length > 1) {
    reasons.add('INCOMPLETE_FRAME_OR_CLOSED_SHADOW');
  }
  if (probe.limitReached) {
    reasons.add('INCOMPLETE_LIMIT_REACHED');
  }
  const incompleteReasons = orderedReasons(reasons);
  const candidates: DiscoveryCandidate[] = [];
  for (const [index, probed] of probe.candidates.entries()) {
    const kinds = listeners.candidates[index];
    if (kinds === undefined) {
      // 件数は上で確かめているので、ここには来ない。来たら、結び付きの分からない候補を出さない（fail-closed）。
      reasons.add('INCOMPLETE_READ_FAILED');
      return pageRecord(location, reasons, []);
    }
    const discovered = discoveredOf(location, probed, {
      form: kinds.form,
      submitter: kinds.submitter,
      ancestor: kinds.ancestor,
      document: listeners.document,
      window: listeners.window,
      inlineHandler: probed.inlineHandler,
    }, incompleteReasons);
    candidates.push(Object.freeze({
      ...discovered,
      ...classifyCandidate(discovered, options.classificationPolicy),
      ...computeCandidateDigests(discovered),
    }));
  }
  return pageRecord(location, reasons, candidates);
}
