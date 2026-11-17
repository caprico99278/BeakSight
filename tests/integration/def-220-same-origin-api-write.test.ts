// DEF-220（設計書 `2026-11-08-beaksight-same-origin-api-and-spa-routes-design.md` 3.1、6 章）: テスト用のサイト自身の API（アプリと同じ Origin の
// `/rest/v1/members`。fixture `startSpaAuthSite` の `sameOriginBackend` の form のない会員の画面。一般の文言）への登録（fetch の POST）と更新（PATCH）が、
// 操作さがしで `API_CREATE`・`API_UPDATE`（型の Origin は承認したテストの Origin の区分 `APPROVED_TEST`）になり、シナリオ（本番の部品）と書き込みの流れ
// （`executeWriteCreateRun`）まで通ることを、ログインのある形（スクリプトで送るログインの監査の段の口がある）とない形（口がない。承認した API の Origin は空）で、
// 本物の Chromium（テストの既定の headless）と 127.0.0.1 の fixture で確かめる結合テスト。
// - 操作さがしは送らない: 発見の間にサーバに届いた読み取りでない要求は 0。
// - 書き込みは承認した 1 回だけ: 登録の POST 1 回、更新の PATCH 1 回（サーバの記録で数える）。照合の READ まで `VERIFIED`。
// - 今の守りのまま: ページが DELETE・手続きの呼び出し（`/rpc/`）・別の行の filter を送る形は送らない（読み取りでない要求は 0）。
// 届いたかは fixture の記録で数える。各場面の後に数え、全部の場面の後に名前つきの時間だけ待って数え直す。出力先は一時のフォルダだけ。
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ActionRunDocument } from '../../src/control/actions/action-contracts.js';
import { readScenarioRevisions } from '../../src/control/approval/scenario-store.js';
import { listReadChecks } from '../../src/control/job/read-check-store.js';
import { writeStartSpecOf } from '../../src/control/job/write-job-start.js';
import { closeControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import { isWorkerStartApiWrite, type WorkerStartApiWrite } from '../../src/control/worker-protocol.js';
import { formatCompactUtcTimestamp } from '../../src/core/utc-timestamp.js';
import type { DiscoveryDocument } from '../../src/discovery/discovery-result.js';
import { sampleApprovalFacts } from '../helpers/approval-facts-sample.js';
import {
  API_WRITE_READ_TEMPLATE_PATH,
  createApiCreateScenario,
  createApiUpdateScenario,
  discoverSpaMemberScreens,
  expectSettledSpaNonReads,
  openSpaWriteProfile,
  runSpaApiWrite,
  saveButtonOf,
  spaMemberRequestCountOf,
  spaNonReadCountOf,
  type SpaRunLogin,
} from '../helpers/api-write-scenario.js';
import { DEFAULT_CHROMIUM_LAUNCHERS } from '../helpers/chromium.js';
import {
  SPA_APP_PATHS,
  SPA_BACKEND_PATHS,
  spaMemberEditPathOf,
  startSpaAuthSite,
  type SpaAuthSite,
  type SpaHostileMemberSave,
} from '../helpers/spa-auth-site-fixture.js';

const LOGINS: readonly SpaRunLogin[] = ['SCRIPT_LOGIN', 'NO_LOGIN'];
const SUITE_TIMEOUT_MS = 300_000;
const TEST_TIMEOUT_MS = 120_000;
const SHA256_HEX_LENGTH = 64;
const EXISTING_NAME = '既存 会員';
const nowText = (): string => formatCompactUtcTimestamp(new Date(), 'test time');

describe.each(DEFAULT_CHROMIUM_LAUNCHERS)('DEF-220: the approved writes to the API of the test site itself with %s', (label, launch) => {
  describe.each(LOGINS)(`with the login form %s (${label})`, (login) => {
    const profileId = `example-def220-${login === 'NO_LOGIN' ? 'nl' : 'sl'}-test`;
    const createScenarioId = `scenario-def220-create-${profileId}`;
    const updateScenarioId = `scenario-def220-update-${profileId}`;
    const readCheckId = `rc-def220-${profileId}`;
    const grantId = `grant-def220-${profileId}`;
    let site: SpaAuthSite;
    let directory = '';
    let database: ControlDatabase;
    let document: DiscoveryDocument;
    let targetId = 0;
    let discoveryNonReads = -1;
    let createFor: (index: number) => WorkerStartApiWrite = () => {
      throw new Error('the scenario is not prepared');
    };
    let updateFor: (index: number) => WorkerStartApiWrite = createFor;
    let caseNumber = 0;
    /** これまでの場面で、届いてよいと確かめた読み取りでない要求（承認した登録・更新）の数。 */
    let expectedNonReads = 0;
    let nonReadsBefore = 0;

    const nonReads = (): number => spaNonReadCountOf(site);
    /** 届いた、アプリの Origin の会員の API への要求（`since` 番目の記録から）。 */
    const memberRequests = (since: number, method: string): number => spaMemberRequestCountOf(site, method, since, 'app');
    const nameFor = (index: number): string => `DEF220 名前 ${String(index)}`;

    beforeAll(async () => {
      site = await startSpaAuthSite({ memberScreenLayout: 'formless', memberDetailPage: true, sameOriginBackend: true });
      expect(site.backendOrigin).toBe(site.appOrigin);
      targetId = site.addMember(EXISTING_NAME);
      directory = await mkdtemp(join(tmpdir(), 'beaksight-def220-'));
      // テストの Origin は承認したテストの Origin だけ（サービスの Origin には入れない。プロファイルの決まり）。ログインのない形は認証の設定を持たない。
      database = await openSpaWriteProfile(site, directory, profileId, login === 'NO_LOGIN' ? null : [site.tokenOrigin]);
      const beforeDiscovery = nonReads();
      document = await discoverSpaMemberScreens(site, join(directory, 'discovery'), launch, { login });
      discoveryNonReads = nonReads() - beforeDiscovery;
      const createScenario = createApiCreateScenario(database, {
        profileId, scenarioId: createScenarioId, readCheckId, site, document, limits: { maxCreatesPerRun: 1, maxCumulativeCreates: 20 }, at: nowText,
      });
      const updateScenario = createApiUpdateScenario(database, {
        profileId, scenarioId: updateScenarioId, ledgerScenarioId: createScenarioId, document, updatePagePath: spaMemberEditPathOf(targetId), at: nowText,
      });
      const createRevision = readScenarioRevisions(database, createScenarioId).find(({ revision }) => revision === createScenario.scenario.revision);
      const readCheck = listReadChecks(database, profileId).find((view) => view.readCheckId === readCheckId);
      const update = updateScenario.scenario.current;
      if (createRevision === undefined || readCheck === undefined || update.api === undefined) throw new Error('the scenarios or the READ check are missing');
      const updateApi = update.api;
      createFor = (index: number): WorkerStartApiWrite => {
        const values = Object.fromEntries(createRevision.scenario.fieldNames.map((key) => [key, key === 'email' ? `def220-${String(index)}@example.invalid` : nameFor(index)]));
        const spec = writeStartSpecOf({
          scenario: createRevision.scenario, evidence: createRevision.evidence, grantId, values, readCheck,
          targetPage: { origin: site.appOrigin, path: API_WRITE_READ_TEMPLATE_PATH }, profileId,
          seedRecord: {
            seed: 'e'.repeat(SHA256_HEX_LENGTH) as never,
            seedInput: { profileId, scenarioId: createScenarioId, scenarioRevision: createRevision.revision, ruleSetDigest: `sha256:${'f'.repeat(SHA256_HEX_LENGTH)}`,
              executionGrantId: grantId },
            baseDate: '2026-11-08',
            attempt: 0,
          },
          approvalFacts: sampleApprovalFacts({ kind: 'CREATE', profileId, scenarioId: createScenarioId, scenarioRevision: createRevision.revision, grantId }),
        });
        if (spec === null || !isWorkerStartApiWrite(spec)) throw new Error('the API write specification was not built');
        return spec;
      };
      updateFor = (index: number): WorkerStartApiWrite => {
        // 照合の READ と seed の形は、本番の親の部品で作った登録の開始の指定を元にする（`api-write-update-run.test.ts` と同じ組み立て）。
        const base = createFor(index);
        const name = nameFor(index);
        return {
          ...base,
          scenarioId: updateScenarioId,
          scenarioRevision: update.revision,
          formPage: { origin: site.appOrigin, path: spaMemberEditPathOf(targetId) },
          candidate: { identityDigest: update.candidate.identityDigest, ruleDigest: update.candidate.ruleDigest },
          submitterIdentityDigest: update.candidate.identityDigest,
          api: updateApi,
          values: { name },
          verification: { resultJudgement: null, recordId: null },
          readVerification: { ...base.readVerification, definition: { ...base.readVerification.definition, expectations: [{ kind: 'TEXT_CONTAINS', text: name }] } },
          approvalFacts: sampleApprovalFacts({ kind: 'UPDATE', profileId, scenarioId: updateScenarioId, scenarioRevision: update.revision, grantId }),
          update: { targetRecordId: String(targetId), knownKeptValues: [{ key: 'email', value: site.memberOf(targetId)?.email ?? '' }] },
        } as WorkerStartApiWrite;
      };
      nonReadsBefore = nonReads();
    }, SUITE_TIMEOUT_MS);

    afterAll(async () => {
      if (site !== undefined) await expectSettledSpaNonReads(site, nonReadsBefore, expectedNonReads);
      if (database !== undefined) closeControlDatabase(database);
      await site?.close();
      if (directory !== '') await rm(directory, { recursive: true, force: true });
    }, SUITE_TIMEOUT_MS);

    const runWrite = async (write: WorkerStartApiWrite): Promise<ActionRunDocument> => {
      caseNumber += 1;
      const { document: written } = await runSpaApiWrite({
        site, outputDirectory: join(directory, `output-${String(caseNumber)}`), jobId: `job-def220-${String(caseNumber)}`, write, launchBrowser: launch, login,
      });
      return written;
    };

    it(`classifies the save of the same Origin API as API_CREATE and API_UPDATE with the approved test Origin, without sending (${login}, ${label})`, () => {
      const create = saveButtonOf(document, SPA_APP_PATHS.memberNew).submissionProbe;
      const update = saveButtonOf(document, spaMemberEditPathOf(targetId)).submissionProbe;
      expect(create).toMatchObject({ result: 'API_CREATE', reason: null, shape: { method: 'POST', origin: { kind: 'APPROVED_TEST', index: 0 }, pathShape: SPA_BACKEND_PATHS.members } });
      expect(update).toMatchObject({ result: 'API_UPDATE', reason: null, shape: { method: 'PATCH', origin: { kind: 'APPROVED_TEST', index: 0 }, pathShape: SPA_BACKEND_PATHS.members } });
      // 操作さがしは送らない（発見の間にサーバに届いた読み取りでない要求は 0）。
      expect(discoveryNonReads).toBe(0);
      // シナリオの API の送り先は、テスト用のサイト自身の Origin（番号を承認したテストの Origin の一覧で解いた値）。
      expect(createFor(0).api.request).toMatchObject({ method: 'POST', origin: site.appOrigin, pathShape: SPA_BACKEND_PATHS.members });
      expect(updateFor(0).api.request).toMatchObject({ method: 'PATCH', origin: site.appOrigin, pathShape: SPA_BACKEND_PATHS.members });
    }, TEST_TIMEOUT_MS);

    it(`sends the approved create once to the same Origin API and verifies it (${login}, ${label})`, async () => {
      const since = site.requests.length;
      const membersBefore = site.memberCount;
      const document = await runWrite(createFor(caseNumber + 1));
      expectedNonReads += 1;
      expect(document).toMatchObject({ transport: 'API', submission: 'SENT', blockReason: null, result: 'VERIFIED', reason: 'READ_VERIFICATION_MATCHED' });
      expect(site.memberCount).toBe(membersBefore + 1);
      expect(memberRequests(since, 'POST')).toBe(1);
      expect(nonReads() - nonReadsBefore).toBe(expectedNonReads);
    }, TEST_TIMEOUT_MS);

    it(`sends the approved update once to the same Origin API and verifies it (${login}, ${label})`, async () => {
      const since = site.requests.length;
      const document = await runWrite(updateFor(caseNumber + 1));
      expectedNonReads += 1;
      expect(document).toMatchObject({ transport: 'API', submission: 'SENT', blockReason: null, result: 'VERIFIED' });
      expect(site.memberOf(targetId)?.name).toBe(nameFor(caseNumber));
      expect(memberRequests(since, 'PATCH')).toBe(1);
      expect(nonReads() - nonReadsBefore).toBe(expectedNonReads);
    }, TEST_TIMEOUT_MS);

    it.each<readonly [string, SpaHostileMemberSave, 'CREATE' | 'UPDATE']>([
      ['sends a DELETE instead', 'deleteOnSave', 'CREATE'],
      ['calls a procedure (/rpc/) instead', 'rpcCall', 'CREATE'],
      ['changes the filter to another row', 'filterRewrite', 'UPDATE'],
    ])(`does not send when the page %s (${login}, ${label})`, async (_name, hostile, kind) => {
      site.setHostileMemberSave(hostile);
      try {
        const before = site.memberOf(targetId);
        const document = await runWrite(kind === 'CREATE' ? createFor(caseNumber + 1) : updateFor(caseNumber + 1));
        expect(document).toMatchObject({ submission: 'NOT_SENT', reservationState: 'RELEASED' });
        expect(site.memberOf(targetId)).toEqual(before);
        expect(nonReads() - nonReadsBefore).toBe(expectedNonReads);
      } finally {
        site.setHostileMemberSave(null);
      }
    }, TEST_TIMEOUT_MS);
  });
});
