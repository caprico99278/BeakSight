/**
 * MEM-3（DEF-266。設計書 `2026-11-13-beaksight-run-memory-scaling-design.md` 3 章）: Run のページの結果（`PageAuditResult`）の、メモリの中の置き場所の唯一の
 * owner（入れ物と、圧縮の書式だけ）。
 * - 本体は、`JSON.stringify` した文字列を `node:zlib` で圧縮したバイト列で持つ（`RunPageCodec`。既定は `ZLIB_RUN_PAGE_CODEC`）。生で持つのは、呼び出し側が
 *   渡す要約（型の引数 `TSummary`。中身の意味は、要約を作る側の owner が決める）だけ。圧縮した本体は、ディスクにも成果物にも出さない（Run の中のメモリだけ）。
 * - 取り出しは、`forEachRunPage` で 1 ページずつ（前のページの処理を終えてから、次のページを戻す。同時に戻すのは 1 ページだけ）。ページごとに event loop を
 *   返す（Run の終わりの心拍を止めないため。DEF-143）。
 * - 配列（テストと、今の呼び出し側）も、同じ口（`RunPages`・`forEachRunPage`・`runPageCountOf`）でなめられる。
 * - ページの結果の中身の owner は、今の owner のまま（Page Auditor・Rule・ArtifactWriter）。ここでは中身を見ない（JSON の値として写すだけ）。
 */
import { promisify } from 'node:util';
import { deflateRaw, inflateRaw } from 'node:zlib';
import type { PageAuditResult } from './contracts.js';

/** 本体の圧縮と戻し（テストで、数える偽の部品を差し込むための口）。 */
export interface RunPageCodec {
  readonly encode: (page: PageAuditResult) => Promise<Uint8Array>;
  readonly decode: (bytes: Uint8Array) => Promise<PageAuditResult>;
}

const deflateRawAsync = promisify(deflateRaw);
const inflateRawAsync = promisify(inflateRaw);

/**
 * 既定の圧縮の書式: JSON の文字列（UTF-8）を、非同期の `deflateRaw`（libuv の threadpool で行う。level は zlib の既定）で圧縮する。戻しは逆の順。
 * JSON の値として写すので、`undefined` の項目は戻さない（成果物の JSON と同じ値になる）。
 */
export const ZLIB_RUN_PAGE_CODEC: RunPageCodec = Object.freeze({
  encode: async (page: PageAuditResult): Promise<Uint8Array> => deflateRawAsync(Buffer.from(JSON.stringify(page), 'utf8')),
  decode: async (bytes: Uint8Array): Promise<PageAuditResult> => JSON.parse((await inflateRawAsync(bytes)).toString('utf8')) as PageAuditResult,
});

/** 置き場所の印（配列と見分ける）。 */
const RUN_PAGE_STORE_KIND = 'RUN_PAGE_STORE';

/** ページの結果の置き場所。ページの順は、入れた順。 */
export interface RunPageStore<TSummary> {
  readonly kind: typeof RUN_PAGE_STORE_KIND;
  /** ページの数。 */
  readonly length: number;
  /** ページを、最後に加える（本体は、ここで圧縮する。要約は生のまま持つ）。 */
  add(page: PageAuditResult, summary: TSummary): Promise<void>;
  /**
   * `index` 番目（0 から）のページの本体を入れ替える。`summary` を渡したときは要約も入れ替える（省略は今の要約のまま）。範囲の外は `RangeError`。
   */
  replace(index: number, page: PageAuditResult, ...summary: [] | [TSummary]): Promise<void>;
  /**
   * MEM-3b: `order`（今の添字の並び。どの添字も 1 回まで）のページを、その順に並べた新しい置き場所（圧縮した本体を共有し、圧縮し直さない。今の置き場所は
   * 変えない。並びにない添字のページは入れない）。Run の終わりに、終わった順を発見の順にするために使う。範囲の外か、2 回ある添字は `RangeError`。
   */
  ordered(order: readonly number[]): RunPageStore<TSummary>;
  /** 要約の一覧（入れた順）。 */
  summaries(): readonly TSummary[];
  /** 圧縮した本体のバイト数の和（測りのため）。 */
  storedByteLength(): number;
  /** `index` 番目のページの本体を戻す（`forEachRunPage` だけが使う）。 */
  decode(index: number): Promise<PageAuditResult>;
}

/** ページの結果の並び（配列か、置き場所）。読む側は、`forEachRunPage` と `runPageCountOf` でなめる。 */
export type RunPages = readonly PageAuditResult[] | RunPageStore<unknown>;

const isRunPageStore = (pages: RunPages): pages is RunPageStore<unknown> => !Array.isArray(pages);

/** MEM-3d: 値が、ページの結果の置き場所（`createRunPageStore` が作ったもの）か（入力の形の確かめのため）。 */
export const isRunPageStoreValue = (value: unknown): value is RunPageStore<unknown> =>
  typeof value === 'object' && value !== null && (value as { readonly kind?: unknown }).kind === RUN_PAGE_STORE_KIND;

/** ページの結果の置き場所を作る。`codec` は省略すると `ZLIB_RUN_PAGE_CODEC`。 */
export function createRunPageStore<TSummary>(options: { readonly codec?: RunPageCodec } = {}): RunPageStore<TSummary> {
  return runPageStoreOf<TSummary>(options.codec ?? ZLIB_RUN_PAGE_CODEC, [], []);
}

/** 圧縮した本体と要約の並び（この置き場所が持つ。呼び出し側は写しを渡す）からの置き場所。 */
function runPageStoreOf<TSummary>(codec: RunPageCodec, bodies: Uint8Array[], summaries: TSummary[]): RunPageStore<TSummary> {
  const assertIndex = (index: number): void => {
    if (!Number.isSafeInteger(index) || index < 0 || index >= bodies.length) {
      throw new RangeError(`no page at ${String(index)} in the run page store of ${String(bodies.length)} pages`);
    }
  };
  return {
    kind: RUN_PAGE_STORE_KIND,
    get length(): number {
      return bodies.length;
    },
    add: async (page, summary) => {
      const body = await codec.encode(page);
      bodies.push(body);
      summaries.push(summary);
    },
    replace: async (index, page, ...summary) => {
      assertIndex(index);
      const body = await codec.encode(page);
      bodies[index] = body;
      if (summary.length > 0) {
        summaries[index] = summary[0] as TSummary;
      }
    },
    ordered: (order) => {
      if (new Set(order).size !== order.length) {
        throw new RangeError('the order must give each page at most once');
      }
      for (const index of order) {
        assertIndex(index);
      }
      return runPageStoreOf(codec, order.map((index) => bodies[index] as Uint8Array), order.map((index) => summaries[index] as TSummary));
    },
    summaries: () => [...summaries],
    storedByteLength: () => bodies.reduce((sum, body) => sum + body.byteLength, 0),
    decode: async (index) => {
      assertIndex(index);
      return codec.decode(bodies[index] as Uint8Array);
    },
  };
}

/** ページの数。 */
export const runPageCountOf = (pages: RunPages): number => pages.length;

/**
 * 全部のページを戻した配列（全ページを同時に持つ）。テストで中身を確かめるときに使う（MEM-3d で、CLI の暫定の使い方は外した。本番の書き出しは使わない）。
 */
export async function runPagesArrayOf(pages: RunPages): Promise<readonly PageAuditResult[]> {
  const all: PageAuditResult[] = [];
  await forEachRunPage(pages, (page) => {
    all.push(page);
  });
  return all;
}

/** event loop を 1 回返す。 */
const yieldToEventLoop = async (): Promise<void> => new Promise((resolve) => {
  setImmediate(resolve);
});

/**
 * ページを、順に 1 つずつ `visit` に渡す（前のページの `visit` を終えてから、次のページを戻す）。置き場所のときは、ページごとに event loop を返す。
 * `visit` が投げた例外は、そのまま伝える。
 */
export async function forEachRunPage(
  pages: RunPages,
  visit: (page: PageAuditResult, index: number) => Promise<void> | void,
): Promise<void> {
  if (!isRunPageStore(pages)) {
    for (const [index, page] of pages.entries()) {
      await visit(page, index);
    }
    return;
  }
  for (let index = 0; index < pages.length; index += 1) {
    await yieldToEventLoop();
    await visit(await pages.decode(index), index);
  }
}
