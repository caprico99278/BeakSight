// 発見の候補の索引の読み書きの唯一の owner（管理データの版 5 の `discovery_candidates` と `discovery_jobs`。Task 27 の設計書 4.4 の「ドリフト」、
// 4.6、4.8。T27c、T27d）。
// - 記録（`recordDiscoveryCandidates`）: 発見のジョブ（`DISCOVERY`）の結果を、1 つのトランザクションで書く。プロファイルと識別の digest で突き合わせ、
//   新しい（`NEW`）・変わった（`CHANGED`。規則の digest・分類・理由のコード・状態の欄の印のどれかが前と違う）・まだある（`UNCHANGED`）・消えた
//   （`MISSING`。今回読み切れた画面の path にあって、今回の結果にない）・読み直していない（`NOT_REVISITED`。今回読まなかった画面の候補。T27d）を
//   返す。消えた候補も読み直していない候補も消さない（最後に見たジョブと時刻が前のまま残る）。変わった候補は、最後に変わったジョブを書く。
//   T27d（設計書の変更履歴「Blocker: T27d」の行の (2)）: ジョブ 1 回を `discovery_jobs` の 1 行（主キーはジョブの ID。読み切れた画面の path の一覧を
//   持つ）として、同じトランザクションで書く。同じジョブの 2 回目の記録は、この行（主キー）で拒む（候補が 0 件のジョブも同じ）。
// - 読み出し（`readDiscoveryIndex`）: プロファイルの候補の一覧と、最後の発見のジョブ（`discovery_jobs` の記録した時刻が最も新しい行。候補が 0 件の
//   ジョブも含む）に対するドリフト。
// - 入力（`DiscoveryIndexEntry`）は、digest・分類・理由のコード・画面と送信先の path・method・状態の欄の印だけ。値・トークン・選択肢の label・
//   ボタンの文言・欄の名前・query の名前の口を持たない（設計書 4.8）。候補から入力を作るのは `discoveryIndexEntryOf`（項目を選んで写す）。同じジョブの
//   中の同じ識別の digest の候補のまとめは、索引に渡す前に `src/discovery/discovery-result.ts` の `mergeDiscoveryCandidates` が行う（ここでは、
//   違う中身の重複を呼び出し側の誤りとして拒む）。
// - T31e（Task 31 の設計書 11 章の T31b の Blocker の判断。管理データの版 9）: 候補ごとの「型にした識別の digest の一覧」（`templatedIdentityDigests`。
//   画面の path と送信先の path で同じ値の区切りの組（値が登録の ID の形 `usableRecordIdOf` に合う組だけ。上限 `MAX_RECORD_ID_SEGMENT_PAIRS`）ごとに、
//   その区切りを `{id}` にした digest。digest だけで、欄の名前は持たない）を書く。求めるのは `discoveryIndexEntryOf`（親が候補の全体から
//   `templatedIdentityDigestsOf` で求める）。新しい候補・変わった候補・まだある候補のどれも、今回の一覧で書き直す（一覧の違いはドリフトに数えない）。
//   版 9 の前に書いた行は一覧なし（読み出しの `templatedIdentityDigests` は null。UPDATE の承認の有効性は止める側）。
// - T38d（Task 38 の設計書 3.1、3.5。管理データの版 13）: 候補ごとの「型の digest の一覧」（`shapeDigests`。押して見た要求の型の digest
//   `submissionProbe.shapeDigest`。digest だけ）を書く。`inputFields` のない probe（T38a の前の成果物）と型のない probe は、型を持たないものとして扱う。
//   同じジョブの同じ識別の digest の候補（型ごとに 1 行。`mergeDiscoveryCandidates`）は、型の一覧を合わせて 1 件にする（ほかの項目が違えば
//   `RangeError`）。上限は `MAX_INDEX_SHAPE_DIGESTS`。どの場合も今回の一覧で書き直す（型の違いはドリフトに数えない）。版 13 の前に書いた行は
//   一覧なし（読み出しの `shapeDigests` は null。API の承認の有効性は止める側。判定は T38c）。
// - T38R-fix（Task 38 の設計書 7 章の最後の行）: C-1: 型の digest は、書き込みの probe（結果が `API_CREATE`・`API_UPDATE`）の型だけ。I-1: 鍵と欄の対応の
//   digest の一覧（`keyFieldDigests`。`apiKeyFieldsDigestOf`）も、型の一覧と同じく書き、合わせ、読む（列を足す前の行は null）。
// - T41a（Task 41 の設計書 3.1）: form のない候補の、画面の path の最後の ID を `{id}` にした識別の digest（`pagePathTemplatedIdentityDigestOf`）も、型に
//   した識別の digest の一覧（同じ列 `templated_identity_digests`）に入れる。印が form の digest と違うので、印で分けて共用する（管理データの版は 14 のまま。
//   列の形と上限は変わらない）。API の UPDATE の承認の有効性が、この一覧で候補を確かめる。
// - 書き込みは、すべて `withWriteTransaction` の中。読むだけの関数は `withReadTransaction` を通す。生の接続を直接参照しない（Architecture Gate
//   `control-store-boundary.test.ts` の (f)(g)）。呼び出し側の誤り（形の違う入力、同じジョブを 2 回、前の時刻）は、書く前に `RangeError`。
import { isSha256Fingerprint } from '../../core/ids.js';
import { deepFreeze } from '../../core/immutable.js';
import { isCompactUtcTimestamp } from '../../core/utc-timestamp.js';
import {
  CANDIDATE_CLASSIFICATIONS,
  CANDIDATE_REASON_CLASSIFICATIONS,
  CANDIDATE_REASON_CODES,
  FORM_METHODS,
  MAX_CANDIDATE_URL_PART_LENGTH,
  METHOD_OVERRIDE_VALUES,
  type CandidateClassification,
  type CandidateReasonCode,
  type DiscoveryCandidate,
  type FormMethod,
  type MethodOverride,
} from '../../discovery/candidate-contracts.js';
import { MAX_DISCOVERY_READ_PAGE_PATHS } from '../../discovery/discovery-result.js';
import { MAX_RECORD_ID_SEGMENT_PAIRS, pagePathTemplatedIdentityDigestOf, templatedIdentityDigestsOf } from '../../discovery/fingerprint.js';
import {
  MAX_SUBMISSION_PROBE_PRESSES_PER_PAGE,
  submissionProbeWriteOf,
  type SubmissionProbeRecord,
} from '../../discovery/submission-probe-contracts.js';
import { apiKeyFieldsDigestOf, scenarioApiKeyFieldsOfProbe } from '../approval/scenario-contracts.js';
import { usableRecordIdOf } from '../actions/action-outcome.js';
import type { ControlDatabase } from '../store/control-database.js';
import type { SqliteConnection } from '../store/sqlite-module.js';
import { ControlStoreError } from '../store/store-errors.js';
import { withReadTransaction, withWriteTransaction } from '../store/transaction.js';
import { WORKER_JOB_ID_PATTERN } from '../worker-protocol.js';
import { dateOfCompactUtcTimestamp } from './auto-login-limits.js';

// ---------------------------------------------------------------------------------------------------------------
// 形
// ---------------------------------------------------------------------------------------------------------------

/**
 * 索引の 1 件の入力（候補から、索引に書く項目だけを選んだもの）。値・トークン・label・ボタンの文言・欄の名前の項目を持たない。
 * method は、form の method と `_method` の上書きを、2 つのまま持つ（実際の method の判定は分類の owner `src/discovery/classify.ts`）。
 */
export interface DiscoveryIndexEntry {
  readonly identityDigest: string;
  readonly ruleDigest: string;
  readonly classification: CandidateClassification;
  readonly reasonCode: CandidateReasonCode;
  /** 画面の path（`/` で始まる。Origin は持たない）。 */
  readonly pagePath: string;
  /** 送信先の path（form の外のボタンは null。query は持たない）。 */
  readonly actionPath: string | null;
  readonly formMethod: FormMethod | null;
  readonly methodOverride: MethodOverride | null;
  readonly hasStateField: boolean;
  /**
   * 型にした識別の digest の一覧（T31e。UTF-16 のコード単位の順、重なりなし、上限 `MAX_RECORD_ID_SEGMENT_PAIRS` 件。digest だけ）。作るのは
   * `discoveryIndexEntryOf`。
   */
  readonly templatedIdentityDigests: readonly string[];
  /**
   * 型の digest の一覧（T38d。UTF-16 のコード単位の順、重なりなし、上限 `MAX_INDEX_SHAPE_DIGESTS` 件。digest だけ）。作るのは `discoveryIndexEntryOf`
   * （`inputFields` を持つ probe の型の digest。ほかは空）。
   */
  readonly shapeDigests: readonly string[];
  /**
   * 鍵と欄の対応の digest の一覧（T38R-fix の I-1。`apiKeyFieldsDigestOf`。型の digest の一覧と同じ行の probe ごと。並べて重なりなし、上限
   * `MAX_INDEX_SHAPE_DIGESTS` 件）。作るのは `discoveryIndexEntryOf`。
   */
  readonly keyFieldDigests: readonly string[];
}

/**
 * 索引の 1 件が持てる型の digest の数の上限（T38d。1 画面で押す回数の上限と同じ。1 回の発見で、1 つの識別の digest の型はそれより多くならない。
 * 管理データの版 13 の CHECK も同じ数）。
 */
export const MAX_INDEX_SHAPE_DIGESTS = MAX_SUBMISSION_PROBE_PRESSES_PER_PAGE;

/** 発見のジョブ 1 回の記録の入力。 */
export interface DiscoveryIndexUpdate {
  readonly profileId: string;
  /** 発見のジョブの ID（`WORKER_JOB_ID_PATTERN`）。 */
  readonly jobId: string;
  /** 見た時刻（UTC の 14 桁）。そのプロファイルの最後に記録したジョブの時刻より前にしない。 */
  readonly at: string;
  readonly entries: readonly DiscoveryIndexEntry[];
  /**
   * 今回のジョブで読み切れた画面の path（`/` で始まる。重複なし。上限 `MAX_DISCOVERY_READ_PAGE_PATHS`。T27d）。ここにある path の候補で今回ない
   * ものを `MISSING`、ほかの今回ない候補を `NOT_REVISITED` にする。作るのは `src/discovery/discovery-result.ts` の `discoveryReadPagePaths`。
   */
  readonly readPagePaths: readonly string[];
}

/** 前の記録に対するドリフト（閉じた一覧。設計書 4.4。T27d で `NOT_REVISITED` を足した）。 */
export const DISCOVERY_INDEX_DRIFTS = Object.freeze(['NEW', 'CHANGED', 'UNCHANGED', 'MISSING', 'NOT_REVISITED'] as const);
export type DiscoveryIndexDrift = (typeof DISCOVERY_INDEX_DRIFTS)[number];

/** 記録の結果（ドリフトごとの識別の digest。UTF-16 のコード単位の順。凍結）。 */
export type DiscoveryIndexUpdateOutcome = { readonly [Drift in DiscoveryIndexDrift]: readonly string[] };

/** 索引の 1 件（凍結。日時は UTC の 14 桁）。`drift` は、最後の発見のジョブに対するもの。 */
export interface DiscoveryCandidateIndexView extends Omit<DiscoveryIndexEntry, 'templatedIdentityDigests' | 'shapeDigests' | 'keyFieldDigests'> {
  /** 鍵と欄の対応の digest の一覧（T38R-fix の I-1）。この列を足す前に書いた行（まだ次の発見で書き直していない行）は null。 */
  readonly keyFieldDigests: readonly string[] | null;
  /** 型にした識別の digest の一覧（T31e）。管理データの版 9 の前に書いた行（まだ次の発見で書き直していない行）は null。 */
  readonly templatedIdentityDigests: readonly string[] | null;
  /** 型の digest の一覧（T38d）。管理データの版 13 の前に書いた行（まだ次の発見で書き直していない行）は null。 */
  readonly shapeDigests: readonly string[] | null;
  readonly profileId: string;
  readonly firstSeenJobId: string;
  readonly firstSeenAt: string;
  readonly lastSeenJobId: string;
  readonly lastSeenAt: string;
  /** 最後に変わった（規則の digest・分類・理由・状態の欄の印が前と違った）ジョブ。変わったことがなければ null。 */
  readonly lastChangedJobId: string | null;
  readonly drift: DiscoveryIndexDrift;
}

/** プロファイルの索引（凍結）。候補は識別の digest の順。記録がなければ、最後のジョブは null で、読んだ画面と候補は空。 */
export interface DiscoveryIndexView {
  /** 最後に記録した発見のジョブ（候補が 0 件のジョブを含む）。 */
  readonly latestJobId: string | null;
  /** 最後のジョブを記録した時刻（UTC の 14 桁）。 */
  readonly latestSeenAt: string | null;
  /** 最後のジョブで読み切れた画面の path（T27d）。 */
  readonly latestReadPagePaths: readonly string[];
  readonly candidates: readonly DiscoveryCandidateIndexView[];
}

// ---------------------------------------------------------------------------------------------------------------
// SQL と行
// ---------------------------------------------------------------------------------------------------------------

interface CandidateRow {
  readonly profile_id: string;
  readonly identity_digest: string;
  readonly rule_digest: string;
  readonly classification: string;
  readonly reason_code: string;
  readonly page_path: string;
  readonly action_path: string | null;
  readonly form_method: string | null;
  readonly method_override: string | null;
  readonly has_state_field: number;
  readonly first_seen_job_id: string;
  readonly first_seen_at: string;
  readonly last_seen_job_id: string;
  readonly last_seen_at: string;
  readonly last_changed_job_id: string | null;
  readonly templated_identity_digests: string | null;
  readonly shape_digests: string | null;
  readonly key_field_digests: string | null;
}

/** `discovery_jobs` の行（T27d）。 */
interface DiscoveryJobRow {
  readonly job_id: string;
  readonly recorded_at: string;
  readonly read_page_paths: string;
}

const CANDIDATE_COLUMNS = 'profile_id, identity_digest, rule_digest, classification, reason_code, page_path, action_path, form_method, '
  + 'method_override, has_state_field, first_seen_job_id, first_seen_at, last_seen_job_id, last_seen_at, last_changed_job_id, templated_identity_digests, '
  + 'shape_digests, key_field_digests';
const SELECT_PROFILE_CANDIDATES_SQL = `SELECT ${CANDIDATE_COLUMNS} FROM discovery_candidates WHERE profile_id = ? ORDER BY identity_digest`;
const SELECT_LATEST_JOB_SQL = `SELECT job_id, recorded_at, read_page_paths FROM discovery_jobs WHERE profile_id = ?
  ORDER BY recorded_at DESC, rowid DESC LIMIT 1`;
const SELECT_JOB_RECORDED_SQL = 'SELECT count(*) AS n FROM discovery_jobs WHERE job_id = ?';
/** あるジョブより後に記録したプロファイルの発見のジョブの数（そのジョブの rowid より後の行。ジョブが null なら、すべての行。CCX-17）。 */
const SELECT_JOBS_AFTER_SQL = `SELECT count(*) AS n FROM discovery_jobs WHERE profile_id = ?
  AND (? IS NULL OR rowid > (SELECT rowid FROM discovery_jobs WHERE job_id = ?))`;
const INSERT_JOB_SQL = 'INSERT INTO discovery_jobs (job_id, profile_id, recorded_at, read_page_paths) VALUES (?, ?, ?, ?)';
const INSERT_CANDIDATE_SQL = `INSERT INTO discovery_candidates (${CANDIDATE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`;
const UPDATE_SEEN_SQL = `UPDATE discovery_candidates SET last_seen_job_id = ?, last_seen_at = ?, templated_identity_digests = ?, shape_digests = ?,
  key_field_digests = ? WHERE profile_id = ? AND identity_digest = ?`;
const UPDATE_CHANGED_SQL = `UPDATE discovery_candidates SET rule_digest = ?, classification = ?, reason_code = ?, has_state_field = ?,
  last_seen_job_id = ?, last_seen_at = ?, last_changed_job_id = ?, templated_identity_digests = ?, shape_digests = ?, key_field_digests = ?
  WHERE profile_id = ? AND identity_digest = ?`;

/** SQLite の真偽の値。 */
const SQL_TRUE = 1;
const SQL_FALSE = 0;
/** path の始まり（`URL.pathname` の形）。 */
const PATH_START = '/';

const isOneOf = <Value extends string>(values: readonly Value[], value: unknown): value is Value =>
  typeof value === 'string' && (values as readonly string[]).includes(value);

const integrityError = (detail: string): ControlStoreError =>
  new ControlStoreError('DATABASE_INTEGRITY_FAILED', `stored discovery index row: ${detail}`);

/** UTF-16 のコード単位の順に並べた、凍結した写し。 */
const sortedFrozen = (values: readonly string[]): readonly string[] => Object.freeze([...values].sort());

// ---------------------------------------------------------------------------------------------------------------
// 入力の確かめ（呼び出し側の誤りは `RangeError`。書く前に確かめる）
// ---------------------------------------------------------------------------------------------------------------

const isCandidatePath = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith(PATH_START) && value.length <= MAX_CANDIDATE_URL_PART_LENGTH;

/** digest の一覧の形か（digest の形、UTF-16 のコード単位の順で重なりなし、上限まで）。 */
const isSortedDigestList = (value: unknown, limit: number): value is readonly string[] =>
  Array.isArray(value)
  && value.length <= limit
  && value.every(isSha256Fingerprint)
  && value.every((digest, index) => index === 0 || (value[index - 1] as string) < digest);

/** 型にした識別の digest の一覧の形か（T31e）。 */
const isTemplatedIdentityDigests = (value: unknown): value is readonly string[] => isSortedDigestList(value, MAX_RECORD_ID_SEGMENT_PAIRS);

/** 型の digest の一覧の形か（T38d）。 */
const isShapeDigests = (value: unknown): value is readonly string[] => isSortedDigestList(value, MAX_INDEX_SHAPE_DIGESTS);

/** 索引の 1 件の形を確かめ、項目を選んだ凍結した写しを返す（余分な項目は写さない）。 */
const requireEntry = (entry: DiscoveryIndexEntry): DiscoveryIndexEntry => {
  if (!isSha256Fingerprint(entry.identityDigest) || !isSha256Fingerprint(entry.ruleDigest)) {
    throw new RangeError('the digests of a discovery index entry must have the form of computeCandidateDigests');
  }
  if (!isOneOf(CANDIDATE_CLASSIFICATIONS, entry.classification) || !isOneOf(CANDIDATE_REASON_CODES, entry.reasonCode)
    || CANDIDATE_REASON_CLASSIFICATIONS[entry.reasonCode] !== entry.classification) {
    throw new RangeError('the classification and the reason code must be a pair of the closed lists');
  }
  if (!isCandidatePath(entry.pagePath) || (entry.actionPath !== null && !isCandidatePath(entry.actionPath))) {
    throw new RangeError('the page path and the action path must start with a slash and be within the limit');
  }
  if ((entry.formMethod !== null && !isOneOf(FORM_METHODS, entry.formMethod))
    || (entry.methodOverride !== null && !isOneOf(METHOD_OVERRIDE_VALUES, entry.methodOverride))
    || (entry.actionPath === null) !== (entry.formMethod === null)
    || (entry.methodOverride !== null && entry.formMethod === null)) {
    throw new RangeError('the form method, the method override and the action path must be of a form, or all null for a button');
  }
  if (typeof entry.hasStateField !== 'boolean') {
    throw new RangeError('the state field mark must be a boolean');
  }
  if (!isTemplatedIdentityDigests(entry.templatedIdentityDigests)) {
    throw new RangeError('the templated identity digests must be sorted distinct digests within the limit');
  }
  if (!isShapeDigests(entry.shapeDigests)) {
    throw new RangeError('the shape digests must be sorted distinct digests within the limit');
  }
  if (!isShapeDigests(entry.keyFieldDigests)) {
    throw new RangeError('the key field digests must be sorted distinct digests within the limit');
  }
  return Object.freeze({
    identityDigest: entry.identityDigest,
    ruleDigest: entry.ruleDigest,
    classification: entry.classification,
    reasonCode: entry.reasonCode,
    pagePath: entry.pagePath,
    actionPath: entry.actionPath,
    formMethod: entry.formMethod,
    methodOverride: entry.methodOverride,
    hasStateField: entry.hasStateField,
    templatedIdentityDigests: Object.freeze([...entry.templatedIdentityDigests]),
    shapeDigests: Object.freeze([...entry.shapeDigests]),
    keyFieldDigests: Object.freeze([...entry.keyFieldDigests]),
  });
};

/**
 * 同じ識別の digest の 2 件が、型の digest の一覧と鍵と欄の対応の digest の一覧のほかは同じ中身か（T38d: 型ごとの行は、型の一覧を合わせて 1 件に
 * する。T38R-fix の I-1: 鍵と欄の対応の一覧も同じ）。
 */
const sameEntryButShapes = (left: DiscoveryIndexEntry, right: DiscoveryIndexEntry): boolean =>
  JSON.stringify({ ...left, shapeDigests: [], keyFieldDigests: [] }) === JSON.stringify({ ...right, shapeDigests: [], keyFieldDigests: [] });

/** 2 つの digest の一覧を合わせる（並べて重なりなし。上限を超えれば `RangeError`）。 */
const joinedDigestsOf = (left: readonly string[], right: readonly string[], label: string): readonly string[] => {
  const joined = sortedFrozen([...new Set([...left, ...right])]);
  if (!isShapeDigests(joined)) {
    throw new RangeError(`one identity digest of a discovery job must have at most ${MAX_INDEX_SHAPE_DIGESTS} ${label}`);
  }
  return joined;
};

/** 同じ識別の digest の 2 件の、型の digest の一覧と鍵と欄の対応の digest の一覧を合わせる（T38d・T38R-fix の I-1）。 */
const withJoinedShapes = (known: DiscoveryIndexEntry, entry: DiscoveryIndexEntry): DiscoveryIndexEntry => Object.freeze({
  ...known,
  shapeDigests: joinedDigestsOf(known.shapeDigests, entry.shapeDigests, 'shape digests'),
  keyFieldDigests: joinedDigestsOf(known.keyFieldDigests, entry.keyFieldDigests, 'key field digests'),
});

/** 読み切れた画面の path の一覧を確かめ、並べた凍結した写しを返す（T27d）。形の違う値、重複、上限を超える件数は `RangeError`。 */
const requireReadPagePaths = (paths: readonly string[]): readonly string[] => {
  if (!Array.isArray(paths) || paths.length > MAX_DISCOVERY_READ_PAGE_PATHS) {
    throw new RangeError(`the read page paths must be an array of at most ${MAX_DISCOVERY_READ_PAGE_PATHS} paths`);
  }
  if (!paths.every(isCandidatePath)) {
    throw new RangeError('every read page path must start with a slash and be within the limit');
  }
  if (new Set(paths).size !== paths.length) {
    throw new RangeError('the read page paths must not repeat a path');
  }
  return sortedFrozen(paths);
};

/** 確かめた入力。 */
interface CheckedUpdate {
  readonly entries: readonly DiscoveryIndexEntry[];
  readonly readPagePaths: readonly string[];
}

/**
 * 入力を確かめ、識別の digest ごとに 1 件にまとめる（同じ中身の重複はまとめ、型の digest の一覧だけが違う重複は一覧を合わせ（T38d）、ほかの違う
 * 中身の重複は `RangeError`）。
 */
const requireUpdate = (update: DiscoveryIndexUpdate): CheckedUpdate => {
  if (typeof update.jobId !== 'string' || !WORKER_JOB_ID_PATTERN.test(update.jobId)) {
    throw new RangeError('the discovery job id must match the job id pattern');
  }
  if (typeof update.at !== 'string' || !isCompactUtcTimestamp(update.at)) {
    throw new RangeError('the time must be 14 ASCII digits of a UTC time');
  }
  dateOfCompactUtcTimestamp(update.at);
  const readPagePaths = requireReadPagePaths(update.readPagePaths);
  const byDigest = new Map<string, DiscoveryIndexEntry>();
  for (const entry of update.entries.map(requireEntry)) {
    const known = byDigest.get(entry.identityDigest);
    if (known !== undefined && !sameEntryButShapes(known, entry)) {
      throw new RangeError('two entries of one discovery job have the same identity digest but different contents');
    }
    byDigest.set(entry.identityDigest, known === undefined ? entry : withJoinedShapes(known, entry));
  }
  return Object.freeze({ entries: Object.freeze([...byDigest.values()]), readPagePaths });
};

/** 前の記録から変わったか（規則の digest・分類・理由のコード・状態の欄の印）。 */
const changedFrom = (row: CandidateRow, entry: DiscoveryIndexEntry): boolean =>
  row.rule_digest !== entry.ruleDigest
  || row.classification !== entry.classification
  || row.reason_code !== entry.reasonCode
  || (row.has_state_field === SQL_TRUE) !== entry.hasStateField;

/** 保存した型にした識別の digest の一覧（T31e。版 9 の前の行は null。壊れていれば `ControlStoreError`）。 */
const templatedIdentityDigestsOfRow = (row: CandidateRow): readonly string[] | null => {
  if (row.templated_identity_digests === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.templated_identity_digests) as unknown;
  } catch {
    throw integrityError('templated_identity_digests is not JSON');
  }
  if (!isTemplatedIdentityDigests(parsed)) {
    throw integrityError('templated_identity_digests is not a sorted list of distinct digests within the limit');
  }
  return Object.freeze([...parsed]);
};

/** 保存した型の digest の一覧（T38d。版 13 の前の行は null。壊れていれば `ControlStoreError`）。 */
const shapeDigestsOfRow = (row: CandidateRow): readonly string[] | null => {
  if (row.shape_digests === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.shape_digests) as unknown;
  } catch {
    throw integrityError('shape_digests is not JSON');
  }
  if (!isShapeDigests(parsed)) {
    throw integrityError('shape_digests is not a sorted list of distinct digests within the limit');
  }
  return Object.freeze([...parsed]);
};

/** 保存した鍵と欄の対応の digest の一覧（T38R-fix の I-1。列を足す前の行は null。壊れていれば `ControlStoreError`）。 */
const keyFieldDigestsOfRow = (row: CandidateRow): readonly string[] | null => {
  if (row.key_field_digests === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.key_field_digests) as unknown;
  } catch {
    throw integrityError('key_field_digests is not JSON');
  }
  if (!isShapeDigests(parsed)) {
    throw integrityError('key_field_digests is not a sorted list of distinct digests within the limit');
  }
  return Object.freeze([...parsed]);
};

/** 保存した読み切れた画面の path の一覧（壊れていれば `ControlStoreError`）。 */
const readPagePathsOf = (row: DiscoveryJobRow): readonly string[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.read_page_paths) as unknown;
  } catch {
    throw integrityError('read_page_paths is not JSON');
  }
  if (!Array.isArray(parsed) || !parsed.every(isCandidatePath)) {
    throw integrityError('read_page_paths is not a list of page paths');
  }
  return sortedFrozen(parsed);
};

// ---------------------------------------------------------------------------------------------------------------
// トランザクションの中の部品（公開しない。`withWriteTransaction` の引数の中からだけ呼ぶ）
// ---------------------------------------------------------------------------------------------------------------

/** 記録の本体（トランザクションの中）。 */
const recordIn = (
  connection: SqliteConnection,
  update: Pick<DiscoveryIndexUpdate, 'profileId' | 'jobId' | 'at'>,
  checked: CheckedUpdate,
): DiscoveryIndexUpdateOutcome => {
  const { profileId, jobId, at } = update;
  // T27d: 同じジョブの 2 回目の記録は、ジョブの行（主キー）で拒む（候補が 0 件のジョブも同じ。主キーの制約は、最後の守り）。
  const recorded = connection.prepare(SELECT_JOB_RECORDED_SQL).get(jobId) as { readonly n: number };
  if (recorded.n > 0) {
    throw new RangeError('the discovery job was already recorded');
  }
  const latest = connection.prepare(SELECT_LATEST_JOB_SQL).get(profileId) as DiscoveryJobRow | undefined;
  if (latest !== undefined && at < latest.recorded_at) {
    throw new RangeError('the time must not be before the last discovery job of the profile');
  }
  connection.prepare(INSERT_JOB_SQL).run(jobId, profileId, at, JSON.stringify(checked.readPagePaths));
  const readPaths: ReadonlySet<string> = new Set(checked.readPagePaths);
  const rows = new Map((connection.prepare(SELECT_PROFILE_CANDIDATES_SQL).all(profileId) as unknown as CandidateRow[])
    .map((row) => [row.identity_digest, row]));
  const outcome: Record<DiscoveryIndexDrift, string[]> = { NEW: [], CHANGED: [], UNCHANGED: [], MISSING: [], NOT_REVISITED: [] };
  for (const entry of checked.entries) {
    const row = rows.get(entry.identityDigest);
    rows.delete(entry.identityDigest);
    // T31e: 型にした識別の digest の一覧は、どの場合も今回の一覧で書く（版 9 の前の行も、次の発見で一覧を持つ）。
    const templated = JSON.stringify(entry.templatedIdentityDigests);
    // T38d: 型の digest の一覧も、どの場合も今回の一覧で書く（版 13 の前の行も、次の発見で一覧を持つ。違いはドリフトに数えない）。
    const shapes = JSON.stringify(entry.shapeDigests);
    // T38R-fix の I-1: 鍵と欄の対応の digest の一覧も、どの場合も今回の一覧で書く。
    const keyFields = JSON.stringify(entry.keyFieldDigests);
    if (row === undefined) {
      connection.prepare(INSERT_CANDIDATE_SQL).run(
        profileId, entry.identityDigest, entry.ruleDigest, entry.classification, entry.reasonCode, entry.pagePath, entry.actionPath,
        entry.formMethod, entry.methodOverride, entry.hasStateField ? SQL_TRUE : SQL_FALSE, jobId, at, jobId, at, templated, shapes, keyFields,
      );
      outcome.NEW.push(entry.identityDigest);
    } else if (changedFrom(row, entry)) {
      connection.prepare(UPDATE_CHANGED_SQL).run(
        entry.ruleDigest, entry.classification, entry.reasonCode, entry.hasStateField ? SQL_TRUE : SQL_FALSE, jobId, at, jobId, templated, shapes,
        keyFields, profileId, entry.identityDigest,
      );
      outcome.CHANGED.push(entry.identityDigest);
    } else {
      connection.prepare(UPDATE_SEEN_SQL).run(jobId, at, templated, shapes, keyFields, profileId, entry.identityDigest);
      outcome.UNCHANGED.push(entry.identityDigest);
    }
  }
  // 今回の結果にない候補は、消さずに残す（最後に見たジョブが前のまま）。読み切れた画面の候補は `MISSING`、ほかは `NOT_REVISITED`。
  for (const row of rows.values()) {
    (readPaths.has(row.page_path) ? outcome.MISSING : outcome.NOT_REVISITED).push(row.identity_digest);
  }
  return Object.freeze({
    NEW: sortedFrozen(outcome.NEW),
    CHANGED: sortedFrozen(outcome.CHANGED),
    UNCHANGED: sortedFrozen(outcome.UNCHANGED),
    MISSING: sortedFrozen(outcome.MISSING),
    NOT_REVISITED: sortedFrozen(outcome.NOT_REVISITED),
  });
};

// ---------------------------------------------------------------------------------------------------------------
// 公開の関数
// ---------------------------------------------------------------------------------------------------------------

/**
 * 候補の、書き込みの probe（T38R-fix の C-1: 結果が `API_CREATE`・`API_UPDATE`。`submissionProbeWriteOf`）で、`inputFields` と型の digest を持つもの。
 * ほかの probe（2 つの要求になった `NOT_EXECUTABLE` など）の型は、索引に入れない。
 */
const writeProbeOf = (candidate: DiscoveryCandidate): (SubmissionProbeRecord & { readonly shapeDigest: string }) | null => {
  const probe = candidate.submissionProbe;
  return probe === undefined || probe.inputFields === undefined || probe.shapeDigest === null || submissionProbeWriteOf(probe.result) === null
    ? null
    : { ...probe, shapeDigest: probe.shapeDigest };
};

/** 候補の型の digest の一覧（T38d。T38R-fix の C-1: 書き込みの probe の型の digest だけ。凍結）。 */
const shapeDigestsOfCandidate = (candidate: DiscoveryCandidate): readonly string[] => {
  const probe = writeProbeOf(candidate);
  return Object.freeze(probe === null ? [] : [probe.shapeDigest]);
};

/** 候補の鍵と欄の対応の digest の一覧（T38R-fix の I-1。書き込みの probe の型と、欄に対応する鍵の欄の識別。凍結）。 */
const keyFieldDigestsOfCandidate = (candidate: DiscoveryCandidate): readonly string[] => {
  const probe = writeProbeOf(candidate);
  return Object.freeze(probe === null ? [] : [apiKeyFieldsDigestOf(probe.shapeDigest, scenarioApiKeyFieldsOfProbe(probe))]);
};

/**
 * 候補の型にした識別の digest の一覧（T31e の form の digest と、T41a の form のない候補の画面の path を型にした digest。印が違うので互いに当たらない。
 * form のない候補は form の digest を持たないので、上限 `MAX_RECORD_ID_SEGMENT_PAIRS` を超えない。並べて重なりなし。凍結）。
 */
const templatedDigestsOfCandidate = (candidate: DiscoveryCandidate): readonly string[] => {
  const page = pagePathTemplatedIdentityDigestOf(candidate);
  const form = templatedIdentityDigestsOf(candidate, (value) => usableRecordIdOf(value) !== null);
  return page === null ? form : sortedFrozen([...new Set([...form, page])]);
};

/**
 * 候補から、索引の 1 件の入力を作る（純粋。項目を選んで写す。値・トークン・label・ボタンの文言・欄の名前は写さない）。T31e: 型にした識別の digest の
 * 一覧を、候補の全体から求める（区切りの値が登録の ID の形 `usableRecordIdOf` に合う組だけ。digest だけを写す）。T38d: 型の digest の一覧は、
 * `inputFields` を持つ probe の型の digest（型がなければ空）。`inputFields` のない probe（T38a の前の成果物）と probe のない候補は空（型を持たない）。
 */
export const discoveryIndexEntryOf = (candidate: DiscoveryCandidate): DiscoveryIndexEntry => Object.freeze({
  identityDigest: candidate.identityDigest,
  ruleDigest: candidate.ruleDigest,
  classification: candidate.classification,
  reasonCode: candidate.reasonCode,
  pagePath: candidate.page.path,
  actionPath: candidate.action?.path ?? null,
  formMethod: candidate.formMethod,
  methodOverride: candidate.methodOverride,
  hasStateField: candidate.hasStateField,
  templatedIdentityDigests: templatedDigestsOfCandidate(candidate),
  shapeDigests: shapeDigestsOfCandidate(candidate),
  keyFieldDigests: keyFieldDigestsOfCandidate(candidate),
});

/**
 * 発見のジョブ 1 回の結果を、1 つのトランザクションで索引に書き（ジョブの行 `discovery_jobs` と候補の行）、前の記録に対するドリフトを返す
 * （設計書 4.4、4.6）。呼び出し側の誤り（形の違う入力、同じ識別の digest の違う中身、同じジョブを 2 回、最後の記録より前の時刻、形の違う読んだ画面の
 * path）は `RangeError` で、何も書かない。プロファイルがなければ、外部キーの誤りで何も書かない。
 */
export const recordDiscoveryCandidates = (database: ControlDatabase, update: DiscoveryIndexUpdate): DiscoveryIndexUpdateOutcome => {
  const checked = requireUpdate(update);
  const values = Object.freeze({ profileId: update.profileId, jobId: update.jobId, at: update.at });
  return withWriteTransaction(database, (connection) => recordIn(connection, values, checked));
};

const viewOf = (row: CandidateRow, latestJobId: string, latestReadPaths: ReadonlySet<string>): DiscoveryCandidateIndexView => {
  if (!isOneOf(CANDIDATE_CLASSIFICATIONS, row.classification) || !isOneOf(CANDIDATE_REASON_CODES, row.reason_code)) {
    throw integrityError('the classification or the reason code is not in the closed lists');
  }
  if ((row.form_method !== null && !isOneOf(FORM_METHODS, row.form_method))
    || (row.method_override !== null && !isOneOf(METHOD_OVERRIDE_VALUES, row.method_override))) {
    throw integrityError('the method is not in the closed lists');
  }
  let drift: DiscoveryIndexDrift = 'UNCHANGED';
  if (row.last_seen_job_id !== latestJobId) {
    drift = latestReadPaths.has(row.page_path) ? 'MISSING' : 'NOT_REVISITED';
  } else if (row.first_seen_job_id === latestJobId) {
    drift = 'NEW';
  } else if (row.last_changed_job_id === latestJobId) {
    drift = 'CHANGED';
  }
  return deepFreeze({
    profileId: row.profile_id,
    identityDigest: row.identity_digest,
    ruleDigest: row.rule_digest,
    classification: row.classification,
    reasonCode: row.reason_code,
    pagePath: row.page_path,
    actionPath: row.action_path,
    formMethod: row.form_method,
    methodOverride: row.method_override,
    hasStateField: row.has_state_field === SQL_TRUE,
    templatedIdentityDigests: templatedIdentityDigestsOfRow(row),
    shapeDigests: shapeDigestsOfRow(row),
    keyFieldDigests: keyFieldDigestsOfRow(row),
    firstSeenJobId: row.first_seen_job_id,
    firstSeenAt: row.first_seen_at,
    lastSeenJobId: row.last_seen_job_id,
    lastSeenAt: row.last_seen_at,
    lastChangedJobId: row.last_changed_job_id,
    drift,
  });
};

/**
 * プロファイルの索引を読む。最後の発見のジョブは、`discovery_jobs` の記録した時刻が最も新しい行のジョブ（同じ時刻なら、後に記録した行。
 * 記録した時刻は前のジョブより前にできないので、記録の順と同じ。ジョブの ID はランダムなので比べない。候補が 0 件のジョブも含む）。各候補のドリフトは、そのジョブに対するもの（最後に見たジョブが違えば、その画面をそのジョブで読み切れていれば
 * `MISSING`、読んでいなければ `NOT_REVISITED`。最初に見たのがそのジョブなら `NEW`、最後に変わったのがそのジョブなら `CHANGED`、ほかは
 * `UNCHANGED`）。
 */
export const readDiscoveryIndex = (database: ControlDatabase, profileId: string): DiscoveryIndexView =>
  withReadTransaction(database, (connection) => readDiscoveryIndexIn(connection, profileId));

/**
 * プロファイルの索引（`readDiscoveryIndex` と同じ形）を、呼び出し側のトランザクションの中で読む（CCX-17。CC-078。読むだけ。呼び出し側の
 * `withReadTransaction`・`withWriteTransaction` の中から呼ぶ）。
 */
export const readDiscoveryIndexIn = (connection: SqliteConnection, profileId: string): DiscoveryIndexView => {
  const latest = connection.prepare(SELECT_LATEST_JOB_SQL).get(profileId) as DiscoveryJobRow | undefined;
  if (latest === undefined) {
    return deepFreeze({ latestJobId: null, latestSeenAt: null, latestReadPagePaths: [], candidates: [] });
  }
  const latestReadPagePaths = readPagePathsOf(latest);
  const readPaths: ReadonlySet<string> = new Set(latestReadPagePaths);
  const rows = connection.prepare(SELECT_PROFILE_CANDIDATES_SQL).all(profileId) as unknown as CandidateRow[];
  return deepFreeze({
    latestJobId: latest.job_id,
    latestSeenAt: latest.recorded_at,
    latestReadPagePaths,
    candidates: rows.map((row) => viewOf(row, latest.job_id, readPaths)),
  });
};

/**
 * あるジョブ（索引を読んだときの最後のジョブ。なければ null）より後に、プロファイルの発見のジョブが記録されていないか（CCX-17。CC-078。読むだけ。
 * 索引を読んだ後に、書くトランザクションの中で確かめ直す）。
 */
export const noDiscoveryJobRecordedAfterIn = (connection: SqliteConnection, profileId: string, latestJobId: string | null): boolean =>
  (connection.prepare(SELECT_JOBS_AFTER_SQL).get(profileId, latestJobId, latestJobId) as { readonly n: number }).n === 0;
