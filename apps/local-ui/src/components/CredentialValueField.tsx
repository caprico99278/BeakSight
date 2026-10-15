/**
 * 資格情報の値（ユーザー名かパスワード）の入力の欄（Task 26 の設計書 4.2。T26e）。
 * - ユーザー名は `autocomplete="off"`、パスワードは `type="password"` と `autocomplete="new-password"`。どちらも `spellcheck="false"`
 *   （綴りの確かめで、値がブラウザの辞書の処理へ渡らないように）。それでも、人のブラウザがパスワードの保存を勧めることは止められない（画面と手順書で
 *   案内する）。
 * - 値は画面の状態の中だけに置き、送った後は呼び出し側がすぐに空にする。値を画面に表示しない（`type="password"`）・ログに出さない。
 */
import { FieldFrame } from './FieldFrame';

/** ユーザー名の欄の `autocomplete`。 */
const USERNAME_AUTOCOMPLETE = 'off';
/** パスワードの欄の `autocomplete`（ブラウザに、保存済みのパスワードを入れさせない）。 */
const PASSWORD_AUTOCOMPLETE = 'new-password';

export function CredentialValueField({
  kind,
  label,
  name,
  hint,
  value,
  errors,
  onChange,
}: Readonly<{
  kind: 'username' | 'password';
  label: string;
  name: string;
  hint?: string;
  value: string;
  errors: readonly string[];
  onChange: (value: string) => void;
}>) {
  return (
    <FieldFrame label={label} {...(hint === undefined ? {} : { hint })} errors={errors}>
      {({ id, describedBy, invalid }) => (
        <input
          id={id}
          className="input"
          name={name}
          type={kind === 'password' ? 'password' : 'text'}
          value={value}
          autoComplete={kind === 'password' ? PASSWORD_AUTOCOMPLETE : USERNAME_AUTOCOMPLETE}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          aria-describedby={describedBy}
          aria-invalid={invalid}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </FieldFrame>
  );
}
