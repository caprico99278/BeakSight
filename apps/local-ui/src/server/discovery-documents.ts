/**
 * 操作の候補と READ の確かめの画面のための、成果物の読み出しと、画面に返す値への写し（Task 27 の設計書 4.7、4.8。T27f）。サーバだけで使う
 * （ブラウザ側のコードは import しない。Server Functions のファイル `discovery-functions.ts`・`read-check-functions.ts` だけが使う）。
 * - 候補の索引は、管理データの読み出し（`readDiscoveryIndex`）。候補の詳しい内容（欄の型と制約、送信先、method）は、索引で候補を最後に見た
 *   発見のジョブの `discovery.json` から読む（`readJobResultDocument`。スキーマとジョブの ID を確かめる。ジョブの管理が READ の確かめの対象の画面を
 *   決めるのと同じ読み方）。READ の確かめの定義の保存の確かめに使う候補は、最後の発見のジョブの `discovery.json` だけから、同じ識別の digest の候補を
 *   まとめた後（`mergeDiscoveryCandidates`。ジョブの管理と READ の実行と同じまとめ方）で探す。文書から候補を探す読み方の owner は
 *   `src/control/discovery-candidate-lookup.ts`（T28c でここから移した。シナリオの保存の部品と同じ読み方を使う）。
 * - 画面に返す値は、項目を選んで写す（表示の前の確かめ）。成果物の契約に、入力の値・CSRF のトークン・hidden の値・選択肢の label はないが、
 *   見えない欄（hidden）と秘密に見える名前の欄の選択肢の値も、画面には返さない。値があるか（`hasValue`）も返さない。
 * - 値を送れる欄かの判定は、純粋な契約の `isSendableReadCheckParameter`（保存の確かめとワーカーの確かめ直しと同じ判定）、秘密に見える名前は
 *   `isSecretUrlQueryParameterName`（伏せ字と同じ判定）、READ の確かめの対象にできる分類かは `isReadCheckTargetClassification` に任せる
 *   （画面の側で書き写さない）。
 */
import type { AuditMode, AuthStrategy } from '../../../../src/control/contracts.js';
import {
  FIELD_CONSTRAINT_NAMES,
  isSendableReadCheckParameter,
  type CandidateField,
  type CandidateFieldTag,
  type CandidateFieldType,
  type CandidateKind,
  type DiscoveryCandidate,
  type DiscoveryDocument,
  type FieldConstraintName,
  type FormEnctype,
  type IncompleteReason,
  type ListenerKind,
  type ReadEvidenceDocument,
} from '../../../../src/control/discovery-view.js';
import { candidateOfDiscoveryDocument, mergedDiscoveryCandidatesOf } from '../../../../src/control/discovery-candidate-lookup.js';
import { readDiscoveryIndex, type DiscoveryIndexView } from '../../../../src/control/job/discovery-index-store.js';
import { isReadCheckTargetClassification } from '../../../../src/control/read-check-policy.js';
import type { ProfileStatus } from '../../../../src/control/store/profile-records.js';
import type { StoredProfile } from '../../../../src/control/store/profile-store.js';
import { isSecretUrlQueryParameterName } from '../../../../src/core/secret-query-names.js';
import { readJobResultDocument } from './artifact-files';
import { localUiAuditJobs } from './audit-jobs';
import { localUiStore } from './control-store';

// ---------------------------------------------------------------------------------------------------------------
// 画面に返す値
// ---------------------------------------------------------------------------------------------------------------

/** プロファイルの要点。 */
export interface DiscoveryProfileView {
  readonly profileId: string;
  readonly revision: number;
  readonly mode: AuditMode;
  readonly auth: AuthStrategy;
  readonly status: ProfileStatus;
  readonly approvedTestOrigins: readonly string[];
}

/** 入力の欄の制約 1 件（属性があるものだけ）。 */
export interface CandidateFieldConstraintView {
  readonly name: FieldConstraintName;
  readonly value: string;
}

/** 入力の欄 1 件（値と label は持たない）。 */
export interface CandidateFieldView {
  readonly name: string;
  readonly tag: CandidateFieldTag;
  readonly type: CandidateFieldType;
  readonly required: boolean;
  readonly readonly: boolean;
  readonly disabled: boolean;
  readonly hidden: boolean;
  readonly constraints: readonly CandidateFieldConstraintView[];
  /** 選択肢の値（select、checkbox、radio。見えない欄と秘密に見える名前の欄は返さない（`optionsWithheld`）。ほかの欄は null）。 */
  readonly options: readonly string[] | null;
  readonly optionsWithheld: boolean;
  readonly omittedOptionCount: number;
  /** READ の確かめで値を送れる欄か（`isSendableReadCheckParameter`）。 */
  readonly sendable: boolean;
  /** 秘密に見える名前の欄か（値を送らない）。 */
  readonly secretLike: boolean;
}

/** 送信先（Origin と path と query の名前。値は持たない）。 */
export interface CandidateActionView {
  readonly origin: string;
  readonly path: string;
  readonly queryNames: readonly string[];
}

/** 候補の詳しい内容（候補を最後に見た発見のジョブの `discovery.json` から）。 */
export interface DiscoveryCandidateDetailView {
  readonly kind: CandidateKind;
  readonly pageOrigin: string;
  readonly action: CandidateActionView | null;
  readonly enctype: FormEnctype | null;
  readonly target: string | null;
  /** 送信ボタンの分類の語（T27R-fix-1。DEF-086。ボタンの文言は持たない）。 */
  readonly submitterWords: readonly string[];
  readonly fields: readonly CandidateFieldView[];
  /** JS の結び付きの listener の種類（form、ボタン、祖先、document、window をまとめた重複なしの一覧）。 */
  readonly listenerKinds: readonly ListenerKind[];
  readonly inlineHandler: boolean;
  readonly incompleteReasons: readonly IncompleteReason[];
}

// ---------------------------------------------------------------------------------------------------------------
// 読み出し
// ---------------------------------------------------------------------------------------------------------------

/** プロファイルの要点（管理データの値を選んで写す）。 */
export const discoveryProfileViewOf = (stored: StoredProfile): DiscoveryProfileView => ({
  profileId: stored.profile.profileId,
  revision: stored.profile.revision,
  mode: stored.profile.mode,
  auth: stored.profile.auth,
  status: stored.status,
  approvedTestOrigins: [...stored.profile.approvedTestOrigins],
});

/** ジョブの `discovery.json`（読めない・合わない・ジョブがないなら null）。 */
const discoveryDocumentOfJob = async (jobId: string): Promise<DiscoveryDocument | null> => {
  const job = localUiAuditJobs().getAuditJob(jobId);
  return job === null ? null : (await readJobResultDocument(job, 'discovery')) as DiscoveryDocument | null;
};

/** ジョブの `read-evidence.json`（読めない・合わない・ジョブがないなら null）。 */
export const readEvidenceDocumentOfJob = async (jobId: string): Promise<ReadEvidenceDocument | null> => {
  const job = localUiAuditJobs().getAuditJob(jobId);
  return job === null ? null : (await readJobResultDocument(job, 'read-evidence')) as ReadEvidenceDocument | null;
};

/** プロファイルの索引と、発見の成果物（ジョブごとに 1 回だけ読む）。 */
export interface DiscoveryDocuments {
  readonly index: DiscoveryIndexView;
  /** 最後の発見のジョブの `discovery.json`（記録がない・読めないなら null）。 */
  readonly latest: DiscoveryDocument | null;
  /** あるジョブの `discovery.json`（読めないなら null。同じジョブは 1 回だけ読む）。 */
  readonly documentOf: (jobId: string) => Promise<DiscoveryDocument | null>;
}

/** プロファイルの索引と、最後の発見のジョブの `discovery.json` を読む。 */
export const readDiscoveryDocuments = async (profileId: string): Promise<DiscoveryDocuments> => {
  const index = readDiscoveryIndex(localUiStore(), profileId);
  const cache = new Map<string, Promise<DiscoveryDocument | null>>();
  const documentOf = (jobId: string): Promise<DiscoveryDocument | null> => {
    let pending = cache.get(jobId);
    if (pending === undefined) {
      pending = discoveryDocumentOfJob(jobId);
      cache.set(jobId, pending);
    }
    return pending;
  };
  const latest = index.latestJobId === null ? null : await documentOf(index.latestJobId);
  return { index, latest, documentOf };
};

/** 許可 Origin がこの数以上なら、画面の Origin を示して、同じ path の候補を区別する（T27c の申し送り 3）。 */
const ORIGINS_SHOWN_FROM = 2;

/** 画面の Origin を示すプロファイルか（許可 Origin が 2 つ以上）。 */
export const showsOriginsOf = (stored: StoredProfile): boolean => stored.profile.approvedTestOrigins.length >= ORIGINS_SHOWN_FROM;

/** 文書の候補を、同じ識別の digest でまとめた一覧（読み方の owner `src/control/discovery-candidate-lookup.ts` の公開し直し）。 */
export const mergedCandidatesOf: (document: DiscoveryDocument | null) => readonly DiscoveryCandidate[] = mergedDiscoveryCandidatesOf;

/** 文書の、識別の digest の候補（まとめた後。なければ null。読み方の owner の公開し直し）。 */
export const candidateOfDocument: (document: DiscoveryDocument | null, identityDigest: string) => DiscoveryCandidate | null =
  candidateOfDiscoveryDocument;

// ---------------------------------------------------------------------------------------------------------------
// 画面に返す値への写し
// ---------------------------------------------------------------------------------------------------------------

/** 秘密に見える名前の欄か（名前のない欄は違う）。 */
const isSecretLikeField = (field: CandidateField): boolean => field.name.length > 0 && isSecretUrlQueryParameterName(field.name);

/** 入力の欄を、画面に返す値にする（項目を選んで写す）。 */
export const candidateFieldViewOf = (candidate: DiscoveryCandidate, field: CandidateField): CandidateFieldView => {
  const secretLike = isSecretLikeField(field);
  const optionsWithheld = field.options !== null && (field.hidden || secretLike);
  return {
    name: field.name,
    tag: field.tag,
    type: field.type,
    required: field.required,
    readonly: field.readonly,
    disabled: field.disabled,
    hidden: field.hidden,
    constraints: FIELD_CONSTRAINT_NAMES.flatMap((name) => {
      const value = field.constraints[name];
      return value === null ? [] : [{ name, value }];
    }),
    options: field.options === null || optionsWithheld ? null : [...field.options],
    optionsWithheld,
    omittedOptionCount: optionsWithheld ? 0 : field.omittedOptionCount,
    sendable: field.name.length > 0 && isSendableReadCheckParameter(candidate, field.name),
    secretLike,
  };
};

/** 候補の詳しい内容を、画面に返す値にする。 */
export const candidateDetailViewOf = (candidate: DiscoveryCandidate): DiscoveryCandidateDetailView => {
  const binding = candidate.jsBinding;
  return {
    kind: candidate.kind,
    pageOrigin: candidate.page.origin,
    action: candidate.action === null
      ? null
      : { origin: candidate.action.origin, path: candidate.action.path, queryNames: [...candidate.action.queryNames] },
    enctype: candidate.enctype,
    target: candidate.target,
    submitterWords: [...candidate.submitterWords],
    fields: candidate.fields.map((field) => candidateFieldViewOf(candidate, field)),
    listenerKinds: [...new Set([...binding.form, ...binding.submitter, ...binding.ancestor, ...binding.document, ...binding.window])],
    inlineHandler: binding.inlineHandler,
    incompleteReasons: [...candidate.incompleteReasons],
  };
};

/** 候補を、READ の確かめの対象にできるか（分類が READ。判定は `read-check-policy.ts`）。 */
export const isReadCheckTarget = (candidate: Pick<DiscoveryCandidate, 'classification'>): boolean =>
  isReadCheckTargetClassification(candidate.classification);
