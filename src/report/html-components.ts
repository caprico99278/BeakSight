/**
 * HTML の部品と HTML のエスケープの唯一の owner（UI追補設計書 第4章、4.2。Task 14〜17 の設計書 6.1.6）。
 * - HTML に値を入れる処理は、`escapeHtml` か、それを必ず通すこのファイルの部品だけが行う。
 * - 部品は、受け取った文字列を必ずエスケープしてから使う。ほかの部品が作った HTML は、`SafeHtml` として受け取る
 *   （`SafeHtml` は、このファイルの中でだけ作れる）。
 * - URL をリンクにするかどうかは、`classifyUrl`（URL の受け入れ判定の owner）の結果で決める。scheme を見分ける独自の
 *   正規表現は書かない。Safety の事象の URL は、`classifyUrl` の結果によらず、`renderUrlAsText` で文字として示す（設計書 6.1.11）。
 * - Run のディレクトリの中の相対パスが安全かどうかは、`isPortableRelativeArtifactPath`（core）だけで確かめる。ここには、href に
 *   固有の処理（区切りごとのパーセント符号化）だけを置く（設計書 6.1.11）。
 * - `style=""` の属性は使わない。見た目は、`html-tokens.ts` のクラスの名前と、唯一のスタイルシートで決める。
 * - 状態や severity の値そのもの（`'ERROR'` など）は書かない。表示は、カタログ（`src/presentation/catalog.ts`）から取る
 *   （GATE-UI01）。日本語の文言は、文言カタログ（`src/presentation/messages.ts`）から取る（GATE-UI06）。
 */
import { isPortableRelativeArtifactPath } from '../core/artifact-layout.js';
import type {
  Finding,
  FindingCategory,
  InteractionStatus,
  PageAuditStatus,
  RunStatus,
  Severity,
  ViewportProfile,
} from '../core/contracts.js';
import type { InteractionNotVerifiableKind, ScreenshotCaptureType } from '../core/evidence-types.js';
import { classifyUrl } from '../crawl/admission-policy.js';
import {
  FINDING_CATEGORY_CATALOG,
  INTERACTION_NOT_VERIFIABLE_KIND_CATALOG,
  INTERACTION_STATUS_CATALOG,
  PAGE_AUDIT_STATUS_CATALOG,
  RUN_STATUS_CATALOG,
  SCREENSHOT_CAPTURE_TYPE_CATALOG,
  SEVERITY_CATALOG,
  VIEWPORT_PROFILE_CATALOG,
  type DisplaySpec,
} from '../presentation/catalog.js';
import { REPORT_COMPONENT_TEXT, ruleVersionText, screenshotLinkText } from '../presentation/messages.js';
import { REPORT_CLASS_NAMES, REPORT_STYLESHEET, toneClassName } from './html-tokens.js';

// ---------------------------------------------------------------------------------------------------------------
// エスケープと SafeHtml
// ---------------------------------------------------------------------------------------------------------------

const HTML_ESCAPES: Readonly<Record<string, string>> = Object.freeze({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
});

/** HTML の唯一のエスケープの関数。`&`、`<`、`>`、`"`、`'` を文字参照にする（本文と、引用符で囲んだ属性の値の両方に使える）。 */
export const escapeHtml = (value: string): string => value.replace(/[&<>"']/gu, (character) => HTML_ESCAPES[character] ?? character);

/** HTML の断片の種類。`row` は表の行（`<tr>`）で、`renderTable` の行にだけ使える。 */
export type SafeHtmlKind = 'fragment' | 'row';

/** `SafeHtml` を作れるのは、このファイルだけ（この値を外に出さない）。 */
const SAFE_HTML_CREATION_KEY = Symbol('SafeHtml');

/**
 * このファイルの部品が作った、エスケープ済みの HTML。ほかのファイルからは作れない（コンストラクタは、外に出さない鍵を求める）。
 * 部品の外で HTML の文字列を組み立てず、部品に渡すときは、この型で渡す。
 */
export class SafeHtml<TKind extends SafeHtmlKind = SafeHtmlKind> {
  readonly kind: TKind;
  readonly html: string;

  constructor(key: symbol, kind: TKind, html: string) {
    if (key !== SAFE_HTML_CREATION_KEY) {
      throw new TypeError('SafeHtml can only be created by src/report/html-components.ts');
    }
    this.kind = kind;
    this.html = html;
    Object.freeze(this);
  }
}

const trusted = (html: string): SafeHtml<'fragment'> => new SafeHtml(SAFE_HTML_CREATION_KEY, 'fragment', html);
const trustedRow = (html: string): SafeHtml<'row'> => new SafeHtml(SAFE_HTML_CREATION_KEY, 'row', html);

const isSafeHtml = (value: unknown): value is SafeHtml => value instanceof SafeHtml;

/** 表のセルや、部品の中身に入れられる値。文字列はエスケープし、`SafeHtml` の断片はそのまま入れる。 */
export type HtmlContent = string | SafeHtml<'fragment'>;

const contentHtml = (content: HtmlContent): string => {
  if (typeof content === 'string') {
    return escapeHtml(content);
  }
  if (isSafeHtml(content) && content.kind === 'fragment') {
    return content.html;
  }
  throw new TypeError('content must be a string or an HTML fragment made by html-components');
};

/** 識別子やコードの `<code>`（エスケープする）。 */
const codeHtml = (text: string): string => `<code class="${REPORT_CLASS_NAMES.identifier}">${escapeHtml(text)}</code>`;

/** 補足の文字（色を薄くする。エスケープする）。 */
const mutedText = (text: string): string => `<span class="${REPORT_CLASS_NAMES.muted}">${escapeHtml(text)}</span>`;

/** 文字列をエスケープした断片。 */
export const htmlText = (value: string): SafeHtml<'fragment'> => trusted(escapeHtml(value));

/** 断片を、区切り（エスケープする）でつなぐ。 */
export const joinHtml = (parts: readonly SafeHtml<'fragment'>[], separator = ''): SafeHtml<'fragment'> =>
  trusted(parts.map((part) => contentHtml(part)).join(escapeHtml(separator)));

// ---------------------------------------------------------------------------------------------------------------
// アンカーと、リンクの先
// ---------------------------------------------------------------------------------------------------------------

/** アンカー（`id` と `#` の後）に使ってよい形。先頭は英字、その後は英数字と `_`、`-`。 */
const SAFE_ANCHOR_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/u;
/** `toAnchorId` の接頭辞の形。 */
const ANCHOR_PREFIX_PATTERN = /^[a-z][a-z0-9-]*$/u;
/** アンカーの中で、そのまま残す文字。それ以外は `_<16進数>_` にする（`_` 自身も変換して、異なる鍵が同じアンカーにならないようにする）。 */
const ANCHOR_KEPT_CHARACTER = /^[A-Za-z0-9-]$/u;

const assertSafeAnchor = (anchorId: string): string => {
  if (!SAFE_ANCHOR_PATTERN.test(anchorId)) {
    throw new RangeError(`unsafe anchor id: ${JSON.stringify(anchorId)}`);
  }
  return anchorId;
};

/**
 * 接頭辞と鍵（ID など）から、安全な文字だけのアンカーを作る（例: `toAnchorId('finding', 'FIND-000001')` →
 * `finding-FIND-000001`）。英数字と `-` 以外の文字は `_<コードポイントの16進数>_` にするので、異なる鍵は異なるアンカーになる。
 * 接頭辞は、`[a-z][a-z0-9-]*` でなければならない（違えば `RangeError`）。
 */
export const toAnchorId = (prefix: string, key: string): string => {
  if (!ANCHOR_PREFIX_PATTERN.test(prefix)) {
    throw new RangeError(`unsafe anchor prefix: ${JSON.stringify(prefix)}`);
  }
  const encodedKey = [...key]
    .map((character) =>
      ANCHOR_KEPT_CHARACTER.test(character) ? character : `_${(character.codePointAt(0) ?? 0).toString(16)}_`,
    )
    .join('');
  return `${prefix}-${encodedKey}`;
};

/** 文書の中のアンカーへのリンク（アンカーが安全な形でなければ `RangeError`）。 */
const internalLinkHtml = (label: string, anchorId: string): string =>
  `<a href="#${escapeHtml(assertSafeAnchor(anchorId))}">${escapeHtml(label)}</a>`;

/**
 * Run のディレクトリの中の相対パスを、リンクの先（href。エスケープの前）にする。リンクにできなければ `null`（Task 14〜17 の設計書 6.1.11）。
 * - 相対パスが安全かどうかは、`isPortableRelativeArtifactPath`（artifact の配置の owner。CC-027）だけで確かめる。ここで別の規則を持たない。
 * - ここが受け持つのは、href に固有の処理だけである。区切り（`/`）ごとに `encodeURIComponent` でパーセント符号化して、パスの
 *   文字（`%`、`?`、`#`、`:`、空白、日本語など）が href の中で別の意味を持たないようにする。
 * - 符号化できない文字列（対になっていないサロゲート）は、リンクにしない。
 */
const relativePathHref = (relativePath: string): string | null => {
  if (!isPortableRelativeArtifactPath(relativePath)) {
    return null;
  }
  try {
    return relativePath.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  } catch {
    return null;
  }
};

/**
 * Evidence の参照のリンクの先（`EvidenceRefInput.href`）を、href（エスケープの前）にする。リンクにできなければ `null`。
 * 文書の中のアンカー（`#<アンカー>`）か、Run のディレクトリの中の相対パス（任意で `#<アンカー>` を付ける）。アンカーは、
 * `id` と同じ安全な形でなければならない。相対パスの部分は、`relativePathHref` で確かめて符号化する。
 */
const evidenceHref = (href: string): string | null => {
  const fragmentStart = href.indexOf('#');
  const path = fragmentStart < 0 ? href : href.slice(0, fragmentStart);
  const anchor = fragmentStart < 0 ? null : href.slice(fragmentStart + 1);
  if (anchor !== null && !SAFE_ANCHOR_PATTERN.test(anchor)) {
    return null;
  }
  if (path === '') {
    return anchor === null ? null : `#${anchor}`;
  }
  const pathHref = relativePathHref(path);
  return pathHref === null ? null : `${pathHref}${anchor === null ? '' : `#${anchor}`}`;
};

// ---------------------------------------------------------------------------------------------------------------
// バッジ
// ---------------------------------------------------------------------------------------------------------------

/**
 * バッジ。色だけに頼らず、カタログの日本語のラベルを文字で示す。`value` は、値そのもの（例: severity の値）で、
 * `data-value` の属性に入れる（検索や、機械的な確認のため）。
 */
export const renderBadge = (spec: DisplaySpec, value: string): SafeHtml<'fragment'> =>
  trusted(
    `<span class="${REPORT_CLASS_NAMES.badge} ${escapeHtml(toneClassName(spec.tone))}" data-value="${escapeHtml(value)}">${escapeHtml(spec.label)}</span>`,
  );

export const renderSeverityBadge = (severity: Severity): SafeHtml<'fragment'> => renderBadge(SEVERITY_CATALOG[severity], severity);

export const renderRunStatusBadge = (status: RunStatus): SafeHtml<'fragment'> => renderBadge(RUN_STATUS_CATALOG[status], status);

export const renderPageAuditStatusBadge = (status: PageAuditStatus): SafeHtml<'fragment'> =>
  renderBadge(PAGE_AUDIT_STATUS_CATALOG[status], status);

export const renderInteractionStatusBadge = (status: InteractionStatus): SafeHtml<'fragment'> =>
  renderBadge(INTERACTION_STATUS_CATALOG[status], status);

export const renderNotVerifiableKindBadge = (kind: InteractionNotVerifiableKind): SafeHtml<'fragment'> =>
  renderBadge(INTERACTION_NOT_VERIFIABLE_KIND_CATALOG[kind], kind);

// ---------------------------------------------------------------------------------------------------------------
// 表
// ---------------------------------------------------------------------------------------------------------------

export interface TableRowOptions {
  /** 行の `id`（`toAnchorId` で作る）。安全な形でなければ `RangeError`。 */
  readonly anchorId?: string | null;
}

/** 表の行（`<tr>`）。セルは `<td>`。 */
export const renderTableRow = (cells: readonly HtmlContent[], options: TableRowOptions = {}): SafeHtml<'row'> => {
  const anchorId = options.anchorId ?? null;
  const idAttribute = anchorId === null ? '' : ` id="${escapeHtml(assertSafeAnchor(anchorId))}"`;
  return trustedRow(`<tr${idAttribute}>${cells.map((cell) => `<td>${contentHtml(cell)}</td>`).join('')}</tr>`);
};

export interface TableInput {
  /** 表の見出し（`<caption>`）。不要なら `null`。 */
  readonly caption: string | null;
  /** 列の見出し（`<th scope="col">`）。 */
  readonly columns: readonly string[];
  /** `renderTableRow` か `renderFindingRow` で作った行。 */
  readonly rows: readonly SafeHtml<'row'>[];
  /**
   * 行がないときに、すべての列にまたがる1行で示す文字（例: 「なし」。色を薄くする）。見出しと列の見出しは、行がなくても示す
   * （R16f で追加。設計書 6.1.11）。省略するか `null` なら、追加の前と同じ（行のない `<tbody>`）。行があるときは使わない。
   */
  readonly emptyText?: string | null;
}

/** 表。列の見出しのセルを持ち、横に長い場合は、表の枠の中でスクロールする。 */
export const renderTable = (input: TableInput): SafeHtml<'fragment'> => {
  for (const row of input.rows) {
    if (!isSafeHtml(row) || row.kind !== 'row') {
      throw new TypeError('table rows must be made by renderTableRow or renderFindingRow');
    }
  }
  const caption = input.caption === null ? '' : `<caption>${escapeHtml(input.caption)}</caption>`;
  const header = input.columns.map((column) => `<th scope="col">${escapeHtml(column)}</th>`).join('');
  const emptyText = input.emptyText ?? null;
  const body =
    input.rows.length === 0 && emptyText !== null
      ? `<tr><td colspan="${input.columns.length}">${mutedText(emptyText)}</td></tr>`
      : input.rows.map((row) => row.html).join('');
  return trusted(
    `<div class="${REPORT_CLASS_NAMES.tableWrapper}"><table class="${REPORT_CLASS_NAMES.table}">${caption}<thead><tr>${header}</tr></thead><tbody>${body}</tbody></table></div>`,
  );
};

// ---------------------------------------------------------------------------------------------------------------
// URL（Task 14〜17 の設計書 6.1.6）
// ---------------------------------------------------------------------------------------------------------------

/**
 * URL を、リンクにせず、文字（エスケープした、記録された文字列）として示す（R16f で追加。設計書 6.1.11）。
 * `classifyUrl` の結果によらない。Safety の事象の URL（安全のために実行しなかった操作の URL）は、これで示す。
 * レポートから1回のクリックで、その操作を実行できないようにするためである（上位の設計書 第20章）。
 * 見た目は、`renderUrl` が文字として示すときと同じ。
 */
export const renderUrlAsText = (rawUrl: string): SafeHtml<'fragment'> =>
  trusted(`<span class="${REPORT_CLASS_NAMES.urlText}">${escapeHtml(rawUrl)}</span>`);

const urlAsText = renderUrlAsText;

/**
 * URL の表示。示す文字は、記録された文字列をエスケープしたもの（正規化し直さない）。
 * リンクにするかは、`classifyUrl(new URL(文字列), 許可 Origin)` の結果で決める。
 * - `INTERNAL_NAVIGABLE`: リンクにする。
 * - `EXTERNAL_RECORD_ONLY`: `rel="noopener noreferrer"` を付けてリンクにする。
 * - `SPECIAL_SCHEME_RECORD_ONLY`（`mailto:`、`tel:` など）、`REJECTED_INVALID`、`new URL` の失敗: 文字として示す。
 * リンクの先は、`classifyUrl` が返した URL（`URL` の直列化）をエスケープしたもの。
 * @param allowedOrigins 許可 Origin（`RunSummary.allowedOrigins`）。
 */
export const renderUrl = (rawUrl: string, allowedOrigins: readonly string[]): SafeHtml<'fragment'> => {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return urlAsText(rawUrl);
  }
  const admission = classifyUrl(parsed, { allowedOrigins: new Set(allowedOrigins) });
  switch (admission.kind) {
    case 'INTERNAL_NAVIGABLE':
      return trusted(`<a class="${REPORT_CLASS_NAMES.url}" href="${escapeHtml(admission.url)}">${escapeHtml(rawUrl)}</a>`);
    case 'EXTERNAL_RECORD_ONLY':
      return trusted(
        `<a class="${REPORT_CLASS_NAMES.url} ${REPORT_CLASS_NAMES.externalUrl}" href="${escapeHtml(admission.url)}" rel="noopener noreferrer">${escapeHtml(rawUrl)}</a>`,
      );
    case 'SPECIAL_SCHEME_RECORD_ONLY':
    case 'REJECTED_INVALID':
      return urlAsText(rawUrl);
    default: {
      const unreachable: never = admission;
      return unreachable;
    }
  }
};

// ---------------------------------------------------------------------------------------------------------------
// Evidence とスクリーンショットの参照
// ---------------------------------------------------------------------------------------------------------------

/** Evidence の参照。 */
export interface EvidenceRefInput {
  readonly evidenceId: string;
  /**
   * リンクの先。Run のディレクトリの中の相対パス（例: `pages/PAGE-000001/page.json`）か、文書の中のアンカー（例: `#evidence-…`）。
   * リンクにしない場合は `null`。安全な形でない場合も、リンクにしない。
   */
  readonly href: string | null;
  /**
   * `href` のファイルの中の、Evidence の場所（JSON Pointer。例: `/evidence/3`）。示さない場合は、省略するか `null`
   * （U16c で追加。省略したときの振る舞いは、追加の前と同じ）。
   */
  readonly pointer?: string | null;
}

/**
 * Evidence の ID を示す。`href` が安全な相対パスかアンカーなら、リンクにする。`pointer`（JSON Pointer）を渡すと、ID の後に
 * 文字として示す（リンクにはしない）。`pointer` を省略するか `null` にしたときの振る舞いは、U16c の追加の前と同じ。
 */
export const renderEvidenceRef = (evidenceId: string, href: string | null, pointer: string | null = null): SafeHtml<'fragment'> => {
  const code = `<code class="${REPORT_CLASS_NAMES.evidenceRef}">${escapeHtml(evidenceId)}</code>`;
  const target = href === null ? null : evidenceHref(href);
  const linked = target === null ? code : `<a href="${escapeHtml(target)}">${code}</a>`;
  return trusted(pointer === null ? linked : `${linked} ${codeHtml(pointer)}`);
};

/** スクリーンショットの参照（スクリーンショットの Evidence の中身）。 */
export interface ScreenshotRefInput {
  readonly evidenceId: string;
  /** Run のディレクトリからの相対パス（`ScreenshotEvidence.relativePath`）。 */
  readonly relativePath: string;
  readonly viewport: ViewportProfile;
  readonly captureType: ScreenshotCaptureType;
}

/**
 * スクリーンショットの参照。ビューポートと撮り方のラベルでリンクし、Evidence の ID を添える。
 * `relativePath` が安全な相対パス（`isPortableRelativeArtifactPath`）なら、区切りごとにパーセント符号化してリンクにする。そうでない場合は、
 * リンクにせず、パスを文字として示す（設計書 6.1.11）。
 */
export const renderScreenshotRef = (input: ScreenshotRefInput): SafeHtml<'fragment'> => {
  const label = escapeHtml(
    screenshotLinkText(VIEWPORT_PROFILE_CATALOG[input.viewport].label, SCREENSHOT_CAPTURE_TYPE_CATALOG[input.captureType].label),
  );
  const evidence = renderEvidenceRef(input.evidenceId, null).html;
  const href = relativePathHref(input.relativePath);
  const target =
    href === null
      ? `<span class="${REPORT_CLASS_NAMES.screenshotRef}">${label}</span> <span class="${REPORT_CLASS_NAMES.urlText}">${escapeHtml(input.relativePath)}</span>`
      : `<a class="${REPORT_CLASS_NAMES.screenshotRef}" href="${escapeHtml(href)}">${label}</a>`;
  return trusted(`${target} ${evidence}`);
};

// ---------------------------------------------------------------------------------------------------------------
// Finding の行
// ---------------------------------------------------------------------------------------------------------------

/** Finding の行の入力。Finding の値と、参照のリンクの先（表示用モデルが組み立てる）。 */
export interface FindingRowInput {
  /** `ruleVersion` を渡すと、Rule の ID の後に版を示す（U16c で追加。省略できる）。 */
  readonly finding: Pick<Finding, 'findingId' | 'severity' | 'category' | 'ruleId' | 'message' | 'pageUrl' | 'viewport'> &
    Partial<Pick<Finding, 'ruleVersion'>>;
  /** 許可 Origin（`RunSummary.allowedOrigins`）。ページの URL をリンクにするかの判断に使う。 */
  readonly allowedOrigins: readonly string[];
  /** Finding が参照する Evidence（`Finding.evidenceRefs` の順）。 */
  readonly evidence: readonly EvidenceRefInput[];
  /** Finding に関係するスクリーンショット。 */
  readonly screenshots: readonly ScreenshotRefInput[];
  /**
   * ページの一覧の中の、Finding のページのアンカー（`toAnchorId` で作ったもの）。渡すと、ページの欄に、そのアンカーへの文書の中の
   * リンクを加える。安全な形でなければ `RangeError`（U16c で追加。省略するか `null` なら、追加の前と同じ）。
   */
  readonly pageAnchorId?: string | null;
  /**
   * 行に `id`（`toAnchorId('finding', findingId)`）を付けるか。既定は `true`（追加の前と同じ）。同じ Finding を文書の中で2回示す場合は、
   * 2回目を `false` にして、`id` が重ならないようにする（U16c で追加）。
   */
  readonly anchored?: boolean;
}

/** Finding の表の列の見出し（`renderFindingRow` のセルの順）。 */
export const FINDING_TABLE_COLUMNS: readonly string[] = REPORT_COMPONENT_TEXT.findingColumns;

const referenceList = (items: readonly string[]): string =>
  items.length === 0
    ? mutedText(REPORT_COMPONENT_TEXT.none)
    : `<ul class="${REPORT_CLASS_NAMES.referenceList}">${items.map((item) => `<li>${item}</li>`).join('')}</ul>`;

const categoryLabel = (category: FindingCategory): string => FINDING_CATEGORY_CATALOG[category].label;

/**
 * Finding の行（`<tr>`）。列は `FINDING_TABLE_COLUMNS` の順（重大度、カテゴリ、内容、ページ、ビューポート、Rule、Evidence、
 * スクリーンショット）。行の `id` は `toAnchorId('finding', findingId)`。Finding の文言は、Rule が作ったものをそのまま示す。
 */
export const renderFindingRow = (input: FindingRowInput): SafeHtml<'row'> => {
  const { finding } = input;
  const pageAnchorId = input.pageAnchorId ?? null;
  const pageUrl =
    finding.pageUrl === null ? mutedText(REPORT_COMPONENT_TEXT.pageIndependent) : renderUrl(finding.pageUrl, input.allowedOrigins).html;
  const page = pageAnchorId === null ? pageUrl : `${pageUrl} ${internalLinkHtml(REPORT_COMPONENT_TEXT.pageDetailLink, pageAnchorId)}`;
  const ruleVersion = finding.ruleVersion === undefined ? '' : ` ${mutedText(ruleVersionText(finding.ruleVersion))}`;
  const viewport =
    finding.viewport === null
      ? mutedText(REPORT_COMPONENT_TEXT.viewportIndependent)
      : escapeHtml(VIEWPORT_PROFILE_CATALOG[finding.viewport].label);
  const cells = [
    renderSeverityBadge(finding.severity).html,
    escapeHtml(categoryLabel(finding.category)),
    `<span class="${REPORT_CLASS_NAMES.findingMessage}">${escapeHtml(finding.message)}</span>`,
    page,
    viewport,
    `<code class="${REPORT_CLASS_NAMES.identifier}">${escapeHtml(finding.ruleId)}</code>${ruleVersion}`,
    referenceList(
      input.evidence.map((reference) => renderEvidenceRef(reference.evidenceId, reference.href, reference.pointer ?? null).html),
    ),
    referenceList(input.screenshots.map((screenshot) => renderScreenshotRef(screenshot).html)),
  ];
  const idAttribute = input.anchored === false ? '' : `id="${escapeHtml(toAnchorId('finding', finding.findingId))}" `;
  return trustedRow(
    `<tr ${idAttribute}class="${REPORT_CLASS_NAMES.findingRow}">${cells.map((cell) => `<td>${cell}</td>`).join('')}</tr>`,
  );
};

/** Finding の表（列の見出しは `FINDING_TABLE_COLUMNS`）。 */
export const renderFindingTable = (input: {
  readonly caption: string | null;
  readonly rows: readonly SafeHtml<'row'>[];
}): SafeHtml<'fragment'> => renderTable({ caption: input.caption, columns: FINDING_TABLE_COLUMNS, rows: input.rows });

// ---------------------------------------------------------------------------------------------------------------
// 小さな部品（U16c で追加。HTML レポートの組み立てに使う）
// ---------------------------------------------------------------------------------------------------------------

/** 識別子やコード（Run の ID、理由のコード、JSON Pointer、技術的な詳細など）を `<code>` で示す。 */
export const renderCode = (text: string): SafeHtml<'fragment'> => trusted(codeHtml(text));

/** 補足の文字（「なし」「未観測」など）を、色を薄くして示す（色だけに頼らず、文字で示す）。 */
export const renderMutedText = (text: string): SafeHtml<'fragment'> => trusted(mutedText(text));

/** 文書の中のアンカー（`toAnchorId` かカタログの `anchor`）へのリンク。アンカーが安全な形でなければ `RangeError`。 */
export const renderInternalLink = (label: string, anchorId: string): SafeHtml<'fragment'> => trusted(internalLinkHtml(label, anchorId));

/**
 * Run のディレクトリの中のファイル（例: `pages/PAGE-000001/page.json`）へのリンク。パスを `<code>` で示す。
 * href は、区切りごとにパーセント符号化する（日本語のパスもリンクにできる。示す文字は、元のパスをエスケープしたもの）。
 * 安全な相対パス（`isPortableRelativeArtifactPath`）でない場合は、リンクにせず、パスを文字として示す（設計書 6.1.11）。
 */
export const renderFileLink = (relativePath: string): SafeHtml<'fragment'> => {
  const href = relativePathHref(relativePath);
  return trusted(href === null ? codeHtml(relativePath) : `<a href="${escapeHtml(href)}">${codeHtml(relativePath)}</a>`);
};

/** 断片の箇条書き（Finding の行の参照の一覧と同じ見た目）。空なら「なし」を示す。 */
export const renderReferenceList = (items: readonly SafeHtml<'fragment'>[]): SafeHtml<'fragment'> =>
  trusted(referenceList(items.map((item) => contentHtml(item))));

// ---------------------------------------------------------------------------------------------------------------
// 節、段落、項目の一覧、文書
// ---------------------------------------------------------------------------------------------------------------

/** 見出しの階層（`<h1>` は文書の題に使う）。 */
export type SectionHeadingLevel = 2 | 3 | 4;

export interface SectionHeadingInput {
  readonly level: SectionHeadingLevel;
  readonly label: string;
  /** 見出しの `id`（カタログの `anchor` か、`toAnchorId` で作ったもの）。安全な形でなければ `RangeError`。 */
  readonly anchorId: string;
}

const headingHtml = (input: SectionHeadingInput): string => {
  const level = input.level;
  if (level !== 2 && level !== 3 && level !== 4) {
    throw new RangeError(`unsupported heading level: ${String(level)}`);
  }
  return `<h${level} id="${escapeHtml(assertSafeAnchor(input.anchorId))}">${escapeHtml(input.label)}</h${level}>`;
};

/** 節の見出しとアンカー。 */
export const renderSectionHeading = (input: SectionHeadingInput): SafeHtml<'fragment'> => trusted(headingHtml(input));

/** 節（見出しと中身）。`<section>` は、見出しの `id` で名前を付ける。 */
export const renderSection = (
  input: SectionHeadingInput & { readonly content: readonly SafeHtml<'fragment'>[] },
): SafeHtml<'fragment'> =>
  trusted(
    `<section class="${REPORT_CLASS_NAMES.section}" aria-labelledby="${escapeHtml(assertSafeAnchor(input.anchorId))}">${headingHtml(input)}${input.content.map((part) => contentHtml(part)).join('')}</section>`,
  );

/** 段落。 */
export const renderParagraph = (content: HtmlContent): SafeHtml<'fragment'> => trusted(`<p>${contentHtml(content)}</p>`);

/** 項目と値の一覧（`<dl>`。例: 要約の Run Status やページの件数）。 */
export const renderKeyValueList = (
  entries: readonly { readonly label: string; readonly value: HtmlContent }[],
): SafeHtml<'fragment'> =>
  trusted(
    `<dl class="${REPORT_CLASS_NAMES.keyValueList}">${entries
      .map((entry) => `<dt>${escapeHtml(entry.label)}</dt><dd>${contentHtml(entry.value)}</dd>`)
      .join('')}</dl>`,
  );

/**
 * スクリプトを実行させないための Content Security Policy。レポートはスクリプトを使わないので、すべて禁じる
 * （エスケープの漏れがあっても、スクリプトが動かないようにする多重の守り）。画像とスタイルは制限しない。
 * 定数で、属性の値の中で意味を持つ `"` と `&` を含まないので、エスケープせずに属性に入れる。
 */
const REPORT_CONTENT_SECURITY_POLICY = "script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

export interface DocumentInput {
  /** 文書の題（`<title>` と `<h1>`）。 */
  readonly title: string;
  readonly content: readonly SafeHtml<'fragment'>[];
}

/**
 * 文書の骨組み。`<html lang="ja">`、UTF-8、唯一のスタイルシート（`REPORT_STYLESHEET`）を持つ、静的な HTML の文字列を返す
 * （改行は LF、末尾に改行を1つ付ける）。
 */
export const renderDocument = (input: DocumentInput): string => {
  const title = escapeHtml(input.title);
  return [
    '<!DOCTYPE html>',
    '<html lang="ja">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta http-equiv="Content-Security-Policy" content="${REPORT_CONTENT_SECURITY_POLICY}">`,
    `<title>${title}</title>`,
    `<style>${REPORT_STYLESHEET}</style>`,
    '</head>',
    '<body>',
    '<main>',
    `<h1>${title}</h1>`,
    ...input.content.map((part) => contentHtml(part)),
    '</main>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
};
