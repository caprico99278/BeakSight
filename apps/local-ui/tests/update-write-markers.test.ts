/**
 * 更新（UPDATE）の書き込みの、画面から始めて結果の画面まで進む目印の検査（端から端まで。Task 31 の設計書 3 章の「証拠と記録」、6 章の「目印の検査」、
 * 8 章の G31。T31i。T31h-2 の申し送り）。
 * - ビルドした画面を一時の root の起動の部品で起動し（`helpers/scenario-marker-flow.ts` の作り）、ワーカーの入口をテストだけの入口（手動のログインの
 *   資格情報を受け渡しのサーバから受ける。ほかは本番の process の組み立て）に替えて、本物のワーカーと本物の Chromium（headless だけ）で動かす。
 * - fixture のサイトは、書き込みの fixture（`tests/helpers/write-site-fixture.ts`。127.0.0.1 だけ）の更新の画面。保つ欄の備考（`note`）には人の値
 *   （目印 `keptMarker`）が入っている。CSRF の hidden と `lock_version` も目印。
 * - 流れ: プロファイルと認証の設定（Server Function）→ 画面から発見のジョブ → （テストだけの操作）READ の確かめの定義、登録（CREATE）と更新（UPDATE）
 *   のシナリオの作成と入力の規則の参照 → 画面で 2 つのシナリオを承認 → （テストだけの操作）登録のシナリオの照合まで済んだ登録 1 件（fixture のサイトの
 *   会員と同じ ID）→ 画面の書き込みの開始（確認のダイアログ）で UPDATE を始める → ジョブの詳細の結果の画面（前後の差分）。
 * - 確かめること:
 *   - 画面の結果（結果・理由・対象の ID・取れた ID・送信・予約・前後の差分の欄ごとの値と一致）が、管理データの書き込みの結果と同じ。
 *   - 変えた欄の前の値（画面に平文で出る）は、BeakSight が登録した値（台帳の値）だけ。保つ欄の人の値（目印）が前の値の欄や画面に出ない。
 *   - 秘密の目印（セッション、資格情報、CSRF、readonly、`lock_version`）と保つ欄の値・hidden の値が、検索するすべての場所（一時の root のファイル、
 *     管理データの全部の行、画面のサーバとワーカーの出力、IPC の記録、すべての画面の HTML と Server Function の応答）に、UTF-8 でも UTF-16LE でも
 *     出ない（検索は `helpers/secret-markers.ts`）。
 *   - T32g（Task 32 の設計書 4.1）: 本物のワーカーの書き込みの報告が親の確かめに通り（`VALID`）、結果の画面から開ける。開いた `action-report.html`
 *     は成果物の CSP の下で見た目のクラスが当たる。監査済みデータの台帳に、登録とその ID への UPDATE が出る。報告の HTML と台帳の画面も、目印を
 *     検索する場所に入れる。
 * 目印の値は出力しない（漏れた場所の名前と、文字の形だけを出す）。
 */
import { readFileSync, readdirSync } from 'node:fs';
import type { Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readWriteResult } from '../../../src/control/actions/write-result-facts.js';
import { AUTH_SETUP_SCHEMA_VERSION_2 } from '../../../src/control/auth/auth-setup-contracts.js';
import {
  createScenario,
  readApprovalReceipts,
  readScenario,
  type ScenarioStoreResult,
} from '../../../src/control/approval/scenario-store.js';
import type { RuleSetContent } from '../../../src/control/data-rules/rule-contracts.js';
import { saveRuleSetAndAttach } from '../../../src/control/data-rules/rule-store.js';
import { readJob } from '../../../src/control/job/job-store.js';
import { createReadCheck } from '../../../src/control/job/read-check-store.js';
import { validateReadCheckDefinition } from '../../../src/control/read-check-policy.js';
import type { ControlDatabase } from '../../../src/control/store/control-database.js';
import { ACTION_REPORT_ARTIFACT_FILE_NAME, DISCOVERY_ARTIFACT_FILE_NAME } from '../../../src/core/artifact-layout.js';
import { REPORT_CLASS_NAMES } from '../../../src/report/html-tokens.js';
import { discoveryCandidatesOf, type DiscoveryDocument } from '../../../src/discovery/discovery-result.js';
import { LOCAL_UI_WRITE_TEXT } from '../../../src/presentation/messages.js';
import { ALL_CONFIRMED } from '../../../tests/unit/approval-samples.js';
import { WRITE_JOB_READ_CHECK_ID, WRITE_JOB_VERIFICATION, updateScenarioDraftOf } from '../../../tests/helpers/write-job-harness.js';
import { seedWriteResultForTest } from '../../../tests/helpers/write-result-fixtures.js';
import { WRITE_SITE_LOGIN_FIELDS, WRITE_SITE_PATHS, startWriteSite, type WriteSite } from '../../../tests/helpers/write-site-fixture.js';
import { writeAuthTargetConfig } from './helpers/auth-worker.ts';
import { FIRST_REVISION, SCENARIO_TIMEOUT_MS, UI_TIMEOUT_MS, createScenarioMarkerFlow } from './helpers/scenario-marker-flow.ts';

const PROFILE_ID = 't31i-update';
const CREATE_SCENARIO_ID = 't31i-create';
const UPDATE_SCENARIO_ID = 't31i-update-scenario';
/** BeakSight が登録した値（台帳の値）と、更新で送る値（匿名の値）。 */
const REGISTERED_NAME = '台帳一郎';
const UPDATED_NAME = '更新太郎';
const KEPT_FIELD_NAMES = ['email', 'note', 'newsletter', 'published'] as const;
/** 発見の上限の画面の数と、読み込みの最小の間隔（ms）。 */
const MAX_PAGES = 20;
const NAVIGATION_INTERVAL_MS = 300;
/** 照合まで済んだ登録の、テストだけの許可とジョブの id と、HTTP の状態。 */
const SEEDED_GRANT_ID = 't31i-seeded-grant';
const SEEDED_JOB_ID = 't31i-seeded-job';
const SEEDED_HTTP_STATUS = 200;
const writeText = LOCAL_UI_WRITE_TEXT;

let site: WriteSite | undefined;
const siteOf = (): WriteSite => {
  if (site === undefined) {
    throw new Error('fixture のサイトが起動していない');
  }
  return site;
};

/** 画面の HTML と、シナリオ・書き込み・ジョブの Server Function の応答か（画面の Cookie と token を探す範囲）。 */
const isWriteScreenPlace = (place: string): boolean =>
  /^(?:html:|browser-html:\d+:)\/(?:scenarios|jobs)\//u.test(place) || /^function:(?:scenario[A-Za-z]+|writeStartPage|getAuditJob)Fn:/u.test(place);

const flow = createScenarioMarkerFlow({
  label: 't31i',
  profileIds: () => [PROFILE_ID],
  secretMarkers: () => siteOf().secretValues(),
  extraScreenPaths: () => [
    `/scenarios/${PROFILE_ID}/${CREATE_SCENARIO_ID}`,
    `/scenarios/${PROFILE_ID}/${UPDATE_SCENARIO_ID}`,
    `/scenarios/${PROFILE_ID}/${UPDATE_SCENARIO_ID}/write`,
    // T32g: 監査済みデータの台帳の画面。
    `/ledger/${PROFILE_ID}`,
  ],
  extraFunctionCalls: () => [
    ['scenarioDetailPageFn', { scenarioId: UPDATE_SCENARIO_ID }] as const,
    ['writeStartPageFn', { scenarioId: UPDATE_SCENARIO_ID }] as const,
    // T32g: 監査済みデータの台帳の画面の値。
    ['auditedDataLedgerPageFn', { profileId: PROFILE_ID }] as const,
  ],
  isScreenSecretPlace: isWriteScreenPlace,
});

/** fixture のサイトの仮の資格情報（受け渡しのサーバに渡す 1 組）。 */
const provideCredentials = async (): Promise<void> => {
  const fields: (readonly [string, string])[] = [];
  await siteOf().fillCredentials(async (selector, value) => {
    fields.push([selector, value]);
  });
  flow.relayOf().provide({ fields, submit: WRITE_SITE_LOGIN_FIELDS.submit });
};

/** 名前の入力の規則（人の固定の値 1 つ）。 */
const nameRulesOf = (value: string): RuleSetContent => ({
  fieldRules: [{ fieldName: 'name', semanticKind: 'FIXED_LIST', method: 'FROM_FIXED_LIST', range: null, fixedValues: [value] }],
  relations: [],
  uniqueKeyFieldNames: ['name'],
});

/** テストだけの操作: 作ったシナリオに入力の規則の参照を付ける。 */
const attachNameRules = (database: ControlDatabase, created: ScenarioStoreResult, scenarioId: string, value: string): void => {
  if (!created.ok) {
    throw new Error(`the scenario was not created: ${created.reason}`);
  }
  const saved = saveRuleSetAndAttach(database, {
    ruleSetId: `rules-${scenarioId}`, scenarioId, expectedRevision: null, content: nameRulesOf(value), expectedScenarioRevision: created.scenario.revision,
    at: flow.nowTimestamp(),
  });
  expect(saved.attachment?.ok).toBe(true);
};

/** 画面の発見の開始のボタンで発見のジョブを始め、終わるまで待つ。ジョブの id を返す。 */
const discoverOnScreen = async (): Promise<string> => {
  await provideCredentials();
  const page = await flow.openPage(`/discovery/${PROFILE_ID}`);
  await page.getByTestId('discovery-start').click();
  await page.waitForURL(/\/jobs\/[a-z0-9-]+$/u, { timeout: UI_TIMEOUT_MS });
  const jobId = new URL(page.url()).pathname.split('/').at(-1) ?? '';
  flow.jobs.push({ jobId, profileId: PROFILE_ID });
  expect(await flow.waitForJobEnd(jobId)).toMatchObject({ jobKind: 'DISCOVERY', state: 'FINISHED' });
  return jobId;
};

/** 発見の成果物（一時の root の出力先の Run のディレクトリの `discovery.json`。1 つだけ）。 */
const discoveryDocumentOf = (): DiscoveryDocument => {
  const output = `${flow.rootOf()}/t25e-output-${PROFILE_ID}`;
  const runs = readdirSync(output, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map(({ name }) => name).sort();
  const latest = runs.at(-1) ?? '';
  return JSON.parse(readFileSync(`${output}/${latest}/${DISCOVERY_ARTIFACT_FILE_NAME}`, 'utf8')) as DiscoveryDocument;
};

/** 最後の承認の記録が縛った、管理データの外の事実。 */
const approvalBoundOf = (database: ControlDatabase, scenarioId: string) => {
  const approval = readApprovalReceipts(database, scenarioId).findLast((receipt) => receipt.kind === 'APPROVAL');
  if (approval?.kind !== 'APPROVAL') {
    throw new Error('承認の記録がない');
  }
  const { authSetupDigest, targetConfigDigest } = approval.bound;
  return { authSetupDigest, targetConfigDigest };
};

/** 書き込みの開始の画面から、確認のダイアログの後に UPDATE を始める。ジョブの id を返す。 */
const startUpdateFromWritePage = async (): Promise<string> => {
  await provideCredentials();
  const page = await flow.openPage(`/scenarios/${PROFILE_ID}/${UPDATE_SCENARIO_ID}/write`);
  await page.getByTestId('write-start-open').waitFor({ timeout: UI_TIMEOUT_MS });
  await flow.snapshot(page);
  await page.getByTestId('write-start-open').click();
  const dialog = page.getByRole('dialog', { name: writeText.startDialog.title });
  await dialog.waitFor({ timeout: UI_TIMEOUT_MS });
  await dialog.getByRole('button', { name: writeText.startDialog.confirm, exact: true }).click();
  await page.waitForURL(/\/jobs\/[a-z0-9-]+$/u, { timeout: UI_TIMEOUT_MS });
  const jobId = new URL(page.url()).pathname.split('/').at(-1) ?? '';
  flow.jobs.push({ jobId, profileId: PROFILE_ID });
  return jobId;
};

/** 画面の一致の印（一致は `true`・`false`、照合できなければ空）。 */
const matchedText = (matched: boolean | null): string => (matched === null ? '' : String(matched));

/** 結果の画面の値（前後の差分の欄ごとの値と一致の印）。 */
const resultOnScreen = async (page: Page) => {
  const result = page.getByTestId('write-result');
  const changed = await page.getByTestId('write-result-diff-changed').evaluateAll((rows) => rows.map((row) => ({
    fieldName: row.getAttribute('data-field-name'),
    matched: row.getAttribute('data-matched'),
    previousValue: row.querySelector('[data-testid="write-result-diff-previous"]')?.textContent ?? null,
    newValue: row.querySelector('[data-testid="write-result-diff-new"]')?.textContent ?? null,
  })));
  const kept = await page.getByTestId('write-result-diff-kept').evaluateAll((rows) => rows.map((row) => ({
    fieldName: row.getAttribute('data-field-name'),
    matched: row.getAttribute('data-matched'),
  })));
  return {
    jobId: await result.getAttribute('data-job-id'),
    result: await result.getAttribute('data-result'),
    kind: await result.getAttribute('data-kind'),
    reason: await page.getByTestId('write-result-reason').getAttribute('data-reason'),
    target: (await page.getByTestId('write-result-target').textContent())?.trim() ?? null,
    recordId: (await page.getByTestId('write-result-record-id').textContent())?.trim() ?? null,
    changed,
    kept,
  };
};

beforeAll(async () => {
  await flow.start();
  site = await startWriteSite();
  site.enableUpdatePages();
}, SCENARIO_TIMEOUT_MS);

afterEach(async () => {
  await flow.closePages();
});

afterAll(async () => {
  await flow.stop();
  await site?.close();
}, SCENARIO_TIMEOUT_MS);

describe('T31i: an UPDATE started on the screen with the real worker, up to the result screen', () => {
  it('shows the same result as the control data, the prior value is only the registered value, and no marker or kept value leaks', async () => {
    const targetConfigPath = writeAuthTargetConfig(flow.rootOf(), PROFILE_ID, siteOf().origin, WRITE_SITE_PATHS.list, MAX_PAGES, NAVIGATION_INTERVAL_MS);
    expect(await flow.valueOf('createProfileFn', 'POST', {
      profile: {
        schemaVersion: 'beaksight-profile/1', profileId: PROFILE_ID, revision: FIRST_REVISION, targetConfigPath, environment: 'TEST',
        mode: 'TEST_APPROVED_WRITE', auth: 'MANUAL_SESSION', approvedTestOrigins: [siteOf().origin], environmentEvidenceRef: 't31i-evidence',
      },
    })).toMatchObject({ ok: true });
    expect(await flow.valueOf('saveAuthSetupFn', 'POST', {
      setup: {
        schemaVersion: AUTH_SETUP_SCHEMA_VERSION_2, profileId: PROFILE_ID, profileRevision: FIRST_REVISION,
        loginStartUrl: `${siteOf().origin}${WRITE_SITE_PATHS.login}`, loginPostEndpoints: [{ origin: siteOf().origin, path: WRITE_SITE_PATHS.login }],
        successCondition: { pathPrefix: WRITE_SITE_PATHS.list, selector: '#search' }, sessionLostCondition: { pathPrefix: WRITE_SITE_PATHS.login },
        excludedPaths: ['/logout'], auditPathPrefixes: [WRITE_SITE_PATHS.list], maxLoginAttempts: 2, allowedIdpOrigins: [], automatedLogin: null,
      },
    })).toMatchObject({ ok: true });
    // BeakSight が登録した会員（台帳の値。下で、照合まで済んだ登録として入れる）。
    const memberId = siteOf().addMember(REGISTERED_NAME);

    await discoverOnScreen();
    const document = discoveryDocumentOf();
    flow.withControlData((database) => {
      const search = discoveryCandidatesOf(document).find((candidate) => candidate.kind === 'FORM' && candidate.page.path === WRITE_SITE_PATHS.list);
      const form = discoveryCandidatesOf(document).find((candidate) => candidate.kind === 'FORM' && candidate.page.path === WRITE_SITE_PATHS.form);
      if (search === undefined || form === undefined) {
        throw new Error('the candidates were not discovered');
      }
      const checked = validateReadCheckDefinition({
        targetIdentityDigest: search.identityDigest, parameters: { q: 'x' }, expectations: [{ kind: 'ROW_COUNT_EQUALS', count: 1 }],
      }, search);
      if (!checked.ok) {
        throw new Error('the READ check was rejected');
      }
      expect(createReadCheck(database, { readCheckId: WRITE_JOB_READ_CHECK_ID, profileId: PROFILE_ID, definition: checked.definition, at: flow.nowTimestamp() }).ok)
        .toBe(true);
      attachNameRules(database, createScenario(database, {
        scenarioId: CREATE_SCENARIO_ID,
        draft: {
          profileId: PROFILE_ID, candidateIdentityDigest: form.identityDigest, fieldNames: ['name', 'email', 'newsletter'], readChecks: [],
          sideEffectConfirmations: ALL_CONFIRMED, limits: { maxCreatesPerRun: 1, maxCumulativeCreates: 20 }, approvalTtlDays: 30,
          verification: WRITE_JOB_VERIFICATION,
        },
        discovery: document,
        at: flow.nowTimestamp(),
      }), CREATE_SCENARIO_ID, REGISTERED_NAME);
      attachNameRules(database, createScenario(database, {
        scenarioId: UPDATE_SCENARIO_ID,
        draft: updateScenarioDraftOf(PROFILE_ID, document, {
          scenarioId: UPDATE_SCENARIO_ID, names: [UPDATED_NAME], targetCreateScenarioId: CREATE_SCENARIO_ID, keepFieldNames: KEPT_FIELD_NAMES,
        }),
        discovery: document,
        at: flow.nowTimestamp(),
      }), UPDATE_SCENARIO_ID, UPDATED_NAME);
    });
    await flow.approveOnScreen(PROFILE_ID, CREATE_SCENARIO_ID);
    await flow.approveOnScreen(PROFILE_ID, UPDATE_SCENARIO_ID);
    flow.withControlData((database) => {
      seedWriteResultForTest(database, {
        profileId: PROFILE_ID, scenarioId: CREATE_SCENARIO_ID, scenarioRevision: readScenario(database, CREATE_SCENARIO_ID)?.revision ?? FIRST_REVISION,
        grantId: SEEDED_GRANT_ID, jobId: SEEDED_JOB_ID, external: approvalBoundOf(database, CREATE_SCENARIO_ID), at: flow.nowTimestamp(),
        submittedValues: { name: REGISTERED_NAME },
        report: {
          submission: 'SENT', blockReason: null, httpStatus: SEEDED_HTTP_STATUS, responseJudgement: 'SUCCESS', recordId: String(memberId),
          readVerification: 'MATCHED', submittedAt: flow.nowTimestamp(),
        },
      });
    });

    const jobId = await startUpdateFromWritePage();
    expect(await flow.waitForJobEnd(jobId)).toMatchObject({ jobKind: 'WRITE_UPDATE', state: 'FINISHED' });
    const page = await flow.openPage(`/jobs/${jobId}`);
    await page.locator('[data-testid="write-result"]:not([data-result=""])').waitFor({ timeout: UI_TIMEOUT_MS });
    await flow.snapshot(page);
    const screen = await resultOnScreen(page);
    const stored = flow.withControlData((database) => readWriteResult(database, jobId));
    expect(stored).toMatchObject({ result: 'VERIFIED', targetRecordId: String(memberId), recordId: String(memberId) });
    // 画面の結果が、管理データの結果と同じ。
    expect(screen).toEqual({
      jobId,
      result: stored?.result,
      kind: 'UPDATE',
      reason: stored?.reason,
      target: stored?.targetRecordId,
      recordId: stored?.recordId,
      changed: (stored?.updateEvidence?.fields ?? []).filter(({ role }) => role === 'CHANGED').map((field) => ({
        fieldName: field.fieldName, matched: matchedText(field.matched), previousValue: field.previousValue, newValue: field.newValue,
      })),
      // 画面は保つ欄を名前の順に並べる（並べ方は画面の決まり。中身を比べる）。
      kept: (stored?.updateEvidence?.fields ?? []).filter(({ role }) => role === 'KEPT').map((field) => ({
        fieldName: field.fieldName, matched: matchedText(field.matched),
      })).sort((left, right) => left.fieldName.localeCompare(right.fieldName)),
    });
    // 変えた欄の前の値は、BeakSight が登録した値（台帳の値）だけ。新しい値は送った値。
    expect(screen.changed).toEqual([{ fieldName: 'name', matched: 'true', previousValue: REGISTERED_NAME, newValue: UPDATED_NAME }]);
    expect(screen.kept.map(({ fieldName }) => fieldName)).toEqual([...KEPT_FIELD_NAMES, 'active'].sort((left, right) => left.localeCompare(right)));
    expect(siteOf().memberOf(memberId)).toMatchObject({ name: UPDATED_NAME, note: siteOf().keptMarker });

    // T32g: 本物のワーカーの書き込みの報告は、親の確かめに通り（`VALID`）、結果の画面から開ける。開いた HTML は、成果物の CSP（style の hash）の
    // 下で、報告の見た目のクラス（バッジ）のスタイルが当たる。
    expect(flow.withControlData((database) => readJob(database, jobId)?.writeReportCheck)).toBe('VALID');
    expect(await page.getByTestId('write-report').getAttribute('data-check')).toBe('VALID');
    const reportHref = await page.getByTestId('write-report-open').getAttribute('href');
    expect(reportHref).toBe(`/artifacts/${jobId}/${ACTION_REPORT_ARTIFACT_FILE_NAME}`);
    const report = await flow.openPage(reportHref ?? '');
    await flow.snapshot(report);
    expect(await report.locator(`.${REPORT_CLASS_NAMES.badge}`).first().evaluate((element) => getComputedStyle(element).display)).toBe('inline-block');
    // T32g: 監査済みデータの台帳に、BeakSight が登録した会員（照合まで済んだ登録）と、その ID への UPDATE 1 回（照合済み）が出る。
    const ledger = await flow.openPage(`/ledger/${PROFILE_ID}`);
    const entry = ledger.locator(`[data-testid="ledger-entry"][data-record-id="${String(memberId)}"]`);
    await entry.waitFor({ timeout: UI_TIMEOUT_MS });
    expect([await entry.getAttribute('data-update-count'), await entry.getAttribute('data-last-update-result')]).toEqual(['1', 'VERIFIED']);
    await flow.snapshot(ledger);

    // 秘密の目印と保つ欄の人の値・hidden の値が、検索するすべての場所（画面と応答を含む）に出ない。
    const places = await flow.expectNoSecretMarker('update');
    // 対照: 検索した場所に、結果の画面と、変えた欄の前の値（秘密でない、台帳の値）が入っている。
    expect(places.some(({ place }) => place === `html:/jobs/${jobId}`)).toBe(true);
    // T32g: 報告の HTML と台帳の画面も検索した。
    expect(places.some(({ place }) => place === `html:/artifacts/${jobId}/${ACTION_REPORT_ARTIFACT_FILE_NAME}`)).toBe(true);
    expect(places.some(({ place }) => place === `html:/ledger/${PROFILE_ID}`)).toBe(true);
    expect(places.some(({ place, bytes }) => place === `html:/jobs/${jobId}` && Buffer.from(bytes).toString('utf8').includes(REGISTERED_NAME))).toBe(true);
  }, SCENARIO_TIMEOUT_MS);
});
