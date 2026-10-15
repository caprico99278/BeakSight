import type { ReactNode } from 'react';
import { LOCAL_UI_TEXT } from '../../../../src/presentation/messages.js';

/** 上の帯（今の画面の名前と、待ち受けの小さな表示）と本文。 */
export function PageFrame({ title, children }: Readonly<{ title: string; children: ReactNode }>) {
  return (
    <>
      <header className="top-bar">
        <h1 className="page-title">{title}</h1>
        <span className="badge badge--positive">{LOCAL_UI_TEXT.listeningBadge}</span>
      </header>
      <main id="main-content" className="content" tabIndex={-1}>
        {children}
      </main>
    </>
  );
}
