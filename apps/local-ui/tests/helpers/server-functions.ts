/**
 * Server Function を HTTP で直接呼ぶテストの補助（T23f）。画面を通さずに、入力の検証（スキーマに合わない入力）と、変更の結果を確かめる。
 * - Server Function の id は、ビルドした画面のサーバの一覧（`dist/server/server.js` の manifest）から、関数の名前で引く。
 * - 入力は TanStack Start のクライアントと同じ形（seroval の JSON）で送り、応答も seroval で読む（テストだけで使う）。
 */
import { readFileSync } from 'node:fs';
import { fromCrossJSON, toJSON } from 'seroval';
import { rawRequest, type RawResponse } from './local-server.ts';

/** manifest の 1 件（`"<id>": { functionName: "<名前>_createServerFn_handler"`）。 */
const MANIFEST_ENTRY_PATTERN = /"([0-9a-f]{64})":\s*\{\s*functionName:\s*"([A-Za-z0-9_$]+)_createServerFn_handler"/gu;

/** ビルドした画面のサーバの、Server Function の名前から id への表。 */
export const readServerFunctionIds = (serverEntryPath: string): ReadonlyMap<string, string> =>
  new Map([...readFileSync(serverEntryPath, 'utf8').matchAll(MANIFEST_ENTRY_PATTERN)].map((match) => [match[2] ?? '', match[1] ?? '']));

/** Server Function の呼び出しの結果。 */
export interface ServerFunctionCall {
  readonly response: RawResponse;
  /** 応答の値（読めなかったときは `undefined`）。 */
  readonly value: unknown;
}

/** クライアントと同じ形の、入力の本文。 */
export const encodeServerFunctionPayload = (data: unknown): string => JSON.stringify(toJSON({ data }));

/** 応答の本文を読む（seroval の cross JSON の 1 件。読めなければ `undefined`）。 */
const decode = (body: string): unknown => {
  try {
    const parsed: unknown = JSON.parse(body);
    const value: unknown = fromCrossJSON(parsed as never, { refs: new Map() });
    return typeof value === 'object' && value !== null && 'result' in value ? value.result : value;
  } catch {
    return undefined;
  }
};

/** 同じ origin の Server Function の要求の header（ブラウザと同じ）。 */
const sameOriginHeaders = (origin: string, cookie: string): Readonly<Record<string, string>> => ({
  cookie,
  origin,
  'sec-fetch-site': 'same-origin',
  accept: 'application/x-tss-framed, application/x-ndjson, application/json',
  'x-tsr-serverfn': 'true',
});

/** Server Function を呼ぶ（POST は本文、GET は `payload` の query で入力を送る）。 */
export const callServerFunction = async (
  options: { readonly port: number; readonly origin: string; readonly cookie: string; readonly ids: ReadonlyMap<string, string> },
  name: string,
  method: 'GET' | 'POST',
  data?: unknown,
  rawPayload?: string,
): Promise<ServerFunctionCall> => {
  const id = options.ids.get(name);
  if (id === undefined) {
    throw new Error(`no server function named ${name}`);
  }
  const payload = rawPayload ?? (data === undefined ? undefined : encodeServerFunctionPayload(data));
  const path = method === 'GET' && payload !== undefined ? `/_serverFn/${id}?payload=${encodeURIComponent(payload)}` : `/_serverFn/${id}`;
  const response = await rawRequest(options.port, path, {
    method,
    headers: { ...sameOriginHeaders(options.origin, options.cookie), ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
    ...(method === 'POST' && payload !== undefined ? { body: payload } : {}),
  });
  return { response, value: decode(response.body) };
};
