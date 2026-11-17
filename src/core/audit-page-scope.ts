/**
 * WSO（ユーザーの依頼 2026-11-16「更新を行う画面だけ監査を行うか、全量実施するか選択できるようにして」）: 点検の範囲の唯一の定義（閉じた一覧）。
 * - 範囲を持たない点検は、今までどおりサイトの全部の画面を巡回する（値は持たない。`null` で表す）。
 * - `CHECKED_WRITE_SCREENS`: 「登録・更新を試せる画面」の一覧でチェックした画面（と、その画面に関係する一覧の画面）だけを読み、ほかの画面へ広げない。
 *   読む画面の中は、今の網羅の決まりで端から端まで読む（数で打ち切らない）。
 * 画面の入力（`ui-audit-job-start`）、ジョブの管理、IPC、Run の記録（`run.json`・保存）、報告が、この 1 か所の値を使う。純粋な値だけ（ブラウザ・管理データに触れない）。
 */

/** 点検の範囲（閉じた一覧）。 */
export const AUDIT_PAGE_SCOPE_KINDS = Object.freeze(['CHECKED_WRITE_SCREENS'] as const);
export type AuditPageScopeKind = (typeof AUDIT_PAGE_SCOPE_KINDS)[number];

/** チェックした画面だけの点検。 */
export const CHECKED_WRITE_SCREENS_SCOPE: AuditPageScopeKind = 'CHECKED_WRITE_SCREENS';

/** 値が点検の範囲か。 */
export const isAuditPageScopeKind = (value: unknown): value is AuditPageScopeKind =>
  typeof value === 'string' && (AUDIT_PAGE_SCOPE_KINDS as readonly string[]).includes(value);

/**
 * Run の記録の範囲（`run.json` と保存の任意の項目。範囲を持たない Run は項目を持たない）。読む画面の数だけを持つ（URL は持たない）。
 */
export interface RunPageScopeRecord {
  readonly kind: AuditPageScopeKind;
  /** 渡された画面のうち、読める画面の数（REV-WSO の M-1。許可 Origin の中で、除外に当たらないもの。0 なら画面を読まずに Run の失敗）。 */
  readonly pageCount: number;
}
