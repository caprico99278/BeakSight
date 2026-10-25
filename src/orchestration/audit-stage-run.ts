// スクリプトで送るログインの監査の Run の、監査の段の部品の受け渡しと記録（T35c。Task 35 の設計書 3.4〜3.7）。Run Coordinator が、認証の指定に監査の段の
// 口（`RunAuthentication.auditStage`）があるときだけ使う（公開の監査とフォームの送信のログインの監査は使わない。出力は変えない）。
// - 実行ごとに、承認したサービスの Origin への要求の上限の部品（`createServiceRequestBudget`）、監査の段の記録（`AuditStageMonitor`）、401 の数と鍵の
//   消失の印を作る（`createAuditStageRunState`）。前の実行までの数は、保存（`RunCheckpointLoad.auditStageCounts`）から引き継ぐ。
// - T35R-fix（T35R の I-2・I-3。T35a の「上限は実行ごと、再開は新しい予算」の判断を取り消した）: 上限は Run の全体（「1 回の Run で 600 件」）。上限の
//   部品は、前の実行までに数えた数から数える（1 分あたりの窓は実行ごと）。上限で断った要求の数も Run の全体で持ち、1 つでもあれば上限に届いたとする。
// - factory に渡す指定（`auditStageFactoryOptions`）。
// - 上限に届いた後に始めなかったページの理由（`SERVICE_REQUEST_LIMIT_SKIP_REASON`）と、鍵の消失のセッションの切れの場所（`SESSION_KEY_LOST_DETAIL`）。
// - `run.json` の `authentication`（`runAuthenticationSummaryOf`）と、保存に書く数（`auditStageCountsOf`）。数だけで、URL・値を持たない。
// - DEF-141: 1 分あたりの上限で次の読み込みの前に待つ、読み込みの間隔の部品の包み（`serviceRequestPacedNavigationPacer`。Run Coordinator・発見・READ の
//   確かめが共用する）と、その知らせ（`ServiceRequestPacingNotice`）。待った回数と時間は、`authentication` と保存の数に入る。
import type { AuditStageServiceRequests, AuthenticatedStorageState, BrowserContextFactoryOptions } from '../browser/context-factory.js';
import {
  SESSION_KEY_LOST_DETAIL,
  type IncompleteReason,
  type IncompleteReasonCode,
  type RunAuthenticationSummary,
  type SessionKeyLostDetail,
} from '../core/contracts.js';
import { saturatingAdd, saturatingIncrement } from '../core/saturating-count.js';
import { createNavigationPacer, withAdditionalNavigationWait, type NavigationPacer } from '../crawl/navigation-pacer.js';
import { createServiceRequestBudget, type ServiceRequestBudget } from '../crawl/service-request-budget.js';
import { readCheckAuditStageDetailOf, type ReadCheckAuditStageObservation } from '../discovery/read-check-evaluation.js';
import { AuditStageMonitor } from '../safety/passive-request-guard.js';
import { authenticatedContextOptions, type RunAuthentication } from './authenticated-run.js';
import type { RunCheckpointAuditStageCounts, RunCheckpointLoad } from './run-checkpoint.js';

/** 承認したサービスの Origin への要求の上限に届いた後に、始めなかったページの理由（`detail` は `null`）。Run の理由にも 1 件残す。 */
export const SERVICE_REQUEST_LIMIT_SKIP_REASON: IncompleteReason = Object.freeze({
  code: 'SERVICE_REQUEST_LIMIT_REACHED' satisfies IncompleteReasonCode,
  detail: null,
});

/**
 * ログインの状態の鍵がなくなったことで、セッションの切れとみなした場所（理由 `AUTH_SESSION_LOST` の `detail`。今の `<ビューポート>:<段階>` と区別する。
 * T35c。URL・鍵の名前・値は入れない）。T37a: 値の owner は `src/core/contracts.ts`（発見と READ の確かめの成果物の純粋な部品も使うため）。ここは今の
 * 名前のまま公開し直す。
 */
export { SESSION_KEY_LOST_DETAIL };

/** 保存に書く数の初め（前の実行がない、または古い保存）。 */
const EMPTY_AUDIT_STAGE_COUNTS: RunCheckpointAuditStageCounts = Object.freeze({
  registeredReadRequestsAllowed: 0,
  tokenRefreshBlocked: 0,
  otherNonReadBlocked: 0,
  serviceUnauthorizedResponses: 0,
  serviceRequestsAdmitted: 0,
  serviceRequestLimitRefused: 0,
  allowedOriginDataRequestsBlocked: 0,
  serviceRequestPacingWaits: 0,
  serviceRequestPacingWaitMs: 0,
});

/** 1 回の実行の、監査の段の部品と数。 */
export interface AuditStageRunState {
  readonly budget: ServiceRequestBudget;
  readonly monitor: AuditStageMonitor;
  /** 前の実行までの数（保存から）。 */
  readonly previous: RunCheckpointAuditStageCounts;
  /** この実行で受けた、承認したサービスの Origin からの 401 の応答の数。 */
  serviceUnauthorizedResponses: number;
  /** この実行で、ログインの状態の鍵がなくなったのを見た。 */
  sessionKeyLost: boolean;
  /** DEF-141: この実行で、1 分あたりの上限で次の読み込みの前に待った回数と、待った時間の合計（ms）。 */
  serviceRequestPacingWaits: number;
  serviceRequestPacingWaitMs: number;
}

/**
 * 承認したサービスの Origin への要求の 1 分あたりの上限で、次の読み込みの前に待つことの知らせ（DEF-141。設計書
 * `2026-10-20-beaksight-service-request-pacing-design.md` 2.2。Run Coordinator・発見・READ の確かめが、今の知らせの口に渡す。事実だけで、文言は表示の側が
 * 作る。凍結する）。
 * - `waitMs`: これから待つ時間（ms）。
 * - `waitCount`・`totalWaitMs`: この待ちを含めた、Run（ジョブ）の全体の待った回数と時間の合計（`run.json` の `authentication` と同じ数え方）。
 */
export interface ServiceRequestPacingNotice {
  readonly kind: 'SERVICE_REQUEST_PACING_WAIT';
  readonly waitMs: number;
  readonly waitCount: number;
  readonly totalWaitMs: number;
}

/**
 * FM2d（設計書 `2026-10-19-beaksight-fewer-manual-steps-design.md` 3A.1）: まとめて実行の段の終わりに、次の段へ持ち越す値（ワーカーのメモリの中だけ。
 * 成果物・管理データ・ログ・IPC に出さない）。
 * - `latestState`: factory の最新のログインの状態（`BrowserContextFactory.latestAuthenticatedState()`。認証の指定がない、factory を作らなかったなら `null`）。
 * - `serviceRequestWindowMs`: サービスの Origin への要求の 1 分の窓の時刻（`serviceRequestWindowOf`。監査の段の口がなければ空）。
 */
export interface RunStageCarried {
  readonly latestState: AuthenticatedStorageState | null;
  readonly serviceRequestWindowMs: readonly number[];
  /** FM2R の C-1: 読み込みの間隔の持ち越し（`RunStageNavigation`）。 */
  readonly navigation: RunStageNavigation;
}

/**
 * FM2R の C-1（設計書の履歴 2026-10-23 の FM2R の判断 b）: 段の終わりの、読み込みの間隔の持ち越し。次の段の pacer は、この値から待つ
 * （`nextStageNavigationPacerOf`）。再開した監査の段は外の pacer を使わない（保存から自分で作る）ので、どの段の後でも、この値で持ち越す。
 * - `lastNavigationStartedAtMs`: その段の最後の読み込みの開始の時刻（pacer の記録。なければ `null`）。
 * - `stageEndedAtMs`: 持ち越しを記録した時刻（Browser を閉じた後。この後に、その段の要求はない。最後の読み込みの後のリダイレクトやページが始めた読み込みも
 *   含めて、次の段の最初の読み込みを、これから設定の間隔以上空ける）。
 * - `minIntervalMs`: その段の最後の最小の間隔（サイトの不調の確かめ直しで上げた間隔 `raiseMinimumInterval` を含む。下げない）。
 */
export interface RunStageNavigation {
  readonly lastNavigationStartedAtMs: number | null;
  readonly stageEndedAtMs: number;
  readonly minIntervalMs: number;
}

/**
 * FM2R の C-1: 読み込みの間隔の部品を包み、上げた最小の間隔（`raiseMinimumInterval`）を覚える（持ち越しに写すため。pacer は今の間隔を外へ出さない）。
 * 待ち・記録・送った時刻の記録は、包んだ部品のまま。
 */
export function intervalTrackingNavigationPacer(
  pacer: NavigationPacer,
  configuredMinIntervalMs: number,
): { readonly pacer: NavigationPacer; readonly minIntervalMs: () => number } {
  let minIntervalMs = configuredMinIntervalMs;
  return Object.freeze({
    pacer: Object.freeze({
      beforeNavigation: () => pacer.beforeNavigation(),
      snapshot: () => pacer.snapshot(),
      raiseMinimumInterval: (raised: number): void => {
        pacer.raiseMinimumInterval(raised);
        minIntervalMs = Math.max(minIntervalMs, raised);
      },
      recordDocumentRequestSent: (): void => pacer.recordDocumentRequestSent(),
    }),
    minIntervalMs: () => minIntervalMs,
  });
}

/**
 * FM2R の C-1: まとめて実行の次の段の読み込みの間隔の部品。前の段の持ち越し（`RunStageNavigation`）から始める: 最小の間隔は設定の値と前の段の間隔の大きい方、
 * 最初の読み込みは、前の段の最後の読み込みの開始と段の終わりの遅い方から、その間隔以上空ける（`createNavigationPacer` の `initial`）。
 */
export function nextStageNavigationPacerOf(
  carried: RunStageNavigation,
  configuredMinIntervalMs: number,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
): NavigationPacer {
  return createNavigationPacer({
    minIntervalMs: Math.max(configuredMinIntervalMs, carried.minIntervalMs),
    now,
    sleep,
    initial: {
      navigationCount: 0,
      totalWaitMs: 0,
      lastNavigationStartedAtMs: Math.max(carried.lastNavigationStartedAtMs ?? 0, carried.stageEndedAtMs),
    },
  });
}

/**
 * FM2d: まとめて実行の段の持ち越しの口（ワーカーが段ごとに渡す。省略すると今のまま。CLI の単独の Run は渡さない）。
 * - `serviceRequestWindowMs`: 前の段の 1 分の窓（初めの段は空）。この段の上限の部品の窓に入れる（実行の上限は段ごとに数える）。
 * - `record`: 段の終わり（Browser を閉じた後、成果物を書く前）に 1 回呼ぶ。
 */
export interface RunStageCarry {
  readonly serviceRequestWindowMs: readonly number[];
  readonly record: (carried: RunStageCarried) => void;
}

/** FM2d: 監査の段の状態の、今の 1 分の窓の時刻（状態がなければ空）。窓の判定は上限の部品の 1 か所（`windowTimesMs`）。 */
export const serviceRequestWindowOf = (state: AuditStageRunState | null): readonly number[] =>
  (state === null ? Object.freeze([]) : state.budget.windowTimesMs());

/**
 * FM2d: 段の終わりの持ち越しを `carry.record` に渡す（Run Coordinator・発見・READ の確かめが共用する 1 か所）。factory の最新の状態（factory がなければ
 * `null`）と、監査の段の状態の窓。持ち越しがなければ何もしない。受け手の例外は外に出さない（Run を止めない。次の段は、ワーカーが持ち越しの有無で決める）。
 */
export function recordRunStageCarry(
  carry: RunStageCarry | null | undefined,
  factory: { readonly latestAuthenticatedState: () => AuthenticatedStorageState | null } | null,
  state: AuditStageRunState | null,
  navigation: { readonly pacer: Pick<NavigationPacer, 'snapshot'>; readonly minIntervalMs: number; readonly now: () => number },
): void {
  if (carry === null || carry === undefined) {
    return;
  }
  try {
    carry.record(Object.freeze({
      latestState: factory?.latestAuthenticatedState() ?? null,
      serviceRequestWindowMs: serviceRequestWindowOf(state),
      // FM2R の C-1: 読み込みの間隔の持ち越し（最後の読み込みの開始、段の終わり、上げた間隔）。
      navigation: Object.freeze({
        lastNavigationStartedAtMs: navigation.pacer.snapshot().lastNavigationStartedAtMs,
        stageEndedAtMs: navigation.now(),
        minIntervalMs: navigation.minIntervalMs,
      }),
    }));
  } catch {
    // 持ち越しの受け手の失敗で、Run を止めない。
  }
}

/**
 * 実行の初めに、監査の段の部品と数を作る（上限の部品は、前の実行までに数えた数から数える。1 分あたりの窓は新しい。FM2d: まとめて実行の次の段は、
 * 前の段の窓 `carriedWindowMs` から始める）。
 */
export function createAuditStageRunState(
  auditStage: AuditStageServiceRequests,
  now: () => number,
  previous: RunCheckpointAuditStageCounts | undefined,
  carriedWindowMs: readonly number[] = [],
): AuditStageRunState {
  const counts = previous ?? EMPTY_AUDIT_STAGE_COUNTS;
  return {
    budget: createServiceRequestBudget({
      ...auditStage.serviceRequestLimits,
      now,
      initialAdmitted: counts.serviceRequestsAdmitted,
      initialWindowTimesMs: carriedWindowMs,
    }),
    monitor: new AuditStageMonitor(),
    previous: counts,
    serviceUnauthorizedResponses: 0,
    sessionKeyLost: false,
    serviceRequestPacingWaits: 0,
    serviceRequestPacingWaitMs: 0,
  };
}

/**
 * Run Coordinator・発見・READ の確かめが共用する、次の読み込みの前の待ちを重ねた読み込みの間隔の部品（DEF-141。設計書
 * `2026-10-20-beaksight-service-request-pacing-design.md` 2.2、2.4）。監査の段の状態がなければ、渡した部品をそのまま返す（今のまま）。状態があれば、
 * 上限の部品の待つ時間（`ServiceRequestBudget.waitBeforeNextLoadMs`）を `withAdditionalNavigationWait` で重ね、待つたびに、回数と時間を状態に足し、
 * Run の全体の数で知らせ（`ServiceRequestPacingNotice`）を出す。知らせの受け手の例外は握りつぶす（表示の失敗で読み込みを止めない）。
 */
export function serviceRequestPacedNavigationPacer(
  pacer: NavigationPacer,
  state: AuditStageRunState | null,
  sleep: (ms: number) => Promise<void>,
  notify: (notice: ServiceRequestPacingNotice) => void,
): NavigationPacer {
  if (state === null) {
    return pacer;
  }
  return withAdditionalNavigationWait(pacer, {
    source: state.budget,
    sleep,
    onWait: (waitMs) => {
      state.serviceRequestPacingWaits = saturatingIncrement(state.serviceRequestPacingWaits);
      state.serviceRequestPacingWaitMs = saturatingAdd(state.serviceRequestPacingWaitMs, waitMs);
      const counts = auditStageCountsOf(state);
      try {
        notify(Object.freeze({
          kind: 'SERVICE_REQUEST_PACING_WAIT',
          waitMs,
          waitCount: counts.serviceRequestPacingWaits,
          totalWaitMs: counts.serviceRequestPacingWaitMs,
        }));
      } catch {
        // 表示の失敗で、読み込みを止めない。
      }
    },
  });
}

/** factory に渡す指定（上限の部品、監査の段の記録、401 と鍵の消失の知らせ）。 */
export function auditStageFactoryOptions(
  state: AuditStageRunState,
): Pick<BrowserContextFactoryOptions, 'serviceRequestBudget' | 'auditStageMonitor' | 'onServiceUnauthorizedResponse' | 'onSessionKeyLost'> {
  return {
    serviceRequestBudget: state.budget,
    auditStageMonitor: state.monitor,
    onServiceUnauthorizedResponse: (): void => {
      state.serviceUnauthorizedResponses = saturatingIncrement(state.serviceUnauthorizedResponses);
    },
    onSessionKeyLost: (): void => {
      state.sessionKeyLost = true;
    },
  };
}

/**
 * 再開のときに引き継ぐ監査の段の数（T35R2-fix。T35R2 の M-1）。上限の部品が数えた数（`serviceRequestsAdmitted`）は、保存の数と、負荷の記録の承認した
 * サービスの Origin の区分の数（`approvedServiceOrigins.count`。届いた要求を数える別の部品）の大きい方にする（保存の書き換えで上限を超えない）。
 * 保存に監査の段の数がなければ `null`（Run Coordinator は再開しない）。
 */
export function resumedAuditStageCounts(
  load: Pick<RunCheckpointLoad, 'approvedServiceOrigins' | 'auditStageCounts'>,
): RunCheckpointAuditStageCounts | null {
  const counts = load.auditStageCounts;
  if (counts === undefined) {
    return null;
  }
  const loadCount = load.approvedServiceOrigins?.count ?? 0;
  return Object.freeze({ ...counts, serviceRequestsAdmitted: Math.max(counts.serviceRequestsAdmitted, loadCount) });
}

/**
 * ジョブの流れで、登録した読み取りの手続きの呼び出し（`auditReadRequests`）を通すか（T37a。Task 37 の設計書 3.1。ユーザーの確認済み 2026-10-16）。
 * - `REGISTERED`: 通す（発見と READ の確かめ。判定は Run と同じ Guard の 1 か所。PRIMARY だけ、1 回の読み込みあたりの上限、サービスの Origin の上限で数える）。
 * - `NONE`: 通さない（書き込みのジョブ。Task 39 まで、口の `auditReadRequests` を空にして渡す）。
 */
export type JobAuditReadRequests = 'REGISTERED' | 'NONE';

/** ジョブの流れの factory の指定と、作った監査の段の状態（口がなければ `null`）。 */
export interface JobAuditStage {
  readonly factoryOptions: Pick<BrowserContextFactoryOptions, 'serviceRequestBudget' | 'auditStageMonitor' | 'onServiceUnauthorizedResponse' | 'onSessionKeyLost'>
    & { readonly authentication: ReturnType<typeof authenticatedContextOptions> };
  readonly state: AuditStageRunState | null;
}

/**
 * Run Coordinator を通らないジョブの流れ（発見・READ の確かめ・書き込み）の factory の指定（T35R2-fix。T35R2 の C-1 の (b)・(c)）。認証の指定に監査の段の
 * 口があれば、Run と同じ作り方（`createAuditStageRunState`・`auditStageFactoryOptions`）で、ジョブの全体で 1 つの上限の部品と監査の段の記録を作って
 * 渡す。T37a: 作った状態も返す（ジョブの流れが、1 画面ごとに上限と鍵の消失を確かめ、成果物に数を書く）。登録した読み取りの手続きの呼び出しは、
 * 呼び出し側が選ぶ（`JobAuditReadRequests`。`NONE` は口の `auditReadRequests` を空にして渡す。判定は Guard の 1 か所のまま）。口がなければ、認証の
 * 指定だけ（今のまま）で、状態は `null`。
 */
export function jobContextFactoryOptions(
  authentication: RunAuthentication,
  now: () => number,
  readRequests: JobAuditReadRequests,
  carriedWindowMs: readonly number[] = [],
): JobAuditStage {
  const { auditStage } = authentication;
  if (auditStage === undefined) {
    return { factoryOptions: { authentication: authenticatedContextOptions(authentication) }, state: null };
  }
  const passed: AuditStageServiceRequests = readRequests === 'REGISTERED' ? auditStage : { ...auditStage, auditReadRequests: [] };
  // FM2d: まとめて実行の次の段は、前の段の 1 分の窓から始める（省略は空。今のまま）。
  const state = createAuditStageRunState(passed, now, undefined, carriedWindowMs);
  return {
    factoryOptions: {
      authentication: authenticatedContextOptions({ ...authentication, auditStage: passed }),
      ...auditStageFactoryOptions(state),
    },
    state,
  };
}

/**
 * 次のページ（ジョブでは次の画面・定義）を始める前の、承認したサービスの Origin への要求の上限に届いたかの判定（T37a。Run Coordinator・発見・READ の
 * 確かめが共有する 1 か所）。状態がなければ偽。
 */
export const isServiceRequestLimitReached = (state: AuditStageRunState | null | undefined): boolean => state?.budget.isLimitReached() === true;

/**
 * ページ（画面）を読んだ後の、ログインの状態の鍵の消失によるセッションの切れの詳しい理由（T37a。Run Coordinator・発見・READ の確かめが共有する 1 か所）。
 * 鍵が消えていなければ、状態がなければ `null`。
 */
export const sessionKeyLostDetailOf = (state: AuditStageRunState | null | undefined): SessionKeyLostDetail | null =>
  (state?.sessionKeyLost === true ? SESSION_KEY_LOST_DETAIL : null);

/**
 * この実行で、上限で断った要求と、承認したサービスの Origin からの 401 の応答の数の和（T37a。読み込みの前と後の差で、その画面に、サービスの読み取りが
 * 届かなかった印を付ける。画面は 1 つずつ読むので、差はその画面の Context の分（閉じるまで）。安全側: 差があれば、その画面を読み切れなかったとする）。
 */
export const serviceReadRefusalCountOf = (state: AuditStageRunState): number =>
  saturatingAdd(state.budget.snapshot().refused, state.serviceUnauthorizedResponses);

/**
 * 1 つの画面（READ の確かめでは 1 つの定義）の読み込みの前と後で比べる、監査の段の数（T37R-fix-B。T37R の M-2。発見と READ の確かめが共有する 1 か所）。
 * - `serviceReadRefusals`: 上限で断った要求と 401 の数の和（`serviceReadRefusalCountOf`）。
 * - `registeredReadRequestsBlocked`: 登録した読み取りの手続きの呼び出しを、回数の上限か送り方で止めた数（T37d の (c)。`READ_REQUEST_OVER_LIMIT`・
 *   `READ_REQUEST_NOT_SCRIPT` の和）。
 * - `serviceOriginNonReadBlocked`: 承認したサービスの Origin への読み取りでない要求を止めた数（T37d の (d)）。
 * - `allowedOriginDataRequestsBlocked`: 許可 Origin への `fetch`・`xhr` の読み取りでない要求を止めた数（T37R の M-5。T37R-fix-B2: 記録だけで、
 *   `isAuditStageReadObstructed` の判定には使わない）。
 * 和は `saturatingAdd`。
 */
export interface AuditStageReadCounts {
  readonly serviceReadRefusals: number;
  readonly registeredReadRequestsBlocked: number;
  readonly serviceOriginNonReadBlocked: number;
  readonly allowedOriginDataRequestsBlocked: number;
}

/** 今の監査の段の数（読み込みの前と後に読む）。 */
export const auditStageReadCountsOf = (state: AuditStageRunState): AuditStageReadCounts => {
  const snapshot = state.monitor.snapshot();
  return Object.freeze({
    serviceReadRefusals: serviceReadRefusalCountOf(state),
    registeredReadRequestsBlocked: saturatingAdd(snapshot.blockedByReason.READ_REQUEST_OVER_LIMIT, snapshot.blockedByReason.READ_REQUEST_NOT_SCRIPT),
    serviceOriginNonReadBlocked: snapshot.serviceOriginNonReadBlocked,
    allowedOriginDataRequestsBlocked: snapshot.allowedOriginDataRequestsBlocked,
  });
};

/** 読み込みの前と後の数の差から作る、その読み込みの間の監査の段の事実（減ることはないが、減っても 0 とする）。 */
export const auditStageReadObservationBetween = (before: AuditStageReadCounts, after: AuditStageReadCounts): ReadCheckAuditStageObservation =>
  Object.freeze({
    serviceReadRefused: after.serviceReadRefusals > before.serviceReadRefusals,
    registeredReadRequestsBlocked: Math.max(0, after.registeredReadRequestsBlocked - before.registeredReadRequestsBlocked),
    serviceOriginNonReadBlocked: Math.max(0, after.serviceOriginNonReadBlocked - before.serviceOriginNonReadBlocked),
    allowedOriginDataRequestsBlocked: Math.max(0, after.allowedOriginDataRequestsBlocked - before.allowedOriginDataRequestsBlocked),
  });

/**
 * その読み込みの画面は、描けなかったかもしれないか（T37R-fix-B。T37R の M-2。発見の「読み切れなかった画面」（`SERVICE_READ_REFUSED`）と、READ の確かめの
 * 候補の画面の読み取り・`UNDETERMINED` の決まりが共有する唯一の判定）。READ の詳しい理由の判定（`readCheckAuditStageDetailOf`）が理由を返すか。事実が
 * なければ（監査の段の口がない）偽。
 */
export const isAuditStageReadObstructed = (observation: ReadCheckAuditStageObservation | null): boolean =>
  observation !== null && readCheckAuditStageDetailOf(observation) !== null;

/**
 * 前の実行までの数と、この実行の数を合わせた値（保存に書く）。上限の部品が数えた数（`serviceRequestsAdmitted`）は、前の実行の数から数えているので、
 * そのまま書く。
 */
export function auditStageCountsOf(state: AuditStageRunState): RunCheckpointAuditStageCounts {
  const snapshot = state.monitor.snapshot();
  const budget = state.budget.snapshot();
  return Object.freeze({
    registeredReadRequestsAllowed: saturatingAdd(state.previous.registeredReadRequestsAllowed, snapshot.registeredReadRequestsAllowed),
    tokenRefreshBlocked: saturatingAdd(state.previous.tokenRefreshBlocked, snapshot.tokenRefreshBlocked),
    otherNonReadBlocked: saturatingAdd(state.previous.otherNonReadBlocked, snapshot.otherNonReadBlocked),
    serviceUnauthorizedResponses: saturatingAdd(state.previous.serviceUnauthorizedResponses, state.serviceUnauthorizedResponses),
    serviceRequestsAdmitted: budget.admitted,
    serviceRequestLimitRefused: saturatingAdd(state.previous.serviceRequestLimitRefused, budget.refused),
    // T37R-fix-B2・DEF-141: 前の実行の数から数える（LG-4: 数のない前の版の保存は読まないので、読み替えない）。
    allowedOriginDataRequestsBlocked: saturatingAdd(state.previous.allowedOriginDataRequestsBlocked, snapshot.allowedOriginDataRequestsBlocked),
    serviceRequestPacingWaits: saturatingAdd(state.previous.serviceRequestPacingWaits, state.serviceRequestPacingWaits),
    serviceRequestPacingWaitMs: saturatingAdd(state.previous.serviceRequestPacingWaitMs, state.serviceRequestPacingWaitMs),
  });
}

/** Run の全体で、上限で断った要求があるか（T35R-fix の I-2。1 つでもあれば、Run の理由 `SERVICE_REQUEST_LIMIT_REACHED` を残し、PARTIAL にする）。 */
export function hasServiceRequestLimitRefusal(state: AuditStageRunState): boolean {
  return auditStageCountsOf(state).serviceRequestLimitRefused > 0;
}

/** `run.json` の `authentication`（Run の全体の数と、Run の全体で上限に届いたか。保存だけの数は書かない）。 */
export function runAuthenticationSummaryOf(state: AuditStageRunState): RunAuthenticationSummary {
  const counts = auditStageCountsOf(state);
  return Object.freeze({
    registeredReadRequestsAllowed: counts.registeredReadRequestsAllowed,
    tokenRefreshBlocked: counts.tokenRefreshBlocked,
    otherNonReadBlocked: counts.otherNonReadBlocked,
    serviceUnauthorizedResponses: counts.serviceUnauthorizedResponses,
    serviceRequestLimitReached: state.budget.isLimitReached() || counts.serviceRequestLimitRefused > 0,
    // T37R-fix-B2（設計書 8 章の最後の行）: 許可 Origin への `fetch`・`xhr` の読み取りでない要求を止めた数（記録だけ。判定には使わない）。
    allowedOriginDataRequestsBlocked: counts.allowedOriginDataRequestsBlocked,
    // DEF-141: 1 分あたりの上限で次の読み込みの前に待った回数と時間（Run の全体）。
    serviceRequestPacingWaits: counts.serviceRequestPacingWaits,
    serviceRequestPacingWaitMs: counts.serviceRequestPacingWaitMs,
  });
}
