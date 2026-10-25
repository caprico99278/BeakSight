// 作った値（文字列）を、API の本文の鍵の JSON の型に変える部品（Task 38 の設計書 3.6。T38e）の、入力の規則の部品のための公開し直し。
// T39a: 書き込みの段の照合（`src/safety/`。`src/control/` を import できない。Gate `control-boundary` の (a)）も使うので、本体を `src/core/json-value.ts`
// へ移した。ここは定義を持たず、本体を公開し直すだけ（第二の部品を持たない）。
export {
  JSON_SCALAR_VALUE_TYPES,
  JSON_VALUE_CONVERSION_FAILURES,
  MAX_JSON_NUMBER_DIGITS,
  isJsonValueConvertible,
  jsonNumberRangeFits,
  jsonValueOf,
  type JsonScalarValueType,
  type JsonValueConversion,
  type JsonValueConversionFailure,
} from '../../core/json-value.js';
