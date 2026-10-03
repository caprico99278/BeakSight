import { describe, expect, it } from 'vitest';
import {
  FINDING_CATEGORIES,
  INTERACTION_STATUSES,
  PAGE_AUDIT_STATUSES,
  RUN_STATUSES,
  SEVERITIES,
  VIEWPORT_PROFILES,
  type FindingId,
} from '../../src/core/contracts.js';
import { INTERACTION_NOT_VERIFIABLE_KINDS, SCREENSHOT_CAPTURE_TYPES } from '../../src/core/evidence-types.js';
import {
  FINDING_CATEGORY_CATALOG,
  INTERACTION_NOT_VERIFIABLE_KIND_CATALOG,
  INTERACTION_STATUS_CATALOG,
  PAGE_AUDIT_STATUS_CATALOG,
  RUN_STATUS_CATALOG,
  SEVERITY_CATALOG,
  VIEWPORT_PROFILE_CATALOG,
} from '../../src/presentation/catalog.js';
import {
  SafeHtml,
  escapeHtml,
  htmlText,
  joinHtml,
  renderCode,
  renderDocument,
  renderEvidenceRef,
  renderFileLink,
  renderFindingRow,
  renderFindingTable,
  renderInteractionStatusBadge,
  renderInternalLink,
  renderKeyValueList,
  renderMutedText,
  renderNotVerifiableKindBadge,
  renderPageAuditStatusBadge,
  renderParagraph,
  renderReferenceList,
  renderRunStatusBadge,
  renderScreenshotRef,
  renderSection,
  renderSectionHeading,
  renderSeverityBadge,
  renderTable,
  renderTableRow,
  renderUrl,
  renderUrlAsText,
  toAnchorId,
  type FindingRowInput,
} from '../../src/report/html-components.js';
import { REPORT_COMPONENT_TEXT, ruleVersionText } from '../../src/presentation/messages.js';
import { REPORT_STYLESHEET, toneClassName } from '../../src/report/html-tokens.js';

/** 埋め込みを試みる、危険な文字列。 */
const HOSTILE_STRINGS = [
  '<script>alert(1)</script>',
  '"><img src=x onerror=alert(1)>',
  "' onmouseover='alert(1)",
  '" onerror="alert(1)',
  '</style><script>alert(1)</script>',
  'javascript:alert(1)',
  '&lt;already-escaped&gt;',
] as const;

const ALLOWED_ORIGINS = ['https://site.test'] as const;

/** 出力に、生のタグや、属性を抜け出す文字が残っていないか。 */
const expectEscaped = (html: string, hostile: string): void => {
  expect(html).not.toContain('<script');
  expect(html).not.toContain('<img');
  expect(html).toContain(escapeHtml(hostile));
  // エスケープした文字列を除いた残りに、イベントハンドラの属性がない（属性を抜け出していない）。
  expect(html.replaceAll(escapeHtml(hostile), '')).not.toMatch(/\son[a-z]+=/iu);
};

const findingInput = (overrides: Partial<FindingRowInput['finding']> = {}): FindingRowInput => ({
  finding: {
    findingId: 'FIND-000001' as FindingId,
    severity: 'ERROR',
    category: 'HTTP',
    ruleId: 'http.status-error',
    message: 'HTTP ステータスが 500 です。',
    pageUrl: 'https://site.test/a',
    viewport: 'desktop',
    ...overrides,
  },
  allowedOrigins: ALLOWED_ORIGINS,
  evidence: [{ evidenceId: 'EV-NET-000001', href: 'pages/PAGE-000001/page.json' }],
  screenshots: [
    {
      evidenceId: 'EV-SHOT-000001',
      relativePath: 'pages/PAGE-000001/desktop/viewport.png',
      viewport: 'desktop',
      captureType: 'VIEWPORT',
    },
  ],
});

describe('escapeHtml', () => {
  it('escapes the five characters that are special in HTML text and attributes', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
    expect(escapeHtml('plain テキスト')).toBe('plain テキスト');
  });

  it('escapes an ampersand before the other characters (no double decoding)', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });
});

describe('SafeHtml', () => {
  it('cannot be created outside the component module', () => {
    const construct = SafeHtml as unknown as new (key: symbol, kind: string, html: string) => SafeHtml;
    expect(() => new construct(Symbol('SafeHtml'), 'fragment', '<script></script>')).toThrow(TypeError);
  });

  it('escapes plain text and joins fragments', () => {
    expect(htmlText('<b>').html).toBe('&lt;b&gt;');
    expect(joinHtml([htmlText('a'), htmlText('<')]).html).toBe('a&lt;');
    expect(Object.isFrozen(htmlText('a'))).toBe(true);
  });
});

describe('badges', () => {
  it('shows the Japanese label as text, not only a colour', () => {
    for (const severity of SEVERITIES) {
      const html = renderSeverityBadge(severity).html;
      expect(html).toContain(`>${SEVERITY_CATALOG[severity].label}<`);
      expect(html).toContain(toneClassName(SEVERITY_CATALOG[severity].tone));
      expect(html).toContain(`data-value="${severity}"`);
    }
  });

  it('renders every status value of every catalog', () => {
    for (const status of RUN_STATUSES) {
      expect(renderRunStatusBadge(status).html).toContain(RUN_STATUS_CATALOG[status].label);
    }
    for (const status of PAGE_AUDIT_STATUSES) {
      expect(renderPageAuditStatusBadge(status).html).toContain(PAGE_AUDIT_STATUS_CATALOG[status].label);
    }
    for (const status of INTERACTION_STATUSES) {
      expect(renderInteractionStatusBadge(status).html).toContain(INTERACTION_STATUS_CATALOG[status].label);
    }
    for (const kind of INTERACTION_NOT_VERIFIABLE_KINDS) {
      expect(renderNotVerifiableKindBadge(kind).html).toContain(INTERACTION_NOT_VERIFIABLE_KIND_CATALOG[kind].label);
    }
  });
});

describe('renderTable', () => {
  it('uses header cells with a column scope and escapes the caption, headers and cells', () => {
    for (const hostile of HOSTILE_STRINGS) {
      const html = renderTable({
        caption: hostile,
        columns: [hostile, 'b'],
        rows: [renderTableRow([hostile, htmlText(hostile)])],
      }).html;
      expect(html).toContain('<th scope="col">');
      expect(html).toContain('<caption>');
      expectEscaped(html, hostile);
    }
  });

  it('does not accept a fragment as a row at the type level', () => {
    // @ts-expect-error: a table row must come from renderTableRow or renderFindingRow.
    expect(() => renderTable({ caption: null, columns: ['a'], rows: [htmlText('x')] })).toThrow(TypeError);
  });

  it('puts a safe anchor on a row', () => {
    const html = renderTableRow(['a'], { anchorId: toAnchorId('finding', 'FIND-000001') }).html;
    expect(html).toContain('<tr id="finding-FIND-000001">');
    expect(() => renderTableRow(['a'], { anchorId: '" onclick="x' })).toThrow(RangeError);
  });
});

describe('renderFindingRow', () => {
  it('shows the severity label, category label, message, page URL, viewport, rule and references', () => {
    const html = renderFindingRow(findingInput()).html;
    expect(html).toContain(SEVERITY_CATALOG.ERROR.label);
    expect(html).toContain(FINDING_CATEGORY_CATALOG.HTTP.label);
    expect(html).toContain('HTTP ステータスが 500 です。');
    expect(html).toContain('href="https://site.test/a"');
    expect(html).toContain(VIEWPORT_PROFILE_CATALOG.desktop.label);
    expect(html).toContain('http.status-error');
    expect(html).toContain('EV-NET-000001');
    expect(html).toContain('href="pages/PAGE-000001/desktop/viewport.png"');
    expect(html).toContain('id="finding-FIND-000001"');
  });

  it('escapes every string taken from the finding and its references', () => {
    for (const hostile of HOSTILE_STRINGS) {
      const input = findingInput({ message: hostile, ruleId: hostile, pageUrl: hostile });
      const html = renderFindingRow({
        ...input,
        evidence: [{ evidenceId: hostile, href: hostile }],
        screenshots: [{ evidenceId: hostile, relativePath: hostile, viewport: 'mobile', captureType: 'FULL_PAGE' }],
      }).html;
      expectEscaped(html, hostile);
      expect(html).not.toContain('href="javascript:');
    }
  });

  it('renders every category and viewport, and findings without a page or a viewport', () => {
    for (const category of FINDING_CATEGORIES) {
      expect(renderFindingRow(findingInput({ category })).html).toContain(FINDING_CATEGORY_CATALOG[category].label);
    }
    for (const viewport of VIEWPORT_PROFILES) {
      expect(renderFindingRow(findingInput({ viewport })).html).toContain(VIEWPORT_PROFILE_CATALOG[viewport].label);
    }
    const html = renderFindingRow(findingInput({ pageUrl: null, viewport: null })).html;
    expect(html).not.toContain('null');
  });

  it('builds a finding table with header cells', () => {
    const html = renderFindingTable({ caption: null, rows: [renderFindingRow(findingInput())] }).html;
    expect(html.match(/<th scope="col">/gu)?.length).toBeGreaterThanOrEqual(5);
    expect(html).toContain('<tbody>');
  });
});

describe('renderUrl', () => {
  it('links an internal http(s) URL without rel', () => {
    const html = renderUrl('https://site.test/path?q=1', ALLOWED_ORIGINS).html;
    expect(html).toContain('<a ');
    expect(html).toContain('href="https://site.test/path?q=1"');
    expect(html).not.toContain('rel=');
  });

  it('links an external http(s) URL with rel="noopener noreferrer"', () => {
    const html = renderUrl('http://other.test/x', ALLOWED_ORIGINS).html;
    expect(html).toContain('href="http://other.test/x"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it.each([
    'mailto:someone@site.test',
    'tel:+81-3-0000-0000',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'https://user:secret@site.test/',
    'not a url',
    '/relative/path',
    '',
  ])('shows %j as text, not as a link', (rawUrl) => {
    const html = renderUrl(rawUrl, ALLOWED_ORIGINS).html;
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('href=');
    expect(html).toContain(escapeHtml(rawUrl));
  });

  it('shows the recorded string as it is, escaped (no re-normalisation)', () => {
    const raw = 'https://site.test/a?b=<x>&c="1"';
    const html = renderUrl(raw, ALLOWED_ORIGINS).html;
    expect(html).toContain(`>${escapeHtml(raw)}</a>`);
    expect(html).not.toContain('<x>');
  });

  it('never produces a mailto or tel link', () => {
    for (const raw of ['mailto:a@b.test', 'MAILTO:a@b.test', ' tel:0', 'tel:0']) {
      const html = renderUrl(raw, ALLOWED_ORIGINS).html;
      expect(html).not.toMatch(/href="\s*(mailto|tel):/iu);
    }
  });
});

describe('renderEvidenceRef', () => {
  it('links a safe relative artifact path or an in-page anchor', () => {
    expect(renderEvidenceRef('EV-NET-000001', 'pages/PAGE-000001/page.json').html).toContain(
      'href="pages/PAGE-000001/page.json"',
    );
    expect(renderEvidenceRef('EV-NET-000001', '#evidence-EV-NET-000001').html).toContain('href="#evidence-EV-NET-000001"');
    expect(renderEvidenceRef('EV-NET-000001', null).html).not.toContain('href=');
  });

  // R16f（設計書 6.1.11）: 相対パスが安全かどうかは `isPortableRelativeArtifactPath` だけで確かめる。空白を含むパス（`a b`）は、
  // 安全な相対パスなので、パーセント符号化してリンクにする（下の「relative links」の節）。ここには、安全でないものだけを置く。
  it.each([
    'javascript:alert(1)',
    '//evil.test/x',
    '/etc/passwd',
    '../outside.json',
    'a/../../b',
    'mailto:x@y.test',
    'a\\b.json',
    'pages/./page.json',
    'pages//page.json',
    'pages/PAGE-000001/',
    'C:/pages/page.json',
    'pages/PAGE-000001/page\u0000.json',
    'pages/PAGE-000001/page\u0085.json',
    '#',
    '#1bad',
    '#" onclick="x',
    'pages/PAGE-000001/page.json#bad anchor',
  ])(
    'does not link an unsafe target %j',
    (href) => {
      const html = renderEvidenceRef('EV-NET-000001', href).html;
      expect(html).not.toContain('href=');
      expect(html).toContain('EV-NET-000001');
    },
  );
});

describe('relative links (R16f, design 6.1.11)', () => {
  const JAPANESE_PATH = 'pages/PAGE-000001/日本語の資料.json';
  const JAPANESE_HREF = `pages/PAGE-000001/${encodeURIComponent('日本語の資料.json')}`;

  it('links a portable relative path with Japanese characters, percent-encoding the href and showing the original text', () => {
    const fileLink = renderFileLink(JAPANESE_PATH).html;
    expect(fileLink).toContain(`href="${JAPANESE_HREF}"`);
    expect(fileLink).toContain(`>${escapeHtml(JAPANESE_PATH)}</code></a>`);

    expect(renderEvidenceRef('EV-NET-000001', JAPANESE_PATH).html).toContain(`href="${JAPANESE_HREF}"`);

    const screenshotPath = 'pages/PAGE-000001/desktop/画面の写し.png';
    const screenshotLink = renderScreenshotRef({
      evidenceId: 'EV-SHOT-000001',
      relativePath: screenshotPath,
      viewport: 'desktop',
      captureType: 'VIEWPORT',
    }).html;
    expect(screenshotLink).toContain(`href="pages/PAGE-000001/desktop/${encodeURIComponent('画面の写し.png')}"`);
  });

  it('percent-encodes each segment, keeping the separators, so that no character of the path changes the meaning of the href', () => {
    const cases: readonly (readonly [string, string])[] = [
      ['a b', 'a%20b'],
      ['pages/100%/x.json', 'pages/100%25/x.json'],
      ['pages/a?b=1/c#d.png', 'pages/a%3Fb%3D1/c%23d.png'],
      ['pages/a:b/c.json', 'pages/a%3Ab/c.json'],
      ['pages/"q"/<x>.json', 'pages/%22q%22/%3Cx%3E.json'],
    ];
    for (const [path, href] of cases) {
      expect(renderFileLink(path).html, path).toContain(`href="${href}"`);
      expect(renderFileLink(path).html, path).toContain(escapeHtml(path));
      expect(renderScreenshotRef({ evidenceId: 'e', relativePath: path, viewport: 'mobile', captureType: 'FULL_PAGE' }).html, path).toContain(
        `href="${href}"`,
      );
    }
    // ASCII の英数字と `.`、`-`、`_` だけのパスは、そのままの href になる（今までと同じ）。
    expect(renderFileLink('pages/PAGE-000001/page.json').html).toContain('href="pages/PAGE-000001/page.json"');
  });

  it('keeps the in-page anchor of an Evidence reference and links a path with a safe anchor', () => {
    expect(renderEvidenceRef('e', '#evidence-EV-NET-000001').html).toContain('href="#evidence-EV-NET-000001"');
    expect(renderEvidenceRef('e', 'pages/PAGE-000001/page.json#evidence-3').html).toContain('href="pages/PAGE-000001/page.json#evidence-3"');
  });

  it('shows a path that is not a portable relative path as text, as before', () => {
    for (const unsafe of ['a\\b.json', 'pages/./x.json', 'pages//x.json', 'pages/x/', 'C:/x.json', 'pages/x\u0007.json', '\ud800.json']) {
      const fileLink = renderFileLink(unsafe).html;
      expect(fileLink, JSON.stringify(unsafe)).not.toContain('href=');
      expect(fileLink, JSON.stringify(unsafe)).toContain(escapeHtml(unsafe));
      const screenshotLink = renderScreenshotRef({ evidenceId: 'e', relativePath: unsafe, viewport: 'desktop', captureType: 'VIEWPORT' }).html;
      expect(screenshotLink, JSON.stringify(unsafe)).not.toContain('href=');
    }
  });

  it('never lets an attribute or a tag out of the href, whatever the path', () => {
    for (const hostile of HOSTILE_STRINGS) {
      for (const html of [
        renderFileLink(hostile).html,
        renderEvidenceRef('e', hostile).html,
        renderScreenshotRef({ evidenceId: 'e', relativePath: hostile, viewport: 'desktop', captureType: 'VIEWPORT' }).html,
      ]) {
        expect(html).not.toContain('<script');
        expect(html).not.toContain('<img');
        expect(html).not.toMatch(/href="\s*javascript:/iu);
        // href の中は、パーセント符号化の結果の文字（`'` は HTML のエスケープで `&#39;`）と、区切りの `/` だけである。
        for (const href of [...html.matchAll(/href="([^"]*)"/gu)].map((match) => match[1] ?? '')) {
          expect(href.replaceAll('&#39;', "'"), hostile).toMatch(/^[A-Za-z0-9%._~!*()'/-]+$/u);
        }
      }
    }
  });
});

describe('renderScreenshotRef', () => {
  it('links the screenshot file and names the viewport and capture type', () => {
    for (const viewport of VIEWPORT_PROFILES) {
      for (const captureType of SCREENSHOT_CAPTURE_TYPES) {
        const html = renderScreenshotRef({
          evidenceId: 'EV-SHOT-000001',
          relativePath: `pages/PAGE-000001/${viewport}/viewport.png`,
          viewport,
          captureType,
        }).html;
        expect(html).toContain(`href="pages/PAGE-000001/${viewport}/viewport.png"`);
        expect(html).toContain(VIEWPORT_PROFILE_CATALOG[viewport].label);
        expect(html).toContain('EV-SHOT-000001');
      }
    }
  });

  it('does not link an unsafe path', () => {
    const html = renderScreenshotRef({
      evidenceId: 'EV-SHOT-000001',
      relativePath: 'javascript:alert(1)',
      viewport: 'desktop',
      captureType: 'VIEWPORT',
    }).html;
    expect(html).not.toContain('href=');
  });
});

describe('anchors and sections', () => {
  it('builds anchors only from safe characters and keeps distinct keys distinct', () => {
    expect(toAnchorId('page', 'PAGE-000001')).toBe('page-PAGE-000001');
    const hostile = toAnchorId('finding', '" onclick="alert(1)');
    expect(hostile).toMatch(/^[A-Za-z][A-Za-z0-9_-]*$/u);
    expect(toAnchorId('x', 'a_b')).not.toBe(toAnchorId('x', 'a-b'));
    expect(toAnchorId('x', 'あ')).not.toBe(toAnchorId('x', 'い'));
    expect(toAnchorId('x', '')).toMatch(/^[A-Za-z][A-Za-z0-9_-]*$/u);
    expect(() => toAnchorId('Bad Prefix', 'a')).toThrow(RangeError);
  });

  it('renders a heading with its anchor and escapes the label', () => {
    for (const hostile of HOSTILE_STRINGS) {
      const html = renderSectionHeading({ level: 2, label: hostile, anchorId: 'summary' }).html;
      expect(html).toMatch(/^<h2 id="summary">/u);
      expectEscaped(html, hostile);
    }
    expect(() => renderSectionHeading({ level: 2, label: 'a', anchorId: 'x" onclick="y' })).toThrow(RangeError);
  });

  it('wraps content in a labelled section', () => {
    const html = renderSection({
      level: 2,
      label: '要約',
      anchorId: 'summary',
      content: [renderParagraph('<p>')],
    }).html;
    expect(html).toMatch(/^<section [^>]*aria-labelledby="summary"[^>]*>/u);
    expect(html).toContain('<h2 id="summary">要約</h2>');
    expect(html).toContain('<p>&lt;p&gt;</p>');
  });

  it('renders an escaped key-value list', () => {
    for (const hostile of HOSTILE_STRINGS) {
      const html = renderKeyValueList([{ label: hostile, value: hostile }, { label: 'b', value: htmlText(hostile) }]).html;
      expect(html).toContain('<dl');
      expectEscaped(html, hostile);
    }
  });
});

describe('renderDocument', () => {
  it('builds a Japanese static document with the single stylesheet and no script', () => {
    const html = renderDocument({ title: '<title>', content: [renderParagraph('a')] });
    expect(html.startsWith('<!DOCTYPE html>\n<html lang="ja">')).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('<title>&lt;title&gt;</title>');
    expect(html).toContain(`<style>${REPORT_STYLESHEET}</style>`);
    expect(html.match(/<style/gu)?.length).toBe(1);
    expect(html).toContain("script-src 'none'");
    expect(html).not.toContain('<script');
    expect(html).toContain('<main>');
    expect(html.endsWith('</html>\n')).toBe(true);
  });
});

describe('every component', () => {
  it('never writes a style attribute', () => {
    const outputs = [
      renderSeverityBadge('ERROR').html,
      renderTable({ caption: 'c', columns: ['a'], rows: [renderTableRow(['x'])] }).html,
      renderFindingRow(findingInput()).html,
      renderUrl('https://site.test/', ALLOWED_ORIGINS).html,
      renderEvidenceRef('EV-NET-000001', 'pages/PAGE-000001/page.json').html,
      renderScreenshotRef(findingInput().screenshots[0]!).html,
      renderSection({ level: 3, label: 'a', anchorId: 'a', content: [] }).html,
      renderKeyValueList([{ label: 'a', value: 'b' }]).html,
      renderDocument({ title: 't', content: [] }),
    ];
    for (const html of outputs) {
      expect(html).not.toMatch(/\sstyle=/iu);
    }
  });

  it('never links mailto or tel, whatever the input', () => {
    const hostileInputs = ['mailto:a@b.test', 'tel:000', 'Mailto:a@b.test', '\tmailto:a@b.test'];
    for (const raw of hostileInputs) {
      const input = findingInput({ pageUrl: raw });
      const outputs = [
        renderUrl(raw, ALLOWED_ORIGINS).html,
        renderFindingRow({ ...input, evidence: [{ evidenceId: 'e', href: raw }] }).html,
        renderEvidenceRef('e', raw).html,
        renderScreenshotRef({ evidenceId: 'e', relativePath: raw, viewport: 'desktop', captureType: 'VIEWPORT' }).html,
      ];
      for (const html of outputs) {
        expect(html).not.toContain('href="mailto:');
        expect(html).not.toContain('href="tel:');
        expect(html).not.toMatch(/href="\s*(mailto|tel):/iu);
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// U16c で加えた部品と、既存の部品の省略できる入力（省略したときの振る舞いは変えない）
// ---------------------------------------------------------------------------------------------------------------

describe('renderEvidenceRef with a JSON pointer (U16c)', () => {
  it('shows the escaped pointer after the linked Evidence ID', () => {
    const html = renderEvidenceRef('EV-NET-000001', 'pages/PAGE-000001/page.json', '/evidence/3').html;
    expect(html).toContain('href="pages/PAGE-000001/page.json"');
    expect(html).toContain('EV-NET-000001');
    expect(html).toContain('/evidence/3');
    for (const hostile of HOSTILE_STRINGS) {
      expectEscaped(renderEvidenceRef('EV-NET-000001', null, hostile).html, hostile);
    }
  });

  it('behaves as before when the pointer is omitted or null', () => {
    const before = renderEvidenceRef('EV-NET-000001', 'pages/PAGE-000001/page.json').html;
    expect(renderEvidenceRef('EV-NET-000001', 'pages/PAGE-000001/page.json', null).html).toBe(before);
    expect(before).not.toContain('/evidence/');
  });
});

describe('renderFindingRow optional inputs (U16c)', () => {
  it('shows the rule version next to the rule ID when it is given', () => {
    const input = findingInput();
    const html = renderFindingRow({ ...input, finding: { ...input.finding, ruleVersion: 7 } }).html;
    expect(html).toContain('http.status-error');
    expect(html).toContain(ruleVersionText(7));
    expect(renderFindingRow(input).html).not.toContain(ruleVersionText(7));
  });

  it('shows the JSON pointer of each Evidence reference when it is given', () => {
    const input = findingInput();
    const html = renderFindingRow({
      ...input,
      evidence: [{ evidenceId: 'EV-NET-000001', href: 'pages/PAGE-000001/page.json', pointer: '/evidence/0' }],
    }).html;
    expect(html).toContain('href="pages/PAGE-000001/page.json"');
    expect(html).toContain('/evidence/0');
  });

  it('links the page anchor in the page cell when it is given, and rejects an unsafe anchor', () => {
    const html = renderFindingRow({ ...findingInput(), pageAnchorId: 'page-PAGE-000001' }).html;
    expect(html).toContain('href="https://site.test/a"');
    expect(html).toContain('href="#page-PAGE-000001"');
    expect(html).toContain(REPORT_COMPONENT_TEXT.pageDetailLink);
    const withoutPageUrl = renderFindingRow({ ...findingInput({ pageUrl: null }), pageAnchorId: 'page-PAGE-000001' }).html;
    expect(withoutPageUrl).toContain('href="#page-PAGE-000001"');
    expect(() => renderFindingRow({ ...findingInput(), pageAnchorId: '" onclick="x' })).toThrow(RangeError);
  });

  it('can leave out the row anchor (for a second listing of the same Finding)', () => {
    const html = renderFindingRow({ ...findingInput(), anchored: false }).html;
    expect(html).not.toContain('id=');
    expect(html).toMatch(/^<tr class="/u);
  });

  it('behaves as before when the optional inputs are omitted', () => {
    const before = renderFindingRow(findingInput()).html;
    expect(renderFindingRow({ ...findingInput(), pageAnchorId: null, anchored: true }).html).toBe(before);
    expect(before).toContain('id="finding-FIND-000001"');
    expect(before).not.toContain('href="#');
  });
});

describe('small components (U16c)', () => {
  it('renderCode and renderMutedText escape their text', () => {
    for (const hostile of HOSTILE_STRINGS) {
      expectEscaped(renderCode(hostile).html, hostile);
      expectEscaped(renderMutedText(hostile).html, hostile);
    }
    expect(renderCode('RUN-1').html).toMatch(/^<code class="[^"]+">RUN-1<\/code>$/u);
    expect(renderMutedText('a').html).toContain('class="muted"');
  });

  it('renderInternalLink links a safe anchor in the document and rejects an unsafe one', () => {
    const html = renderInternalLink('<ページ>', 'page-PAGE-000001').html;
    expect(html).toBe('<a href="#page-PAGE-000001">&lt;ページ&gt;</a>');
    for (const unsafe of ['" onclick="x', 'javascript:alert(1)', '1abc', '']) {
      expect(() => renderInternalLink('a', unsafe)).toThrow(RangeError);
    }
  });

  it('renderFileLink links a safe relative path and shows anything else as text', () => {
    expect(renderFileLink('pages/PAGE-000001/page.json').html).toContain('href="pages/PAGE-000001/page.json"');
    for (const unsafe of ['javascript:alert(1)', 'mailto:a@b.test', '../x.json', '/etc/passwd', '//evil.test/x']) {
      const html = renderFileLink(unsafe).html;
      expect(html).not.toContain('href=');
      expect(html).toContain(escapeHtml(unsafe));
    }
    for (const hostile of HOSTILE_STRINGS) {
      expectEscaped(renderFileLink(hostile).html, hostile);
    }
  });

  it('renderReferenceList lists fragments, and shows "none" when empty', () => {
    const html = renderReferenceList([htmlText('<a>'), renderCode('b')]).html;
    expect(html).toMatch(/^<ul class="[^"]+"><li>&lt;a&gt;<\/li><li><code/u);
    expect(renderReferenceList([]).html).toContain(REPORT_COMPONENT_TEXT.none);
    expect(renderReferenceList([]).html).not.toContain('<ul');
  });

  it('never write a style attribute and never link mailto or tel', () => {
    const outputs = [
      renderCode('mailto:a@b.test').html,
      renderMutedText('tel:000').html,
      renderInternalLink('a', 'b').html,
      renderFileLink('mailto:a@b.test').html,
      renderFileLink('tel:000').html,
      renderReferenceList([renderFileLink('tel:000')]).html,
      renderEvidenceRef('e', 'mailto:a@b.test', 'tel:000').html,
    ];
    for (const html of outputs) {
      expect(html).not.toMatch(/\sstyle=/iu);
      expect(html).not.toMatch(/href="\s*(mailto|tel):/iu);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// R16f で加えた部品と、既存の部品の省略できる入力（設計書 6.1.11。省略したときの振る舞いは変えない）
// ---------------------------------------------------------------------------------------------------------------

describe('renderUrlAsText (R16f, design 6.1.11)', () => {
  it('shows any URL as escaped text and never as a link, whatever classifyUrl says', () => {
    for (const raw of ['https://site.test/a', 'http://other.test/x?y=1', 'mailto:a@b.test', 'javascript:alert(1)', 'not a url', ...HOSTILE_STRINGS]) {
      const html = renderUrlAsText(raw).html;
      expect(html, raw).not.toContain('<a');
      expect(html, raw).not.toContain('href=');
      expect(html, raw).toContain(escapeHtml(raw));
      expectEscaped(html, raw);
    }
  });

  it('looks the same as a URL that renderUrl shows as text', () => {
    for (const raw of ['mailto:a@b.test', 'not a url']) {
      expect(renderUrlAsText(raw).html).toBe(renderUrl(raw, ALLOWED_ORIGINS).html);
    }
  });
});

describe('renderTable with an empty text (R16f, design 6.1.11)', () => {
  it('keeps the caption and the column headers of a table without rows, and says so in a row across every column', () => {
    const html = renderTable({ caption: '<表>', columns: ['a', 'b', 'c'], rows: [], emptyText: '<なし>' }).html;
    expect(html).toContain('<caption>&lt;表&gt;</caption>');
    for (const column of ['a', 'b', 'c']) {
      expect(html).toContain(`<th scope="col">${column}</th>`);
    }
    expect(html).toContain(`<tbody><tr><td colspan="3">${renderMutedText('<なし>').html}</td></tr></tbody>`);
  });

  it('behaves as before when the empty text is omitted or null, or when there are rows', () => {
    const empty = renderTable({ caption: 'c', columns: ['a'], rows: [] }).html;
    expect(empty).toContain('<tbody></tbody>');
    expect(renderTable({ caption: 'c', columns: ['a'], rows: [], emptyText: null }).html).toBe(empty);
    const rows = [renderTableRow(['x'])];
    expect(renderTable({ caption: 'c', columns: ['a'], rows, emptyText: 'なし' }).html).toBe(renderTable({ caption: 'c', columns: ['a'], rows }).html);
  });
});
