// 管理の契約のスキーマで確かめた、凍結した写しの唯一の手順（CCX-17。台帳の CC-077）。純粋な関数（スキーマの読み込みは
// `control-schema-validator.ts` に任せる）。
// - 手順: JSON の写し（入力を変えない。関数などの JSON でない値は落ちて、スキーマで拒まれる。`undefined` は写さずにスキーマで拒む）→ スキーマで
//   確かめる（`validateControlDocument`）→ 凍結（`deepFreeze`）。
// - 使う所: READ の確かめの定義（`src/control/read-check-policy.ts`）、シナリオの版と承認の記録（`src/control/approval/scenario-policy.ts`）、
//   発見の根拠の写し（`src/control/approval/scenario-facts.ts`）、入力の規則の集まりの版（`src/control/data-rules/rule-set-policy.ts`）。同じ手順を
//   ほかのファイルに書かない（Architecture Gate `control-read-ownership.test.ts` の (a)）。
import { deepFreeze } from '../core/immutable.js';
import { jsonCopyOf } from '../core/json-copy.js';
import { validateControlDocument, type ControlSchemaName } from './control-schema-validator.js';

/** スキーマで確かめた写し。通れば凍結した写し、通らなければスキーマの誤りの文（英語。項目の位置だけ）。 */
export type SchemaCheckedCopy<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly string[] };

/** 管理の契約のスキーマ（`schemaName`）で確かめた、凍結した写し（純粋。入力を変えない）。 */
export const schemaCheckedCopyOf = <T>(schemaName: ControlSchemaName, value: unknown): SchemaCheckedCopy<T> => {
  const copy = jsonCopyOf(value);
  const shape = validateControlDocument(schemaName, copy);
  return shape.ok
    ? Object.freeze({ ok: true, value: deepFreeze(copy as T) })
    : Object.freeze({ ok: false, errors: Object.freeze([...shape.errors]) });
};

/**
 * 管理の契約のスキーマで確かめた、凍結した写し。通らなければ `RangeError`（`the <subject> does not match the contract: <誤り>`。呼び出し側の
 * 誤りか、保存した行の誤り）。
 */
export const requireSchemaCheckedCopy = <T>(schemaName: ControlSchemaName, subject: string, value: unknown): T => {
  const checked = schemaCheckedCopyOf<T>(schemaName, value);
  if (!checked.ok) {
    throw new RangeError(`the ${subject} does not match the contract: ${checked.errors.join('; ')}`);
  }
  return checked.value;
};
