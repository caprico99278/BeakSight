// T27R-fix-2（T27R-fix-1 の報告の発見事項 3）: 発見の入口（`discoverPageCandidates`）が、送信ボタンの文言を `input` の `value` と画像の送信ボタン
// （`input type=image`）の `alt` から読み、分類の語（`submitterWords`）に変えることを、本物の factory の Passive の Context（Guard つき）と、127.0.0.1
// の fixture のサーバ（`tests/helpers/submitter-words-fixture.ts`）で確かめる。Chromium は headless だけ（テストの既定と、CLI の起動の設定の両方）。
// - DEF-086 の後、候補は文言を持たないので、語のある文言を置いた所（`value`、`alt`）から語が出ることで、probe がその所を読んだことを確かめる。
// - 対照: 語を probe が読まない属性（`data-label`、`name`、submit の `alt`、image の `value`）にだけ置いた form は、語が 0 件になる（語が別の所から
//   出ていないこと）。
// - 発見の間に、サーバに届いた GET 以外の要求は 0 件。
import type { Browser, BrowserContext } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import type { DiscoveryCandidate } from '../../src/discovery/candidate-contracts.js';
import { discoverPageCandidates } from '../../src/discovery/discover-page.js';
import { InFlightRequestCounter } from '../../src/discovery/settle.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import { READ_METHODS } from '../helpers/leak-places.js';
import { closePassiveResources } from '../helpers/passive-cleanup.js';
import { SUBMITTER_WORDS_FIXTURE_PATHS, startSubmitterWordsFixture, type SubmitterWordsFixture } from '../helpers/submitter-words-fixture.js';
import { createTestConfig, TEST_FACTORY_OPTIONS } from '../helpers/test-config.js';

const LAUNCHERS = [
  ['the default test Chromium', () => launchHeadlessChromium()],
  ['the CLI launch settings', () => launchCliChromium()],
] as const;

/** 候補の、比べる項目（種類、送信先の path、語、分類）。 */
const summaryOf = (candidate: DiscoveryCandidate): readonly unknown[] =>
  [candidate.kind, candidate.action?.path ?? null, candidate.submitterWords, candidate.classification];

describe.each(LAUNCHERS)('T27R-fix-2: the submitter words read from an input value and an image alt (%s)', (_name, launch) => {
  let browser: Browser;
  let fixture: SubmitterWordsFixture;
  const resources: { factory: BrowserContextFactory; context: BrowserContext }[] = [];

  beforeAll(async () => {
    browser = await launch();
    fixture = await startSubmitterWordsFixture();
  });

  afterEach(async () => {
    for (const resource of resources.splice(0)) {
      await closePassiveResources(resource);
      await resource.factory.close();
    }
  });

  afterAll(async () => {
    // 全体で、GET と HEAD 以外の要求は 1 件もサーバに届かない。
    expect(fixture?.requests.filter(({ method }) => !READ_METHODS.has(method)) ?? []).toEqual([]);
    await fixture?.close();
    await browser?.close();
  });

  /** Guard つきの Passive の Context で画面を開き、候補を読む。 */
  const discover = async (path: string): Promise<readonly DiscoveryCandidate[]> => {
    const config = createTestConfig(fixture.origin);
    const factory = new BrowserContextFactory(browser, config, () => new SafetyLedger(), TEST_FACTORY_OPTIONS);
    const context = await factory.createPassiveContext(config.viewports.primaryDesktop);
    resources.push({ factory, context });
    const page = await factory.createPassivePage(context);
    const counter = new InFlightRequestCounter(page);
    await page.goto(fixture.url(path));
    const record = await discoverPageCandidates(page, { classificationPolicy: { allowedOrigins: new Set([fixture.origin]) }, requestCounter: counter });
    counter.dispose();
    expect(record.incompleteReasons, path).toEqual([]);
    return record.candidates;
  };

  it('reads the words from the value of input buttons (submit, reset and button)', async () => {
    const candidates = await discover(SUBMITTER_WORDS_FIXTURE_PATHS.inputValue);
    expect(candidates.map(summaryOf)).toEqual(expect.arrayContaining([
      ['FORM', '/items/remove', ['削除'], 'NOT_EXECUTABLE'],
      ['FORM', '/items/save', ['save'], 'UPDATE'],
      ['FORM', '/items/other', [], 'DISPLAY_ONLY'],
      // form の中のリセット（`value` の `取消`）と、form の外の `input type=button`（`value` の `編集`）。
      ['BUTTON', null, ['取消'], 'NOT_EXECUTABLE'],
      ['BUTTON', null, ['編集'], 'DISPLAY_ONLY'],
    ]));
    expect(candidates).toHaveLength(5);
  });

  it('reads the words from the alt of image submit buttons', async () => {
    const candidates = await discover(SUBMITTER_WORDS_FIXTURE_PATHS.imageAlt);
    expect(candidates.map(summaryOf)).toEqual([
      ['FORM', '/items', ['検索'], 'READ'],
      ['FORM', '/items/drop', ['削除'], 'NOT_EXECUTABLE'],
    ]);
  });

  it('does not take words from the attributes that it does not read (the control)', async () => {
    const candidates = await discover(SUBMITTER_WORDS_FIXTURE_PATHS.notRead);
    expect(candidates.map(summaryOf)).toEqual([
      ['FORM', '/items/a', [], 'DISPLAY_ONLY'],
      ['FORM', '/items/b', [], 'DISPLAY_ONLY'],
    ]);
  });
});
