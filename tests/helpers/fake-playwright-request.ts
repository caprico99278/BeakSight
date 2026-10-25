/**
 * テストの偽の Playwright の要求（`Request`）を作る補助（CC-094。T35b で、`passive-request-guard.test.ts` ほかのファイルの中に直接書いていた偽の要求を
 * まとめた）。Guard の route の層と `requestfailed` の判定に渡す。
 * - 渡した項目だけを持つ（`method`・`url`・`isNavigationRequest`・`frame`・`failure`・`response`）。渡さない項目は持たない（項目がない場合の
 *   Guard の振る舞いを確かめるテストのため）。
 * - 要求の種類（`resourceType`）は、本物と同じく必ず持つ（DEF-120。省略は、ナビゲーションなら `document`、ほかは `other`）。
 * - 投げる口など、形の違う口は `overrides` で上書きする（最後に重ねる）。
 */
import type { Page, Request } from 'playwright';

/** 偽の frame（`parentFrame` と `page`）。`parent` が `null` なら main frame。 */
export interface FakeFrame {
  readonly parentFrame: () => unknown;
  readonly page: () => Page | undefined;
}

/** 偽の frame を作る（`parent` を省略すると main frame）。 */
export const fakeFrame = (page?: Page, parent: unknown = null): FakeFrame => ({ parentFrame: () => parent, page: () => page });

/** 偽の要求の項目（どれも省略できる）。 */
export interface FakeRequestShape {
  readonly method?: string;
  readonly url?: string;
  readonly navigation?: boolean;
  /** 要求の種類（省略は、ナビゲーションなら `document`、ほかは `other`）。 */
  readonly resourceType?: string;
  /** `frame()` が返す値（`fakeFrame`）。 */
  readonly frame?: unknown;
  /** `failure()` の `errorText`。 */
  readonly failureText?: string;
  /** `response()` が返す値（Promise で返す）。 */
  readonly response?: unknown;
}

/** 本物の要求の種類の、省略したときの値。 */
const DOCUMENT_RESOURCE_TYPE = 'document';
const OTHER_RESOURCE_TYPE = 'other';

/** 偽の要求を作る（項目は `FakeRequestShape`。`overrides` は最後に重ねる）。 */
export function fakePlaywrightRequest(shape: FakeRequestShape, overrides: Readonly<Record<string, unknown>> = {}): Request {
  const resourceType = shape.resourceType ?? (shape.navigation === true ? DOCUMENT_RESOURCE_TYPE : OTHER_RESOURCE_TYPE);
  return {
    ...(shape.method === undefined ? {} : { method: () => shape.method }),
    ...(shape.url === undefined ? {} : { url: () => shape.url }),
    ...(shape.navigation === undefined ? {} : { isNavigationRequest: () => shape.navigation }),
    resourceType: () => resourceType,
    ...(shape.frame === undefined ? {} : { frame: () => shape.frame }),
    ...(shape.failureText === undefined ? {} : { failure: () => ({ errorText: shape.failureText }) }),
    ...('response' in shape ? { response: async () => shape.response } : {}),
    ...overrides,
  } as unknown as Request;
}
