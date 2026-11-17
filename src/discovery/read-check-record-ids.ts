// DEF-235（設計書 `2026-11-09-beaksight-read-check-record-id-fill-design.md`。FIX-235 の指示書の読み替え）: 番号の入る画面の path の型（`{id}`）の READ の
// 確かめで、番号を自動で埋めるための純粋な部品の唯一の置き場。
// - 番号の元の選び方（`readCheckRecordIdsOf`）: 近い順に、元 1（操作さがしで読み切れた同じ型の画面の path）、元 2（点検の段のリンクの URL。開始の URL と同じ
//   Origin）、元 3（書き込みで作った登録の ID）。どの元の番号も全部を対象にし、重ねない（ユーザーの方針: 数で網羅を削らない。「1 つだけ」「N 件まで」で決めない）。
//   番号の形は、登録の ID として使える形（`isUsableRecordId`）と、ID に見える区切り（`isRecordIdLikePathSegment`）の両方で確かめる。
// - 一覧の画面の path（`readCheckListPagePathOf`）: 型の `{id}` の前までの path。元から番号が取れないとき、ワーカーがこの画面を 1 回読み、リンクから番号を取る
//   （`recordIdsOfLinkUrls`）。
// - 一致の決まり（設計書 3.4）: 自動の下書きが作った型の定義（期待が仮の 1 件 `READ_CHECK_PAGE_OPENED_EXPECTATIONS` だけ）は、READ の確かめの段では「画面が
//   開けた」を一致とする（`isPageOpenedReadCheckDefinition`。照らし方は `read-check-evaluation.ts` の `pageOpenedEvidenceOf`）。
// - 純粋な定義と関数だけ（core の純粋な部品と、READ の確かめの契約だけを import する）。
import { isRecordIdLikePathSegment } from '../core/api-request-shape.js';
import { ROW_COUNT_AT_LEAST_EXPECTATION_KIND } from '../core/read-check-expectation-kinds.js';
import { PATH_TEMPLATE_ID_SEGMENT, isUsableRecordId, recordIdOfPathPattern } from '../core/record-id-path-pattern.js';
import { isReadCheckPageTemplatePath, type ReadCheckDefinition, type ReadCheckExpectation } from './read-check-contracts.js';

/**
 * 自動の下書きが型の定義に入れる仮の期待（今の決まり: 定義は期待を 1 件以上持つ）。DEF-235: READ の確かめの段で、この期待だけを持つ型の定義は「画面が開けた」を
 * 一致とする（行の数の期待は、書き込みの段の照合で今のとおり使う）。自動の下書き（`api-scenario-autodraft.ts`）は、ここを公開し直す。
 */
export const READ_CHECK_PAGE_OPENED_EXPECTATIONS: readonly ReadCheckExpectation[] = Object.freeze([
  Object.freeze({ kind: ROW_COUNT_AT_LEAST_EXPECTATION_KIND, count: 1 } as const),
]);

/** path の区切り。 */
const PATH_SEPARATOR = '/';

/** 型の path に当たる、使える形の番号（当たらない・形の違う番号は null）。 */
const recordIdOfTemplatePath = (path: string, template: string): string | null => {
  const recordId = recordIdOfPathPattern(path, template);
  return isUsableRecordId(recordId) && isRecordIdLikePathSegment(recordId) ? recordId : null;
};

/** 使える形の番号か（元 3 の登録の ID を確かめる）。 */
const isFillableRecordId = (recordId: string): boolean => isUsableRecordId(recordId) && isRecordIdLikePathSegment(recordId);

/** 並びの順に、重ねずに足す。 */
const appendUnique = (into: string[], seen: Set<string>, values: readonly string[]): void => {
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      into.push(value);
    }
  }
};

/** 画面の path の並びから、型に当たる番号（並びの順。重ねない）。 */
const recordIdsOfPaths = (template: string, paths: readonly string[]): readonly string[] =>
  paths.flatMap((path) => {
    const recordId = recordIdOfTemplatePath(path, template);
    return recordId === null ? [] : [recordId];
  });

/**
 * URL の並び（点検の段のリンクと、一覧の画面のリンク）から、開始の URL の Origin の URL（`isStartOrigin`。呼ぶ側が Origin の判定の owner `hasAllowedOrigin` で
 * 渡す。GATE-ARCH04）で、query と fragment のない、型に当たる番号（並びの順。重ねない）。読めない URL は飛ばす。
 */
export const recordIdsOfLinkUrls = (template: string, isStartOrigin: (url: string) => boolean, urls: readonly string[]): readonly string[] => {
  const paths = urls.flatMap((value) => {
    try {
      const url = new URL(value);
      return isStartOrigin(value) && url.search.length === 0 && url.hash.length === 0 ? [url.pathname] : [];
    } catch {
      return [];
    }
  });
  const found: string[] = [];
  appendUnique(found, new Set(), recordIdsOfPaths(template, paths));
  return Object.freeze(found);
};

/** 番号の元（親が集める。どれも見つけた順）。 */
export interface ReadCheckRecordIdSources {
  /** 定義の画面の path の型。 */
  readonly template: string;
  /** 開始の URL の Origin の URL か（元 2 のリンクは、この Origin のものだけ。呼ぶ側が Origin の判定の owner で渡す）。 */
  readonly isStartOrigin: (url: string) => boolean;
  /** 元 1: 最新の操作さがしで読み切れた画面の path。 */
  readonly readPagePaths: readonly string[];
  /** 元 2: 同じ連鎖の点検の段のリンクの URL（連鎖でなければ空）。 */
  readonly auditLinkUrls: readonly string[];
  /** 元 3: この定義に結んだ登録のシナリオの書き込みで作った登録の ID（照合で確かめた回。新しい順）。 */
  readonly createdRecordIds: readonly string[];
}

/**
 * 型の定義の読む番号（純粋。ファイルの先頭の説明）: 元 1 → 元 2 → 元 3 の順に、型に当たる使える形の番号を全部、重ねずに並べる。型でない定義は空。数で削らない。
 */
export const readCheckRecordIdsOf = (sources: ReadCheckRecordIdSources): readonly string[] => {
  const { template } = sources;
  if (!isReadCheckPageTemplatePath(template)) {
    return Object.freeze([]);
  }
  const found: string[] = [];
  const seen = new Set<string>();
  appendUnique(found, seen, recordIdsOfPaths(template, sources.readPagePaths));
  appendUnique(found, seen, recordIdsOfLinkUrls(template, sources.isStartOrigin, sources.auditLinkUrls));
  appendUnique(found, seen, sources.createdRecordIds.filter(isFillableRecordId));
  return Object.freeze(found);
};

/** 型の一覧の画面の path（`{id}` の前までの path。型でなければ null）。 */
export const readCheckListPagePathOf = (template: string): string | null => {
  if (!isReadCheckPageTemplatePath(template)) {
    return null;
  }
  const segments = template.split(PATH_SEPARATOR);
  return segments.slice(0, segments.indexOf(PATH_TEMPLATE_ID_SEGMENT)).join(PATH_SEPARATOR);
};

/** 期待が、自動の下書きの仮の期待と同じか。 */
const hasPlaceholderExpectations = (expectations: readonly ReadCheckExpectation[]): boolean =>
  expectations.length === READ_CHECK_PAGE_OPENED_EXPECTATIONS.length
  && expectations.every((expectation, index) => JSON.stringify(expectation) === JSON.stringify(READ_CHECK_PAGE_OPENED_EXPECTATIONS[index]));

/**
 * 自動の下書きが作った型の定義か（画面の path が型で、期待が仮の 1 件だけ）。DEF-235（設計書 3.4）: READ の確かめの段では「画面が開けた」を一致とする。利用者が
 * 手で書いた期待は今のまま照らす（同じ期待を手で書いた型の定義も同じ扱いになるのは限界）。
 */
export const isPageOpenedReadCheckDefinition = (definition: ReadCheckDefinition): boolean =>
  definition.targetPagePath !== undefined && isReadCheckPageTemplatePath(definition.targetPagePath) && hasPlaceholderExpectations(definition.expectations);
