/**
 * REC-4: ChatGPT 用バンドル（2.0）の中の指摘を読む補助（テストのファイルではない）。指摘は、場所の一覧（`finding-files.json`）の順に、ページごとの指摘のファイル
 * （`pages/<pageId>/findings.json`）と、ページに属さない指摘のファイル（`run-findings.json`）にある。
 */
import { CHATGPT_BUNDLE_FILE_NAMES } from '../../src/report/chatgpt-bundle.js';

/** 指摘のファイルの中の一覧の名前（本体・外した指摘・初めの表示だけ）。 */
export type BundledFindingList = 'main' | 'excluded' | 'initialOnly';

const decoder = new TextDecoder();

/** 展開したバンドル（1 つの ZIP か、全部の部を合わせたもの）の、指定した一覧の指摘（ファイルの順、ファイルの中の順）。 */
export function bundledFindingsOf<T = unknown>(entries: Readonly<Record<string, Uint8Array>>, list: BundledFindingList = 'main'): readonly T[] {
  const read = (path: string): unknown => {
    const bytes = entries[path];
    if (bytes === undefined) {
      throw new Error(`missing bundle entry ${path}`);
    }
    return JSON.parse(decoder.decode(bytes)) as unknown;
  };
  const files = read(CHATGPT_BUNDLE_FILE_NAMES.findingFiles) as readonly { readonly path: string }[];
  return files.flatMap(({ path }) => (read(path) as Readonly<Record<BundledFindingList, readonly T[]>>)[list]);
}
