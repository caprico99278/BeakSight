/**
 * たたんだ「詳しい内容」（MI-1。設計書 `doc/design/2026-10-26-beaksight-minimal-input-ux-design.md` 4.2。PL-3: 見出しの語を、設計書
 * `2026-10-26-beaksight-plain-ui-design.md` 3 章の 1 の「詳しい内容」にした。前は「詳しい設定」）。共通の部品（共通部品台帳に載せる）。
 * - BeakSight が観察や案で決める値の欄を、既定で閉じた区画（`<details>` と `<summary>`）にたたむ。中は `children`。開いて直した値だけを使うかは、
 *   使う側が決める（この部品は表示だけ）。
 * - プロファイルの作成と編集（MI-1）のほか、認証の設定の画面（MI-3）、自動ログインの切り替え（MI-4）、シナリオの画面（MI-6）でも使う。
 * - `openRequested` が真になったら開く（中の欄に保存の誤りが出たときに、閉じたまま誤りを隠さないため）。利用者が閉じるのは止めない。
 * - 見出しの文言はカタログ（`LOCAL_UI_TEXT.advancedSettings`）。
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { LOCAL_UI_TEXT } from '../../../../src/presentation/messages.js';

export function AdvancedSettings({
  children,
  openRequested = false,
  testId,
}: Readonly<{
  children: ReactNode;
  /** 真になったら開く（既定は閉じる）。 */
  openRequested?: boolean;
  /** 画面のテストの目印（`data-testid`）。 */
  testId?: string;
}>) {
  const details = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (openRequested && details.current !== null) {
      details.current.open = true;
    }
  }, [openRequested]);
  return (
    <details ref={details} className="field-group" data-testid={testId}>
      <summary className="field-group-heading">{LOCAL_UI_TEXT.advancedSettings.summary}</summary>
      {children}
    </details>
  );
}
