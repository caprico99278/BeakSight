// 監査の段の送信の扱いの値の一覧の唯一の owner（AS-b。設計書 `doc/design/2026-10-19-beaksight-audit-send-policy-design.md` 2.1、5 章の AS-b の Blocker の行）。
// - `READ_ONLY`（既定）: 今のまま、Passive Context では GET と HEAD のほかを送らない。
// - `PASS_EXCEPT_DELETE`: 監査・発見・READ の確かめの Passive Context で、ページが自分で出す副資源の要求のうち、削除と危険な語の path のほかを通す
//   （判定は `src/safety/request-policy.ts` の `auditSendDecisionOf`。口は Guard の `auditSend`）。
// - 項目を持たない設定（AS-b の前の保存・`run.json`、項目を書かない設定の値）は `READ_ONLY` と読む（その Run は読み取りだけで動いたため）。読み替えは
//   `auditSendPolicyOf` の 1 か所。
// 純粋な定義だけのファイル（`src/core/` の外を import しない）。

/** 読み取りだけ（既定）。 */
export const AUDIT_SEND_READ_ONLY = 'READ_ONLY';
/** 削除と危険な語のほかを通す。 */
export const AUDIT_SEND_PASS_EXCEPT_DELETE = 'PASS_EXCEPT_DELETE';

/** 監査の段の送信の扱いの閉じた一覧（この順に表示する）。 */
export const AUDIT_SEND_POLICIES = Object.freeze([AUDIT_SEND_READ_ONLY, AUDIT_SEND_PASS_EXCEPT_DELETE] as const);
export type AuditSendPolicyName = (typeof AUDIT_SEND_POLICIES)[number];

/** 既定の扱い（読み取りだけ）。 */
export const DEFAULT_AUDIT_SEND_POLICY: AuditSendPolicyName = AUDIT_SEND_READ_ONLY;

/** 一覧の値か。 */
export const isAuditSendPolicyName = (value: unknown): value is AuditSendPolicyName =>
  typeof value === 'string' && (AUDIT_SEND_POLICIES as readonly string[]).includes(value);

/** 実効の設定（か、その写し）の扱い。項目がなければ既定（`READ_ONLY`）と読む。 */
export const auditSendPolicyOf = (config: { readonly audit: { readonly sendPolicy?: AuditSendPolicyName | undefined } }): AuditSendPolicyName =>
  config.audit.sendPolicy ?? DEFAULT_AUDIT_SEND_POLICY;

/**
 * AS-c fix round 1（C-1・C-2）: 通した WebSocket の接続の知らせ（Guard の route を通らずに開いた接続か、危険な語の接続が 1 本でもあった）を出すか。報告（HTML・
 * CLI）とジョブの画面が、この 1 か所で決める。数を持たない記録（前の Run）は 0 と読む。
 */
export const hasAuditSendWebSocketCaution = (counts: {
  readonly passedWebSocketsOutsideGuard?: number | undefined;
  readonly passedDangerousWebSockets?: number | undefined;
}): boolean => (counts.passedWebSocketsOutsideGuard ?? 0) > 0 || (counts.passedDangerousWebSockets ?? 0) > 0;
