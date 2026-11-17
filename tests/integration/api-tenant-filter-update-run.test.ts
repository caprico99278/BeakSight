// TEST-SLIM W3: 別の編集の画面（一覧の 1 つ下の `/admin/members/<番号>`。一覧の「編集」はスクリプトで移り、一覧に編集の画面へのリンクはない）の保存から、
// 今の形 C の流れ（本番の自動の下書き `draftUpdateForCreate`・台帳・書き込みの段）で、登録 → 同じ点検で登録した行の更新が、書き込み 1 件ずつで `VERIFIED`
// になることと、崩した送り方はどれもサーバに届かないことを、fixture の 3 つの形（前は 3 つのファイル）の `describe.each` で確かめる
// （設計書 `doc/design/2026-11-02-beaksight-list-row-update-design.md`）。
// - DEF-190（5.8 の 3）: `memberListEditMovesAway` だけ。登録の候補と更新の候補が混ざらず、下書き・台帳が画面の path（型）で分かれる。承認した登録と更新の
//   ほかの読み取りでない要求は届かない。
// - DEF-198（5.9）: `memberTenantFilter` も。保存が番号の絞り込みのほかに所属の絞り込みを持ち（本文にも番号の鍵 `id` と所属の鍵）、登録の本文にもページが
//   所属の鍵を入れる。所属の鍵の名前（`account_id`）は番号の鍵 `id` より前に並ぶ（並び順で番号の絞り込みを選ばない）。崩した絞り込み・本文は届かない。
// - DEF-203（5.10）: `memberTenantExtraKeys` も。登録と更新の本文に、欄と結びつかない鍵（文字・真偽・null）をページが入れる。その鍵の値を変えた・鍵を足した
//   保存は届かない。
// - 発見は本物の流れ（`executeDiscoveryRun`）。登録のシナリオは今の補助（`createApiCreateScenario`。照合の READ は一覧の画面）。
// - 照らす値は、テストで直接入れない。登録の書き込みの成果物（`action-run.json` の `api.pageKeyValues`。親が締めで読む文書と同じ）から、本番の部品
//   （`apiOtherFilterValuesOf`・`apiLedgerKeyValuesOf`。`writeStartSpecOf` と同じ部品）で取る。
// - サーバの記録で数える: 登録の POST 1 件、更新の PATCH は正しい更新の 1 件だけ、DELETE 0 件。各場面の後と、全部の場面の後に名前つきの時間だけ待って数え直す。
// - Chromium はテストの既定だけ（承認の外の送信が届かないことは、Guard の結合 `guard-api-write-stage.test.ts` が 2 つの Chromium で確かめる）。出力先は一時のフォルダだけ。
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ActionRunDocument } from '../../src/control/actions/action-contracts.js';
import { readScenario, readScenarioRevisions } from '../../src/control/approval/scenario-store.js';
import { draftUpdateForCreate } from '../../src/control/approval/update-autodraft.js';
import { planRuleSet } from '../../src/control/data-rules/field-evaluation.js';
import { readLatestRuleSet } from '../../src/control/data-rules/rule-store.js';
import { uniqueEachRunFieldNamesOf } from '../../src/control/data-rules/varying-values.js';
import { listReadChecks } from '../../src/control/job/read-check-store.js';
import { apiLedgerKeyValuesOf, apiOtherFilterValuesOf, writeStartSpecOf } from '../../src/control/job/write-job-start.js';
import { closeControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import { isWorkerStartApiWrite, type WorkerStartApiWrite } from '../../src/control/worker-protocol.js';
import { formatCompactUtcTimestamp } from '../../src/core/utc-timestamp.js';
import { discoveryCandidatesOf, mergeDiscoveryCandidates, type DiscoveryDocument } from '../../src/discovery/discovery-result.js';
import { executeDiscoveryRun } from '../../src/worker/discovery-run.js';
import { sampleApprovalFacts } from '../helpers/approval-facts-sample.js';
import {
  createApiCreateScenario,
  openSpaWriteProfile,
  runSpaApiWrite,
  SPA_WRITE_LATE_DELIVERY_SETTLE_MS,
  spaApiWriteConfigOf,
  spaMemberRequestCountOf,
  spaRunAuthenticationOf,
} from '../helpers/api-write-scenario.js';
import { launchHeadlessChromium, useSharedRunBrowser } from '../helpers/chromium.js';
import { READ_METHODS } from '../helpers/leak-places.js';
import { settleLateDeliveries } from '../helpers/loopback-server.js';
import { probeQuietWindowsOf } from '../helpers/test-waits.js';
import {
  SPA_APP_PATHS,
  SPA_BACKEND_PATHS,
  SPA_MEMBER_EXTRA_KEY_SAVE_MODES,
  SPA_MEMBER_EXTRA_KEY_VALUES,
  SPA_MEMBER_LIST_PATH,
  SPA_MEMBER_TENANT_KEY,
  SPA_MEMBER_TENANT_SAVE_MODES,
  SPA_MEMBER_TENANT_VALUE,
  startSpaAuthSite,
  type SpaAuthSite,
  type SpaAuthSiteOptions,
  type SpaMemberTenantSaveMode,
} from '../helpers/spa-auth-site-fixture.js';

const SUITE_TIMEOUT_MS = 300_000;
const TEST_TIMEOUT_MS = 600_000;
/** 押した後に静まるまで待つ時間（ms。発見のテストの値）。 */
const SHORT_QUIET_WAIT_MS = 500;
const SHA256_HEX_LENGTH = 64;
/** 編集の画面（一覧の 1 つ下、最後が番号）の path の形と、その型。 */
const EDIT_PAGE_PATH = /^\/admin\/members\/[0-9]+$/u;
const EDIT_PAGE_TEMPLATE = `${SPA_MEMBER_LIST_PATH}/{id}`;
/** DEF-203: 欄と結びつかない鍵の名前（名前の順）。 */
const EXTRA_KEYS = Object.keys(SPA_MEMBER_EXTRA_KEY_VALUES).sort();
const nowText = (): string => formatCompactUtcTimestamp(new Date(), 'test time');

/** 1 つの形の準備の結果（自動の下書きの確かめに渡す）。 */
interface Prepared {
  readonly database: ControlDatabase;
  readonly document: DiscoveryDocument;
  readonly createScenarioId: string;
  readonly updateScenarioId: string | null;
}

/** 画面の保存（probe の結果を持つ、保存の語のボタン。`match` は画面の path）。 */
const savesOf = (document: DiscoveryDocument, match: (path: string) => boolean) => mergeDiscoveryCandidates(discoveryCandidatesOf(document))
  .filter((candidate) => match(candidate.page.path) && candidate.kind === 'BUTTON' && candidate.submitterWords.includes('保存') && candidate.submissionProbe !== undefined);

/** fixture の形ごとの、サイトの指定・登録の成果物に残る値・崩した送り方・自動の下書きの確かめ。 */
interface UpdateShape {
  readonly siteOptions: SpaAuthSiteOptions;
  /** 登録の応答に印の表現を返し、ページが入れた鍵の値を登録の成果物に残す形か（null は確かめない）。 */
  readonly pageKeyValues: Readonly<Record<string, string>> | null;
  readonly brokenSaveModes: readonly SpaMemberTenantSaveMode[];
  /** 承認した登録と更新のほかの読み取りでない要求が届かないことを、サーバの記録の全体で確かめるか。 */
  readonly onlyApprovedWritesReach: boolean;
  readonly expectDraft: (prepared: Prepared) => void;
}

const UPDATE_SHAPES: readonly (readonly [string, UpdateShape])[] = [
  ['DEF-190: the edit page that the list moves to', {
    siteOptions: { memberListEditMovesAway: true },
    pageKeyValues: null,
    brokenSaveModes: [],
    onlyApprovedWritesReach: true,
    // 登録のシナリオは登録の画面の候補、更新のシナリオは編集の画面の候補（同じ保存のボタンでも混ざらない）。台帳は登録のシナリオで、編集の画面の型。
    expectDraft: ({ database, document, createScenarioId, updateScenarioId }) => {
      const createSaves = savesOf(document, (path) => path === SPA_APP_PATHS.memberNew);
      const editSaves = savesOf(document, (path) => EDIT_PAGE_PATH.test(path));
      expect(createSaves.map((candidate) => candidate.submissionProbe?.result)).toEqual(['API_CREATE']);
      expect(editSaves.map((candidate) => candidate.submissionProbe?.result)).toEqual(['API_UPDATE']);
      const create = readScenario(database, createScenarioId);
      const update = readScenario(database, updateScenarioId ?? '');
      expect(create?.current).toMatchObject({ kind: 'CREATE', candidate: { identityDigest: createSaves[0]?.identityDigest } });
      expect(create?.evidence.page.path).toBe(SPA_APP_PATHS.memberNew);
      expect(update?.current).toMatchObject({
        kind: 'UPDATE', candidate: { identityDigest: editSaves[0]?.identityDigest },
        api: { ledger: { targetCreateScenarioId: createScenarioId, formPathTemplate: EDIT_PAGE_TEMPLATE } },
      });
      expect(EDIT_PAGE_PATH.test(update?.evidence.page.path ?? '')).toBe(true);
      expect(update?.current.api?.shapeDigest).not.toBe(create?.current.api?.shapeDigest);
    },
  }],
  ['DEF-198: the edit page with a tenant filter', {
    siteOptions: { memberListEditMovesAway: true, memberTenantFilter: true },
    pageKeyValues: { [SPA_MEMBER_TENANT_KEY]: String(SPA_MEMBER_TENANT_VALUE) },
    // SLIM W-3: 崩した保存は種類ごとの代表（絞り込みの値・絞り込みの演算子・本文）。照合の形は単体（`api-write-payload-policy-update`）が確かめる。
    brokenSaveModes: SPA_MEMBER_TENANT_SAVE_MODES.filter((mode) => ['otherTenant', 'orExtra', 'bodyOtherTenant'].includes(mode)),
    onlyApprovedWritesReach: false,
    // 型の filter の 1 つ目は所属（所属の鍵の名前は番号の鍵より前に並ぶ）。下書きはページの値で番号の filter を選ぶ。本文の番号と所属の鍵は、欄の識別なしの
    // ページが決める鍵として受ける。
    expectDraft: ({ database, document, createScenarioId, updateScenarioId }) => {
      const editSaves = savesOf(document, (path) => EDIT_PAGE_PATH.test(path));
      expect(editSaves.map((candidate) => candidate.submissionProbe?.shape?.filters.map(({ name }) => name))).toEqual([[SPA_MEMBER_TENANT_KEY, 'id']]);
      expect(editSaves.map((candidate) => [candidate.submissionProbe?.result, candidate.submissionProbe?.reason ?? null])).toEqual([['API_UPDATE', null]]);
      const update = readScenario(database, updateScenarioId ?? '')?.current;
      expect(update?.api).toMatchObject({ filterName: 'id', otherFilterNames: [SPA_MEMBER_TENANT_KEY], ledger: { targetCreateScenarioId: createScenarioId } });
      expect(update?.api?.pageKeys.map(({ key }) => key)).toEqual([SPA_MEMBER_TENANT_KEY, 'id']);
    },
  }],
  ['DEF-203: the edit page with keys not bound to a field', {
    siteOptions: { memberListEditMovesAway: true, memberTenantFilter: true, memberTenantExtraKeys: true },
    pageKeyValues: {
      [SPA_MEMBER_TENANT_KEY]: String(SPA_MEMBER_TENANT_VALUE),
      ...Object.fromEntries(Object.entries(SPA_MEMBER_EXTRA_KEY_VALUES).map(([key, value]) => [key, JSON.stringify(value)])),
    },
    // SLIM W-3: 崩した保存は代表（値を変える・鍵を足す）。
    brokenSaveModes: SPA_MEMBER_EXTRA_KEY_SAVE_MODES.filter((mode) => ['extraFlippedBoolean', 'extraAddedKey'].includes(mode)),
    onlyApprovedWritesReach: false,
    // 本文の番号・所属の鍵と、欄と結びつかない鍵は、欄の識別なしのページが決める鍵として受け、欄と結びつかない鍵は登録の値と照らす鍵にする。
    expectDraft: ({ database, createScenarioId, updateScenarioId }) => {
      const update = readScenario(database, updateScenarioId ?? '')?.current;
      expect(update?.api).toMatchObject({
        filterName: 'id', otherFilterNames: [SPA_MEMBER_TENANT_KEY], ledgerPageKeys: EXTRA_KEYS, ledger: { targetCreateScenarioId: createScenarioId },
      });
      expect(update?.api?.pageKeys.map(({ key }) => key)).toEqual([SPA_MEMBER_TENANT_KEY, 'id', ...EXTRA_KEYS]);
      expect(update?.api?.pageKeys.every(({ field }) => field === undefined)).toBe(true);
    },
  }],
];

/** 1 つの形の準備の結果と、登録・更新の書き込みの開始の指定（`index` は値を変える番号）。 */
interface ShapeRun extends Prepared {
  readonly createFor: (index: number) => WorkerStartApiWrite;
  readonly updateFor: (index: number, targetRecordId: string, created: ActionRunDocument) => WorkerStartApiWrite;
}

/**
 * 1 つの形の、プロファイル（手渡しのセッション。承認したサービスの Origin はバックエンド）・発見・登録のシナリオ（今の補助）・更新のシナリオ（本番の自動の
 * 下書き）を作る。登録の開始の指定は本番の部品（`writeStartSpecOf`）、更新の開始の指定は `api-write-update-run.test.ts` と同じ組み立て。
 */
const prepareShape = async (id: string, site: SpaAuthSite, directory: string): Promise<ShapeRun> => {
  const PROFILE_ID = `example-${id}`;
  const CREATE_SCENARIO_ID = `scenario-api-create-${id}`;
  const READ_CHECK_ID = `rc-api-${id}`;
  const GRANT_ID = `grant-${id}`;
  const valuesFor = (keys: readonly string[], index: number): Record<string, string> =>
    Object.fromEntries(keys.map((key) => [key, key === 'email' ? `${id}-${String(index)}@example.invalid` : `${id.toUpperCase()} ${key} ${String(index)}`]));
  site.addMember(`${id.toUpperCase()} 既存の会員`, { email: `${id}-existing@example.invalid` });
  const database = await openSpaWriteProfile(site, directory, PROFILE_ID, [site.backendOrigin]);
  const base = spaApiWriteConfigOf(site, join(directory, 'discovery'), { crawl: { maxPages: 2 }, audit: { sendPolicy: 'PASS_EXCEPT_DELETE' } });
  const discovered = await executeDiscoveryRun({
    config: { ...base, site: { ...base.site, startUrl: `${site.appOrigin}${SPA_MEMBER_LIST_PATH}` } },
    jobId: `job-discovery-${id}`,
    authentication: spaRunAuthenticationOf(site),
    launchBrowser: () => launchHeadlessChromium(),
    clock: () => new Date(), now: () => Date.now(), stopSignal: new AbortController().signal, observationWindows: probeQuietWindowsOf(SHORT_QUIET_WAIT_MS),
  }, { onRunStarted: () => undefined, onSessionLost: () => undefined });
  if (discovered.kind !== 'RAN') throw new Error(`the discovery did not run: ${discovered.kind}`);
  const document = JSON.parse(readFileSync(join(discovered.runDirectory, 'discovery.json'), 'utf8')) as DiscoveryDocument;
  const created = createApiCreateScenario(database, {
    profileId: PROFILE_ID, scenarioId: CREATE_SCENARIO_ID, readCheckId: READ_CHECK_ID, site, document, limits: { maxCreatesPerRun: 1, maxCumulativeCreates: 20 },
    at: nowText, readTargetPagePath: SPA_MEMBER_LIST_PATH,
  });
  const updateScenarioId = draftUpdateForCreate({ database, profileId: PROFILE_ID, discovery: document, clock: () => nowText() }, CREATE_SCENARIO_ID);
  const createRevision = readScenarioRevisions(database, CREATE_SCENARIO_ID).find(({ revision }) => revision === created.scenario.revision);
  const readCheck = listReadChecks(database, PROFILE_ID).find(({ readCheckId }) => readCheckId === READ_CHECK_ID);
  const rules = readLatestRuleSet(database, CREATE_SCENARIO_ID);
  if (createRevision === undefined || readCheck === undefined || rules === null) {
    throw new Error('the scenario, the rules or the READ check are missing');
  }
  const uniqueFieldNames = uniqueEachRunFieldNamesOf(planRuleSet(rules.ruleSet, createRevision.scenario, createRevision.evidence));
  const seedRecord = {
    seed: 'e'.repeat(SHA256_HEX_LENGTH) as never,
    seedInput: { profileId: PROFILE_ID, scenarioId: CREATE_SCENARIO_ID, scenarioRevision: createRevision.revision, ruleSetDigest: `sha256:${'f'.repeat(SHA256_HEX_LENGTH)}`,
      executionGrantId: GRANT_ID },
    baseDate: '2026-11-04',
    attempt: 0,
  };
  const createFor = (index: number): WorkerStartApiWrite => {
    const spec = writeStartSpecOf({
      uniqueEachRunFieldNames: uniqueFieldNames,
      scenario: createRevision.scenario, evidence: createRevision.evidence, grantId: GRANT_ID, values: valuesFor(createRevision.scenario.fieldNames, index), readCheck,
      targetPage: { origin: site.appOrigin, path: SPA_MEMBER_LIST_PATH }, profileId: PROFILE_ID, seedRecord,
      approvalFacts: sampleApprovalFacts({ kind: 'CREATE', profileId: PROFILE_ID, scenarioId: CREATE_SCENARIO_ID, scenarioRevision: createRevision.revision, grantId: GRANT_ID }),
    });
    if (spec === null || !isWorkerStartApiWrite(spec)) throw new Error('the API create specification was not built');
    return spec;
  };
  const update = updateScenarioId === null ? undefined : readScenario(database, updateScenarioId)?.current;
  const updateFor = (index: number, targetRecordId: string, createdRun: ActionRunDocument): WorkerStartApiWrite => {
    const updateApi = update?.api;
    if (update === undefined || updateApi === undefined || updateScenarioId === null) throw new Error('the update scenario was not drafted');
    const scenarioId = updateScenarioId;
    const baseWrite = createFor(index);
    const changed = valuesFor(update.fieldNames, index + 1000);
    const member = site.memberOf(Number(targetRecordId));
    const kept = (updateApi.keptKeys ?? []).map(({ key }) => ({ key, value: String((member as Record<string, unknown> | undefined)?.[key] ?? '') }));
    const [firstChanged] = Object.values(changed);
    // 照らす値（所属・欄と結びつかない鍵）は、登録の成果物のページが決めた値から、本番の部品で取る（テストで直接入れない。照らす鍵のない形は空）。
    const otherFilterValues = apiOtherFilterValuesOf(updateApi, createdRun.api?.pageKeyValues ?? null);
    const ledgerKeyValues = apiLedgerKeyValuesOf(updateApi, createdRun.api?.pageKeyValues ?? null);
    if (otherFilterValues === null || ledgerKeyValues === null) throw new Error('the values to compare were not taken from the create');
    return {
      ...baseWrite,
      scenarioId,
      scenarioRevision: update.revision,
      formPage: { origin: site.appOrigin, path: `${SPA_MEMBER_LIST_PATH}/${targetRecordId}` },
      candidate: { identityDigest: update.candidate.identityDigest, ruleDigest: update.candidate.ruleDigest },
      submitterIdentityDigest: update.candidate.identityDigest,
      api: updateApi,
      values: changed,
      verification: { resultJudgement: null, recordId: null },
      readVerification: {
        ...baseWrite.readVerification,
        definition: { ...baseWrite.readVerification.definition, expectations: [{ kind: 'TEXT_CONTAINS', text: firstChanged ?? '' }] },
      },
      approvalFacts: sampleApprovalFacts({ kind: 'UPDATE', profileId: PROFILE_ID, scenarioId, scenarioRevision: update.revision, grantId: GRANT_ID }),
      update: {
        targetRecordId, knownKeptValues: kept, ...(otherFilterValues.length === 0 ? {} : { otherFilterValues }),
        ...(ledgerKeyValues.length === 0 ? {} : { ledgerKeyValues }),
      },
    } as WorkerStartApiWrite;
  };
  return { database, document, createScenarioId: CREATE_SCENARIO_ID, updateScenarioId, createFor, updateFor };
};

describe.each(UPDATE_SHAPES)('%s: create and then update the created row through the edit page', (name, shape) => {
  const id = name.slice(0, name.indexOf(':')).toLowerCase();
  // SLIM-2（X7）: 書き込みの流れごとに Chromium を起こさず、1 つの Browser を共有する（Context は流れごと）。
  const launch = useSharedRunBrowser(() => launchHeadlessChromium());
  let site: SpaAuthSite | undefined;
  let directory = '';
  let run: ShapeRun | undefined;
  let caseNumber = 0;
  /** 発見の後（書き込みの前）の、サーバの記録の数（ここから後に届いた要求を数える）。 */
  let since = 0;

  /** 書き込みの後にサーバ（バックエンド）に届いた会員の API への `method` の要求の数。 */
  const backendRequests = (method: string): number => (site === undefined ? 0 : spaMemberRequestCountOf(site, method, since, 'backend'));
  /** 読み取りでない要求（一覧の手続きの呼び出し（読み取りの手続き。送信の扱いで通す）と事前確認のほか）。 */
  const otherNonReads = (): readonly string[] => (site?.requests ?? []).slice(since)
    .filter((request) => !request.preflight && !READ_METHODS.has(request.method) && !request.path.startsWith(SPA_BACKEND_PATHS.rpcListMembers))
    .map((request) => `${request.method} ${request.path.split('?')[0] ?? ''}`);

  beforeAll(async () => {
    site = await startSpaAuthSite(shape.siteOptions);
    directory = await mkdtemp(join(tmpdir(), `beaksight-${id}-update-`));
    run = await prepareShape(id, site, directory);
    since = site.requests.length;
  }, SUITE_TIMEOUT_MS);

  afterAll(async () => {
    if (site !== undefined) {
      // 遅れて届く要求を待って数え直す: 登録の POST 1 件、正しい更新の PATCH 1 件だけ、DELETE 0 件。SLIM-2（X1）: 流れの Context は閉じた後なので、
      // 待ちはサーバが静まるまで。
      await settleLateDeliveries(SPA_WRITE_LATE_DELIVERY_SETTLE_MS, site);
      expect([backendRequests('POST'), backendRequests('PATCH'), backendRequests('DELETE')]).toEqual([1, 1, 0]);
      if (shape.onlyApprovedWritesReach) expect(otherNonReads()).toHaveLength(2);
    }
    if (run !== undefined) closeControlDatabase(run.database);
    await site?.close();
    if (directory !== '') await rm(directory, { recursive: true, force: true });
  }, SUITE_TIMEOUT_MS);

  const prepared = (): { readonly site: SpaAuthSite; readonly run: ShapeRun } => {
    if (site === undefined || run === undefined) throw new Error('not prepared');
    return { site, run };
  };
  const runWrite = async (write: WorkerStartApiWrite): Promise<ActionRunDocument> => {
    caseNumber += 1;
    const { document: written } = await runSpaApiWrite({
      site: prepared().site, outputDirectory: join(directory, `output-${String(caseNumber)}`), jobId: `job-${id}-${String(caseNumber)}`, write,
      launchBrowser: launch, sendPolicy: 'PASS_EXCEPT_DELETE',
    });
    return written;
  };

  it(`drafts the update from the save of the edit page (${name})`, () => {
    expect(prepared().run.updateScenarioId).not.toBeNull();
    shape.expectDraft(prepared().run);
  });

  it(`creates one row, updates it once with the values of the create (VERIFIED), and sends none of the broken saves (${name})`, async () => {
    const { site: served, run: { createFor, updateFor } } = prepared();
    if (shape.pageKeyValues !== null) served.setMemberSaveResponse('markedRepresentation');
    let created: ActionRunDocument;
    try {
      created = await runWrite(createFor(caseNumber + 1));
    } finally {
      served.setMemberSaveResponse(null);
    }
    expect(created).toMatchObject({ transport: 'API', submission: 'SENT', result: 'VERIFIED', reason: 'READ_VERIFICATION_MATCHED' });
    // 登録の成果物に、ページが入れた鍵の値が残る（今の Task 38 の記録。新しく足した記録ではない）。
    if (shape.pageKeyValues !== null) expect(created.api?.pageKeyValues).toEqual(shape.pageKeyValues);
    expect(backendRequests('POST')).toBe(1);
    const recordId = created.recordId ?? '';
    expect(recordId).toMatch(/^[0-9]+$/u);

    const before = served.memberOf(Number(recordId));
    const write = updateFor(caseNumber + 1, recordId, created);
    const updated = await runWrite(write);
    expect(updated).toMatchObject({
      transport: 'API', submission: 'SENT', recordId, result: 'VERIFIED', reason: 'READ_VERIFICATION_MATCHED', update: { targetRecordId: recordId },
      submittedValues: write.values,
    });
    // 変えた欄だけが変わる（サーバの状態）。
    expect(served.memberOf(Number(recordId))).toMatchObject({ ...before, ...write.values });
    expect(backendRequests('PATCH')).toBe(1);

    // 崩した送り方（絞り込み・本文・欄と結びつかない鍵）は、どれもサーバに届かない。
    for (const mode of shape.brokenSaveModes) {
      served.setMemberTenantSaveMode(mode);
      try {
        const patches = backendRequests('PATCH');
        const rowBefore = served.memberOf(Number(recordId));
        const blocked = await runWrite(updateFor(caseNumber + 1, recordId, created));
        // 止めたのは書き込みの段の Guard の照合（送る前の確かめではない）。
        expect({ mode, submission: blocked.submission, blockReason: blocked.blockReason, patches: backendRequests('PATCH') - patches })
          .toEqual({ mode, submission: 'NOT_SENT', blockReason: 'PAYLOAD_MISMATCH', patches: 0 });
        expect(served.memberOf(Number(recordId))).toEqual(rowBefore);
      } finally {
        served.setMemberTenantSaveMode(null);
      }
    }
    expect(backendRequests('PATCH')).toBe(1);
    expect(backendRequests('DELETE')).toBe(0);
  }, TEST_TIMEOUT_MS);
});
