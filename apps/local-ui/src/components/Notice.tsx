import type { ReactNode } from 'react';

/** お知らせの種類（左の帯の色）。 */
export type NoticeKind = 'caution' | 'critical' | 'positive';

/** お知らせ（見出しと本文）。誤りと結果は、読み上げで伝わるように role を付ける。 */
export function Notice({ kind, heading, children }: Readonly<{ kind: NoticeKind; heading?: string; children: ReactNode }>) {
  return (
    <div className={`notice notice--${kind}`} role={kind === 'critical' ? 'alert' : 'status'}>
      {heading === undefined ? null : <p className="notice-heading">{heading}</p>}
      {children}
    </div>
  );
}
