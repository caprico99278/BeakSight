// CC-031（C18k）: 外部スキームの宛先の値の複製が、`fixtures/external-scheme-targets.ts` の `EXTERNAL_SCHEME_TARGETS` と
// 同じであることを確かめる。
// - 値の定義は `fixtures/external-scheme-targets.ts` の1か所だけにある。fixture のサーバ（`fixtures/server.ts`）と、テストの補助
//   （`tests/helpers/external-scheme-fixture.ts`。値を export し直す）は、そこから import する。
// - fixture の HTML（ブラウザの中で動くスクリプト）は、TypeScript の値を import できない。サーバは HTML を、そのまま配る
//   （置き換えは robots.txt と sitemap.xml だけ）。宛先を別のリクエストで読ませると、Gate が数えるリクエストが変わる。
//   そのため、HTML の中の一覧は複製のまま残し、ここで同じ値であることを確かめる。
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  EXTERNAL_SCHEME_BUTTON_PAGE,
  EXTERNAL_SCHEME_KEYS,
  EXTERNAL_SCHEME_NAVIGATION_PAGE,
  EXTERNAL_SCHEME_TARGETS,
} from '../helpers/external-scheme-fixture.js';

/** 外部スキームの宛先の一覧（`const destinations = { ... };`）を持つ、fixture の HTML のパス名。 */
const HTML_PAGES_WITH_DESTINATIONS = Object.freeze([EXTERNAL_SCHEME_NAVIGATION_PAGE, EXTERNAL_SCHEME_BUTTON_PAGE] as const);

/** `EXTERNAL_SCHEME_TARGETS` の、名前から宛先の URL への一覧。 */
const expectedDestinations = (): Record<string, string> =>
  Object.fromEntries(EXTERNAL_SCHEME_KEYS.map((key) => [key, EXTERNAL_SCHEME_TARGETS[key].url]));

/**
 * HTML のスクリプトの `const destinations = { ... };` の項目（`名前: '宛先'`）を読む。一覧がないか、
 * `名前: '宛先'` の形でない行がある場合は投げる（読み違えて、確かめが空振りしないようにする）。
 */
function readDestinations(html: string): Record<string, string> {
  const block = /const destinations = \{\r?\n([\s\S]*?)\r?\n\s*\};/u.exec(html)?.[1];
  if (block === undefined) {
    throw new Error('the fixture HTML has no destinations list');
  }
  return Object.fromEntries(block.split(/\r?\n/u).map((line) => {
    const entry = /^\s*([\w-]+): '([^']*)',?$/u.exec(line);
    if (entry === null) {
      throw new Error(`unexpected line in the destinations list: ${line}`);
    }
    return [entry[1], entry[2]];
  }));
}

describe('external scheme destinations of the fixture HTML (CC-031)', () => {
  it.each(HTML_PAGES_WITH_DESTINATIONS)('%s has the same destinations as EXTERNAL_SCHEME_TARGETS', async (pathname) => {
    const html = await readFile(new URL(`../../fixtures/site${pathname}`, import.meta.url), 'utf8');

    expect(readDestinations(html)).toEqual(expectedDestinations());
  });

  it('reads every entry of a destinations list, so that a changed value is detected', () => {
    const html = `<script>
      const destinations = {
        tel: 'tel:+10000000000',
        mailto: 'mailto:someone-else@example.invalid',
        custom: 'beaksight-test-app:probe',
      };
    </script>`;

    expect(readDestinations(html)).toEqual({
      tel: 'tel:+10000000000',
      mailto: 'mailto:someone-else@example.invalid',
      custom: 'beaksight-test-app:probe',
    });
    expect(readDestinations(html)).not.toEqual(expectedDestinations());
    expect(() => readDestinations('<script>const other = {};</script>')).toThrow('no destinations list');
  });
});
