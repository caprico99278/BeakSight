/**
 * Server Function の入力の検証（Task 23 設計書 4.4、Task 24 の設計書 4.8。T23f で作り、T24f でプロファイルと監査のジョブの Server Functions の
 * 共用にした）。入力は、サーバで `schemas/control/` のスキーマ（`ui-*`）で確かめてから使う。画面の側の確かめは補助だけ。
 */
import { validateControlDocument, type ControlSchemaName } from '../../../../src/control/control-schema-validator.js';

/** スキーマに合わない入力の応答の状態。 */
export const BAD_REQUEST_STATUS = 400;

/** スキーマ `schemaName` で入力を確かめる。合わなければ 400 の応答を投げる（Server Function の外へ、そのまま返る）。 */
export const requestOf = <TRequest>(schemaName: ControlSchemaName) => (input: unknown): TRequest => {
  const result = validateControlDocument(schemaName, input);
  if (!result.ok) {
    throw new Response(JSON.stringify({ error: 'INVALID_REQUEST' }), {
      status: BAD_REQUEST_STATUS,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }
  return input as TRequest;
};
