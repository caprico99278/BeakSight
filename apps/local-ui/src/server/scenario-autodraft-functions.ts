/**
 * シナリオの下書きをボタン 1 回で作る Server Functions（手を減らす段 2 の設計書 3A.2、3A.3。5 章の 2026-10-22 の FM2b の Blocker の判断（案 2））。
 * - 決まり（作る順、`recordId.key` の推し、台帳の結び付けの判定、照合の READ の型と期待の推し、既にあるものの判定、押せない理由）は、純粋な部品
 *   （`src/control/approval/api-scenario-autodraft.ts`。画面向けの公開し直し `approval-view.ts` から読む）の 1 か所。ここは、管理データと最後の発見の
 *   成果物を読んで部品に渡し、今の保存の口（`createScenario`・`updateScenario`・`createReadCheck`・`saveRuleSetAndAttach`）で保存するだけ。保存の口の
 *   確かめ（下書きの確かめ、承認の境界）は変えない。サイトには接続しない（読むのは管理データと成果物だけ）。
 * - 作るもの: 登録の型の行ごとに、登録のシナリオの下書き（`DRAFT`。副作用の確認の 4 項目は偽。承認・実行の許可は作らない）、推した入力の規則の集まり
 *   （`inferRuleSetContent`）、照合の READ の `{id}` の型の定義（推せたときだけ。仮の期待つき）と、規則の後に推した期待（推せたときだけ、シナリオの版を
 *   上げて照合の READ に結ぶ）。更新は保存しない（変える欄は人が必ず選ぶ）。作成の画面へのリンク（候補・型・前もって選ぶ台帳と画面の型）を返す。
 * - 押せるのは、最後の発見の時のプロファイルの改訂が今の改訂と同じときだけ（`autoDraftBlockerOf`）。作る時は、確認のダイアログに出した改訂と発見の
 *   ジョブと照らし直し、違えば何も作らない（`PREVIEW_OUTDATED`）。
 * - 更新の導線: 作成の画面で人が変える欄を選んで保存した後に、`attachAutoDraftRulesFn` で推した規則を付ける（承認の前。規則がまだないシナリオだけ）。
 *   導線を通ったかは、作成の画面の URL の引数（承認に結ばない）で渡す。
 */
import { randomUUID } from 'node:crypto';
import { createServerFn } from '@tanstack/react-start';
import {
  API_SCENARIO_TRANSPORT,
  apiAutoDraftPlanOf,
  apiScenarioFormOf,
  apiUpdateDraftPresetOf,
  DRAFT_SCENARIO_STATE,
  autoDraftBlockerOf,
  autoDraftExpectationStepOf,
  autoDraftReadCheckChoiceOf,
  autoDraftReadVerificationOf,
  autoDraftScenarioIdOf,
  createScenario,
  listScenarios,
  readScenario,
  readScenarioDraftContext,
  scenarioTransportOf,
  updateScenario,
  type AutoDraftBlocker,
  type AutoDraftCreatePlan,
  type AutoDraftExpectationOutcome,
  type AutoDraftReadCheckChoice,
  type AutoDraftReadCheckFact,
  type AutoDraftReadCheckOutcome,
  type AutoDraftScenarioFact,
  type AutoDraftUpdatePlan,
  type DraftValue,
  type DraftValueGround,
  type DraftValueOrigin,
  type ReadCheckReference,
  type ScenarioDraftContext,
  type ScenarioDraftRejectionReason,
  type ScenarioKind,
  type ScenarioStoreRejectionReason,
  type ScenarioView,
} from '../../../../src/control/approval-view.js';
import {
  inferRuleSetContent,
  planRuleSet,
  readLatestRuleSet,
  saveRuleSetAndAttach,
  varyingFieldNamesOf,
  type FieldRuleProblem,
  type RuleSetRevision,
  type RuleSetStoreRejectionReason,
} from '../../../../src/control/data-rules-view.js';
import { MAX_READ_CHECK_DEFINITIONS_PER_PROFILE, type DiscoveryCandidate, type DiscoveryDocument } from '../../../../src/control/discovery-view.js';
import { cancelReadCheck, createReadCheck, listReadChecks } from '../../../../src/control/job/read-check-store.js';
import { validateReadCheckDefinition, type ReadCheckDefinitionRejectionReason } from '../../../../src/control/read-check-policy.js';
import { ACTIVE_PROFILE_STATUS } from '../../../../src/control/store/profile-records.js';
import type { StoredProfile } from '../../../../src/control/store/profile-store.js';
import { usesReadCheck, usesScenarios } from '../display/labels';
import { localUiStore } from './control-store';
import { defaultRuleSetIdOf } from './data-rule-facts';
import { mergedCandidatesOf, readDiscoveryDocuments } from './discovery-documents';
import { readCheckPageContextOf, readCheckPagePathsOf } from './read-check-page-context';
import { requestOf } from './request-validation';
import { readProfileStart, type ProfileStartReading } from './start-check-inputs';
import { nowCompactTimestamp } from './timestamps';

// ---------------------------------------------------------------------------------------------------------------
// 画面に返す値
// ---------------------------------------------------------------------------------------------------------------

/** 案の値と出どころの印（表示だけ。承認に結ばない）。 */
export interface AutoDraftValueView {
  readonly value: string;
  readonly origin: DraftValueOrigin;
  readonly ground: DraftValueGround;
}

/** 型の行の要点（値は持たない）。 */
export interface AutoDraftRowView {
  readonly kind: ScenarioKind;
  readonly identityDigest: string;
  readonly shapeDigest: string;
  readonly method: string;
  readonly pathShape: string;
  readonly pagePath: string;
}

/** 確認のダイアログの、登録の行 1 つ。 */
export interface AutoDraftCreatePreviewView extends AutoDraftRowView {
  readonly status: AutoDraftCreatePlan['status'];
  /** 既にあるシナリオ（`EXISTING` のとき）。 */
  readonly scenarioId: string | null;
  /** 作れない理由（`REJECTED` のとき）。 */
  readonly reason: ScenarioDraftRejectionReason | null;
  readonly recordIdKey: AutoDraftValueView | null;
  /** 照合の READ の定義の予定（`NEW` のときだけ）。 */
  readonly readCheck: Exclude<AutoDraftReadCheckOutcome, 'REJECTED' | 'NOT_LINKED' | 'NOT_ATTEMPTED'> | null;
  readonly readTemplate: AutoDraftValueView | null;
}

/** 確認のダイアログの、更新の行 1 つ。 */
export interface AutoDraftUpdatePreviewView extends AutoDraftRowView {
  readonly status: AutoDraftUpdatePlan['status'];
  readonly scenarioId: string | null;
  readonly reason: ScenarioDraftRejectionReason | null;
}

/** 発見の画面の、下書きを作るボタンの値（確認のダイアログの一覧）。 */
export interface AutoDraftPreviewView {
  /** 押せない理由（押せるなら null）。 */
  readonly blocker: AutoDraftBlocker | null;
  /** 作る時に照らし直す、プロファイルの改訂と最後の発見のジョブ。 */
  readonly expectedRevision: number;
  readonly discoveryJobId: string | null;
  readonly creates: readonly AutoDraftCreatePreviewView[];
  readonly updates: readonly AutoDraftUpdatePreviewView[];
}

/** 入力の規則の結果。 */
export interface AutoDraftRulesView {
  readonly attached: boolean;
  /** 推せなかった欄（理由のコードつき）。 */
  readonly unresolved: readonly FieldRuleProblem[];
  /** 範囲の既定の幅を入れた欄（推測の印）。 */
  readonly defaultRangeFieldNames: readonly string[];
}

/** 作った結果の、登録の行 1 つ。 */
export interface AutoDraftCreateResultView extends AutoDraftRowView {
  readonly status: 'CREATED' | 'EXISTING' | 'REJECTED' | 'FAILED';
  readonly scenarioId: string | null;
  /** 作れない理由（`REJECTED`）か、保存の下書きの誤りの最初（`FAILED`）。 */
  readonly reason: ScenarioDraftRejectionReason | null;
  /** 保存の口が拒んだ理由（`FAILED` のとき）。 */
  readonly failure: ScenarioStoreRejectionReason | null;
  readonly recordIdKey: AutoDraftValueView | null;
  readonly readCheck: AutoDraftReadCheckOutcome | null;
  readonly readTemplate: AutoDraftValueView | null;
  readonly readCheckRejection: ReadCheckDefinitionRejectionReason | null;
  readonly rules: AutoDraftRulesView | null;
  /** 推した照合の READ の期待の欄（結べなければ null）。 */
  readonly expectation: AutoDraftValueView | null;
  /** FM2R の Minor 10: 照合の READ の期待を結んだか・結ばなかった理由（シナリオを作れなければ null）。 */
  readonly expectationOutcome: AutoDraftExpectationOutcome | null;
}

/** 作成の画面へのリンクの引数（ID と型だけ。値と秘密は載せない）。 */
export interface AutoDraftUpdateLinkView {
  readonly candidate: string;
  readonly shape: string;
  readonly ledger: string | null;
  readonly template: string | null;
}

/** 作った結果の、更新の行 1 つ。 */
export interface AutoDraftUpdateResultView extends AutoDraftUpdatePreviewView {
  /** 作成の画面へのリンク（`NEEDS_CHANGED_FIELDS` のとき）。 */
  readonly link: AutoDraftUpdateLinkView | null;
  readonly ledgerOptionCount: number;
  readonly presetLedger: AutoDraftValueView | null;
  readonly presetTemplate: AutoDraftValueView | null;
}

/** 下書きを作った結果。 */
export type AutoDraftResultView =
  | { readonly ok: true; readonly creates: readonly AutoDraftCreateResultView[]; readonly updates: readonly AutoDraftUpdateResultView[] }
  | { readonly ok: false; readonly blocker: AutoDraftBlocker };

/** 更新の導線の規則の付け方を拒む理由。 */
export type AutoDraftRulesRejectionReason =
  | 'SCENARIO_NOT_FOUND'
  | 'SCENARIO_REVISION_CONFLICT'
  | 'AUTO_RULES_NOT_TARGET'
  | 'AUTO_RULES_ALREADY_SET'
  | 'AUTO_RULES_NOT_INFERRED'
  | RuleSetStoreRejectionReason
  | ScenarioStoreRejectionReason;

/** 更新の導線で規則を付けた結果。 */
export type AutoDraftRulesResultView =
  | { readonly ok: true; readonly scenarioRevision: number; readonly unresolvedCount: number }
  | { readonly ok: false; readonly reason: AutoDraftRulesRejectionReason };

// ---------------------------------------------------------------------------------------------------------------
// 値の組み立て
// ---------------------------------------------------------------------------------------------------------------

// FM2R の Minor 13: プロファイルの状態・シナリオの状態・今の時刻は、それぞれの owner（`profile-records.ts`・`scenario-contracts.ts`・`timestamps.ts`）から読む。

const valueViewOf = (value: DraftValue<string> | null): AutoDraftValueView | null =>
  (value === null ? null : { value: value.value, origin: value.origin, ground: value.ground });

const rowViewOf = (row: AutoDraftCreatePlan['row']): AutoDraftRowView => {
  const shape = row.candidate.submissionProbe?.shape ?? null;
  return {
    kind: row.kind,
    identityDigest: row.candidate.identityDigest,
    shapeDigest: row.shapeDigest,
    method: shape?.method ?? '',
    pathShape: shape?.pathShape ?? '',
    pagePath: row.candidate.page.path,
  };
};

/** 作る前の事実（プロファイル、最後の発見、文脈、既にあるシナリオと READ の定義、読めた画面の path、画面の path の文脈）。 */
interface AutoDraftFacts {
  readonly stored: StoredProfile;
  readonly reading: ProfileStartReading;
  readonly latest: DiscoveryDocument | null;
  readonly candidates: readonly DiscoveryCandidate[];
  readonly context: ScenarioDraftContext | null;
  readonly blocker: AutoDraftBlocker | null;
}

const scenarioFactsOf = (profileId: string): readonly AutoDraftScenarioFact[] => listScenarios(localUiStore(), profileId).map((scenario) => ({
  scenarioId: scenario.scenarioId,
  kind: scenario.current.kind,
  state: scenario.state,
  candidateIdentityDigest: scenario.current.candidate.identityDigest,
  shapeDigest: scenario.current.api?.shapeDigest ?? null,
}));

const readCheckFactsOf = (profileId: string): readonly AutoDraftReadCheckFact[] => listReadChecks(localUiStore(), profileId)
  .map(({ readCheckId, revision, definition }) => ({ readCheckId, revision, targetPagePath: definition.targetPagePath ?? null }));

const factsOf = async (profileId: string): Promise<AutoDraftFacts | null> => {
  const reading = await readProfileStart(profileId);
  if (reading === null) {
    return null;
  }
  const { stored } = reading;
  const { latest } = await readDiscoveryDocuments(profileId);
  const context = latest === null ? null : readScenarioDraftContext(localUiStore(), profileId, latest.jobId, null);
  const candidates = mergedCandidatesOf(latest);
  const editable = usesScenarios(stored.profile.mode, stored.profile.auth) && stored.status === ACTIVE_PROFILE_STATUS;
  return {
    stored, reading, latest, candidates, context,
    blocker: autoDraftBlockerOf({ editable, discoveryRead: latest !== null, context, candidates }),
  };
};

const planOf = (facts: AutoDraftFacts, context: ScenarioDraftContext) => apiAutoDraftPlanOf({
  profileId: facts.stored.profile.profileId,
  candidates: facts.candidates,
  context,
  scenarios: scenarioFactsOf(facts.stored.profile.profileId),
});

/** 確認のダイアログの一覧（保存しない。照合の READ の定義の予定は、作る順に数えて上限を見る）。 */
const previewOf = (facts: AutoDraftFacts): AutoDraftPreviewView => {
  const base = { blocker: facts.blocker, expectedRevision: facts.stored.profile.revision, discoveryJobId: facts.latest?.jobId ?? null };
  if (facts.blocker !== null || facts.context === null) {
    return { ...base, creates: [], updates: [] };
  }
  const plan = planOf(facts, facts.context);
  const readPagePaths = readCheckPagePathsOf(facts.latest, facts.reading);
  const definitions: AutoDraftReadCheckFact[] = [...readCheckFactsOf(facts.stored.profile.profileId)];
  return {
    ...base,
    creates: plan.creates.map((item): AutoDraftCreatePreviewView => {
      if (item.status !== 'NEW') {
        return {
          ...rowViewOf(item.row), status: item.status, scenarioId: item.status === 'EXISTING' ? item.scenarioId : null,
          reason: item.status === 'REJECTED' ? item.reason : null, recordIdKey: null, readCheck: null, readTemplate: null,
        };
      }
      const choice = autoDraftReadCheckChoiceOf({
        createPagePath: item.row.candidate.page.path, readPagePaths, definitions, maxDefinitions: MAX_READ_CHECK_DEFINITIONS_PER_PROFILE,
      });
      if (choice.kind === 'CREATE') {
        // 予定の数え方: 作る定義を 1 つ足して、次の行の上限と、同じ型の定義の重なりを見る。
        definitions.push({ readCheckId: '', revision: 0, targetPagePath: choice.template.value });
      }
      return {
        ...rowViewOf(item.row), status: item.status, scenarioId: null, reason: null, recordIdKey: valueViewOf(item.recordIdKey),
        readCheck: choice.kind === 'CREATE' ? 'CREATED' : choice.kind, readTemplate: choice.kind === 'NOT_INFERRED' ? null : valueViewOf(choice.template),
      };
    }),
    updates: plan.updates.map((item) => ({
      ...rowViewOf(item.row), status: item.status, scenarioId: item.status === 'EXISTING' ? item.scenarioId : null,
      reason: item.status === 'REJECTED' ? item.reason : null,
    })),
  };
};

/** 推した規則の集まりを作り、シナリオに付ける（今の 2 段の保存の口。承認の前だけ）。 */
const attachInferredRulesOf = (scenario: ScenarioView): {
  readonly view: AutoDraftRulesView;
  readonly scenario: ScenarioView | null;
  readonly ruleSet: RuleSetRevision | null;
  readonly rejection: RuleSetStoreRejectionReason | ScenarioStoreRejectionReason | 'AUTO_RULES_NOT_INFERRED' | null;
} => {
  let inferred: ReturnType<typeof inferRuleSetContent>;
  try {
    inferred = inferRuleSetContent(scenario.current, scenario.evidence);
  } catch (error) {
    if (error instanceof RangeError) {
      return { view: { attached: false, unresolved: [], defaultRangeFieldNames: [] }, scenario: null, ruleSet: null, rejection: 'AUTO_RULES_NOT_INFERRED' };
    }
    throw error;
  }
  const saved = saveRuleSetAndAttach(localUiStore(), {
    ruleSetId: defaultRuleSetIdOf(scenario.scenarioId),
    scenarioId: scenario.scenarioId,
    expectedRevision: null,
    content: inferred.content,
    expectedScenarioRevision: scenario.revision,
    at: nowCompactTimestamp('automatic input rule save time'),
  });
  const attached = saved.ruleSet.ok && saved.attachment !== null && saved.attachment.ok;
  const view = { attached, unresolved: [...inferred.unresolvedFields], defaultRangeFieldNames: [...inferred.defaultRangeFieldNames] };
  if (!saved.ruleSet.ok) {
    return { view, scenario: null, ruleSet: null, rejection: saved.ruleSet.reason };
  }
  if (saved.attachment === null || !saved.attachment.ok) {
    return { view, scenario: null, ruleSet: saved.ruleSet.ruleSet, rejection: saved.attachment?.ok === false ? saved.attachment.reason : 'SCENARIO_NOT_FOUND' };
  }
  return { view, scenario: saved.attachment.scenario, ruleSet: saved.ruleSet.ruleSet, rejection: null };
};

/**
 * 照合の READ の定義の参照（既にある定義を使うか、確かめてから作る）。FM2R の Minor 10: 期待を結べるときだけ呼ぶ（結べない定義を作らない）。
 */
const readCheckReferenceOf = (facts: AutoDraftFacts, choice: Extract<AutoDraftReadCheckChoice, { kind: 'EXISTING' | 'CREATE' }>): {
  readonly outcome: Extract<AutoDraftReadCheckOutcome, 'CREATED' | 'EXISTING' | 'REJECTED'>;
  readonly reference: ReadCheckReference | null;
  readonly rejection: ReadCheckDefinitionRejectionReason | null;
} => {
  if (choice.kind === 'EXISTING') {
    return { outcome: 'EXISTING', reference: choice.reference, rejection: null };
  }
  if (!usesReadCheck(facts.stored.profile.mode, facts.stored.profile.auth)) {
    return { outcome: 'REJECTED', reference: null, rejection: 'READ_CHECK_PROFILE_NOT_ELIGIBLE' };
  }
  // 保存の確かめは、READ の確かめの画面の保存と同じ（画面の path の文脈。候補は見ない）。
  const validation = validateReadCheckDefinition(choice.definition, null, readCheckPageContextOf(facts.reading));
  if (!validation.ok) {
    return { outcome: 'REJECTED', reference: null, rejection: validation.errors[0]?.code ?? 'READ_CHECK_INPUT_INVALID' };
  }
  const saved = createReadCheck(localUiStore(), {
    readCheckId: randomUUID(), profileId: facts.stored.profile.profileId, definition: validation.definition,
    at: nowCompactTimestamp('automatic READ check creation time'),
  });
  return saved.ok
    ? { outcome: 'CREATED', reference: { readCheckId: saved.readCheck.readCheckId, revision: saved.readCheck.revision }, rejection: null }
    : { outcome: 'REJECTED', reference: null, rejection: saved.reason };
};

/**
 * 登録の行 1 つを作る（作る順: シナリオ → 規則 → 期待の段の判定 → 結べるときだけ照合の READ の定義 → 照合の READ に結ぶ）。FM2R の Minor 9: シナリオの
 * id は、自動の下書きの頭つき（推測の印の出どころ）。FM2R の Minor 10: 期待を結ばなかった理由を事実のとおりに返し、作った後に結べなかった定義は取り消す
 * （定義の数の上限に数えない）。
 */
const createOne = (facts: AutoDraftFacts, item: AutoDraftCreatePlan): AutoDraftCreateResultView => {
  const empty = {
    ...rowViewOf(item.row), scenarioId: null, reason: null, failure: null, recordIdKey: null, readCheck: null, readTemplate: null,
    readCheckRejection: null, rules: null, expectation: null, expectationOutcome: null,
  };
  if (item.status === 'EXISTING') {
    return { ...empty, status: 'EXISTING', scenarioId: item.scenarioId };
  }
  if (item.status === 'REJECTED') {
    return { ...empty, status: 'REJECTED', reason: item.reason };
  }
  const recordIdKey = valueViewOf(item.recordIdKey);
  const created = createScenario(localUiStore(), {
    scenarioId: autoDraftScenarioIdOf(randomUUID()), draft: item.draft, discovery: facts.latest, at: nowCompactTimestamp('automatic scenario creation time'),
  });
  if (!created.ok) {
    return { ...empty, status: 'FAILED', recordIdKey, failure: created.reason, reason: created.draftErrors[0]?.code ?? null, readCheck: 'NOT_ATTEMPTED' };
  }
  const rules = attachInferredRulesOf(created.scenario);
  const choice = autoDraftReadCheckChoiceOf({
    createPagePath: item.row.candidate.page.path,
    readPagePaths: readCheckPagePathsOf(facts.latest, facts.reading),
    definitions: readCheckFactsOf(facts.stored.profile.profileId),
    maxDefinitions: MAX_READ_CHECK_DEFINITIONS_PER_PROFILE,
  });
  // 期待の欄は、規則を付けた後に、実行のたびに値が変わる欄から推す（許可の発行と同じ値の作り方と判定）。
  const attached = rules.scenario !== null && rules.ruleSet !== null ? { scenario: rules.scenario, ruleSet: rules.ruleSet } : null;
  const step = autoDraftExpectationStepOf({
    rulesAttached: attached !== null,
    readCheck: choice,
    fieldNames: created.scenario.current.fieldNames,
    varyingFieldNames: attached === null ? [] : varyingFieldNamesOf(planRuleSet(attached.ruleSet, attached.scenario.current, attached.scenario.evidence)),
  });
  const base = {
    ...empty, status: 'CREATED' as const, scenarioId: created.scenario.scenarioId, recordIdKey,
    readTemplate: choice.kind === 'NOT_INFERRED' ? null : valueViewOf(choice.template), rules: rules.view,
  };
  if (step.kind === 'SKIP' || attached === null || (choice.kind !== 'EXISTING' && choice.kind !== 'CREATE')) {
    // 結べないので、型の定義は作らない（既にある定義は、そのまま）。
    const outcome: AutoDraftReadCheckOutcome = choice.kind === 'CREATE' ? 'NOT_LINKED' : choice.kind;
    return { ...base, readCheck: outcome, expectationOutcome: step.kind === 'SKIP' ? step.outcome : 'RULES_NOT_ATTACHED' };
  }
  const read = readCheckReferenceOf(facts, choice);
  if (read.reference === null) {
    return { ...base, readCheck: read.outcome, readCheckRejection: read.rejection, expectationOutcome: 'NO_READ_CHECK' };
  }
  const linked = updateScenario(localUiStore(), {
    scenarioId: attached.scenario.scenarioId,
    expectedRevision: attached.scenario.revision,
    draft: {
      ...item.draft,
      verification: {
        successCondition: null, inputErrorCondition: null, recordId: null, readVerification: autoDraftReadVerificationOf(read.reference, step.expectation.value),
      },
    },
    discovery: facts.latest,
    at: nowCompactTimestamp('automatic scenario verification time'),
  });
  if (!linked.ok) {
    // 作った後に結べなかった定義は取り消す（定義の数の上限に数えない。既にある定義は取り消さない）。
    if (read.outcome === 'CREATED') {
      cancelReadCheck(localUiStore(), {
        readCheckId: read.reference.readCheckId, expectedRevision: read.reference.revision, at: nowCompactTimestamp('automatic READ check cancel time'),
      });
    }
    return { ...base, readCheck: read.outcome === 'CREATED' ? 'NOT_LINKED' : read.outcome, expectationOutcome: 'LINK_FAILED' };
  }
  return {
    ...base,
    readCheck: read.outcome,
    expectation: { value: step.expectation.value.fieldName, origin: step.expectation.origin, ground: step.expectation.ground },
    expectationOutcome: 'LINKED',
  };
};

/** 更新の行 1 つ（保存しない。登録を保存した後の文脈で、台帳と画面の型を前もって選ぶ値を求める）。 */
const updateOne = (facts: AutoDraftFacts, item: AutoDraftUpdatePlan, context: ScenarioDraftContext | null): AutoDraftUpdateResultView => {
  const base = {
    ...rowViewOf(item.row), status: item.status, scenarioId: item.status === 'EXISTING' ? item.scenarioId : null,
    reason: item.status === 'REJECTED' ? item.reason : null, link: null, ledgerOptionCount: 0, presetLedger: null, presetTemplate: null,
  };
  if (item.status !== 'NEEDS_CHANGED_FIELDS' || context === null) {
    return base;
  }
  const profileId = facts.stored.profile.profileId;
  const { form } = apiScenarioFormOf({
    profileId,
    candidate: item.row.candidate,
    context,
    scenarios: listScenarios(localUiStore(), profileId)
      .map((scenario) => ({ scenarioId: scenario.scenarioId, kind: scenario.current.kind, pagePath: scenario.evidence.page.path })),
  });
  if (form === null) {
    return base;
  }
  const preset = apiUpdateDraftPresetOf(form);
  return {
    ...base,
    link: { candidate: item.row.candidate.identityDigest, shape: item.row.shapeDigest, ledger: preset.ledger?.value ?? null, template: preset.formPathTemplate?.value ?? null },
    ledgerOptionCount: preset.ledgerOptionCount,
    presetLedger: valueViewOf(preset.ledger),
    presetTemplate: valueViewOf(preset.formPathTemplate),
  };
};

// ---------------------------------------------------------------------------------------------------------------
// 入力（形は `requestOf` でスキーマを使って確かめる）
// ---------------------------------------------------------------------------------------------------------------

interface ProfileKeyRequest {
  readonly profileId: string;
}
interface AutoDraftRequest {
  readonly profileId: string;
  readonly expectedRevision: number;
  readonly discoveryJobId: string;
}
interface AutoRulesRequest {
  readonly scenarioId: string;
  readonly expectedRevision: number;
}

// ---------------------------------------------------------------------------------------------------------------
// Server Functions
// ---------------------------------------------------------------------------------------------------------------

/** 確認のダイアログに出す、作るものの一覧（読むだけ。保存しない）。プロファイルがなければ `null`。 */
export const scenarioAutoDraftPreviewFn = createServerFn({ method: 'GET' })
  .validator(requestOf<ProfileKeyRequest>('ui-profile-key'))
  .handler(async ({ data }): Promise<AutoDraftPreviewView | null> => {
    const facts = await factsOf(data.profileId);
    return facts === null ? null : previewOf(facts);
  });

/** 下書きを作る（確認のダイアログの後。作る順は登録が先、更新は保存せずにリンクを返す）。 */
export const createScenarioAutoDraftsFn = createServerFn({ method: 'POST' })
  .validator(requestOf<AutoDraftRequest>('ui-scenario-auto-draft'))
  .handler(async ({ data }): Promise<AutoDraftResultView> => {
    const facts = await factsOf(data.profileId);
    if (facts === null) {
      return { ok: false, blocker: 'PROFILE_NOT_EDITABLE' };
    }
    if (facts.blocker !== null || facts.context === null) {
      return { ok: false, blocker: facts.blocker ?? 'DISCOVERY_MISSING' };
    }
    if (facts.stored.profile.revision !== data.expectedRevision || facts.latest?.jobId !== data.discoveryJobId) {
      return { ok: false, blocker: 'PREVIEW_OUTDATED' };
    }
    const plan = planOf(facts, facts.context);
    const creates: AutoDraftCreateResultView[] = [];
    for (const item of plan.creates) {
      creates.push(createOne(facts, item));
    }
    // 作る順: 登録を保存した後の文脈で、更新の台帳の結び付けを判定する。
    const context = readScenarioDraftContext(localUiStore(), data.profileId, data.discoveryJobId, null);
    return { ok: true, creates, updates: plan.updates.map((item) => updateOne(facts, item, context)) };
  });

/**
 * 更新の導線: 作成の画面で人が変える欄を選んで保存した API のシナリオに、推した入力の規則の集まりを付ける（承認の前。規則がまだない下書きだけ。
 * 導線の外で作ったシナリオには、画面がこの口を呼ばない）。
 */
export const attachAutoDraftRulesFn = createServerFn({ method: 'POST' })
  .validator(requestOf<AutoRulesRequest>('ui-scenario-auto-rules'))
  .handler(({ data }): AutoDraftRulesResultView => {
    const scenario = readScenario(localUiStore(), data.scenarioId);
    if (scenario === null) {
      return { ok: false, reason: 'SCENARIO_NOT_FOUND' };
    }
    if (scenario.revision !== data.expectedRevision) {
      return { ok: false, reason: 'SCENARIO_REVISION_CONFLICT' };
    }
    if (scenario.state !== DRAFT_SCENARIO_STATE || scenarioTransportOf(scenario.current) !== API_SCENARIO_TRANSPORT) {
      return { ok: false, reason: 'AUTO_RULES_NOT_TARGET' };
    }
    if (scenario.current.inputRuleReference !== null || readLatestRuleSet(localUiStore(), scenario.scenarioId) !== null) {
      return { ok: false, reason: 'AUTO_RULES_ALREADY_SET' };
    }
    const attached = attachInferredRulesOf(scenario);
    return attached.rejection === null && attached.scenario !== null
      ? { ok: true, scenarioRevision: attached.scenario.revision, unresolvedCount: attached.view.unresolved.length }
      : { ok: false, reason: attached.rejection ?? 'SCENARIO_NOT_FOUND' };
  });
