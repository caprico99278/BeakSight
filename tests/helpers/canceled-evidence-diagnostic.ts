import { expect } from 'vitest';
import type { CanceledDocumentEvidenceMissingReason } from '../../src/safety/passive-request-guard.js';

// DEF-052（設計書 `2026-10-09-beaksight-def-052-guard-evidence-wait-design.md` 2.2）: Guard が、取り消しの証拠のないまま、一時停止の ID が
// 無効な形の命令の失敗を違反にするときに、違反の文の後ろに付ける診断の形。テストの診断の組み立てと照合の部品は、ここだけに置く（CC-055）。
// 形: `<元の文言> [canceled-document-evidence: reason=<理由の語>; waited-ms=<整数>; elapsed-ms=<整数>; dropped-at-capacity=<整数>]`
// 理由の語は、製品の側の閉じた一覧（`CANCELED_DOCUMENT_EVIDENCE_MISSING_REASON`）の値を使う。

/** 0 以上の整数（先頭に 0 を付けない）。 */
const DIAGNOSTIC_INTEGER_PATTERN = '(0|[1-9]\\d*)';
/** 1 以上の整数。 */
const DIAGNOSTIC_POSITIVE_INTEGER_PATTERN = '([1-9]\\d*)';
/** 理由の語の形（照合の後に、閉じた一覧にあることを確かめる）。 */
export const DIAGNOSTIC_REASON_PATTERN = '([a-z]+(?:-[a-z]+)*)';
const escapeForPattern = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 診断の各項目の値（文字列）。 */
export interface CanceledEvidenceDiagnosticValues {
  readonly reason: string;
  readonly waitedMs: string;
  readonly elapsedMs: string;
  readonly droppedAtCapacity: string;
}

/** 診断の部分（元の文言の後ろに付く文字列）。設計書 2.2 の形の、ただ一つの定義。 */
export const canceledEvidenceDiagnosticText = (values: CanceledEvidenceDiagnosticValues): string =>
  ` [canceled-document-evidence: reason=${values.reason}; waited-ms=${values.waitedMs}; elapsed-ms=${values.elapsedMs}; dropped-at-capacity=${values.droppedAtCapacity}]`;

/** 正規表現を組み立てるときに、値の位置に置く印（正規表現で特別な文字を含まない）。 */
const DIAGNOSTIC_VALUE_MARKERS: CanceledEvidenceDiagnosticValues = Object.freeze({
  reason: '<<reason>>',
  waitedMs: '<<waited-ms>>',
  elapsedMs: '<<elapsed-ms>>',
  droppedAtCapacity: '<<dropped-at-capacity>>',
});

/** 診断の部分の正規表現の文字列（文の終わりまで）。各項目の値の形（正規表現）を受け取る。 */
const canceledEvidenceDiagnosticSource = (patterns: CanceledEvidenceDiagnosticValues): string => {
  let source = escapeForPattern(canceledEvidenceDiagnosticText(DIAGNOSTIC_VALUE_MARKERS));
  for (const key of ['reason', 'waitedMs', 'elapsedMs', 'droppedAtCapacity'] as const) {
    source = source.replace(DIAGNOSTIC_VALUE_MARKERS[key], patterns[key]);
  }
  return `${source}$`;
};

/** 場面ごとの診断の期待。理由は完全一致。待った時間と覚えなかった数は、場面で決まる場合だけ値を渡す（渡さなければ 0 以上の整数の形）。 */
export interface CanceledEvidenceDiagnosticExpectation {
  readonly reason: CanceledDocumentEvidenceMissingReason;
  readonly waitedMs?: number;
  /** 上限のために覚えなかった証拠の数の累計。`AT_LEAST_ONE` は 1 以上。 */
  readonly droppedAtCapacity?: number | 'AT_LEAST_ONE';
}

/** 元の文言で始まり、その直後に、場面の診断だけが続く違反の文の正規表現。 */
export function canceledEvidenceMessagePattern(original: string, expectation: CanceledEvidenceDiagnosticExpectation): RegExp {
  const { droppedAtCapacity } = expectation;
  return new RegExp(`^${escapeForPattern(original)}${canceledEvidenceDiagnosticSource({
    reason: escapeForPattern(expectation.reason),
    waitedMs: expectation.waitedMs === undefined ? DIAGNOSTIC_INTEGER_PATTERN : String(expectation.waitedMs),
    elapsedMs: DIAGNOSTIC_INTEGER_PATTERN,
    droppedAtCapacity: droppedAtCapacity === undefined
      ? DIAGNOSTIC_INTEGER_PATTERN
      : droppedAtCapacity === 'AT_LEAST_ONE' ? DIAGNOSTIC_POSITIVE_INTEGER_PATTERN : String(droppedAtCapacity),
  })}`);
}

/** `{ code, message }` の違反の期待（`code` は完全一致、`message` は `canceledEvidenceMessagePattern`）。 */
export const canceledEvidenceViolation = (
  code: string,
  original: string,
  expectation: CanceledEvidenceDiagnosticExpectation,
): { readonly code: string; readonly message: unknown } => ({
  code,
  message: expect.stringMatching(canceledEvidenceMessagePattern(original, expectation)),
});

/** 違反の文から、元の文言と診断の値を取り出す（形が違えば `null`）。 */
export function parseCanceledEvidenceMessage(message: string): {
  readonly original: string;
  readonly reason: string;
  readonly waitedMs: number;
  readonly elapsedMs: number;
  readonly droppedAtCapacity: number;
} | null {
  const match = new RegExp(`^(.*)${canceledEvidenceDiagnosticSource({
    reason: DIAGNOSTIC_REASON_PATTERN,
    waitedMs: DIAGNOSTIC_INTEGER_PATTERN,
    elapsedMs: DIAGNOSTIC_INTEGER_PATTERN,
    droppedAtCapacity: DIAGNOSTIC_INTEGER_PATTERN,
  })}`, 's').exec(message);
  if (match === null) return null;
  const [, original, reason, waitedMs, elapsedMs, droppedAtCapacity] = match;
  return {
    original: original ?? '',
    reason: reason ?? '',
    waitedMs: Number(waitedMs),
    elapsedMs: Number(elapsedMs),
    droppedAtCapacity: Number(droppedAtCapacity),
  };
}
