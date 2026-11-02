import { useEffect, useId, useRef, type ReactNode } from 'react';

/**
 * 確定のボタンの見た目（PL-V。設計書 `2026-10-26-beaksight-plain-ui-design.md` 13 章の 7）。
 * - `danger`: 取り返せない確定と、守りを緩める確定（書き込みの OK、書き込みを始める、削除、取り消し、削除のほかを通す など）。赤い縁。
 * - `primary`: 危険でない確定（自動ログインへの切り替え、書き込みも試す、設定の保存 など）。主のボタンの見た目。
 */
export type ConfirmTone = 'danger' | 'primary';

/** 確定のボタンの見た目ごとの class（`app.css` のボタンの規則）。 */
const CONFIRM_BUTTON_CLASSES: Readonly<Record<ConfirmTone, string>> = Object.freeze({
  danger: 'button button--danger',
  primary: 'button button--primary',
});

/** 確認のダイアログの指定。 */
export interface ConfirmDialogProps {
  readonly open: boolean;
  readonly title: string;
  readonly body: string;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
  /** 確定のボタンの見た目（使う側が、どちらかを必ず選ぶ）。 */
  readonly confirmTone: ConfirmTone;
  readonly busy: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  /** 本文の下に出す、確かめる内容（T28e。シナリオの承認の、差分・副作用の確認・期限・上限）。 */
  readonly children?: ReactNode;
  /** PL-5: 確定を押せない（ダイアログの中の選択がまだ足りない。既定は押せる）。 */
  readonly confirmDisabled?: boolean;
}

/**
 * フォーカスを回す要素（PL-5: 書き込みも試すダイアログの、隔離の扱いの 2 択と参照の欄のように、ボタンのほかに入力を持つダイアログでも、キーボードで届く）。
 */
const FOCUSABLE_SELECTOR = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])';

/**
 * 確認のダイアログ（HTML の `dialog` の modal）。ダイアログの外は操作できず（ブラウザの modal の扱い）、Tab のフォーカスはダイアログの中で
 * 回し（最後の次は最初）、Escape で閉じる。
 * 開いたときは「やめる」にフォーカスを置き（取り消しを誤って押さないため）、閉じたときは開く前のフォーカスに戻す。
 */
export function ConfirmDialog({
  open, title, body, confirmLabel, cancelLabel, confirmTone, busy, onConfirm, onCancel, children, confirmDisabled = false,
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  // 1 つの画面に 2 つ以上のダイアログがあっても、見出しと本文の id が重ならないようにする（T28e。承認と撤回のダイアログ）。
  const titleId = `${useId()}-title`;
  const bodyId = `${titleId}-body`;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) {
      return;
    }
    if (open && !dialog.open) {
      returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
      cancelRef.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
      returnFocusRef.current?.focus();
    }
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      className="dialog"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      onKeyDown={(event) => {
        // フォーカスをダイアログの中で回す（最後の次は最初、最初の前は最後。ブラウザの外へ出さない）。
        if (event.key !== 'Tab') {
          return;
        }
        const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [])];
        const first = focusable[0];
        const last = focusable.at(-1);
        if (first === undefined || last === undefined) {
          return;
        }
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <h2 id={titleId} className="dialog-title">{title}</h2>
      <p id={bodyId}>{body}</p>
      {children}
      <div className="button-row">
        <button ref={cancelRef} type="button" className="button" onClick={onCancel} disabled={busy}>
          {cancelLabel}
        </button>
        <button type="button" className={CONFIRM_BUTTON_CLASSES[confirmTone]} data-confirm-tone={confirmTone} onClick={onConfirm}
          disabled={busy || confirmDisabled}>
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
