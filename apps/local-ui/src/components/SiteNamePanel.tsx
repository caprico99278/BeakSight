/**
 * DN-1（設計書 `doc/design/2026-11-16-beaksight-profile-display-name-design.md` 2 章）: サイトの画面の詳しい内容の、画面に出す名前の欄。
 * - 入れて「名前を変える」で保存する（管理データの表示の設定。見分けの印・点検の記録・書き込みの OK・ログインの設定は変わらない）。
 * - 保存できたら、画面（根の route の loader の名前の組）を読み直し、一覧・この画面の題・作業の履歴の名前をすぐ新しい名前にする。
 * - 空・長すぎ・改行のある名前は、保存の部品が拒み、その理由を欄の下に出す（入れた値はそのまま残す）。文言はカタログ。
 */
import { useRouter } from '@tanstack/react-router';
import { useServerFn } from '@tanstack/react-start';
import { useState, type FormEvent } from 'react';
import type { ProfileDisplayNameRejectionReason, ProfileDisplayNameSaveResult } from '../../../../src/control/store/profile-store.js';
import { LOCAL_UI_DISPLAY_NAME_TEXT } from '../../../../src/presentation/messages.js';
import { closedListReason, settleServerFunction, type ServerFunctionOutcome } from '../display/server-function-outcome';
import { useSiteNameOf } from '../display/site-name';
import { saveProfileDisplayNameFn } from '../server/display-settings-functions';
import { FieldFrame } from './FieldFrame';
import { Notice } from './Notice';

const text = LOCAL_UI_DISPLAY_NAME_TEXT;

type Accepted = Extract<ProfileDisplayNameSaveResult, { ok: true }>;
type SaveFailure = Exclude<ServerFunctionOutcome<Accepted, ProfileDisplayNameRejectionReason>, { readonly kind: 'ACCEPTED' }>;

/** 拒む理由の閉じた一覧の値か（一覧はカタログの鍵と同じ。網羅は `catalog-coverage.ts`）。 */
const isRejectionReason = closedListReason(text.reasons);

/** 保存できた結果は、保存した名前を持つ（持たない値は、例外と同じく `REQUEST_FAILED`）。 */
const hasDisplayName = (value: Readonly<Record<string, unknown>>): boolean => typeof value['displayName'] === 'string';

export function SiteNamePanel({ profileId, editable }: Readonly<{
  profileId: string;
  /** 保存できるか（有効なサイトだけ）。 */
  editable: boolean;
}>) {
  const siteNameOf = useSiteNameOf();
  const save = useServerFn(saveProfileDisplayNameFn);
  const router = useRouter();
  const [value, setValue] = useState(() => siteNameOf(profileId));
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [failure, setFailure] = useState<SaveFailure | null>(null);

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setBusy(true);
    setSaved(false);
    setFailure(null);
    void settleServerFunction<Accepted, ProfileDisplayNameRejectionReason>(save({ data: { profileId, displayName: value } }), isRejectionReason, hasDisplayName)
      .then((outcome) => {
        if (outcome.kind === 'ACCEPTED') {
          setValue(outcome.result.displayName);
          setSaved(true);
          void router.invalidate();
        } else {
          setFailure(outcome);
        }
      })
      .finally(() => setBusy(false));
  };

  return (
    <section className="panel" data-testid="profile-display-name">
      <h2 className="panel-heading">{text.heading}</h2>
      <form onSubmit={submit} noValidate>
        <FieldFrame label={text.label} hint={text.hint} errors={failure?.kind === 'REJECTED' ? [text.reasons[failure.reason]] : []}>
          {({ id, describedBy, invalid }) => (
            <input
              id={id}
              className="input"
              name="displayName"
              value={value}
              disabled={!editable || busy}
              autoComplete="off"
              aria-describedby={describedBy}
              aria-invalid={invalid}
              data-testid="profile-display-name-input"
              onChange={(event) => {
                setValue(event.target.value);
                setSaved(false);
              }}
            />
          )}
        </FieldFrame>
        <div className="button-row">
          <button type="submit" className="button" disabled={!editable || busy} data-testid="profile-display-name-save">{text.save}</button>
        </div>
      </form>
      {busy ? <p role="status">{text.saving}</p> : null}
      {saved ? <p data-testid="profile-display-name-saved" role="status">{text.saved}</p> : null}
      {failure === null ? null : (
        <Notice kind="caution">
          <div data-testid="profile-display-name-rejection" data-reason={failure.kind === 'REJECTED' ? failure.reason : failure.kind}>
            <p>{text.rejected}</p>
            {failure.kind === 'REJECTED' ? null : <p className="muted">{text.requestFailed}</p>}
          </div>
        </Notice>
      )}
    </section>
  );
}
