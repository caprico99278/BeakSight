/**
 * PageAuditor の段の順（RB-10。再構築の設計書 2 章 1・3 章）。次の読み込み（ビューポート・幅の走査の幅・Interaction の候補）を始めない条件の順と、閉じる前に
 * 前の画面を見せたまま待つかを、ここだけで決める。ページには触れない。
 * - 違反の確かめ（`violationRecorded`）は、止めたことを記録する。時刻の読み（`runTimeLimitPassed`）とセッションの切れの確かめも、呼ぶ時点に意味がある。
 *   そのため関数で受け、決まった順に呼び、当たったら後のものを呼ばない（前の if の並びと同じ呼び方）。
 * - 始めない条件に当たった読み込みでは、読み込みの間隔の待ち（`beforeNavigation`）を呼ばない（DEF-209）。呼ぶ側は、この関数の答えを見てから待つ。
 */
import type { EvidenceType, IncompleteReason, IncompleteReasonCode, PageAuditResult, PageAuditStage, PageId, ViewportProfile } from '../core/contracts.js';
import { isRunTimeLimitReason } from './resume-revisit.js';
import { AUTH_SESSION_LOST_SKIP_REASON } from './authenticated-run.js';
import { SITE_UNAVAILABLE_SKIP_REASON } from './site-availability.js';

/** 違反を検出したため、始めなかったページとビューポートの理由（`detail` は `null`。C18f）。Run Coordinator も使う。 */
export const SAFETY_VIOLATION_ABORT_REASON: IncompleteReason = Object.freeze({ code: 'SAFETY_VIOLATION_ABORT' satisfies IncompleteReasonCode, detail: null });

/** L0: Run の時間の上限を過ぎたため、始めなかったビューポートの理由。 */
export const RUN_TIME_LIMIT_SKIP_REASON: IncompleteReason = Object.freeze({ code: 'MAX_RUNTIME_REACHED' satisfies IncompleteReasonCode, detail: null });

/** DEF-225: 開くとファイルのダウンロードになったビューポートの理由。同じページの次のビューポートも、この理由で始めない（同じ URL を読み直さない）。 */
export const DOWNLOAD_RESPONSE_REASON: IncompleteReason = Object.freeze({ code: 'DOWNLOAD_RESPONSE' satisfies IncompleteReasonCode, detail: null });

/**
 * 次のビューポートを始めない理由（始めるなら `null`）。順は、違反 → 不調 → セッションの切れ → ダウンロード → Run の時間の上限。最初のビューポートの前には、
 * 違反と時間の上限を確かめない（ページを始めるかは Run Coordinator が決める）。
 */
export function viewportSkipReasonOf(facts: {
  readonly earlierViewports: number;
  readonly violationRecorded: () => boolean;
  readonly siteUnavailable: boolean;
  readonly sessionLost: boolean;
  readonly downloadResponse: boolean;
  readonly runTimeLimitPassed: () => boolean;
}): IncompleteReason | null {
  const later = facts.earlierViewports > 0;
  if (later && facts.violationRecorded()) return SAFETY_VIOLATION_ABORT_REASON;
  if (facts.siteUnavailable) return SITE_UNAVAILABLE_SKIP_REASON;
  if (facts.sessionLost) return AUTH_SESSION_LOST_SKIP_REASON;
  if (facts.downloadResponse) return DOWNLOAD_RESPONSE_REASON;
  if (later && facts.runTimeLimitPassed()) return RUN_TIME_LIMIT_SKIP_REASON;
  return null;
}

/** 幅の走査の次の幅を始めない理由（始めるなら `null`）。順は、違反 → 不調 → セッションの切れ（確かめ直しを含む）。 */
export function stressWidthAbortOf(facts: {
  readonly violationRecorded: () => boolean;
  readonly siteUnavailable: boolean;
  readonly sessionLost: () => boolean;
}): 'SAFETY_VIOLATION_ABORT' | 'SITE_UNAVAILABLE' | 'AUTH_SESSION_LOST' | null {
  if (facts.violationRecorded()) return 'SAFETY_VIOLATION_ABORT';
  if (facts.siteUnavailable) return 'SITE_UNAVAILABLE';
  if (facts.sessionLost()) return 'AUTH_SESSION_LOST';
  return null;
}

/** Interaction の次の候補の扱い。`END` は理由なしで終える（段が止まった）。`STOP` は、残りの候補の数を付けて理由を残して終える。 */
export type InteractionCandidateStep =
  | { readonly kind: 'AUDIT' }
  | { readonly kind: 'END' }
  | { readonly kind: 'STOP'; readonly reason: 'SAFETY_VIOLATION_ABORT' | 'SITE_UNAVAILABLE' | 'limit' };

/**
 * Interaction の次の候補（主の画面の候補と、開いた状態の中の候補で共通）。順は、段が止まった → 違反 → 不調 → 1 ページの上限（`index` は監査を始めた候補の数）。
 */
export function interactionCandidateStepOf(facts: {
  readonly stopped: boolean;
  readonly violationRecorded: () => boolean;
  readonly siteUnavailable: boolean;
  readonly index: number;
  readonly maxInteractionsPerPage: number | undefined;
}): InteractionCandidateStep {
  if (facts.stopped) return { kind: 'END' };
  if (facts.violationRecorded()) return { kind: 'STOP', reason: 'SAFETY_VIOLATION_ABORT' };
  if (facts.siteUnavailable) return { kind: 'STOP', reason: 'SITE_UNAVAILABLE' };
  if (facts.maxInteractionsPerPage !== undefined && facts.index >= facts.maxInteractionsPerPage) return { kind: 'STOP', reason: 'limit' };
  return { kind: 'AUDIT' };
}

/**
 * DEF-236: 次の読み込みを始めうるか。不調・セッションの切れ・Run の時間の上限・違反（止めたことを記録しない確かめ）の後は、始めない。
 */
export function nextLoadMayStart(facts: {
  readonly siteUnavailable: boolean;
  readonly sessionLost: boolean;
  readonly runTimeLimitPassed: () => boolean;
  readonly violationDetected: () => boolean;
}): boolean {
  return !facts.siteUnavailable && !facts.sessionLost && !facts.runTimeLimitPassed() && !facts.violationDetected();
}

/**
 * DEF-236: ビューポートを閉じる前に、前の画面を見せたまま読み込みの間隔を待つか。開いた page で証拠を集め終え、crash していないときだけ、ダウンロードで
 * ない → 次を始めうる → 後に読み込みが続く、の順に確かめる（後に続くかは Run Coordinator に 1 回だけ聞くので、最後）。
 */
export function waitsWithPageShown(facts: {
  readonly evidenceSettled: boolean;
  readonly crashed: boolean;
  readonly downloadBlocked: () => boolean;
  readonly nextLoadMayStart: () => boolean;
  readonly laterLoadFollows: () => boolean;
}): boolean {
  return facts.evidenceSettled && !facts.crashed
    && !facts.downloadBlocked() && facts.nextLoadMayStart() && facts.laterLoadFollows();
}

/**
 * DUP（ユーザーの判断 2026-11-18）: ページの点検の深さの閉じた一覧。
 * - `FULL`: しっかり点検する（今までの全部の段）。
 * - `LIGHT`: 同じ作り（作りの鍵が同じ）の 2 つ目以降で、データだけが違う画面。文字のはみ出しや重なりの確かめに絞る。
 * - `SAME`: 同じ作りで、表示の中身もしっかり点検した画面と同じ。Desktop の layout と links の後の段をしない。
 */
export const PAGE_AUDIT_DEPTHS = Object.freeze(['FULL', 'LIGHT', 'SAME'] as const);
export type PageAuditDepth = (typeof PAGE_AUDIT_DEPTHS)[number];

/** DUP: 深さで決まる段（Desktop の主の読み込み・DOM・layout・links は、どの深さでも行う）。設定で止めた段は、設定のとおり行わない。 */
export interface PageAuditDepthStages {
  /** layout の後の画像・指摘の対象を撮る（reveal）・確かめ直し。 */
  readonly afterLayout: boolean;
  readonly accessibility: boolean;
  readonly performance: boolean;
  /** Desktop の幅の走査。 */
  readonly stressSweep: boolean;
  readonly interactions: boolean;
  readonly focusCheck: boolean;
  /** そのビューポートを始めるか（偽は、理由 `SAME_CONTENT_AS_EARLIER_PAGE` の `SKIPPED`。Desktop は深さを決めるビューポートなので、いつも始める）。 */
  readonly viewport: boolean;
  /** Rule に渡す記録の種類（`null` は全部）。 */
  readonly ruleEvidenceTypes: readonly EvidenceType[] | null;
}

const ALL_STAGES: PageAuditDepthStages = Object.freeze({
  afterLayout: true, accessibility: true, performance: true, stressSweep: true, interactions: true, focusCheck: true, viewport: true, ruleEvidenceTypes: null,
});
const NO_STAGES: PageAuditDepthStages = Object.freeze({
  afterLayout: false, accessibility: false, performance: false, stressSweep: false, interactions: false, focusCheck: false, viewport: true, ruleEvidenceTypes: null,
});
/** 軽い点検: layout とその証拠（画像・reveal・確かめ直し）は残す。axe は Desktop だけ（設計者の判断 2026-11-18。安いので）。 */
const LIGHT_STAGES: Readonly<Record<ViewportProfile, PageAuditDepthStages>> = Object.freeze({
  desktop: Object.freeze({ ...NO_STAGES, afterLayout: true, accessibility: true }),
  mobile: Object.freeze({ ...NO_STAGES, afterLayout: true }),
});
/**
 * 点検を省く: Desktop は layout と links まで、Mobile は始めない。Rule には安全・通信・console の記録だけを渡す（同じ中身の画面の指摘と重なる表示の指摘を
 * 作らない。安全・HTTP・資源・JS の指摘は残す。REV-DUP の M-3）。
 */
const SAME_STAGES: Readonly<Record<ViewportProfile, PageAuditDepthStages>> = Object.freeze({
  desktop: Object.freeze({ ...NO_STAGES, ruleEvidenceTypes: Object.freeze(['safety', 'network', 'console'] as const) }),
  mobile: Object.freeze({ ...NO_STAGES, viewport: false }),
});

/** DUP: 深さとビューポートの段の表（段の唯一の決め所。REV-DUP の M-6）。 */
export function pageAuditStagesOf(depth: PageAuditDepth, profile: ViewportProfile): PageAuditDepthStages {
  switch (depth) {
    case 'FULL':
      return ALL_STAGES;
    case 'LIGHT':
      return LIGHT_STAGES[profile];
    case 'SAME':
      return SAME_STAGES[profile];
  }
}

/** DUP: 段の表の項目と、その段の名前（`COLLECTOR_INCOMPLETE` の `detail` の段など。1 回目の認め方が使う）。 */
const STAGE_NAMES_OF_ITEM: Readonly<Record<'accessibility' | 'performance' | 'stressSweep' | 'interactions' | 'focusCheck', readonly PageAuditStage[]>> =
  Object.freeze({
    accessibility: ['accessibility'],
    performance: ['performance'],
    stressSweep: ['stress-layout'],
    interactions: ['interaction-discovery', 'interaction', 'opened-state'],
    focusCheck: ['focus-check'],
  });

/** DUP: そのビューポートで、しっかり点検では行い、軽い点検では省く段の名前（段の表から導く）。 */
const stagesLightSkips = (profile: ViewportProfile): ReadonlySet<PageAuditStage> => {
  const full = pageAuditStagesOf('FULL', profile);
  const light = pageAuditStagesOf('LIGHT', profile);
  return new Set((Object.keys(STAGE_NAMES_OF_ITEM) as (keyof typeof STAGE_NAMES_OF_ITEM)[])
    .filter((item) => full[item] && !light[item])
    .flatMap((item) => STAGE_NAMES_OF_ITEM[item]));
};

/** DUP: 理由が、その段の理由か（`detail` が段の名前か、`<段>:` で始まる）。 */
const isReasonOfStages = (reason: IncompleteReason, stages: ReadonlySet<PageAuditStage>): boolean =>
  reason.detail !== null && [...stages].some((stage) => reason.detail === stage || reason.detail?.startsWith(`${stage}:`) === true);

/**
 * DUP: 決めた深さ。`sameAs` は、`LIGHT` なら同じ作りのしっかり点検した 1 回目、`SAME` なら表示の中身が同じ点検した画面（`FULL` は `null`）。
 */
export interface PageAuditDepthDecision {
  readonly depth: PageAuditDepth;
  readonly sameAs: PageId | null;
}

/** DUP: 1 回目の表に聞く口（作りの鍵の 1 回目と、表示の中身が同じ点検した画面）。 */
export interface PageSamenessAnswers {
  readonly referenceOf: (templateKey: string) => PageId | null;
  readonly sameContentAs: (templateKey: string, contentDigest: string) => PageId | null;
}

/**
 * DUP: ページの深さ。作りの鍵が分からない・しっかり点検した 1 回目がない → `FULL`。1 回目がある → 中身の要約が同じ点検した画面があれば `SAME`、なければ（中身の
 * 要約が分からないときも）`LIGHT`。中身は 1 回目があるときだけ比べる。
 */
export function pageAuditDepthOf(facts: PageSamenessAnswers & {
  readonly templateKey: string | null;
  readonly contentDigest: string | null;
}): PageAuditDepthDecision {
  const { templateKey, contentDigest } = facts;
  const reference = templateKey === null ? null : facts.referenceOf(templateKey);
  if (templateKey === null || reference === null) {
    return Object.freeze({ depth: 'FULL', sameAs: null });
  }
  const sameAs = contentDigest === null ? null : facts.sameContentAs(templateKey, contentDigest);
  return Object.freeze(sameAs === null ? { depth: 'LIGHT', sameAs: reference } : { depth: 'SAME', sameAs });
}

/**
 * DUP: しっかり点検した 1 回目と認める結果か（設計書 2 章、REV-DUP の I-1）。2 つ目以降の軽い点検は、省く段（幅の走査・Interaction・フォーカスの確かめ・性能・
 * Mobile の axe）を 1 回目に任せるので、1 回目でその段を最後まで終えたときだけ認める。
 * - `AUDITED` か `PARTIAL` で、Mobile が `FAILED` でも `SKIPPED` でもない。
 * - 軽い点検で省く段（段の表 `pageAuditStagesOf` から導く）に、未完了の理由（失敗・反応なし・静まらない・時間切れ・crash など、段の名前を持つ理由）がない。
 * - 途中で止まった理由（`SAMENESS_REFERENCE_STOP_CODES` と時間切れ `isRunTimeLimitReason`）がない。
 * 認めなければ、次の同じ作りの画面をしっかり点検する。
 */
export function acceptsAsSamenessReference(result: Pick<PageAuditResult, 'status' | 'incompleteReasons' | 'viewports'>): boolean {
  if ((result.status !== 'AUDITED' && result.status !== 'PARTIAL') || result.viewports.mobile.status === 'FAILED' || result.viewports.mobile.status === 'SKIPPED') {
    return false;
  }
  const stopped = (reason: IncompleteReason): boolean => SAMENESS_REFERENCE_STOP_CODES.has(reason.code) || isRunTimeLimitReason(reason);
  return !result.incompleteReasons.some(stopped)
    && !(Object.keys(result.viewports) as ViewportProfile[]).some((profile) => result.viewports[profile].incompleteReasons
      .some((reason) => stopped(reason) || isReasonOfStages(reason, stagesLightSkips(profile))));
}

/** DUP: 1 回目と認めない、途中で止まった理由のコード（時間切れは `isRunTimeLimitReason`）。 */
const SAMENESS_REFERENCE_STOP_CODES: ReadonlySet<IncompleteReasonCode> = new Set<IncompleteReasonCode>([
  'SITE_UNAVAILABLE',
  'AUTH_SESSION_LOST',
  'SAFETY_VIOLATION_ABORT',
  'RUN_INTERRUPTED',
  'NAVIGATION_FAILED',
  'DOCUMENT_LEFT_DURING_AUDIT',
  'PAGE_CRASHED',
]);

/**
 * DUP（設計書 2 章の再開）: 読み直すページは、前の深さのままにする（`LIGHT` の読み直しは `LIGHT`、`FULL` は `FULL`）。`previous` は前の結果の深さ（`null` は
 * 読み直しでない。1 回目の表のとおり）。`LIGHT`・`SAME` の 1 回目は、表になければ前の記録の画面にする。
 */
export function samenessAnswersOf(table: PageSamenessAnswers, previous: PageAuditDepthDecision | null): PageSamenessAnswers {
  if (previous === null) {
    return table;
  }
  if (previous.depth === 'FULL' || previous.sameAs === null) {
    return Object.freeze({ referenceOf: () => null, sameContentAs: () => null });
  }
  const { sameAs } = previous;
  return Object.freeze({
    referenceOf: (templateKey: string) => table.referenceOf(templateKey) ?? sameAs,
    sameContentAs: () => (previous.depth === 'SAME' ? sameAs : null),
  });
}

/** DUP: Page Auditor に知らせた深さと鍵（Run Coordinator が、しっかり点検した 1 回目の表に使う）。 */
export interface PageSamenessDecision extends PageAuditDepthDecision {
  readonly pageId: PageId;
  /** 作りの鍵（読めなければ `null`）。 */
  readonly templateKey: string | null;
  /** 中身の要約（layout がなければ `null`）。 */
  readonly contentDigest: string | null;
}

/**
 * DUP: 同じ作りの画面の口（Run Coordinator が渡す。渡さなければ、どのページもしっかり点検する）。`referenceOf` と `sameContentAs` は、Desktop の layout を
 * 読んだ後に聞く。`decided` は、Desktop で深さを決めたときに 1 回だけ呼ぶ。
 */
export interface PageSamenessPort extends PageSamenessAnswers {
  readonly decided: (decision: PageSamenessDecision) => void;
}
