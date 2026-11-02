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
 * - 更新の導線: 作成の画面で人が変える欄を選んで保存すると、保存の口（`scenario-functions.ts`）が推した規則を付ける（PL-6b・PL-5 の 9 の (1)。
 *   すべての保存）。PL-5 の修正の 1 回目: 前の規則を付ける口 `attachAutoDraftRulesFn` とスキーマ `ui-scenario-auto-rules` は、使い先がなくなったので捨てた。
 * - PL-6b（設計書 `2026-10-26-beaksight-plain-ui-design.md` 8 章、8.1）: 下書きの入口は 1 つ。最後の発見の候補が API の形でもフォームの形でも、同じ口で作る
 *   （フォームの形の決まりは `form-scenario-autodraft.ts`）。フォームの形の登録は、ID の型と照合の専用の答え合わせの定義を付ける（決められない理由は
 *   `gaps`）。書き換えの案内（作成の画面へのリンクと前もって選ぶ値）は、確認の一覧（`scenarioAutoDraftPreviewFn`）でも、今の管理データから求め直して返す
 *   （画面を移っても消えない。管理データの版を上げない）。
 */
import { randomUUID } from 'node:crypto';
import { createServerFn, createServerOnlyFn } from '@tanstack/react-start';
import {
  API_SCENARIO_TRANSPORT,
  FORM_SCENARIO_TRANSPORT,
  apiAutoDraftPlanOf,
  formAnswerReadChoiceOf,
  formAnswerReadVerificationOf,
  formAutoDraftPlanOf,
  readVerificationOnlyReadCheckIds,
  formRecordIdFromUpdateOf,
  WRITE_AUDIT_MODE,
  type AutoDraftUpdateResultStatus,
  autoDraftBlockerOf,
  autoDraftExpectationStepOf,
  autoDraftReadCheckChoiceOf,
  autoDraftReadVerificationOf,
  isAutoDraftListPageChoice,
  autoDraftScenarioIdOf,
  writeScreenMayNotifyOf,
  attachInferredRules,
  autoDraftReadCheckFactsOf,
  autoDraftScenarioFactsOf,
  apiUpdateAutoDraftOf,
  draftUpdateForCreate,
  formUpdateAutoDraftOf,
  type UpdateAutoDraftFacts,
  type UpdateAutoDraftOutcome,
  createScenario,
  listScenarios,
  readScenario,
  readScenarioDraftContext,
  revokeScenarioApproval,
  updateScenario,
  validateScenarioDraft,
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
  type FormAutoDraftCreatePlan,
  type FormAutoDraftGap,
  type FormAutoDraftUpdatePlan,
  type ReadCheckReference,
  type ScenarioDraftContext,
  type ScenarioReadVerification,
  type ScenarioRevision,
  type ScenarioVerificationRecordId,
  type VerificationExpectation,
  type ScenarioDraftRejectionReason,
  type ScenarioKind,
  type ScenarioStoreRejectionReason,
  type ScenarioTransport,
  type ScenarioView,
} from '../../../../src/control/approval-view.js';
import {
  PRE_APPROVAL_EVALUATION_PREMISE,
  planRuleSet,
  readLatestRuleSet,
  uniqueEachRunFieldNamesOf,
  varyingFieldNamesOf,
  type FieldRuleProblem,
  type RuleSetRevision,
  type RuleSetStoreRejectionReason,
} from '../../../../src/control/data-rules-view.js';
import {
  MAX_READ_CHECK_DEFINITIONS_PER_PROFILE,
  discoveryPageScreenNameOf,
  type DiscoveryCandidate,
  type DiscoveryDocument,
} from '../../../../src/control/discovery-view.js';
import { readJob } from '../../../../src/control/job/job-store.js';
import { cancelReadCheck, createReadCheck } from '../../../../src/control/job/read-check-store.js';
import { validateReadCheckDefinition, type ReadCheckDefinitionRejectionReason } from '../../../../src/control/read-check-policy.js';
import { ACTIVE_PROFILE_STATUS } from '../../../../src/control/store/profile-records.js';
import { sortedKeysJsonOf } from '../../../../src/core/sorted-keys-json.js';
import type { StoredProfile } from '../../../../src/control/store/profile-store.js';
import { usesReadCheck, usesScenarios } from '../display/labels';
import { localUiStore } from './control-store';
import { mergedCandidatesOf, readDiscoveryDocuments } from './discovery-documents';
import { readLatestAuditStageLinkUrls } from './artifact-files';
import { auditLinkPagePathsOf, readCheckPageContextOf, readCheckPagePathsOf } from './read-check-page-context';
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
  /** PL-6b: 送り方（API の形かフォームの形か）。 */
  readonly transport: ScenarioTransport;
  readonly identityDigest: string;
  /** API の形の型の digest（PL-6b: フォームの形の行は空の文字。作成の画面のリンクでは省かれる）。 */
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
  /** PL-6b: フォームの形の登録の、決められなかった理由（下書きの時点で出す。API の形は空）。 */
  readonly gaps: readonly FormAutoDraftGap[];
}

/** 作成の画面へのリンクの引数（ID と型だけ。値と秘密は載せない）。PL-6b: フォームの形は `shape` が空の文字。 */
export interface AutoDraftUpdateLinkView {
  readonly candidate: string;
  readonly shape: string;
  readonly ledger: string | null;
  readonly template: string | null;
}

/**
 * 確認のダイアログの、更新の行 1 つ。PL-6b（設計書 8 章の「更新の案内」）: 作成の画面へのリンクと前もって選ぶ値も、今の管理データから求め直して返す（画面を
 * 移っても案内が消えない。保存しない）。
 */
export interface AutoDraftUpdatePreviewView extends AutoDraftRowView {
  /** OP-2（D10）: 計画の状態（`NEW` は規則 F で変える欄を決めた）。作った結果は `CREATED`（保存した）か `NOT_SAVED`（台帳か型を決められない・保存で拒まれた）。 */
  readonly status: AutoDraftUpdateResultStatus;
  readonly scenarioId: string | null;
  readonly reason: ScenarioDraftRejectionReason | null;
  /** OP-2: 規則 F で決めた変える欄（`NEW`・`CREATED` のとき。ほかは空）。 */
  readonly changedFieldNames: readonly string[];
  /** 作成の画面へのリンク（OP-2: もう使わない。いつも null。形は前のまま）。 */
  readonly link: AutoDraftUpdateLinkView | null;
  readonly ledgerOptionCount: number;
  readonly presetLedger: AutoDraftValueView | null;
  readonly presetTemplate: AutoDraftValueView | null;
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
  /** PL-6b: フォームの形の登録の、決められなかった理由（API の形は空）。 */
  readonly gaps: readonly FormAutoDraftGap[];
}

/** 作った結果の、更新の行 1 つ（確認の一覧の行と同じ形）。 */
export type AutoDraftUpdateResultView = AutoDraftUpdatePreviewView;

/** 下書きを作った結果。 */
export type AutoDraftResultView =
  | { readonly ok: true; readonly creates: readonly AutoDraftCreateResultView[]; readonly updates: readonly AutoDraftUpdateResultView[] }
  | { readonly ok: false; readonly blocker: AutoDraftBlocker };

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
    transport: API_SCENARIO_TRANSPORT,
    identityDigest: row.candidate.identityDigest,
    shapeDigest: row.shapeDigest,
    method: shape?.method ?? '',
    pathShape: shape?.pathShape ?? '',
    pagePath: row.candidate.page.path,
  };
};

/** PL-6b: フォームの形の行の要点（method は上書きがあればその method、path は送信先の path）。 */
const formRowViewOf = (row: FormAutoDraftCreatePlan['row']): AutoDraftRowView => ({
  kind: row.kind,
  transport: FORM_SCENARIO_TRANSPORT,
  identityDigest: row.candidate.identityDigest,
  shapeDigest: '',
  method: row.candidate.methodOverride ?? row.candidate.formMethod ?? '',
  pathShape: row.candidate.action?.path ?? '',
  pagePath: row.candidate.page.path,
});

/** 作る前の事実（プロファイル、最後の発見、文脈、既にあるシナリオと READ の定義、読めた画面の path、画面の path の文脈）。 */
interface AutoDraftFacts {
  readonly stored: StoredProfile;
  readonly reading: ProfileStartReading;
  readonly latest: DiscoveryDocument | null;
  readonly candidates: readonly DiscoveryCandidate[];
  readonly context: ScenarioDraftContext | null;
  readonly blocker: AutoDraftBlocker | null;
  /**
   * OP-R（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1.9 の R1）: 最後の操作さがしまでに終わった点検の段のリンクの path（開始の URL と同じ Origin の
   * もの）。照合の READ の一覧の画面を、ここから選ぶ。
   */
  readonly auditLinkPaths: readonly string[];
}

// OP-2 の修正の 3 回目: シナリオと見るだけの確かめの定義の事実は、共有の部品（`src/control/approval/update-autodraft.ts`）から読む。
const scenarioFactsOf = (profileId: string): readonly AutoDraftScenarioFact[] => autoDraftScenarioFactsOf(localUiStore(), profileId);

const readCheckFactsOf = (profileId: string): readonly AutoDraftReadCheckFact[] => autoDraftReadCheckFactsOf(localUiStore(), profileId);

/**
 * OP-R（R1）: 最後の操作さがしのジョブを作った時までに終わった、最後の点検の段のリンクの path（開始の URL と同じ Origin のもの。読み方は J1 と同じ共通の部品）。
 * 操作さがしがなければ空。
 */
const auditLinkPathsOf = async (profileId: string, latest: DiscoveryDocument | null, reading: ProfileStartReading): Promise<readonly string[]> => {
  if (latest === null) {
    return [];
  }
  const discoveredAt = readJob(localUiStore(), latest.jobId)?.createdAt ?? null;
  return auditLinkPagePathsOf(await readLatestAuditStageLinkUrls(profileId, discoveredAt), reading);
};

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
    auditLinkPaths: await auditLinkPathsOf(profileId, latest, reading),
  };
};

const planInputOf = (facts: AutoDraftFacts, context: ScenarioDraftContext) => ({
  profileId: facts.stored.profile.profileId,
  candidates: facts.candidates,
  context,
  scenarios: scenarioFactsOf(facts.stored.profile.profileId),
});
const planOf = (facts: AutoDraftFacts, context: ScenarioDraftContext) => apiAutoDraftPlanOf(planInputOf(facts, context));
/** PL-6b: フォームの形の計画（同じ入力）。 */
const formPlanOf = (facts: AutoDraftFacts, context: ScenarioDraftContext) => formAutoDraftPlanOf(planInputOf(facts, context));

/** PL-6b: フォームの形の答え合わせの定義の選び方（照合の専用の印で参照される定義だけを使い回す）。答え合わせの候補がなければ null。 */
const formAnswerChoiceOf = (
  facts: AutoDraftFacts,
  item: Extract<FormAutoDraftCreatePlan, { status: 'NEW' }>,
  definitions: readonly AutoDraftReadCheckFact[],
) => (item.answerRead === null
  ? null
  : formAnswerReadChoiceOf({
    answerRead: item.answerRead.value,
    definitions,
    verificationOnlyReadCheckIds: readVerificationOnlyReadCheckIds(localUiStore(), facts.stored.profile.profileId),
    maxDefinitions: MAX_READ_CHECK_DEFINITIONS_PER_PROFILE,
  }));

/** 確認のダイアログの一覧（保存しない。照合の READ の定義の予定は、作る順に数えて上限を見る）。 */
const previewOf = (facts: AutoDraftFacts): AutoDraftPreviewView => {
  const base = { blocker: facts.blocker, expectedRevision: facts.stored.profile.revision, discoveryJobId: facts.latest?.jobId ?? null };
  if (facts.blocker !== null || facts.context === null) {
    return { ...base, creates: [], updates: [] };
  }
  const plan = planOf(facts, facts.context);
  const formPlan = formPlanOf(facts, facts.context);
  const readPagePaths = readCheckPagePathsOf(facts.latest, facts.reading);
  const definitions: AutoDraftReadCheckFact[] = [...readCheckFactsOf(facts.stored.profile.profileId)];
  const apiCreates = plan.creates.map((item): AutoDraftCreatePreviewView => {
      if (item.status !== 'NEW') {
        return {
          ...rowViewOf(item.row), status: item.status, scenarioId: item.status === 'EXISTING' ? item.scenarioId : null,
          reason: item.status === 'REJECTED' ? item.reason : null, recordIdKey: null, readCheck: null, readTemplate: null, gaps: [],
        };
      }
      const choice = autoDraftReadCheckChoiceOf({
        createPagePath: item.row.candidate.page.path, readPagePaths, definitions, maxDefinitions: MAX_READ_CHECK_DEFINITIONS_PER_PROFILE,
        withoutData: item.recordIdKey?.ground === 'API_RECORD_ID_KEY_COMMON_NAME',
        // OP-R（R1）: 点検の段のリンクにある、登録の画面の 1 つ上の一覧の画面も選べる。
        auditLinkPaths: facts.auditLinkPaths,
      });
      if (choice.kind === 'CREATE') {
        // 予定の数え方: 作る定義を 1 つ足して、次の行の上限と、同じ型の定義の重なりを見る。
        definitions.push({ readCheckId: '', revision: 0, targetPagePath: choice.template.value });
      }
      return {
        ...rowViewOf(item.row), status: item.status, scenarioId: null, reason: null, recordIdKey: valueViewOf(item.recordIdKey),
        readCheck: choice.kind === 'CREATE' ? 'CREATED' : choice.kind, readTemplate: choice.kind === 'NOT_INFERRED' ? null : valueViewOf(choice.template),
        gaps: [],
      };
    });
  // PL-6b: フォームの形の登録（API の形の後。照合の専用の定義の予定も、同じ数え方で上限を見る）。
  const formCreates = formPlan.creates.map((item): AutoDraftCreatePreviewView => {
    if (item.status !== 'NEW') {
      return {
        ...formRowViewOf(item.row), status: item.status, scenarioId: item.status === 'EXISTING' ? item.scenarioId : null,
        reason: item.status === 'REJECTED' ? item.reason : null, recordIdKey: null, readCheck: null, readTemplate: null, gaps: [],
      };
    }
    const choice = formAnswerChoiceOf(facts, item, definitions);
    if (choice !== null && choice.kind === 'CREATE') {
      definitions.push({ readCheckId: '', revision: 0, targetPagePath: null });
    }
    return {
      ...formRowViewOf(item.row), status: item.status, scenarioId: null, reason: null, recordIdKey: null,
      readCheck: choice === null ? 'NOT_INFERRED' : choice.kind === 'CREATE' ? 'CREATED' : choice.kind, readTemplate: null, gaps: [...item.gaps],
    };
  });
  return {
    ...base,
    creates: [...apiCreates, ...formCreates],
    // PL-6b（設計書 8 章の「更新の案内」）: 書き換えの案内（作成の画面へのリンクと前もって選ぶ値）は、今の管理データ（作った登録）から求め直す。
    updates: [...plan.updates.map((item) => updateOne(facts, item, facts.context, false)), ...formPlan.updates.map((item) => formUpdateOne(facts, item, false))],
  };
};

/**
 * 推した規則の集まりを作り、シナリオに付ける（今の 2 段の保存の口。承認の前だけ）。PL-6b（設計書 8 章の「入れる値の決まり」）: 書き込みの手順の保存の口
 * （`scenario-functions.ts` の作成と変更）も、規則がまだない下書きに、これで付ける（付け方の 1 か所）。
 */
const attachInferredRulesOf = (scenario: ScenarioView): {
  readonly view: AutoDraftRulesView;
  readonly scenario: ScenarioView | null;
  readonly ruleSet: RuleSetRevision | null;
  readonly rejection: RuleSetStoreRejectionReason | ScenarioStoreRejectionReason | 'AUTO_RULES_NOT_INFERRED' | null;
} => {
  // OP-2 の修正の 3 回目: 中身は共有の部品（`attachInferredRules`。ジョブの管理の更新の下書きと同じ 1 か所）。
  const attached = attachInferredRules(localUiStore(), scenario, nowCompactTimestamp);
  return { view: attached.summary, scenario: attached.scenario, ruleSet: attached.ruleSet, rejection: attached.rejection };
};

/** PL-6b: 保存の口（`scenario-functions.ts`）が使う、推した規則の付け方（サーバだけの関数。DEF-066 の決まり）。 */
export const attachInferredRulesOnSave = createServerOnlyFn((scenario: ScenarioView) => attachInferredRulesOf(scenario));

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
    readCheckRejection: null, rules: null, expectation: null, expectationOutcome: null, gaps: [],
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
  const attached = rules.scenario !== null && rules.ruleSet !== null ? { scenario: rules.scenario, ruleSet: rules.ruleSet } : null;
  const { choice, step } = apiVerificationPlanOf(facts, item, attached === null ? null : {
    ruleSet: attached.ruleSet, scenario: attached.scenario.current, candidate: attached.scenario.evidence,
  }, created.scenario.current.fieldNames);
  const base = {
    ...empty, status: 'CREATED' as const, scenarioId: created.scenario.scenarioId, recordIdKey,
    readTemplate: choice.kind === 'NOT_INFERRED' ? null : valueViewOf(choice.template), rules: rules.view,
  };
  if (step.kind === 'SKIP' || attached === null || (choice.kind !== 'EXISTING' && choice.kind !== 'CREATE')) {
    // 結べないので、型の定義は作らない（既にある定義は、そのまま）。
    const outcome: AutoDraftReadCheckOutcome = choice.kind === 'CREATE' ? 'NOT_LINKED' : choice.kind;
    return { ...base, readCheck: outcome, expectationOutcome: step.kind === 'SKIP' ? step.outcome : 'RULES_NOT_ATTACHED' };
  }
  const { read, linked } = linkApiVerificationOf(facts, item, attached.scenario, choice, step.expectation.value);
  if (read.reference === null) {
    return { ...base, readCheck: read.outcome, readCheckRejection: read.rejection, expectationOutcome: 'NO_READ_CHECK' };
  }
  if (linked === null) {
    return { ...base, readCheck: read.outcome === 'CREATED' ? 'NOT_LINKED' : read.outcome, expectationOutcome: 'LINK_FAILED' };
  }
  return {
    ...base,
    readCheck: read.outcome,
    expectation: { value: step.expectation.value.fieldName, origin: step.expectation.origin, ground: step.expectation.ground },
    expectationOutcome: 'LINKED',
  };
};

/** 入れる値の決まりを付けた、照合の READ の計画の入力（規則、その規則で値を作るシナリオの中身、候補）。 */
interface AttachedRulesFacts {
  readonly ruleSet: RuleSetRevision;
  readonly scenario: ScenarioRevision;
  readonly candidate: DiscoveryCandidate;
}

/**
 * API の形の登録の照合の READ の計画（保存しない。登録を作るときと、OP-S の作り直しの共通の 1 か所）: 照合の READ の画面の選び方と、期待の段。
 * 期待の欄は、規則を付けた後に、実行のたびに値が変わる欄から推す（許可の発行と同じ値の作り方と判定）。MI-C（MI-6 の報告の片付け）: 下書きは副作用の確認が
 * まだなので、承認の前の画面（`data-rule-facts.ts`）と同じ前提（承認のダイアログで確認する `PRE_APPROVAL_EVALUATION_PREMISE`）で判定する（メールの欄も
 * 変わる欄に数える。承認の後の許可の発行は、確認を入れた版で同じ判定になる）。
 */
const apiVerificationPlanOf = (
  facts: AutoDraftFacts,
  item: Extract<AutoDraftCreatePlan, { readonly status: 'NEW' }>,
  attached: AttachedRulesFacts | null,
  fieldNames: readonly string[],
): { readonly choice: AutoDraftReadCheckChoice; readonly step: ReturnType<typeof autoDraftExpectationStepOf> } => {
  const planned = plannedRulesOf(attached);
  // OP-REV6 の I-1: 実行のたびに違う値になる欄（一覧の画面は、この欄があるときだけ推し、この欄と比べる）。規則がなければ空。
  const uniqueEachRunFieldNames = planned === null ? [] : uniqueEachRunFieldNamesOf(planned);
  const choice = autoDraftReadCheckChoiceOf({
    createPagePath: item.row.candidate.page.path,
    readPagePaths: readCheckPagePathsOf(facts.latest, facts.reading),
    definitions: readCheckFactsOf(facts.stored.profile.profileId),
    maxDefinitions: MAX_READ_CHECK_DEFINITIONS_PER_PROFILE,
    // OP-G（設計書 4.1.4 の E2）: データのないサイトの登録は、答え合わせの画面の型も、よくある形を推す。
    withoutData: item.recordIdKey?.ground === 'API_RECORD_ID_KEY_COMMON_NAME',
    // OP-R（設計書 4.1.9 の R1）: 点検の段のリンクにある、登録の画面の 1 つ上の一覧の画面を、よくある形より先に選ぶ。
    auditLinkPaths: facts.auditLinkPaths,
    fieldNames,
    uniqueEachRunFieldNames,
  });
  const step = autoDraftExpectationStepOf({
    rulesAttached: planned !== null,
    readCheck: choice,
    fieldNames,
    varyingFieldNames: planned === null ? [] : varyingFieldNamesOf(planned),
    uniqueEachRunFieldNames,
  });
  return { choice, step };
};

/** 規則で値を作る計画（規則がない・規則がそのシナリオの中身に合わないときは null）。 */
const plannedRulesOf = (attached: AttachedRulesFacts | null): ReturnType<typeof planRuleSet> | null => {
  if (attached === null) {
    return null;
  }
  try {
    return planRuleSet(attached.ruleSet, attached.scenario, attached.candidate, undefined, PRE_APPROVAL_EVALUATION_PREMISE);
  } catch (error) {
    if (error instanceof RangeError) {
      return null;
    }
    throw error;
  }
};

/**
 * OP-T fix round 2（Minor 7）: フォームの形の答え合わせの結び付けと期待を、照合の定義の参照から作る部品（作るときと作り直しの共通の 1 か所）。変わる欄は、規則で
 * 値を作る計画から求める（`plannedRulesOf`）。
 */
const formVerificationOfPlan = (
  answerRead: NonNullable<Extract<FormAutoDraftCreatePlan, { readonly status: 'NEW' }>['answerRead']>['value'],
  textFieldNames: readonly string[],
  planned: NonNullable<ReturnType<typeof plannedRulesOf>>,
): ((reference: ReadCheckReference) => ScenarioReadVerification | null) => {
  const varyingFieldNames = varyingFieldNamesOf(planned);
  return (reference) => formAnswerReadVerificationOf({ reference, parameterName: answerRead.parameterName, textFieldNames, varyingFieldNames });
};

/**
 * API の形の登録の照合の READ の定義を用意し（既にある定義を使うか、確かめてから作る）、下書きの版に結ぶ（今の保存の口 `updateScenario`。版を 1 つ上げ、状態は
 * `DRAFT`）。結べなかったときは、作った定義を取り消す（定義の数の上限に数えない。既にある定義は取り消さない）。登録を作るときと、OP-S の作り直しの共通。
 */
const linkApiVerificationOf = (
  facts: AutoDraftFacts,
  item: Extract<AutoDraftCreatePlan, { readonly status: 'NEW' }>,
  scenario: ScenarioView,
  choice: Extract<AutoDraftReadCheckChoice, { kind: 'EXISTING' | 'CREATE' }>,
  expectation: VerificationExpectation,
): { readonly read: ReturnType<typeof readCheckReferenceOf>; readonly linked: ScenarioView | null } => {
  const read = readCheckReferenceOf(facts, choice);
  if (read.reference === null) {
    return { read, linked: null };
  }
  const linked = updateScenario(localUiStore(), {
    scenarioId: scenario.scenarioId,
    expectedRevision: scenario.revision,
    draft: {
      ...item.draft,
      verification: {
        // PL-6a: 成否の条件はない（結果の判定のしかたの印は、下書きの確かめが送り方から付ける）。
        // OP-R（R1）: 一覧の画面の照合の READ は、照合の専用の印を持つ（単独の READ の確かめのジョブは読まない）。
        recordId: null, readVerification: autoDraftReadVerificationOf(read.reference, expectation, isAutoDraftListPageChoice(choice)),
      },
    },
    discovery: facts.latest,
    at: nowCompactTimestamp('automatic scenario verification time'),
  });
  if (!linked.ok) {
    if (read.outcome === 'CREATED') {
      cancelReadCheck(localUiStore(), {
        readCheckId: read.reference.readCheckId, expectedRevision: read.reference.revision, at: nowCompactTimestamp('automatic READ check cancel time'),
      });
    }
    return { read, linked: null };
  }
  return { read, linked: linked.scenario };
};

/** OP-2 の修正の 3 回目: 共有の部品（`src/control/approval/update-autodraft.ts`）に渡す事実（画面の管理データと、最後の発見）。 */
const updateFactsOf = (facts: AutoDraftFacts): UpdateAutoDraftFacts => ({
  database: localUiStore(), profileId: facts.stored.profile.profileId, discovery: facts.latest, clock: nowCompactTimestamp,
});

/** 共有の部品の行の結果を、画面の行の値にする（出どころの印つきの値の写し）。 */
const updateViewOf = (row: AutoDraftRowView, outcome: UpdateAutoDraftOutcome): AutoDraftUpdateResultView => ({
  ...row,
  status: outcome.status,
  scenarioId: outcome.scenarioId,
  reason: outcome.reason,
  changedFieldNames: outcome.changedFieldNames,
  link: null,
  ledgerOptionCount: outcome.ledgerOptionCount,
  presetLedger: valueViewOf(outcome.presetLedger),
  presetTemplate: valueViewOf(outcome.presetTemplate),
});

/**
 * 更新の行 1 つ（API の形）。OP-2 の修正の 3 回目: 中身は共有の部品（`apiUpdateAutoDraftOf`）。ここは画面の行の値にするだけ。
 */
const updateOne = (facts: AutoDraftFacts, item: AutoDraftUpdatePlan, context: ScenarioDraftContext | null, save: boolean): AutoDraftUpdateResultView =>
  updateViewOf(rowViewOf(item.row), apiUpdateAutoDraftOf(updateFactsOf(facts), item, context, save));

/**
 * PL-6b: フォームの形の登録の行 1 つを作る（作る順: シナリオ（ID の型つき）→ 規則 → 変わる欄で答え合わせの結び付けと期待を決める → 結べるときだけ照合の専用の
 * 定義を作る（既にある照合の専用の定義は使う）→ 答え合わせに結ぶ）。作った後に結べなかった定義は取り消す（API の形と同じ）。
 */
const createFormOne = (facts: AutoDraftFacts, item: FormAutoDraftCreatePlan): AutoDraftCreateResultView => {
  const empty = {
    ...formRowViewOf(item.row), scenarioId: null, reason: null, failure: null, recordIdKey: null, readCheck: null, readTemplate: null,
    readCheckRejection: null, rules: null, expectation: null, expectationOutcome: null, gaps: [],
  };
  if (item.status === 'EXISTING') {
    return { ...empty, status: 'EXISTING', scenarioId: item.scenarioId };
  }
  if (item.status === 'REJECTED') {
    return { ...empty, status: 'REJECTED', reason: item.reason };
  }
  const gaps = [...item.gaps];
  const created = createScenario(localUiStore(), {
    scenarioId: autoDraftScenarioIdOf(randomUUID()), draft: item.draft, discovery: facts.latest, at: nowCompactTimestamp('automatic scenario creation time'),
  });
  if (!created.ok) {
    return { ...empty, status: 'FAILED', gaps, failure: created.reason, reason: created.draftErrors[0]?.code ?? null, readCheck: 'NOT_ATTEMPTED' };
  }
  const rules = attachInferredRulesOf(created.scenario);
  const base = { ...empty, status: 'CREATED' as const, scenarioId: created.scenario.scenarioId, rules: rules.view, gaps };
  const choice = formAnswerChoiceOf(facts, item, readCheckFactsOf(facts.stored.profile.profileId));
  if (item.answerRead === null || choice === null) {
    return { ...base, readCheck: 'NOT_INFERRED', expectationOutcome: 'NO_READ_CHECK' };
  }
  const notLinked: AutoDraftReadCheckOutcome = choice.kind === 'CREATE' ? 'NOT_LINKED' : choice.kind;
  if (rules.scenario === null || rules.ruleSet === null) {
    return { ...base, readCheck: notLinked, expectationOutcome: 'RULES_NOT_ATTACHED' };
  }
  const attached = { scenario: rules.scenario, ruleSet: rules.ruleSet };
  // 変わる欄は、承認の前の画面と同じ前提（`PRE_APPROVAL_EVALUATION_PREMISE`）で求める（API の形と同じ）。OP-T fix round 2（Minor 7）: 求め方は作り直しと同じ
  // `plannedRulesOf`（規則がシナリオの中身に合わないときは、規則なしと同じに扱う）。
  const planned = plannedRulesOf({ ruleSet: attached.ruleSet, scenario: attached.scenario.current, candidate: attached.scenario.evidence });
  if (planned === null) {
    return { ...base, readCheck: notLinked, expectationOutcome: 'RULES_NOT_ATTACHED' };
  }
  const answerCandidate = item.answerRead.value.candidate;
  const verificationOf = formVerificationOfPlan(item.answerRead.value, item.textFieldNames, planned);
  // 結べない定義は作らない（変わる欄がなければ、定義を作らずに理由を返す）。
  if (verificationOf({ readCheckId: '', revision: 0 }) === null) {
    return { ...base, readCheck: notLinked, expectationOutcome: 'NO_VARYING_FIELD' };
  }
  if (choice.kind === 'LIMIT_REACHED') {
    return { ...base, readCheck: 'LIMIT_REACHED', expectationOutcome: 'NO_READ_CHECK' };
  }
  const linked = linkFormVerificationOf(facts, item, attached.scenario, choice, answerCandidate, verificationOf);
  if (linked.kind === 'REJECTED') {
    return { ...base, readCheck: 'REJECTED', readCheckRejection: linked.rejection, expectationOutcome: 'NO_READ_CHECK' };
  }
  if (linked.kind === 'NOT_LINKED') {
    return { ...base, readCheck: notLinked, expectationOutcome: 'LINK_FAILED' };
  }
  const outcome: AutoDraftReadCheckOutcome = choice.kind === 'CREATE' ? 'CREATED' : 'EXISTING';
  const { readVerification } = linked;
  const [binding] = readVerification?.bindings ?? [];
  return {
    ...base,
    readCheck: outcome,
    expectation: binding === undefined ? null : { value: binding.fieldName, origin: 'INFERRED', ground: 'READ_EXPECTATION_FROM_VARYING_FIELD' },
    expectationOutcome: 'LINKED',
  };
};

/**
 * フォームの形の登録の照合の専用の定義を用意し（既にある定義を使うか、確かめてから作る）、下書きの版に結ぶ（今の保存の口 `updateScenario`）。結べなかったときは、
 * 作った定義を取り消す（既にある定義は取り消さない）。登録を作るときと、OP-S の作り直しの共通。
 */
const linkFormVerificationOf = (
  facts: AutoDraftFacts,
  item: Extract<FormAutoDraftCreatePlan, { readonly status: 'NEW' }>,
  scenario: ScenarioView,
  choice: { readonly kind: 'EXISTING'; readonly reference: ReadCheckReference } | { readonly kind: 'CREATE'; readonly definition: unknown },
  answerCandidate: DiscoveryCandidate,
  verificationOf: (reference: ReadCheckReference) => ScenarioReadVerification | null,
):
  | { readonly kind: 'REJECTED'; readonly rejection: ReadCheckDefinitionRejectionReason }
  | { readonly kind: 'NOT_LINKED' }
  | { readonly kind: 'LINKED'; readonly scenario: ScenarioView; readonly readVerification: ScenarioReadVerification } => {
  let reference: ReadCheckReference;
  if (choice.kind === 'EXISTING') {
    reference = choice.reference;
  } else {
    // 保存の確かめは、READ の確かめの画面の保存と同じ（対象の候補に照らす）。
    const validation = validateReadCheckDefinition(choice.definition, answerCandidate);
    if (!validation.ok) {
      return { kind: 'REJECTED', rejection: validation.errors[0]?.code ?? 'READ_CHECK_INPUT_INVALID' };
    }
    const saved = createReadCheck(localUiStore(), {
      readCheckId: randomUUID(), profileId: facts.stored.profile.profileId, definition: validation.definition,
      at: nowCompactTimestamp('automatic READ check creation time'),
    });
    if (!saved.ok) {
      return { kind: 'REJECTED', rejection: saved.reason };
    }
    reference = { readCheckId: saved.readCheck.readCheckId, revision: saved.readCheck.revision };
  }
  const readVerification = verificationOf(reference);
  const linked = readVerification === null ? null : updateScenario(localUiStore(), {
    scenarioId: scenario.scenarioId,
    expectedRevision: scenario.revision,
    draft: { ...item.draft, verification: { recordId: item.recordId?.value ?? null, readVerification } },
    discovery: facts.latest,
    at: nowCompactTimestamp('automatic scenario verification time'),
  });
  if (readVerification === null || linked === null || !linked.ok) {
    // 作った後に結べなかった定義は取り消す（既にある定義は取り消さない）。
    if (choice.kind === 'CREATE') {
      cancelReadCheck(localUiStore(), {
        readCheckId: reference.readCheckId, expectedRevision: reference.revision, at: nowCompactTimestamp('automatic READ check cancel time'),
      });
    }
    return { kind: 'NOT_LINKED' };
  }
  return { kind: 'LINKED', scenario: linked.scenario, readVerification };
};

/** 更新の行 1 つ（フォームの形）。OP-2 の修正の 3 回目: 中身は共有の部品（`formUpdateAutoDraftOf`）。ここは画面の行の値にするだけ。 */
const formUpdateOne = (facts: AutoDraftFacts, item: FormAutoDraftUpdatePlan, save: boolean): AutoDraftUpdateResultView =>
  updateViewOf(formRowViewOf(item.row), formUpdateAutoDraftOf(updateFactsOf(facts), item, save));

// ---------------------------------------------------------------------------------------------------------------
// OP-S（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1.1 の D7'、4.1.9）: チェックを入れたときの、既にある登録の書き込みの手順の作り直し
// - その画面の登録の手順が既にあれば、最後の操作さがしと今の自動の下書きの決まりで作り直した中身（送る欄・ID の取り方などの下書き、照合の READ の定義と期待）
//   を、今の版と比べる。違えば、今の保存の口（`updateScenario`）で新しい版にする（承認は、チェックの保存がその版に行う）。同じなら、何もしない（承認だけ）。
// - 作り方は、登録を作るときと同じ部品（`apiVerificationPlanOf`・`linkApiVerificationOf`・`linkFormVerificationOf`）。入れる値の決まりは、今の版に付いた
//   規則を使う（人が直したかもしれないので、推し直さない）。今の決まりで完全な手順を作れないとき（照合の READ を推せない・上限・期待を推せない）は、
//   今の版のまま（承認だけ）にする（チェックできていた画面を、チェックできない形にしない）。
// - 承認している版は、今の撤回の口（`revokeScenarioApproval`）で取り消してから、新しい版にする（承認を引き継がない）。
// - 前の照合の定義: 照合の専用の印で参照していた定義は、どのシナリオの今の版も参照しなくなれば取り消す（印がなくなると、単独の READ の確かめのジョブが読む
//   ため）。印のない定義（人が作った定義と、前の決まりの `{id}` の型の定義）は、そのまま残す（単独の READ の確かめでの扱いは前と同じ）。
// ---------------------------------------------------------------------------------------------------------------

/** 作る前の照合の定義の仮の参照（比べるときだけに使う。保存しない）。 */
const PENDING_READ_CHECK_REFERENCE: ReadCheckReference = Object.freeze({ readCheckId: '', revision: 0 });

/** 中身の比べに入れない項目（版・日時・規則の参照、チェックの承認が確かめる副作用の確認、別に比べる検証の指定）。 */
const UNCOMPARED_CONTENT_KEYS: ReadonlySet<string> = new Set([
  'schemaVersion', 'scenarioId', 'revision', 'inputRuleReference', 'createdAt', 'updatedAt', 'sideEffectConfirmations', 'verification',
]);

/** OP-T: 送る中身の比べに入れない、照合の READ の項目（照らす READ の定義の参照。照合の定義・期待・結び付けは検証の指定の側）。 */
const READ_CONTENT_KEYS: ReadonlySet<string> = new Set(['readChecks']);

/** 比べる形の中身（送り方の項目のない FORM の文書は、`FORM` と同じに扱う。`excluded` は、ほかに比べに入れない項目）。 */
const comparableContentOf = (content: object, excluded: ReadonlySet<string> = new Set()): string => sortedKeysJsonOf({
  ...Object.fromEntries(Object.entries(content).filter(([key]) => !UNCOMPARED_CONTENT_KEYS.has(key) && !excluded.has(key))),
  transport: (content as { readonly transport?: string }).transport ?? FORM_SCENARIO_TRANSPORT,
});

/**
 * OP-T（DEF-184）: 比べる形の送る中身（送り先の path の形・方式・送る欄の名前の集まり・ID の取り方。照合の READ の参照と定義・期待・結び付けは入れない）。
 * これが違う作り直しは、チェックの承認の外（まとめて実行の始めには自動で承認しない）。
 */
const comparableSentOf = (content: object, recordId: ScenarioVerificationRecordId | null): string =>
  sortedKeysJsonOf({ content: comparableContentOf(content, READ_CONTENT_KEYS), recordId });

/**
 * OP-T: 作り直しの結果（`NOT_REDRAFTED`: 作り直さなかった・作り直せなかった。`SAME`: 今の版と同じ。`READ_CHANGED`: 照合の READ だけが違い、新しい版にした。
 * `SENT_CHANGED`: 送る中身が違い、新しい版にした）。
 */
export type ScreenRedraftOutcome = 'NOT_REDRAFTED' | 'SAME' | 'READ_CHANGED' | 'SENT_CHANGED';

/** 新しい版にしたときの結果（送る中身が違うか）。 */
const changedOutcomeOf = (
  existing: ScenarioView,
  content: object,
  recordId: ScenarioVerificationRecordId | null,
): Extract<ScreenRedraftOutcome, 'READ_CHANGED' | 'SENT_CHANGED'> =>
  (comparableSentOf(existing.current, existing.current.verification.recordId) === comparableSentOf(content, recordId) ? 'READ_CHANGED' : 'SENT_CHANGED');

/** 比べる形の検証の指定（結び付けは順によらない。照合の専用の印は、省いたものを偽にする）。 */
const comparableVerificationOf = (recordId: ScenarioVerificationRecordId | null, read: ScenarioReadVerification | null): string => sortedKeysJsonOf({
  recordId,
  readVerification: read === null ? null : {
    readCheckId: read.readCheckId,
    revision: read.revision,
    bindings: read.bindings.map((binding) => sortedKeysJsonOf(binding)).sort(),
    expectations: read.expectations,
    verificationOnly: read.verificationOnly === true,
  },
});

/** 作り直した中身が、今の版と違うか（照合の定義を新しく作るなら、違う）。 */
const redraftDiffersOf = (
  existing: ScenarioView,
  content: object,
  target: { readonly recordId: ScenarioVerificationRecordId | null; readonly readVerification: ScenarioReadVerification },
  newDefinition: boolean,
): boolean => newDefinition
  || comparableContentOf(existing.current) !== comparableContentOf(content)
  || comparableVerificationOf(existing.current.verification.recordId, existing.current.verification.readVerification)
    !== comparableVerificationOf(target.recordId, target.readVerification);

/** 今の版に付いた入れる値の決まり（最新の規則の集まりが、今の版の参照と同じときだけ。値を作る中身は作り直した中身）。 */
const attachedRulesOfExisting = (existing: ScenarioView, content: object, candidate: DiscoveryCandidate): AttachedRulesFacts | null => {
  const stored = readLatestRuleSet(localUiStore(), existing.scenarioId);
  const reference = existing.current.inputRuleReference;
  if (stored === null || reference === null || stored.reference.ruleSetId !== reference.ruleSetId || stored.reference.revision !== reference.revision
    || stored.reference.digest !== reference.digest) {
    return null;
  }
  return { ruleSet: stored.ruleSet, scenario: { ...existing.current, ...content } as ScenarioRevision, candidate };
};

/**
 * OP-T fix round 2（Minor 7）: 承認したシナリオ 1 つの承認を、今の撤回の口（`revokeScenarioApproval`）で取り消す小さな部品（作り直しと、書き込みの一覧の取り消しが
 * 使う）。承認していなければ、そのまま返す。取り消せなければ null。`timeLabel` は時刻の記録の名前。
 */
export const revokeApprovalOf = createServerOnlyFn((scenario: ScenarioView, timeLabel: string): ScenarioView | null => {
  if (scenario.state !== 'APPROVED') {
    return scenario;
  }
  const revoked = revokeScenarioApproval(localUiStore(), {
    scenarioId: scenario.scenarioId, expectedRevision: scenario.revision, receiptId: randomUUID(), at: nowCompactTimestamp(timeLabel),
  });
  return revoked.ok ? revoked.scenario : null;
});

/** 新しい版にできるシナリオ（承認していれば、今の撤回の口で取り消した後。取り消せなければ null）。 */
const redraftableOf = (scenario: ScenarioView): ScenarioView | null => revokeApprovalOf(scenario, 'automatic redraft revoke time');

/** 置き換えた前の照合の専用の定義を、どのシナリオの今の版も参照しなくなったら取り消す（印のない定義は残す）。 */
const retireReplacedDefinitionOf = (profileId: string, replaced: ScenarioReadVerification | null): void => {
  if (replaced === null || replaced.verificationOnly !== true) {
    return;
  }
  const used = listScenarios(localUiStore(), profileId).some(({ current }) => current.verification.readVerification?.readCheckId === replaced.readCheckId
    || current.readChecks.some(({ readCheckId }) => readCheckId === replaced.readCheckId));
  const fact = readCheckFactsOf(profileId).find(({ readCheckId }) => readCheckId === replaced.readCheckId);
  if (used || fact === undefined) {
    return;
  }
  cancelReadCheck(localUiStore(), {
    readCheckId: fact.readCheckId, expectedRevision: fact.revision, at: nowCompactTimestamp('automatic redraft READ check cancel time'),
  });
};

/** 計画の入力（作り直すシナリオを、既にあるものから外す。外したので、その行は `NEW` の計画になる）。 */
const redraftPlanInputOf = (facts: AutoDraftFacts, context: ScenarioDraftContext, scenarioId: string) => ({
  ...planInputOf(facts, context),
  scenarios: scenarioFactsOf(facts.stored.profile.profileId).filter((scenario) => scenario.scenarioId !== scenarioId),
});

/** API の形の登録の手順を、今の決まりで作り直す（違うときだけ新しい版にする）。 */
const redraftApiCreate = (
  facts: AutoDraftFacts,
  context: ScenarioDraftContext,
  existingItem: Extract<AutoDraftCreatePlan, { readonly status: 'EXISTING' }>,
): ScreenRedraftOutcome => {
  const existing = readScenario(localUiStore(), existingItem.scenarioId);
  const item = apiAutoDraftPlanOf(redraftPlanInputOf(facts, context, existingItem.scenarioId)).creates
    .find(({ row }) => row.candidate.identityDigest === existingItem.row.candidate.identityDigest && row.shapeDigest === existingItem.row.shapeDigest);
  if (existing === null || item?.status !== 'NEW') {
    return 'NOT_REDRAFTED';
  }
  const content = validateScenarioDraft(item.draft, item.row.candidate, [], context);
  if (!content.ok) {
    return 'NOT_REDRAFTED';
  }
  const attached = attachedRulesOfExisting(existing, content.content, item.row.candidate);
  const { choice, step } = apiVerificationPlanOf(facts, item, attached, content.content.fieldNames);
  if (step.kind === 'SKIP' || (choice.kind !== 'EXISTING' && choice.kind !== 'CREATE')) {
    return 'NOT_REDRAFTED';
  }
  const readVerification = autoDraftReadVerificationOf(
    choice.kind === 'EXISTING' ? choice.reference : PENDING_READ_CHECK_REFERENCE, step.expectation.value, isAutoDraftListPageChoice(choice),
  );
  if (!redraftDiffersOf(existing, content.content, { recordId: null, readVerification }, choice.kind === 'CREATE')) {
    return 'SAME';
  }
  const redraftable = redraftableOf(existing);
  if (redraftable === null || linkApiVerificationOf(facts, item, redraftable, choice, step.expectation.value).linked === null) {
    return 'NOT_REDRAFTED';
  }
  retireReplacedDefinitionOf(facts.stored.profile.profileId, existing.current.verification.readVerification);
  return changedOutcomeOf(existing, content.content, null);
};

/** フォームの形の登録の手順を、今の決まりで作り直す（違うときだけ新しい版にする）。 */
const redraftFormCreate = (
  facts: AutoDraftFacts,
  context: ScenarioDraftContext,
  existingItem: Extract<FormAutoDraftCreatePlan, { readonly status: 'EXISTING' }>,
): ScreenRedraftOutcome => {
  const existing = readScenario(localUiStore(), existingItem.scenarioId);
  const item = formAutoDraftPlanOf(redraftPlanInputOf(facts, context, existingItem.scenarioId)).creates
    .find(({ row }) => row.candidate.identityDigest === existingItem.row.candidate.identityDigest);
  if (existing === null || item?.status !== 'NEW' || item.answerRead === null) {
    return 'NOT_REDRAFTED';
  }
  const content = validateScenarioDraft(item.draft, item.row.candidate, [], context);
  const planned = content.ok ? plannedRulesOf(attachedRulesOfExisting(existing, content.content, item.row.candidate)) : null;
  const choice = formAnswerChoiceOf(facts, item, readCheckFactsOf(facts.stored.profile.profileId));
  if (!content.ok || planned === null || choice === null || choice.kind === 'LIMIT_REACHED') {
    return 'NOT_REDRAFTED';
  }
  const answerCandidate = item.answerRead.value.candidate;
  const verificationOf = formVerificationOfPlan(item.answerRead.value, item.textFieldNames, planned);
  const readVerification = verificationOf(choice.kind === 'EXISTING' ? choice.reference : PENDING_READ_CHECK_REFERENCE);
  const recordId = item.recordId?.value ?? null;
  if (readVerification === null) {
    return 'NOT_REDRAFTED';
  }
  if (!redraftDiffersOf(existing, content.content, { recordId, readVerification }, choice.kind === 'CREATE')) {
    return 'SAME';
  }
  const redraftable = redraftableOf(existing);
  if (redraftable === null || linkFormVerificationOf(facts, item, redraftable, choice, answerCandidate, verificationOf).kind !== 'LINKED') {
    return 'NOT_REDRAFTED';
  }
  retireReplacedDefinitionOf(facts.stored.profile.profileId, existing.current.verification.readVerification);
  return changedOutcomeOf(existing, content.content, recordId);
};

/**
 * 既にある登録の手順を、今の決まりで作り直す 1 か所（OP-S。チェックの保存と、OP-T のまとめて実行の始めが使う）。登録の手順がまだない画面・見つからない画面は
 * `NOT_REDRAFTED`。
 */
const redraftExistingOf = (
  facts: AutoDraftFacts,
  context: ScenarioDraftContext,
  apiCreate: AutoDraftCreatePlan | undefined,
  formCreate: FormAutoDraftCreatePlan | undefined,
): ScreenRedraftOutcome => {
  if (apiCreate !== undefined) {
    return apiCreate.status === 'EXISTING' ? redraftApiCreate(facts, context, apiCreate) : 'NOT_REDRAFTED';
  }
  return formCreate?.status === 'EXISTING' ? redraftFormCreate(facts, context, formCreate) : 'NOT_REDRAFTED';
};

/** 画面 1 つ（登録の候補の識別の digest）の、今の計画の登録の行（API の形とフォームの形）。 */
const screenCreatesOf = (facts: AutoDraftFacts, context: ScenarioDraftContext, createDigest: string) => ({
  apiCreate: planOf(facts, context).creates.find(({ row }) => row.candidate.identityDigest === createDigest),
  formCreate: formPlanOf(facts, context).creates.find(({ row }) => row.candidate.identityDigest === createDigest),
});

/**
 * OP-T（DEF-184）: まとめて実行の始めに、チェックした画面の登録の手順を作り直す口（作り直しの中身は OP-S の 1 か所 `redraftExistingOf`。チェックの保存と同じ部品）。
 * 承認はしない（結果で、呼ぶ側が決める）。下書きの事実がそろわないサイトは `NOT_REDRAFTED`。
 */
export const redraftScreenOnChainStart = createServerOnlyFn(async (profileId: string, createDigest: string): Promise<ScreenRedraftOutcome> => {
  const facts = await factsOf(profileId);
  if (facts === null || facts.blocker !== null || facts.context === null) {
    return 'NOT_REDRAFTED';
  }
  const { apiCreate, formCreate } = screenCreatesOf(facts, facts.context, createDigest);
  return redraftExistingOf(facts, facts.context, apiCreate, formCreate);
});

/**
 * OP-2（設計書 4.1.1 の D7'）: サイトの画面の一覧のチェックの保存が使う、画面 1 つ（登録の候補の識別の digest）の下書き。登録がなければ作り（今の作り方
 * `createOne`・`createFormOne`）、登録を保存した後の文脈で、その台帳に結ぶ更新を規則 F で作る（ちょうど 1 つの台帳に決まるときだけ）。作れない画面は理由。
 */
export interface ScreenDraftResult {
  readonly ok: boolean;
  readonly createScenarioId: string | null;
  readonly updateScenarioId: string | null;
  readonly blocker: AutoDraftBlocker | 'SCREEN_NOT_FOUND' | 'SCREEN_NOT_DRAFTABLE' | null;
}

export const draftScreenForCheck = createServerOnlyFn(async (profileId: string, createDigest: string): Promise<ScreenDraftResult> => {
  const facts = await factsOf(profileId);
  if (facts === null) {
    return { ok: false, createScenarioId: null, updateScenarioId: null, blocker: 'PROFILE_NOT_EDITABLE' };
  }
  if (facts.blocker !== null || facts.context === null) {
    return { ok: false, createScenarioId: null, updateScenarioId: null, blocker: facts.blocker ?? 'DISCOVERY_MISSING' };
  }
  const { apiCreate, formCreate } = screenCreatesOf(facts, facts.context, createDigest);
  // OP-S: 既にある登録の手順は、今の決まりで作り直す（違うときだけ新しい版。承認は、チェックの保存がその版に行う）。
  redraftExistingOf(facts, facts.context, apiCreate, formCreate);
  const created = apiCreate !== undefined ? createOne(facts, apiCreate) : formCreate !== undefined ? createFormOne(facts, formCreate) : null;
  if (created === null) {
    return { ok: false, createScenarioId: null, updateScenarioId: null, blocker: 'SCREEN_NOT_FOUND' };
  }
  if (created.scenarioId === null) {
    return { ok: false, createScenarioId: null, updateScenarioId: null, blocker: 'SCREEN_NOT_DRAFTABLE' };
  }
  const createScenarioId = created.scenarioId;
  // OP-2 の修正の 3 回目: 登録を保存した後の文脈で、その台帳に結ぶ更新（既にあるもの、または規則 F で作れるもの）。中身は共有の部品（`draftUpdateForCreate`。
  // ジョブの管理が点検の書き込みの段の前に使うものと同じ 1 か所）。
  const updateScenarioId = draftUpdateForCreate(updateFactsOf(facts), createScenarioId);
  return { ok: true, createScenarioId, updateScenarioId, blocker: null };
});


/**
 * OP-2（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1.1 の D7'）: サイトの画面の「登録・更新を試せる画面」の一覧のもと（最後の操作さがしの登録の画面ごと。
 * API の形とフォームの形）。書き込みのモードに切り替える前のサイトでも出す（切り替えはチェックの保存が行う）。書き込みを試せないサイト・操作さがしがないサイトは null。
 * - `scenarioId`: その画面の登録のシナリオ（既にあれば）。
 * - `notCheckableReason`: チェックできない理由（今の下書きの理由の鍵。秘密に見える欄・古い操作さがしなど）。
 * - `updatePossible`: 同じ表の更新の画面が操作さがしにある（なければ、チェックしても登録だけ。更新の画面は登録の後の点検で見つかることがある）。
 * - `screenName`（OP-2 の修正の 1 回目、判断 2）: 操作さがしで記録した、その画面の見出し → 題（なければ null。行の名前に使う）。
 * - `mayNotify`（判断 1）: 送る欄にメール・電話の欄がある（行に「メールなどを送ることがある」の 1 行を出す）。OP-F（M-3）: 登録の画面か、分かっている更新の画面
 *   （候補が分かっているときだけ）のどちらかが当たれば真。
 * - `updateFound`（OP-2 の修正の 2 回目、R1）: 同じ表の更新の画面（候補）が操作さがしにある（下書きを作れるかによらない。`updatePossible` が偽で、これが真なら、
 *   更新する欄を決められない）。
 */
export interface AutoDraftScreenView {
  readonly rowKey: string;
  readonly pagePath: string;
  readonly screenName: string | null;
  readonly mayNotify: boolean;
  readonly scenarioId: string | null;
  readonly notCheckableReason: ScenarioDraftRejectionReason | null;
  readonly updatePossible: boolean;
  readonly updateFound: boolean;
  /**
   * OP-T fix round 2（I-2）: 最後の操作さがしで既にある更新の手順（同じ形の計画の `EXISTING`。計画の順）。行が対象にする更新は、このうち登録の台帳に結ぶ最初の
   * もの（チェックの保存の `draftUpdateForCreate` が既にある更新を選ぶ順と同じ）。
   */
  readonly existingUpdateScenarioIds: readonly string[];
}

export const scenarioAutoDraftScreensOf = createServerOnlyFn(async (profileId: string): Promise<readonly AutoDraftScreenView[] | null> => {
  const reading = await readProfileStart(profileId);
  if (reading === null) {
    return null;
  }
  const { stored } = reading;
  if (stored.status !== ACTIVE_PROFILE_STATUS || !usesScenarios(WRITE_AUDIT_MODE, stored.profile.auth)) {
    return null;
  }
  const { latest } = await readDiscoveryDocuments(profileId);
  const context = latest === null ? null : readScenarioDraftContext(localUiStore(), profileId, latest.jobId, null);
  if (latest === null || context === null) {
    return null;
  }
  const candidates = mergedCandidatesOf(latest);
  const facts: AutoDraftFacts = { stored, reading, latest, candidates, context, blocker: null, auditLinkPaths: await auditLinkPathsOf(profileId, latest, reading) };
  const plan = planOf(facts, context);
  const formPlan = formPlanOf(facts, context);
  const formUpdates = formPlan.updates.filter(({ status }) => status === 'NEW' || status === 'EXISTING').map(({ row }) => row.candidate);
  const formUpdateCandidates = formPlan.updates.map(({ row }) => row.candidate);
  const apiUpdatePossible = plan.updates.some(({ status }) => status === 'NEW' || status === 'EXISTING');
  const apiUpdateCandidates = plan.updates.map(({ row }) => row.candidate);
  const existingIdsOf = (updates: readonly { readonly status: string; readonly scenarioId?: string }[]): readonly string[] =>
    updates.flatMap((update) => (update.status === 'EXISTING' && update.scenarioId !== undefined ? [update.scenarioId] : []));
  const apiExistingUpdateIds = existingIdsOf(plan.updates);
  const formExistingUpdateIds = existingIdsOf(formPlan.updates);
  const screenOf = (
    item: AutoDraftCreatePlan | FormAutoDraftCreatePlan,
    updatePossible: boolean,
    updateFound: boolean,
    updateCandidates: readonly DiscoveryCandidate[],
    existingUpdateScenarioIds: readonly string[],
  ): AutoDraftScreenView => ({
    rowKey: item.row.candidate.identityDigest,
    pagePath: item.row.candidate.page.path,
    screenName: discoveryPageScreenNameOf(latest, item.row.candidate.page.path),
    // OP-F（M-3）: 登録の画面か、分かっている更新の画面のどちらかが当たれば出す（判定は 1 か所 `writeScreenMayNotifyOf`）。
    mayNotify: writeScreenMayNotifyOf(item.row.candidate, updateCandidates),
    scenarioId: item.status === 'EXISTING' ? item.scenarioId : null,
    notCheckableReason: item.status === 'REJECTED' ? item.reason : null,
    updatePossible,
    updateFound: updatePossible || updateFound,
    existingUpdateScenarioIds,
  });
  return [
    ...plan.creates.map((item) => screenOf(item, apiUpdatePossible, plan.updates.length > 0, apiUpdateCandidates, apiExistingUpdateIds)),
    ...formPlan.creates.map((item) => screenOf(
      // OP-G（E1）: 同じ表の更新の候補かは、更新の候補から推した型だけで決める（データのないときの推しは、更新があることにしない）。
      item, formRecordIdFromUpdateOf(item.row.candidate, formUpdates) !== null, formRecordIdFromUpdateOf(item.row.candidate, formUpdateCandidates) !== null,
      formUpdateCandidates.filter((candidate) => formRecordIdFromUpdateOf(item.row.candidate, [candidate]) !== null), formExistingUpdateIds,
    )),
  ];
});

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
    const formPlan = formPlanOf(facts, facts.context);
    const creates: AutoDraftCreateResultView[] = [];
    for (const item of plan.creates) {
      creates.push(createOne(facts, item));
    }
    // PL-6b: フォームの形の登録も、同じ口で作る（API の形の後）。
    for (const item of formPlan.creates) {
      creates.push(createFormOne(facts, item));
    }
    // 作る順: 登録を保存した後の文脈で、更新の台帳の結び付けを判定する。
    const context = readScenarioDraftContext(localUiStore(), data.profileId, data.discoveryJobId, null);
    return {
      ok: true,
      creates,
      // OP-2（D10）: 規則 F で変える欄を決めた更新は、登録を保存した後の文脈で、台帳と型を決めて保存する。
      updates: [...plan.updates.map((item) => updateOne(facts, item, context, true)), ...formPlan.updates.map((item) => formUpdateOne(facts, item, true))],
    };
  });
