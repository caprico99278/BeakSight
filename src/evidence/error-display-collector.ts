/**
 * AUD-7（整理の文書 `doc/design/2026-11-09-beaksight-audit-precision-triage.md` の AUD-7）: 画面の誤りの表示の手がかりの読み取り（DOM の Evidence の
 * `errorDisplay`）。
 * - 設計者の判断（2026-11-10）: 画面の誤りの表示と言えるのは、誤りの語（`ERROR_DISPLAY_WORDS`）が、role=alert・aria-live=assertive・見出し・
 *   aria-invalid の欄の近くの文字のどれかにあるときだけ。本文のどこかに語があるだけでは、誤りの表示としない。
 * - ページの中では、その 4 つの所の文字だけを読む（見える要素だけ）。語との照らし合わせは Node の側（`errorDisplayWordsIn`）で行い、文そのものは残さない。
 * - 欄の近くの文字は、欄の `aria-errormessage`・`aria-describedby` が指す要素の文字と、欄の親の要素の文字。
 * - 読めなかったときは `FAILED`（例外を投げない）。要求は送らない。
 */
import type { Page } from 'playwright';
import { errorDisplayWordsIn } from '../core/error-display-words.js';
import { safeErrorMessage } from '../core/errors.js';
import { ERROR_DISPLAY_SOURCES, type ErrorDisplayEvidence, type ErrorDisplaySource } from '../core/evidence-types.js';
import { composeInPage, type StandardReaders } from '../browser/in-page-readers.js';

/** ページの中で探す所の CSS（`ERROR_DISPLAY_SOURCES` の順。欄は、欄そのもの）。 */
const SOURCE_SELECTORS: Readonly<Record<ErrorDisplaySource, string>> = Object.freeze({
  ALERT: '[role="alert"]',
  ASSERTIVE_LIVE: '[aria-live="assertive"]',
  HEADING: 'h1, h2, h3, h4, h5, h6, [role="heading"]',
  INVALID_FIELD: '[aria-invalid="true"]',
});

type RawErrorDisplayTexts = Readonly<Record<ErrorDisplaySource, readonly string[]>>;

function readErrorDisplayTextsReader(
  R: StandardReaders,
  input: { readonly selectors: Readonly<Record<string, string>>; readonly fieldSource: string },
): Record<string, string[]> {
  const textOf = (node: Node): string => String(R.standardProperty<string | null>(Node.prototype, 'textContent', node) ?? '');
  const parentOf = R.standardGetter<Element | null>(Node.prototype, 'parentElement');
  const roots = R.optionalOpenRoots();
  const output: Record<string, string[]> = {};
  for (const [source, selector] of Object.entries(input.selectors)) {
    const texts: string[] = [];
    for (const node of R.queryAllInRoots(roots, selector)) {
      if (!(node instanceof Element) || !R.isVisible(node)) {
        continue;
      }
      if (source !== input.fieldSource) {
        texts.push(textOf(node));
        continue;
      }
      // 欄の近くの文字: 欄が指す誤りの文・説明の要素と、欄の親の要素。
      for (const name of ['aria-errormessage', 'aria-describedby']) {
        for (const id of (Element.prototype.getAttribute.call(node, name) ?? '').split(/\s+/u)) {
          const target = id.length === 0 ? null : document.getElementById(id);
          if (target !== null) {
            texts.push(textOf(target));
          }
        }
      }
      const parent = parentOf(node);
      if (parent !== null) {
        texts.push(textOf(parent));
      }
    }
    output[source] = texts;
  }
  return output;
}
const readErrorDisplayTextsInPage = composeInPage(readErrorDisplayTextsReader);

/** 読んだ文から、誤りの語が見つかった所と語を作る（`ERROR_DISPLAY_SOURCES` の順。語は所ごとに重なりなし、一覧の順）。 */
export function errorDisplayOfTexts(texts: RawErrorDisplayTexts): ErrorDisplayEvidence {
  const matches = ERROR_DISPLAY_SOURCES.flatMap((source) => {
    const found = new Set(texts[source].flatMap((text) => errorDisplayWordsIn(text)));
    const words = errorDisplayWordsIn([...found].join('\n'));
    return words.length === 0 ? [] : [Object.freeze({ source, words: Object.freeze([...words]) })];
  });
  return Object.freeze({ status: 'OBSERVED', matches: Object.freeze(matches) });
}

/** 画面の誤りの表示の手がかりを読む（例外を投げない）。 */
export async function collectErrorDisplay(page: Page): Promise<ErrorDisplayEvidence> {
  try {
    const raw = await page.evaluate(readErrorDisplayTextsInPage, { selectors: SOURCE_SELECTORS, fieldSource: 'INVALID_FIELD' });
    const textsOf = (source: ErrorDisplaySource): readonly string[] => {
      const value: unknown = raw[source];
      return Array.isArray(value) ? value.filter((text): text is string => typeof text === 'string') : [];
    };
    return errorDisplayOfTexts({
      ALERT: textsOf('ALERT'),
      ASSERTIVE_LIVE: textsOf('ASSERTIVE_LIVE'),
      HEADING: textsOf('HEADING'),
      INVALID_FIELD: textsOf('INVALID_FIELD'),
    });
  } catch (error) {
    return Object.freeze({ status: 'FAILED', errorText: safeErrorMessage(error) });
  }
}
