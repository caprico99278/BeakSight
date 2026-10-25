// T27R2 の I3: 目印の検査（`apps/local-ui/tests/discovery-secret-markers.test.ts`）に足した目印の形（fixture の `markerShapes` の画面。form の中の
// 送信ボタンの `value`、画像の送信ボタンの `alt`、`<label>`（`for` と包む形）、`aria-labelledby`・`aria-describedby`）が、fixture の誤りで空振り
// していないことを、本物の Chromium（headless だけ。テストの既定と、CLI の起動の設定の両方）と 127.0.0.1 の fixture のサーバで確かめる。
// - main world の確かめ: 同じ画面を普通の Context（Guard なし。セッションの Cookie だけ足す）で開き、ページの main world で、目印を置いた要素が
//   期待の形（送信ボタンが form に属する、ラベルが欄に結び付く、ARIA の参照の先がある）であること、その所の文字に行の目印があることを確かめる
//   （値はテストの process の中だけ。真偽だけを比べる）。
// - probe の確かめ: 発見のジョブの流れ（`executeDiscoveryRun`）でその画面を読み、3 つの form が候補になり、送信ボタンの `value` と画像の `alt` から
//   分類の語（`検索`）が出る（probe がその所を読んだ）ことと、`discovery.json` に秘密の目印が出ないことを確かめる。
// - サイトへの要求は GET（と HEAD）だけ。
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateArtifact } from '../../src/core/schema-validator.js';
import { launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import {
  DISCOVERY_SITE_EXTRA_PATHS,
  DISCOVERY_SITE_MARKER_SHAPE_IDS,
  DISCOVERY_SITE_SESSION_COOKIE,
  startDiscoverySite,
  type DiscoverySite,
} from '../helpers/discovery-site-fixture.js';
import { runDiscoveryOnSite } from '../helpers/discovery-site-run.js';
import { READ_METHODS } from '../helpers/leak-places.js';

const LAUNCHERS = [
  ['the default test Chromium', () => launchHeadlessChromium()],
  ['the CLI launch settings', () => launchCliChromium()],
] as const;
const TEST_TIMEOUT_MS = 120_000;
/** 目印の形の画面の form の数と、読む画面の数（目印の形の画面だけ。リンクはない）。 */
const MARKER_SHAPE_FORMS = 3;
const ONE_PAGE = 1;
/** 読み込みの最小の間隔（ms。1 画面だけなので、間隔は待たない）。 */
const NAVIGATION_INTERVAL_MS = 0;

/** main world で読む、目印を置いた所の形と文字（値はテストの process の中だけ）。 */
interface ShapeFacts {
  /** 要素が期待の形か（送信ボタンが form に属する、ラベルが欄に結び付く、ARIA の参照の先がある）。 */
  readonly shaped: Readonly<Record<string, boolean>>;
  /** 目印を置いた所の文字。 */
  readonly texts: Readonly<Record<string, string>>;
}

/** ページの main world で動かす（外を参照しない）。 */
function readShapeFactsInPage(ids: typeof DISCOVERY_SITE_MARKER_SHAPE_IDS): ShapeFacts {
  const byId = (id: string): HTMLElement | null => document.getElementById(id);
  const referencedText = (element: HTMLElement | null, attribute: string): string | null => {
    const references = (element?.getAttribute(attribute) ?? '').split(/\s+/u).filter((reference) => reference.length > 0);
    const targets = references.map((reference) => byId(reference));
    return targets.length > 0 && targets.every((target) => target !== null) ? targets.map((target) => target?.textContent ?? '').join(' ') : null;
  };
  const labelsText = (element: HTMLElement | null): string | null => {
    const labels = element instanceof HTMLInputElement ? element.labels : null;
    return labels === null || labels.length === 0 ? null : [...labels].map((label) => label.textContent ?? '').join(' ');
  };
  const submit = byId(ids.submitValue);
  const image = byId(ids.imageAlt);
  const labelFor = byId(ids.labelFor);
  const wrapped = byId(ids.labelWrapped);
  const ariaField = byId(ids.ariaField);
  const ariaButton = byId(ids.ariaButton);
  const texts = {
    submitValue: submit instanceof HTMLInputElement ? submit.value : null,
    imageAlt: image instanceof HTMLInputElement ? image.alt : null,
    labelFor: labelsText(labelFor),
    labelWrapped: labelsText(wrapped),
    fieldLabelledBy: referencedText(ariaField, 'aria-labelledby'),
    fieldDescribedBy: referencedText(ariaField, 'aria-describedby'),
    buttonLabelledBy: referencedText(ariaButton, 'aria-labelledby'),
    buttonDescribedBy: referencedText(ariaButton, 'aria-describedby'),
  };
  return {
    shaped: {
      submitInForm: submit instanceof HTMLInputElement && submit.type === 'submit' && submit.form !== null,
      imageInForm: image instanceof HTMLInputElement && image.type === 'image' && image.form !== null,
      labelForIsNotWrapping: labelFor !== null && labelFor.closest('label') === null,
      labelWrapsField: wrapped !== null && wrapped.closest('label') !== null,
      ariaButtonSubmits: ariaButton instanceof HTMLButtonElement && ariaButton.type === 'submit' && ariaButton.form !== null,
      everyTextFound: Object.values(texts).every((text) => text !== null),
    },
    texts: Object.fromEntries(Object.entries(texts).map(([name, text]) => [name, text ?? ''])),
  };
}

describe.each(LAUNCHERS)('T27R2 I3: the marker shapes of the discovery fixture are readable and are read by the probe (%s)', (_name, launch) => {
  let site: DiscoverySite;
  let outputDirectory: string;

  beforeEach(async () => {
    site = await startDiscoverySite({ markerShapes: true });
    outputDirectory = await mkdtemp(join(tmpdir(), 'beaksight-marker-shapes-'));
  });

  afterEach(async () => {
    // 全体で、GET と HEAD 以外の要求は 1 件もサーバに届かない。
    expect(site.requests.filter(({ method }) => !READ_METHODS.has(method))).toEqual([]);
    await site.close();
    await rm(outputDirectory, { recursive: true, force: true });
  });

  /** 文字に秘密の目印があるか（値は出さない）。 */
  const hasMarker = (text: string): boolean => site.secretValues().some((marker) => text.includes(marker));

  it('places a row marker in every shape, readable in the main world of the page', async () => {
    const browser: Browser = await launch();
    try {
      const context = await browser.newContext();
      await context.addCookies([{ name: DISCOVERY_SITE_SESSION_COOKIE, value: site.issueSession(), url: site.origin }]);
      const page = await context.newPage();
      const response = await page.goto(`${site.origin}${DISCOVERY_SITE_EXTRA_PATHS.markerShapes}`);
      expect(response?.status()).toBe(200);
      const facts = await page.evaluate(readShapeFactsInPage, DISCOVERY_SITE_MARKER_SHAPE_IDS);
      expect(facts.shaped).toEqual({
        submitInForm: true, imageInForm: true, labelForIsNotWrapping: true, labelWrapsField: true, ariaButtonSubmits: true, everyTextFound: true,
      });
      expect(Object.fromEntries(Object.entries(facts.texts).map(([name, text]) => [name, hasMarker(text)]))).toEqual({
        submitValue: true,
        imageAlt: true,
        labelFor: true,
        labelWrapped: true,
        fieldLabelledBy: true,
        fieldDescribedBy: true,
        buttonLabelledBy: true,
        buttonDescribedBy: true,
      });
      // ARIA の参照のボタンは、ボタンの文字には目印がない（目印は参照の先だけにある）。
      expect(hasMarker(await page.locator(`#${DISCOVERY_SITE_MARKER_SHAPE_IDS.ariaButton}`).innerText())).toBe(false);
      await context.close();
    } finally {
      await browser.close();
    }
  }, TEST_TIMEOUT_MS);

  it('discovers the three forms, takes the word from the submit value and the image alt, and writes no marker into discovery.json', async () => {
    const run = await runDiscoveryOnSite({
      site,
      startPath: DISCOVERY_SITE_EXTRA_PATHS.markerShapes,
      outputDirectory,
      launchBrowser: launch,
      maxPages: ONE_PAGE,
      minNavigationIntervalMs: NAVIGATION_INTERVAL_MS,
      jobId: 'job-marker-shapes',
    });
    expect(run.outcome).toMatchObject({ kind: 'RAN', runStatus: 'COMPLETE' });
    if (run.document === null || run.documentText === null) {
      throw new Error('the discovery did not run');
    }
    expect((await validateArtifact('discovery', run.document)).ok).toBe(true);
    const [page] = run.document.pages;
    if (page?.state !== 'READ') {
      throw new Error('the page of the marker shapes was not read');
    }
    expect(new URL(page.url).pathname).toBe(DISCOVERY_SITE_EXTRA_PATHS.markerShapes);
    expect(page.record.incompleteReasons).toEqual([]);
    // 欄の名前（目印ではない）で form を見分ける: `sv` は送信ボタンの `value`、`si` は画像の `alt`、`sa` は ARIA の参照（ボタンの文字は語でない）。
    expect(page.record.candidates.map((candidate) => [candidate.kind, candidate.fields.map(({ name }) => name), candidate.submitterWords])).toEqual([
      ['FORM', ['sv'], ['検索']],
      ['FORM', ['si'], ['検索']],
      ['FORM', ['sa'], []],
    ]);
    expect(page.record.candidates).toHaveLength(MARKER_SHAPE_FORMS);
    // 秘密の目印は、成果物に出ない。
    expect(hasMarker(run.documentText)).toBe(false);
  }, TEST_TIMEOUT_MS);
});
