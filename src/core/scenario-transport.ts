// シナリオの送り方の値の契約（T40R-fix-B。Task 40 の設計書 7 章の「T40R」の行の M-2）。純粋な定義だけのファイル。
// - シナリオの契約（`src/control/approval/scenario-contracts.ts` の `SCENARIO_TRANSPORTS`・`FORM_SCENARIO_TRANSPORT`・`API_SCENARIO_TRANSPORT`）が、ここを
//   公開し直して使う。IPC の契約（`src/control/worker-protocol.ts`）は、シナリオの契約が IPC の契約を読む（ID の形）ので、循環しないようにここから読む
//   （CC-102 の `api-field-identity.ts` と同じ置き方）。送り方の値を書くのはここだけ。
// - `FORM`: form の送信（Task 28〜32 の今のシナリオ。送り方の項目のない前の文書も `FORM`）。
// - `API`: ページのスクリプトが承認した API の Origin へ送る要求（Task 37 の probe の `API_CREATE`・`API_UPDATE` の候補）。

/** シナリオの送り方（閉じた一覧）。 */
export const SCENARIO_TRANSPORTS = Object.freeze(['FORM', 'API'] as const);
export type ScenarioTransport = (typeof SCENARIO_TRANSPORTS)[number];

/** 送り方の値の名前つきの定数（`SCENARIO_TRANSPORTS` の要素）。 */
export const FORM_SCENARIO_TRANSPORT = SCENARIO_TRANSPORTS[0];
export const API_SCENARIO_TRANSPORT = SCENARIO_TRANSPORTS[1];
