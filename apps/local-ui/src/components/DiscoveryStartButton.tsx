/**
 * 「操作をさがす」のボタン（操作さがしの画面から移した。PL-U で、書き込みの手順が 0 件の一覧の「書き込みの手順を作る」と共用する。設計書
 * `doc/design/2026-10-26-beaksight-plain-ui-design.md` 14.1 の U4）。押すと操作さがしの作業を始め、始めたら作業の画面へ移る。拒まれたら、呼び出し側に
 * 理由を渡す（理由の出し方は呼び出し側の `StartReasonDetails`）。始められないときは、呼び出し側が置かない。`label` はボタンの語（呼び出し側のカタログ）。
 */
import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useServerFn } from '@tanstack/react-start';
import { LOCAL_UI_DISCOVERY_TEXT } from '../../../../src/presentation/messages.js';
import type { AuditJobStartView } from '../server/audit-job-functions';
import { startDiscoveryFn } from '../server/discovery-functions';

export function DiscoveryStartButton({ profileId, revision, primary, label, onRejected }: Readonly<{
  profileId: string;
  /** 画面が読んだサイトの改訂。 */
  revision: number;
  primary: boolean;
  label: string;
  onRejected: (rejection: Extract<AuditJobStartView, { ok: false }>) => void;
}>) {
  const start = useServerFn(startDiscoveryFn);
  const navigate = useNavigate();
  const [submitting, setSubmitting] = useState(false);
  return (
    <button
      type="button"
      className={primary ? 'button button--primary' : 'button'}
      disabled={submitting}
      data-testid="discovery-start"
      onClick={() => {
        setSubmitting(true);
        void start({ data: { profileId, expectedRevision: revision } })
          .then((started) => {
            if (started.ok) {
              return navigate({ to: '/jobs/$jobId', params: { jobId: started.jobId } });
            }
            onRejected(started);
            return undefined;
          })
          .finally(() => setSubmitting(false));
      }}
    >
      {submitting ? LOCAL_UI_DISCOVERY_TEXT.submitting : label}
    </button>
  );
}
