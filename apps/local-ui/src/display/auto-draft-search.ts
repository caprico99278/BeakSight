/**
 * 自動の下書きの案内から作成の画面を開いたことの、URL の引数の印（手を減らす段 2 の設計書 3A.2。FM2b。FM2R の Minor 13 で、発見の画面のリンクと作成の
 * 画面の読み方の 2 か所の書き写しをまとめた）。ブラウザでも動く純粋な部品。印は承認に結ばない（保存の後に推した入力の規則を付けるかだけを決める）。
 */

/** 印の値。 */
export const AUTO_DRAFT_SEARCH_MARK = '1';

/**
 * URL の引数の値が印か（ルーターは `1` を数として読み直すことがあるので、文字と数のどちらも受ける）。
 */
export const isAutoDraftSearchMark = (value: unknown): boolean => value === AUTO_DRAFT_SEARCH_MARK || value === Number(AUTO_DRAFT_SEARCH_MARK);
