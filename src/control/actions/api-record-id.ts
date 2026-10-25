// API のシナリオの書き込みの応答の本文から、登録の ID を取り出す口（T39c。Task 39 の設計書 3.4、Task 40 の D3。組み込みは Task 40）。純粋な関数。
// - 登録の ID の取り方 `RESPONSE_BODY_KEY`（シナリオの `api.recordId.key`）の鍵で、応答の本文（JSON）の最上位の object か、要素が 1 つだけの array の
//   その object（表現を返す応答の形）から、値を読む。値は文字列か、0 以上の安全な整数（10 進の文字列にする）だけ。
// - 使える形の ID（`isUsableRecordId`。path の 1 区切りに入れて安全な閉じた形）だけを返し、ほかは null（ID なし）。
// - 本文はメモリの中だけで扱い、記録しない。返すのは ID だけ。上限（`MAX_API_RECORD_ID_BODY_BYTES`）を超える本文、UTF-8 でない本文、JSON でない本文は
//   読まない（null）。例外を投げない。
// - CC-104: 応答の本文の解読（上限、UTF-8、JSON）は 1 つの手順（`decodedApiResponseBodyOf`）にまとめ、本文の形（`apiResponseBodyShapeOf`）、一覧の要素の
//   数（`apiResponseListLength`）、登録の ID（`apiRecordIdOfResponseBody`）と、ワーカーの読めない本文の判定（`isUnreadableApiResponseBody`）が、その上に載る。
import { usableRecordIdOf } from './action-outcome.js';

/** 読む応答の本文の上限（bytes。1 件の登録・更新の表現に余裕を見た値。超えたら読まない）。 */
export const MAX_API_RECORD_ID_BODY_BYTES = 1_048_576;

/** 最上位の object（要素が 1 つだけの array なら、その要素の object）。なければ null。 */
const recordObjectOf = (parsed: unknown): Readonly<Record<string, unknown>> | null => {
  const candidate = Array.isArray(parsed) ? (parsed.length === 1 ? parsed[0] : null) : parsed;
  return typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate) ? candidate as Readonly<Record<string, unknown>> : null;
};

/** ID の候補の文字列（文字列か、0 以上の安全な整数。ほかは null）。 */
const idTextOf = (value: unknown): string | null => {
  if (typeof value === 'string') {
    return value;
  }
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
};

/** 応答の本文を解読した結果（`NONE`: 空の本文。`PARSED`: JSON の値。`UNREADABLE`: 上限を超える、バイト列でない、UTF-8・JSON でない）。 */
type DecodedApiResponseBody = { readonly kind: 'NONE' } | { readonly kind: 'PARSED'; readonly value: unknown } | { readonly kind: 'UNREADABLE' };

const NO_BODY = Object.freeze({ kind: 'NONE' } as const);
const UNREADABLE_BODY = Object.freeze({ kind: 'UNREADABLE' } as const);

/**
 * CC-104（T41R2-fix の発見事項 1）: 応答の本文の解読（上限 `MAX_API_RECORD_ID_BODY_BYTES`、UTF-8、JSON）の唯一の手順。本文はメモリの中だけで扱う。例外を
 * 投げない。
 */
const decodedApiResponseBodyOf = (body: Uint8Array): DecodedApiResponseBody => {
  try {
    if (!(body instanceof Uint8Array) || body.byteLength > MAX_API_RECORD_ID_BODY_BYTES) {
      return UNREADABLE_BODY;
    }
    if (body.byteLength === 0) {
      return NO_BODY;
    }
    return { kind: 'PARSED', value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) as unknown };
  } catch {
    return UNREADABLE_BODY;
  }
};

/**
 * CC-104: 応答の本文の形。`NONE` は空の本文（204 など）、`LIST` は一覧（`length` は要素の数）、`OTHER` は一覧でない JSON（object・scalar）、`UNREADABLE` は
 * 上限を超える、UTF-8・JSON でない本文（空白だけの本文を含む）。
 */
export type ApiResponseBodyShape =
  | { readonly kind: 'NONE' }
  | { readonly kind: 'LIST'; readonly length: number }
  | { readonly kind: 'OTHER' }
  | { readonly kind: 'UNREADABLE' };

/** CC-104: 応答の本文の形（`decodedApiResponseBodyOf` の上に載る。本文は記録しない。例外を投げない）。 */
export function apiResponseBodyShapeOf(body: Uint8Array): ApiResponseBodyShape {
  const decoded = decodedApiResponseBodyOf(body);
  if (decoded.kind !== 'PARSED') {
    return decoded;
  }
  return Array.isArray(decoded.value) ? Object.freeze({ kind: 'LIST', length: decoded.value.length }) : Object.freeze({ kind: 'OTHER' });
}

/**
 * T41d（Task 41 の設計書 3.4 の 3）・T41R-fix（設計書 8 章の「T41R の完全版」の I-2）: 応答の本文が一覧なら、その要素の数（表現を返す更新で、更新した行の
 * 数。0 は更新した行がない、2 以上は 2 行以上を更新した）。一覧でない本文、空の本文、上限を超える本文、UTF-8・JSON でない本文は null。CC-104: 本文の形
 * （`apiResponseBodyShapeOf`）の上に載る。本文は記録しない。例外を投げない。
 */
export function apiResponseListLength(body: Uint8Array): number | null {
  const shape = apiResponseBodyShapeOf(body);
  return shape.kind === 'LIST' ? shape.length : null;
}

/** 応答の本文 `body` から、鍵 `key` の登録の ID を取り出す（使える形の ID だけ。ほかは null）。CC-104: 解読は `decodedApiResponseBodyOf`。 */
export function apiRecordIdOfResponseBody(body: Uint8Array, key: string): string | null {
  try {
    if (typeof key !== 'string' || key.length === 0) {
      return null;
    }
    const decoded = decodedApiResponseBodyOf(body);
    const record = decoded.kind === 'PARSED' ? recordObjectOf(decoded.value) : null;
    if (record === null || !Object.hasOwn(record, key)) {
      return null;
    }
    return usableRecordIdOf(idTextOf(record[key]));
  } catch {
    return null;
  }
}
