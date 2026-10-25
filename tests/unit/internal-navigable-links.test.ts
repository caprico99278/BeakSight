// CCX-6（共通化の台帳の CC-070）: Link の Evidence から、巡回の候補にする URL（`INTERNAL_NAVIGABLE` で、正規化できたもの）を取り出す表。
// Run Coordinator（Desktop の `link` の Evidence）と、発見のワーカーの流れ（`discoverLinks` の結果）、Cross-page rule（内部のリンクの索引）が、
// 同じ部品（`src/crawl/internal-navigable-links.ts`。PRE42-CC 組 5b で Run Coordinator から移した）を使う。
// - 受け入れの判定が `INTERNAL_NAVIGABLE` で、正規化が `ok` のリンクだけを、正規化した URL にする。
// - 文書の順を保つ。重なりは取り除かない（巡回の待ち行列が扱う）。
// 例の値は、匿名の値（`example.com`）だけを使う。
import { describe, expect, it } from 'vitest';
import type { LinkAdmissionEvidence, LinkEvidence, LinkNormalizationEvidence, NormalizedHttpUrlEvidence } from '../../src/core/evidence-types.js';
import { createPageId } from '../../src/core/ids.js';
import { internalNavigableUrlsOf } from '../../src/crawl/internal-navigable-links.js';

const ORIGIN = 'https://example.com';
const normalized = (url: string): NormalizedHttpUrlEvidence => url as NormalizedHttpUrlEvidence;

/** 1 つのリンクの Evidence（判定に使わない項目は決まった値）。 */
const link = (rawHref: string, admission: LinkAdmissionEvidence, normalization: LinkNormalizationEvidence): LinkEvidence => ({
  sourcePageId: createPageId(1),
  anchorText: rawHref,
  ariaLabel: null,
  title: null,
  rawHref,
  normalized: normalization,
  admission,
  truncated: false,
});

const internal = (path: string): LinkEvidence =>
  link(path, { kind: 'INTERNAL_NAVIGABLE', url: `${ORIGIN}${path}` }, { ok: true, url: normalized(`${ORIGIN}${path}`) });

const cases: readonly { readonly name: string; readonly links: readonly LinkEvidence[]; readonly expected: readonly string[] }[] = [
  { name: 'no links', links: [], expected: [] },
  { name: 'an internal navigable link', links: [internal('/a')], expected: [`${ORIGIN}/a`] },
  {
    name: 'an internal navigable admission whose normalization failed (not a candidate)',
    links: [link('/b', { kind: 'INTERNAL_NAVIGABLE', url: `${ORIGIN}/b` }, { ok: false, rawUrl: '/b', reason: 'URL_TOO_LONG' })],
    expected: [],
  },
  {
    name: 'an external link (record only)',
    links: [link('https://other.example.com/', { kind: 'EXTERNAL_RECORD_ONLY', url: 'https://other.example.com/' }, {
      ok: true,
      url: normalized('https://other.example.com/'),
    })],
    expected: [],
  },
  {
    name: 'a special scheme link (record only)',
    links: [link('mailto:a@example.com', { kind: 'SPECIAL_SCHEME_RECORD_ONLY', rawUrl: 'mailto:a@example.com', scheme: 'mailto' }, {
      ok: false,
      rawUrl: 'mailto:a@example.com',
      reason: 'UNSUPPORTED_SCHEME',
    })],
    expected: [],
  },
  {
    name: 'a rejected link',
    links: [link('http://[', { kind: 'REJECTED_INVALID', rawUrl: 'http://[', reason: 'INVALID_URL' }, {
      ok: false,
      rawUrl: 'http://[',
      reason: 'INVALID_URL',
    })],
    expected: [],
  },
  {
    name: 'mixed links in the document order, keeping duplicates',
    links: [
      internal('/z'),
      link('https://other.example.com/', { kind: 'EXTERNAL_RECORD_ONLY', url: 'https://other.example.com/' }, {
        ok: true,
        url: normalized('https://other.example.com/'),
      }),
      internal('/a'),
      internal('/z'),
    ],
    expected: [`${ORIGIN}/z`, `${ORIGIN}/a`, `${ORIGIN}/z`],
  },
];

describe('internalNavigableUrlsOf: the crawl candidates from the link Evidence (CCX-6)', () => {
  it.each(cases)('$name', ({ links, expected }) => {
    expect(internalNavigableUrlsOf(links)).toEqual(expected);
  });
});
