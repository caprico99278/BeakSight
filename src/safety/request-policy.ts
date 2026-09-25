import { canonicalizeAllowedOrigins } from '../crawl/normalize-url.js';

export interface HttpRequestFacts {
  readonly kind: 'HTTP';
  readonly method: string;
  readonly url: string;
  readonly isNavigationRequest: boolean;
  readonly isMainFrame: boolean;
}

export interface WebSocketRequestFacts {
  readonly kind: 'WEBSOCKET';
  readonly url: string;
}

export type PassiveRequestFacts = HttpRequestFacts | WebSocketRequestFacts;

export type PassiveRequestDecision =
  | { readonly action: 'ALLOW'; readonly delivery: 'DIRECT' | 'INSPECT_REDIRECTS' }
  | { readonly action: 'BLOCK'; readonly category: 'REQUEST'; readonly reason: 'NON_READ_METHOD' }
  | {
    readonly action: 'BLOCK';
    readonly category: 'NAVIGATION';
    readonly reason: 'EXTERNAL_MAIN_FRAME_NAVIGATION';
  }
  | { readonly action: 'BLOCK'; readonly category: 'WEBSOCKET'; readonly reason: 'PASSIVE_WEBSOCKET' };

export function isReadMethod(method: string): boolean {
  const normalizedMethod = method.toUpperCase();
  return normalizedMethod === 'GET' || normalizedMethod === 'HEAD';
}

/** Passive HTTP の許可Origin。正規化は URL の意味の owner（`canonicalizeAllowedOrigins`）に委譲する。 */
export function canonicalPassiveAllowedOrigins(allowedOrigins: ReadonlySet<string>): ReadonlySet<string> {
  return canonicalizeAllowedOrigins(allowedOrigins);
}

function hasAllowedOrigin(url: string, allowedOrigins: ReadonlySet<string>): boolean {
  try {
    const candidate = new URL(url);
    return canonicalPassiveAllowedOrigins(allowedOrigins).has(candidate.origin);
  } catch {
    return false;
  }
}

export function classifyPassiveRequest(
  facts: PassiveRequestFacts,
  allowedOrigins: ReadonlySet<string>,
): PassiveRequestDecision {
  if (facts.kind === 'WEBSOCKET') {
    return { action: 'BLOCK', category: 'WEBSOCKET', reason: 'PASSIVE_WEBSOCKET' };
  }
  if (!isReadMethod(facts.method)) {
    return { action: 'BLOCK', category: 'REQUEST', reason: 'NON_READ_METHOD' };
  }
  if (
    facts.isNavigationRequest
    && facts.isMainFrame
    && !hasAllowedOrigin(facts.url, allowedOrigins)
  ) {
    return {
      action: 'BLOCK',
      category: 'NAVIGATION',
      reason: 'EXTERNAL_MAIN_FRAME_NAVIGATION',
    };
  }
  return {
    action: 'ALLOW',
    delivery: facts.isNavigationRequest && facts.isMainFrame ? 'INSPECT_REDIRECTS' : 'DIRECT',
  };
}
