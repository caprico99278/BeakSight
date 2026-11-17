/**
 * AUD-7（整理の文書 `doc/design/2026-11-09-beaksight-audit-precision-triage.md` の AUD-7）: 4xx・5xx の応答の本文の要旨の、唯一の作り方（純粋な関数）。
 * - 設計者の判断（2026-11-10）:
 *   - JSON は、許した最上位の鍵（`RESPONSE_SUMMARY_JSON_KEYS`）だけを、値の型と、`RESPONSE_SUMMARY_TEXT_LENGTH` 文字までの値で残す。
 *   - text/plain は先頭の `RESPONSE_SUMMARY_TEXT_LENGTH` 文字、HTML は `<title>` だけ。ほかの種類は要旨を作らない。
 *   - 値は全部 `isSecretLikeText` に通し、当たれば値を残さず印だけを残す。
 *   - 本文を読めない応答は、要旨なしとして理由を残す。
 *   - 文字数で切るのは、本文を保存しないための守りで、網羅の上限ではない。
 * - 要旨の値は、記録とバンドルにだけ出す（画面と HTML の本文には出さない）。
 */
import type {
  ResponseBodySummaryEvidence,
  ResponseBodySummaryNoneReason,
  ResponseSummaryFieldEvidence,
  ResponseSummaryValueType,
} from '../core/evidence-types.js';
import { safeErrorMessage } from '../core/errors.js';
import { isSecretLikeText } from '../core/secret-like-text.js';
import { normalizeWhitespace } from '../core/text.js';

/** 要旨に残す値の長さ（文字。本文を保存しないための守り）。 */
export const RESPONSE_SUMMARY_TEXT_LENGTH = 200;

/** JSON の要旨に残す最上位の鍵（この順に並べる）。 */
export const RESPONSE_SUMMARY_JSON_KEYS = Object.freeze(['code', 'error', 'error_code', 'message', 'detail', 'title', 'status', 'type'] as const);

const HTML_TITLE = /<title[^>]*>([\s\S]*?)<\/title>/iu;

const none = (reason: ResponseBodySummaryNoneReason, errorText: string | null = null): ResponseBodySummaryEvidence =>
  Object.freeze({ status: 'NONE', reason, errorText });

const field = (key: string, valueType: ResponseSummaryValueType, text: string): ResponseSummaryFieldEvidence => {
  const characters = [...text];
  const truncated = characters.length > RESPONSE_SUMMARY_TEXT_LENGTH;
  const value = truncated ? characters.slice(0, RESPONSE_SUMMARY_TEXT_LENGTH).join('') : text;
  // 切る前の値で確かめる（切った所で秘密の形が崩れて、見逃さないため）。
  const secretLike = isSecretLikeText(text);
  return Object.freeze({ key, valueType, value: secretLike ? null : value, secretLike, truncated });
};

const valueTypeOf = (value: unknown): ResponseSummaryValueType => {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  switch (typeof value) {
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    default:
      return 'object';
  }
};

const isJsonContentType = (mediaType: string): boolean => mediaType === 'application/json' || mediaType.endsWith('+json');

/** 本文と content-type から、要旨を作る。 */
export function summarizeErrorResponseBody(body: Uint8Array, contentType: string | null): ResponseBodySummaryEvidence {
  const mediaType = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  const isJson = isJsonContentType(mediaType);
  if (!isJson && mediaType !== 'text/plain' && mediaType !== 'text/html') {
    return none('UNSUPPORTED_CONTENT_TYPE');
  }
  if (body.byteLength === 0) {
    return none('EMPTY_BODY');
  }
  const text = new TextDecoder('utf-8').decode(body);
  if (isJson) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return none('UNPARSABLE_JSON');
    }
    const record = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    const fields = record === null
      ? []
      : RESPONSE_SUMMARY_JSON_KEYS.flatMap((key) => {
        if (!Object.hasOwn(record, key)) {
          return [];
        }
        const value = record[key];
        return [field(key, valueTypeOf(value), typeof value === 'string' ? value : JSON.stringify(value) ?? 'null')];
      });
    return Object.freeze({ status: 'OBSERVED', format: 'JSON', fields: Object.freeze(fields) });
  }
  if (mediaType === 'text/plain') {
    return Object.freeze({ status: 'OBSERVED', format: 'TEXT', fields: Object.freeze([field('text', 'string', text)]) });
  }
  const title = HTML_TITLE.exec(text)?.[1];
  const normalized = title === undefined ? '' : normalizeWhitespace(title);
  return Object.freeze({ status: 'OBSERVED', format: 'HTML', fields: Object.freeze(normalized.length === 0 ? [] : [field('title', 'string', normalized)]) });
}

/** 本文を読めなかった応答の要旨（要旨なし。理由の文を残す）。 */
export function unreadableErrorResponseBody(error: unknown): ResponseBodySummaryEvidence {
  return none('UNREADABLE', safeErrorMessage(error));
}
