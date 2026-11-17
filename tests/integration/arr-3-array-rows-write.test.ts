// ARR-3（DEF-234 の段 A1。設計書 `2026-11-09-beaksight-api-array-rows-design.md` 2.2、6 章）: 入力の行がいくつもある登録の画面（`startSpaAuthSite` の
// `memberArrayRows`。一般の文言）で、操作さがし → 自動の下書き → 承認（副作用の確認）→ 入力の規則（推した規則）→ 値の生成 → 書き込みの開始の指定 →
// 書き込みの段（`executeWriteCreateRun`）まで通ることを、本物の Chromium（テストの既定）と 127.0.0.1 の fixture で確かめる結合テスト。
// 送り先はテスト用のサイト自身の API（アプリと同じ Origin。区分 `APPROVED_TEST`。ログインなし）。
// - real1（行の欄の後ろに空の行）と autoTrailBox（入れると空の行が足される。行の入れ物が別の親）: 欄の位置と空の位置を承認し、POST が 1 回だけ届き、本文の
//   一覧が `[生成した値, ""]`（サーバの記録）。ページが一覧を崩した形（足す・減らす・順・別の値・空の位置を埋める・入れ子）は届いた数 0。
// - ARR-4（段 A2。設計書 2.3）: twoBoth（欄の印が 2 つ入る一覧）・twoBothSkip（空の行を送らない）・four（欄 4 つと後ろに空の行）は、位置ごとの欄の鍵
//   （道 `key[i]`）として承認し、POST が 1 回だけ届き、本文の一覧の各位置が欄ごとの生成した値（ARR-3 のときは、ページが決める一覧として受けず、自動の
//   下書きが `SCENARIO_API_ARRAY_MULTIPLE_FIELDS` で拒んでいた）。崩した形は届いた数 0。
// - ARR-5（段 C。設計書 2.4）: objRows・objSkip・objAdd・objTrail（職歴の行の object の一覧。後ろに空の行の形も）は、行の中の欄ごとの鍵（道
//   `key[i].name`）として承認し、POST が 1 回だけ届き、本文の行が欄ごとの生成した値（ARR-4 のときは入れ子として拒んでいた）。崩した形（行を足す・減らす・
//   順・別の値・空の値を埋める・深くする・中の鍵を足す・減らす）は届いた数 0。
// - DEF-237: autoTrail（入れると、同じ親の前の位置に行が足される）も、操作さがしが API_CREATE を取り、POST が 1 回だけ届く（位置の道は探す手がかり。
//   同じ要素かは backendNodeId で決める）。
// - 操作さがしは送らない: 発見の間にサーバに届いた読み取りでない要求は 0。
// - DEF-226・ARR-2（W-FIX で `def-226-array-key-write.test.ts` から移した）: 一覧の鍵（欄の一覧とページが決める一覧）を含む登録。ファイルの末尾の describe。
// 届いたかは fixture の記録で数える。各場面の後に数え、全部の場面の後に名前つきの時間だけ待って数え直す。出力先は一時のフォルダだけ。
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AutoDraftCreatePlan } from '../../src/control/approval/api-scenario-autodraft.js';
import { closeControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import { formatCompactUtcTimestamp } from '../../src/core/utc-timestamp.js';
import type { DiscoveryDocument } from '../../src/discovery/discovery-result.js';
import {
  approveSpaCreateDraft,
  blockedPayloadCountOf,
  discoverSpaMemberScreens,
  expectSettledSpaNonReads,
  openSpaWriteProfile,
  recordSpaDiscoveryJob,
  runSpaApiWrite,
  saveButtonOf,
  spaCreateAutoDraftPlanOf,
  spaMemberRequestCountOf,
  spaNonReadCountOf,
  type ApprovedSpaCreate,
  type SpaRunLogin,
} from '../helpers/api-write-scenario.js';
import { DEFAULT_CHROMIUM_LAUNCHERS, useSharedRunBrowser } from '../helpers/chromium.js';
import {
  SPA_APP_PATHS,
  SPA_ARRAY_KEYS,
  SPA_BACKEND_PATHS,
  startSpaAuthSite,
  type SpaArrayRowsLayout,
  type SpaAuthSite,
  type SpaHostileMemberSave,
} from '../helpers/spa-auth-site-fixture.js';

const SUITE_TIMEOUT_MS = 300_000;
const TEST_TIMEOUT_MS = 120_000;
const BASE_DATE = '2026-11-09';
const nowText = (): string => formatCompactUtcTimestamp(new Date(), 'test time');

/** 承認する形ごとの、欄の一覧の鍵と、ページが崩す送り方（崩した形は送らない）。 */
const HOSTILE_ROWS_SAVES: readonly SpaHostileMemberSave[] = ['rowsAdded', 'rowsDropped', 'rowsReordered', 'rowsOtherValue', 'rowsEmptyFilled', 'rowsNested'];
/** 位置ごとの役（欄 1 つと後ろに空の位置、欄 2 つ、欄 4 つと後ろに空の位置）。 */
const ONE_AND_EMPTY = ['FIELD', 'EMPTY_STRING'];
const TWO_FIELDS = ['FIELD', 'FIELD'];
const FOUR_AND_EMPTY = ['FIELD', 'FIELD', 'FIELD', 'FIELD', 'EMPTY_STRING'];
/** 生成した値（欄の鍵ごと）。 */
type Values = Readonly<Record<string, string | null>>;
/**
 * 形ごとの、承認する欄の一覧の鍵と役（ARR-3 は一覧の鍵 1 つ、ARR-4 は位置ごとの道 `key[i]`）、届く本文の一覧（生成した値から）、ページが崩す送り方。
 */
interface SendableLayout {
  readonly layout: SpaArrayRowsLayout;
  /** 欄の一覧の鍵と、位置の役（ARR-3・ARR-4）か行の役（ARR-5）。 */
  readonly keyRoles: readonly (readonly [string, readonly unknown[]])[];
  readonly listsOf: (values: Values) => Readonly<Record<string, readonly unknown[]>>;
  readonly hostileSaves: readonly SpaHostileMemberSave[];
}
const pathsOf = (key: string, count: number, roles: readonly unknown[]): (readonly [string, readonly unknown[]])[] =>
  Array.from({ length: count }, (_, index) => [`${key}[${String(index)}]`, roles] as const);
/** ARR-5: 職歴の行の役（欄の行と、後ろに足す空の行）。 */
const CAREER_FIELD_ROW = [{ name: 'name', role: 'FIELD' }, { name: 'year', role: 'FIELD' }];
const EMPTY_CAREER_ROW = [{ name: 'name', role: 'EMPTY_STRING' }, { name: 'year', role: 'EMPTY_STRING' }];
/** ARR-5: 職歴の行の欄の鍵（道 `careers[i].name`・`careers[i].year`）と、行の役。 */
const careerKeyRolesOf = (count: number, trailing: readonly unknown[]): (readonly [string, readonly unknown[]])[] => {
  const rows = [...Array.from({ length: count }, () => CAREER_FIELD_ROW), ...trailing];
  return Array.from({ length: count }, (_, index) => [`careers[${String(index)}].name`, `careers[${String(index)}].year`])
    .flat().map((key) => [key, rows] as const);
};
/** ARR-5: 届く職歴の行（欄の行は欄ごとの生成した値）。 */
const careerRowsOf = (values: Values, count: number, trailing: readonly unknown[]): readonly unknown[] => [
  ...Array.from({ length: count }, (_, index) => ({ name: values[`careers[${String(index)}].name`], year: values[`careers[${String(index)}].year`] })),
  ...trailing,
];
/** ARR-5: object の行の崩し（足す・減らす・順・別の値・空の位置を埋める・深くする・中の鍵を足す・減らす）。 */
const OBJECT_ROWS_SAVES: readonly SpaHostileMemberSave[] = [...HOSTILE_ROWS_SAVES, 'rowsInnerKeyAdded', 'rowsInnerKeyRemoved'];
const SENDABLE_LAYOUTS: readonly (readonly [string, SendableLayout])[] = [
  ['real1', {
    layout: 'real1',
    keyRoles: [['licenses', ONE_AND_EMPTY], ['quals', ONE_AND_EMPTY]],
    listsOf: (values) => ({ licenses: [values['licenses'] ?? null, ''], quals: [values['quals'] ?? null, ''] }),
    hostileSaves: HOSTILE_ROWS_SAVES,
  }],
  ['autoTrailBox', {
    layout: 'autoTrailBox', keyRoles: [['quals', ONE_AND_EMPTY]], listsOf: (values) => ({ quals: [values['quals'] ?? null, ''] }), hostileSaves: HOSTILE_ROWS_SAVES,
  }],
  // DEF-237（設計書 `2026-11-09-beaksight-element-identity-design.md` 7 章）: 入れると、同じ親の前の位置に行が足される形（後ろの欄と保存のボタンの位置の道が
  // ずれる）。操作さがしが API_CREATE を取り、書き込みの段で 1 回だけ届く。崩した形は 1 つだけ確かめる（届いた数 0）。
  ['autoTrail', {
    layout: 'autoTrail', keyRoles: [['certs', ONE_AND_EMPTY]], listsOf: (values) => ({ certs: [values['certs'] ?? null, ''] }), hostileSaves: ['rowsAdded'],
  }],
  // ARR-4（DEF-234 の段 A2）: 1 つの一覧に欄がいくつも入る形。
  ['twoBoth', {
    layout: 'twoBoth',
    keyRoles: pathsOf('quals', 2, TWO_FIELDS),
    listsOf: (values) => ({ quals: [values['quals[0]'] ?? null, values['quals[1]'] ?? null] }),
    // 空の位置がないので、空の位置を埋める崩し（`rowsEmptyFilled`）は本文を変えない（承認どおりに届く）。外す。
    hostileSaves: HOSTILE_ROWS_SAVES.filter((save) => save !== 'rowsEmptyFilled'),
  }],
  ['twoBothSkip', {
    layout: 'twoBothSkip',
    keyRoles: pathsOf('quals', 2, TWO_FIELDS),
    listsOf: (values) => ({ quals: [values['quals[0]'] ?? null, values['quals[1]'] ?? null] }),
    hostileSaves: ['rowsDropped', 'rowsReordered'],
  }],
  ['four', {
    layout: 'four',
    keyRoles: pathsOf('skills', 4, FOUR_AND_EMPTY),
    listsOf: (values) => ({ skills: [0, 1, 2, 3].map((index) => values[`skills[${String(index)}]`] ?? null).concat(['']) }),
    hostileSaves: HOSTILE_ROWS_SAVES,
  }],
  // ARR-5（DEF-234 の段 C）: 職歴の行（object の一覧。入れ子 1 段）。行の中の欄ごとに道 `key[i].name`。
  ['objRows', {
    layout: 'objRows', keyRoles: careerKeyRolesOf(2, []), listsOf: (values) => ({ careers: careerRowsOf(values, 2, []) }),
    // 空の値がないので、空の位置を埋める崩しは本文を変えない。外す。
    hostileSaves: OBJECT_ROWS_SAVES.filter((save) => save !== 'rowsEmptyFilled'),
  }],
  ['objSkip', {
    layout: 'objSkip', keyRoles: careerKeyRolesOf(3, []), listsOf: (values) => ({ careers: careerRowsOf(values, 3, []) }),
    hostileSaves: ['rowsDropped', 'rowsReordered', 'rowsInnerKeyAdded'],
  }],
  ['objAdd', {
    layout: 'objAdd', keyRoles: careerKeyRolesOf(1, []), listsOf: (values) => ({ careers: careerRowsOf(values, 1, []) }),
    hostileSaves: ['rowsAdded', 'rowsDropped', 'rowsOtherValue', 'rowsInnerKeyRemoved'],
  }],
  ['objTrail', {
    layout: 'objTrail', keyRoles: careerKeyRolesOf(2, [EMPTY_CAREER_ROW]), listsOf: (values) => ({ careers: careerRowsOf(values, 2, [{ name: '', year: '' }]) }),
    hostileSaves: OBJECT_ROWS_SAVES,
  }],
];

/** 1 つの形の、仮のサイト・管理データ・操作さがし・自動の下書き（beforeAll で作る）。 */
interface Prepared {
  readonly site: SpaAuthSite;
  readonly directory: string;
  readonly database: ControlDatabase;
  readonly profileId: string;
  readonly document: DiscoveryDocument;
  readonly discoveryNonReads: number;
  readonly createPlan: AutoDraftCreatePlan | undefined;
}

/** 仮のサイトを起こし、プロファイルを作り、操作さがし（送らない）と自動の下書きまでを流す（共通の部品 `api-write-scenario.ts`）。 */
const prepare = async (layout: SpaArrayRowsLayout, launch: () => Promise<Browser>): Promise<Prepared> => {
  const site = await startSpaAuthSite({ memberScreenLayout: 'formless', memberDetailPage: true, memberArrayRows: layout, sameOriginBackend: true });
  const profileId = `example-arr3-${layout.toLowerCase()}-default`;
  const directory = await mkdtemp(join(tmpdir(), 'beaksight-arr3-'));
  const database = await openSpaWriteProfile(site, directory, profileId, null);
  const beforeDiscovery = spaNonReadCountOf(site);
  const document = await discoverSpaMemberScreens(site, join(directory, 'discovery'), launch, { login: 'NO_LOGIN' });
  const discoveryNonReads = spaNonReadCountOf(site) - beforeDiscovery;
  const candidates = recordSpaDiscoveryJob(database, profileId, document, nowText());
  const createPlan = spaCreateAutoDraftPlanOf(site, profileId, candidates, []);
  return { site, directory, database, profileId, document, discoveryNonReads, createPlan };
};

/** 片づけ（遅れて届く要求を待って数え直してから）。 */
const cleanUp = async (prepared: Prepared | undefined, expectedNonReads: number, nonReadsBefore: number): Promise<void> => {
  if (prepared === undefined) return;
  await expectSettledSpaNonReads(prepared.site, nonReadsBefore, expectedNonReads);
  closeControlDatabase(prepared.database);
  await prepared.site.close();
  await rm(prepared.directory, { recursive: true, force: true });
};

/**
 * SLIM W-3: 崩した保存は、崩しの種類ごとに 1 回（文字列の一覧の形と object の行の形で分け、その崩しを持つ最初の並びで流す）。崩しの照合は単体
 * （`arr-3`〜`arr-5` の単体）が確かめ、ここは種類ごとに本物のブラウザで届いた数 0 を 1 回ずつ残す。
 */
const hostileFamilyOf = (layout: string, save: string): string => `${layout.startsWith('obj') ? 'OBJECT' : 'ARRAY'}:${save}`;
const FIRST_LAYOUT_OF_HOSTILE: ReadonlyMap<string, string> = SENDABLE_LAYOUTS.reduce((first, [, { layout, hostileSaves }]) => {
  for (const save of hostileSaves) {
    if (!first.has(hostileFamilyOf(layout, save))) {
      first.set(hostileFamilyOf(layout, save), layout);
    }
  }
  return first;
}, new Map<string, string>());

describe.each(DEFAULT_CHROMIUM_LAUNCHERS)('ARR-3 (DEF-234 A1): the rows of a list with %s', (label, launchChromium) => {
  // SLIM-2（X7）: 発見と書き込みの流れごとに Chromium を起こさず、1 つの Browser を共有する（Context は流れごと）。
  const launch = useSharedRunBrowser(launchChromium);
  describe.each(SENDABLE_LAYOUTS)(`the %s form (${label})`, (_name, { layout, keyRoles, listsOf, hostileSaves }) => {
    let prepared: Prepared | undefined;
    let approved: ApprovedSpaCreate | undefined;
    let caseNumber = 0;
    let expectedNonReads = 0;
    let nonReadsBefore = 0;

    beforeAll(async () => {
      prepared = await prepare(layout, launch);
      const { site, database, profileId, document, createPlan } = prepared;
      // 承認の前の人の確かめ（副作用の確認）と照合の READ を足して保存し、本番の推した入力の規則を付ける。
      approved = approveSpaCreateDraft(database, {
        site, profileId, document, plan: createPlan, scenarioId: `scenario-${profileId}`, readCheckId: `rc-${profileId}`, baseDate: BASE_DATE, at: nowText,
      });
      nonReadsBefore = spaNonReadCountOf(site);
    }, SUITE_TIMEOUT_MS);

    afterAll(async () => {
      await cleanUp(prepared, expectedNonReads, nonReadsBefore);
    }, SUITE_TIMEOUT_MS);

    /** 次の実行の許可の、書き込みの開始の指定と生成した値。 */
    const nextWrite = () => {
      if (prepared === undefined || approved === undefined) throw new Error('not prepared');
      return approved.writeFor(`grant-${prepared.profileId}-${String(caseNumber + 1)}`);
    };
    const runWrite = (write: Parameters<typeof runSpaApiWrite>[0]['write']) => {
      if (prepared === undefined) throw new Error('not prepared');
      caseNumber += 1;
      return runSpaApiWrite({
        site: prepared.site, outputDirectory: join(prepared.directory, `output-${String(caseNumber)}`), jobId: `job-arr3-${String(caseNumber)}`,
        write, launchBrowser: launch, login: 'NO_LOGIN',
      });
    };

    it(`probes the rows without sending and approves the field and the empty position of each list (${layout}, ${label})`, () => {
      if (prepared === undefined) throw new Error('not prepared');
      const probe = saveButtonOf(prepared.document, SPA_APP_PATHS.memberNew).submissionProbe;
      expect(probe).toMatchObject({ result: 'API_CREATE', reason: null, shape: { method: 'POST', origin: { kind: 'APPROVED_TEST', index: 0 } } });
      expect(prepared.discoveryNonReads).toBe(0);
      const arrayKeyFields = approved?.revision.api?.keyFields.filter(({ type }) => type === 'array');
      expect(arrayKeyFields?.map(({ key, positions, rows }) => [key, positions ?? rows])).toEqual(keyRoles.map(([key, roles]) => [key, roles]));
      expect(approved?.revision.api?.pageKeys.filter(({ type }) => type === 'array')).toEqual([]);
    }, TEST_TIMEOUT_MS);

    it(`sends the approved create once, with the generated value and the empty value in each list (${layout}, ${label})`, async () => {
      if (prepared === undefined) throw new Error('not prepared');
      const { site } = prepared;
      const since = site.requests.length;
      const bodiesBefore = site.memberCreateBodies.length;
      const { write, values } = nextWrite();
      for (const [key] of keyRoles) expect(typeof values[key]).toBe('string');
      const { document, payloadBlocks } = await runWrite(write);
      expectedNonReads += 1;
      expect(document).toMatchObject({ transport: 'API', submission: 'SENT', blockReason: null, result: 'VERIFIED' });
      expect(blockedPayloadCountOf(payloadBlocks)).toBe(0);
      expect(spaMemberRequestCountOf(site, 'POST', since)).toBe(1);
      expect(site.memberCreateBodies.slice(bodiesBefore)).toEqual([expect.objectContaining({
        ...listsOf(values), name: values['name'], email: values['email'],
      })]);
      expect(spaNonReadCountOf(site) - nonReadsBefore).toBe(expectedNonReads);
    }, TEST_TIMEOUT_MS);

    const ownHostileSaves = hostileSaves.filter((save) => FIRST_LAYOUT_OF_HOSTILE.get(hostileFamilyOf(layout, save)) === layout);
    it.runIf(ownHostileSaves.length > 0).each(ownHostileSaves.length > 0 ? ownHostileSaves : hostileSaves)(`does not send when the page changes the list (%s, ${layout}, ${label})`, async (hostile) => {
      if (prepared === undefined) throw new Error('not prepared');
      const { site } = prepared;
      site.setHostileMemberSave(hostile);
      try {
        const since = site.requests.length;
        const { document, payloadBlocks } = await runWrite(nextWrite().write);
        expect(document).toMatchObject({ submission: 'NOT_SENT', reservationState: 'RELEASED' });
        // 止めた証拠: 送る前の照合が止めた（入れ子は値が scalar でない理由、ほかは値の違い）。
        // ARR-5: object の行の中を深くした形は、行の値の違い（照合は行の中の値を完全一致で照らす）。
        const nestedReason = layout.startsWith('obj') ? 'BODY_VALUE_MISMATCH' : 'BODY_VALUE_NOT_SCALAR';
        expect(payloadBlocks[hostile === 'rowsNested' ? nestedReason : 'BODY_VALUE_MISMATCH']).toBeGreaterThan(0);
        expect(spaMemberRequestCountOf(site, 'POST', since)).toBe(0);
        expect(spaNonReadCountOf(site) - nonReadsBefore).toBe(expectedNonReads);
      } finally {
        site.setHostileMemberSave(null);
      }
    }, TEST_TIMEOUT_MS);
  });

  // ARR-5 fix round 1（SREV-ARR2 の C1）: 行の中に論理削除・削除の語の鍵（`purged: null`・`delete: ""`）を空の値で入れる形は、承認が拒み、書き込みに
  // 進まない（届いた数 0。名前つきの時間だけ待って数え直す）。
  describe.each(['objPurged', 'objDelete'] as const)(`the %s form (${label})`, (layout) => {
    let prepared: Prepared | undefined;
    let nonReadsBefore = 0;
    beforeAll(async () => {
      prepared = await prepare(layout, launch);
      nonReadsBefore = spaNonReadCountOf(prepared.site);
    }, SUITE_TIMEOUT_MS);
    afterAll(async () => {
      await cleanUp(prepared, 0, nonReadsBefore);
    }, SUITE_TIMEOUT_MS);

    it(`rejects the rows with an inner key of a removal and does not go on to the write (${layout}, ${label})`, () => {
      if (prepared === undefined) throw new Error('not prepared');
      expect(saveButtonOf(prepared.document, SPA_APP_PATHS.memberNew).submissionProbe).toMatchObject({ result: 'API_CREATE', reason: null });
      expect(prepared.discoveryNonReads).toBe(0);
      expect(prepared.createPlan).toMatchObject({ status: 'REJECTED', reason: 'SCENARIO_API_ARRAY_INNER_KEY_NOT_ALLOWED' });
      expect(prepared.site.memberCreateBodies).toEqual([]);
    }, TEST_TIMEOUT_MS);
  });

  // DEF-226・ARR-2（設計書 `2026-11-08-beaksight-api-array-keys-design.md` 3.3 の 2、3.4、7 章。W-FIX で `def-226-array-key-write.test.ts` から移した。
  // Browser を共有する）: 保存の JSON の本文に一覧の値（札の欄の文字が入る `labels: ["<値>"]`、ページが決める `holders: ["u-1"]` と空の `makers: []`）を
  // 含める登録の画面（`memberArrayKeys`）。送り先の 2 つの形（テスト用のサイト自身の API・ログインなし、承認した API の Origin・スクリプトで送るログイン）
  // で、操作さがしは送らず、承認した登録が 1 回だけ届く。ページが一覧を崩した形（数・要素の型・入れ子・欄の一覧に別の値）は届いた数 0。崩しは、送り先の形で
  // 照合が変わらないので、最初の形だけで 1 回ずつ流す（照合は単体 `write-payload-update`・`arr-*` が確かめる）。
  describe.each<readonly ['APPROVED_TEST' | 'APPROVED_API', SpaRunLogin]>([
    ['APPROVED_TEST', 'NO_LOGIN'],
    ['APPROVED_API', 'SCRIPT_LOGIN'],
  ])(`DEF-226 (ARR-2): the array keys to the %s origin (${label})`, (originKind, login) => {
    const profileId = `example-def226-${originKind === 'APPROVED_TEST' ? 'test' : 'api'}-default`;
    let site: SpaAuthSite;
    let directory = '';
    let database: ControlDatabase | undefined;
    let document: DiscoveryDocument;
    let discoveryNonReads = -1;
    let approved: ApprovedSpaCreate | undefined;
    let caseNumber = 0;
    let expectedNonReads = 0;
    let nonReadsBefore = 0;

    beforeAll(async () => {
      site = await startSpaAuthSite({
        memberScreenLayout: 'formless', memberDetailPage: true, memberArrayKeys: true, ...(originKind === 'APPROVED_TEST' ? { sameOriginBackend: true } : {}),
      });
      directory = await mkdtemp(join(tmpdir(), 'beaksight-def226-'));
      // 承認した API の Origin の形は、バックエンドをサービスの Origin にする。
      const approvedServiceOrigins = originKind === 'APPROVED_API' ? [site.backendOrigin] : [];
      database = await openSpaWriteProfile(site, directory, profileId, login === 'NO_LOGIN' ? null : approvedServiceOrigins);
      const beforeDiscovery = spaNonReadCountOf(site);
      document = await discoverSpaMemberScreens(site, join(directory, 'discovery'), launch, { login });
      discoveryNonReads = spaNonReadCountOf(site) - beforeDiscovery;
      const candidates = recordSpaDiscoveryJob(database, profileId, document, nowText());
      approved = approveSpaCreateDraft(database, {
        site, profileId, document, plan: spaCreateAutoDraftPlanOf(site, profileId, candidates, approvedServiceOrigins),
        scenarioId: `scenario-def226-${profileId}`, readCheckId: `rc-def226-${profileId}`, baseDate: BASE_DATE, at: nowText,
      });
      nonReadsBefore = spaNonReadCountOf(site);
    }, SUITE_TIMEOUT_MS);

    afterAll(async () => {
      if (site !== undefined) await expectSettledSpaNonReads(site, nonReadsBefore, expectedNonReads);
      if (database !== undefined) closeControlDatabase(database);
      await site?.close();
      if (directory !== '') await rm(directory, { recursive: true, force: true });
    }, SUITE_TIMEOUT_MS);

    const runNextWrite = () => {
      if (approved === undefined) throw new Error('not prepared');
      const next = approved.writeFor(`grant-def226-${profileId}-${String(caseNumber + 1)}`);
      caseNumber += 1;
      return {
        values: next.values,
        run: () => runSpaApiWrite({
          site, outputDirectory: join(directory, `output-${String(caseNumber)}`), jobId: `job-def226-${String(caseNumber)}`, write: next.write,
          launchBrowser: launch, login,
        }),
      };
    };

    it(`probes the array keys without sending, approves them, and sends the create once with the expected lists (${originKind}, ${label})`, async () => {
      const probe = saveButtonOf(document, SPA_APP_PATHS.memberNew).submissionProbe;
      expect(probe).toMatchObject({ result: 'API_CREATE', reason: null, shape: { method: 'POST', origin: { kind: originKind, index: 0 }, pathShape: SPA_BACKEND_PATHS.members } });
      expect(discoveryNonReads).toBe(0);
      // 欄の一覧の鍵（札の欄 × 文字の一覧）とページが決める一覧の鍵（要素の型の集合と数）を承認の内容に持つ。値は持たない。
      expect(approved?.revision.api?.keyFields.find(({ key }) => key === 'labels')).toEqual({
        key: 'labels', type: 'array', field: { kind: 'NAME', name: SPA_ARRAY_KEYS.labelFieldId }, fieldType: 'text',
      });
      expect(approved?.revision.api?.pageKeys.filter(({ type }) => type === 'array')).toEqual([
        { key: 'holders', type: 'array', elements: { types: ['string'], count: 1 } },
        { key: 'makers', type: 'array', elements: { types: [], count: 0 } },
      ]);
      expect(JSON.stringify(approved?.revision)).not.toContain(SPA_ARRAY_KEYS.holderId);

      const since = site.requests.length;
      const bodiesBefore = site.memberCreateBodies.length;
      const { values, run } = runNextWrite();
      expect(typeof values['labels']).toBe('string');
      const { document: written, payloadBlocks } = await run();
      expectedNonReads += 1;
      expect(written).toMatchObject({ transport: 'API', submission: 'SENT', blockReason: null, result: 'VERIFIED' });
      expect(blockedPayloadCountOf(payloadBlocks)).toBe(0);
      expect(spaMemberRequestCountOf(site, 'POST', since)).toBe(1);
      expect(site.memberCreateBodies.slice(bodiesBefore)).toEqual([expect.objectContaining({
        labels: [values['labels']], holders: [SPA_ARRAY_KEYS.holderId], makers: [], name: values['name'], email: values['email'],
      })]);
      // ページが決める一覧の値は、記録に JSON の文字で残る。
      expect(written.api?.pageKeyValues).toEqual({ holders: JSON.stringify([SPA_ARRAY_KEYS.holderId]), makers: '[]' });
      expect(spaNonReadCountOf(site) - nonReadsBefore).toBe(expectedNonReads);
    }, TEST_TIMEOUT_MS);

    it.runIf(originKind === 'APPROVED_TEST').each<readonly [string, SpaHostileMemberSave, string]>([
      ['changes the count of a page list', 'arrayCountChanged', 'BODY_VALUE_MISMATCH'],
      ['changes the element type of a page list', 'arrayTypeChanged', 'BODY_VALUE_MISMATCH'],
      ['nests a page list', 'arrayNested', 'BODY_VALUE_NOT_SCALAR'],
      ['adds another value to the field list', 'arrayFieldExtra', 'BODY_VALUE_MISMATCH'],
    ])(`does not send when the page %s (${originKind}, ${label})`, async (_name, hostile, reason) => {
      site.setHostileMemberSave(hostile);
      try {
        const since = site.requests.length;
        const { document: written, payloadBlocks } = await runNextWrite().run();
        expect(written).toMatchObject({ submission: 'NOT_SENT', reservationState: 'RELEASED' });
        // 止めた証拠: 送る前の照合が、その理由で止めた。
        expect(payloadBlocks[reason]).toBeGreaterThan(0);
        expect(spaMemberRequestCountOf(site, 'POST', since)).toBe(0);
        expect(spaNonReadCountOf(site) - nonReadsBefore).toBe(expectedNonReads);
      } finally {
        site.setHostileMemberSave(null);
      }
    }, TEST_TIMEOUT_MS);
  });
});
