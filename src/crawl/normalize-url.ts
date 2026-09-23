export type NormalizedHttpUrl = string & { readonly __brand: 'NormalizedHttpUrl' };

export type NormalizedUrlResult =
  | { readonly ok: true; readonly url: NormalizedHttpUrl }
  | { readonly ok: false; readonly rawUrl: string; readonly reason: string };

const isTrackingParameter = (name: string): boolean => {
  const normalizedName = name.toLowerCase();
  return normalizedName.startsWith('utm_') || normalizedName === 'gclid' || normalizedName === 'fbclid';
};

const compareCodeUnits = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
};

const isUnreservedOctet = (octet: number): boolean =>
  (octet >= 0x41 && octet <= 0x5A)
  || (octet >= 0x61 && octet <= 0x7A)
  || (octet >= 0x30 && octet <= 0x39)
  || octet === 0x2D
  || octet === 0x2E
  || octet === 0x5F
  || octet === 0x7E;

const canonicalizePathPercentEncoding = (pathname: string): string => pathname.replace(
  /%([0-9a-fA-F]{2})/gu,
  (_match, hexadecimalOctet: string) => {
    const octet = Number.parseInt(hexadecimalOctet, 16);
    return isUnreservedOctet(octet) ? String.fromCharCode(octet) : `%${hexadecimalOctet.toUpperCase()}`;
  },
);

export const normalizeUrl = (
  rawUrl: string,
  baseUrl: string,
  allowedQueryParameters: ReadonlySet<string>,
): NormalizedUrlResult => {
  let url: URL;
  try {
    url = new URL(rawUrl, baseUrl);
  } catch {
    return { ok: false, rawUrl, reason: 'invalid URL' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, rawUrl, reason: 'unsupported URL scheme' };
  }

  const allowedParameters = [...url.searchParams.entries()]
    .filter(([name]) => allowedQueryParameters.has(name) && !isTrackingParameter(name))
    .sort(([leftName], [rightName]) => compareCodeUnits(leftName, rightName));
  const normalizedQuery = new URLSearchParams();
  for (const [name, value] of allowedParameters) {
    normalizedQuery.append(name, value);
  }

  url.pathname = canonicalizePathPercentEncoding(url.pathname);
  url.search = normalizedQuery.toString();
  url.hash = '';
  return { ok: true, url: url.toString() as NormalizedHttpUrl };
};
