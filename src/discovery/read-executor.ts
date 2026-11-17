// READ の確かめの、ページを読む部品（Task 27 の設計書 4.5、変更履歴の「T27a の報告」の (6)。T27e）。ブラウザの部品
// （`tests/architecture/discovery-boundary.test.ts` の `BROWSER_DISCOVERY_FILES`）。ページを操作しない（同じ Gate の (w)）。
// - 候補の今の形の確かめ（`readCandidatePage`）: 発見の入口（`discoverPageCandidates`。落ち着きの待ち → 凍結 → isolated world の 1 回の読み取り → 分類と指紋）で
//   対象の画面を読み、純粋な確かめ（`confirmReadTargetOnPage`）に渡す（同じ画面の定義は、1 回の読み込みで確かめる）。凍結は戻せず、凍結した Context では READ の URL の読み込み（`goto`）ができないので、
//   呼ぶ側（`src/worker/read-check-run.ts`）は、READ の URL を、別の新しい Context で読む。対象の候補が見つからず、画面を読み切れていない
//   （発見の成果物で「読んだ画面」に数えない理由がある。判定は発見の owner の `isDiscoveryPageReadInFull` に任せる）ときは、候補が消えたと言わずに
//   `UNREADABLE`。
// - READ の結果の構造（`readSettledPageStructure`）: 発見と同じ落ち着きの待ち（`waitForDiscoverySettled`。読み取りの集合は、構造の全体の 1 つの
//   文字列）の後の、最後の読み取り。読み取りは isolated world の 1 回の読み取り（`readInIsolatedWorld` で `readStructureInPage` を動かす。
//   DEF-087。ページの JS は、`HTMLCollection` の length や innerText などを書き換えて結果を偽れず、読み取りの間に走らない）で、標準の
//   prototype の getter とメソッドで読む（DOM clobbering を受けない。`probe.ts` と同じ読み方。ページの中の関数は外を参照できないので、
//   読み方はここに書く。CC-068 と同じ扱い）。古い world・例外の詳細・期限切れは、読めなかった（`FAILED`）とする。
//   上限（要素の数、構造の数、詳細の項目の数、文字の長さ）に達したら `limitReached`。
// - 主な領域: `main` の要素がちょうど 1 つあればそれ、なければ `body`。`nav`・`header`・`footer`・`aside` の中の構造は数えない（見えている文字には
//   含める）。表はほかの表の中の表を数えず、`tbody` の `tr` のうち `td` を 1 つ以上持つものを行とする（見出しだけの行を数えない）。一覧（`ul`・`ol`）は
//   ほかの一覧と表の中のものを数えず、子の `li` を項目とする。詳細は `dl`（と、その中の `div`）の子の `dt` → 次の最初の `dd`。
import type { Page } from 'playwright';
import { isNonNegativeSafeInteger, isRecord } from '../core/guards.js';
import { normalizeWhitespace, UNICODE_COMPATIBILITY_NORMALIZATION_FORM } from '../core/text.js';
import type { CandidateClassificationPolicy } from './classify.js';
import { discoverPageCandidates } from './discover-page.js';
import { isDiscoveryPageReadInFull } from './discovery-result.js';
import { readElementsInIsolatedWorld, readInIsolatedWorld, type InPageElementsResult } from './isolated-read.js';
import { composeInPage, type StandardReaders } from '../browser/in-page-readers.js';
import type { DiscoveryCandidate } from './candidate-contracts.js';
import {
  READ_PAGE_REGIONS,
  readTextForComparison,
  type ReadDetailEntry,
  type ReadPageRegion,
  type ReadPageStructure,
} from './read-check-evaluation.js';
import { waitForDiscoverySettled, type DiscoverySettlePolicy, type InFlightRequestCounter, DISCOVERY_SETTLE_POLICY } from './settle.js';
import { watchProgress, type ProgressSignals, type ProgressWatchEnd } from '../core/progress-watch.js';
import { attachPageProgressSignals } from '../browser/page-progress-signals.js';

// L4（設計書 `2026-11-09-beaksight-remove-limits-design.md` 4・5 の 1）: 1 回の読み取りの時間の上限（前は 10 秒）は撤廃した（読み取りは、進んでいる間は待つ。
// 固まった画面の守りは L0 の進みの見張り `watchProgress`。`watchedPageRead`）。定数は LZ-1 で消した。

// LZ-3b: 期限を置かない読み取りは、期限を `undefined` で渡す（前の番兵 `NO_READ_STRUCTURE_DEADLINE_AT_MS` = `Number.MAX_SAFE_INTEGER` はやめた）。読み取りを
// 終えるのは、進みの見張りだけ。

/** L4: 見張りが読み取りを終えた理由（全く反応がない・静まらない。Run の時間の上限は、この読み取りの見張りに渡さない）。 */
export type ReadWatchEnd = Exclude<ProgressWatchEnd, 'RUN_TIME_LIMIT'>;

/** L4: 読み取りの見張りの指定（テストが反応なしの長さを短くする。省略は `PROGRESS_WATCH_QUIET_LIMIT_MS`）。 */
export interface ReadWatchOptions {
  readonly quietLimitMs?: number | undefined;
  /**
   * L6/L3-1: 外側の見張りの口（操作さがしの 1 画面の見張り `screen-watch.ts`）。渡すと、自分では見張らず、その口に印を付けて読む（外側の見張りが画面を
   * 終える。`controlled-scroll` の `progress` と同じ形）。
   */
  readonly progress?: ProgressSignals | undefined;
}

/**
 * L4（L0 につなぐ）: ページの読み取り（`read`）を、進みの見張り（`watchProgress`）で包む。ページの自発の変化（通信・画面の変化）の印は
 * `attachPageProgressSignals` が付け、ブラウザからの応答の印は `read` が付ける（`signals.track`・`signals.mark`）。全く反応がない・静まらないときだけ
 * 読み取りを終え、`ended(理由)` を返す（読み取りは見放す。期限で打ち切らない）。`read` が投げたら（部品は投げないが念のため）`failed`。
 */
export async function watchedPageRead<T>(
  page: Page,
  read: (signals: ProgressSignals) => Promise<T>,
  ended: (end: ReadWatchEnd) => T,
  failed: T,
  options: ReadWatchOptions = {},
): Promise<T> {
  if (options.progress !== undefined) {
    // L6/L3-1: 外側の見張りの口を受けたら、自分では見張らない（ページの印も外側が付ける）。
    try {
      return await read(options.progress);
    } catch {
      return failed;
    }
  }
  const outcome = await watchProgress(async (signals) => {
    const detach = attachPageProgressSignals(page, signals);
    try {
      return await read(signals);
    } finally {
      detach();
    }
  }, { quietLimitMs: options.quietLimitMs });
  switch (outcome.status) {
    case 'FULFILLED':
      return outcome.value;
    case 'REJECTED':
      return failed;
    case 'ENDED':
      return ended(outcome.end === 'STAGE_NEVER_QUIET' ? 'STAGE_NEVER_QUIET' : 'STAGE_UNRESPONSIVE');
  }
}

// L4（INV-LIMITS の N32）: 主な領域の要素（前は 100,000）・構造（200）・詳細の項目（500）・詳細の文字（1,024）・見えている文字（200,000）・表の行（100,000）
// の上限は撤廃した（定数は LZ-1 で消した）。LZ-3b: ページの中の読み取りに渡していた上限の項目と番兵（前の `NO_READ_STRUCTURE_LIMIT` = `Number.MAX_SAFE_INTEGER`）
// も消した。ページの中では件数と長さを比べない。
/**
 * LU-3（設計書 `2026-11-02-beaksight-list-row-update-design.md` 5.5 の 2）: 値を含む行の読み取りで、要素の参照を返す行の数の上限（ちょうど 1 つのときだけ
 * 参照を返すので、2 つ目からは数えるだけにする）。
 */
const MAX_MATCHED_ROW_REFERENCES = 1;
// LZ-3a: 行の位置の読み取り（`readListRowPaths`）で返す行の数の上限（前は `MAX_LIST_ROW_PATHS` 2,000。超えたら `limitReached` にして、行の開き手を結ばなかった）は
// 撤廃した。一覧の画面の行を残らず読む。
/**
 * LU-SFIX2-A（LU-SREV2 の Minor-3）: 行の値の比べで、値の前後にあってはならない文字（語の続き。文字・数字・`_`・`-`・`.`・`@`。唯一の定義）。値がセルの文字と
 * 同じか、値の前後がこの文字でない（か端の）ところに値が現れるセルだけを、値を含むセルとする（`item-2` は `item-21` に当たらない）。
 * ページの中では import できないので、正規表現の文字の並びで渡す（`u` の旗で使う）。LU-SFIX3-A（LU-SREV3 の Minor-1）: 結合文字（`\p{M}`）も語の続きにする。
 */
const ROW_VALUE_WORD_CHARACTER_PATTERN = '[\\p{L}\\p{M}\\p{N}_.@-]';
/** 数えない領域の要素の名前。 */
const EXCLUDED_REGION_NAMES = Object.freeze(['nav', 'header', 'footer', 'aside'] as const);
/** `NodeFilter` の値（ページの中の `NodeFilter` を読まずに渡す）。 */
const NODE_FILTER_SHOW_ELEMENT = 1;
const NODE_FILTER_ACCEPT = 1;
const NODE_FILTER_REJECT = 2;

/** 読み取りの指定（ページの中に渡す）。 */
interface ReadStructureInput {
  readonly excludedRegionNames: readonly string[];
  readonly showElement: number;
  readonly filterAccept: number;
  readonly filterReject: number;
  /**
   * LU-3: 探す値（比べる形に整えた値。`readTextForComparison`）。null なら探さない（構造を数えるだけ）。行の決まりは数える読み取りと同じ（表の `tbody` の
   * `td` のある `tr`、一覧の子の `li`）。LU-SFIX2-A: 行の中のセル（表の行は `td`・`th`、一覧の項目は子の要素と項目の全体）の見えている
   * 文字を同じ形に整え、値と同じか、値が語の区切りで現れる（`rowValueWordCharacterPattern`）セルのある行を数える。
   */
  readonly rowNeedle: string | null;
  /** LU-3: 参照を返す行の数の上限。 */
  readonly maxMatchedRowReferences: number;
  /** LU-11: 行の位置（文書の根からの位置）と、表の行（`tr`）かを集めるか。集めないときは空の並び。 */
  readonly collectRowPaths: boolean;
  /** LU-SFIX2-A: 値の前後にあってはならない文字（`ROW_VALUE_WORD_CHARACTER_PATTERN`）。 */
  readonly rowValueWordCharacterPattern: string;
  /** LU-SFIX3-A: 行の値の比べの、Unicode の互換の正規化の形（`UNICODE_COMPATIBILITY_NORMALIZATION_FORM`）。 */
  readonly rowValueNormalizationForm: typeof UNICODE_COMPATIBILITY_NORMALIZATION_FORM;
}

// L4（INV-LIMITS の N32）: 要素・構造・詳細の項目・文字・表の行の上限を置かない。LZ-3a: 行の位置の読み取り（`readListRowPaths`）の行の数の上限も
// 置かない。LZ-3b: 上限の印（ページの中の `limitReached`）も消した（構造の `limitReached` は、READ の記録の schema が求めるので、いつも偽で残す）。
const READ_STRUCTURE_INPUT: ReadStructureInput = Object.freeze({
  excludedRegionNames: EXCLUDED_REGION_NAMES,
  showElement: NODE_FILTER_SHOW_ELEMENT,
  filterAccept: NODE_FILTER_ACCEPT,
  filterReject: NODE_FILTER_REJECT,
  rowNeedle: null,
  maxMatchedRowReferences: MAX_MATCHED_ROW_REFERENCES,
  collectRowPaths: false,
  rowValueWordCharacterPattern: ROW_VALUE_WORD_CHARACTER_PATTERN,
  rowValueNormalizationForm: UNICODE_COMPATIBILITY_NORMALIZATION_FORM,
});

/** ページの中で読んだ構造（検査の前）。 */
interface RawReadStructure {
  readonly region: string;
  readonly tableRowCounts: readonly number[];
  readonly listItemCounts: readonly number[];
  readonly detailEntries: readonly { readonly term: string; readonly value: string }[];
  readonly text: string;
  /** LU-3: 探す値を含む行の数（探さないときは 0）。 */
  readonly matchedRowCount: number;
  /** LU-11: 行の位置と、表の行か（集めないときは空。位置を求められない行は入れない）。 */
  readonly rowPaths: readonly { readonly path: readonly number[]; readonly tableRow: boolean }[];
}

/**
 * ページの中で、主な領域の構造を読む（ページに何も書かない。操作しない）。この関数はページの中で動く（外の値を参照しない）。
 * 部品（`R`）は `composeInPage` で組み込む（`src/browser/in-page-readers.ts`。CC-068）。
 * LU-3: 行の決まり（どの要素を行とするか）の owner はこの関数だけ。探す値（`input.rowNeedle`）があれば、同じ走査で、値を含む行を数え、上限
 * （`input.maxMatchedRowReferences`）までの行の要素を返す（要素の参照は `readElementsInIsolatedWorld` が受ける。数えるだけの読み取りは空の並び）。
 */
function readStructureReader(R: StandardReaders, input: ReadStructureInput): InPageElementsResult {
  // 標準の prototype の getter（部品の `standardGetter`。`src/browser/in-page-readers.ts`。CC-068）。
  const { standardGetter: getterOf } = R;
  const text = (value: unknown): string => (typeof value === 'string' ? value : '');
  const localNameOf = getterOf(Element.prototype, 'localName');
  const childrenOf = getterOf(Element.prototype, 'children');
  const parentElementOf = getterOf(Node.prototype, 'parentElement');
  const bodyOf = getterOf(Document.prototype, 'body');
  const innerTextOf = getterOf(HTMLElement.prototype, 'innerText');
  const tBodiesOf = getterOf(HTMLTableElement.prototype, 'tBodies');
  const sectionRowsOf = getterOf(HTMLTableSectionElement.prototype, 'rows');
  const rowCellsOf = getterOf(HTMLTableRowElement.prototype, 'cells');
  const collectionLengthOf = getterOf(HTMLCollection.prototype, 'length');
  const nodeListLengthOf = getterOf(NodeList.prototype, 'length');
  const itemOf = (collection: unknown, index: number): Element | null =>
    HTMLCollection.prototype.item.call(collection as HTMLCollection, index);
  const lengthOf = (collection: unknown): number => {
    const length = collectionLengthOf(collection);
    return typeof length === 'number' ? length : 0;
  };
  const closest = (element: Element, selectors: string): Element | null => Element.prototype.closest.call(element, selectors);
  const nameOf = (element: unknown): string => text(localNameOf(element));
  // LZ-3b: 文は切り詰めない。
  const innerText = (element: Element): string => text(innerTextOf(element));

  // 主な領域（`main` がちょうど 1 つ。なければ `body`）。
  const mains = Document.prototype.querySelectorAll.call(document, 'main');
  const mainCount = nodeListLengthOf(mains);
  const main = mainCount === 1 ? NodeList.prototype.item.call(mains, 0) as Element | null : null;
  const body = bodyOf(document) as Element | null | undefined;
  const region: Element | null = main ?? body ?? null;
  const regionName = main === null ? 'BODY' : 'MAIN';
  if (region === null) {
    const empty: RawReadStructure = {
      region: regionName, tableRowCounts: [], listItemCounts: [], detailEntries: [], text: '', matchedRowCount: 0, rowPaths: [],
    };
    return { value: empty, elements: [] };
  }
  const excluded = new Set(input.excludedRegionNames);
  const walker = Document.prototype.createTreeWalker.call(document, region, input.showElement, {
    acceptNode: (node: Node): number => (excluded.has(nameOf(node)) ? input.filterReject : input.filterAccept),
  });
  const tableRowCounts: number[] = [];
  const listItemCounts: number[] = [];
  const detailEntries: { term: string; value: string }[] = [];
  // LU-3: 値を含む行。比べる形は Node の側の `readTextForComparison`（`normalizeWhitespace`。空白をまとめて前後を除く）と同じ形にする（ページの中では
  // import できないので、同じ置き換えをここに書く。`probe.ts` の送信ボタンの文言と同じ扱い）。
  // LU-SFIX2-A（LU-SREV2 の Minor-3）: 比べ方の唯一の置き場（行を探す部品 `findListRowsContainingValue` と、照合の行の選び方がこれを使う）。セルの文字が値と
  // 同じか、値の前後が語の続きの文字（`input.rowValueWordCharacterPattern`）でない所に値が現れれば、当たり。
  const wordCharacter = new RegExp(input.rowValueWordCharacterPattern, 'u');
  // LU-SFIX3-A（LU-SREV3 の Minor-1）: 比べる形の唯一の決まり（値とセルの文字の両方に使う）。Unicode の互換の正規化（`input.rowValueNormalizationForm`。形の名前の owner は `src/core/text.ts`）をかけ、見えない書式の文字（`\p{Cf}`。ZWSP・ZWJ・
  // ZWNJ・BOM など）を除き、NBSP を空白にし、空白をまとめて前後を除き、大文字と小文字を区別しない（`text-transform` で見た目が変わる形に合わせる）。
  const comparableOf = (value: string): string => value.normalize(input.rowValueNormalizationForm).replace(/\p{Cf}/gu, '').replace(/\u{00A0}/gu, ' ')
    .replace(/\s+/gu, ' ').trim().toLowerCase();
  // LU-SFIX3-A: 描かれていないセル（`checkVisibility` が偽。なければ部品の見え方の判定）は比べない。
  const rendered = (element: Element): boolean => (typeof Element.prototype.checkVisibility === 'function'
    ? Element.prototype.checkVisibility.call(element)
    : R.isVisible(element));
  const cellHasValue = (cellText: string, needle: string): boolean => {
    const normalized = comparableOf(cellText);
    if (normalized === needle) {
      return true;
    }
    for (let at = normalized.indexOf(needle); at >= 0; at = normalized.indexOf(needle, at + 1)) {
      const before = Array.from(normalized.slice(0, at)).at(-1) ?? '';
      const after = Array.from(normalized.slice(at + needle.length))[0] ?? '';
      if (!wordCharacter.test(before) && !wordCharacter.test(after)) {
        return true;
      }
    }
    return false;
  };
  /** 行の中のセル（表の行は `td`・`th`、一覧の項目は子の要素と項目の全体）。 */
  const cellsOf = (row: Element): Element[] => {
    const cells: Element[] = [];
    if (nameOf(row) === 'tr') {
      const rowCells = rowCellsOf(row);
      for (let index = 0; index < lengthOf(rowCells); index += 1) {
        const cell = itemOf(rowCells, index);
        if (cell !== null) cells.push(cell);
      }
      return cells;
    }
    const children = childrenOf(row);
    for (let index = 0; index < lengthOf(children); index += 1) {
      const child = itemOf(children, index);
      if (child !== null) cells.push(child);
    }
    // LU-SFIX2-A fix round 1: 一覧の項目は、子の要素に加えて項目の全体も比べる（値が文字の節で直接書かれた `<li>値 <button>…</button></li>` の形）。
    cells.push(row);
    return cells;
  };
  const rowNeedle = input.rowNeedle === null ? null : comparableOf(input.rowNeedle);
  let matchedRowCount = 0;
  const matchedRows: Element[] = [];
  // LU-11: 行の位置（同じ行の決まりで集める。発見の候補の要素の位置と同じ形 `elementPathOf`）。
  const rowPaths: { path: number[]; tableRow: boolean }[] = [];
  const visitRow = (row: Element): void => {
    if (input.collectRowPaths) {
      const path = R.elementPathOf(row);
      if (path !== null) {
        rowPaths.push({ path, tableRow: nameOf(row) === 'tr' });
      }
    }
    if (input.rowNeedle === null) {
      return;
    }
    const needle = rowNeedle;
    if (needle !== null && needle.length > 0 && cellsOf(row).some((cell) => rendered(cell) && cellHasValue(text(innerTextOf(cell)), needle))) {
      matchedRowCount += 1;
      if (matchedRows.length < input.maxMatchedRowReferences) {
        matchedRows.push(row);
      }
    }
  };
  /** 外側の構造の中にあるか（`region` の外は見ない）。 */
  const insideOuter = (element: Element, selectors: string): boolean => {
    const parent = parentElementOf(element) as Element | null;
    if (parent === null) {
      return false;
    }
    const outer = closest(parent, selectors);
    return outer !== null && (outer === region || Node.prototype.contains.call(region, outer));
  };
  const countTableRows = (table: Element): number => {
    let rows = 0;
    const bodies = tBodiesOf(table);
    for (let bodyIndex = 0; bodyIndex < lengthOf(bodies); bodyIndex += 1) {
      const section = itemOf(bodies, bodyIndex);
      const sectionRows = section === null ? null : sectionRowsOf(section);
      for (let rowIndex = 0; rowIndex < lengthOf(sectionRows); rowIndex += 1) {
        const row = itemOf(sectionRows, rowIndex);
        const cells = row === null ? null : rowCellsOf(row);
        let hasDataCell = false;
        for (let cellIndex = 0; cellIndex < lengthOf(cells) && !hasDataCell; cellIndex += 1) {
          hasDataCell = nameOf(itemOf(cells, cellIndex)) === 'td';
        }
        if (hasDataCell && row !== null) {
          rows += 1;
          visitRow(row);
        }
      }
    }
    return rows;
  };
  const countListItems = (list: Element): number => {
    const children = childrenOf(list);
    let items = 0;
    for (let index = 0; index < lengthOf(children); index += 1) {
      const child = itemOf(children, index);
      if (child !== null && nameOf(child) === 'li') {
        items += 1;
        visitRow(child);
      }
    }
    return items;
  };
  const readDetails = (list: Element): void => {
    let pendingTerms: string[] = [];
    const visit = (container: Element): void => {
      const children = childrenOf(container);
      for (let index = 0; index < lengthOf(children); index += 1) {
        const child = itemOf(children, index);
        if (child === null) {
          continue;
        }
        const name = nameOf(child);
        if (name === 'div' && container === list) {
          visit(child);
        } else if (name === 'dt') {
          pendingTerms.push(innerText(child));
        } else if (name === 'dd' && pendingTerms.length > 0) {
          const value = innerText(child);
          for (const term of pendingTerms) {
            detailEntries.push({ term, value });
          }
          pendingTerms = [];
        }
      }
    };
    visit(list);
  };

  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const element = node as Element;
    const name = nameOf(element);
    if (name === 'table' && !insideOuter(element, 'table')) {
      tableRowCounts.push(countTableRows(element));
    } else if ((name === 'ul' || name === 'ol') && !insideOuter(element, 'ul, ol, table')) {
      listItemCounts.push(countListItems(element));
    } else if (name === 'dl') {
      readDetails(element);
    }
  }
  const value: RawReadStructure = {
    region: regionName, tableRowCounts, listItemCounts, detailEntries, text: innerText(region), matchedRowCount, rowPaths,
  };
  return { value, elements: matchedRows };
}
const readStructureInPage = composeInPage(readStructureReader);

/** 読んだ値の形が違う（ページの中の読み取りの誤り。読めなかったとして扱う）。 */
class ReadStructureShapeError extends Error {}

const requireArray = (value: unknown): readonly unknown[] => {
  if (!Array.isArray(value)) throw new ReadStructureShapeError();
  return value;
};
const requireString = (value: unknown): string => {
  if (typeof value !== 'string') throw new ReadStructureShapeError();
  return value;
};
const requireCount = (value: unknown): number => {
  if (!isNonNegativeSafeInteger(value)) throw new ReadStructureShapeError();
  return value;
};

/** 読んだ値を、契約の形にする（形が違えば `ReadStructureShapeError`）。文字は空白をまとめる。 */
const structureOf = (value: unknown, settled: boolean): ReadPageStructure => {
  if (!isRecord(value)) throw new ReadStructureShapeError();
  const region = requireString(value['region']);
  if (!(READ_PAGE_REGIONS as readonly string[]).includes(region)) throw new ReadStructureShapeError();
  // L4: 読んだ値を、件数と長さで切らない。
  const detailEntries: readonly ReadDetailEntry[] = requireArray(value['detailEntries']).map((entry) => {
    if (!isRecord(entry)) throw new ReadStructureShapeError();
    return Object.freeze({
      term: normalizeWhitespace(requireString(entry['term'])),
      value: normalizeWhitespace(requireString(entry['value'])),
    });
  });
  return Object.freeze({
    region: region as ReadPageRegion,
    tableRowCounts: Object.freeze(requireArray(value['tableRowCounts']).map(requireCount)),
    listItemCounts: Object.freeze(requireArray(value['listItemCounts']).map(requireCount)),
    detailEntries: Object.freeze(detailEntries),
    text: normalizeWhitespace(requireString(value['text'])),
    // LZ-3b: 上限がないので、いつも偽（READ の記録の schema が求める項目なので残す）。
    limitReached: false,
    settled,
  });
};

/**
 * 構造の読み取りの結果。L4: 見張りが読み取りを終えたときは `FAILED` に理由（`end`）を持つ（全く反応がない・静まらない）。
 */
export type ReadStructureOutcome =
  | { readonly status: 'READ'; readonly structure: ReadPageStructure }
  | { readonly status: 'FAILED'; readonly end?: ReadWatchEnd };

const READ_FAILED: ReadStructureOutcome = Object.freeze({ status: 'FAILED' });

/** L4: 見張りが終えた読み取りの、理由つきの読めなかった結果。 */
const watchEndedOf = (end: ReadWatchEnd): { readonly status: 'FAILED'; readonly end: ReadWatchEnd } => Object.freeze({ status: 'FAILED', end });

/**
 * 主な領域の構造を、isolated world の 1 回の読み取り（`readInIsolatedWorld`）で読む（例外を投げない）。`deadlineAtMs` までに読めなければ
 * `FAILED`（`undefined` は期限なし）。`settled` は、呼ぶ側が決めた落ち着きの結果（構造の値に写すだけ）。
 */
export async function readPageStructure(page: Page, deadlineAtMs: number | undefined, settled = true): Promise<ReadStructureOutcome> {
  const outcome = await readInIsolatedWorld(page, readStructureInPage, READ_STRUCTURE_INPUT, deadlineAtMs);
  if (outcome.status !== 'READ' || !isRecord(outcome.value)) {
    return READ_FAILED;
  }
  try {
    return Object.freeze({ status: 'READ', structure: structureOf(outcome.value['value'], settled) });
  } catch {
    return READ_FAILED;
  }
}

/**
 * READ の結果のページが落ち着くのを待ってから、構造を読む（例外を投げない）。発見と同じ待ち（進行中の要求 0 が続き、2 回続けて同じ構造）。
 * 落ち着いたら、待ちの最後の読み取りを返す。上限を超えたら、もう 1 回だけ読み、`settled` を偽にして返す。読めなければ `FAILED`。待ちの間に
 * 読み込みを足さない。`counter` は、呼ぶ側が読み込みの前に作り、`dispose` する。
 * L4（L0 につなぐ）: 全体を進みの見張りで包む（`watchedPageRead`）。落ち着きの待ちの読み取りは、新しい値を読んだときだけ進みの印を付け（同じ値の繰り返しは
 * 進みに数えない）、最後の 1 回の読み取りは期限を置かずに、返ったら印を付ける。全く反応がない・静まらないときだけ、理由つきの `FAILED` を返す。
 */
export async function readSettledPageStructure(
  page: Page,
  counter: InFlightRequestCounter,
  settlePolicy: DiscoverySettlePolicy = DISCOVERY_SETTLE_POLICY,
  watch: ReadWatchOptions = {},
): Promise<ReadStructureOutcome> {
  return watchedPageRead(page, async (signals) => {
    let last: ReadPageStructure | null = null;
    let lastKey: string | null = null;
    const settled = await waitForDiscoverySettled(counter, async (deadlineAtMs) => {
      const read = await readPageStructure(page, deadlineAtMs);
      if (read.status !== 'READ') {
        return null;
      }
      const key = JSON.stringify(read.structure);
      if (key !== lastKey) {
        signals.mark('BROWSER_RESPONSE');
        lastKey = key;
      }
      last = read.structure;
      return [key];
    }, settlePolicy);
    const settledStructure: ReadPageStructure | null = last;
    if (settled.status === 'SETTLED' && settledStructure !== null) {
      return Object.freeze({ status: 'READ', structure: settledStructure });
    }
    return signals.track(readPageStructure(page, undefined, false));
  }, watchEndedOf, READ_FAILED, watch);
}

/** 対象の画面の候補（`readCandidatePage`）。 */
export interface ReadCandidatePage {
  /** 今の画面の候補（発見の入口が読んだもの。まとめる前）。 */
  readonly candidates: readonly DiscoveryCandidate[];
  /** 画面を読み切れたか（発見の成果物で「読んだ画面」に数えるか。偽なら、候補が見つからなくても消えたと言わない）。 */
  readonly reliable: boolean;
}

/** 対象の画面の読み取りの指定。 */
export interface ReadCandidatePageOptions {
  readonly classificationPolicy: CandidateClassificationPolicy;
  /** 進行中の要求の数え方（画面を読み込む前に作ったもの。呼ぶ側が `dispose` する）。 */
  readonly requestCounter: InFlightRequestCounter;
  readonly settlePolicy?: DiscoverySettlePolicy | undefined;
}

/**
 * 読み込んだ対象の画面（Guard の付いた Passive の Context の、ただ 1 つの page）の候補を、発見の入口で読む（例外を投げない）。凍結をかけるので、
 * この Context では、以後、ページを読み込まない。候補の確かめは、純粋な `confirmReadTargetOnPage` で行う（同じ画面の定義のすべてに使う）。
 */
export async function readCandidatePage(page: Page, options: ReadCandidatePageOptions): Promise<ReadCandidatePage> {
  const record = await discoverPageCandidates(page, {
    classificationPolicy: options.classificationPolicy,
    requestCounter: options.requestCounter,
    settlePolicy: options.settlePolicy,
  });
  // 候補が消えたと言えるのは、読み切れた画面だけ（判定は発見の owner の `isDiscoveryPageReadInFull` に任せる）。
  return Object.freeze({ candidates: record.candidates, reliable: isDiscoveryPageReadInFull(record) });
}

// ---------------------------------------------------------------------------------------------------------------
// LU-3（設計書 `2026-11-02-beaksight-list-row-update-design.md` 5.5 の 2、4.0 の D4）: 値を含む行の読み取り
// ---------------------------------------------------------------------------------------------------------------

/**
 * 値を含む行の参照（文書の根からの位置と、CDP の要素の番号）。行の中の開き手を押す部品（`src/browser/api-write-submitter.ts` の `pressListRowOpener`）が、
 * 同じ位置の要素がこの要素のままかを確かめ、行の中の候補を位置で選ぶ。値は持たない。
 */
export interface ListRowReference {
  readonly path: readonly number[];
  readonly backendNodeId: number;
}

/**
 * 値を含む行の読み取りの結果。`matchedRowCount` は値を含む行の数。`row` は、ちょうど 1 つで、位置があるときだけ。読めなければ `FAILED`。
 * LZ-3b: 上限の印（前の `limitReached`）は、上限がないので消した。
 */
export type ListRowSearchOutcome =
  | { readonly status: 'READ'; readonly matchedRowCount: number; readonly row: ListRowReference | null }
  | { readonly status: 'FAILED'; readonly end?: ReadWatchEnd };

const ROW_SEARCH_FAILED: ListRowSearchOutcome = Object.freeze({ status: 'FAILED' });

/**
 * LU-3: 主な領域の行（数える読み取りと同じ行の決まり。`readStructureReader`）のうち、`value` を含む行を数え、ちょうど 1 つなら、その行の参照を返す（例外を
 * 投げない）。整え方は READ の答え合わせと同じ（`readTextForComparison`。空白をまとめて前後を除く）。LU-SFIX2-A（LU-SREV2 の Minor-3）: 含むかは、部分一致でなく、
 * 行の中のセルの文字が値と同じか、値が語の区切りで現れるか（比べ方の唯一の置き場は `readStructureReader`）。読むだけで、押さない・
 * 入れない。値は記録しない（ページの中へ渡すだけ）。整えた値が空なら、どの行にも当たるので `FAILED`。ページ送り・検索はしない（D4）。
 * L4（L0 につなぐ）: 読み取りを進みの見張りで包む（`watchedPageRead`）。期限は、呼ぶ側が渡したときだけ効く（省けば置かない）。全く反応がない・静まらないときは、
 * 理由つきの `FAILED`。
 */
export async function findListRowsContainingValue(
  page: Page,
  value: string,
  deadlineAtMs: number | undefined = undefined,
  watch: ReadWatchOptions = {},
): Promise<ListRowSearchOutcome> {
  if (typeof value !== 'string') {
    return ROW_SEARCH_FAILED;
  }
  const needle = readTextForComparison(value);
  if (needle.length === 0) {
    return ROW_SEARCH_FAILED;
  }
  return watchedPageRead(page, (signals) => signals.track(searchListRows(page, needle, deadlineAtMs)), watchEndedOf, ROW_SEARCH_FAILED, watch);
}

/** LU-3: 値を含む行の、isolated world の 1 回の読み取り（`findListRowsContainingValue` の中身。例外を投げない）。 */
async function searchListRows(page: Page, needle: string, deadlineAtMs: number | undefined): Promise<ListRowSearchOutcome> {
  const outcome = await readElementsInIsolatedWorld(page, readStructureInPage, { ...READ_STRUCTURE_INPUT, rowNeedle: needle }, deadlineAtMs);
  // 要素の参照の読み取りは、ページの中の結果の `value`（構造）を、そのまま返す。
  if (outcome.status !== 'READ' || !isRecord(outcome.value)) {
    return ROW_SEARCH_FAILED;
  }
  const raw = outcome.value;
  const matchedRowCount = raw['matchedRowCount'];
  if (!isNonNegativeSafeInteger(matchedRowCount) || outcome.elements.length > MAX_MATCHED_ROW_REFERENCES) {
    return ROW_SEARCH_FAILED;
  }
  const [only] = outcome.elements;
  const row = matchedRowCount === 1 && only !== undefined && only.path !== null
    ? Object.freeze({ path: only.path, backendNodeId: only.backendNodeId })
    : null;
  return Object.freeze({ status: 'READ', matchedRowCount, row });
}

// ---------------------------------------------------------------------------------------------------------------
// LU-11（設計書 `2026-11-02-beaksight-list-row-update-design.md` 5.4 の 4、D5）: 行の位置の読み取りと、フォームを開き手の行に結ぶ決まり
// ---------------------------------------------------------------------------------------------------------------

/** 行 1 つの位置（文書の根からの要素の位置）と、表の行（`tr`）か（一覧の `li` は偽）。値は持たない。 */
export interface ListRowPath {
  readonly path: readonly number[];
  readonly tableRow: boolean;
}

/** 行の位置の読み取りの結果（読めなければ `FAILED`。LZ-3b: 上限の印 `limitReached` は、上限がないので消した）。 */
export type ListRowPathsOutcome =
  | { readonly status: 'READ'; readonly rows: readonly ListRowPath[] }
  | { readonly status: 'FAILED'; readonly end?: ReadWatchEnd };

const ROW_PATHS_FAILED: ListRowPathsOutcome = Object.freeze({ status: 'FAILED' });

/** 要素の位置の 1 歩の形か（文書の中の位置だけ。0 以上の整数）。 */
const isPathStep = (value: unknown): value is number => isNonNegativeSafeInteger(value);

/**
 * LU-11: 主な領域の行（数える読み取りと同じ行の決まり。`readStructureReader`）の位置を、isolated world の 1 回の読み取りで読む（例外を投げない）。読むだけで、
 * 押さない・入れない。値と文字は返さない。発見の入口（`src/discovery/discover-page.ts`）が、フォームの候補を同じ行の開き手に結ぶのに使う。
 * L4（L0 につなぐ）: 読み取りを進みの見張りで包む（`watchedPageRead`）。期限は、呼ぶ側が渡したときだけ効く（省けば置かない）。全く反応がない・静まらないときは、
 * 理由つきの `FAILED`。
 */
export async function readListRowPaths(
  page: Page,
  deadlineAtMs: number | undefined = undefined,
  watch: ReadWatchOptions = {},
): Promise<ListRowPathsOutcome> {
  return watchedPageRead(page, (signals) => signals.track(readRowPathsOnce(page, deadlineAtMs)), watchEndedOf, ROW_PATHS_FAILED, watch);
}

/** LU-11: 行の位置の、isolated world の 1 回の読み取り（`readListRowPaths` の中身。例外を投げない）。 */
async function readRowPathsOnce(page: Page, deadlineAtMs: number | undefined): Promise<ListRowPathsOutcome> {
  const outcome = await readInIsolatedWorld(page, readStructureInPage, { ...READ_STRUCTURE_INPUT, collectRowPaths: true }, deadlineAtMs);
  if (outcome.status !== 'READ' || !isRecord(outcome.value) || !isRecord(outcome.value['value'])) {
    return ROW_PATHS_FAILED;
  }
  const raw = outcome.value['value'];
  const rawRows = raw['rowPaths'];
  if (!Array.isArray(rawRows)) {
    return ROW_PATHS_FAILED;
  }
  const rows: ListRowPath[] = [];
  for (const row of rawRows as readonly unknown[]) {
    if (!isRecord(row) || typeof row['tableRow'] !== 'boolean' || !Array.isArray(row['path']) || !(row['path'] as readonly unknown[]).every(isPathStep)) {
      return ROW_PATHS_FAILED;
    }
    rows.push(Object.freeze({ path: Object.freeze([...(row['path'] as readonly number[])]), tableRow: row['tableRow'] }));
  }
  return Object.freeze({ status: 'READ', rows: Object.freeze(rows) });
}

/** `path` が `ancestor` の中（同じ要素を含む）か。 */
const isInsidePath = (ancestor: readonly number[], path: readonly number[]): boolean =>
  ancestor.length <= path.length && ancestor.every((step, index) => path[index] === step);

/** 要素を含む、最も内側の行（なければ null）。 */
const innermostRowOf = (rows: readonly ListRowPath[], path: readonly number[]): ListRowPath | null =>
  rows.reduce<ListRowPath | null>((found, row) => (isInsidePath(row.path, path) && (found === null || row.path.length > found.path.length) ? row : found), null);

/** 表の行のすぐ前の兄弟の表の行（同じ親の、1 つ前の要素の位置。なければ null）。 */
const precedingTableRowOf = (rows: readonly ListRowPath[], row: ListRowPath): ListRowPath | null => {
  const last = row.path.at(-1);
  if (!row.tableRow || last === undefined || last === 0) {
    return null;
  }
  const parent = row.path.slice(0, -1);
  return rows.find((other) => other.tableRow && other.path.length === row.path.length
    && isInsidePath(parent, other.path) && other.path.at(-1) === last - 1) ?? null;
};

/**
 * LU-11（設計者の判断。LU-11 fix round 1）: フォームの要素（`formPath`）を、開き手の行に結ぶ決まりの唯一の置き場所（純粋）。フォームを含む最も内側の行に開き手が
 * ある（`hasOpener`）なら、その行。その行が表の行で開き手がなく、すぐ前の兄弟の表の行（行の下に広がる隠れた行の形）に開き手があれば、その前の行（広げるのは
 * この 1 つだけ。一覧の `li` は同じ `li` の中だけ）。どれでもなければ null。開き手の数（0 か 2 以上なら結ばない）は呼ぶ側が決める（`hasOpener` は 1 つ
 * 以上あるかを返す）。
 */
export const listRowOfFormPath = (
  rows: readonly ListRowPath[],
  formPath: readonly number[],
  hasOpener: (row: ListRowPath) => boolean,
): ListRowPath | null => {
  const own = innermostRowOf(rows, formPath);
  if (own === null) {
    return null;
  }
  if (hasOpener(own)) {
    return own;
  }
  const preceding = precedingTableRowOf(rows, own);
  return preceding !== null && hasOpener(preceding) ? preceding : null;
};

/** LU-11: 要素（`path`）が行の中か（行の決まりの owner の比べ方。開き手のボタンを行に数えるのに使う）。 */
export const isInsideListRow = (row: ListRowPath, path: readonly number[]): boolean => isInsidePath(row.path, path);
