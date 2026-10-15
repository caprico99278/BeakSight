// T22c（Task 22 の設計書 4.5 の I02）: Control（`src/control/`）の追加で、既存の公開監査（`PUBLIC_PASSIVE`）が何も変わらないことの固定。
// - Guard の判定（`classifyPassiveRequest`）の表: method × 許可 Origin の内・外 × ナビゲーション（main frame）・サブリソース。
// - 成果物のスキーマの版: `$id` と `schemaVersion` の const。
// どちらも、作成の時点（2026-10-09）の値を、そのまま期待値として書いた golden である（固定のためのテスト。最初から PASS する。RED の対象外）。
// 期待値は、判定の関数やスキーマから計算しない（計算すると、判定やスキーマが変わったときに一緒に変わり、固定にならない）。
// 将来、`PUBLIC_PASSIVE` の判定や成果物の版を意図して変えるときは、設計書に理由を書いてから、この表を改める。
// 例の値は、匿名の値（`example.com`、`example.invalid`）だけを使う。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classifyPassiveRequest, type PassiveRequestDecision } from '../../src/safety/request-policy.js';

const ALLOWED_ORIGINS: ReadonlySet<string> = new Set(['https://example.com']);

/** 許可 Origin の内と外の URL。 */
const URL_BY_ORIGIN = {
  inside: 'https://example.com/catalog',
  outside: 'https://example.invalid/catalog',
} as const;
type OriginPlacement = keyof typeof URL_BY_ORIGIN;

/**
 * 要求の種類。
 * - `mainFrameNavigation`: main frame のナビゲーション（`isNavigationRequest: true`、`isMainFrame: true`）。
 * - `subresource`: ナビゲーションでない、子のフレームからの要求（`isNavigationRequest: false`、`isMainFrame: false`。CDP の横取りの経路が
 *   Guard に渡す形と同じ）。
 */
const REQUEST_SHAPES = {
  mainFrameNavigation: { isNavigationRequest: true, isMainFrame: true },
  subresource: { isNavigationRequest: false, isMainFrame: false },
} as const;
type RequestShape = keyof typeof REQUEST_SHAPES;

const ALLOW_INSPECT_REDIRECTS: PassiveRequestDecision = { action: 'ALLOW', delivery: 'INSPECT_REDIRECTS' };
const ALLOW_DIRECT: PassiveRequestDecision = { action: 'ALLOW', delivery: 'DIRECT' };
const BLOCK_NON_READ_METHOD: PassiveRequestDecision = { action: 'BLOCK', category: 'REQUEST', reason: 'NON_READ_METHOD' };
const BLOCK_EXTERNAL_NAVIGATION: PassiveRequestDecision = {
  action: 'BLOCK',
  category: 'NAVIGATION',
  reason: 'EXTERNAL_MAIN_FRAME_NAVIGATION',
};

/** golden の表（7 method × 2 × 2 = 28 行）。作成の時点の値。 */
const GUARD_GOLDEN: readonly (readonly [method: string, origin: OriginPlacement, shape: RequestShape, expected: PassiveRequestDecision])[] = [
  ['GET', 'inside', 'mainFrameNavigation', ALLOW_INSPECT_REDIRECTS],
  ['GET', 'inside', 'subresource', ALLOW_DIRECT],
  ['GET', 'outside', 'mainFrameNavigation', BLOCK_EXTERNAL_NAVIGATION],
  ['GET', 'outside', 'subresource', ALLOW_DIRECT],
  ['HEAD', 'inside', 'mainFrameNavigation', ALLOW_INSPECT_REDIRECTS],
  ['HEAD', 'inside', 'subresource', ALLOW_DIRECT],
  ['HEAD', 'outside', 'mainFrameNavigation', BLOCK_EXTERNAL_NAVIGATION],
  ['HEAD', 'outside', 'subresource', ALLOW_DIRECT],
  ['POST', 'inside', 'mainFrameNavigation', BLOCK_NON_READ_METHOD],
  ['POST', 'inside', 'subresource', BLOCK_NON_READ_METHOD],
  ['POST', 'outside', 'mainFrameNavigation', BLOCK_NON_READ_METHOD],
  ['POST', 'outside', 'subresource', BLOCK_NON_READ_METHOD],
  ['PUT', 'inside', 'mainFrameNavigation', BLOCK_NON_READ_METHOD],
  ['PUT', 'inside', 'subresource', BLOCK_NON_READ_METHOD],
  ['PUT', 'outside', 'mainFrameNavigation', BLOCK_NON_READ_METHOD],
  ['PUT', 'outside', 'subresource', BLOCK_NON_READ_METHOD],
  ['PATCH', 'inside', 'mainFrameNavigation', BLOCK_NON_READ_METHOD],
  ['PATCH', 'inside', 'subresource', BLOCK_NON_READ_METHOD],
  ['PATCH', 'outside', 'mainFrameNavigation', BLOCK_NON_READ_METHOD],
  ['PATCH', 'outside', 'subresource', BLOCK_NON_READ_METHOD],
  ['DELETE', 'inside', 'mainFrameNavigation', BLOCK_NON_READ_METHOD],
  ['DELETE', 'inside', 'subresource', BLOCK_NON_READ_METHOD],
  ['DELETE', 'outside', 'mainFrameNavigation', BLOCK_NON_READ_METHOD],
  ['DELETE', 'outside', 'subresource', BLOCK_NON_READ_METHOD],
  ['OPTIONS', 'inside', 'mainFrameNavigation', BLOCK_NON_READ_METHOD],
  ['OPTIONS', 'inside', 'subresource', BLOCK_NON_READ_METHOD],
  ['OPTIONS', 'outside', 'mainFrameNavigation', BLOCK_NON_READ_METHOD],
  ['OPTIONS', 'outside', 'subresource', BLOCK_NON_READ_METHOD],
];

describe('T22c golden: classifyPassiveRequest for PUBLIC_PASSIVE (design 4.5 I02)', () => {
  it('covers every method, origin placement and request shape exactly once', () => {
    const methods = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
    const combinations = methods.flatMap((method) =>
      (Object.keys(URL_BY_ORIGIN) as OriginPlacement[]).flatMap((origin) =>
        (Object.keys(REQUEST_SHAPES) as RequestShape[]).map((shape) => `${method} ${origin} ${shape}`)));
    expect(GUARD_GOLDEN.map(([method, origin, shape]) => `${method} ${origin} ${shape}`)).toEqual(combinations);
  });

  it.each(GUARD_GOLDEN)('%s to the %s origin as %s keeps the decision', (method, origin, shape, expected) => {
    expect(classifyPassiveRequest({
      kind: 'HTTP',
      method,
      url: URL_BY_ORIGIN[origin],
      ...REQUEST_SHAPES[shape],
    }, ALLOWED_ORIGINS)).toEqual(expected);
  });
});

/** 成果物のスキーマの版の golden（`schemas/<name>.schema.json` の `$id` と `properties.schemaVersion.const`）。作成の時点の値。 */
const SCHEMA_VERSION_GOLDEN: readonly (readonly [name: string, id: string, schemaVersion: string])[] = [
  ['run', 'urn:beaksight:schema:run:1.0', 'run-schema/1.0'],
  ['audit', 'urn:beaksight:schema:audit:1.0', 'audit-schema/1.0'],
  ['page', 'urn:beaksight:schema:page:1.0', 'page-schema/1.0'],
  ['checkpoint', 'urn:beaksight:schema:checkpoint:1.0', 'checkpoint-schema/1.0'],
  ['checkpoint-page', 'urn:beaksight:schema:checkpoint-page:1.0', 'checkpoint-page-schema/1.0'],
  ['finding', 'urn:beaksight:schema:finding:1.0', 'finding-schema/1.0'],
  ['site-unavailable-diagnostic', 'urn:beaksight:schema:site-unavailable-diagnostic:1.0', 'site-unavailable-diagnostic-schema/1.1'],
];

interface SchemaVersionFacts {
  readonly $id: unknown;
  readonly properties?: { readonly schemaVersion?: { readonly const?: unknown } };
}

const readSchemaVersionFacts = (name: string): SchemaVersionFacts =>
  JSON.parse(readFileSync(new URL(`../../schemas/${name}.schema.json`, import.meta.url), 'utf8')) as SchemaVersionFacts;

describe('T22c golden: artifact schema versions (design 4.5 I02)', () => {
  it.each(SCHEMA_VERSION_GOLDEN)('schemas/%s.schema.json keeps $id %s and schemaVersion %s', (name, id, schemaVersion) => {
    const schema = readSchemaVersionFacts(name);
    expect(schema.$id).toBe(id);
    expect(schema.properties?.schemaVersion?.const).toBe(schemaVersion);
  });
});
