/**
 * ARR-5（DEF-234）: 欄の名前の表示（データの規則の画面 `DataRuleForm.tsx` と、書き込みの結果の差の表 `WriteResultDetails.tsx` が共用する部品
 * `FieldNameText`・`fieldNameDisplayOf`）。並びの行の欄の鍵（道）は行の番号の言い方（`apiKeyPathDisplayText`）、ほかは今どおり名前を `code` で出す。
 * - 部品を `react-dom/server` の `renderToStaticMarkup` で HTML にして、文字のまま比べる（ビルドとブラウザは使わない）。
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FieldNameText } from '../src/components/FieldNameText';
import { fieldNameDisplayOf } from '../src/display/write-screen-values';

describe('ARR-5: the text of a field name on the data rules screen and the write result', () => {
  it('says a key of a row of a list with the row number, without the key names or the brackets', () => {
    expect(fieldNameDisplayOf('quals[0]')).toEqual({ text: '並びの項目（1 行目）', path: true });
    expect(fieldNameDisplayOf('careers[1].name')).toEqual({ text: '並びの項目（2 行目）の 中の項目', path: true });
    const html = renderToStaticMarkup(createElement(FieldNameText, { fieldName: 'careers[1].name' }));
    expect(html).toBe('<span data-testid="field-name-path">並びの項目（2 行目）の 中の項目</span>');
    expect(html).not.toContain('careers');
  });

  it('keeps another field name as it is, in a code element', () => {
    expect(fieldNameDisplayOf('email')).toEqual({ text: 'email', path: false });
    expect(renderToStaticMarkup(createElement(FieldNameText, { fieldName: 'email' }))).toBe('<code>email</code>');
  });
});
