import type { LinkAdmissionEvidence } from '../core/evidence-types.js';
import {
  canonicalizeAllowedOrigins,
  CREDENTIALS_NOT_ALLOWED,
  hasUrlCredentials,
  isHttpProtocol,
  redactUrlCredentials,
} from './normalize-url.js';

export interface AdmissionPolicy {
  readonly allowedOrigins: ReadonlySet<string>;
}

/** URL の受け入れ判定の結果。定義は `src/core/evidence-types.ts` に1か所だけ置く。 */
export type UrlAdmission = LinkAdmissionEvidence;

/**
 * URL を受け入れ判定する。記録する `rawUrl` は、認証情報を伏せ字にした値（`redactUrlCredentials`）。
 * 受け入れない理由は、閉じた一覧 `URL_REJECTION_REASONS` のコード。
 */
export const classifyUrl = (url: URL, policy: AdmissionPolicy): UrlAdmission => {
  const rawUrl = redactUrlCredentials(url.toString());
  if (!isHttpProtocol(url.protocol)) {
    return {
      kind: 'SPECIAL_SCHEME_RECORD_ONLY',
      rawUrl,
      scheme: url.protocol.slice(0, -1),
    };
  }

  if (hasUrlCredentials(url)) {
    return { kind: 'REJECTED_INVALID', rawUrl, reason: CREDENTIALS_NOT_ALLOWED };
  }

  if (url.origin === 'null' || url.hostname.length === 0) {
    return { kind: 'REJECTED_INVALID', rawUrl, reason: 'INVALID_URL' };
  }

  const canonicalUrl = url.toString();
  if (canonicalizeAllowedOrigins(policy.allowedOrigins).has(url.origin)) {
    return { kind: 'INTERNAL_NAVIGABLE', url: canonicalUrl };
  }

  return { kind: 'EXTERNAL_RECORD_ONLY', url: canonicalUrl };
};
