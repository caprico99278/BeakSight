import type { Page } from 'playwright';
import type { PageId } from '../core/contracts.js';
import { classifyUrl, type AdmissionPolicy, type UrlAdmission } from './admission-policy.js';
import { normalizeUrl, type NormalizedUrlResult } from './normalize-url.js';

export interface LinkEvidence {
  readonly sourcePageId: PageId;
  readonly anchorText: string;
  readonly ariaLabel: string | null;
  readonly title: string | null;
  readonly rawHref: string;
  readonly normalized: NormalizedUrlResult;
  readonly admission: UrlAdmission;
}

/** リンク証跡用に注入するURLポリシー。省略した場合、探索範囲は現在のページOriginに限定される。 */
export interface LinkDiscoveryPolicy extends AdmissionPolicy {
  readonly allowedQueryParameters: ReadonlySet<string>;
}

interface ExtractedAnchor {
  readonly anchorText: string;
  readonly ariaLabel: string | null;
  readonly title: string | null;
  readonly rawHref: string;
  readonly baseUrl: string;
}

const normalizeAnchorText = (text: string | null): string => text?.replace(/\s+/gu, ' ').trim() ?? '';

const resolveDefaultPolicy = (pageUrl: string): LinkDiscoveryPolicy => {
  try {
    const currentPageUrl = new URL(pageUrl);
    if (currentPageUrl.protocol !== 'http:' && currentPageUrl.protocol !== 'https:') {
      return { allowedOrigins: new Set(), allowedQueryParameters: new Set() };
    }
    return {
      allowedOrigins: new Set([currentPageUrl.origin]),
      allowedQueryParameters: new Set(),
    };
  } catch {
    return { allowedOrigins: new Set(), allowedQueryParameters: new Set() };
  }
};

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
 * 本番で使用する唯一のアンカー抽出処理。証跡を返すのみであり、INTERNAL_NAVIGABLEの
 * 許可を巡回候補にするかどうかは呼び出し側が判断する。
 */
export const discoverLinks = async (
  page: Page,
  sourcePageId: PageId,
  policy?: LinkDiscoveryPolicy,
): Promise<readonly LinkEvidence[]> => {
  const resolvedPolicy = policy ?? resolveDefaultPolicy(page.url());
  const anchors = await page.locator('a[href]').evaluateAll((elements) => elements.map((element) => {
    const anchor = element as HTMLAnchorElement;
    return {
      anchorText: anchor.textContent,
      ariaLabel: anchor.getAttribute('aria-label'),
      title: anchor.getAttribute('title'),
      rawHref: anchor.getAttribute('href') ?? '',
      baseUrl: document.baseURI,
    };
  }));

  return anchors.map((anchor): LinkEvidence => {
    const normalized = normalizeUrl(anchor.rawHref, anchor.baseUrl, resolvedPolicy.allowedQueryParameters);
    const admission = normalized.ok
      ? classifyUrl(new URL(normalized.url), resolvedPolicy)
      : classifyRejectedNormalization(normalized, anchor.baseUrl, resolvedPolicy);

    return {
      sourcePageId,
      anchorText: normalizeAnchorText(anchor.anchorText),
      ariaLabel: anchor.ariaLabel,
      title: anchor.title,
      rawHref: anchor.rawHref,
      normalized,
      admission,
    };
  });
};
