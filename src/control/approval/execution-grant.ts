// 実行の許可（ExecutionGrant）と件数の予約（WriteReservation）の純粋な決まりの唯一の owner（Task 28 の設計書 3 章、4.4。T28d）。
// - 拒む理由の閉じた一覧、予約の状態の遷移の表、許可の期限の計算、上限と残りの数え方、書き込みの同時実行の枠の判定を持つ。
// - SQL と管理データは持たない（T28d の Blocker の判断（案 A）: 版 6 の表に書くのは `scenario-store.ts` だけ。発行・消費・確かめ直し・撤回の結び付け・
//   予約の状態の変更の口は `scenario-store.ts` の「許可と予約」の節が、ここの決まりで判断して書く）。
// - 承認が有効かの判定は `approval-validity.ts`（ここでは判定しない）。時刻は 14 桁の UTC の文字列と、注入した `Date`。
import { dateOfCompactUtcTimestamp, formatCompactUtcTimestamp } from '../../core/utc-timestamp.js';
import {
  EXECUTION_GRANT_TTL_MS,
  WRITE_JOB_CONCURRENCY,
  type ScenarioLimits,
  type WriteReservationState,
} from './scenario-contracts.js';

/**
 * 実行の許可の発行・消費・確かめ直しを拒む理由（閉じた一覧）。
 * - 発行: `GRANT_SCENARIO_NOT_FOUND`（シナリオがない）、`GRANT_REVISION_CONFLICT`（画面が読んだ版と今の版が違う）、`GRANT_APPROVAL_INVALID`
 *   （承認が有効でない。理由は再承認の判定の理由）、`NEEDS_RULE_INPUT`（入力の規則の参照がない）、`GRANT_ALREADY_OPEN`（このシナリオに、消費して
 *   いない有効な許可がある）、`GRANT_WRITE_CONCURRENCY_EXCEEDED`（書き込みの同時実行の枠がない）、`GRANT_RUN_LIMIT_EXCEEDED`（件数が 1 回の Run の
 *   上限を超える）、`GRANT_FACTS_CHANGED`（確かめの間に発見のジョブが記録された）。
 *   T30a: `VERIFICATION_SPEC_MISSING`（シナリオの検証の指定のどれかが未指定。判定は `scenario-policy.ts` の `missingVerificationItemsOf`。発行の
 *   確かめに足すのは T30d）。
 *   T30d: `GRANT_ENVIRONMENT_EVIDENCE_MISSING`（プロファイルの環境の証跡の参照が空。`environmentEvidenceRejectionOf`）。
 *   LZ-3c: 累積の上限（`GRANT_CUMULATIVE_LIMIT_REACHED`）と連続の上限（`GRANT_WRITE_INTERVAL_NOT_ELAPSED`・`GRANT_DAILY_WRITE_LIMIT_REACHED`）の理由は、
 *   L12b で出さなくなったので捨てた（発行の結果は管理データ・成果物に残らない）。
 * - 消費と確かめ直し: `GRANT_NOT_FOUND`（ない id。偽造を含む）、`GRANT_MISMATCH`（別のシナリオ・ジョブ・プロファイル・版、または承認の記録が
 *   変わった）、`GRANT_EXPIRED`（許可の期限を過ぎた。無効にし予約を返す）、`GRANT_ALREADY_CONSUMED`（2 回目）、`GRANT_INVALIDATED`（撤回や期限切れで
 *   無効にした）、`GRANT_NOT_CONSUMED`（確かめ直しで、まだ消費していない）。消費と確かめ直しも、承認が有効でなければ `GRANT_APPROVAL_INVALID`。
 * - T28R-fix-1（独立レビュー T28R の I-2、M-2）: `GRANT_RESERVATION_SETTLED`（確かめ直しで、その許可の予約が `RESERVED` でない。送った・分からない・
 *   返した後の許可で、次の書き込みの要求を送らない）、`GRANT_CLOCK_BEFORE_APPROVAL`（発行の時刻が、承認の時刻より前。時計の巻き戻し）、
 *   `GRANT_CLOCK_BEFORE_ISSUE`（消費の時刻が、発行の時刻より前）。
 * - LG-3（2026-10-24 のテストの組の設計 3.7.2）: T31b の `SCENARIO_UPDATE_SPEC_MISSING`（UPDATE の指定の前に保存した UPDATE の版）は捨てた。その版は
 *   読むときに契約の形の誤り（`DATABASE_INTEGRITY_FAILED`）で止まる。
 * - T31e（Task 31 の設計書 3 章の「対象の選び方」）: `TARGET_SELECTION_CHANGED`（発行で、UPDATE の対象を選び直した結果が、画面が見せた予定の
 *   レコードの ID と違う）、`TARGET_RECORD_UNAVAILABLE`（発行で、UPDATE の対象にできるレコード（参照した CREATE のシナリオの `VERIFIED` の登録）が
 *   ない）。
 */
export const EXECUTION_GRANT_REJECTION_REASONS = Object.freeze([
  'GRANT_SCENARIO_NOT_FOUND',
  'GRANT_REVISION_CONFLICT',
  'GRANT_APPROVAL_INVALID',
  'NEEDS_RULE_INPUT',
  'VERIFICATION_SPEC_MISSING',
  'GRANT_ENVIRONMENT_EVIDENCE_MISSING',
  'GRANT_ALREADY_OPEN',
  'GRANT_WRITE_CONCURRENCY_EXCEEDED',
  'GRANT_RUN_LIMIT_EXCEEDED',
  'GRANT_FACTS_CHANGED',
  'GRANT_NOT_FOUND',
  'GRANT_MISMATCH',
  'GRANT_EXPIRED',
  'GRANT_ALREADY_CONSUMED',
  'GRANT_INVALIDATED',
  'GRANT_NOT_CONSUMED',
  'GRANT_RESERVATION_SETTLED',
  'GRANT_CLOCK_BEFORE_APPROVAL',
  'GRANT_CLOCK_BEFORE_ISSUE',
  'TARGET_SELECTION_CHANGED',
  'TARGET_RECORD_UNAVAILABLE',
  // T31R-fix-1 の I-2: 下書きの保存の後に台帳の登録の ID の取り方が変わり、path の型の `{id}` の位置に結び付かなくなった（下書きの理由と同じ名前）。
  'SCENARIO_UPDATE_PATH_NOT_BOUND_TO_LEDGER_ID',
  // LG-3b（2026-10-24 のテストの組の設計 3.7.2）: T38b の `API_WRITE_NOT_AVAILABLE`（T41a の契約のない API の更新）は捨てた（その版は、スキーマが
  // 拒むので保存の部品が読まない）。
  // T40R2-fix（Task 40 の設計書 7 章の「T40R2」の行の M-1）: API のシナリオの送る値を持たない照合の READ（`{id}` の型）の期待が、実行のたびに変わる値
  // （生成した値）と比べない（毎回同じ値になる規則の欄だけと比べる）。判定は `src/control/data-rules/varying-values.ts`。
  'READ_VERIFICATION_NOT_VARYING',
  // T41b（Task 41 の設計書 3.2）: 下書きの保存の後に台帳の登録の ID の取り方（応答の本文の鍵）が変わり、API の更新の filter の名前に結び付かなくなった
  // （下書きの理由と同じ名前。判定は `scenario-policy.ts` の `apiUpdateLedgerBindingRejectionOf`）。
  'SCENARIO_API_FILTER_NOT_BOUND_TO_LEDGER_ID',
  // MI-F1（設計書 `2026-10-26-beaksight-minimal-input-ux-design.md` 4.7.1 の 5。MI-R の Minor 7）: 発行・消費・確かめ直しで、シナリオの今の版の副作用の確認に、
  // まだ確かめていない項目がある（承認の不変条件に頼らない多重の守り。判定は `scenario-policy.ts` の `unconfirmedSideEffectsOf`。承認の理由と同じ名前）。
  'SCENARIO_SIDE_EFFECTS_UNCONFIRMED',
] as const);
export type ExecutionGrantRejectionReason = (typeof EXECUTION_GRANT_REJECTION_REASONS)[number];

/** 予約の状態の変更を拒む理由（閉じた一覧）。 */
export const WRITE_RESERVATION_REJECTION_REASONS = Object.freeze(['RESERVATION_NOT_FOUND', 'RESERVATION_TRANSITION_NOT_ALLOWED'] as const);
export type WriteReservationRejectionReason = (typeof WRITE_RESERVATION_REJECTION_REASONS)[number];

/**
 * 予約の状態の遷移の表（閉じた表。ほかの遷移は拒む）。`RESERVED` から、送った（`COMMITTED`）・送ったか分からない（`UNKNOWN`）・送る前に返した
 * （`RELEASED`）へだけ移る。決着した状態からは移らない（`UNKNOWN` を `COMMITTED` に昇格しない）。
 */
export const WRITE_RESERVATION_TRANSITIONS: Readonly<Record<WriteReservationState, readonly WriteReservationState[]>> = Object.freeze({
  RESERVED: Object.freeze(['COMMITTED', 'UNKNOWN', 'RELEASED'] as const),
  RELEASED: Object.freeze([] as const),
  COMMITTED: Object.freeze([] as const),
  UNKNOWN: Object.freeze([] as const),
});

/** 予約の状態を `from` から `to` へ移してよいか（表にある遷移だけ）。 */
export const isWriteReservationTransitionAllowed = (from: WriteReservationState, to: WriteReservationState): boolean =>
  WRITE_RESERVATION_TRANSITIONS[from].includes(to);

/** 累積に数える予約の状態（予約中・送った・送ったか分からない。返したものは数えない）。 */
export const COUNTED_WRITE_RESERVATION_STATES = Object.freeze(['RESERVED', 'COMMITTED', 'UNKNOWN'] as const satisfies readonly WriteReservationState[]);

/** 予約 1 件の、数え方に要る項目（許可の id は、数えない許可を除くときに使う）。 */
export interface CountedWriteReservation {
  readonly grantId?: string;
  readonly state: WriteReservationState;
  readonly count: number;
}

/** 数えない許可が、まだないときの空の集まり。 */
const NO_EXCLUDED_GRANTS: ReadonlySet<string> = new Set();

/**
 * 累積の使った件数（`COUNTED_WRITE_RESERVATION_STATES` の予約の件数の合計）。`excludedGrantIds` の許可の予約は数えない（T28R-fix-1。M-6: 発行は、
 * 期限切れなどで次の発行のときに無効にする許可の予約を数えない。画面の「使った件数」も、同じこの関数と `expiredOpenGrantIdsOf` で数える）。
 */
export const usedCumulativeWrites = (
  reservations: readonly CountedWriteReservation[],
  excludedGrantIds: ReadonlySet<string> = NO_EXCLUDED_GRANTS,
): number =>
  reservations
    .filter(({ state, grantId }) => (COUNTED_WRITE_RESERVATION_STATES as readonly WriteReservationState[]).includes(state)
      && (grantId === undefined || !excludedGrantIds.has(grantId)))
    .reduce((sum, { count }) => sum + count, 0);

/** 許可 1 件の、期限切れの判定に要る項目。 */
export interface ExpiringGrant {
  readonly grantId: string;
  readonly expiresAt: string;
  readonly consumedAt: string | null;
  readonly invalidatedAt: string | null;
  /** L12b: 許可のジョブの行があるか（あれば、期限で古い許可にしない）。省略はない（今のまま期限で判定する）。 */
  readonly jobExists?: boolean;
}

/**
 * 期限を過ぎた、消費していない有効な許可（まだ無効にしていない）の id（T28R-fix-1。M-6）。発行は、次の発行のときに無効にして予約を返すので、
 * これらの予約を件数と同時実行の枠に数えない。画面の「使った件数」も同じ。
 */
export const expiredOpenGrantIdsOf = (grants: readonly ExpiringGrant[], now: Date): ReadonlySet<string> =>
  new Set(grants
    // L12b（設計書 6.2。S16）: 許可はジョブの中の予約で、期限で切らない。古い許可として捨てるのは、ジョブの行がない（ジョブが始まらなかった）まま、前の期限の
    // 長さ（`EXECUTION_GRANT_TTL_MS`）を過ぎた許可だけ（発行の後に落ちた画面の取り残し。ジョブが動いている許可は、何分でも有効）。
    .filter((grant) => grant.consumedAt === null && grant.invalidatedAt === null && grant.jobExists !== true
      && isExecutionGrantExpired(grant.expiresAt, now))
    .map(({ grantId }) => grantId));

/** 予約の件数の最小。 */
const MIN_RESERVATION_COUNT = 1;

/**
 * 予約の件数を判定する。件数が 1 回の Run の上限の外（1 未満を含む）なら `GRANT_RUN_LIMIT_EXCEEDED`、受けるなら null（1 つのジョブが送るのは承認した 1 回。
 * 管理データの予約の件数も 1 に縛る）。L12b（設計書 `2026-11-09-beaksight-remove-limits-design.md` 6.2。S14）: 累積の件数（`limits.maxCumulativeCreates`）は当てない。
 */
export const writeLimitRejectionOf = (count: number, limits: ScenarioLimits): 'GRANT_RUN_LIMIT_EXCEEDED' | null => {
  return !Number.isSafeInteger(count) || count < MIN_RESERVATION_COUNT || count > limits.maxCreatesPerRun ? 'GRANT_RUN_LIMIT_EXCEEDED' : null;
};

// LZ-3c: 連続の上限（前の T30d の `writeRateRejectionOf`。最後の書き込みから 5 分・24 時間に 5 件）と、その予定（前の T30g の `writeScheduleOf`）は、
// L12b（設計書 `2026-11-09-beaksight-remove-limits-design.md` 6.2）で当てなくなったので捨てた（理由も一覧から捨てた。管理データ・成果物に残らない）。

/**
 * 環境の証跡の参照の判定（Task 30 の設計書 3 章の「外部への通知」、10 章の 4。T30d）。null、空、空白だけなら `GRANT_ENVIRONMENT_EVIDENCE_MISSING`、
 * 受けるなら null（参照の細かい形の確かめは、プロファイルの確かめ `profile-policy.ts` が保存のときに行う。ここは書き込みの前の重ねた確かめ）。
 */
export const environmentEvidenceRejectionOf = (reference: string | null): 'GRANT_ENVIRONMENT_EVIDENCE_MISSING' | null =>
  reference === null || reference.trim().length === 0 ? 'GRANT_ENVIRONMENT_EVIDENCE_MISSING' : null;

// LG-3b（2026-10-24 のテストの組の設計 3.7.2）: API の書き込みの判定 `apiWriteRejectionOf`（T38b・T38f・T40a・T41b。T41a の契約のない API の更新に
// 許可を出さない重ねの守り）は捨てた。契約のない API の更新の版は、シナリオのスキーマが拒むので、保存も読み出しもされない（読むときに
// `DATABASE_INTEGRITY_FAILED`）。API の登録と、契約のある API の更新には、FORM と同じ確かめ（有効性、入力の規則、検証の指定、上限、予約）で許可を出す。

/** 書き込みの同時実行の枠があるか（動いている書き込みの数（消費していない有効な許可と、決着していない消費済みの許可）が枠より少ない）。 */
export const isWriteConcurrencyAvailable = (activeWrites: number): boolean => activeWrites < WRITE_JOB_CONCURRENCY;

/** 許可の期限の時刻（発行の時刻 + `EXECUTION_GRANT_TTL_MS`。UTC の 14 桁）。発行の時刻の形が違えば `RangeError`。 */
export const executionGrantExpiresAtOf = (issuedAt: string): string =>
  formatCompactUtcTimestamp(new Date(dateOfCompactUtcTimestamp(issuedAt).getTime() + EXECUTION_GRANT_TTL_MS), 'execution grant expiry time');

/** 許可の期限を過ぎたか（ちょうど期限の時刻は期限切れ）。 */
export const isExecutionGrantExpired = (expiresAt: string, now: Date): boolean =>
  now.getTime() >= dateOfCompactUtcTimestamp(expiresAt).getTime();

/** UPDATE の対象にできるレコード 1 件（T31e。参照した CREATE のシナリオの `VERIFIED` の登録。台帳の読み出しは `write-result-facts.ts`）。 */
export interface UpdateTargetCandidate {
  /** 登録の ID（`isUsableRecordId` の形）。 */
  readonly recordId: string;
  /** 登録の時刻（送信の時刻。UTC の 14 桁）。 */
  readonly registeredAt: string;
  /** 登録した書き込みのジョブの id（同じ時刻の登録の順を決める）。 */
  readonly jobId: string;
}

/**
 * UPDATE の対象の選び方（純粋。T31e。Task 31 の設計書 2 章のユーザーの判断 4・5）: 対象にできるレコードのうち、登録の時刻が最も新しい 1 件
 * （同じ時刻なら、ジョブの id の UTF-16 のコード単位の順の後のもの）の ID。外すレコードはなく、レコードごとの回数も数えない（前の UPDATE の結果
 * （`UNKNOWN` を含む）によらず、同じレコードを選ぶ）。対象がなければ null。
 */
export const selectUpdateTargetRecordId = (candidates: readonly UpdateTargetCandidate[]): string | null => {
  let latest: UpdateTargetCandidate | null = null;
  for (const candidate of candidates) {
    if (latest === null || candidate.registeredAt > latest.registeredAt
      || (candidate.registeredAt === latest.registeredAt && candidate.jobId > latest.jobId)) {
      latest = candidate;
    }
  }
  return latest?.recordId ?? null;
};

/**
 * 発行の中の、対象の選び直しの判定（純粋。T31e）。選び直した ID がなければ `TARGET_RECORD_UNAVAILABLE`、画面が見せた予定の ID（`expected`）と違えば
 * `TARGET_SELECTION_CHANGED`、同じなら null。
 */
export const targetSelectionRejectionOf = (
  selected: string | null,
  expected: string | null,
): 'TARGET_RECORD_UNAVAILABLE' | 'TARGET_SELECTION_CHANGED' | null => {
  if (selected === null) {
    return 'TARGET_RECORD_UNAVAILABLE';
  }
  return selected === expected ? null : 'TARGET_SELECTION_CHANGED';
};
