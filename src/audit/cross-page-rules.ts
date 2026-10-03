import {
  VIEWPORT_PROFILES,
  type EvidenceId,
  type FindingCategory,
  type PageAuditResult,
  type Severity,
  type ViewportAuditResult,
  type ViewportProfile,
} from '../core/contracts.js';
import type { NormalizedHttpUrlEvidence, SitemapEvidence } from '../core/evidence-types.js';
import type { FindingFingerprintIdentityField } from '../core/ids.js';
import { deepFreeze } from '../core/immutable.js';
import { compareCodeUnits, normalizeWhitespace } from '../core/text.js';
import { classifyUrl, type UrlAdmission } from '../crawl/admission-policy.js';
import { canonicalizeAllowedOrigins, normalizeUrl } from '../crawl/normalize-url.js';
import { listText, truncatedListText } from '../presentation/messages.js';
import type { FindingDraft } from './rule.js';
import {
  compareRuleEvaluationFailures,
  materializeFindingDrafts,
  toRuleEvaluationFailure,
  type FindingDraftContext,
  type FindingDraftEntry,
  type MaterializeFindingDraftsResult,
  type RuleEvaluationFailure,
} from './rule-engine.js';
import { RULE_CATALOG, freezeCatalog } from './rule-catalog.js';
import {
  ERROR_HTTP_STATUS_RANGE,
  SUCCESS_HTTP_STATUS_RANGE,
  distinctSorted,
  isHttpStatusInRange,
} from './rule-helpers.js';

// ---------------------------------------------------------------------------------------------------------------
// 入力と出力の型
// ---------------------------------------------------------------------------------------------------------------

/**
 * Cross-page rule が読む、1ビューポートの監査結果。`ViewportAuditResult` の別名（Task 14〜17 の設計書 4.3.0、4.5.9）。
 * ナビゲーションの結果の種類（`navigationOutcome`）、要求したURL、最終URLは、`ViewportAuditResult` の項目を使う。
 */
export type CrossPageViewportResult = ViewportAuditResult;

/**
 * Cross-page rule が読む、1ページの監査結果（`PageAuditResult` の一部と、ビューポートごとのナビゲーションの結果）。
 * - `evidence` のうち、link の Evidence（リンク）、DOM の Evidence（title と canonical）、network の Evidence（参照だけ）を使う。
 * - `viewports` のビューポートごとの identity（最終URL、HTTP ステータス、ナビゲーションの失敗、ナビゲーションの結果の種類）を使う。
 */
export type CrossPagePageResult = Pick<PageAuditResult, 'pageId' | 'pageUrl' | 'evidence'> & {
  readonly viewports: Readonly<Record<ViewportProfile, CrossPageViewportResult>>;
};

export interface CrossPageRuleInput {
  /** `AuditConfig.target.id`。fingerprint の対象になる。 */
  readonly targetId: string;
  /** 最初に振る Finding の連番（Run 全体で一意にするため、採番器から受け取る）。 */
  readonly firstFindingSequence: number;
  /** `AuditConfig.site.allowedOrigins`。最終URL・canonical・sitemap のURLが許可Originの中かを判定するために使う。 */
  readonly allowedOrigins: readonly string[];
  /** `AuditConfig.crawl.allowedQueryParameters`。canonical・最終URL・sitemap のURLを、クロールと同じ規則で正規化するために使う。 */
  readonly allowedQueryParameters: readonly string[];
  /** 監査したページ（スキップ・失敗したページを含む）。同じ `pageUrl` のページを2つ含めてはならない。 */
  readonly pages: readonly CrossPagePageResult[];
  /** sitemap の Evidence。sitemap がない場合は省略するか `null`。 */
  readonly sitemap?: SitemapEvidence | null;
}

export interface CrossPageEvaluationResult extends MaterializeFindingDraftsResult {
  /**
   * 検証できなかった内部リンクの件数。リンク元のページとリンク先のURLの組を1件と数える。
   * リンク先が監査されなかった（上限などでキューから外れた、どのビューポートもスキップされた）ため、
   * リンク切れかどうかを判定できなかったもの。これらから Finding は作らない。
   */
  readonly unverifiedInternalLinkCount: number;
}

/** Cross-page rule の下書きと、その文脈（どのページ・ビューポートの Finding か）。 */
export interface CrossPageFindingDraft {
  readonly context: FindingDraftContext;
  readonly draft: FindingDraft;
}

/**
 * Cross-page rule の契約。登録は `CROSS_PAGE_RULES` だけで行う（page rule の `RULE_CATALOG` とは別。入力が1ページではないため）。
 * 下書きの ruleId・ruleVersion・category は、Rule の ruleId・version・category と一致しなければならない
 * （`materializeFindingDrafts` が検査する）。一覧は、page rule と同じ `freezeCatalog` の検査を受ける。
 */
export interface CrossPageRule {
  readonly ruleId: string;
  /** 正の整数。判定を変えたら上げる。 */
  readonly version: number;
  readonly category: FindingCategory;
  readonly severity: Severity;
  evaluate(index: CrossPageIndex): readonly CrossPageFindingDraft[];
}

// ---------------------------------------------------------------------------------------------------------------
// 索引（入力の順序に依存しない形に組み立て直したもの）
// ---------------------------------------------------------------------------------------------------------------

/** ビューポートごとの最終URL（正規化したもの）。 */
export interface IndexedFinalUrl {
  readonly viewport: ViewportProfile;
  readonly url: NormalizedHttpUrlEvidence;
}

export interface IndexedPage {
  readonly page: CrossPagePageResult;
  /** 正規化した title と、それを記録した DOM の Evidence の ID。2xx の文書の、切り詰めていない title だけ。 */
  readonly titles: ReadonlyMap<string, readonly EvidenceId[]>;
  /** 正規化した canonical と、それを記録した DOM の Evidence の ID。2xx の文書の、切り詰めていない canonical だけ。 */
  readonly canonicals: ReadonlyMap<NormalizedHttpUrlEvidence, readonly EvidenceId[]>;
  readonly finalUrls: readonly IndexedFinalUrl[];
  /**
   * 文書の同一性の鍵。canonical が1つに決まればそれ、決まらなければ最終URLが1つに決まればそれ、どちらでもなければ `pageUrl`。
   * 鍵が同じページは、同じ文書を別のURLで開いたものとみなす（`DUPLICATE_PAGE_TITLE` で使う）。
   */
  readonly documentKey: string;
}

/** リンク元のページとリンク先のURLの組。同じ組のアンカーは1つにまとめる。 */
export interface IndexedInternalLink {
  readonly source: IndexedPage;
  readonly targetUrl: NormalizedHttpUrlEvidence;
  /** リンク先の監査結果。監査していない場合は `undefined`。 */
  readonly target: IndexedPage | undefined;
  /** このリンクを含む、リンク元の link の Evidence の ID。 */
  readonly evidenceRefs: readonly EvidenceId[];
}

export interface CrossPageIndex {
  /** `pageUrl` のコード単位の順。 */
  readonly pages: readonly IndexedPage[];
  readonly pagesByUrl: ReadonlyMap<string, IndexedPage>;
  readonly allowedOrigins: ReadonlySet<string>;
  /** リンク元の `pageUrl`、リンク先のURLの順。 */
  readonly internalLinks: readonly IndexedInternalLink[];
  /** クロールで発見したURL（監査したページの URL、内部リンクの遷移先、正規化した最終URL）。 */
  readonly discoveredUrls: ReadonlySet<string>;
  /** URL（ページの `pageUrl` か、正規化した最終URL）ごとの、観測した HTTP ステータス。 */
  readonly statusesByUrl: ReadonlyMap<string, readonly ViewportHttpStatus[]>;
  /**
   * 許可Originの中の、正規化した sitemap のURL（コード単位の順）と、sitemap の URL を上限で切り詰めたか。
   * sitemap がない場合は `null`。
   */
  readonly sitemap: {
    readonly evidenceId: EvidenceId;
    readonly urls: readonly NormalizedHttpUrlEvidence[];
    readonly truncated: boolean;
  } | null;
}

export interface ViewportHttpStatus {
  readonly viewport: ViewportProfile;
  readonly httpStatus: number;
}

// ---------------------------------------------------------------------------------------------------------------
// 判定の定数
// ---------------------------------------------------------------------------------------------------------------

// HTTP のステータスの範囲は、`rule-helpers.ts` の定数を使う（page rule と共有する）。
// - title と canonical は、成功（2xx）の文書のものだけを比べる（エラーページの共通の title を重複としない）。
// - リンク切れとみなす応答は、エラー（4xx・5xx）。
/** 文言に並べるURLの最大数。超えた分は件数だけを書く。Evidence の参照も、並べたページの分に限る。 */
const MAX_LISTED_URLS = 5;

// ---------------------------------------------------------------------------------------------------------------
// 補助
// ---------------------------------------------------------------------------------------------------------------

const isSuccessStatus = (status: number | null): boolean => isHttpStatusInRange(status, SUCCESS_HTTP_STATUS_RANGE);

const isErrorStatus = (status: number): boolean => isHttpStatusInRange(status, ERROR_HTTP_STATUS_RANGE);

/**
 * 正規化した URL の、許可Originに対する受け入れの判定。判定は URL の受け入れの owner（`classifyUrl`）に委ねる
 * （Rule の中に Origin の比較を書かない。Task 18 の設計書 4.4 の ARCH04）。
 * 正規化した URL は、http・https で認証情報を含まないので、結果は `INTERNAL_NAVIGABLE`（許可Originの中）か
 * `EXTERNAL_RECORD_ONLY`（許可Originの外）のどちらかになる。
 */
const admissionOf = (url: NormalizedHttpUrlEvidence, allowedOrigins: ReadonlySet<string>): UrlAdmission =>
  classifyUrl(new URL(url), { allowedOrigins });

/** 正規化した URL が、許可Originの中か。 */
const isInsideAllowedOrigins = (url: NormalizedHttpUrlEvidence, allowedOrigins: ReadonlySet<string>): boolean =>
  admissionOf(url, allowedOrigins).kind === 'INTERNAL_NAVIGABLE';

const formatStatuses = (statuses: readonly ViewportHttpStatus[]): string =>
  listText(statuses.map(({ viewport, httpStatus }) => `${viewport}: ${httpStatus}`));

const byViewport = (left: ViewportHttpStatus, right: ViewportHttpStatus): number =>
  VIEWPORT_PROFILES.indexOf(left.viewport) - VIEWPORT_PROFILES.indexOf(right.viewport)
  || left.httpStatus - right.httpStatus;

const pushToMapList = <K, V>(map: Map<K, V[]>, key: K, value: V): void => {
  const list = map.get(key);
  if (list === undefined) {
    map.set(key, [value]);
  } else {
    list.push(value);
  }
};

/**
 * ページの、指定したビューポートの network の Evidence の ID。ナビゲーションや最終URLの Finding は、これを参照する。
 * 参照できる Evidence がなければ、その Finding は作らない（`evidenceRefs` は1件以上が必要なため）。
 */
const networkRefsOf = (page: CrossPagePageResult, viewports: readonly ViewportProfile[]): EvidenceId[] =>
  page.evidence
    .filter((record) => record.type === 'network' && record.viewport !== null && viewports.includes(record.viewport))
    .map((record) => record.evidenceId);

/**
 * 正規化した URL が許可Originの外なら、文言に示すための、その URL の Origin を返す。中なら `null`。
 * 外かどうかは `classifyUrl` が決める（`EXTERNAL_RECORD_ONLY`）。Origin は、表示のために取り出すだけである。
 */
const outsideOriginOf = (url: NormalizedHttpUrlEvidence, allowedOrigins: ReadonlySet<string>): string | null =>
  admissionOf(url, allowedOrigins).kind === 'EXTERNAL_RECORD_ONLY' ? new URL(url).origin : null;

/** ページの Finding の文脈。いまの Cross-page rule の Finding は、どれもビューポートを持たない（`viewport` は null）。 */
const pageContext = (page: CrossPagePageResult): FindingDraftContext => ({
  pageId: page.pageId,
  pageUrl: page.pageUrl,
  viewport: null,
});

const RUN_CONTEXT: FindingDraftContext = { pageId: null, pageUrl: null, viewport: null };

interface RuleDefinition {
  readonly ruleId: string;
  readonly version: number;
  readonly category: FindingCategory;
  readonly severity: Severity;
}

/** Rule の定義から下書きを作る（ruleId・version・category・severity を Rule の定義と一致させるため）。 */
const createDraft = (
  rule: RuleDefinition,
  context: FindingDraftContext,
  message: string,
  evidenceRefs: readonly EvidenceId[],
  identityFields: readonly FindingFingerprintIdentityField[],
): CrossPageFindingDraft => ({
  context,
  draft: {
    ruleId: rule.ruleId,
    ruleVersion: rule.version,
    category: rule.category,
    severity: rule.severity,
    message,
    evidenceRefs,
    identityFields,
  },
});

const defineRule = (
  definition: RuleDefinition,
  evaluate: (rule: RuleDefinition, index: CrossPageIndex) => readonly CrossPageFindingDraft[],
): CrossPageRule => Object.freeze({ ...definition, evaluate: (index: CrossPageIndex) => evaluate(definition, index) });

// ---------------------------------------------------------------------------------------------------------------
// 索引の組み立て
// ---------------------------------------------------------------------------------------------------------------

const normalizeWithRules = (
  rawUrl: string,
  baseUrl: string,
  allowedQueryParameters: ReadonlySet<string>,
): NormalizedHttpUrlEvidence | null => {
  const normalized = normalizeUrl(rawUrl, baseUrl, allowedQueryParameters);
  return normalized.ok ? normalized.url : null;
};

const indexPage = (page: CrossPagePageResult, allowedQueryParameters: ReadonlySet<string>): IndexedPage => {
  const titles = new Map<string, EvidenceId[]>();
  const canonicals = new Map<NormalizedHttpUrlEvidence, EvidenceId[]>();
  for (const record of page.evidence) {
    if (record.type !== 'dom' || record.viewport === null) {
      continue;
    }
    const identity = page.viewports[record.viewport];
    if (!isSuccessStatus(identity.httpStatus)) {
      continue;
    }
    const { title, canonicalUrl, truncation } = record.payload;
    if (title !== null && !truncation.documentFields.title) {
      const normalizedTitle = normalizeWhitespace(title);
      if (normalizedTitle.length > 0) {
        pushToMapList(titles, normalizedTitle, record.evidenceId);
      }
    }
    if (canonicalUrl !== null && !truncation.documentFields.canonicalUrl) {
      const canonical = normalizeWithRules(canonicalUrl, identity.finalUrl ?? page.pageUrl, allowedQueryParameters);
      if (canonical !== null) {
        pushToMapList(canonicals, canonical, record.evidenceId);
      }
    }
  }

  const finalUrls: IndexedFinalUrl[] = [];
  for (const viewport of VIEWPORT_PROFILES) {
    const finalUrl = page.viewports[viewport].finalUrl;
    const normalized = finalUrl === null ? null : normalizeWithRules(finalUrl, finalUrl, allowedQueryParameters);
    if (normalized !== null) {
      finalUrls.push({ viewport, url: normalized });
    }
  }

  const distinctCanonicals = [...canonicals.keys()];
  const distinctFinalUrls = distinctSorted(finalUrls.map(({ url }) => url));
  const documentKey = distinctCanonicals.length === 1
    ? distinctCanonicals[0] ?? page.pageUrl
    : distinctCanonicals.length === 0 && distinctFinalUrls.length === 1
      ? distinctFinalUrls[0] ?? page.pageUrl
      : page.pageUrl;

  return { page, titles, canonicals, finalUrls, documentKey };
};

const buildIndex = (input: CrossPageRuleInput): { readonly index: CrossPageIndex; readonly evidenceIds: Set<string> } => {
  const allowedQueryParameters = new Set(input.allowedQueryParameters);
  const allowedOrigins = canonicalizeAllowedOrigins(input.allowedOrigins);
  const evidenceIds = new Set<string>();

  const pagesByUrl = new Map<string, IndexedPage>();
  for (const page of input.pages) {
    if (pagesByUrl.has(page.pageUrl)) {
      throw new TypeError(`cross-page input contains the same page url more than once: ${page.pageUrl}`);
    }
    pagesByUrl.set(page.pageUrl, indexPage(page, allowedQueryParameters));
    for (const record of page.evidence) {
      evidenceIds.add(record.evidenceId);
    }
  }
  const pages = [...pagesByUrl.values()].sort((left, right) => compareCodeUnits(left.page.pageUrl, right.page.pageUrl));

  const discoveredUrls = new Set<string>();
  const statusesByUrl = new Map<string, ViewportHttpStatus[]>();
  const linkRefs = new Map<string, Map<NormalizedHttpUrlEvidence, Set<EvidenceId>>>();
  for (const indexed of pages) {
    const { page } = indexed;
    discoveredUrls.add(page.pageUrl);
    for (const { url } of indexed.finalUrls) {
      discoveredUrls.add(url);
    }
    for (const viewport of VIEWPORT_PROFILES) {
      const httpStatus = page.viewports[viewport].httpStatus;
      if (httpStatus === null) {
        continue;
      }
      const statusUrls = new Set<string>([page.pageUrl]);
      for (const finalUrl of indexed.finalUrls) {
        if (finalUrl.viewport === viewport) {
          statusUrls.add(finalUrl.url);
        }
      }
      for (const url of statusUrls) {
        pushToMapList(statusesByUrl, url, { viewport, httpStatus });
      }
    }

    const targets = new Map<NormalizedHttpUrlEvidence, Set<EvidenceId>>();
    for (const record of page.evidence) {
      if (record.type !== 'link') {
        continue;
      }
      for (const link of record.payload.links) {
        if (link.admission.kind !== 'INTERNAL_NAVIGABLE' || !link.normalized.ok) {
          continue;
        }
        const targetUrl = link.normalized.url;
        discoveredUrls.add(targetUrl);
        const refs = targets.get(targetUrl) ?? new Set<EvidenceId>();
        refs.add(record.evidenceId);
        targets.set(targetUrl, refs);
      }
    }
    linkRefs.set(page.pageUrl, targets);
  }

  const internalLinks: IndexedInternalLink[] = [];
  for (const source of pages) {
    const targets = linkRefs.get(source.page.pageUrl) ?? new Map<NormalizedHttpUrlEvidence, Set<EvidenceId>>();
    for (const targetUrl of distinctSorted(targets.keys())) {
      internalLinks.push({
        source,
        targetUrl,
        target: pagesByUrl.get(targetUrl),
        evidenceRefs: distinctSorted(targets.get(targetUrl) ?? []),
      });
    }
  }

  let sitemap: CrossPageIndex['sitemap'] = null;
  if (input.sitemap !== undefined && input.sitemap !== null) {
    evidenceIds.add(input.sitemap.evidenceId);
    const urls: NormalizedHttpUrlEvidence[] = [];
    for (const rawUrl of input.sitemap.urls) {
      const url = normalizeWithRules(rawUrl, rawUrl, allowedQueryParameters);
      if (url !== null && isInsideAllowedOrigins(url, allowedOrigins)) {
        urls.push(url);
      }
    }
    // 切り詰めの印が真でないと確かめられない場合は、切り詰めたものとして扱う（sitemap にないと言いすぎない）。
    sitemap = { evidenceId: input.sitemap.evidenceId, urls: distinctSorted(urls), truncated: input.sitemap.truncated !== false };
  }

  for (const statuses of statusesByUrl.values()) {
    statuses.sort(byViewport);
  }

  return {
    index: { pages, pagesByUrl, allowedOrigins, internalLinks, discoveredUrls, statusesByUrl, sitemap },
    evidenceIds,
  };
};

/** リンク先の、4xx・5xx のビューポートごとの応答。 */
const errorStatusesOf = (target: IndexedPage): ViewportHttpStatus[] =>
  VIEWPORT_PROFILES.flatMap((viewport) => {
    const httpStatus = target.page.viewports[viewport].httpStatus;
    return httpStatus !== null && isErrorStatus(httpStatus) ? [{ viewport, httpStatus }] : [];
  });

/**
 * リンク先へのナビゲーション自体が失敗した（ナビゲーションの結果が `FAILED` の）ビューポート（設計書 第7章、RT12 の I4）。
 * 1つの事実から作る Finding は1つだけにするため、ほかの結果は対象にしない。
 * - `TIMEOUT` は `NAVIGATION_TIMEOUT` だけが、`BLOCKED_EXTERNAL_REDIRECT` は `UNEXPECTED_ORIGIN_REDIRECT` だけが扱う。
 * - `null`（スキップ）は、ナビゲーションしていないので Finding にしない。
 */
const navigationFailedViewportsOf = (target: IndexedPage): ViewportProfile[] =>
  VIEWPORT_PROFILES.filter((viewport) => target.page.viewports[viewport].navigationOutcome === 'FAILED');

/**
 * リンク先を検証できたか。どれかのビューポートでナビゲーションした（ナビゲーションの結果が `null` でない）場合に、検証したとする
 * （P14a、RT12b の発見事項2）。応答を得た場合（`OK`）も、ナビゲーションの失敗を観測した場合（`TIMEOUT` など）も含む。
 * 理由のコード（`NAVIGATION_FAILED`）では判断しない。
 */
const isLinkTargetVerified = (link: IndexedInternalLink): boolean => {
  const target = link.target;
  return target !== undefined
    && VIEWPORT_PROFILES.some((viewport) => target.page.viewports[viewport].navigationOutcome !== null);
};

/** ページが宣言した canonical ごとの、ページと DOM の Evidence の ID（canonical のコード単位の順）。 */
const groupByCanonical = (index: CrossPageIndex): [NormalizedHttpUrlEvidence, IndexedPage[]][] => {
  const groups = new Map<NormalizedHttpUrlEvidence, IndexedPage[]>();
  for (const indexed of index.pages) {
    for (const canonical of indexed.canonicals.keys()) {
      pushToMapList(groups, canonical, indexed);
    }
  }
  return [...groups.entries()].sort(([left], [right]) => compareCodeUnits(left, right));
};

/**
 * ページが canonical 自身か（設計書 第7章、RT12 の M7）。`pageUrl` と、各ビューポートの正規化した最終URLのどれかが
 * canonical と一致すれば、自身とみなす。正常なリダイレクトの後に、自分自身を canonical にしているページを含めるため。
 */
const isCanonicalPage = (indexed: IndexedPage, canonical: NormalizedHttpUrlEvidence): boolean =>
  indexed.page.pageUrl === canonical || indexed.finalUrls.some(({ url }) => url === canonical);

const canonicalRefs = (pages: readonly IndexedPage[], canonical: NormalizedHttpUrlEvidence): EvidenceId[] =>
  pages.slice(0, MAX_LISTED_URLS).flatMap((indexed) => indexed.canonicals.get(canonical) ?? []);

// ---------------------------------------------------------------------------------------------------------------
// Rule
// ---------------------------------------------------------------------------------------------------------------

const BROKEN_INTERNAL_LINK = defineRule(
  { ruleId: 'BROKEN_INTERNAL_LINK', version: 1, category: 'LINK', severity: 'ERROR' },
  (rule, index) =>
    index.internalLinks.flatMap((link) => {
      const statuses = link.target === undefined ? [] : errorStatusesOf(link.target);
      if (statuses.length === 0) {
        return [];
      }
      return [
        createDraft(
          rule,
          pageContext(link.source.page),
          `内部リンクの遷移先 ${link.targetUrl} の応答が HTTP のエラーでした（${formatStatuses(statuses)}）。`
            + `リンク元: ${link.source.page.pageUrl}`,
          link.evidenceRefs,
          [{ name: 'targetUrl', value: link.targetUrl }],
        ),
      ];
    }),
);

const TARGET_NAVIGATION_FAILED = defineRule(
  { ruleId: 'TARGET_NAVIGATION_FAILED', version: 1, category: 'LINK', severity: 'ERROR' },
  (rule, index) =>
    index.internalLinks.flatMap((link) => {
      const viewports = link.target === undefined ? [] : navigationFailedViewportsOf(link.target);
      if (viewports.length === 0) {
        return [];
      }
      return [
        createDraft(
          rule,
          pageContext(link.source.page),
          `内部リンクの遷移先 ${link.targetUrl} へのナビゲーションが失敗しました（ビューポート: ${listText(viewports)}）。`
            + `リンク元: ${link.source.page.pageUrl}`,
          link.evidenceRefs,
          [{ name: 'targetUrl', value: link.targetUrl }],
        ),
      ];
    }),
);

const DUPLICATE_PAGE_TITLE = defineRule(
  { ruleId: 'DUPLICATE_PAGE_TITLE', version: 1, category: 'CROSS_PAGE', severity: 'WARN' },
  (rule, index) => {
    const groups = new Map<string, IndexedPage[]>();
    for (const indexed of index.pages) {
      for (const title of indexed.titles.keys()) {
        pushToMapList(groups, title, indexed);
      }
    }
    const drafts: CrossPageFindingDraft[] = [];
    for (const [title, members] of groups) {
      for (const indexed of members) {
        const others = members.filter((other) => other.documentKey !== indexed.documentKey);
        if (others.length === 0) {
          continue;
        }
        const listedOthers = others.slice(0, MAX_LISTED_URLS);
        drafts.push(
          createDraft(
            rule,
            pageContext(indexed.page),
            `title「${title}」が、canonical の異なるほかの ${others.length} ページと同じです: `
              + truncatedListText(others.map((other) => other.page.pageUrl), MAX_LISTED_URLS),
            [indexed, ...listedOthers].flatMap((member) => member.titles.get(title) ?? []),
            [{ name: 'title', value: title }],
          ),
        );
      }
    }
    return drafts;
  },
);

const DUPLICATE_CANONICAL = defineRule(
  { ruleId: 'DUPLICATE_CANONICAL', version: 1, category: 'CROSS_PAGE', severity: 'WARN' },
  (rule, index) =>
    groupByCanonical(index).flatMap(([canonical, members]) => {
      if (members.length < 2 || members.some((member) => isCanonicalPage(member, canonical))) {
        return [];
      }
      return [
        createDraft(
          rule,
          RUN_CONTEXT,
          `${members.length} ページが同じ canonical ${canonical} を宣言していますが、どのページも ${canonical} 自身ではありません: `
            + truncatedListText(members.map((member) => member.page.pageUrl), MAX_LISTED_URLS),
          canonicalRefs(members, canonical),
          [{ name: 'canonicalUrl', value: canonical }],
        ),
      ];
    }),
);

const MULTIPLE_URLS_SAME_CANONICAL = defineRule(
  { ruleId: 'MULTIPLE_URLS_SAME_CANONICAL', version: 1, category: 'CROSS_PAGE', severity: 'INFO' },
  (rule, index) =>
    groupByCanonical(index).flatMap(([canonical, members]) => {
      // canonical のページ自身が含まれない場合は、DUPLICATE_CANONICAL が扱う（同じ組を2回報告しない）。
      if (members.length < 2 || !members.some((member) => isCanonicalPage(member, canonical))) {
        return [];
      }
      return [
        createDraft(
          rule,
          RUN_CONTEXT,
          `${members.length} 個のURLが同じ canonical ${canonical} を指しています: `
            + truncatedListText(members.map((member) => member.page.pageUrl), MAX_LISTED_URLS),
          canonicalRefs(members, canonical),
          [{ name: 'canonicalUrl', value: canonical }],
        ),
      ];
    }),
);

const CANONICAL_TARGET_NOT_FOUND = defineRule(
  { ruleId: 'CANONICAL_TARGET_NOT_FOUND', version: 1, category: 'CROSS_PAGE', severity: 'WARN' },
  (rule, index) =>
    index.pages.flatMap((indexed) =>
      [...indexed.canonicals.entries()].flatMap(([canonical, refs]) => {
        // 自分自身を指す canonical と、許可Originの外の canonical（INCONSISTENT_ORIGIN が扱う）は対象外。
        if (canonical === indexed.page.pageUrl || !isInsideAllowedOrigins(canonical, index.allowedOrigins)) {
          return [];
        }
        const errorStatuses = (index.statusesByUrl.get(canonical) ?? []).filter(({ httpStatus }) =>
          isErrorStatus(httpStatus));
        let message: string;
        if (errorStatuses.length > 0) {
          message = `canonical の遷移先 ${canonical} の応答が HTTP のエラーでした（${formatStatuses(errorStatuses)}）。`
            + `宣言したページ: ${indexed.page.pageUrl}`;
        } else if (!index.discoveredUrls.has(canonical)) {
          message = `canonical の遷移先 ${canonical} は、クロールで発見されませんでした。宣言したページ: ${indexed.page.pageUrl}`;
        } else {
          // 発見したが、応答が成功だったか、監査していない（上限など）。監査していないものを問題とはみなさない。
          return [];
        }
        return [createDraft(rule, pageContext(indexed.page), message, refs, [{ name: 'canonicalUrl', value: canonical }])];
      }),
    ),
);

/**
 * canonical の Origin が許可Originの外のもの（設計書 第7章）。
 * 最終URLの Origin が許可Originの外である事実は、`UNEXPECTED_ORIGIN_REDIRECT` だけが扱う（同じ事実から2つの Finding を作らない）。
 */
const INCONSISTENT_ORIGIN = defineRule(
  { ruleId: 'INCONSISTENT_ORIGIN', version: 1, category: 'CROSS_PAGE', severity: 'WARN' },
  (rule, index) =>
    index.pages.flatMap(({ page, canonicals }) =>
      [...canonicals].flatMap(([canonical, refs]) => {
        const origin = outsideOriginOf(canonical, index.allowedOrigins);
        if (origin === null) {
          return [];
        }
        return [
          createDraft(
            rule,
            pageContext(page),
            `canonical ${canonical} の Origin ${origin} は、許可Originの外です。宣言したページ: ${page.pageUrl}`,
            refs,
            [{ name: 'canonicalUrl', value: canonical }],
          ),
        ];
      })),
);

const SITEMAP_URL_NOT_DISCOVERED = defineRule(
  { ruleId: 'SITEMAP_URL_NOT_DISCOVERED', version: 1, category: 'CROSS_PAGE', severity: 'INFO' },
  (rule, index) => {
    const { sitemap } = index;
    if (sitemap === null) {
      return [];
    }
    return sitemap.urls
      .filter((url) => !index.discoveredUrls.has(url))
      .map((url) =>
        createDraft(
          rule,
          RUN_CONTEXT,
          `sitemap にあるURL ${url} は、クロールで発見されませんでした。`,
          [sitemap.evidenceId],
          [{ name: 'url', value: url }],
        ));
  },
);

const DISCOVERED_URL_NOT_IN_SITEMAP = defineRule(
  { ruleId: 'DISCOVERED_URL_NOT_IN_SITEMAP', version: 1, category: 'CROSS_PAGE', severity: 'INFO' },
  (rule, index) => {
    const { sitemap } = index;
    // sitemap の URL を上限で切り詰めた場合は、sitemap にないとは言えないので判定しない（Task 12・13 の設計書 第7章）。
    if (sitemap === null || sitemap.truncated) {
      return [];
    }
    const inSitemap = new Set<string>(sitemap.urls);
    const drafts: CrossPageFindingDraft[] = [];
    for (const indexed of index.pages) {
      const { page } = indexed;
      // リダイレクトの後の最終URLが sitemap にあれば、sitemap にあるとみなす。
      if (inSitemap.has(page.pageUrl) || indexed.finalUrls.some(({ url }) => inSitemap.has(url))) {
        continue;
      }
      drafts.push(
        createDraft(
          rule,
          pageContext(page),
          `クロールで発見したURL ${page.pageUrl} は、sitemap にありません。`,
          [sitemap.evidenceId],
          [{ name: 'url', value: page.pageUrl }],
        ),
      );
    }
    for (const targetUrl of distinctSorted(index.internalLinks.map((link) => link.targetUrl))) {
      if (index.pagesByUrl.has(targetUrl) || inSitemap.has(targetUrl)) {
        continue;
      }
      drafts.push(
        createDraft(
          rule,
          RUN_CONTEXT,
          `クロールで発見したURL ${targetUrl} は、sitemap にありません。`,
          [sitemap.evidenceId],
          [{ name: 'url', value: targetUrl }],
        ),
      );
    }
    return drafts;
  },
);

const NAVIGATION_TIMEOUT = defineRule(
  { ruleId: 'NAVIGATION_TIMEOUT', version: 1, category: 'HTTP', severity: 'ERROR' },
  (rule, index) =>
    index.pages.flatMap(({ page }) => {
      // ページごとに1つにまとめる。ビューポートの違いでは分けない（設計書 第7章）。
      const viewports = VIEWPORT_PROFILES.filter((viewport) => page.viewports[viewport].navigationOutcome === 'TIMEOUT');
      const refs = networkRefsOf(page, viewports);
      if (viewports.length === 0 || refs.length === 0) {
        return [];
      }
      return [
        createDraft(
          rule,
          pageContext(page),
          `ページ ${page.pageUrl} のナビゲーションが、設定の期限を過ぎました（ビューポート: ${listText(viewports)}）。`,
          refs,
          [],
        ),
      ];
    }),
);

const UNEXPECTED_ORIGIN_REDIRECT = defineRule(
  { ruleId: 'UNEXPECTED_ORIGIN_REDIRECT', version: 1, category: 'HTTP', severity: 'WARN' },
  (rule, index) =>
    index.pages.flatMap((indexed) => {
      const { page } = indexed;
      const viewports: ViewportProfile[] = [];
      const details: string[] = [];
      for (const viewport of VIEWPORT_PROFILES) {
        if (page.viewports[viewport].navigationOutcome === 'BLOCKED_EXTERNAL_REDIRECT') {
          viewports.push(viewport);
          details.push(`${viewport}: 許可Originの外へのリダイレクトを遮断`);
          continue;
        }
        const outside = indexed.finalUrls.find((finalUrl) =>
          finalUrl.viewport === viewport && outsideOriginOf(finalUrl.url, index.allowedOrigins) !== null);
        if (outside !== undefined) {
          viewports.push(viewport);
          details.push(`${viewport}: 最終URL ${outside.url}`);
        }
      }
      // ページごとに1つにまとめる。ビューポートの違いでは分けない（設計書 第7章）。
      const refs = networkRefsOf(page, viewports);
      if (viewports.length === 0 || refs.length === 0) {
        return [];
      }
      return [
        createDraft(
          rule,
          pageContext(page),
          `ページ ${page.pageUrl} のナビゲーションのリダイレクトの行き先が、許可Originの外でした（${listText(details)}）。`,
          refs,
          [],
        ),
      ];
    }),
);

/**
 * Cross-page rule の一覧を、page rule の Catalog と同じ検査（`freezeCatalog`）にかけて凍結する。
 * ruleId の重複と `ruleIdPrefix` の衝突は、page rule（`RULE_CATALOG`）とのあいだでも検査する。
 */
const freezeCrossPageRules = (rules: readonly CrossPageRule[]): readonly CrossPageRule[] =>
  freezeCatalog(rules, RULE_CATALOG);

/** すべての Cross-page rule の唯一の登録先。`evaluateCrossPageRules()` だけがこれを評価する。 */
export const CROSS_PAGE_RULES: readonly CrossPageRule[] = freezeCrossPageRules([
  BROKEN_INTERNAL_LINK,
  TARGET_NAVIGATION_FAILED,
  DUPLICATE_PAGE_TITLE,
  DUPLICATE_CANONICAL,
  MULTIPLE_URLS_SAME_CANONICAL,
  CANONICAL_TARGET_NOT_FOUND,
  INCONSISTENT_ORIGIN,
  SITEMAP_URL_NOT_DISCOVERED,
  DISCOVERED_URL_NOT_IN_SITEMAP,
  NAVIGATION_TIMEOUT,
  UNEXPECTED_ORIGIN_REDIRECT,
]);

/**
 * ページをまたぐ構造の Rule を評価する、唯一の入口（Task 12・13 の設計書 第7章）。クロールの後に1回呼ぶ。
 * - 下書きの検査、fingerprint、並べ替え、Finding ID の採番は `materializeFindingDrafts` が行う。
 * - 入力のページ・Evidence・リンク・sitemap のURLの順序は、出力の順序と fingerprint に影響しない。
 * - リンク先を監査していない内部リンクは、Finding にせず `unverifiedInternalLinkCount` に数える。
 * - 見出しやリンクの文言の意味は判定しない。
 * - Rule が例外を投げた場合は、`toRuleEvaluationFailure` でその Rule の失敗（`RULE_EVALUATION_FAILED`）にし、ほかの Rule の評価を続ける。
 * - 同じ `pageUrl` のページが2つある場合は、呼び出し側の誤りとして `TypeError` を投げる。
 * @param rules 評価する Rule の一覧。省略すると `CROSS_PAGE_RULES`。テストで仮の Rule を渡すためのもので、登録先ではない。
 *   渡した一覧も `CROSS_PAGE_RULES` と同じ検査（`freezeCatalog`）にかけ、反していれば例外を投げる。
 */
export const evaluateCrossPageRules = (
  input: CrossPageRuleInput,
  rules: readonly CrossPageRule[] = CROSS_PAGE_RULES,
): CrossPageEvaluationResult => {
  const checkedRules = rules === CROSS_PAGE_RULES ? CROSS_PAGE_RULES : freezeCrossPageRules(rules);
  const { index, evidenceIds } = buildIndex(input);
  const drafts: FindingDraftEntry[] = [];
  const evaluationFailures: RuleEvaluationFailure[] = [];
  for (const rule of checkedRules) {
    try {
      const ruleDrafts = rule.evaluate(index);
      drafts.push(...ruleDrafts.map(({ context, draft }): FindingDraftEntry => ({ owner: rule, context, draft })));
    } catch (error) {
      evaluationFailures.push(toRuleEvaluationFailure(rule.ruleId, error));
    }
  }
  const materialized = materializeFindingDrafts({
    targetId: input.targetId,
    firstFindingSequence: input.firstFindingSequence,
    evidenceIds,
    drafts,
  });
  return deepFreeze({
    findings: materialized.findings,
    // `MaterializeFindingDraftsResult.failures` と同じく、ruleId の順に並べる。
    failures: [...evaluationFailures, ...materialized.failures].sort(compareRuleEvaluationFailures),
    nextFindingSequence: materialized.nextFindingSequence,
    unverifiedInternalLinkCount: index.internalLinks.filter((link) => !isLinkTargetVerified(link)).length,
  });
};
