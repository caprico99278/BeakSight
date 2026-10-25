/**
 * 操作の候補の画面の Server Functions（Task 27 の設計書 4.4、4.7、4.8。T27f）。
 * - 読むだけのもの（候補の画面の値）は GET。発見のジョブの開始は POST だけ。入力は、サーバで `schemas/control/` のスキーマ（`ui-profile-key`、
 *   `ui-discovery-start`）で確かめてから使う（`requestOf`）。開始の判断（プロファイル、改訂、モード、認証の設定、同時に 1 つ）は、ジョブの管理の
 *   `startDiscovery` が開始の直前に行う（I08）。画面の開始できない理由の表示は補助だけ（`auditStartCheckOf`。ジョブの管理と同じ順）。
 * - 候補の一覧は、索引（`readDiscoveryIndex`。最後の発見のジョブに対するドリフト）。詳しい内容は、候補を最後に見た発見のジョブの `discovery.json`
 *   （`discovery-documents.ts`）。返す値は、表示に要るものだけ（入力の値・トークン・選択肢の label は成果物にもなく、見えない欄と秘密に見える名前の
 *   欄の選択肢の値も返さない）。日時は ISO 8601。
 * - 発見のジョブは進み具合（`PROGRESS`）を送らない（T27d の申し送り 5）。ジョブの画面は、種類と状態だけを示す。
 * - T28e（Task 28 の設計書 4.6）: シナリオを使うプロファイルの、最後の発見の結果の登録（CREATE）・更新（UPDATE）の候補に、シナリオを作れる印
 *   （`scenarioCreatable`）を付ける。画面は、その候補にだけ「シナリオを作る」を出す（作成の確かめは、シナリオの保存の部品が行う）。
 * - T38f（Task 38 の設計書 3.7）: API の候補（probe の結果が `API_CREATE`・`API_UPDATE` で欄の範囲を持つ行）には、probe の行ごとに「API のシナリオを
 *   作る」を出す（`apiScenarioRows`。型の digest で行を選んで、作成の画面に渡す）。
 * - T41e-2（Task 41 の設計書 3.3）: 型から API のシナリオを作れない行（欄として識別できないページが決める鍵を持つ更新の型）には、その理由を添える
 *   （`apiScenarioShapeRejectionOf`。下書きの確かめと同じ判定）。
 */
import { createServerFn } from '@tanstack/react-start';
import type { ConfigErrorKind } from '../../../../src/config/config-error.js';
import type {
  CandidateClassification,
  CandidateReasonCode,
  DiscoveryDocument,
  DiscoveryEndReason,
  DiscoveryUnreadReason,
  FormMethod,
  IncompleteReason,
  MethodOverride,
  SubmissionProbeRecord,
} from '../../../../src/control/discovery-view.js';
import { discoverySummaryOf, submissionProbeWriteOf } from '../../../../src/control/discovery-view.js';
import { SCENARIO_KINDS, apiScenarioShapeRejectionOf, type ScenarioDraftRejectionReason } from '../../../../src/control/approval-view.js';
import { usesDiscovery, usesScenarios } from '../display/labels';
import type { DiscoveryIndexDrift } from '../../../../src/control/job/discovery-index-store.js';
// T44g（Task 44 の設計書 P4-8 の CC-105）: ジョブの種類の値は、IPC の契約の名前つきの定数から読む（画面のサーバに同じ定数を置かない）。
import { WORKER_DISCOVERY_JOB_KIND } from '../../../../src/control/worker-protocol.js';
import type { RunStatus } from '../../../../src/core/contracts.js';
import type { AuditJobStartView, AuditStartCheckView } from './audit-job-functions';
import { auditStartCheckOf, startRejectionViewOf } from './audit-start-check';
import { localUiAuditJobs } from './audit-jobs';
import {
  candidateDetailViewOf,
  candidateOfDocument,
  discoveryProfileViewOf,
  isReadCheckTarget,
  readDiscoveryDocuments,
  showsOriginsOf,
  submissionProbesOfDocument,
  type DiscoveryCandidateDetailView,
  type DiscoveryProfileView,
} from './discovery-documents';
import { requestOf } from './request-validation';
import { readProfileStart } from './start-check-inputs';
import { isoTimestampOf } from './timestamps';

// ---------------------------------------------------------------------------------------------------------------
// 画面に返す値
// ---------------------------------------------------------------------------------------------------------------

/** 候補の一覧の 1 件（索引と、詳しい内容）。 */
export interface DiscoveryCandidateView {
  readonly identityDigest: string;
  readonly classification: CandidateClassification;
  readonly reasonCode: CandidateReasonCode;
  readonly drift: DiscoveryIndexDrift;
  readonly hasStateField: boolean;
  readonly pagePath: string;
  readonly actionPath: string | null;
  readonly formMethod: FormMethod | null;
  readonly methodOverride: MethodOverride | null;
  /** 日時は ISO 8601。 */
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly lastSeenJobId: string;
  /** READ の確かめの対象にできるか（分類が READ で、最後の発見のジョブの結果にある）。 */
  readonly readCheckable: boolean;
  /**
   * シナリオを作れる候補か（T28e。分類がシナリオの種類（`SCENARIO_KINDS`。登録・更新）で、最後の発見のジョブの結果にあり、プロファイルが
   * シナリオを使う（`usesScenarios`）。ほかの分類には「シナリオを作る」を出さない）。
   */
  readonly scenarioCreatable: boolean;
  /**
   * T38f（Task 38 の設計書 3.7）: API のシナリオを作れる probe の行（結果が `API_CREATE`・`API_UPDATE` で、欄の範囲 `inputFields` を持つ行。型の
   * digest と、型の method・path の型。シナリオを使うプロファイルの、最後の発見の結果の候補だけ。作成の確かめは、シナリオの保存の部品が行う）。
   */
  readonly apiScenarioRows: readonly DiscoveryApiScenarioRowView[];
  /** 詳しい内容（候補を最後に見た発見のジョブの `discovery.json` を読めなければ null）。 */
  readonly detail: DiscoveryCandidateDetailView | null;
}

/** T38f: API のシナリオを作れる probe の行 1 つ。 */
export interface DiscoveryApiScenarioRowView {
  readonly shapeDigest: string;
  readonly method: string;
  readonly pathShape: string;
  /**
   * T41e-2（Task 41 の設計書 3.3）: その型から API のシナリオを作れない理由（下書きの確かめと同じ判定 `apiScenarioShapeRejectionOf`。作れるなら null）。
   * 理由があれば、画面は作成の画面へのリンクの代わりに理由を出す。
   */
  readonly rejection: ScenarioDraftRejectionReason | null;
}

/**
 * T38f: API のシナリオを作れる probe の行（型の digest の重なりなし。行の順）。T38R-fix の M-2: 書き込みの probe の結果は、契約の 1 か所
 * （`submissionProbeWriteOf`）。作成の確かめは下書きの確かめ。
 */
const apiScenarioRowsOf = (probes: readonly SubmissionProbeRecord[]): readonly DiscoveryApiScenarioRowView[] => {
  const rows = probes.flatMap((probe) => (submissionProbeWriteOf(probe.result) !== null && probe.inputFields !== undefined && probe.shapeDigest !== null
    && probe.shape !== null
    ? [{ shapeDigest: probe.shapeDigest, method: probe.shape.method, pathShape: probe.shape.pathShape, rejection: apiScenarioShapeRejectionOf(probe) }]
    : []));
  return rows.filter((row, index) => rows.findIndex(({ shapeDigest }) => shapeDigest === row.shapeDigest) === index);
};

/** 読まなかった理由ごとの数。 */
export interface DiscoveryUnreadCountView {
  readonly reason: DiscoveryUnreadReason;
  readonly count: number;
}

/** 読み切れなかった画面（場所が分からなければ、伏せ字の後の URL）。 */
export interface DiscoveryIncompletePageView {
  readonly origin: string | null;
  readonly path: string | null;
  readonly url: string;
  readonly reasons: readonly IncompleteReason[];
}

/** 最後の発見のジョブの結果の要点（`discovery.json` から）。 */
export interface DiscoveryResultView {
  readonly endReason: DiscoveryEndReason;
  readonly runStatus: RunStatus;
  readonly maxPages: number;
  readonly pagesRead: number;
  readonly pagesNotRead: number;
  readonly unreadReasons: readonly DiscoveryUnreadCountView[];
  readonly incompletePages: readonly DiscoveryIncompletePageView[];
}

/** 最後の発見のジョブ。 */
export interface DiscoveryLatestView {
  readonly jobId: string;
  /** 記録した日時（ISO 8601）。 */
  readonly recordedAt: string;
  /** `discovery.json` を読めなければ null。 */
  readonly result: DiscoveryResultView | null;
}

/** 操作の候補の画面の値。 */
export interface DiscoveryPageView {
  readonly profile: DiscoveryProfileView;
  /** このプロファイルで発見を行うか（`usesDiscovery`。T28b で `execution-policy.ts` の `DISCOVERY` の行の判定にした）。 */
  readonly eligible: boolean;
  /** 発見を始められない理由（ジョブの管理と同じ順の確かめ）。 */
  readonly start: AuditStartCheckView;
  readonly configError: ConfigErrorKind | null;
  /** 許可 Origin が 2 つ以上あり、画面の Origin を示して区別する（T27c の申し送り 3）。 */
  readonly showOrigins: boolean;
  readonly latest: DiscoveryLatestView | null;
  readonly candidates: readonly DiscoveryCandidateView[];
}


/** 最後の発見のジョブの結果の要点を作る。 */
const resultViewOf = (document: DiscoveryDocument): DiscoveryResultView => {
  const summary = discoverySummaryOf(document);
  const unread = new Map<DiscoveryUnreadReason, number>();
  const incompletePages: DiscoveryIncompletePageView[] = [];
  for (const page of document.pages) {
    if (page.state === 'NOT_READ') {
      unread.set(page.reason, (unread.get(page.reason) ?? 0) + 1);
    } else if (page.record.incompleteReasons.length > 0) {
      incompletePages.push({
        origin: page.record.location?.origin ?? null,
        path: page.record.location?.path ?? null,
        url: page.url,
        reasons: [...page.record.incompleteReasons],
      });
    }
  }
  return {
    endReason: document.endReason,
    runStatus: document.runStatus,
    maxPages: document.maxPages,
    pagesRead: summary.pagesRead,
    pagesNotRead: summary.pagesNotRead,
    unreadReasons: [...unread].map(([reason, count]) => ({ reason, count })),
    incompletePages,
  };
};

// ---------------------------------------------------------------------------------------------------------------
// 入力（形は `requestOf` でスキーマを使って確かめる）
// ---------------------------------------------------------------------------------------------------------------

interface ProfileKeyRequest {
  readonly profileId: string;
}
interface DiscoveryStartRequest {
  readonly profileId: string;
  readonly expectedRevision: number;
}

// ---------------------------------------------------------------------------------------------------------------
// Server Functions
// ---------------------------------------------------------------------------------------------------------------

/** 操作の候補の画面の値（読むだけ）。プロファイルがなければ `null`。 */
export const discoveryPageFn = createServerFn({ method: 'GET' })
  .validator(requestOf<ProfileKeyRequest>('ui-profile-key'))
  .handler(async ({ data }): Promise<DiscoveryPageView | null> => {
    const reading = await readProfileStart(data.profileId);
    if (reading === null) {
      return null;
    }
    const { stored } = reading;
    const check = auditStartCheckOf({ ...reading.checkInput, jobKind: WORKER_DISCOVERY_JOB_KIND });
    const documents = await readDiscoveryDocuments(stored.profile.profileId);
    const { index, latest } = documents;
    const scenarioProfile = usesScenarios(stored.profile.mode, stored.profile.auth);
    const candidates: DiscoveryCandidateView[] = [];
    for (const entry of index.candidates) {
      const lastSeen = await documents.documentOf(entry.lastSeenJobId);
      const candidate = candidateOfDocument(lastSeen, entry.identityDigest);
      const inLatest = entry.lastSeenJobId === index.latestJobId && candidateOfDocument(latest, entry.identityDigest) !== null;
      candidates.push({
        identityDigest: entry.identityDigest,
        classification: entry.classification,
        reasonCode: entry.reasonCode,
        drift: entry.drift,
        hasStateField: entry.hasStateField,
        pagePath: entry.pagePath,
        actionPath: entry.actionPath,
        formMethod: entry.formMethod,
        methodOverride: entry.methodOverride,
        firstSeenAt: isoTimestampOf(entry.firstSeenAt),
        lastSeenAt: isoTimestampOf(entry.lastSeenAt),
        lastSeenJobId: entry.lastSeenJobId,
        readCheckable: inLatest && isReadCheckTarget(entry),
        scenarioCreatable: scenarioProfile && inLatest && SCENARIO_KINDS.some((kind) => kind === entry.classification),
        // T38f: API のシナリオは、最後の発見の結果の probe の行ごとに作れる。
        apiScenarioRows: scenarioProfile && inLatest ? apiScenarioRowsOf(submissionProbesOfDocument(latest, entry.identityDigest)) : [],
        // T37c: 同じ識別の digest の行の、送らずに観察する probe の結果（型ごと）も添える。
        detail: candidate === null ? null : candidateDetailViewOf(candidate, submissionProbesOfDocument(lastSeen, entry.identityDigest)),
      });
    }
    return {
      profile: discoveryProfileViewOf(stored),
      eligible: usesDiscovery(stored.profile.mode, stored.profile.auth),
      start: { blocker: check.blocker, errorCodes: check.errorCodes, authSetupErrors: check.authSetupErrors, nextAllowedAt: check.nextAllowedAt },
      configError: reading.configError,
      showOrigins: showsOriginsOf(stored),
      latest: index.latestJobId === null || index.latestSeenAt === null
        ? null
        : { jobId: index.latestJobId, recordedAt: isoTimestampOf(index.latestSeenAt), result: latest === null ? null : resultViewOf(latest) },
      candidates,
    };
  });

/** 操作の候補の発見を始める（開始の判断はジョブの管理が開始の直前に行う）。 */
export const startDiscoveryFn = createServerFn({ method: 'POST' })
  .validator(requestOf<DiscoveryStartRequest>('ui-discovery-start'))
  .handler(async ({ data }): Promise<AuditJobStartView> => {
    const result = await localUiAuditJobs().startDiscovery({ profileId: data.profileId, expectedRevision: data.expectedRevision });
    return result.ok
      ? { ok: true, jobId: result.job.jobId }
      : { ok: false, ...startRejectionViewOf(result) };
  });
