export interface AdmissionPolicy {
  readonly allowedOrigins: ReadonlySet<string>;
}

export type UrlAdmission =
  | { readonly kind: 'INTERNAL_NAVIGABLE'; readonly url: string }
  | { readonly kind: 'EXTERNAL_RECORD_ONLY'; readonly url: string }
  | { readonly kind: 'SPECIAL_SCHEME_RECORD_ONLY'; readonly rawUrl: string; readonly scheme: string }
  | { readonly kind: 'REJECTED_INVALID'; readonly rawUrl: string; readonly reason: string };

const canonicalizeAllowedOrigins = (policy: AdmissionPolicy): ReadonlySet<string> => {
  const canonicalOrigins = new Set<string>();
  for (const entry of policy.allowedOrigins) {
    try {
      const url = new URL(entry);
      if ((url.protocol === 'http:' || url.protocol === 'https:') && url.username.length === 0 && url.password.length === 0) {
        canonicalOrigins.add(url.origin);
      }
    } catch {
      // 不正なポリシーエントリに巡回権限を与えてはならない。
    }
  }
  return canonicalOrigins;
};

export const classifyUrl = (url: URL, policy: AdmissionPolicy): UrlAdmission => {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return {
      kind: 'SPECIAL_SCHEME_RECORD_ONLY',
      rawUrl: url.toString(),
      scheme: url.protocol.slice(0, -1),
    };
  }

  if (url.username.length > 0 || url.password.length > 0) {
    return { kind: 'REJECTED_INVALID', rawUrl: url.toString(), reason: 'credential-bearing HTTP(S) URL' };
  }

  if (url.origin === 'null' || url.hostname.length === 0) {
    return { kind: 'REJECTED_INVALID', rawUrl: url.toString(), reason: 'invalid HTTP(S) URL' };
  }

  const canonicalUrl = url.toString();
  if (canonicalizeAllowedOrigins(policy).has(url.origin)) {
    return { kind: 'INTERNAL_NAVIGABLE', url: canonicalUrl };
  }

  return { kind: 'EXTERNAL_RECORD_ONLY', url: canonicalUrl };
};
