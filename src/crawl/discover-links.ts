import type { Page } from 'playwright';
import type { PageId } from '../core/contracts.js';
import type { LinkAdmissionEvidence, LinkDiscoveryEvidence, LinkEvidence } from '../core/evidence-types.js';
import { MAX_URL_LENGTH } from '../core/limits.js';
import { normalizeWhitespace, truncateText } from '../core/text.js';
import { classifyUrl, type AdmissionPolicy, type UrlAdmission } from './admission-policy.js';
import { normalizeUrl, redactUrlCredentials, type NormalizedUrlResult } from './normalize-url.js';

/** Link の Evidence の上限。超えた分は、件数（`omittedLinkCount`）か印（`truncated`）を Evidence に残す。 */
export const LINK_LIMITS = Object.freeze({
  /** 1ページで記録するリンク（`a[href]`）の最大件数。文書の順で、先頭から記録する。 */
  maxLinks: 2_000,
  /** `anchorText`・`ariaLabel`・`title` の最大長（UTF-16 のコード単位）。 */
  maxTextLength: 1_024,
  /** `rawHref`、`normalized` と `admission` の `rawUrl`、`scheme` の最大長。 */
  maxUrlLength: MAX_URL_LENGTH,
});

/** リンク証跡用に注入するURLポリシー（必須。暗黙の受け入れ判定は持たない）。 */
export interface LinkDiscoveryPolicy extends AdmissionPolicy {
  readonly allowedQueryParameters: ReadonlySet<string>;
}

interface ExtractedAnchor {
  readonly anchorText: string | null;
  readonly ariaLabel: string | null;
  readonly title: string | null;
  readonly rawHref: string;
  readonly baseUrl: string;
}

interface ExtractedAnchors {
  /** 文書の中の `a[href]` の総数。 */
  readonly totalCount: number;
  /** 先頭から `LINK_LIMITS.maxLinks` 件までのアンカー。 */
  readonly anchors: readonly ExtractedAnchor[];
}

const normalizeAnchorText = (text: string | null): string => (text === null ? '' : normalizeWhitespace(text));

const classifyRejectedNormalization = (
  normalized: Extract<NormalizedUrlResult, { readonly ok: false }>,
  baseUrl: string,
  policy: AdmissionPolicy,
): UrlAdmission => {
  try {
    const parsedUrl = new URL(normalized.rawUrl, baseUrl);
    const admission = classifyUrl(parsedUrl, policy);
    if (admission.kind === 'SPECIAL_SCHEME_RECORD_ONLY') {
      return admission;
    }
  } catch {
    // 下記の正規化された失敗値は、パーサーが返す正規の理由と生の値をそのまま保持する。
  }

  return { kind: 'REJECTED_INVALID', rawUrl: normalized.rawUrl, reason: normalized.reason };
};

/**
 * 1つのアンカーの Evidence を作る。認証情報は、切り詰める前の値で伏せ字にする（切り詰めで伏せ字が効かなくならないように）。
 * 文字列は `LINK_LIMITS` までに切り詰め、切り詰めた場合は `truncated` を真にする。
 * 正規化済みのURL（`normalized.url`、`admission.url`）は、正規化が `MAX_URL_LENGTH` を超えるものを受け入れないので、切り詰めない。
 */
const toLinkEvidence = (anchor: ExtractedAnchor, sourcePageId: PageId, policy: LinkDiscoveryPolicy): LinkEvidence => {
  const normalized = normalizeUrl(anchor.rawHref, anchor.baseUrl, policy.allowedQueryParameters);
  const admission = normalized.ok
    ? classifyUrl(new URL(normalized.url), policy)
    : classifyRejectedNormalization(normalized, anchor.baseUrl, policy);

  let truncated = false;
  const bound = (value: string, maxLength: number): string => {
    const result = truncateText(value, maxLength);
    truncated ||= result.truncated;
    return result.text;
  };
  const boundNullable = (value: string | null, maxLength: number): string | null =>
    (value === null ? null : bound(value, maxLength));
  const boundAdmission = (value: LinkAdmissionEvidence): LinkAdmissionEvidence => {
    switch (value.kind) {
      case 'INTERNAL_NAVIGABLE':
      case 'EXTERNAL_RECORD_ONLY':
        return value;
      case 'SPECIAL_SCHEME_RECORD_ONLY':
        return {
          ...value,
          rawUrl: bound(value.rawUrl, LINK_LIMITS.maxUrlLength),
          scheme: bound(value.scheme, LINK_LIMITS.maxUrlLength),
        };
      case 'REJECTED_INVALID':
        return { ...value, rawUrl: bound(value.rawUrl, LINK_LIMITS.maxUrlLength) };
    }
  };

  const anchorText = bound(normalizeAnchorText(anchor.anchorText), LINK_LIMITS.maxTextLength);
  const ariaLabel = boundNullable(anchor.ariaLabel, LINK_LIMITS.maxTextLength);
  const title = boundNullable(anchor.title, LINK_LIMITS.maxTextLength);
  const rawHref = bound(redactUrlCredentials(anchor.rawHref, anchor.baseUrl), LINK_LIMITS.maxUrlLength);
  const boundedNormalized: NormalizedUrlResult = normalized.ok
    ? normalized
    : { ...normalized, rawUrl: bound(normalized.rawUrl, LINK_LIMITS.maxUrlLength) };
  const boundedAdmission = boundAdmission(admission);

  return {
    sourcePageId,
    anchorText,
    ariaLabel,
    title,
    rawHref,
    normalized: boundedNormalized,
    admission: boundedAdmission,
    truncated,
  };
};

/**
 * 本番で使用する唯一のアンカー抽出処理（link の Evidence の payload を返す）。証跡を返すのみであり、
 * INTERNAL_NAVIGABLEの許可を巡回候補にするかどうかは呼び出し側が判断する。
 * 文書の順で先頭から `LINK_LIMITS.maxLinks` 件までを記録し、超えた件数を `omittedLinkCount` に残す。
 * DOM の Evidence には、ここで得た結果（`links` と `omittedLinkCount`）をそのまま渡す（Link は1回だけ抽出する。ARCH03）。
 * Link を抽出する入口は、この関数だけにする（実装タスク指示 4.2「No Parallel Entry Points」）。
 */
export const discoverLinks = async (
  page: Page,
  sourcePageId: PageId,
  policy: LinkDiscoveryPolicy,
): Promise<LinkDiscoveryEvidence> => {
  if (typeof policy !== 'object' || policy === null) {
    throw new TypeError('discoverLinks requires an explicit link discovery policy');
  }
  const extracted = await page.locator('a[href]').evaluateAll((elements, maxLinks): ExtractedAnchors => ({
    totalCount: elements.length,
    anchors: elements.slice(0, maxLinks).map((element) => {
      const anchor = element as HTMLAnchorElement;
      return {
        anchorText: anchor.textContent,
        ariaLabel: anchor.getAttribute('aria-label'),
        title: anchor.getAttribute('title'),
        rawHref: anchor.getAttribute('href') ?? '',
        baseUrl: document.baseURI,
      };
    }),
  }), LINK_LIMITS.maxLinks);

  return {
    links: extracted.anchors.map((anchor) => toLinkEvidence(anchor, sourcePageId, policy)),
    omittedLinkCount: Math.max(0, extracted.totalCount - extracted.anchors.length),
  };
};
