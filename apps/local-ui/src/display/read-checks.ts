/**
 * READ の確かめの定義の表示の文（Task 27 の設計書 4.5、4.7。T27f）。一覧と定義の画面が共用する（ブラウザでも動く。文言は `src/presentation/` から）。
 * 送る値（テスト用の値）と期待の値は、設計どおり画面に出す（JSON の文字列の形で、空白や記号を見分けられるように示す）。
 */
import type { ReadCheckExpectation } from '../../../../src/control/discovery-view.js';
import { formatInteger } from '../../../../src/presentation/format.js';
import { LOCAL_UI_READ_CHECK_TEXT, cliFieldText, listText } from '../../../../src/presentation/messages.js';
import { readCheckExpectationKindDisplay } from './labels';

/** 期待 1 件の表示（種類と、照らす値）。 */
export const expectationText = (expectation: ReadCheckExpectation): string => {
  const kind = readCheckExpectationKindDisplay(expectation.kind).label;
  switch (expectation.kind) {
    case 'ROW_COUNT_EQUALS':
    case 'ROW_COUNT_AT_LEAST':
      return cliFieldText(kind, formatInteger(expectation.count));
    case 'TEXT_CONTAINS':
      return cliFieldText(kind, JSON.stringify(expectation.text));
    case 'DETAIL_FIELD_EQUALS':
      return cliFieldText(kind, `${JSON.stringify(expectation.field)} = ${JSON.stringify(expectation.value)}`);
  }
};

/** 送る値の表示（`名前="値"` の並び。送る値がなければ「なし」）。 */
export const parametersText = (parameters: Readonly<Record<string, string>>): string => {
  const entries = Object.entries(parameters);
  return entries.length === 0 ? LOCAL_UI_READ_CHECK_TEXT.noParameters : listText(entries.map(([name, value]) => `${name}=${JSON.stringify(value)}`));
};
