// T28d（Task 28 の設計書 4.4）: 実行の許可と件数の予約のテストの共通の値と準備（テストのファイルではない）。親のテスト
// （`execution-grant-store.test.ts`、`execution-grant-processes.test.ts`）と、子 process（`execution-grant-child.ts`）が使う。
// - 書き込みのモードのプロファイル、最後の発見のジョブ（登録の候補）、シナリオ（作成 → 入力の規則の参照 → 承認）を、保存の部品の公開の口だけで作る。
// - T29d: 入力の規則の参照は、規則の集まりを保存してから付ける 2 段の手順（`saveRuleSetAndAttach`）で付ける（承認の判定の今の事実が、規則の集まりの
//   最新の版になったため。形だけの参照（`INPUT_RULES`）は、参照を付け直す確かめにだけ使う）。
// - 例の値は匿名の値だけ（`127.0.0.1`、`example.invalid`）。
// - T30d: 実行の許可の発行は、シナリオの検証の指定がそろっていることを求める（`VERIFICATION_SPEC_MISSING`）。プロファイルの準備で照合の READ の定義
//   （`VERIFICATION_READ_CHECK_ID`）を作り、シナリオの下書きに検証の指定（`VERIFICATION_SPEC`）を入れる（選択肢で外せる）。
// - T31e: UPDATE のシナリオの準備（`prepareUpdateScenario`）と、参照する CREATE のシナリオの照合まで済んだ登録を作る手順（`registerVerifiedForTest`。
//   発行 → 消費 → 送る前の記録 → `VERIFIED` の締め）。子 process の動き `update-issue`（予定の ID を読んでから、UPDATE の発行を 1 回争う）。
import { MIN_PROFILE_REVISION } from '../../src/control/contracts.js';
import { saveRuleSetAndAttach } from '../../src/control/data-rules/rule-store.js';
import type { RuleSetContent } from '../../src/control/data-rules/rule-contracts.js';
import {
  approveScenario,
  consumeExecutionGrant,
  createScenario,
  issueExecutionGrant,
  readScenario,
  readScenarioApprovalStatus,
  recordWriteAttempt,
  settleWriteReservation,
  settleWriteResult,
  type ApprovalExternalFacts,
  type ScenarioView,
} from '../../src/control/approval/scenario-store.js';
import type { WriteUpdateEvidence } from '../../src/control/actions/action-contracts.js';
import type { DataSeed } from '../../src/control/data-rules/deterministic-stream.js';
import {
  MIN_WRITE_INTERVAL_MS,
  type InputRuleReference,
  type ScenarioLimits,
  type ScenarioVerification,
} from '../../src/control/approval/scenario-contracts.js';
import { dateOfCompactUtcTimestamp, formatCompactUtcTimestamp } from '../../src/core/utc-timestamp.js';
import { discoveryIndexEntryOf, recordDiscoveryCandidates } from '../../src/control/job/discovery-index-store.js';
import { createReadCheck } from '../../src/control/job/read-check-store.js';
import type { ControlDatabase } from '../../src/control/store/control-database.js';
import { createProfile } from '../../src/control/store/profile-store.js';
import type { DiscoveryCandidate } from '../../src/discovery/candidate-contracts.js';
import {
  DISCOVERY_ARTIFACT_SCHEMA_VERSION,
  discoveryReadPagePaths,
  mergeDiscoveryCandidates,
  type DiscoveryDocument,
} from '../../src/discovery/discovery-result.js';
import { ALL_CONFIRMED, CREATE_CANDIDATE, READ_CANDIDATE, UPDATE_CANDIDATE } from '../unit/approval-samples.js';
import { resolveTestContext, testWriteProfile } from './control-profile-fixtures.js';

export const GRANT_PROFILE_ID = 'example-grant';
export const DISCOVERED_AT = '20261012000000';
export const CREATED_AT = '20261012010000';
export const ATTACHED_AT = '20261012013000';
export const APPROVED_AT = '20261012020000';
export const ISSUED_AT = '20261012030000';
/** 許可の期限（発行から `EXECUTION_GRANT_TTL_MS`）。 */
export const GRANT_EXPIRES_AT = '20261012030500';
export const DISCOVERY_JOB_ID = 'job-grant-d1';

export const EXTERNAL: ApprovalExternalFacts = Object.freeze({
  authSetupDigest: `sha256:${'2'.repeat(64)}`,
  targetConfigDigest: '3'.repeat(64),
});

export const INPUT_RULES: InputRuleReference = Object.freeze({
  ruleSetId: 'rules-1',
  revision: 1,
  digest: `sha256:${'1'.repeat(64)}`,
});

/** 照合の READ の定義の id（T30d。プロファイルの準備で作る）。 */
export const VERIFICATION_READ_CHECK_ID = 'rc-verify';

/** すべての項目を指定した検証の指定（T30d。送る欄 `name` の生成した値で読み直す）。 */
export const VERIFICATION_SPEC: ScenarioVerification = Object.freeze<ScenarioVerification>({
  successCondition: { pathPrefix: '/members/', selector: '.registered' },
  inputErrorCondition: { pathPrefix: '/members/new', selector: '.error' },
  recordId: { source: 'URL_PATH_PATTERN', pathPattern: '/members/{id}' },
  readVerification: {
    readCheckId: VERIFICATION_READ_CHECK_ID,
    revision: 1,
    bindings: [{ parameterName: 'q', fieldName: 'name' }],
    expectations: [{ kind: 'ROW_COUNT_EQUALS', count: 1 }],
  },
});

/** 発見のジョブ 1 回の `discovery.json` の形。 */
export const discoveryDocumentOf = (jobId: string, candidates: readonly DiscoveryCandidate[]): DiscoveryDocument => ({
  schemaVersion: DISCOVERY_ARTIFACT_SCHEMA_VERSION,
  jobId,
  runId: 'RUN-000001',
  startedAt: DISCOVERED_AT,
  finishedAt: DISCOVERED_AT,
  runStatus: 'COMPLETE',
  endReason: 'COMPLETED',
  maxPages: 10,
  pages: [{
    url: 'http://127.0.0.1:4173/members/new',
    state: 'READ',
    record: { location: { origin: 'http://127.0.0.1:4173', path: '/members/new' }, incompleteReasons: [], candidates: [...candidates] },
    blockedRequests: 0,
  }],
  omittedUnreadPages: 0,
});

/** 書き込みのモードのプロファイルと、最後の発見のジョブを作る。最後の発見の文書を返す。 */
export const prepareGrantProfile = (database: ControlDatabase): DiscoveryDocument => {
  const created = createProfile(database, testWriteProfile(GRANT_PROFILE_ID, MIN_PROFILE_REVISION), { resolveContext: resolveTestContext });
  if (!created.ok) {
    throw new Error(`could not create the profile: ${created.reason}`);
  }
  const candidates = [CREATE_CANDIDATE, UPDATE_CANDIDATE];
  const document = discoveryDocumentOf(DISCOVERY_JOB_ID, candidates);
  recordDiscoveryCandidates(database, {
    profileId: GRANT_PROFILE_ID,
    jobId: DISCOVERY_JOB_ID,
    at: DISCOVERED_AT,
    entries: mergeDiscoveryCandidates(candidates).map(discoveryIndexEntryOf),
    readPagePaths: discoveryReadPagePaths(document),
  });
  const readCheck = createReadCheck(database, {
    readCheckId: VERIFICATION_READ_CHECK_ID,
    profileId: GRANT_PROFILE_ID,
    definition: { targetIdentityDigest: READ_CANDIDATE.identityDigest, parameters: { q: 'x' }, expectations: [{ kind: 'ROW_COUNT_EQUALS', count: 1 }] },
    at: DISCOVERED_AT,
  });
  if (!readCheck.ok) {
    throw new Error(`could not create the READ check: ${readCheck.reason}`);
  }
  return document;
};

/** シナリオの準備の選択肢。 */
export interface ScenarioPreparation {
  readonly limits?: ScenarioLimits;
  /** 入力の規則の参照を付けるか（既定は付ける）。 */
  readonly attach?: boolean;
  /** 承認するか（既定は承認する）。 */
  readonly approve?: boolean;
  readonly receiptId?: string;
  /** 保存する入力の規則の中身（既定は、人の規則なし。テンプレートと汎用の規則だけで決まる）。 */
  readonly ruleContent?: RuleSetContent;
  /** 検証の指定（T30d。既定は `VERIFICATION_SPEC`。null なら下書きに入れない（すべて未指定））。 */
  readonly verification?: ScenarioVerification | null;
  /** T31e: UPDATE のシナリオにする（参照する CREATE のシナリオの id。省略すると CREATE のシナリオ）。 */
  readonly updateOf?: string;
}

/** T31e: UPDATE のシナリオの path の型（`UPDATE_CANDIDATE` の画面 `/members/1/edit` と送信先 `/members/1` に戻る型）。 */
export const UPDATE_FORM_PATH_TEMPLATE = '/members/{id}/edit';
export const UPDATE_ACTION_PATH_TEMPLATE = '/members/{id}';

/** 人の規則のない、入力の規則の中身。 */
export const EMPTY_RULE_CONTENT: RuleSetContent = Object.freeze({ fieldRules: [], relations: [], uniqueKeyFieldNames: [] });

/** シナリオの規則の集まりの id（シナリオごとに 1 つ）。 */
export const ruleSetIdOf = (scenarioId: string): string => `rules-${scenarioId}`;

/** 作らなかった・付けられなかった・承認できなかったときの誤り。 */
const failed = (step: string, reason: string): Error => new Error(`could not ${step} the scenario: ${reason}`);

/** シナリオを作り、入力の規則の参照を付け、承認する（選択肢で途中まで）。今のシナリオを返す。 */
export const prepareScenario = (
  database: ControlDatabase,
  latest: DiscoveryDocument,
  scenarioId: string,
  options: ScenarioPreparation = {},
): ScenarioView => {
  const created = createScenario(database, {
    scenarioId,
    draft: {
      profileId: GRANT_PROFILE_ID,
      // T31e: UPDATE のシナリオは、更新の候補（`name` を変える欄にし、保つ欄はない）と UPDATE の指定。
      ...(options.updateOf === undefined
        ? {
          candidateIdentityDigest: CREATE_CANDIDATE.identityDigest,
          // T30f fix round 1（DEF-098）: CREATE の候補の見えていて編集できる select（`plan`）も送る欄にする。
          fieldNames: ['name', 'plan'],
        }
        : {
          candidateIdentityDigest: UPDATE_CANDIDATE.identityDigest,
          fieldNames: ['name'],
          update: {
            targetCreateScenarioId: options.updateOf,
            formPathTemplate: UPDATE_FORM_PATH_TEMPLATE,
            actionPathTemplate: UPDATE_ACTION_PATH_TEMPLATE,
            keepFieldNames: [],
          },
        }),
      readChecks: [],
      sideEffectConfirmations: ALL_CONFIRMED,
      limits: options.limits ?? { maxCreatesPerRun: 1, maxCumulativeCreates: 20 },
      approvalTtlDays: 30,
      ...(options.verification === null ? {} : { verification: options.verification ?? VERIFICATION_SPEC }),
    },
    discovery: latest,
    at: CREATED_AT,
  });
  if (!created.ok) {
    throw failed('create', created.reason);
  }
  let scenario = created.scenario;
  if (options.attach !== false) {
    const saved = saveRuleSetAndAttach(database, {
      ruleSetId: ruleSetIdOf(scenarioId),
      scenarioId,
      expectedRevision: null,
      content: options.ruleContent ?? EMPTY_RULE_CONTENT,
      expectedScenarioRevision: scenario.revision,
      at: ATTACHED_AT,
    });
    if (!saved.ruleSet.ok) {
      throw failed('save the input rules of', saved.ruleSet.reason);
    }
    if (saved.attachment === null || !saved.attachment.ok) {
      throw failed('attach the input rules to', saved.attachment?.ok === false ? saved.attachment.reason : 'missing');
    }
    scenario = saved.attachment.scenario;
  }
  if (options.approve !== false) {
    const status = readScenarioApprovalStatus(database, scenarioId, EXTERNAL, new Date(Date.parse('2026-10-12T02:00:00Z')));
    if (status === null) {
      throw failed('read', 'missing');
    }
    const approved = approveScenario(database, {
      scenarioId,
      expectedRevision: scenario.revision,
      expectedApprovalDigest: status.approvalDigest,
      receiptId: options.receiptId ?? `receipt-${scenarioId}`,
      external: EXTERNAL,
      at: APPROVED_AT,
    });
    if (!approved.ok) {
      throw failed('approve', approved.reason);
    }
    scenario = approved.scenario;
  }
  return scenario;
};

/** T31e: UPDATE のシナリオを作り、入力の規則の参照を付け、承認する（`prepareScenario` の UPDATE の形）。 */
export const prepareUpdateScenario = (
  database: ControlDatabase,
  latest: DiscoveryDocument,
  scenarioId: string,
  targetCreateScenarioId: string,
  options: Omit<ScenarioPreparation, 'updateOf'> = {},
): ScenarioView => prepareScenario(database, latest, scenarioId, { ...options, updateOf: targetCreateScenarioId });

/** T31e: 照合まで済んだ登録を作る入力（テストだけ）。 */
export interface TestVerifiedRegistration {
  readonly createScenarioId: string;
  readonly grantId: string;
  readonly jobId: string;
  readonly recordId: string;
  /** 発行・消費・記録・送信・締めの時刻（連続の上限のため、登録ごとに `writeSlotAt` でずらす）。 */
  readonly at: string;
  /** 送った値（既定は `name` だけ）。 */
  readonly submittedValues?: Readonly<Record<string, string>>;
}

/** テストだけの seed の記録。 */
const testSeedRecordOf = (grantId: string) => ({
  seed: 'a'.repeat(64) as DataSeed,
  seedInput: { profileId: GRANT_PROFILE_ID, scenarioId: 'scenario-test', scenarioRevision: 1, ruleSetDigest: `sha256:${'b'.repeat(64)}`,
    executionGrantId: grantId },
  baseDate: '2026-10-12',
  attempt: 0,
});

/**
 * T31e: CREATE のシナリオの照合まで済んだ登録を 1 件作る（テストだけ。発行 → 消費 → 送る前の記録 → `VERIFIED` の締め）。作れたかを返す。UPDATE の
 * 対象にできるレコードになる。
 */
export const registerVerifiedForTest = (database: ControlDatabase, input: TestVerifiedRegistration): boolean => {
  const issued = issueExecutionGrant(database, {
    scenarioId: input.createScenarioId, expectedRevision: readScenario(database, input.createScenarioId)?.revision ?? 0, grantId: input.grantId,
    jobId: input.jobId, count: 1, external: EXTERNAL, at: input.at,
  });
  if (!issued.ok) {
    return false;
  }
  const consumed = consumeExecutionGrant(database, {
    grantId: input.grantId, scenarioId: input.createScenarioId, scenarioRevision: issued.grant.scenarioRevision, jobId: input.jobId,
    profileId: GRANT_PROFILE_ID, external: EXTERNAL, at: input.at,
  });
  if (!consumed.ok) {
    return false;
  }
  const recorded = recordWriteAttempt(database, {
    jobId: input.jobId, grantId: input.grantId, seedRecord: testSeedRecordOf(input.grantId),
    submittedValues: input.submittedValues ?? { name: `サンプル ${input.recordId}` }, uniqueKey: null, phoneNumbers: [], at: input.at,
  });
  return recorded.ok && settleWriteResult(database, {
    jobId: input.jobId, submission: 'SENT', blockReason: null, httpStatus: TEST_HTTP_STATUS, responseJudgement: 'SUCCESS',
    recordId: input.recordId, readVerification: 'MATCHED', submittedAt: input.at, at: input.at,
  }).ok;
};

/** T31e: UPDATE の書き込みの記録と締めの入力（テストだけ。消費した UPDATE の許可）。 */
export interface TestUpdateWrite {
  readonly grantId: string;
  readonly jobId: string;
  readonly submittedValues: Readonly<Record<string, string>>;
  readonly at: string;
  /** 締めの報告（既定は、照合まで済んだ `VERIFIED`）。 */
  readonly outcome: 'VERIFIED' | 'UNKNOWN';
  readonly recordId: string | null;
  readonly updateEvidence: WriteUpdateEvidence | null;
}

/** T31e: UPDATE の許可の送る前の記録と締め（テストだけ）。締めの結果をそのまま返す。 */
export const recordUpdateWriteForTest = (database: ControlDatabase, input: TestUpdateWrite) => {
  const recorded = recordWriteAttempt(database, {
    jobId: input.jobId, grantId: input.grantId, seedRecord: testSeedRecordOf(input.grantId), submittedValues: input.submittedValues, uniqueKey: null,
    phoneNumbers: [], at: input.at,
  });
  if (!recorded.ok) {
    return recorded;
  }
  const verified = input.outcome === 'VERIFIED';
  return settleWriteResult(database, {
    jobId: input.jobId, submission: verified ? 'SENT' : 'UNKNOWN', blockReason: null, httpStatus: verified ? TEST_HTTP_STATUS : null,
    responseJudgement: verified ? 'SUCCESS' : null, recordId: verified ? input.recordId : null, readVerification: verified ? 'MATCHED' : null,
    submittedAt: verified ? input.at : null, updateEvidence: input.updateEvidence, at: input.at,
  });
};

/** 子 process との決まり（標準入出力の 1 行ずつ）。 */
export const GRANT_CHILD_PROTOCOL = Object.freeze({
  /** 子の動き: 発行・消費・送った記録をくり返す／発行だけをくり返す／撤回する。 */
  writeLoopMode: 'write-loop',
  issueLoopMode: 'issue-loop',
  revokeMode: 'revoke',
  /** T31e: UPDATE の予定の ID を読んでから、UPDATE の発行を 1 回だけ争う（結果の数えに、結んだ対象の ID を `TARGET:<ID>` で足す）。 */
  updateIssueMode: 'update-issue',
  /** 子 → 親: 開いて準備ができた。 */
  ready: 'READY',
  /**
   * 親 → 子: 始める。write-loop では回ごとに送る（DEF-097 fix: 2 つの子の回をそろえる。親は、両方の子の回の終わり（`ROUND`）を受けてから
   * 次の `GO` を送る）。ほかの動きは 1 回だけ。
   */
  go: 'GO',
  /** 子 → 親: write-loop の 1 回が終わった（`ROUND <回>`）。 */
  round: 'ROUND',
  /** 子 → 親: 終わった（`DONE <JSON>`）。 */
  done: 'DONE',
});

/** 子 process がくり返す回数。 */
export const GRANT_CHILD_ROUNDS = 12;

/**
 * T30d: 書き込みをくり返すテストの 1 回の時刻の幅（発行の時刻を、回ごとにこの幅だけ進める）。同じシナリオの連続の書き込みの間隔
 * （`MIN_WRITE_INTERVAL_MS`）の 2 倍にして、回の中で発行から 5 分未満で締めても、次の回の発行が間隔を守るようにする。
 */
export const WRITE_SLOT_MS = 2 * MIN_WRITE_INTERVAL_MS;

/** テストだけの締めの入力（消費した許可と、その予約）。 */
export interface TestWriteSettlement {
  readonly grantId: string;
  readonly jobId: string;
  readonly reservationId: number;
  readonly to: 'COMMITTED' | 'UNKNOWN' | 'RELEASED';
  readonly at: string;
}

/**
 * T30e（T30d の発見事項 2 の判断）: 予約を締める（テストだけ）。送った・分からない（`COMMITTED`・`UNKNOWN`）は、書き込みの結果の記録を伴う口だけが
 * 締めるので、送る前の記録（値なし）を書いてから `settleWriteResult` で締める（`COMMITTED` は応答のある送信、`UNKNOWN` は送ったか分からない）。
 * `RELEASED` は `settleWriteReservation`。締められたかを返す。
 */
export const settleWriteForTest = (database: ControlDatabase, input: TestWriteSettlement): boolean => {
  if (input.to === 'RELEASED') {
    return settleWriteReservation(database, { reservationId: input.reservationId, to: 'RELEASED', at: input.at }).ok;
  }
  const recorded = recordWriteAttempt(database, {
    jobId: input.jobId,
    grantId: input.grantId,
    seedRecord: testSeedRecordOf(input.grantId),
    submittedValues: {},
    uniqueKey: null,
    phoneNumbers: [],
    at: input.at,
  });
  if (!recorded.ok) {
    return false;
  }
  const sent = input.to === 'COMMITTED';
  return settleWriteResult(database, {
    jobId: input.jobId,
    submission: sent ? 'SENT' : 'UNKNOWN',
    blockReason: null,
    httpStatus: sent ? TEST_HTTP_STATUS : null,
    responseJudgement: sent ? 'INPUT_ERROR' : null,
    recordId: null,
    readVerification: null,
    submittedAt: null,
    at: input.at,
  }).ok;
};

/** テストだけの締めの応答の HTTP の状態。 */
const TEST_HTTP_STATUS = 200;

/** `index` 回目（0 から）の書き込みの時刻（`ISSUED_AT` から `WRITE_SLOT_MS` ずつ進める。UTC の 14 桁）。 */
export const writeSlotAt = (index: number, offsetMs = 0): string =>
  formatCompactUtcTimestamp(new Date(dateOfCompactUtcTimestamp(ISSUED_AT).getTime() + index * WRITE_SLOT_MS + offsetMs), 'write slot time');
