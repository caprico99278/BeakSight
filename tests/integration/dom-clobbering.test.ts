// DEF-069: form の中の名前つきの入力の欄が、form の標準のプロパティを隠す（DOM clobbering）ページで、DOM の Evidence の収集
// （`collectDomEvidence`）と Interaction の候補の発見（`discoverInteractionCandidates`、保持した要素の読み取り）が落ちずに、標準の値を記録する
// ことを確かめる。fixture（`fixtures/site/dom-clobbered-forms.html`）は、名前ごとに 1 つの form を持ち、その form の中に、その名前の入力の欄と
// 送信のボタンを置く。form 自身も候補（`aria-expanded`）にして、候補の発見が form そのものを読む経路も確かめる。
// Chromium は headless だけ（テストの既定と、CLI の起動の設定の両方）。サーバは 127.0.0.1 の fixture のサーバだけ。
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';
import { createPageId } from '../../src/core/ids.js';
import { collectDomEvidence } from '../../src/evidence/dom-collector.js';
import {
  discoverInteractionCandidates,
  inspectInteractionCandidateHandle,
  resolveInteractionCandidateHandle,
} from '../../src/interaction/discover-candidates.js';
import { launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';

const LAUNCHERS = [
  ['the default test Chromium', () => launchHeadlessChromium()],
  ['the CLI launch settings', () => launchCliChromium()],
] as const;

const FIXTURE_PATH = '/dom-clobbered-forms.html';

/**
 * fixture の form の中の入力の欄の名前（文書の順）。どれも、form の標準のプロパティかメソッドの名前で、form のその名前の読み取りを、入力の欄に
 * 置き換える。form の固有のもの（method など）と、要素・ノードに共通のもの（tagName など）を含む。
 */
const CLOBBERING_FIELD_NAMES = [
  'method',
  'action',
  'target',
  'enctype',
  'elements',
  'id',
  'getAttribute',
  'hasAttribute',
  'tagName',
  'nodeType',
  'childNodes',
  'shadowRoot',
  'parentElement',
  'parentNode',
  'assignedSlot',
  'closest',
  'matches',
  'checkVisibility',
  'getBoundingClientRect',
  'attributes',
  'isConnected',
] as const;

/** 名前が `id` の欄を持つ form の id。fixture の div と同じ id にしてあり、標準の読み方で読めば、重複の id として記録される。 */
const DUPLICATED_FORM_ID = 'duplicated-form';
const DUPLICATED_ID_COUNT = 2;
/** fixture の form の `method` 属性の、標準の値（ブラウザの `method` のプロパティは小文字）。 */
const STANDARD_FORM_METHOD = 'post';
const actionPathOf = (name: string): string => `/clobbered/${name}`;
/** 1 つの form の、候補の数（form 自身と送信のボタン）。 */
const CANDIDATES_PER_FORM = 2;

let server: FixtureServer;

beforeAll(async () => {
  server = await startFixtureServer();
});

afterAll(async () => {
  await server.close();
});

describe.each(LAUNCHERS)('DEF-069: DOM clobbering of form properties (%s)', (_name, launch) => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await launch();
  });

  afterAll(async () => {
    await browser.close();
  });

  const withFixturePage = async (body: (page: Page) => Promise<void>): Promise<void> => {
    const page = await browser.newPage();
    try {
      await page.goto(`${server.origin}${FIXTURE_PATH}`);
      await body(page);
    } finally {
      await page.close();
    }
  };

  it('hides the named standard property of every fixture form behind its field (the fixture really clobbers)', async () => {
    await withFixturePage(async (page) => {
      const clobbered = await page.evaluate((names) => names.map((name) => {
        const form = document.querySelector(`form[aria-label="Form ${name}"]`);
        return form instanceof HTMLFormElement && (form as unknown as Record<string, unknown>)[name] instanceof HTMLInputElement;
      }), [...CLOBBERING_FIELD_NAMES]);
      expect(clobbered).toEqual(CLOBBERING_FIELD_NAMES.map(() => true));
    });
  });

  it('collects DOM Evidence with the standard method, action, fields, submit controls, form regions, and duplicated ids', async () => {
    await withFixturePage(async (page) => {
      const evidence = await collectDomEvidence(page, createPageId(1));

      expect(evidence.forms.map(({ method, action }) => ({ method, action }))).toEqual(
        CLOBBERING_FIELD_NAMES.map((name) => ({ method: STANDARD_FORM_METHOD, action: actionPathOf(name) })),
      );
      expect(evidence.forms.map(({ fields }) => fields.map(({ type, name, labels }) => ({ type, name, labels })))).toEqual(
        CLOBBERING_FIELD_NAMES.map((name) => [{ type: 'text', name, labels: [`Field ${name}`] }]),
      );
      expect(evidence.forms.map(({ submitControls }) => submitControls.map(({ type, name, value, text }) => ({ type, name, value, text }))))
        .toEqual(CLOBBERING_FIELD_NAMES.map((name) => [{ type: 'submit', name: 'send', value: name, text: `Send ${name}` }]));
      expect(evidence.truncation.omittedFormCount).toBe(0);
      expect(evidence.unassociatedFields).toEqual([]);
      expect(evidence.visibleText.regions.filter(({ kind }) => kind === 'form')).toEqual(
        CLOBBERING_FIELD_NAMES.map((name) => ({ kind: 'form', text: `Field ${name} Send ${name}`, ariaHidden: false, truncated: false })),
      );
      expect(evidence.duplicateIds).toEqual([{ id: DUPLICATED_FORM_ID, count: DUPLICATED_ID_COUNT, truncated: false }]);
    });
  });

  it('discovers the forms and their submit buttons with the standard method and resolved action', async () => {
    await withFixturePage(async (page) => {
      const discovery = await discoverInteractionCandidates(page);

      expect(discovery.completeness).toBe('COMPLETE');
      expect(discovery.candidates.map(({ tagName, accessibleName, formAssociated, formMethod, formAction, visible }) => ({
        tagName, accessibleName, formAssociated, formMethod, formAction, visible,
      }))).toEqual(CLOBBERING_FIELD_NAMES.flatMap((name) => [
        { tagName: 'form', accessibleName: `Form ${name}`, formAssociated: false, formMethod: null, formAction: null, visible: true },
        {
          tagName: 'button',
          accessibleName: `Send ${name}`,
          formAssociated: true,
          formMethod: STANDARD_FORM_METHOD,
          formAction: `${server.origin}${actionPathOf(name)}`,
          visible: true,
        },
      ]));
    });
  });

  it('inspects the retained forms and buttons with complete scroll and attribute records', async () => {
    await withFixturePage(async (page) => {
      const discovery = await discoverInteractionCandidates(page);
      expect(discovery.candidates).toHaveLength(CLOBBERING_FIELD_NAMES.length * CANDIDATES_PER_FORM);
      for (const candidate of discovery.candidates) {
        const resolution = await resolveInteractionCandidateHandle(page, candidate.ordinal);
        if (resolution.status !== 'FOUND') throw new Error(`Expected candidate ${candidate.ordinal}`);
        try {
          const snapshot = await inspectInteractionCandidateHandle(resolution.reference, candidate.ordinal);
          expect(snapshot).toMatchObject({
            status: 'CONNECTED',
            candidate: { candidateId: candidate.candidateId, ordinal: candidate.ordinal },
            scroll: { status: 'RECORDED' },
            attributes: { status: 'RECORDED' },
          });
        } finally {
          await resolution.reference.handle.dispose();
        }
      }
    });
  });
});
