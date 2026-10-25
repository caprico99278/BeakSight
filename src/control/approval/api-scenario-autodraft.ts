// シナリオの下書きをボタン 1 回で作るときの決まりの唯一の owner（手を減らす段 2 の設計書 3A.2。5 章の 2026-10-22 の FM2b の Blocker の判断（案 2））。
// 純粋な部品（管理データ・ファイル・画面に依らない。同じ入力に同じ出力。入力を変えない）。画面のサーバ（`apps/local-ui/src/server/scenario-autodraft-functions.ts`）は、
// これを呼んで、今の保存の口（シナリオ・READ の確かめの定義・入力の規則）で保存するだけにする。
// - 作る順（`apiAutoDraftRowsOf`・`apiAutoDraftPlanOf`）: 登録（`API_CREATE` の型の行）の下書きを先に作り、更新（`API_UPDATE` の型の行）は後。更新は保存しない
//   （変える欄は人が必ず選ぶ。ユーザーの判断 2026-10-22。変える欄が 0 の下書きは今の下書きの確かめを通らず、確かめと承認の境界は変えない）。更新は、
//   作成の画面へ案内し、そこで前もって選ぶ値（台帳と更新の画面の型。`apiUpdateDraftPresetOf`）を、登録を保存した後の事実で求める。
// - 登録の下書き: 送る鍵は欄に対応する鍵のすべて、ページが決める鍵は選べる鍵のすべて（`apiScenarioFormOf` の案。FM2a）。上限と期限は既定。副作用の
//   確認の 4 項目は必ず偽（`UNCONFIRMED_SIDE_EFFECTS`）。`recordId.key` は、同じ表（同じ Origin と path の型）の更新の filter の名前がちょうど 1 つのとき
//   だけ推す（`inferredRecordIdKeyOf`。推測の印）。推せなければ null（人が入れる）。
// - 台帳の結び付けの判定（`apiUpdateDraftPresetOf`）: 結び付く登録（判定は下書きの確かめの owner の `apiUpdateLedgerBindingRejectionOf`。案の部品の
//   `ledgerOptions`）がちょうど 1 つのときだけ選ぶ。0 なら、同じ操作で先に作った登録の下書きが結び付けば、それが 1 つになる。2 つ以上なら選ばない。
//   更新の画面の型は、案がちょうど 1 つなら `ONLY_FORM_PATH_TEMPLATE`、2 つ以上なら先頭を推測（`FIRST_FORM_PATH_TEMPLATE`）。
// - 照合の READ（登録の下書きだけ）: `{id}` の画面の型は、読めた画面の path から推す（`inferredReadPageTemplateOf`。推測の印）。定義の期待は、今の決まりの
//   とおり仮の 1 件（`AUTO_DRAFT_READ_CHECK_PLACEHOLDER_EXPECTATIONS`。型の定義は単独で読まないので照らさない）。シナリオの期待の欄は、入力の規則を付けた
//   後に、実行のたびに値が変わる欄から推す（`inferredReadExpectationOf`。推測の印）。
// - 既にあるもの: 同じ型の行（候補の識別の digest と型の digest）のシナリオがあれば、状態（下書き・承認済み・撤回済み）によらず作らない（書き換えない）。
// - 推測の印は承認に結ばない。表示のときに、同じ部品で求め直す（`autoDraftInferredItemsOf`）。
import { isOriginInAllowedOrigins } from '../../crawl/normalize-url.js';
import type { DiscoveryCandidate } from '../../discovery/candidate-contracts.js';
import { isReadCheckPageTemplatePath, type ReadCheckExpectation } from '../../discovery/read-check-contracts.js';
import { submissionProbeWriteOf, type SubmissionProbeRecord } from '../../discovery/submission-probe-contracts.js';
import {
  DRAFT_PROBE_PATH_TEMPLATE,
  apiScenarioDraftInputOf,
  apiScenarioFormOf,
  isUsableRecordIdSegment,
  type ApiScenarioFormProposal,
} from './api-scenario-draft.js';
import { draftValueOf, type DraftValue, type DraftValueGround, type DraftValueOrigin } from './draft-value-origin.js';
import {
  CREATE_SCENARIO_KIND,
  RECORD_ID_PLACEHOLDER,
  SCENARIO_ID_PATTERN,
  SCENARIO_API_RECORD_ID_SOURCES,
  UPDATE_SCENARIO_KIND,
  API_SCENARIO_TRANSPORT,
  scenarioTransportOf,
  type ReadCheckReference,
  type ScenarioContent,
  type ScenarioKind,
  type ScenarioReadVerification,
  type ScenarioState,
  type VerificationExpectation,
} from './scenario-contracts.js';
import {
  apiRequestTargetOfProbe,
  apiScenarioShapeRejectionOf,
  validateScenarioDraft,
  type ScenarioDraftContext,
  type ScenarioDraftRejectionReason,
} from './scenario-policy.js';

/** 下書きを作る型の行 1 つ（API の登録か更新の、probe の型を持つ候補の行）。 */
export interface AutoDraftRow {
  readonly kind: ScenarioKind;
  readonly candidate: DiscoveryCandidate;
  readonly shapeDigest: string;
}

/** 既にあるシナリオ 1 件の事実（同じプロファイル。既にあるかの判定に要るものだけ）。 */
export interface AutoDraftScenarioFact {
  readonly scenarioId: string;
  readonly kind: ScenarioKind;
  readonly state: ScenarioState;
  readonly candidateIdentityDigest: string;
  /** API のシナリオの型の digest（form のシナリオは null）。 */
  readonly shapeDigest: string | null;
}

/** 登録の行の計画（作る・既にある・作れない）。 */
export type AutoDraftCreatePlan =
  | {
    readonly status: 'NEW';
    readonly row: AutoDraftRow;
    /** 保存の口に渡す下書き（今の下書きの確かめを通る形）。 */
    readonly draft: Readonly<Record<string, unknown>>;
    /** 推した登録の ID の応答の鍵（推せなければ null。人が入れる）。 */
    readonly recordIdKey: DraftValue<string> | null;
    /** 下書きの値と根拠（表示の順）。 */
    readonly values: readonly DraftValue<unknown>[];
  }
  | { readonly status: 'EXISTING'; readonly row: AutoDraftRow; readonly scenarioId: string }
  | { readonly status: 'REJECTED'; readonly row: AutoDraftRow; readonly reason: ScenarioDraftRejectionReason };

/** 更新の行の計画（変える欄を人が選ぶ・既にある・作れない）。更新は保存しない。 */
export type AutoDraftUpdatePlan =
  | { readonly status: 'NEEDS_CHANGED_FIELDS'; readonly row: AutoDraftRow }
  | { readonly status: 'EXISTING'; readonly row: AutoDraftRow; readonly scenarioId: string }
  | { readonly status: 'REJECTED'; readonly row: AutoDraftRow; readonly reason: ScenarioDraftRejectionReason };

/** 計画（作る順: 登録が先、更新が後）。 */
export interface AutoDraftPlan {
  readonly creates: readonly AutoDraftCreatePlan[];
  readonly updates: readonly AutoDraftUpdatePlan[];
}

/** 計画の入力。 */
export interface AutoDraftPlanInput {
  readonly profileId: string;
  /** 最後の発見の候補（同じ識別でまとめた後の行。API の行でない候補は使わない）。 */
  readonly candidates: readonly DiscoveryCandidate[];
  /** 下書きの確かめの文脈（保存と同じ。発見の Run の情報とほかのシナリオの事実）。 */
  readonly context: ScenarioDraftContext;
  readonly scenarios: readonly AutoDraftScenarioFact[];
}

/** 更新の作成の画面で前もって選ぶ値。 */
export interface AutoDraftUpdatePreset {
  /** 台帳（結び付く登録がちょうど 1 つのときだけ。ほかは null）。 */
  readonly ledger: DraftValue<string> | null;
  /** 結び付く登録の数（0 なら登録の下書きが要る、2 つ以上なら人が選ぶ）。 */
  readonly ledgerOptionCount: number;
  /** 更新の画面の型（案がなければ null）。 */
  readonly formPathTemplate: DraftValue<string> | null;
}

/** 表示のときに求め直す推測の項目（閉じた一覧。画面の文言は `messages.ts` の `LOCAL_UI_AUTO_DRAFT_TEXT.inferredItems`）。 */
export const AUTO_DRAFT_INFERRED_ITEMS = Object.freeze([
  'RECORD_ID_KEY',
  'READ_PAGE_TEMPLATE',
  'READ_EXPECTATION',
  // FM2R の Minor 11: 更新の前もって選んだ画面の型（推測のとき）と、範囲の既定の幅を入れた欄。
  'UPDATE_FORM_PATH_TEMPLATE',
  'DEFAULT_RANGE_FIELD',
] as const);
export type AutoDraftInferredItemKind = (typeof AUTO_DRAFT_INFERRED_ITEMS)[number];

/** 推測の項目 1 つ（値と根拠）。 */
export interface AutoDraftInferredItem {
  readonly item: AutoDraftInferredItemKind;
  readonly value: string;
  readonly origin: DraftValueOrigin;
  readonly ground: DraftValueGround;
}

/** 照合の READ の `{id}` の型の定義の、仮の期待（今の決まり: 定義は期待を 1 件以上持つ。型の定義は単独で読まないので照らさない）。 */
export const AUTO_DRAFT_READ_CHECK_PLACEHOLDER_EXPECTATIONS: readonly ReadCheckExpectation[] = Object.freeze([
  Object.freeze({ kind: 'ROW_COUNT_AT_LEAST', count: 1 } as const),
]);

/** 登録の ID を読む応答の鍵の取り方（応答の本文の鍵）。 */
const [RESPONSE_BODY_KEY_SOURCE] = SCENARIO_API_RECORD_ID_SOURCES;
/** 発見の改訂が古い理由。 */
const STALE_REASON = 'SCENARIO_API_DISCOVERY_PROFILE_STALE' satisfies ScenarioDraftRejectionReason;
/** 登録の ID を読む応答の鍵が秘密に見える理由（推した鍵が当たれば、鍵を空にする）。 */
const RECORD_ID_KEY_SECRET_REASON = 'SCENARIO_API_RECORD_ID_KEY_SECRET_LIKE' satisfies ScenarioDraftRejectionReason;
/** path の区切り。 */
const PATH_SEPARATOR = '/';
/** ID の区切りに見える値（数字を 1 つ以上含む。`new`・`import` のような語を ID にしない）。 */
const HAS_DIGIT = /[0-9]/u;
/** 照合の READ の期待の種類（本文が含む）。 */
const TEXT_CONTAINS_KIND = 'TEXT_CONTAINS' satisfies VerificationExpectation['kind'];
/** 本文が含む期待。 */
type TextContainsExpectation = Extract<VerificationExpectation, { readonly kind: typeof TEXT_CONTAINS_KIND }>;

const rowKeyOf = (identityDigest: string, shapeDigest: string | null): string => `${identityDigest}\u0000${shapeDigest ?? ''}`;

/** 候補の、書き込みの probe の行（型の digest と欄の範囲を持つ API の登録か更新）。ほかは null。 */
const rowOf = (candidate: DiscoveryCandidate): AutoDraftRow | null => {
  const probe = candidate.submissionProbe;
  const kind = probe === undefined ? null : submissionProbeWriteOf(probe.result)?.kind ?? null;
  return probe === undefined || kind === null || probe.shapeDigest === null || probe.shape === null || probe.inputFields === undefined
    ? null
    : { kind, candidate, shapeDigest: probe.shapeDigest };
};

/** 下書きを作る型の行（作る順: 登録が先、更新が後。それぞれ候補の順。同じ識別と型の行は 1 つ。凍結）。 */
export const apiAutoDraftRowsOf = (candidates: readonly DiscoveryCandidate[]): readonly AutoDraftRow[] => {
  const seen = new Set<string>();
  const rows = candidates.flatMap((candidate) => {
    const row = rowOf(candidate);
    if (row === null || seen.has(rowKeyOf(candidate.identityDigest, row.shapeDigest))) {
      return [];
    }
    seen.add(rowKeyOf(candidate.identityDigest, row.shapeDigest));
    return [row];
  });
  return Object.freeze([...rows.filter(({ kind }) => kind === CREATE_SCENARIO_KIND), ...rows.filter(({ kind }) => kind === UPDATE_SCENARIO_KIND)]);
};

/** 発見のジョブのプロファイルの改訂が、今の改訂と違う（分からないときも。下書きの確かめと同じ fail-closed）か。 */
export const isAutoDraftDiscoveryStale = (context: ScenarioDraftContext): boolean => {
  const revisions = context.profileRevisions;
  return revisions === undefined || revisions.discoveryJob === null || revisions.discoveryJob !== revisions.current;
};

/** 型の更新の filter の名前（ない・登録なら null）。 */
const updateFilterNameOf = (probe: SubmissionProbeRecord): string | null => probe.shape?.filters[0]?.name ?? null;

/**
 * 登録の ID を読む応答の鍵の推し（推測。根拠 `RECORD_ID_KEY_FROM_UPDATE_FILTER`）: 同じ表（承認したサービスの Origin の文字列と path の型が同じ）の更新の
 * 型の filter の名前が、ちょうど 1 つのときの名前。更新がない・名前が 2 つ以上・送り先が分からないときは null。
 */
export const inferredRecordIdKeyOf = (
  create: DiscoveryCandidate,
  rows: readonly AutoDraftRow[],
  approvedServiceOrigins: readonly string[],
): DraftValue<string> | null => {
  const probe = create.submissionProbe;
  const target = probe === undefined ? null : apiRequestTargetOfProbe(probe, approvedServiceOrigins);
  if (target === null) {
    return null;
  }
  const names = new Set(rows.flatMap(({ kind, candidate }) => {
    const updateProbe = candidate.submissionProbe;
    const updateTarget = kind === UPDATE_SCENARIO_KIND && updateProbe !== undefined ? apiRequestTargetOfProbe(updateProbe, approvedServiceOrigins) : null;
    const name = updateProbe === undefined ? null : updateFilterNameOf(updateProbe);
    // Origin の比べ方は、台帳の結び付けの判定と同じ URL の意味の owner（`isOriginInAllowedOrigins`。GATE-ARCH04）。
    return updateTarget !== null && name !== null && updateTarget.pathShape === target.pathShape
      && isOriginInAllowedOrigins([target.origin], updateTarget.origin) ? [name] : [];
  }));
  const [only] = names;
  return names.size === 1 && only !== undefined ? draftValueOf(only, 'RECORD_ID_KEY_FROM_UPDATE_FILTER') : null;
};

/** 同じ型の行の、既にあるシナリオ（状態によらない。なければ null）。 */
const existingScenarioIdOf = (row: AutoDraftRow, scenarios: readonly AutoDraftScenarioFact[]): string | null =>
  scenarios.find((scenario) => scenario.kind === row.kind && scenario.candidateIdentityDigest === row.candidate.identityDigest
    && scenario.shapeDigest === row.shapeDigest)?.scenarioId ?? null;

/** 下書きの確かめの最初の誤りの理由（通れば null）。 */
const firstDraftErrorOf = (draft: Readonly<Record<string, unknown>>, candidate: DiscoveryCandidate, context: ScenarioDraftContext) => {
  const result = validateScenarioDraft(draft, candidate, [], context);
  return result.ok ? null : result.errors;
};

/** 登録の行の計画。 */
const createPlanOf = (input: AutoDraftPlanInput, row: AutoDraftRow, rows: readonly AutoDraftRow[]): AutoDraftCreatePlan => {
  const { profileId, context } = input;
  const { candidate } = row;
  const { form, rejection } = apiScenarioFormOf({ profileId, candidate, context, scenarios: [] });
  const probe = candidate.submissionProbe;
  if (form === null || probe === undefined) {
    return { status: 'REJECTED', row, reason: rejection ?? 'SCENARIO_API_CANDIDATE_NOT_API' };
  }
  if (rejection !== null) {
    return { status: 'REJECTED', row, reason: rejection };
  }
  const fieldNames = form.keyFields.map(({ key }) => key);
  const pageKeys = form.pageKeys.filter(({ rejection: blocked }) => blocked === null).map(({ key }) => key);
  const base = apiScenarioDraftInputOf(profileId, candidate, probe, { fieldNames, pageKeys, formPathTemplate: DRAFT_PROBE_PATH_TEMPLATE });
  const draftWith = (key: string | null): Readonly<Record<string, unknown>> => ({
    ...base,
    api: { ...(base['api'] as Record<string, unknown>), recordId: key === null ? null : { source: RESPONSE_BODY_KEY_SOURCE, key } },
  });
  const inferred = inferredRecordIdKeyOf(candidate, rows, context.approvedServiceOrigins ?? []);
  const withKey = inferred === null ? null : firstDraftErrorOf(draftWith(inferred.value), candidate, context);
  // 推した鍵が秘密に見える名前なら、鍵を空にする（人が入れる）。ほかの誤りは、鍵を空にしても同じなので、下で理由にする。
  const recordIdKey = inferred !== null && !(withKey ?? []).some(({ code }) => code === RECORD_ID_KEY_SECRET_REASON) ? inferred : null;
  const draft = draftWith(recordIdKey?.value ?? null);
  const errors = firstDraftErrorOf(draft, candidate, context);
  const [first] = errors ?? [];
  if (first !== undefined) {
    return { status: 'REJECTED', row, reason: first.code };
  }
  return {
    status: 'NEW',
    row,
    draft,
    recordIdKey,
    values: Object.freeze([
      draftValueOf(fieldNames, 'API_FIELDED_KEYS'),
      draftValueOf(pageKeys, 'API_UNFIELDED_KEYS'),
      draftValueOf({ limits: base['limits'], approvalTtlDays: base['approvalTtlDays'] }, 'CONTRACT_DEFAULTS'),
      draftValueOf(base['sideEffectConfirmations'], 'SIDE_EFFECTS_UNCONFIRMED'),
      ...(recordIdKey === null ? [] : [recordIdKey]),
    ]),
  };
};

/** 更新の行の計画（保存しない。作れない理由は、型の入口の判定と案の部品の判定）。 */
const updatePlanOf = (input: AutoDraftPlanInput, row: AutoDraftRow): AutoDraftUpdatePlan => {
  const probe = row.candidate.submissionProbe;
  const shapeRejection = probe === undefined ? 'SCENARIO_API_CANDIDATE_NOT_API' : apiScenarioShapeRejectionOf(probe);
  const { rejection } = apiScenarioFormOf({ profileId: input.profileId, candidate: row.candidate, context: input.context, scenarios: [] });
  const reason = shapeRejection ?? rejection;
  return reason === null ? { status: 'NEEDS_CHANGED_FIELDS', row } : { status: 'REJECTED', row, reason };
};

/**
 * 下書きの計画（作る順: 登録が先、更新が後）。既にある行は作らない。発見の改訂が古ければ、どの行も作らない（`SCENARIO_API_DISCOVERY_PROFILE_STALE`）。凍結。
 */
export const apiAutoDraftPlanOf = (input: AutoDraftPlanInput): AutoDraftPlan => {
  const rows = apiAutoDraftRowsOf(input.candidates);
  const stale = isAutoDraftDiscoveryStale(input.context);
  const creates = rows.filter(({ kind }) => kind === CREATE_SCENARIO_KIND).map((row): AutoDraftCreatePlan => {
    const existing = existingScenarioIdOf(row, input.scenarios);
    if (existing !== null) {
      return { status: 'EXISTING', row, scenarioId: existing };
    }
    return stale ? { status: 'REJECTED', row, reason: STALE_REASON } : createPlanOf(input, row, rows);
  });
  const updates = rows.filter(({ kind }) => kind === UPDATE_SCENARIO_KIND).map((row): AutoDraftUpdatePlan => {
    const existing = existingScenarioIdOf(row, input.scenarios);
    if (existing !== null) {
      return { status: 'EXISTING', row, scenarioId: existing };
    }
    return stale ? { status: 'REJECTED', row, reason: STALE_REASON } : updatePlanOf(input, row);
  });
  return Object.freeze({ creates: Object.freeze(creates), updates: Object.freeze(updates) });
};

/**
 * 更新の作成の画面で前もって選ぶ値（台帳の結び付けの判定）。`form` は、登録を保存した後の文脈で作った案（`apiScenarioFormOf`。台帳の選択肢は唯一の判定
 * `apiUpdateLedgerBindingRejectionOf` で結び付くものだけ）。
 */
export const apiUpdateDraftPresetOf = (form: Pick<ApiScenarioFormProposal, 'ledgerOptions' | 'formPathTemplates'>): AutoDraftUpdatePreset => {
  const [onlyLedger] = form.ledgerOptions;
  const [firstTemplate] = form.formPathTemplates;
  return Object.freeze({
    ledger: form.ledgerOptions.length === 1 && onlyLedger !== undefined ? draftValueOf(onlyLedger.scenarioId, 'SINGLE_BOUND_LEDGER') : null,
    ledgerOptionCount: form.ledgerOptions.length,
    formPathTemplate: firstTemplate === undefined
      ? null
      : draftValueOf(firstTemplate, form.formPathTemplates.length === 1 ? 'ONLY_FORM_PATH_TEMPLATE' : 'FIRST_FORM_PATH_TEMPLATE'),
  });
};

/** path の末尾の区切りを外した形（根は `/`）。 */
const withoutTrailingSeparator = (path: string): string => {
  const trimmed = path.replace(/\/+$/u, '');
  return trimmed.length === 0 ? PATH_SEPARATOR : trimmed;
};

/**
 * 照合の READ の `{id}` の画面の型の推し（推測。根拠 `READ_PAGE_TEMPLATE_FROM_READ_PATH`）: 登録の画面の path（と、その 1 つ上の path）の直下に、ID に見える
 * 区切り（レコードの ID の形で、数字を含む）を 1 つだけ足した、読めた画面の path があれば、その区切りを `{id}` にした型（登録の画面の path の直下を先に
 * 見る）。型の決まり（`isReadCheckPageTemplatePath`。前に固定の区切りが要る）に合わなければ null。
 */
export const inferredReadPageTemplateOf = (createPagePath: string, readPagePaths: readonly string[]): DraftValue<string> | null => {
  const own = withoutTrailingSeparator(createPagePath);
  const parent = own.slice(0, own.lastIndexOf(PATH_SEPARATOR));
  for (const prefix of [own, parent]) {
    if (prefix.length === 0 || prefix === PATH_SEPARATOR) {
      continue;
    }
    const found = readPagePaths.some((path) => {
      if (path === createPagePath || !path.startsWith(`${prefix}${PATH_SEPARATOR}`)) {
        return false;
      }
      const segment = path.slice(prefix.length + PATH_SEPARATOR.length);
      return !segment.includes(PATH_SEPARATOR) && isUsableRecordIdSegment(segment) && HAS_DIGIT.test(segment);
    });
    const template = `${prefix}${PATH_SEPARATOR}${RECORD_ID_PLACEHOLDER}`;
    if (found && isReadCheckPageTemplatePath(template)) {
      return draftValueOf(template, 'READ_PAGE_TEMPLATE_FROM_READ_PATH');
    }
  }
  return null;
};

/**
 * 照合の READ の期待の推し（推測。根拠 `READ_EXPECTATION_FROM_VARYING_FIELD`）: 送る欄（鍵の順）のうち、入力の規則で実行のたびに値が変わる欄の最初の
 * 1 つと比べる「本文が含む」。変わる欄がなければ null（人が入れる）。
 */
export const inferredReadExpectationOf = (
  fieldNames: readonly string[],
  varyingFieldNames: readonly string[],
): DraftValue<TextContainsExpectation> | null => {
  const varying = new Set(varyingFieldNames);
  const fieldName = fieldNames.find((name) => varying.has(name));
  return fieldName === undefined ? null : draftValueOf(Object.freeze({ kind: TEXT_CONTAINS_KIND, fieldName }), 'READ_EXPECTATION_FROM_VARYING_FIELD');
};

/**
 * ボタンを押せない理由（閉じた一覧。画面の文言は `messages.ts` の `LOCAL_UI_AUTO_DRAFT_TEXT.blockers`）。判定の順。
 * - `PROFILE_NOT_EDITABLE`: シナリオを使わないプロファイルか、取り消したプロファイル。
 * - `DISCOVERY_MISSING`: 最後の発見の結果（`discovery.json`）を読めない、または発見の記録がない。
 * - `DISCOVERY_STALE`: 最後の発見の時のプロファイルの改訂が、今の改訂と違う（発見をやり直す）。
 * - `NO_API_ROWS`: 最後の発見の結果に、API の登録・更新の型の行がない。
 * - `PREVIEW_OUTDATED`: 確認のダイアログに出した後に、プロファイルの改訂か最後の発見が変わった（読み直す）。画面のサーバが作る時に判定する。
 */
export const AUTO_DRAFT_BLOCKERS = Object.freeze(['PROFILE_NOT_EDITABLE', 'DISCOVERY_MISSING', 'DISCOVERY_STALE', 'NO_API_ROWS', 'PREVIEW_OUTDATED'] as const);
export type AutoDraftBlocker = (typeof AUTO_DRAFT_BLOCKERS)[number];

/** ボタンを押せない理由（押せるなら null。`PREVIEW_OUTDATED` は作る時だけの判定なので、ここでは返さない）。 */
export const autoDraftBlockerOf = (input: {
  readonly editable: boolean;
  /** 最後の発見の文書を読めたか。 */
  readonly discoveryRead: boolean;
  /** 下書きの確かめの文脈（読めなければ null）。 */
  readonly context: ScenarioDraftContext | null;
  readonly candidates: readonly DiscoveryCandidate[];
}): AutoDraftBlocker | null => {
  if (!input.editable) {
    return 'PROFILE_NOT_EDITABLE';
  }
  if (!input.discoveryRead || input.context === null) {
    return 'DISCOVERY_MISSING';
  }
  if (isAutoDraftDiscoveryStale(input.context)) {
    return 'DISCOVERY_STALE';
  }
  return apiAutoDraftRowsOf(input.candidates).length === 0 ? 'NO_API_ROWS' : null;
};

/**
 * 照合の READ の定義の扱い（閉じた一覧。画面の文言は `messages.ts` の `LOCAL_UI_AUTO_DRAFT_TEXT.readCheckOutcomes`）。
 * - `CREATED`: 推した型の定義を作った。`EXISTING`: 同じ型の定義（取り消していない）が既にあるので、それを使った。
 * - `NOT_INFERRED`: 型を推せなかった（人が「画面を読む定義」を作る）。`LIMIT_REACHED`: 定義の数の上限で作らなかった。
 * - `REJECTED`: 定義の保存の確かめ（読まないパスなど）で拒まれた。`NOT_ATTEMPTED`: シナリオを作れなかったので、扱っていない。
 * - `NOT_LINKED`（FM2R の Minor 10）: 型は推せたが、照合の READ に結べない（期待を推せない、結ぶ保存が拒まれた）ので、定義を作らなかった（作った後に
 *   結べなかった定義は取り消した）。理由は期待の段の結果（`AutoDraftExpectationOutcome`）。
 */
export const AUTO_DRAFT_READ_CHECK_OUTCOMES = Object.freeze(
  ['CREATED', 'EXISTING', 'NOT_INFERRED', 'LIMIT_REACHED', 'REJECTED', 'NOT_LINKED', 'NOT_ATTEMPTED'] as const,
);
export type AutoDraftReadCheckOutcome = (typeof AUTO_DRAFT_READ_CHECK_OUTCOMES)[number];

/** 取り消していない READ の確かめの定義 1 件（照合の READ の選び方に要るものだけ）。 */
export interface AutoDraftReadCheckFact extends ReadCheckReference {
  /** 画面の path の定義の path（候補の定義は null）。 */
  readonly targetPagePath: string | null;
}

/** 照合の READ の定義の選び方（既にある定義を使う・作る・作らない）。 */
export type AutoDraftReadCheckChoice =
  | { readonly kind: 'EXISTING'; readonly template: DraftValue<string>; readonly reference: ReadCheckReference }
  | { readonly kind: 'CREATE'; readonly template: DraftValue<string>; readonly definition: ReturnType<typeof autoDraftReadCheckDefinitionOf> }
  | { readonly kind: 'NOT_INFERRED' }
  | { readonly kind: 'LIMIT_REACHED'; readonly template: DraftValue<string> };

/**
 * 登録の下書きの照合の READ の定義の選び方: 型を推せなければ作らない。同じ型の定義が既にあれば、それを使う（同じ定義を 2 つ作らない）。定義の数が上限
 * （`maxDefinitions`）に達していれば作らない。ほかは、仮の期待つきの定義を作る。
 */
export const autoDraftReadCheckChoiceOf = (input: {
  readonly createPagePath: string;
  readonly readPagePaths: readonly string[];
  readonly definitions: readonly AutoDraftReadCheckFact[];
  readonly maxDefinitions: number;
}): AutoDraftReadCheckChoice => {
  const template = inferredReadPageTemplateOf(input.createPagePath, input.readPagePaths);
  if (template === null) {
    return { kind: 'NOT_INFERRED' };
  }
  const existing = input.definitions.find(({ targetPagePath }) => targetPagePath === template.value);
  if (existing !== undefined) {
    return { kind: 'EXISTING', template, reference: { readCheckId: existing.readCheckId, revision: existing.revision } };
  }
  return input.definitions.length >= input.maxDefinitions
    ? { kind: 'LIMIT_REACHED', template }
    : { kind: 'CREATE', template, definition: autoDraftReadCheckDefinitionOf(template.value) };
};

/** 照合の READ の `{id}` の型の定義（送る値なし。期待は仮の 1 件）。 */
export const autoDraftReadCheckDefinitionOf = (template: string): {
  readonly targetPagePath: string;
  readonly parameters: Readonly<Record<string, never>>;
  readonly expectations: readonly ReadCheckExpectation[];
} => ({ targetPagePath: template, parameters: {}, expectations: AUTO_DRAFT_READ_CHECK_PLACEHOLDER_EXPECTATIONS });

/** シナリオの照合の READ（`{id}` の型の定義。結び付けは 0 件。期待は推した 1 件）。 */
export const autoDraftReadVerificationOf = (readCheck: ReadCheckReference, expectation: VerificationExpectation): ScenarioReadVerification => ({
  readCheckId: readCheck.readCheckId,
  revision: readCheck.revision,
  bindings: [],
  expectations: [expectation],
});

/** 表示のときに求め直す入力。 */
/**
 * 照合の READ の期待を結んだか・結ばなかった理由（閉じた一覧。画面の文言は `messages.ts` の `LOCAL_UI_AUTO_DRAFT_TEXT.expectationOutcomes`。FM2R の
 * Minor 10: 理由を事実のとおりに出す）。
 * - `LINKED`: 推した期待で、照合の READ に結んだ。
 * - `RULES_NOT_ATTACHED`: 入力の規則を付けられなかったので、変わる欄を求められない。
 * - `NO_READ_CHECK`: 照合の READ の定義がない（型を推せない・上限・保存の確かめで拒まれた）。
 * - `NO_VARYING_FIELD`: 実行のたびに値が変わる欄がない。
 * - `LINK_FAILED`: シナリオの保存の口が、照合の READ を結んだ版を拒んだ。
 */
export const AUTO_DRAFT_EXPECTATION_OUTCOMES = Object.freeze(['LINKED', 'RULES_NOT_ATTACHED', 'NO_READ_CHECK', 'NO_VARYING_FIELD', 'LINK_FAILED'] as const);
export type AutoDraftExpectationOutcome = (typeof AUTO_DRAFT_EXPECTATION_OUTCOMES)[number];

/**
 * 照合の READ の期待の段の決め方（作る順の 1 か所。FM2R の Minor 10）: 規則を付けた後に、変わる欄から期待を推す。推せないときは、その理由。結べない
 * 定義を作らないため、画面のサーバは、この結果が `LINK` のときだけ照合の READ の定義を作る（既にある定義は使うだけ）。
 */
export const autoDraftExpectationStepOf = (input: {
  readonly rulesAttached: boolean;
  /** 照合の READ の定義の選び方（既にある・作る ほか）。 */
  readonly readCheck: AutoDraftReadCheckChoice;
  readonly fieldNames: readonly string[];
  readonly varyingFieldNames: readonly string[];
}): { readonly kind: 'LINK'; readonly expectation: DraftValue<TextContainsExpectation> } | {
  readonly kind: 'SKIP';
  readonly outcome: Exclude<AutoDraftExpectationOutcome, 'LINKED' | 'LINK_FAILED'>;
} => {
  if (!input.rulesAttached) {
    return { kind: 'SKIP', outcome: 'RULES_NOT_ATTACHED' };
  }
  if (input.readCheck.kind !== 'EXISTING' && input.readCheck.kind !== 'CREATE') {
    return { kind: 'SKIP', outcome: 'NO_READ_CHECK' };
  }
  const expectation = inferredReadExpectationOf(input.fieldNames, input.varyingFieldNames);
  return expectation === null ? { kind: 'SKIP', outcome: 'NO_VARYING_FIELD' } : { kind: 'LINK', expectation };
};

/**
 * 自動の下書きが作った登録のシナリオの id の頭（FM2R の Minor 9: 推測の印を、自動の下書きが作ったシナリオだけに出すための出どころ。印は承認に結ばない）。
 * シナリオの id の形（`SCENARIO_ID_PATTERN`）の中に収める。
 */
export const AUTO_DRAFT_SCENARIO_ID_PREFIX = 'auto-';

/** 自動の下書きの登録のシナリオの id（`unique` は UUID など。シナリオの id の形に合わなければ `RangeError`）。 */
export const autoDraftScenarioIdOf = (unique: string): string => {
  const scenarioId = `${AUTO_DRAFT_SCENARIO_ID_PREFIX}${unique}`;
  if (!SCENARIO_ID_PATTERN.test(scenarioId)) {
    throw new RangeError('the automatic draft scenario id must match the scenario id pattern');
  }
  return scenarioId;
};

/** 自動の下書きが作ったシナリオの id か。 */
export const isAutoDraftScenarioId = (scenarioId: string): boolean => scenarioId.startsWith(AUTO_DRAFT_SCENARIO_ID_PREFIX);

/** 表示のときに求め直す入力。 */
export interface AutoDraftInferredItemsInput {
  readonly scenarioId: string;
  readonly scenario: Pick<ScenarioContent, 'kind' | 'transport' | 'api' | 'fieldNames' | 'verification'>;
  /** シナリオの版の写しの履歴（版の順。今の版を含む）。自動の下書きの値が、その後に変わっていないかを見る。 */
  readonly history: readonly Pick<ScenarioContent, 'api' | 'verification'>[];
  /** シナリオの発見の根拠の写し（登録の画面と probe）。 */
  readonly evidence: DiscoveryCandidate;
  /** 最後の発見の候補（更新の filter の名前）。 */
  readonly candidates: readonly DiscoveryCandidate[];
  readonly approvedServiceOrigins: readonly string[];
  /** 最後の発見の、読めた画面の path。 */
  readonly readPagePaths: readonly string[];
  /** 照合の READ の定義の画面の path（照合の READ がない・画面の定義でなければ null）。 */
  readonly readVerificationPagePath: string | null;
  /** 入力の規則で、実行のたびに値が変わる欄。 */
  readonly varyingFieldNames: readonly string[];
  /** 更新の画面の型の選択肢（保存で拒まれない型。API の更新でなければ空）。 */
  readonly updateFormPathTemplates: readonly string[];
  /** 入力の規則で、範囲の既定の幅を入れた欄（推測の印。判定は規則の部品 `defaultRangeFieldNamesOf`）。 */
  readonly defaultRangeFieldNames: readonly string[];
}

/** 履歴の中で、値が最初に現れてから今まで同じか（人が変えていないか。最初に現れる前の版は見ない）。 */
const unchangedSinceSet = <T>(history: readonly T[], valueOf: (revision: T) => unknown): boolean => {
  const values = history.map((revision) => JSON.stringify(valueOf(revision) ?? null));
  const first = values.findIndex((value) => value !== 'null');
  return first >= 0 && values.slice(first).every((value) => value === values[first]);
};

/**
 * 推測の項目のうち、シナリオに今も残るもの（表示だけ。印は承認に結ばない）。
 * - 登録の ID を読む応答の鍵・照合の READ の画面の型・照合の READ の期待（FM2R の Minor 9）: 自動の下書きが作ったシナリオ（id の頭）で、値が自動の
 *   下書きの値から変わっていない（履歴で、最初に現れてから同じ）ときだけ。人が入れた値は、推した値と同じでも出さない。
 * - 更新の画面の型（FM2R の Minor 11）: 選べる型が 2 つ以上で、先頭の型（作成の画面が前もって選ぶ値）のまま。
 * - 範囲の既定の幅を入れた欄（FM2R の Minor 11）: 規則の部品が求めた欄。
 */
export const autoDraftInferredItemsOf = (input: AutoDraftInferredItemsInput): readonly AutoDraftInferredItem[] => {
  const { scenario, evidence } = input;
  if (scenarioTransportOf(scenario) !== API_SCENARIO_TRANSPORT) {
    return Object.freeze([]);
  }
  const items: AutoDraftInferredItem[] = [];
  const itemOf = (item: AutoDraftInferredItemKind, value: DraftValue<unknown>, shown: string): AutoDraftInferredItem =>
    Object.freeze({ item, value: shown, origin: value.origin, ground: value.ground });
  if (scenario.kind === CREATE_SCENARIO_KIND && isAutoDraftScenarioId(input.scenarioId)) {
    const key = inferredRecordIdKeyOf(evidence, apiAutoDraftRowsOf(input.candidates), input.approvedServiceOrigins);
    if (key !== null && scenario.api?.recordId?.key === key.value && unchangedSinceSet(input.history, (revision) => revision.api?.recordId)) {
      items.push(itemOf('RECORD_ID_KEY', key, key.value));
    }
    const read = scenario.verification.readVerification;
    const readUnchanged = unchangedSinceSet(input.history, (revision) => revision.verification.readVerification);
    const template = inferredReadPageTemplateOf(evidence.page.path, input.readPagePaths);
    if (template !== null && readUnchanged && input.readVerificationPagePath === template.value) {
      items.push(itemOf('READ_PAGE_TEMPLATE', template, template.value));
    }
    // 照合の READ の期待: 推しと同じ形（「本文が含む」1 件で、比べる欄が実行のたびに変わる欄）のまま残るとき。どの変わる欄を先に選ぶかは、副作用の確認で
    // 規則の作り方が変わると動くので、欄の名前の一致ではなく、変わる欄であることで見る。
    const [only] = read?.expectations ?? [];
    if (read !== null && readUnchanged && read.expectations.length === 1 && only !== undefined && only.kind === TEXT_CONTAINS_KIND
      && input.varyingFieldNames.includes(only.fieldName) && scenario.fieldNames.includes(only.fieldName)) {
      items.push(itemOf('READ_EXPECTATION', draftValueOf(only.fieldName, 'READ_EXPECTATION_FROM_VARYING_FIELD'), only.fieldName));
    }
  }
  if (scenario.kind === UPDATE_SCENARIO_KIND) {
    const preset = apiUpdateDraftPresetOf({ ledgerOptions: [], formPathTemplates: input.updateFormPathTemplates }).formPathTemplate;
    // 推測の印の型の根拠（選べる型が 2 つ以上の先頭）で見る（案の出どころの項目の比べは、URL の比べと紛れるので書かない。GATE-ARCH04）。
    if (preset !== null && preset.ground === 'FIRST_FORM_PATH_TEMPLATE' && scenario.api?.ledger?.formPathTemplate === preset.value) {
      items.push(itemOf('UPDATE_FORM_PATH_TEMPLATE', preset, preset.value));
    }
  }
  for (const fieldName of input.defaultRangeFieldNames) {
    items.push(itemOf('DEFAULT_RANGE_FIELD', draftValueOf(fieldName, 'DEFAULT_RANGE_WITHOUT_HINT'), fieldName));
  }
  return Object.freeze(items);
};
