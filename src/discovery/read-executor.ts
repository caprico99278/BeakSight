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
import { normalizeWhitespace } from '../core/text.js';
import type { CandidateClassificationPolicy } from './classify.js';
import { discoverPageCandidates } from './discover-page.js';
import { isDiscoveryPageReadInFull } from './discovery-result.js';
import { readInIsolatedWorld } from './isolated-read.js';
import { composeInPage, type StandardReaders } from '../browser/in-page-readers.js';
import type { DiscoveryCandidate } from './candidate-contracts.js';
import {
  READ_PAGE_REGIONS,
  type ReadDetailEntry,
  type ReadPageRegion,
  type ReadPageStructure,
} from './read-check-evaluation.js';
import { waitForDiscoverySettled, type DiscoverySettlePolicy, type InFlightRequestCounter, DISCOVERY_SETTLE_POLICY } from './settle.js';

/** 1 回の読み取りの時間の上限（ms。発見の読み取りの上限と同じ考え）。 */
export const READ_STRUCTURE_READ_TIMEOUT_MS = 10_000;
/** 主な領域で走査する要素の数の上限。 */
export const MAX_READ_STRUCTURE_ELEMENTS = 100_000;
/** 数える構造（表と一覧のそれぞれ）の数の上限。 */
export const MAX_READ_STRUCTURES = 200;
/** 読む詳細の項目の数の上限。 */
export const MAX_READ_DETAIL_ENTRIES = 500;
/** 詳細の項目の文字の、読む長さの上限（UTF-16 のコード単位。期待の値の上限より長くし、切った値が期待と一致しないようにする）。 */
export const MAX_READ_DETAIL_TEXT_LENGTH = 1_024;
/** 主な領域の見えている文字の、読む長さの上限（UTF-16 のコード単位）。 */
export const MAX_READ_TEXT_LENGTH = 200_000;
/** 表の行の、数える上限（この数を超えたら `limitReached`）。 */
export const MAX_READ_TABLE_ROWS = 100_000;
/** 数えない領域の要素の名前。 */
const EXCLUDED_REGION_NAMES = Object.freeze(['nav', 'header', 'footer', 'aside'] as const);
/** `NodeFilter` の値（ページの中の `NodeFilter` を読まずに渡す）。 */
const NODE_FILTER_SHOW_ELEMENT = 1;
const NODE_FILTER_ACCEPT = 1;
const NODE_FILTER_REJECT = 2;

/** 読み取りの上限（ページの中に渡す）。 */
interface ReadStructureInput {
  readonly maxElements: number;
  readonly maxStructures: number;
  readonly maxDetailEntries: number;
  readonly maxDetailTextLength: number;
  readonly maxTextLength: number;
  readonly maxTableRows: number;
  readonly excludedRegionNames: readonly string[];
  readonly showElement: number;
  readonly filterAccept: number;
  readonly filterReject: number;
}

const READ_STRUCTURE_INPUT: ReadStructureInput = Object.freeze({
  maxElements: MAX_READ_STRUCTURE_ELEMENTS,
  maxStructures: MAX_READ_STRUCTURES,
  maxDetailEntries: MAX_READ_DETAIL_ENTRIES,
  maxDetailTextLength: MAX_READ_DETAIL_TEXT_LENGTH,
  maxTextLength: MAX_READ_TEXT_LENGTH,
  maxTableRows: MAX_READ_TABLE_ROWS,
  excludedRegionNames: EXCLUDED_REGION_NAMES,
  showElement: NODE_FILTER_SHOW_ELEMENT,
  filterAccept: NODE_FILTER_ACCEPT,
  filterReject: NODE_FILTER_REJECT,
});

/** ページの中で読んだ構造（検査の前）。 */
interface RawReadStructure {
  readonly region: string;
  readonly tableRowCounts: readonly number[];
  readonly listItemCounts: readonly number[];
  readonly detailEntries: readonly { readonly term: string; readonly value: string }[];
  readonly text: string;
  readonly limitReached: boolean;
}

/**
 * ページの中で、主な領域の構造を読む（ページに何も書かない。操作しない）。この関数はページの中で動く（外の値を参照しない）。
 * 部品（`R`）は `composeInPage` で組み込む（`src/browser/in-page-readers.ts`。CC-068）。
 */
function readStructureReader(R: StandardReaders, input: ReadStructureInput): RawReadStructure {
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
  const innerText = (element: Element, maxLength: number): { readonly value: string; readonly truncated: boolean } => {
    const value = text(innerTextOf(element));
    return { value: value.slice(0, maxLength), truncated: value.length > maxLength };
  };

  let limitReached = false;
  // 主な領域（`main` がちょうど 1 つ。なければ `body`）。
  const mains = Document.prototype.querySelectorAll.call(document, 'main');
  const mainCount = nodeListLengthOf(mains);
  const main = mainCount === 1 ? NodeList.prototype.item.call(mains, 0) as Element | null : null;
  const body = bodyOf(document) as Element | null | undefined;
  const region: Element | null = main ?? body ?? null;
  const regionName = main === null ? 'BODY' : 'MAIN';
  if (region === null) {
    return { region: regionName, tableRowCounts: [], listItemCounts: [], detailEntries: [], text: '', limitReached: false };
  }
  const excluded = new Set(input.excludedRegionNames);
  const walker = Document.prototype.createTreeWalker.call(document, region, input.showElement, {
    acceptNode: (node: Node): number => (excluded.has(nameOf(node)) ? input.filterReject : input.filterAccept),
  });
  const tableRowCounts: number[] = [];
  const listItemCounts: number[] = [];
  const detailEntries: { term: string; value: string }[] = [];
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
        if (hasDataCell) {
          rows += 1;
          if (rows > input.maxTableRows) {
            limitReached = true;
            return rows;
          }
        }
      }
    }
    return rows;
  };
  const countListItems = (list: Element): number => {
    const children = childrenOf(list);
    let items = 0;
    for (let index = 0; index < lengthOf(children); index += 1) {
      if (nameOf(itemOf(children, index)) === 'li') {
        items += 1;
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
          // 切った文字は、期待の名前（上限は読む長さより短い）と一致しないので、上限の印にはしない。
          pendingTerms.push(innerText(child, input.maxDetailTextLength).value);
        } else if (name === 'dd' && pendingTerms.length > 0) {
          const value = innerText(child, input.maxDetailTextLength);
          for (const term of pendingTerms) {
            if (detailEntries.length >= input.maxDetailEntries) {
              limitReached = true;
              return;
            }
            detailEntries.push({ term, value: value.value });
          }
          pendingTerms = [];
        }
      }
    };
    visit(list);
  };

  let elements = 0;
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    elements += 1;
    if (elements > input.maxElements) {
      limitReached = true;
      break;
    }
    const element = node as Element;
    const name = nameOf(element);
    if (name === 'table' && !insideOuter(element, 'table')) {
      if (tableRowCounts.length >= input.maxStructures) {
        limitReached = true;
      } else {
        tableRowCounts.push(countTableRows(element));
      }
    } else if ((name === 'ul' || name === 'ol') && !insideOuter(element, 'ul, ol, table')) {
      if (listItemCounts.length >= input.maxStructures) {
        limitReached = true;
      } else {
        listItemCounts.push(countListItems(element));
      }
    } else if (name === 'dl') {
      readDetails(element);
    }
  }
  const regionText = innerText(region, input.maxTextLength);
  limitReached ||= regionText.truncated;
  return { region: regionName, tableRowCounts, listItemCounts, detailEntries, text: regionText.value, limitReached };
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
  if (!isRecord(value) || typeof value['limitReached'] !== 'boolean') throw new ReadStructureShapeError();
  const region = requireString(value['region']);
  if (!(READ_PAGE_REGIONS as readonly string[]).includes(region)) throw new ReadStructureShapeError();
  const detailEntries: readonly ReadDetailEntry[] = requireArray(value['detailEntries']).slice(0, MAX_READ_DETAIL_ENTRIES).map((entry) => {
    if (!isRecord(entry)) throw new ReadStructureShapeError();
    return Object.freeze({
      term: normalizeWhitespace(requireString(entry['term']).slice(0, MAX_READ_DETAIL_TEXT_LENGTH)),
      value: normalizeWhitespace(requireString(entry['value']).slice(0, MAX_READ_DETAIL_TEXT_LENGTH)),
    });
  });
  return Object.freeze({
    region: region as ReadPageRegion,
    tableRowCounts: Object.freeze(requireArray(value['tableRowCounts']).slice(0, MAX_READ_STRUCTURES).map(requireCount)),
    listItemCounts: Object.freeze(requireArray(value['listItemCounts']).slice(0, MAX_READ_STRUCTURES).map(requireCount)),
    detailEntries: Object.freeze(detailEntries),
    text: normalizeWhitespace(requireString(value['text']).slice(0, MAX_READ_TEXT_LENGTH)),
    limitReached: value['limitReached'],
    settled,
  });
};

/** 構造の読み取りの結果。 */
export type ReadStructureOutcome = { readonly status: 'READ'; readonly structure: ReadPageStructure } | { readonly status: 'FAILED' };

const READ_FAILED: ReadStructureOutcome = Object.freeze({ status: 'FAILED' });

/**
 * 主な領域の構造を、isolated world の 1 回の読み取り（`readInIsolatedWorld`）で読む（例外を投げない）。`deadlineAtMs` までに読めなければ
 * `FAILED`。`settled` は、呼ぶ側が決めた落ち着きの結果（構造の値に写すだけ）。
 */
export async function readPageStructure(page: Page, deadlineAtMs: number, settled = true): Promise<ReadStructureOutcome> {
  const outcome = await readInIsolatedWorld(page, readStructureInPage, READ_STRUCTURE_INPUT, deadlineAtMs);
  if (outcome.status !== 'READ') {
    return READ_FAILED;
  }
  try {
    return Object.freeze({ status: 'READ', structure: structureOf(outcome.value, settled) });
  } catch {
    return READ_FAILED;
  }
}

/**
 * READ の結果のページが落ち着くのを待ってから、構造を読む（例外を投げない）。発見と同じ待ち（進行中の要求 0 が続き、2 回続けて同じ構造）。
 * 落ち着いたら、待ちの最後の読み取りを返す。上限を超えたら、もう 1 回だけ読み、`settled` を偽にして返す。読めなければ `FAILED`。待ちの間に
 * 読み込みを足さない。`counter` は、呼ぶ側が読み込みの前に作り、`dispose` する。
 */
export async function readSettledPageStructure(
  page: Page,
  counter: InFlightRequestCounter,
  settlePolicy: DiscoverySettlePolicy = DISCOVERY_SETTLE_POLICY,
): Promise<ReadStructureOutcome> {
  let last: ReadPageStructure | null = null;
  const settled = await waitForDiscoverySettled(counter, async (deadlineAtMs) => {
    const read = await readPageStructure(page, deadlineAtMs);
    if (read.status !== 'READ') {
      return null;
    }
    last = read.structure;
    return [JSON.stringify(read.structure)];
  }, settlePolicy);
  const settledStructure: ReadPageStructure | null = last;
  if (settled.status === 'SETTLED' && settledStructure !== null) {
    return Object.freeze({ status: 'READ', structure: settledStructure });
  }
  return readPageStructure(page, Date.now() + READ_STRUCTURE_READ_TIMEOUT_MS, false);
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
