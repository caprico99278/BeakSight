/**
 * ARR-5（DEF-234）: 欄の名前の表示（データの規則の画面と、書き込みの結果の差の表が共用する）。並びの行の欄の鍵（道 `key[i]`・`key[i].name`）は、行の番号の
 * 言い方（`fieldNameDisplayOf`。文言は 1 か所）を文として出し、ほかの名前は今どおり `code` で出す。
 */
import { fieldNameDisplayOf } from '../display/write-screen-values';

export function FieldNameText({ fieldName }: Readonly<{ fieldName: string }>) {
  const { text, path } = fieldNameDisplayOf(fieldName);
  return path ? <span data-testid="field-name-path">{text}</span> : <code>{text}</code>;
}
