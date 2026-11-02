import type { ReactNode } from 'react';
import { LOCAL_UI_FRAME_TEXT } from '../../../../src/presentation/messages.js';

/** お知らせの種類（左の帯の色と面の色。見出しがないときの種類の語は `LOCAL_UI_FRAME_TEXT.noticeKinds`）。 */
export type NoticeKind = 'caution' | 'critical' | 'positive';

/**
 * お知らせ（見出しと本文）。誤りと結果は、読み上げで伝わるように role を付ける。
 * PL-V（設計書 `2026-10-26-beaksight-plain-ui-design.md` 13 章の 6）: 色の帯と面の色だけで種類を伝えないよう、見出しがないときは種類の語
 * （「注意」など。カタログ）を見出しの位置に出す。
 */
export function Notice({ kind, heading, children }: Readonly<{ kind: NoticeKind; heading?: string; children: ReactNode }>) {
  return (
    <div className={`notice notice--${kind}`} role={kind === 'critical' ? 'alert' : 'status'}>
      <p className="notice-heading">{heading ?? LOCAL_UI_FRAME_TEXT.noticeKinds[kind]}</p>
      {children}
    </div>
  );
}
