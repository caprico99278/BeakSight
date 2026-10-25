/**
 * AS-b（設計書 `doc/design/2026-10-19-beaksight-audit-send-policy-design.md` 2.3）: ジョブの画面の、監査の段の送信の扱いの知らせ。結果の記録の扱いが、表示カタログ
 * （`AUDIT_SEND_POLICY_CATALOG`）で目立つ形で出す扱い（`PASS_EXCEPT_DELETE`）のときだけ出す。文言は報告（HTML・CLI）と共用のカタログ（`AUDIT_SEND_TEXT`）で、
 * 通した数は `run.json` の値のまま（数え直さない）。通した数を持たない記録（発見・READ の確かめ）は、数のない文言にする。数だけで、URL・値を出さない。
 */
import { AUDIT_SEND_POLICY_CATALOG } from '../../../../src/presentation/catalog.js';
import { formatCount } from '../../../../src/presentation/format.js';
import { AUDIT_SEND_TEXT } from '../../../../src/presentation/messages.js';
import type { AuditJobAuditSendView } from '../server/audit-job-functions';
import { Notice } from './Notice';

export function AuditSendNotice({ auditSend }: Readonly<{ auditSend: AuditJobAuditSendView | null }>) {
  if (auditSend === null || !AUDIT_SEND_POLICY_CATALOG[auditSend.policy].prominent) {
    return null;
  }
  const spec = AUDIT_SEND_POLICY_CATALOG[auditSend.policy];
  return (
    <Notice kind="caution" heading={AUDIT_SEND_TEXT.label}>
      <p data-testid="job-audit-send-notice" data-policy={auditSend.policy}>
        {auditSend.passedRequests === null ? AUDIT_SEND_TEXT.jobNotice : AUDIT_SEND_TEXT.passedNotice(formatCount(auditSend.passedRequests))}
      </p>
      {/* AS-c: 内訳（ほかの Origin への送信と、WebSocket の接続。監査の記録だけ）。 */}
      {auditSend.passedOtherOriginRequests === null || auditSend.passedWebSockets === null ? null : (
        <p data-testid="job-audit-send-detail">
          {AUDIT_SEND_TEXT.passedDetail(formatCount(auditSend.passedOtherOriginRequests), formatCount(auditSend.passedWebSockets))}
        </p>
      )}
      {/* AS-c fix round 1: Guard の判定を通らずに開いた接続と、危険な語の接続（出すかはサーバの `webSocketCaution`）。 */}
      {!auditSend.webSocketCaution || auditSend.passedWebSocketsOutsideGuard === null || auditSend.passedDangerousWebSockets === null ? null : (
        <p data-testid="job-audit-send-websocket-caution">
          {AUDIT_SEND_TEXT.webSocketCaution(formatCount(auditSend.passedWebSocketsOutsideGuard), formatCount(auditSend.passedDangerousWebSockets))}
        </p>
      )}
      {spec.description === null ? null : <p className="muted">{spec.description}</p>}
    </Notice>
  );
}
