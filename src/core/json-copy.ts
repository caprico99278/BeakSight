// JSON の値の写しの唯一の owner（台帳の CC-077 の残り。PRE42-CC 組 1b）。純粋な関数。
// - 与えた値を JSON にして読み直した写しを返す（入力を変えない）。関数・`Symbol` などの JSON でない値は落ちる（項目から消える。最上位なら
//   `JSON.parse` が `SyntaxError` を投げる）。`undefined` だけは写さずに、そのまま `undefined` を返す（呼び出し側がスキーマなどで拒む）。
// - 使う所: スキーマで確かめた凍結した写し（`src/control/schema-checked-copy.ts`）、シナリオの下書きの写し（`src/control/approval/scenario-store.ts`）、
//   入力の規則の集まりの中身の写し（`src/control/data-rules/rule-store.ts`）。
// - JSON の写しは、このファイルの外に書かない（`tests/architecture/control-read-ownership.test.ts` の (c)）。閉じた例外は Guard の写し
//   （`src/safety/passive-request-guard.ts`。Guard の写しは寄せない）だけ。

/** JSON の値の写し（入力を変えない。`undefined` はそのまま）。 */
export const jsonCopyOf = (value: unknown): unknown => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)) as unknown);
