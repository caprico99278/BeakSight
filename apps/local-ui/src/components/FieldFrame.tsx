/**
 * フォームの 1 つの項目の枠（ラベル、説明、誤り）。入力の要素は `children` に渡す関数が受ける id と aria の値で結ぶ（T23f で
 * `ProfileForm.tsx` の中に作り、T25e で認証の設定のフォームと共用するために切り出した）。
 */
import { useId, type ReactNode } from 'react';

export function FieldFrame({
  label,
  hint,
  errors,
  children,
}: Readonly<{
  label: string;
  hint?: string;
  errors: readonly string[];
  children: (props: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode;
}>) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint === undefined ? null : hintId, errors.length > 0 ? errorId : null].filter((value) => value !== null).join(' ');
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>{label}</label>
      {hint === undefined ? null : <span id={hintId} className="field-hint">{hint}</span>}
      {children({ id, describedBy: describedBy === '' ? undefined : describedBy, invalid: errors.length > 0 })}
      {errors.length > 0 ? (
        <span id={errorId} className="field-error">{errors.join(' ')}</span>
      ) : null}
    </div>
  );
}
