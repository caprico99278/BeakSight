// 更新の書き込みの手順の自動の下書きと、チェックの範囲の承認の唯一の置き場所（OP-2 の修正の 3 回目。設計書 `2026-10-27-beaksight-one-pass-flow-design.md`
// 4.1 の D10、4.1.2 の R1・「チェックの保存」）。前は画面のサーバ（`apps/local-ui/src/server/scenario-autodraft-functions.ts`・`write-screen-functions.ts`）に
// あった中身を、データベースを引数に取る関数にして移した（設計者の判断（案 A）。共通化を優先する）。画面のサーバとジョブの管理は、どちらもここを呼ぶだけ。
// - 推した入れる値の決まりを付ける（`attachInferredRules`）: 規則を推し（`inferRuleSetContent`）、今の 2 段の保存の口（`saveRuleSetAndAttach`）で付ける。
// - 更新の行 1 つ（API の形 `apiUpdateAutoDraftOf`、フォームの形 `formUpdateAutoDraftOf`）: 規則 F で変える欄を決めた計画（`NEW`）から、台帳と型を前もって
//   選ぶ値を求め、`save` のとき、台帳がちょうど 1 つに決まり型があれば、更新の下書きを保存する（検証の指定は台帳から写す `updateVerificationCopyOf`）。
// - 登録に結ぶ更新（`draftUpdateForCreate`）: 既にあれば、その更新。なければ、規則 F で作れて台帳がその登録に決まる更新を作る（ほかの登録の台帳に結ぶ更新は
//   作らない）。
// - チェックの範囲の承認（`approveForCheck`）: 承認が今も有効なものはそのまま。ほかは今の承認の口（`approveScenario`。版・digest・今の事実を確かめ直す）で、
//   副作用の確認を兼ねて（`confirmSideEffects: true`）承認する。承認の有効さの判定は変えない。SPEC-4: 外した規則の画面で人が保存した規則は使わず、推した
//   規則に替えてから承認する（`replaceHumanRules`。判定は `humanRulesAttachedOf`）。
// - 承認・実行の許可は、ここでは出さない（許可の発行は、点検の書き込みの段の前にジョブの管理が行う）。サイトには接続しない。
import { randomUUID } from 'node:crypto';
import { API_SCENARIO_TRANSPORT, FORM_SCENARIO_TRANSPORT, type ScenarioTransport } from '../../core/scenario-transport.js';
import type { ScenarioDraftRejectionReason } from '../../core/scenario-draft-rejection-reasons.js';
import { dateOfCompactUtcTimestamp } from '../../core/utc-timestamp.js';
import { mergedDiscoveryCandidatesOf } from '../discovery-candidate-lookup.js';
import type { DiscoveryDocument } from '../../discovery/discovery-result.js';
import { inferRuleSetContent } from '../data-rules/rule-set-inference.js';
import { ruleSetHasHumanItems, type FieldRuleProblem, type RuleSetRevision } from '../data-rules/rule-contracts.js';
import {
  defaultRuleSetIdOf,
  readLatestRuleSet,
  readRuleSetRevisions,
  saveRuleSetAndAttach,
  type RuleSetStoreRejectionReason,
} from '../data-rules/rule-store.js';
import { listReadChecks } from '../job/read-check-store.js';
import type { ControlDatabase } from '../store/control-database.js';
import {
  apiAutoDraftPlanOf,
  apiUpdateAutoDraftInputOf,
  apiUpdateDraftPresetOf,
  autoDraftScenarioIdOf,
  listShownFieldNamesOf,
  type AutoDraftReadCheckFact,
  type AutoDraftScenarioFact,
  type AutoDraftUpdatePlan,
  type AutoDraftUpdateResultStatus,
} from './api-scenario-autodraft.js';
import { apiScenarioFormOf } from './api-scenario-draft.js';
import { updateNotifyConfirmedByCheckOf, writeScreenMayNotifyOf } from './autodraft-shared.js';
import type { DraftValue } from './draft-value-origin.js';
import {
  formAutoDraftPlanOf,
  formListRowUpdateOf,
  formScenarioProbeDraftOf,
  formTextFieldNamesOf,
  formUpdateDraftPresetOf,
  type FormAutoDraftUpdatePlan,
} from './form-scenario-autodraft.js';
import { scenarioTransportOf, updateLedgerScenarioIdOf } from './scenario-contracts.js';
import type { ApprovalExternalFacts, ScenarioView } from './scenario-facts.js';
import type { ScenarioDraftContext } from './scenario-policy.js';
import { updateVerificationCopyOf } from './update-verification-copy.js';
import {
  approveScenario,
  createScenario,
  listScenarios,
  readScenario,
  readScenarioApprovalStatus,
  readScenarioDraftContext,
  revokeScenarioApproval,
  type ScenarioStoreRejectionReason,
} from './scenario-store.js';

/** 保存の日時を作る時計（UTC の 14 桁。`label` は誤りの文に使う日時の名前）。 */
export type AutoDraftClock = (label: string) => string;

/** 下書きの入力の事実（データベース、プロファイル、下書きに使う発見の文書、時計）。 */
export interface UpdateAutoDraftFacts {
  readonly database: ControlDatabase;
  readonly profileId: string;
  readonly discovery: DiscoveryDocument | null;
  readonly clock: AutoDraftClock;
}

/** 推した入れる値の決まりの結果の要点（値は持たない）。 */
export interface InferredRulesSummary {
  readonly attached: boolean;
  readonly unresolved: readonly FieldRuleProblem[];
  readonly defaultRangeFieldNames: readonly string[];
}

/** 推した入れる値の決まりを付けた結果。 */
export interface InferredRulesAttachment {
  readonly summary: InferredRulesSummary;
  readonly scenario: ScenarioView | null;
  readonly ruleSet: RuleSetRevision | null;
  readonly rejection: RuleSetStoreRejectionReason | ScenarioStoreRejectionReason | 'AUTO_RULES_NOT_INFERRED' | null;
}

/** 更新の行 1 つの結果（行の表示の値は、画面が足す）。 */
export interface UpdateAutoDraftOutcome {
  readonly status: AutoDraftUpdateResultStatus;
  readonly scenarioId: string | null;
  readonly reason: ScenarioDraftRejectionReason | null;
  readonly changedFieldNames: readonly string[];
  readonly ledgerOptionCount: number;
  readonly presetLedger: DraftValue<string> | null;
  readonly presetTemplate: DraftValue<string> | null;
}

/** プロファイルのシナリオの事実（自動の下書きの計画の入力）。 */
export const autoDraftScenarioFactsOf = (database: ControlDatabase, profileId: string): readonly AutoDraftScenarioFact[] =>
  listScenarios(database, profileId).map((scenario) => ({
    scenarioId: scenario.scenarioId,
    kind: scenario.current.kind,
    state: scenario.state,
    candidateIdentityDigest: scenario.current.candidate.identityDigest,
    shapeDigest: scenario.current.api?.shapeDigest ?? null,
  }));

/** プロファイルの、取り消していない見るだけの確かめの定義の事実（自動の下書きの答え合わせの選び方の入力）。 */
export const autoDraftReadCheckFactsOf = (database: ControlDatabase, profileId: string): readonly AutoDraftReadCheckFact[] =>
  listReadChecks(database, profileId).map(({ readCheckId, revision, definition }) => ({
    readCheckId, revision, targetPagePath: definition.targetPagePath ?? null,
    // PL-6b: フォームの形の照合の専用の定義を使い回すかの判定に使う（候補の定義の対象と送る値の名前）。
    targetIdentityDigest: definition.targetIdentityDigest ?? null, parameterNames: Object.keys(definition.parameters),
  }));

/** 推した規則の集まりを保存する先（新しく作るなら版は null。人の規則を替えるなら、その規則の集まりの id と最新の版）。 */
interface InferredRulesTarget {
  readonly ruleSetId: string;
  readonly expectedRevision: number | null;
}

/**
 * 推した規則の集まりを作り、シナリオに付ける（今の 2 段の保存の口。承認の前だけ。自動の下書きの、規則がまだない下書きに付ける 1 か所）。
 */
export const attachInferredRules = (database: ControlDatabase, scenario: ScenarioView, clock: AutoDraftClock): InferredRulesAttachment =>
  saveInferredRulesOf(database, scenario, clock, { ruleSetId: defaultRuleSetIdOf(scenario.scenarioId), expectedRevision: null });

const saveInferredRulesOf = (database: ControlDatabase, scenario: ScenarioView, clock: AutoDraftClock, target: InferredRulesTarget): InferredRulesAttachment => {
  let inferred: ReturnType<typeof inferRuleSetContent>;
  try {
    inferred = inferRuleSetContent(scenario.current, scenario.evidence);
  } catch (error) {
    if (error instanceof RangeError) {
      return { summary: { attached: false, unresolved: [], defaultRangeFieldNames: [] }, scenario: null, ruleSet: null, rejection: 'AUTO_RULES_NOT_INFERRED' };
    }
    throw error;
  }
  const saved = saveRuleSetAndAttach(database, {
    ruleSetId: target.ruleSetId,
    scenarioId: scenario.scenarioId,
    expectedRevision: target.expectedRevision,
    content: inferred.content,
    expectedScenarioRevision: scenario.revision,
    at: clock('automatic input rule save time'),
  });
  const attached = saved.ruleSet.ok && saved.attachment !== null && saved.attachment.ok;
  const summary = { attached, unresolved: [...inferred.unresolvedFields], defaultRangeFieldNames: [...inferred.defaultRangeFieldNames] };
  if (!saved.ruleSet.ok) {
    return { summary, scenario: null, ruleSet: null, rejection: saved.ruleSet.reason };
  }
  if (saved.attachment === null || !saved.attachment.ok) {
    return { summary, scenario: null, ruleSet: saved.ruleSet.ruleSet, rejection: saved.attachment?.ok === false ? saved.attachment.reason : 'SCENARIO_NOT_FOUND' };
  }
  return { summary, scenario: saved.attachment.scenario, ruleSet: saved.ruleSet.ruleSet, rejection: null };
};

/** SPEC-4: シナリオの今の版に付いた規則の集まりが、人の項目を持つか（外した規則の画面で人が保存したもの。判定は `ruleSetHasHumanItems`）。 */
export const humanRulesAttachedOf = (database: ControlDatabase, scenario: ScenarioView): boolean => {
  const reference = scenario.current.inputRuleReference;
  const attached = reference === null
    ? undefined
    : readRuleSetRevisions(database, scenario.scenarioId)
      .find((stored) => stored.reference.revision === reference.revision && stored.reference.digest === reference.digest);
  return attached !== undefined && ruleSetHasHumanItems(attached.ruleSet);
};

/**
 * SPEC-4（設計書 `2026-11-14-beaksight-slim-and-simplify-design.md` 5.1）: 人が保存した規則（`humanRulesAttachedOf`）を使わず、推した規則に替える（チェックの範囲の
 * 承認の前）。承認していれば、今の撤回の口で取り消してから、推した規則を同じ規則の集まりの新しい版にして付ける。人の規則でなければ何もしない。替えなくてよい・
 * 替えたら真、替えられなければ（推せない・保存の口が拒んだ）偽。
 */
export const replaceHumanRules = (database: ControlDatabase, scenarioId: string, clock: AutoDraftClock): boolean => {
  const scenario = readScenario(database, scenarioId);
  const latest = scenario === null ? null : readLatestRuleSet(database, scenarioId);
  if (scenario === null || latest === null || !humanRulesAttachedOf(database, scenario)) {
    return true;
  }
  let draft = scenario;
  if (scenario.state === 'APPROVED') {
    const revoked = revokeScenarioApproval(database, { scenarioId, expectedRevision: scenario.revision, receiptId: randomUUID(), at: clock('human rules revoke time') });
    if (!revoked.ok) {
      return false;
    }
    draft = revoked.scenario;
  }
  return saveInferredRulesOf(database, draft, clock, { ruleSetId: latest.reference.ruleSetId, expectedRevision: latest.reference.revision }).scenario !== null;
};

/**
 * 規則 F で変える欄を決めた更新の下書きを保存する（台帳の検証の指定は、写しの決まり `updateVerificationCopyOf` で台帳から写す。写せなければ照合なしの下書きのまま
 * 保存し、承認の前の確かめが止める）。保存した後に、推した入れる値の決まりを付ける。保存したシナリオ（拒まれたら null）。
 */
const saveUpdateDraftOf = (
  facts: UpdateAutoDraftFacts,
  draft: Readonly<Record<string, unknown>>,
  input: {
    readonly transport: ScenarioTransport;
    readonly ledgerId: string;
    readonly changedFieldNames: readonly string[];
    readonly changedTextFieldNames: readonly string[];
    /** LU-7 fix round 2: API の一覧の行の更新の行の選び方（一覧の画面の照合の READ を写す）。 */
    readonly listRow?: { readonly listPagePath: string } | null;
  },
): { readonly scenario: ScenarioView | null; readonly reason: ScenarioDraftRejectionReason | null } => {
  const { database, profileId } = facts;
  const ledger = listScenarios(database, profileId).find(({ scenarioId }) => scenarioId === input.ledgerId) ?? null;
  const copy = updateVerificationCopyOf({
    transport: input.transport,
    ledger: ledger?.current.verification ?? null,
    readChecks: autoDraftReadCheckFactsOf(database, profileId),
    changedFieldNames: input.changedFieldNames,
    changedTextFieldNames: input.changedTextFieldNames,
    listRow: input.listRow ?? null,
  });
  const verified = copy.kind === 'FILLED' ? { ...draft, verification: { recordId: copy.recordId, readVerification: copy.readVerification } } : draft;
  const created = createScenario(database, {
    scenarioId: autoDraftScenarioIdOf(randomUUID()), draft: verified, discovery: facts.discovery, at: facts.clock('automatic update scenario creation time'),
  });
  if (!created.ok) {
    return { scenario: null, reason: created.draftErrors[0]?.code ?? null };
  }
  const rules = attachInferredRules(database, created.scenario, facts.clock);
  return { scenario: rules.scenario ?? created.scenario, reason: null };
};

/** 計画の状態から作る、行の結果の土台。 */
const outcomeBaseOf = (item: AutoDraftUpdatePlan | FormAutoDraftUpdatePlan): UpdateAutoDraftOutcome => ({
  status: item.status as AutoDraftUpdateResultStatus,
  scenarioId: item.status === 'EXISTING' ? item.scenarioId : null,
  reason: item.status === 'REJECTED' ? item.reason : null,
  changedFieldNames: item.status === 'NEW' ? [...item.changedFieldNames] : [],
  ledgerOptionCount: 0,
  presetLedger: null,
  presetTemplate: null,
});

/**
 * 更新の行 1 つ（API の形）。登録を保存した後の文脈で、台帳と画面の型を前もって選ぶ値を求める。規則 F で変える鍵を決めた行（`NEW`）は、`save` のとき、台帳が
 * ちょうど 1 つに決まり型があれば、変える鍵だけを送る更新の下書きを保存する（`CREATED`。決まらない・拒まれたら `NOT_SAVED`）。
 */
export const apiUpdateAutoDraftOf = (
  facts: UpdateAutoDraftFacts,
  item: AutoDraftUpdatePlan,
  context: ScenarioDraftContext | null,
  save: boolean,
): UpdateAutoDraftOutcome => {
  const base = outcomeBaseOf(item);
  if (item.status !== 'NEW' || context === null) {
    return base;
  }
  const { database, profileId } = facts;
  const scenarios = listScenarios(database, profileId);
  const readChecks = autoDraftReadCheckFactsOf(database, profileId);
  const { form } = apiScenarioFormOf({
    profileId,
    candidate: item.row.candidate,
    context,
    // MI-7: 作成の画面と同じく、台帳の照合の READ と定義を渡す（台帳の選択肢の判定は変わらない）。
    scenarios: scenarios.map((scenario) => ({
      scenarioId: scenario.scenarioId,
      kind: scenario.current.kind,
      pagePath: scenario.evidence.page.path,
      readVerification: scenario.current.verification.readVerification,
    })),
    readChecks,
    // LU-7 fix round 1: 一覧の行の更新の型の案は、自動の下書きだけが受ける（作成の画面は受けない）。
    listRowUpdate: true,
  });
  if (form === null) {
    return save ? { ...base, status: 'NOT_SAVED' } : base;
  }
  const preset = apiUpdateDraftPresetOf(form);
  const view = { ...base, ledgerOptionCount: preset.ledgerOptionCount, presetLedger: preset.ledger, presetTemplate: preset.formPathTemplate };
  const probe = item.row.candidate.submissionProbe;
  if (!save) {
    return view;
  }
  if (preset.ledger === null || preset.formPathTemplate === null || probe === undefined) {
    return { ...view, status: 'NOT_SAVED' };
  }
  // LU-7（一覧の行の更新の設計書 5.4 の 4）: 下書きの組み立ては純粋な部品の 1 か所（一覧の行の更新は、台帳の事実から行を選ぶ欄を選ぶ。選べなければ作らない）。
  const ledgerId = preset.ledger.value;
  const ledgerRead = scenarios.find(({ scenarioId }) => scenarioId === ledgerId)?.current.verification.readVerification ?? null;
  const draft = apiUpdateAutoDraftInputOf({
    profileId, item, form, ledgerScenarioId: ledgerId, formPathTemplate: preset.formPathTemplate.value,
    ledgerFact: context.scenarios.find(({ scenarioId }) => scenarioId === ledgerId),
    listShownFieldNames: listShownFieldNamesOf(ledgerRead, readChecks, preset.formPathTemplate.value),
  });
  if (draft === null) {
    return { ...view, status: 'NOT_SAVED' };
  }
  // LU-11 fix round 2: 一覧の行の更新では、変える鍵は行を選ぶ鍵を除いて選び直した値（下書きの送る鍵）。
  const changedFieldNames = (draft['fieldNames'] as readonly string[] | undefined) ?? item.changedFieldNames;
  const saved = saveUpdateDraftOf(facts, draft, {
    transport: API_SCENARIO_TRANSPORT, ledgerId, changedFieldNames, changedTextFieldNames: [],
    listRow: ((draft['api'] as { readonly ledger?: { readonly listRow?: { readonly listPagePath: string } } }).ledger?.listRow) ?? null,
  });
  return saved.scenario === null
    ? { ...view, status: 'NOT_SAVED', reason: saved.reason }
    : { ...view, status: 'CREATED', scenarioId: saved.scenario.scenarioId, changedFieldNames: [...changedFieldNames] };
};

/**
 * 更新の行 1 つ（フォームの形）。台帳と型を前もって選ぶ値（台帳は同じプロファイルのフォームの形の登録のシナリオから、型は共通の部品）を、今の管理データから
 * 求める。規則 F で変える欄を決めた行（`NEW`）は、`save` のとき、台帳がちょうど 1 つに決まり型があれば、更新の下書きを保存する（`CREATED`。決まらない・拒まれたら
 * `NOT_SAVED`）。
 */
export const formUpdateAutoDraftOf = (facts: UpdateAutoDraftFacts, item: FormAutoDraftUpdatePlan, save: boolean): UpdateAutoDraftOutcome => {
  const base = outcomeBaseOf(item);
  if (item.status !== 'NEW') {
    return base;
  }
  const { database, profileId } = facts;
  const preset = formUpdateDraftPresetOf(item.row.candidate, listScenarios(database, profileId)
    .filter(({ current }) => scenarioTransportOf(current) === FORM_SCENARIO_TRANSPORT)
    .map(({ scenarioId, current }) => ({ scenarioId, kind: current.kind, recordId: current.verification.recordId })));
  const template = preset.templates === null
    ? null
    : { value: preset.templates.value.formPathTemplate, origin: preset.templates.origin, ground: preset.templates.ground };
  const view = { ...base, ledgerOptionCount: preset.ledgerOptionCount, presetLedger: preset.ledger, presetTemplate: template };
  if (!save) {
    return view;
  }
  if (preset.ledger === null || preset.templates === null) {
    return { ...view, status: 'NOT_SAVED' };
  }
  // LU-11（一覧の行の更新の設計書 5.4 の 4、D5）: 行の下に広がるフォーム（同じ行の開き手 `rowOpener`）は、行の選び方を足す（組み立ては純粋な部品
  // `formListRowUpdateOf`。行を選ぶ欄を台帳の事実から API の形と同じ決め方で先に決め、変える欄はそれを除いて選び直す。決められなければ作らない）。
  const ledgerId = preset.ledger.value;
  const { formPathTemplate, actionPathTemplate } = preset.templates.value;
  let listRowUpdate: ReturnType<typeof formListRowUpdateOf> = null;
  if (item.row.candidate.rowOpener !== undefined) {
    const context = facts.discovery === null ? null : readScenarioDraftContext(database, profileId, facts.discovery.jobId, null);
    const ledgerRead = listScenarios(database, profileId).find(({ scenarioId }) => scenarioId === ledgerId)?.current.verification.readVerification ?? null;
    listRowUpdate = formListRowUpdateOf({
      update: item.row.candidate,
      formPathTemplate,
      facts: item.changedFieldFacts,
      ledgerFact: context?.scenarios.find(({ scenarioId }) => scenarioId === ledgerId),
      listShownFieldNames: listShownFieldNamesOf(ledgerRead, autoDraftReadCheckFactsOf(database, profileId), formPathTemplate),
    });
    if (listRowUpdate === null) {
      return { ...view, status: 'NOT_SAVED' };
    }
  }
  const changedFieldNames = listRowUpdate?.changedFieldNames ?? item.changedFieldNames;
  const keepFieldNames = listRowUpdate?.keepFieldNames ?? item.keepFieldNames;
  const draft = {
    ...formScenarioProbeDraftOf(profileId, item.row.candidate, changedFieldNames, keepFieldNames),
    update: {
      targetCreateScenarioId: ledgerId,
      formPathTemplate,
      actionPathTemplate,
      keepFieldNames: [...keepFieldNames],
      ...(listRowUpdate === null ? {} : { listRow: { ...listRowUpdate.listRow } }),
    },
  };
  const saved = saveUpdateDraftOf(facts, draft, {
    transport: FORM_SCENARIO_TRANSPORT, ledgerId: preset.ledger.value, changedFieldNames,
    changedTextFieldNames: formTextFieldNamesOf(item.row.candidate, changedFieldNames),
  });
  return saved.scenario === null
    ? { ...view, status: 'NOT_SAVED', reason: saved.reason }
    : { ...view, status: 'CREATED', scenarioId: saved.scenario.scenarioId, changedFieldNames: [...changedFieldNames] };
};

/** 更新の台帳（登録のシナリオ。なければ null）。 */
const ledgerOf = (database: ControlDatabase, profileId: string, scenarioId: string | null): string | null => {
  const scenario = scenarioId === null ? null : listScenarios(database, profileId).find((item) => item.scenarioId === scenarioId) ?? null;
  return scenario === null ? null : updateLedgerScenarioIdOf(scenario.current);
};

/**
 * 登録のシナリオに結ぶ更新のシナリオ（なければ null）。既にある更新（この台帳に結ぶもの）か、`facts.discovery` の候補で規則 F で作れて、台帳がこの登録に
 * ちょうど決まる更新を作る（ほかの登録の台帳に結ぶ更新は作らない）。発見の文書がない・文脈がない（古い発見など）ときは作らない。
 */
export const draftUpdateForCreate = (facts: UpdateAutoDraftFacts, createScenarioId: string): string | null => {
  const { database, profileId, discovery } = facts;
  const context = discovery === null ? null : readScenarioDraftContext(database, profileId, discovery.jobId, null);
  if (context === null) {
    return null;
  }
  const input = { profileId, candidates: mergedDiscoveryCandidatesOf(discovery), context, scenarios: autoDraftScenarioFactsOf(database, profileId) };
  const updates: readonly {
    readonly status: string;
    readonly existingId: string | null;
    readonly preview: () => UpdateAutoDraftOutcome;
    readonly saveOne: () => UpdateAutoDraftOutcome;
  }[] = [
    ...apiAutoDraftPlanOf(input).updates.map((item) => ({
      status: item.status, existingId: item.status === 'EXISTING' ? item.scenarioId : null,
      preview: () => apiUpdateAutoDraftOf(facts, item, context, false), saveOne: () => apiUpdateAutoDraftOf(facts, item, context, true),
    })),
    ...formAutoDraftPlanOf(input).updates.map((item) => ({
      status: item.status, existingId: item.status === 'EXISTING' ? item.scenarioId : null,
      preview: () => formUpdateAutoDraftOf(facts, item, false), saveOne: () => formUpdateAutoDraftOf(facts, item, true),
    })),
  ];
  for (const { existingId } of updates) {
    if (existingId !== null && ledgerOf(database, profileId, existingId) === createScenarioId) {
      return existingId;
    }
  }
  for (const { status, preview, saveOne } of updates) {
    if (status !== 'NEW' || preview().presetLedger?.value !== createScenarioId) {
      continue;
    }
    const saved = saveOne();
    if (saved.status === 'CREATED' && ledgerOf(database, profileId, saved.scenarioId) === createScenarioId) {
      return saved.scenarioId;
    }
  }
  return null;
};

/**
 * OP-F（安全のレビューの M-3。設計者の判断（案 b））: 点検の中で見つかった更新の、チェックの範囲の自動の承認（ジョブの管理が書き込みの段の前に呼ぶ）。更新の画面が
 * 知らせを送ることがあり、チェックしたときの行（チェックで承認した登録の版の画面）にその 1 行が出ていなかったときは、承認しない（`UPDATE_MAY_NOTIFY`。判定は
 * `updateNotifyConfirmedByCheckOf`）。ほかは `approveForCheck`。
 */
export const approveUpdateForChain = (
  database: ControlDatabase,
  createScenarioId: string,
  updateScenarioId: string,
  external: ApprovalExternalFacts,
  clock: AutoDraftClock,
): { readonly ok: true } | { readonly ok: false; readonly reason: CheckApprovalRejection | 'UPDATE_MAY_NOTIFY' } => {
  const create = readScenario(database, createScenarioId);
  const update = readScenario(database, updateScenarioId);
  if (create === null || update === null) {
    return { ok: false, reason: 'APPROVAL_REJECTED' };
  }
  if (!updateNotifyConfirmedByCheckOf(writeScreenMayNotifyOf(create.evidence, []), update.evidence)) {
    return { ok: false, reason: 'UPDATE_MAY_NOTIFY' };
  }
  return approveForCheck(database, [updateScenarioId], external, clock);
};

/** チェックの範囲の承認を拒んだ理由。 */
export type CheckApprovalRejection = 'APPROVAL_REJECTED';

/**
 * チェックの範囲の承認: シナリオごとに、承認が今も有効ならそのまま。ほかは今の承認の口（`approveScenario`。版・digest・今の事実を同じトランザクションで確かめ
 * 直す）で承認する。チェックが副作用の確認を兼ねる（`confirmSideEffects: true`）。承認の有効さの判定は変えない。どれかを承認できなければ、そこで止める。
 * OP-F（安全のレビューの M-4）: 止めたときは、この呼び出しで行った承認を取り消す（今の撤回の口 `revokeScenarioApproval`）。チェックの意味は「その画面で登録と
 * 更新を試す」なので、更新を承認できなければ、登録も承認しない形に戻す。前から有効だった承認は、そのまま。
 */
export const approveForCheck = (
  database: ControlDatabase,
  scenarioIds: readonly string[],
  external: ApprovalExternalFacts,
  clock: AutoDraftClock,
): { readonly ok: true } | { readonly ok: false; readonly reason: CheckApprovalRejection } => {
  const approvedHere: ScenarioView[] = [];
  const rejectedTakingBack = (): { readonly ok: false; readonly reason: CheckApprovalRejection } => {
    for (const scenario of approvedHere.reverse()) {
      revokeScenarioApproval(database, {
        scenarioId: scenario.scenarioId, expectedRevision: scenario.revision, receiptId: randomUUID(), at: clock('write screen check time'),
      });
    }
    return { ok: false, reason: 'APPROVAL_REJECTED' };
  };
  for (const scenarioId of scenarioIds) {
    // SPEC-4: 人が保存した規則は使わない（推した規則に替えてから承認する）。
    if (!replaceHumanRules(database, scenarioId, clock)) {
      return rejectedTakingBack();
    }
    const at = clock('write screen check time');
    const status = readScenarioApprovalStatus(database, scenarioId, external, dateOfCompactUtcTimestamp(at));
    if (status === null) {
      return rejectedTakingBack();
    }
    if (status.scenario.state === 'APPROVED' && status.validity.approved) {
      continue;
    }
    const approved = approveScenario(database, {
      scenarioId,
      expectedRevision: status.scenario.revision,
      expectedApprovalDigest: status.approvalDigest,
      receiptId: randomUUID(),
      external,
      at,
      confirmSideEffects: true,
    });
    if (!approved.ok) {
      return rejectedTakingBack();
    }
    approvedHere.push(approved.scenario);
  }
  return { ok: true };
};
