// RCA-4（検索の確かめの設計書 `doc/design/2026-11-18-beaksight-search-check-design.md` 2.2）: 検索の確かめで文字の欄に入れる値の種類の閉じた一覧の唯一の置き場
// （空・半角の英数字の目印・全角の仮名の目印。利用者に見せる文言ではない）。組の作り手（`search-check-plan.ts`）が公開し直す。import を持たない。
// REV-RCA fix round 2: 前は値そのもの（空・「a」・「あ」）だったが、1 文字の値はほとんどの文字列に含まれ、目印として見分けられない（token の更新などを広く止める）。
// 組・プロトコル・成果物は種類だけを持ち、値（目印）はワーカーが組ごとに作る（`searchCheckTextOf`。`submission-probe-contracts.ts`）。値は成果物・画面に残さない。

/** 文字の欄に入れる値の種類（空・半角の英数字の目印・全角の仮名の目印。この順に並べる）。 */
export const SEARCH_CHECK_TEXT_VALUES = Object.freeze(['EMPTY', 'HALF_WIDTH', 'FULL_WIDTH'] as const);
export type SearchCheckTextValue = (typeof SEARCH_CHECK_TEXT_VALUES)[number];
