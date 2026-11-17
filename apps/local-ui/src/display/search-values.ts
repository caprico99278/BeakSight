/**
 * MI-C2 項目 19（MI-1 の発見事項 1）: 画面の URL の search の値を、閉じた一覧の値だけにする部品（ブラウザでも動く純粋な部品）。
 * TanStack Router は根の生の search も子へ渡すので、`validateSearch` で外した値も `useSearch()` に残る。知らせの値は、`validateSearch` と、描く前の
 * 確かめ直しの両方で、この部品を通す（一覧にない値で、空の知らせの枠を出さない）。
 */

/** 値が閉じた一覧 `values` のどれかか。 */
export const isClosedSearchValue = <TValue extends string>(values: readonly TValue[], value: unknown): value is TValue =>
  values.some((candidate) => candidate === value);

/** 閉じた一覧 `values` の値ならその値、ほかは `undefined`。 */
export const closedSearchValueOf = <TValue extends string>(values: readonly TValue[], value: unknown): TValue | undefined =>
  (isClosedSearchValue(values, value) ? value : undefined);
