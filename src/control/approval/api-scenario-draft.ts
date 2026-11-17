// API のシナリオの下書きの入力と案を作る唯一の部品（手を減らす段 2 の設計書 3A.2 の「共通化」。FM2a）。純粋な部品（管理データ・ファイル・画面に
// 依らない。同じ入力に同じ出力。入力を変えない）。作成の画面のサーバ（`apps/local-ui/src/server/scenario-functions.ts`）にあった
// `apiProbeDraftOf`・`apiFormOf`（T38f、T41e、T41e-3）を移した。画面の案と自動の下書き（FM2b）は、この部品を使う。
// - 入力: probe の記録を持つ候補（発見の結果）、発見の Run の情報（下書きの確かめの文脈 `ScenarioDraftContext`。承認したサービスの Origin、発見の時と
//   今のプロファイルの改訂、ほかのシナリオの事実）、既にあるシナリオの一覧（同じプロファイル。台帳の選択肢）。
// - 出力: 下書きの入力（`apiScenarioDraftInputOf`。保存の口と下書きの確かめが受ける形）と、案（`apiScenarioFormOf`。欄に対応する鍵・ページが決める鍵と
//   選べない理由、型の要約の案、filter の名前、台帳の選択肢、更新の画面の型の選択肢、候補を作れない理由）。
// - 選べるか・作れない理由は、下書きの確かめの owner（`validateScenarioDraft`）に、保存と同じ文脈で聞いて決める（判定を書き写さない）。更新の台帳の
//   参照は、確かめのためだけの登録のシナリオの事実（`DRAFT_PROBE_LEDGER_SCENARIO_ID`。この型と同じ送り先の API の登録）で確かめる（本当の台帳の参照は、
//   保存のときに確かめる）。台帳の選択肢は、台帳の結び付きの唯一の判定（`apiUpdateLedgerBindingRejectionOf`）で、画面の型のどれかで結び付くものだけ。
// - 副作用の確認の 4 項目は、必ず偽で作る（設計書 3A 章の共通の決まり。`UNCONFIRMED_SIDE_EFFECTS`）。上限と期限は契約の既定。
// - 案の出どころの印は `draft-value-origin.ts`（印は承認に結ばない）。
// - MI-7（設計書 `2026-10-26-beaksight-minimal-input-ux-design.md` 4.6）: 更新の台帳の選択肢ごとに、照合の READ を台帳の登録のシナリオから埋めるための
//   値（`apiUpdateLedgerReadVerificationOf`。定義の参照は今の版、期待は台帳の写し）か、埋められない理由を足す。比べる欄は、変える欄で決まる
//   ので、ここでは決めない。埋め方の唯一の置き場所は `update-verification-copy.ts`（SPEC-4 で、作成の画面とその写しは外した）。照合の READ の確かめは、
//   今の保存の口のまま。
import type { DiscoveryCandidate } from '../../discovery/candidate-contracts.js';
import { pagePathTemplateOptionsOf } from '../../discovery/fingerprint.js';
import { isReadCheckPageTemplatePath } from '../../discovery/read-check-contracts.js';
import {
  submissionProbeKeyFieldsOf,
  submissionProbeWriteOf,
  type SubmissionProbeOpener,
  type SubmissionProbeRecord,
} from '../../discovery/submission-probe-contracts.js';
import type { ApiJsonValueType } from '../../core/api-request-shape.js';
import { API_SCENARIO_TRANSPORT } from '../../core/scenario-transport.js';
import { usableRecordIdOf } from '../actions/action-outcome.js';
import {
  APPROVAL_TTL_DAYS,
  CREATE_SCENARIO_KIND,
  UPDATE_SCENARIO_KIND,
  DEFAULT_MAX_CREATES_PER_RUN,
  DEFAULT_MAX_CUMULATIVE_CREATES,
  RECORD_ID_PLACEHOLDER,
  SIDE_EFFECT_CONFIRMATIONS,
  scenarioApiKeyFieldsOfProbe,
  scenarioApiPublicationStateKeysOf,
  type ReadCheckReference,
  type ScenarioApiSpec,
  type ScenarioKind,
  type ScenarioKindFact,
  type ScenarioListRow,
  type ScenarioReadVerification,
  type VerificationExpectation,
  type SideEffectConfirmation,
  type SideEffectConfirmations,
} from './scenario-contracts.js';
import {
  apiLedgerTableMatchOf,
  apiRequestTargetOfProbe,
  apiUpdateFilterNamesOfProbe,
  apiUpdateLedgerBindingRejectionOf,
  validateScenarioDraft,
  type ScenarioDraftContext,
  type ScenarioDraftError,
  type ScenarioDraftRejectionReason,
} from './scenario-policy.js';

/** 登録・更新のシナリオの種類（CC-106: 種類の一覧の owner の名前つきの定数）。 */
const CREATE_KIND = CREATE_SCENARIO_KIND;
const UPDATE_KIND = UPDATE_SCENARIO_KIND;

/** 副作用の確認（どれも確かめていない。自動の下書きと、選べるかの確かめの下書きに使う）。 */
export const UNCONFIRMED_SIDE_EFFECTS: SideEffectConfirmations = Object.freeze(
  Object.fromEntries(SIDE_EFFECT_CONFIRMATIONS.map((item) => [item, false])) as Record<SideEffectConfirmation, boolean>,
);

/**
 * 選べるかを確かめる更新の下書きの、形だけ正しい値。path の型は、区切りの全体を印にした path（契約の印を使う。書き写さない）。台帳の参照は、シナリオの
 * id の形に合う、確かめのためだけの名前。
 */
export const DRAFT_PROBE_PATH_TEMPLATE = `/${RECORD_ID_PLACEHOLDER}`;
export const DRAFT_PROBE_LEDGER_SCENARIO_ID = 'scenario-form-probe';
/**
 * LU-7: 選べるかを確かめる一覧の行の更新の下書きの、行を選ぶ欄の形だけ正しい名前（確かめのためだけの台帳の事実の、実行のたびに違う値になる欄に入れる。
 * 本当の行を選ぶ欄は、保存のときに台帳の事実から選ぶ）。
 */
export const DRAFT_PROBE_ROW_KEY_FIELD = 'scenario-form-probe-row-key';

/** 更新の probe の記録の開き手（名前の有無によらない。更新でない・開き手のない記録は null）。 */
const updateProbeOpenerOf = (probe: SubmissionProbeRecord): SubmissionProbeOpener | null =>
  (submissionProbeWriteOf(probe.result)?.kind === UPDATE_KIND ? probe.opener ?? null : null);

/**
 * LU-7（設計書 `2026-11-02-beaksight-list-row-update-design.md` 5.4 の 4、4.0 の D3）: 一覧の行の更新の開き手（判定の 1 か所）。更新の probe の記録に、名前の
 * ある開き手があるときだけ、その開き手。ほかは null（開き手のない更新は今のまま。名前のない開き手の更新は、型の案を作らない）。
 */
export const listRowOpenerOf = (probe: SubmissionProbeRecord): SubmissionProbeOpener | null => {
  const opener = updateProbeOpenerOf(probe);
  return opener?.hasName === true ? opener : null;
};

/**
 * LU-13 fix round 1（設計書 4.0 の D3、5.6）: 更新の候補が、名前のない開き手（アイコンだけ）から出たものか（判定の 1 か所。事実は `listRowOpenerOf` と同じ
 * 開き手の `hasName`。API は更新の probe の記録の `opener`、フォームは同じ行の開き手 `rowOpener`）。サイトの画面の一覧が「この画面の更新は自動で扱えません」の
 * 1 行を出すのに使う。
 */
export const isUnnamedOpenerUpdateOf = (candidate: DiscoveryCandidate): boolean => {
  const opener = (candidate.submissionProbe === undefined ? null : updateProbeOpenerOf(candidate.submissionProbe)) ?? candidate.rowOpener ?? null;
  return opener !== null && !opener.hasName;
};

/** 更新の下書きで、更新の指定の入力で直せる、欄に結び付かない誤り（候補を作れない理由にしない）。 */
export const SCENARIO_UPDATE_INPUT_REASONS: ReadonlySet<ScenarioDraftRejectionReason> = new Set([
  'SCENARIO_UPDATE_TARGET_NOT_FOUND',
  'SCENARIO_UPDATE_TARGET_NOT_CREATE',
  'SCENARIO_UPDATE_PATH_MISMATCH',
  'SCENARIO_UPDATE_RECORD_ID_UNSAFE',
  'SCENARIO_UPDATE_NO_CHANGED_FIELD',
]);

/** API の下書きで、フォームの入力で直せる、鍵に結び付かない誤り（候補を作れない理由にしない）。 */
const API_INPUT_REASONS: ReadonlySet<ScenarioDraftRejectionReason> = new Set([
  'SCENARIO_API_KEY_NOT_ALLOWED',
  'SCENARIO_API_PAGE_KEY_SECRET_LIKE',
  'SCENARIO_API_FILTER_MISMATCH',
  // T38R-fix の I-2: ページが決める鍵の scalar と、登録の ID を読む応答の鍵の秘密に見える名前。
  'SCENARIO_API_PAGE_KEY_NOT_SCALAR',
  'SCENARIO_API_RECORD_ID_KEY_SECRET_LIKE',
  // T41e: 更新の画面の欄として識別できないページが決める鍵と、台帳の ID と filter の結び付き（入力の近くに出す。候補を作れない理由にしない）。
  'SCENARIO_API_PAGE_KEY_NOT_IDENTIFIABLE',
  'SCENARIO_API_FILTER_NOT_BOUND_TO_LEDGER_ID',
  // ARR-2: ページが決める一覧の鍵の入れ子と上限の超過（その鍵をページが決める鍵から外す理由。候補を作れない理由にしない）。
  'SCENARIO_API_ARRAY_NESTED',
  'SCENARIO_API_ARRAY_OVER_LIMIT',
  // ARR-3: 欄の印が 2 つ以上入る一覧の鍵（その鍵をページが決める鍵から外す理由）。
  'SCENARIO_API_ARRAY_MULTIPLE_FIELDS',
  // ARR-5 fix round 1: 一覧の位置の道が重なる鍵（その鍵をページが決める鍵から外す理由）。
  'SCENARIO_API_ARRAY_PATH_CONFLICT',
  ...SCENARIO_UPDATE_INPUT_REASONS,
]);
/**
 * ページが決める鍵に選べない理由（秘密に見える名前と、T38R-fix の I-2 の scalar でない鍵）。T41e: 更新の画面の欄として識別できない鍵（更新だけ。ユーザーの
 * 判断 2）。
 */
const PAGE_KEY_REJECTION_REASONS: ReadonlySet<ScenarioDraftRejectionReason> = new Set([
  'SCENARIO_API_PAGE_KEY_SECRET_LIKE',
  'SCENARIO_API_PAGE_KEY_NOT_SCALAR',
  'SCENARIO_API_PAGE_KEY_NOT_IDENTIFIABLE',
  // ARR-2: 入れ子の一覧と、上限を超える一覧（登録のページが決める一覧の鍵）。
  'SCENARIO_API_ARRAY_NESTED',
  'SCENARIO_API_ARRAY_OVER_LIMIT',
  // ARR-3（設計書 `2026-11-09-beaksight-api-array-rows-design.md` 2.2 の 3）: 欄の印が 2 つ以上入る一覧（ページが決める一覧として受けない）。
  'SCENARIO_API_ARRAY_MULTIPLE_FIELDS',
  // ARR-5 fix round 1（SREV-ARR2 の M1）: 一覧の位置の道が、ほかの鍵かほかの道と重なる。
  'SCENARIO_API_ARRAY_PATH_CONFLICT',
]);
/** T41e: 台帳の画面の型が候補の画面の path に合わない理由（API の更新の型の選択肢から外す。判定は下書きの確かめの owner）。 */
const TEMPLATE_MISMATCH_REASON = 'SCENARIO_UPDATE_PATH_MISMATCH' satisfies ScenarioDraftRejectionReason;
/** API の型を持たない候補の理由。 */
const NOT_API_REASON = 'SCENARIO_API_CANDIDATE_NOT_API' satisfies ScenarioDraftRejectionReason;

/** ID の区切りの値が、レコードの ID の形か（owner は `src/control/actions/action-outcome.ts`）。 */
export const isUsableRecordIdSegment = (value: string): boolean => usableRecordIdOf(value) !== null;

/** 下書きの入力の選び方（送る鍵、ページが決める鍵、更新の画面の型）。 */
export interface ApiScenarioDraftChoice {
  readonly fieldNames: readonly string[];
  readonly pageKeys: readonly string[];
  readonly formPathTemplate: string;
  /** LU-7: 一覧の行の更新の行の選び方（更新だけ。`formPathTemplate` は一覧の画面の path と同じにする）。省けば持たない。 */
  readonly listRow?: ScenarioListRow;
}

/**
 * API の下書きの入力（送る鍵とページが決める鍵を受け、ほかは既定の値。副作用の確認はすべて偽。更新は型の filter と、確かめのためだけの台帳の参照を足す）。
 */
export const apiScenarioDraftInputOf = (
  profileId: string,
  candidate: DiscoveryCandidate,
  probe: SubmissionProbeRecord,
  choice: ApiScenarioDraftChoice,
): Record<string, unknown> => {
  const kind = submissionProbeWriteOf(probe.result)?.kind ?? null;
  return {
    profileId,
    candidateIdentityDigest: candidate.identityDigest,
    transport: API_SCENARIO_TRANSPORT,
    fieldNames: [...choice.fieldNames],
    readChecks: [],
    sideEffectConfirmations: UNCONFIRMED_SIDE_EFFECTS,
    limits: { maxCreatesPerRun: DEFAULT_MAX_CREATES_PER_RUN, maxCumulativeCreates: DEFAULT_MAX_CUMULATIVE_CREATES },
    approvalTtlDays: APPROVAL_TTL_DAYS,
    api: {
      shapeDigest: probe.shapeDigest,
      pageKeys: [...choice.pageKeys],
      // DEF-198: 番号の filter は、並び順でなく画面の番号の印で選ぶ（唯一の決まり）。
      filterName: kind === UPDATE_KIND ? apiUpdateFilterNamesOfProbe(probe).filterName : null,
      recordId: null,
      ledger: kind === UPDATE_KIND
        ? {
          targetCreateScenarioId: DRAFT_PROBE_LEDGER_SCENARIO_ID,
          formPathTemplate: choice.formPathTemplate,
          ...(choice.listRow === undefined ? {} : { listRow: { ...choice.listRow } }),
        }
        : null,
    },
  };
};

/** 既にあるシナリオ 1 件（同じプロファイル。台帳の選択肢に要るものだけ）。 */
export interface ApiScenarioExistingScenario {
  readonly scenarioId: string;
  /** 今の版のシナリオの種類。 */
  readonly kind: ScenarioKind;
  /** 発見の根拠の画面の path。 */
  readonly pagePath: string;
  /** MI-7: 今の版の照合の READ（ない・渡さなければ、更新の照合の READ を台帳から埋めない）。 */
  readonly readVerification?: ScenarioReadVerification | null;
}

/** MI-7: 取り消していない READ の確かめの定義 1 件（台帳の照合の READ の定義を使えるかに要るものだけ）。 */
export interface ApiScenarioReadCheckFact extends ReadCheckReference {
  /** 画面の path の定義の path（候補の定義は null）。 */
  readonly targetPagePath: string | null;
}

/** 案を作る入力。 */
export interface ApiScenarioFormInput {
  readonly profileId: string;
  readonly candidate: DiscoveryCandidate;
  /** 下書きの確かめの文脈（保存と同じ。発見の Run の情報とほかのシナリオの事実）。 */
  readonly context: ScenarioDraftContext;
  readonly scenarios: readonly ApiScenarioExistingScenario[];
  /** MI-7: 取り消していない READ の確かめの定義（同じプロファイル。省けば、どの台帳の照合の READ も使えない）。 */
  readonly readChecks?: readonly ApiScenarioReadCheckFact[];
  /**
   * LU-7 fix round 1: 一覧の行の更新（名前のある開き手のある更新）の型の案（一覧の画面の path）を出すか。自動の下書き（`update-autodraft.ts`）だけが真にする。
   * 作成の画面の手での入力は、一覧の行の選び方を持てず保存できないので、省いて偽（開き手のある更新の型の案は 0 件）。
   */
  readonly listRowUpdate?: boolean;
  /**
   * DEF-203（設計書 `2026-11-02-beaksight-list-row-update-design.md` 5.10 の 2）: まだ保存していない同じ表の登録の下書きの、ページが決める鍵の名前（自動の下書きが、
   * 同じ操作で先に作る登録の下書きの鍵を渡す）。保存した登録の鍵は文脈の事実（`apiPageKeyNames`）から取る。省けばなし。
   */
  readonly createPageKeyNames?: readonly string[];
}

/**
 * DEF-203（設計書 5.10 の 2）: 同じ表（承認したサービスの Origin と path の型が同じ。同じ表の唯一の判定 `apiLedgerTableMatchOf` の `SAME_PATH`）の API の登録の
 * シナリオの、ページが決める鍵の名前（同じプロファイルの文脈の事実から。重なりなし）。送り先が分からないときは空。型の入口と案の部品が、台帳の登録の値と照らす鍵を
 * 選ぶのに使う（本当の台帳の確かめは、保存のときに下書きの確かめが行う）。
 */
export const sameTableCreatePageKeyNamesOf = (
  probe: SubmissionProbeRecord,
  context: Pick<ScenarioDraftContext, 'scenarios' | 'approvedServiceOrigins' | 'approvedTestOrigins'>,
  profileId: string,
): readonly string[] => {
  const target = apiRequestTargetOfProbe(probe, context);
  if (target === null) {
    return Object.freeze([]);
  }
  return Object.freeze([...new Set(context.scenarios.flatMap((fact: ScenarioKindFact) => (fact.profileId === profileId && fact.kind === CREATE_KIND
    && fact.apiRequest !== null && fact.apiRequest !== undefined && apiLedgerTableMatchOf(fact.apiRequest, target) === 'SAME_PATH'
    ? fact.apiPageKeyNames ?? []
    : [])))]);
};

/** 欄に対応する鍵 1 つ（probe の案。送るかを利用者が確かめる）。 */
export interface ApiScenarioKeyFieldProposal {
  readonly key: string;
  readonly type: ApiJsonValueType;
  readonly field: ScenarioApiSpec['keyFields'][number]['field'];
  /** T41e: 欄の型（メールアドレスと電話番号の欄は、既定で保つことを近くで知らせる）。 */
  readonly fieldType: ScenarioApiSpec['keyFields'][number]['fieldType'];
  /** その鍵を送れない理由（下書きの確かめの owner の、その鍵の誤り。送れるなら null）。 */
  readonly rejection: ScenarioDraftRejectionReason | null;
  /** ARR-4・ARR-5: 一覧の位置の欄（道 `key[i]`・`key[i].name`）だけが持つ、本文の一覧の鍵と位置（`ScenarioApiKeyField.element`）。 */
  readonly element?: ScenarioApiSpec['keyFields'][number]['element'];
}

/** 欄に対応しない鍵 1 つ（ページが決める鍵に選べるか）。 */
export interface ApiScenarioPageKeyProposal {
  readonly key: string;
  readonly type: ApiJsonValueType;
  /** ページが決める鍵に選べない理由（秘密に見える名前など。下書きの確かめの owner の誤り。選べるなら null）。 */
  readonly rejection: ScenarioDraftRejectionReason | null;
}

/**
 * MI-7: 更新の照合の READ を台帳から埋められない理由（閉じた一覧。画面の文言は `messages.ts` の `LOCAL_UI_SCENARIO_TEXT.api.ledgerReadUnavailable`）。
 * - `LEDGER_READ_VERIFICATION_MISSING`: 台帳の登録のシナリオに照合の READ がない（古い記録など）。
 * - `LEDGER_READ_CHECK_UNUSABLE`: 台帳の照合の READ の定義を、更新に使えない（取り消した、`{id}` つきの画面の path の定義でない、結び付けがある）。
 */
export const API_UPDATE_LEDGER_READ_UNAVAILABLE_REASONS = Object.freeze(['LEDGER_READ_VERIFICATION_MISSING', 'LEDGER_READ_CHECK_UNUSABLE'] as const);
export type ApiUpdateLedgerReadUnavailableReason = (typeof API_UPDATE_LEDGER_READ_UNAVAILABLE_REASONS)[number];

/** MI-7: 台帳の照合の READ から埋める値（定義の参照は今の版、期待は台帳の写し）か、埋められない理由。 */
export type ApiUpdateLedgerReadVerification =
  | {
    readonly status: 'FROM_LEDGER';
    readonly readCheckId: string;
    readonly revision: number;
    readonly expectations: readonly VerificationExpectation[];
  }
  | { readonly status: 'UNAVAILABLE'; readonly reason: ApiUpdateLedgerReadUnavailableReason };

/** 更新の台帳にできる登録のシナリオ 1 件。 */
export interface ApiScenarioLedgerOption {
  readonly scenarioId: string;
  readonly pagePath: string;
  /** MI-7: 照合の READ を、この台帳から埋める値か、埋められない理由。 */
  readonly readVerification: ApiUpdateLedgerReadVerification;
}

/**
 * MI-7: 台帳の照合の READ から埋める値。使えるのは、取り消していない `{id}` つきの画面の path の定義で、結び付けのないもの（更新の照合の READ も、
 * `{id}` に台帳の登録の ID が入る同じ定義を読む）。定義の参照は今の版（作成の画面の選択肢と同じ）。期待は台帳の写し（比べる欄は、画面が変える欄から
 * 選ぶ）。照合の READ の確かめ（`SCENARIO_API_READ_VERIFICATION_NOT_BOUND`、許可の発行の `READ_VERIFICATION_NOT_VARYING` など）は、保存と発行の今の口。
 */
export const apiUpdateLedgerReadVerificationOf = (
  ledger: ScenarioReadVerification | null | undefined,
  readChecks: readonly ApiScenarioReadCheckFact[],
): ApiUpdateLedgerReadVerification => {
  if (ledger === null || ledger === undefined) {
    return Object.freeze({ status: 'UNAVAILABLE', reason: 'LEDGER_READ_VERIFICATION_MISSING' });
  }
  const definition = readChecks.find(({ readCheckId }) => readCheckId === ledger.readCheckId);
  if (definition === undefined || definition.targetPagePath === null || !isReadCheckPageTemplatePath(definition.targetPagePath)
    || ledger.bindings.length > 0) {
    return Object.freeze({ status: 'UNAVAILABLE', reason: 'LEDGER_READ_CHECK_UNUSABLE' });
  }
  return Object.freeze({
    status: 'FROM_LEDGER',
    readCheckId: definition.readCheckId,
    revision: definition.revision,
    expectations: Object.freeze(ledger.expectations.map((expectation) => Object.freeze({ ...expectation }))),
  });
};

/** API の候補の案（probe の型から作る。値は持たない）。 */
export interface ApiScenarioFormProposal {
  /** 候補の行を選んだ型の digest。 */
  readonly shapeDigest: string;
  /** probe の結果のシナリオの種類（登録か更新）。 */
  readonly kind: ScenarioKind | null;
  /**
   * 型の要約の案（欄に対応する鍵をすべて送り、選べるページが決める鍵をすべて許した下書きを、下書きの確かめの owner が作った API の指定）。作れなければ
   * null。
   */
  readonly proposal: ScenarioApiSpec | null;
  readonly keyFields: readonly ApiScenarioKeyFieldProposal[];
  readonly pageKeys: readonly ApiScenarioPageKeyProposal[];
  /** DEF-147: 欄に対応する鍵とページが決める鍵のうち、公開の状態にあたる鍵（判定は契約の 1 か所）。 */
  readonly publicationStateKeys: readonly string[];
  /** 更新の filter の名前の案（型の filter。登録は null）。 */
  readonly filterName: string | null;
  /** 更新の台帳にできる登録のシナリオ（同じ表の API の登録。登録は空）。 */
  readonly ledgerOptions: readonly ApiScenarioLedgerOption[];
  /** 更新の画面の path の型の選択肢（候補の画面の path から作り、保存で拒まれない型だけ。登録は空）。 */
  readonly formPathTemplates: readonly string[];
}

/** 案と、候補を作れない理由。 */
export interface ApiScenarioFormResult {
  /** API の型を持たない候補は null。 */
  readonly form: ApiScenarioFormProposal | null;
  readonly rejection: ScenarioDraftRejectionReason | null;
}

/** probe の型の、欄に対応する鍵（契約の `scenarioApiKeyFieldsOfProbe`。索引の鍵と欄の digest と同じ作り方）と、欄に対応しない鍵。 */
const apiKeysOf = (probe: SubmissionProbeRecord): {
  readonly fielded: ScenarioApiSpec['keyFields'];
  readonly unfielded: readonly { readonly key: string; readonly type: ApiJsonValueType }[];
} => ({
  fielded: scenarioApiKeyFieldsOfProbe(probe),
  unfielded: submissionProbeKeyFieldsOf(probe).flatMap(({ key, type, field }) => (field === null ? [{ key, type }] : [])),
});

/** API の候補の案と、候補を作れない理由（下書きの確かめの owner に、保存と同じ文脈で任せる）。 */
export const apiScenarioFormOf = (input: ApiScenarioFormInput): ApiScenarioFormResult => {
  const { profileId, candidate, context, scenarios } = input;
  const readChecks = input.readChecks ?? [];
  const probe = candidate.submissionProbe;
  if (probe === undefined || probe.shapeDigest === null) {
    return { form: null, rejection: NOT_API_REASON };
  }
  // 案の確かめでは、更新の台帳の参照に、確かめのためだけの登録のシナリオの事実を足す（本当の台帳の参照は、保存のときに確かめる）。T41e-3（T41R-fix-B）:
  // 台帳は同じ表の API の登録だけなので、確かめのための事実も、この型と同じ送り先（`apiRequestTargetOfProbe`）を持つ API の登録にする。
  const requestTarget = apiRequestTargetOfProbe(probe, context);
  // DEF-203（設計書 5.10 の 2）: 確かめのための台帳のページが決める鍵は、同じ表の登録（保存したものと、まだ保存していない下書き）のページが決める鍵。
  const createPageKeyNames = [...new Set([...sameTableCreatePageKeyNamesOf(probe, context, profileId), ...(input.createPageKeyNames ?? [])])];
  const probeContext: ScenarioDraftContext = {
    ...context,
    // LU-7: 一覧の行の更新の行を選ぶ欄の確かめのため、確かめのためだけの行を選ぶ欄を、実行のたびに違う値になる欄に入れる。
    scenarios: [...context.scenarios, {
      scenarioId: DRAFT_PROBE_LEDGER_SCENARIO_ID, profileId, kind: CREATE_KIND, apiRequest: requestTarget, uniqueEachRunFieldNames: [DRAFT_PROBE_ROW_KEY_FIELD],
      apiPageKeyNames: createPageKeyNames,
    }],
  };
  const errorsOf = (draft: Record<string, unknown>): readonly ScenarioDraftError[] => {
    const result = validateScenarioDraft(draft, candidate, [], probeContext);
    return result.ok ? [] : result.errors;
  };
  const { fielded, unfielded } = apiKeysOf(probe);
  const kind = submissionProbeWriteOf(probe.result)?.kind ?? null;
  // LU-7（設計書 5.4 の 4）: 一覧の行から開いた窓の更新（probe の記録に開き手）は、自動の下書き（`listRowUpdate`）に限って、一覧の画面の path そのものを
  // 1 つの型の案にする（名前のない開き手・作成の画面は、案を作らない。D3）。開き手のない更新は今のまま（画面の path の ID の区切りを `{id}` にした型）。
  const listRowOpener = input.listRowUpdate === true ? listRowOpenerOf(probe) : null;
  const fromRow = kind === UPDATE_KIND && probe.opener !== undefined;
  const pathTemplates = fromRow
    ? (listRowOpener === null ? [] : [candidate.page.path])
    : [...pagePathTemplateOptionsOf(candidate.page.path, isUsableRecordIdSegment)];
  /** LU-7: 確かめのためだけの一覧の行の選び方（一覧の行の更新でなければ省く）。 */
  const probeListRowOf = (formPathTemplate: string): Pick<ApiScenarioDraftChoice, 'listRow'> => (listRowOpener === null ? {} : {
    listRow: { listPagePath: formPathTemplate, openerIdentityDigest: listRowOpener.identityDigest, rowKeyField: DRAFT_PROBE_ROW_KEY_FIELD },
  });
  // T41e（T41a の発見事項 3）: API の更新の画面の型は、保存で拒まれない型（`{id}` が最後の ID の区切り）だけを出す（判定は下書きの確かめの owner）。
  const templateDraftOf = (formPathTemplate: string) => apiScenarioDraftInputOf(profileId, candidate, probe, {
    fieldNames: fielded.map(({ key }) => key), pageKeys: [], formPathTemplate, ...probeListRowOf(formPathTemplate),
  });
  const formPathTemplates = kind === UPDATE_KIND
    ? pathTemplates.filter((template) => !errorsOf(templateDraftOf(template)).some(({ code }) => code === TEMPLATE_MISMATCH_REASON))
    : pathTemplates;
  const choiceOf = (pageKeys: readonly string[]): ApiScenarioDraftChoice => {
    const [firstTemplate] = formPathTemplates;
    return {
      fieldNames: fielded.map(({ key }) => key),
      pageKeys,
      formPathTemplate: firstTemplate ?? DRAFT_PROBE_PATH_TEMPLATE,
      ...(firstTemplate === undefined ? {} : probeListRowOf(firstTemplate)),
    };
  };
  const pageKeys = unfielded.map(({ key, type }): ApiScenarioPageKeyProposal => ({
    key,
    type,
    rejection: errorsOf(apiScenarioDraftInputOf(profileId, candidate, probe, choiceOf([key]))).find(({ code }) => PAGE_KEY_REJECTION_REASONS.has(code))?.code
      ?? null,
  }));
  const proposed = validateScenarioDraft(
    apiScenarioDraftInputOf(profileId, candidate, probe, choiceOf(pageKeys.filter(({ rejection }) => rejection === null).map(({ key }) => key))),
    candidate,
    [],
    probeContext,
  );
  const errors = proposed.ok ? [] : proposed.errors;
  const rejection = errors.find((error) => error.fieldName === null && error.readCheckId === null && !API_INPUT_REASONS.has(error.code))?.code ?? null;
  const filterName = kind === UPDATE_KIND ? apiUpdateFilterNamesOfProbe(probe).filterName : null;
  // T41e-3（T41R-fix-B の申し送り）: 台帳の選択肢は、保存を通る登録のシナリオだけ（台帳の事実と、下書きの確かめと同じ唯一の判定
  // `apiUpdateLedgerBindingRejectionOf`。画面の型のどれかで結び付くもの）。
  const isBoundLedger = (scenarioId: string): boolean => {
    const fact = context.scenarios.find((scenario) => scenario.scenarioId === scenarioId && scenario.profileId === profileId);
    return requestTarget !== null && fact !== undefined && formPathTemplates.some((formPathTemplate) =>
      apiUpdateLedgerBindingRejectionOf({ filterName, formPathTemplate, origin: requestTarget.origin, pathShape: requestTarget.pathShape }, fact) === null);
  };
  return {
    rejection,
    form: {
      shapeDigest: probe.shapeDigest,
      kind,
      proposal: proposed.ok ? structuredClone(proposed.content.api) ?? null : null,
      keyFields: fielded.map(({ key, type, field, fieldType, element }) => ({
        key, type, field, fieldType, rejection: errors.find((error) => error.fieldName === key)?.code ?? null,
        // ARR-5 fix round 1（SREV-ARR2 の M4）: 一覧の位置の欄だけ、本文の一覧の鍵と位置を持つ（画面は、これのある鍵だけを行の言い方にする）。
        ...(element === undefined ? {} : { element }),
      })),
      pageKeys,
      // DEF-147: 公開の状態にあたる鍵（欄に対応する鍵とページが決める鍵から。判定は契約の 1 か所）。
      publicationStateKeys: [...scenarioApiPublicationStateKeysOf({
        keyFields: fielded,
        pageKeys: unfielded.map(({ key, type }) => ({ key, type })),
      })],
      filterName,
      ledgerOptions: kind === UPDATE_KIND
        ? scenarios
          .filter((scenario) => scenario.kind === CREATE_KIND && isBoundLedger(scenario.scenarioId))
          .map(({ scenarioId, pagePath, readVerification }) => ({
            scenarioId, pagePath, readVerification: apiUpdateLedgerReadVerificationOf(readVerification, readChecks),
          }))
        : [],
      formPathTemplates: kind === UPDATE_KIND ? formPathTemplates : [],
    },
  };
};
