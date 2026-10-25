// シナリオの種類の値の契約（CC-106。PRE42-CC の組 2）。純粋な定義だけのファイル。
// - シナリオの契約（`src/control/approval/scenario-contracts.ts`）が、ここを公開し直して使う（一覧が候補の分類の一部であることは、そこで型で確かめる）。
//   IPC の契約（`src/control/worker-protocol.ts`）は、シナリオの契約が IPC の契約を読む（ID の形）ので、循環しないようにここから読む。画面のブラウザ側
//   （`apps/local-ui/src/components/`）も、管理データに触れずに値を読めるように、ここから読む（`scenario-transport.ts` と同じ置き方）。
// - 種類の値を書くのはここだけ（`tests/architecture/owner-constant-reuse.test.ts` の (d)。`'UPDATE' satisfies ScenarioKind` を書き写さない）。
// - `CREATE`: 登録のシナリオ。`UPDATE`: 更新のシナリオ（候補の分類のうち、書き込みの 2 つ）。

/** シナリオの種類（閉じた一覧）。 */
export const SCENARIO_KINDS = Object.freeze(['CREATE', 'UPDATE'] as const);
export type ScenarioKind = (typeof SCENARIO_KINDS)[number];

/** 種類の値の名前つきの定数（`SCENARIO_KINDS` の要素）。 */
export const CREATE_SCENARIO_KIND = SCENARIO_KINDS[0];
export const UPDATE_SCENARIO_KIND = SCENARIO_KINDS[1];
