/**
 * READ の確かめの画面の Server Functions（Task 27 の設計書 4.5、4.7、4.8。T27f）。
 * - 読むだけのもの（画面の値）は GET。定義の作成・変更・削除と、READ の確かめのジョブの開始は POST だけ。入力は、サーバで `schemas/control/` の
 *   スキーマ（`ui-profile-key`、`ui-read-check-create`・`-update`・`-cancel`・`-start`）で確かめてから使う（`requestOf`）。
 * - 定義の保存: 対象の候補は、最後の発見のジョブの `discovery.json` から、識別の digest で読む（同じ digest の候補をまとめた後。
 *   `discovery-documents.ts`）。定義は `validateReadCheckDefinition`（候補に照らす検証の唯一の owner）を通し、保存は `createReadCheck`・
 *   `updateReadCheck`（形と秘密に見える名前の確かめ直し、版、上限、取り消したプロファイルの拒否は保存の部品）。拒むときは、理由のコードと、
 *   項目（送る値の欄の名前）ごとの誤りを返す（英語の詳しい文は返さない）。取り消したプロファイルは、保存の部品の前にも拒む（T27c の申し送り 6）。
 * - 「削除」は、定義を一覧から外す（`cancelReadCheck`。行は消さずに、取り消した時刻を書く）。取り消したプロファイルでもできる。
 * - 開始の判断（プロファイル、改訂、モード、定義の数、認証の設定、同時に 1 つ）は、ジョブの管理の `startReadCheck` が開始の直前に行う（I08）。
 * - 結果: 最近の結果（`readRecentReadCheckResults`）を、ジョブごとにまとめ、そのジョブの `read-evidence.json`（スキーマとジョブの ID を確かめる）から、
 *   詳しい理由と、期待ごとの結果の要約（件数と照らした項目と取れた値だけ）を足す。READ のジョブは進み具合を送らない（T27d の申し送り 5）。
 * - 送る値（テスト環境のテスト用の値）は、設計どおり、この画面に出す（設計書 4.5）。資格情報・Cookie・トークンの口はない。
 * - T37d（Task 37 の設計書 3.5）: 画面の path を読む定義。選べる画面の path は、直近の発見のジョブの結果の読めた画面（開始の URL と同じ Origin）から
 *   返す（読めなければ空。画面は入力の欄だけ）。保存の検証には、開始の URL・許可 Origin・認証の設定の除外の文脈（`read-check-page-context.ts` の `readCheckPageContextOf`）を渡す。結果には、
 *   成果物の対象の種類と画面の path を足す。
 */
import { randomUUID } from 'node:crypto';
import { createServerFn } from '@tanstack/react-start';
import type { ConfigErrorKind } from '../../../../src/config/config-error.js';
import { RECORD_ID_PLACEHOLDER } from '../../../../src/control/approval-view.js';
import {
  MAX_READ_CHECK_DEFINITIONS_PER_PROFILE,
  MAX_READ_CHECK_DETAIL_FIELD_LENGTH,
  MAX_READ_CHECK_EXPECTATIONS,
  MAX_READ_CHECK_EXPECTED_TEXT_LENGTH,
  MAX_READ_CHECK_PARAMETER_VALUE_LENGTH,
  MAX_READ_CHECK_ROW_COUNT,
  MAX_READ_CHECK_PAGE_PATH_LENGTH,
  READ_CHECK_EXPECTATION_KINDS,
  READ_CHECK_TARGET_KINDS,
  readCheckTargetKindOf,
  type ReadCheckTargetKind,
  type CandidateFieldTag,
  type CandidateFieldType,
  type DiscoveryCandidate,
  type ReadCheckDefinition,
  type ReadCheckDetail,
  type ReadCheckEndReason,
  type ReadCheckExpectation,
  type ReadCheckExpectationKind,
  type ReadCheckResult,
  type ReadEvidenceDocument,
  type ReadExpectationEvidence,
  type ReadExpectationResult,
  type ReadExpectationUndeterminedReason,
  type ReadRowSource,
} from '../../../../src/control/discovery-view.js';
// PRE42-CC 組 3（N4-8b）: 終わったジョブの状態は、owner の `job-records.ts` の名前つきの定数から読む。
import { FINISHED_AUDIT_JOB_STATE } from '../../../../src/control/job/job-records.js';
import {
  cancelReadCheck,
  createReadCheck,
  listReadChecks,
  readReadCheck,
  readRecentReadCheckResults,
  updateReadCheck,
  type ReadCheckResultView,
  type ReadCheckStoreResult,
} from '../../../../src/control/job/read-check-store.js';
// T44g（Task 44 の設計書 P4-8 の CC-105）: ジョブの種類の値は、IPC の契約の名前つきの定数から読む（画面のサーバに同じ定数を置かない）。
import { WORKER_READ_CHECK_JOB_KIND } from '../../../../src/control/worker-protocol.js';
import { validateReadCheckDefinition, type ReadCheckDefinitionRejectionReason } from '../../../../src/control/read-check-policy.js';
import { getProfile } from '../../../../src/control/store/profile-store.js';
import { READ_EVIDENCE_ARTIFACT_FILE_NAME } from '../../../../src/core/artifact-layout.js';
import { isRecord } from '../../../../src/core/guards.js';
import { ACTIVE_PROFILE_STATUS } from '../../../../src/control/store/profile-records.js';
import { usesReadCheck } from '../display/labels';
import { artifactRoutePath } from '../security/artifact-route';
import type { AuditJobStartView, AuditStartCheckView } from './audit-job-functions';
import { auditStartCheckOf, startRejectionViewOf } from './audit-start-check';
import { localUiAuditJobs } from './audit-jobs';
import { localUiStore } from './control-store';
import {
  candidateFieldViewOf,
  candidateOfDocument,
  discoveryProfileViewOf,
  isReadCheckTarget,
  mergedCandidatesOf,
  readDiscoveryDocuments,
  readEvidenceDocumentOfJob,
  showsOriginsOf,
  type DiscoveryProfileView,
} from './discovery-documents';
import { requestOf } from './request-validation';
import { readCheckPageContextOf, readCheckPagePathsOf } from './read-check-page-context';
import { readProfileStart } from './start-check-inputs';
import { isoTimestampOf, nowCompactTimestamp } from './timestamps';

// ---------------------------------------------------------------------------------------------------------------
// 画面に返す値
// ---------------------------------------------------------------------------------------------------------------

/** 定義の入力の欄 1 件（値を送れる欄だけ。値と label は持たない）。 */
export interface ReadCheckFieldView {
  readonly name: string;
  readonly tag: CandidateFieldTag;
  readonly type: CandidateFieldType;
  /** 選択肢の値（見えない欄と秘密に見える名前の欄は返さない）。 */
  readonly options: readonly string[] | null;
  readonly omittedOptionCount: number;
  /** 秘密に見える名前の欄か（値を入れても保存のときに拒む）。 */
  readonly secretLike: boolean;
}

/** READ の確かめに使える候補（最後の発見のジョブの結果から）。 */
export interface ReadCheckCandidateView {
  readonly identityDigest: string;
  readonly pageOrigin: string;
  readonly pagePath: string;
  readonly actionOrigin: string | null;
  readonly actionPath: string | null;
  /** 送信ボタンの分類の語（T27R-fix-1。DEF-086。ボタンの文言は持たない）。 */
  readonly submitterWords: readonly string[];
  /** 値を送れる欄（同じ名前の欄は 1 つにまとめる。欄の順）。 */
  readonly fields: readonly ReadCheckFieldView[];
}

/** 定義 1 件（取り消していないもの）。 */
export interface ReadCheckDefinitionView {
  readonly readCheckId: string;
  readonly revision: number;
  /** 送る値（テスト用の値）と期待（設計どおり画面に出す）。 */
  readonly definition: ReadCheckDefinition;
  /** 日時は ISO 8601。 */
  readonly createdAt: string;
  readonly updatedAt: string;
  /** 対象の候補（最後の発見のジョブの結果になければ null。画面の path の定義は null）。 */
  readonly candidate: ReadCheckCandidateView | null;
  /** T37d: 対象の種類（候補を読む・画面を読む）と、画面の path（画面のときだけ）。 */
  readonly targetKind: ReadCheckTargetKind;
  readonly targetPagePath: string | null;
}

/** 期待 1 件の結果の要約（照らした項目と取れた値だけ）。 */
export interface ReadExpectationResultView {
  readonly expectation: ReadCheckExpectation;
  readonly result: ReadExpectationResult;
  readonly undeterminedReason: ReadExpectationUndeterminedReason | null;
  readonly rowSource: ReadRowSource | null;
  readonly observedRowCount: number | null;
  readonly found: boolean | null;
  readonly observedValue: string | null;
}

/** 定義 1 件の結果。 */
export interface ReadCheckResultItemView {
  readonly readCheckId: string;
  readonly readCheckRevision: number;
  readonly result: ReadCheckResult;
  /** 記録した日時（ISO 8601）。 */
  readonly recordedAt: string;
  /** 詳しい理由（`read-evidence.json` を読めなければ null）。 */
  readonly detail: ReadCheckDetail | null;
  /** T37d: 対象の種類と画面の path（`read-evidence.json` から。読めなければ null）。 */
  readonly targetKind: ReadCheckTargetKind | null;
  readonly targetPagePath: string | null;
  readonly httpStatus: number | null;
  readonly expectations: readonly ReadExpectationResultView[];
}

/** 確かめなかった定義 1 件（`read-evidence.json` から）。 */
export interface ReadCheckNotExecutedView {
  readonly readCheckId: string;
  readonly readCheckRevision: number;
  readonly reason: ReadCheckEndReason;
}

/** 1 回の READ の確かめのジョブの結果。 */
export interface ReadCheckJobResultsView {
  readonly jobId: string;
  /** 記録した日時（最後の結果。ISO 8601）。 */
  readonly recordedAt: string;
  /** `read-evidence.json` の成果物の URL（読めなければ null）。 */
  readonly evidenceHref: string | null;
  readonly endReason: ReadCheckEndReason | null;
  readonly results: readonly ReadCheckResultItemView[];
  readonly notExecuted: readonly ReadCheckNotExecutedView[];
}

/** 定義のフォームの決まり（契約の閉じた一覧と上限。画面の入力の欄の上限と選択肢に使う）。 */
export interface ReadCheckFormView {
  readonly expectationKinds: readonly ReadCheckExpectationKind[];
  readonly maxParameterValueLength: number;
  readonly maxExpectations: number;
  readonly maxRowCount: number;
  readonly maxExpectedTextLength: number;
  readonly maxDetailFieldLength: number;
  readonly maxDefinitions: number;
  /** T37d: 定義の対象の種類（表示の順）と、画面の path の最大長。 */
  readonly targetKinds: readonly ReadCheckTargetKind[];
  readonly maxPagePathLength: number;
  /** T38f: 画面の path の型のレコードの ID の区切りの印（契約の値。`{id}` つきの型の案内に使う）。 */
  readonly pageTemplatePlaceholder: string;
}

/** READ の確かめの画面の値。 */
export interface ReadCheckPageView {
  readonly profile: DiscoveryProfileView;
  /** このプロファイルで READ の確かめを行うか（`usesReadCheck`。T28b で `execution-policy.ts` の `READ_CHECK` の行の判定にした）。 */
  readonly eligible: boolean;
  /** 定義を作り・変えられるか（行うプロファイルで、取り消していない）。 */
  readonly editable: boolean;
  /** READ の確かめを始められない理由（ジョブの管理と同じ順の確かめ）。 */
  readonly start: AuditStartCheckView;
  readonly configError: ConfigErrorKind | null;
  readonly showOrigins: boolean;
  readonly latestDiscoveryJobId: string | null;
  readonly candidates: readonly ReadCheckCandidateView[];
  /**
   * T37d: 画面を読む定義で選べる画面の path（直近の発見のジョブの結果の、読めた画面のうち、開始の URL と同じ Origin のもの。文書の順で重なりなし。
   * 読めなければ空。画面は入力の欄だけを出す）。
   */
  readonly pagePaths: readonly string[];
  readonly definitions: readonly ReadCheckDefinitionView[];
  readonly results: readonly ReadCheckJobResultsView[];
  readonly form: ReadCheckFormView;
}

/** 保存の誤り 1 件（送る値の誤りは、その欄の名前）。 */
export interface ReadCheckErrorView {
  readonly code: ReadCheckDefinitionRejectionReason;
  readonly parameter: string | null;
}

/** 定義の保存（作成・変更）の結果。 */
export type ReadCheckSaveView =
  | { readonly ok: true; readonly readCheckId: string; readonly revision: number }
  | { readonly ok: false; readonly reason: ReadCheckDefinitionRejectionReason; readonly errors: readonly ReadCheckErrorView[] };

/** 定義の削除の結果。 */
export type ReadCheckCancelView = { readonly ok: true } | { readonly ok: false; readonly reason: ReadCheckDefinitionRejectionReason };


// 定義を作り・変えてよいプロファイルの状態（`ACTIVE_PROFILE_STATUS`）は、owner の `profile-records.ts` から読む（FM2R の Minor 13）。

const FORM_VIEW: ReadCheckFormView = Object.freeze({
  expectationKinds: READ_CHECK_EXPECTATION_KINDS,
  maxParameterValueLength: MAX_READ_CHECK_PARAMETER_VALUE_LENGTH,
  maxExpectations: MAX_READ_CHECK_EXPECTATIONS,
  maxRowCount: MAX_READ_CHECK_ROW_COUNT,
  maxExpectedTextLength: MAX_READ_CHECK_EXPECTED_TEXT_LENGTH,
  maxDetailFieldLength: MAX_READ_CHECK_DETAIL_FIELD_LENGTH,
  maxDefinitions: MAX_READ_CHECK_DEFINITIONS_PER_PROFILE,
  targetKinds: READ_CHECK_TARGET_KINDS,
  maxPagePathLength: MAX_READ_CHECK_PAGE_PATH_LENGTH,
  pageTemplatePlaceholder: RECORD_ID_PLACEHOLDER,
});

// T37d: 画面の path の定義を確かめる文脈と、選べる画面の path は、`read-check-page-context.ts`（FM2b でシナリオの下書きの自動の作成と共用するために移した）。

/** READ の確かめに使える候補を、画面に返す値にする（値を送れる欄だけ。同じ名前の欄は最初の 1 つ）。 */
const readCheckCandidateViewOf = (candidate: DiscoveryCandidate): ReadCheckCandidateView => {
  const seen = new Set<string>();
  const fields: ReadCheckFieldView[] = [];
  for (const field of candidate.fields) {
    const view = candidateFieldViewOf(candidate, field);
    if (!view.sendable || seen.has(view.name)) {
      continue;
    }
    seen.add(view.name);
    fields.push({ name: view.name, tag: view.tag, type: view.type, options: view.options, omittedOptionCount: view.omittedOptionCount, secretLike: view.secretLike });
  }
  return {
    identityDigest: candidate.identityDigest,
    pageOrigin: candidate.page.origin,
    pagePath: candidate.page.path,
    actionOrigin: candidate.action?.origin ?? null,
    actionPath: candidate.action?.path ?? null,
    submitterWords: [...candidate.submitterWords],
    fields,
  };
};

/** 期待 1 件の結果を、画面に返す値にする（照らした項目と取れた値だけ）。 */
const expectationViewOf = (evidence: ReadExpectationEvidence): ReadExpectationResultView => ({
  expectation: structuredClone(evidence.expectation),
  result: evidence.result,
  undeterminedReason: evidence.undeterminedReason,
  rowSource: 'rowSource' in evidence ? evidence.rowSource : null,
  observedRowCount: 'observedRowCount' in evidence ? evidence.observedRowCount : null,
  found: 'found' in evidence ? evidence.found : null,
  observedValue: 'observedValue' in evidence ? evidence.observedValue : null,
});

/** T44e（Task 44 の設計書 P2-5）: 結果の記録が 1 件もない READ の確かめのジョブを、結果の一覧に足す数の上限（新しい順）。 */
const MAX_UNRECORDED_READ_CHECK_JOBS = 5;

/**
 * T44e（Task 44 の設計書 P2-5）: 最初の定義の前に止まった（結果の記録が 1 件もない）、終わった READ の確かめのジョブ（新しい順。上限
 * `MAX_UNRECORDED_READ_CHECK_JOBS`）。`read-evidence.json` を読めたものだけを、止まった理由と確かめなかった定義つきで並べる。
 */
const unrecordedJobsViewOf = async (profileId: string, recordedJobIds: ReadonlySet<string>): Promise<readonly ReadCheckJobResultsView[]> => {
  const jobs = localUiAuditJobs().listAuditJobs()
    .filter((job) => job.profileId === profileId && job.jobKind === WORKER_READ_CHECK_JOB_KIND && job.state === FINISHED_AUDIT_JOB_STATE && !recordedJobIds.has(job.jobId))
    .slice(0, MAX_UNRECORDED_READ_CHECK_JOBS);
  const views: ReadCheckJobResultsView[] = [];
  for (const job of jobs) {
    const evidence: ReadEvidenceDocument | null = await readEvidenceDocumentOfJob(job.jobId);
    if (evidence === null) {
      continue;
    }
    views.push({
      jobId: job.jobId,
      recordedAt: isoTimestampOf(job.finishedAt ?? job.createdAt),
      evidenceHref: artifactRoutePath(job.jobId, READ_EVIDENCE_ARTIFACT_FILE_NAME),
      endReason: evidence.endReason,
      results: [],
      notExecuted: evidence.checks.flatMap((check) => (check.state === 'NOT_EXECUTED'
        ? [{ readCheckId: check.readCheckId, readCheckRevision: check.readCheckRevision, reason: check.reason }]
        : [])),
    });
  }
  return views;
};

/** 最近の結果を、ジョブごとにまとめ（新しい順）、`read-evidence.json` の詳しい理由を足す。 */
const resultsViewOf = async (results: readonly ReadCheckResultView[]): Promise<readonly ReadCheckJobResultsView[]> => {
  const byJob = new Map<string, ReadCheckResultView[]>();
  for (const result of results) {
    const group = byJob.get(result.jobId) ?? [];
    group.push(result);
    byJob.set(result.jobId, group);
  }
  const views: ReadCheckJobResultsView[] = [];
  for (const [jobId, group] of byJob) {
    const evidence: ReadEvidenceDocument | null = await readEvidenceDocumentOfJob(jobId);
    const checks = evidence?.checks ?? [];
    views.push({
      jobId,
      recordedAt: isoTimestampOf(group.reduce((latest, result) => (result.recordedAt > latest ? result.recordedAt : latest), group[0]?.recordedAt ?? '')),
      evidenceHref: evidence === null ? null : artifactRoutePath(jobId, READ_EVIDENCE_ARTIFACT_FILE_NAME),
      endReason: evidence?.endReason ?? null,
      results: [...group].reverse().map((result) => {
        const executed = checks.find((check) => check.readCheckId === result.readCheckId && check.state === 'EXECUTED');
        const check = executed !== undefined && executed.state === 'EXECUTED' ? executed : null;
        return {
          readCheckId: result.readCheckId,
          readCheckRevision: result.readCheckRevision,
          result: result.result,
          recordedAt: isoTimestampOf(result.recordedAt),
          detail: check?.detail ?? null,
          targetKind: check?.targetKind ?? null,
          targetPagePath: check?.targetPagePath ?? null,
          httpStatus: check?.httpStatus ?? null,
          expectations: check === null ? [] : check.expectations.map(expectationViewOf),
        };
      }),
      notExecuted: checks.flatMap((check) => (check.state === 'NOT_EXECUTED'
        ? [{ readCheckId: check.readCheckId, readCheckRevision: check.readCheckRevision, reason: check.reason }]
        : [])),
    });
  }
  return views;
};

/** T44e: 記録のある結果と、記録のないジョブを、記録した日時の新しい順に並べる。 */
const allResultsViewOf = async (profileId: string, results: readonly ReadCheckResultView[]): Promise<readonly ReadCheckJobResultsView[]> => {
  const recorded = await resultsViewOf(results);
  const unrecorded = await unrecordedJobsViewOf(profileId, new Set(results.map(({ jobId }) => jobId)));
  return [...recorded, ...unrecorded].sort((left, right) => right.recordedAt.localeCompare(left.recordedAt));
};

/** 保存の拒否（理由のコードと、項目ごとの誤り）。 */
const saveRejected = (reason: ReadCheckDefinitionRejectionReason, errors: readonly ReadCheckErrorView[] = []): ReadCheckSaveView =>
  ({ ok: false, reason, errors: errors.length === 0 ? [{ code: reason, parameter: null }] : errors });

/** 保存の部品の結果を、画面に返す値にする。 */
const saveViewOf = (result: ReadCheckStoreResult): ReadCheckSaveView =>
  (result.ok ? { ok: true, readCheckId: result.readCheck.readCheckId, revision: result.readCheck.revision } : saveRejected(result.reason));

/** 定義の対象の識別の digest（形が違えば空の文字列。形の誤りは検証が返す）。 */
const targetDigestOf = (definition: unknown): string =>
  (isRecord(definition) && typeof definition['targetIdentityDigest'] === 'string' ? definition['targetIdentityDigest'] : '');

/**
 * 定義を、最後の発見のジョブの候補に照らして確かめる（`validateReadCheckDefinition`）。拒むときは、画面に返す値（最初の誤りの理由と、項目ごとの
 * 誤り）。受けるときは、確かめた定義。
 */
const checkedDefinitionOf = async (
  profileId: string,
  definition: unknown,
): Promise<{ readonly ok: true; readonly definition: ReadCheckDefinition } | Extract<ReadCheckSaveView, { ok: false }>> => {
  const { latest } = await readDiscoveryDocuments(profileId);
  // T37d: 画面の path の定義は、開始の URL・許可 Origin・認証の設定の除外に照らす（候補は見ない）。
  const reading = await readProfileStart(profileId);
  const page = reading === null ? null : readCheckPageContextOf(reading);
  const validation = validateReadCheckDefinition(definition, candidateOfDocument(latest, targetDigestOf(definition)), page);
  if (validation.ok) {
    return { ok: true, definition: validation.definition };
  }
  const [first] = validation.errors;
  return {
    ok: false,
    reason: first?.code ?? 'READ_CHECK_INPUT_INVALID',
    errors: validation.errors.map(({ code, parameter }) => ({ code, parameter })),
  };
};

/** 今の時刻（管理データの UTC の 14 桁。owner は `timestamps.ts`）。 */
const nowStamp = nowCompactTimestamp;

// ---------------------------------------------------------------------------------------------------------------
// 入力（形は `requestOf` でスキーマを使って確かめる）
// ---------------------------------------------------------------------------------------------------------------

interface ProfileKeyRequest {
  readonly profileId: string;
}
interface ReadCheckStartRequest {
  readonly profileId: string;
  readonly expectedRevision: number;
}
interface ReadCheckCreateRequest {
  readonly profileId: string;
  readonly definition: Readonly<Record<string, unknown>>;
}
interface ReadCheckUpdateRequest {
  readonly readCheckId: string;
  readonly expectedRevision: number;
  readonly definition: Readonly<Record<string, unknown>>;
}
interface ReadCheckCancelRequest {
  readonly readCheckId: string;
  readonly expectedRevision: number;
}

// ---------------------------------------------------------------------------------------------------------------
// Server Functions
// ---------------------------------------------------------------------------------------------------------------

/** READ の確かめの画面の値（読むだけ）。プロファイルがなければ `null`。 */
export const readCheckPageFn = createServerFn({ method: 'GET' })
  .validator(requestOf<ProfileKeyRequest>('ui-profile-key'))
  .handler(async ({ data }): Promise<ReadCheckPageView | null> => {
    const reading = await readProfileStart(data.profileId);
    if (reading === null) {
      return null;
    }
    const { stored } = reading;
    const { profileId } = stored.profile;
    const database = localUiStore();
    const definitions = listReadChecks(database, profileId);
    const check = auditStartCheckOf({ ...reading.checkInput, jobKind: WORKER_READ_CHECK_JOB_KIND, readCheckDefinitionCount: definitions.length });
    const { index, latest } = await readDiscoveryDocuments(profileId);
    const eligible = usesReadCheck(stored.profile.mode, stored.profile.auth);
    return {
      profile: discoveryProfileViewOf(stored),
      eligible,
      editable: eligible && stored.status === ACTIVE_PROFILE_STATUS,
      start: { blocker: check.blocker, errorCodes: check.errorCodes, authSetupErrors: check.authSetupErrors, nextAllowedAt: check.nextAllowedAt },
      configError: reading.configError,
      showOrigins: showsOriginsOf(stored),
      latestDiscoveryJobId: index.latestJobId,
      candidates: mergedCandidatesOf(latest).filter(isReadCheckTarget).map(readCheckCandidateViewOf),
      pagePaths: readCheckPagePathsOf(latest, reading),
      definitions: definitions.map((view) => {
        const { targetIdentityDigest, targetPagePath } = view.definition;
        const candidate = targetIdentityDigest === undefined ? null : candidateOfDocument(latest, targetIdentityDigest);
        return {
          readCheckId: view.readCheckId,
          revision: view.revision,
          definition: structuredClone(view.definition) as ReadCheckDefinition,
          createdAt: isoTimestampOf(view.createdAt),
          updatedAt: isoTimestampOf(view.updatedAt),
          candidate: candidate === null || !isReadCheckTarget(candidate) ? null : readCheckCandidateViewOf(candidate),
          targetKind: readCheckTargetKindOf(view.definition),
          targetPagePath: targetPagePath ?? null,
        };
      }),
      results: await allResultsViewOf(profileId, readRecentReadCheckResults(database, profileId)),
      form: FORM_VIEW,
    };
  });

/** READ の確かめの定義を作る（候補に照らす検証の後に保存する）。 */
export const createReadCheckFn = createServerFn({ method: 'POST' })
  .validator(requestOf<ReadCheckCreateRequest>('ui-read-check-create'))
  .handler(async ({ data }): Promise<ReadCheckSaveView> => {
    const database = localUiStore();
    const stored = getProfile(database, data.profileId);
    if (stored === null) {
      return saveRejected('READ_CHECK_PROFILE_NOT_FOUND');
    }
    if (stored.status !== ACTIVE_PROFILE_STATUS) {
      return saveRejected('READ_CHECK_PROFILE_RETIRED');
    }
    // T28b fix round 1: READ の確かめを許すモードと認証の方式か（`execution-policy.ts` の `READ_CHECK` の行。候補の検証の前。管理の側の保存も同じ
    // 判定で確かめ直す）。
    if (!usesReadCheck(stored.profile.mode, stored.profile.auth)) {
      return saveRejected('READ_CHECK_PROFILE_NOT_ELIGIBLE');
    }
    const checked = await checkedDefinitionOf(data.profileId, data.definition);
    if (!checked.ok) {
      return checked;
    }
    return saveViewOf(createReadCheck(database, {
      readCheckId: randomUUID(),
      profileId: data.profileId,
      definition: checked.definition,
      at: nowStamp('READ check creation time'),
    }));
  });

/** READ の確かめの定義を変える（画面が読んだ版と同じときだけ）。 */
export const updateReadCheckFn = createServerFn({ method: 'POST' })
  .validator(requestOf<ReadCheckUpdateRequest>('ui-read-check-update'))
  .handler(async ({ data }): Promise<ReadCheckSaveView> => {
    const database = localUiStore();
    const current = readReadCheck(database, data.readCheckId);
    if (current === null) {
      return saveRejected('READ_CHECK_NOT_FOUND');
    }
    if (current.canceledAt !== null) {
      return saveRejected('READ_CHECK_CANCELED');
    }
    if (current.revision !== data.expectedRevision) {
      return saveRejected('READ_CHECK_REVISION_CONFLICT');
    }
    const stored = getProfile(database, current.profileId);
    if (stored === null) {
      return saveRejected('READ_CHECK_PROFILE_NOT_FOUND');
    }
    if (stored.status !== ACTIVE_PROFILE_STATUS) {
      return saveRejected('READ_CHECK_PROFILE_RETIRED');
    }
    // T28b fix round 1: 作るときと同じく、READ の確かめを許すモードと認証の方式かを、候補の検証の前に確かめる。
    if (!usesReadCheck(stored.profile.mode, stored.profile.auth)) {
      return saveRejected('READ_CHECK_PROFILE_NOT_ELIGIBLE');
    }
    const checked = await checkedDefinitionOf(current.profileId, data.definition);
    if (!checked.ok) {
      return checked;
    }
    return saveViewOf(updateReadCheck(database, {
      readCheckId: data.readCheckId,
      expectedRevision: data.expectedRevision,
      definition: checked.definition,
      at: nowStamp('READ check change time'),
    }));
  });

/** READ の確かめの定義を削除する（一覧から外す。行は消さずに、取り消した時刻を書く）。 */
export const cancelReadCheckFn = createServerFn({ method: 'POST' })
  .validator(requestOf<ReadCheckCancelRequest>('ui-read-check-cancel'))
  .handler(({ data }): ReadCheckCancelView => {
    const result = cancelReadCheck(localUiStore(), {
      readCheckId: data.readCheckId,
      expectedRevision: data.expectedRevision,
      at: nowStamp('READ check cancel time'),
    });
    return result.ok ? { ok: true } : { ok: false, reason: result.reason };
  });

/** READ の確かめを始める（開始の判断はジョブの管理が開始の直前に行う）。 */
export const startReadCheckFn = createServerFn({ method: 'POST' })
  .validator(requestOf<ReadCheckStartRequest>('ui-read-check-start'))
  .handler(async ({ data }): Promise<AuditJobStartView> => {
    const result = await localUiAuditJobs().startReadCheck({ profileId: data.profileId, expectedRevision: data.expectedRevision });
    return result.ok
      ? { ok: true, jobId: result.job.jobId }
      : { ok: false, ...startRejectionViewOf(result) };
  });
