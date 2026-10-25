/**
 * FM-1（設計書 `doc/design/2026-10-19-beaksight-fewer-manual-steps-design.md` の 2.1）: ジョブの詳細のログインの段の表の 1 行の「登録する」。押すと、
 * サーバが組み立てた案（足すもの、足す承認したサービスの Origin、保存した後のプロファイルの改訂）を確認のダイアログに出し、確認したら、その場で保存する
 * （画面は移らない）。足せない行は、ダイアログを出さずに理由を出す。保存したら、ジョブの値を読み直す（自動で登録した設定の欄を新しくする）。文言はカタログ。
 */
import { useQueryClient } from '@tanstack/react-query';
import { useServerFn } from '@tanstack/react-start';
import { useRef, useState } from 'react';
import { formatCount } from '../../../../src/presentation/format.js';
import { LOCAL_UI_LOGIN_STAGE_REGISTER_TEXT, LOCAL_UI_MANUAL_LOGIN_TEXT, LOCAL_UI_TEXT, listText } from '../../../../src/presentation/messages.js';
import {
  loginStageRowProposalFn,
  registerLoginStageRowFn,
  type LoginStageRowProposalView,
  type LoginStageRowRejectionReason,
} from '../server/login-stage-registration-functions';
import { ConfirmDialog } from './ConfirmDialog';
import { Notice } from './Notice';

const text = LOCAL_UI_LOGIN_STAGE_REGISTER_TEXT;

/** 表の 1 行の指定（どの表の何行目か）。 */
export interface LoginStageRowTarget {
  readonly jobId: string;
  readonly passed: boolean;
  readonly index: number;
}

type Proposal = Extract<LoginStageRowProposalView, { ok: true }>;

/** 足すもの（token の送信先か、ログインに伴う送信と回数。値を持たない）。 */
function AddedItem({ added }: Readonly<{ added: Proposal['added'] }>) {
  if (added.kind === 'TOKEN_TARGET') {
    return (
      <p data-testid="login-stage-register-added" data-kind={added.kind}>
        {text.tokenTarget}: <code>{`${added.origin}${added.path}`}</code>
        {added.queryNames.length === 0 ? null : <span className="muted">{text.tokenQueryNames(listText(added.queryNames))}</span>}
      </p>
    );
  }
  return (
    <p data-testid="login-stage-register-added" data-kind={added.kind}>
      {text.sideRequest}: {LOCAL_UI_MANUAL_LOGIN_TEXT.sideRequestValue(added.method, `${added.origin}${added.path}`, formatCount(added.maxPerLoginStage))}
    </p>
  );
}

export function LoginStageRegisterButton({ target, registration }: Readonly<{ target: LoginStageRowTarget; registration: string }>) {
  const propose = useServerFn(loginStageRowProposalFn);
  const register = useServerFn(registerLoginStageRowFn);
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [rejection, setRejection] = useState<{ readonly reason: LoginStageRowRejectionReason; readonly codes: readonly string[] } | null>(null);
  const [savedRevision, setSavedRevision] = useState<number | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const close = (): void => {
    setProposal(null);
    buttonRef.current?.focus();
  };
  const open = (): void => {
    setBusy(true);
    setRejection(null);
    setSavedRevision(null);
    void propose({ data: target })
      .then((result) => {
        if (result.ok) {
          setProposal(result);
        } else {
          setRejection({ reason: result.reason, codes: [] });
        }
      })
      .finally(() => setBusy(false));
  };
  const save = (): void => {
    if (proposal === null) {
      return;
    }
    setBusy(true);
    void register({ data: { ...target, expectedProfileRevision: proposal.profileRevision } })
      .then((result) => {
        close();
        if (result.ok) {
          setSavedRevision(result.profileRevision);
          void queryClient.invalidateQueries({ queryKey: ['audit-job', target.jobId] });
        } else {
          setRejection({ reason: result.reason, codes: result.codes });
        }
      })
      .finally(() => setBusy(false));
  };

  return (
    <>
      <button ref={buttonRef} type="button" className="button" data-testid="job-login-stage-register" data-registration={registration} disabled={busy} onClick={open}>
        {busy && proposal === null ? text.preparing : text.confirm}
      </button>
      {/* ダイアログは、案を出す間だけ置く（表のセルの文字に、閉じたダイアログの文を入れない）。閉じたら、ボタンにフォーカスを戻す。 */}
      {proposal === null ? null : (
        <ConfirmDialog
          open
          title={text.dialogTitle}
          body={text.dialogBody}
          confirmLabel={busy ? text.saving : text.confirm}
          cancelLabel={text.cancel}
          busy={busy}
          onConfirm={save}
          onCancel={close}
        >
          <AddedItem added={proposal.added} />
          {proposal.addServiceOrigins.length === 0 ? null : (
            <p>
              {text.addServiceOrigins}: <span data-testid="login-stage-register-origins">{listText(proposal.addServiceOrigins)}</span>
            </p>
          )}
          <p>
            {text.nextRevision}: <span data-testid="login-stage-register-revision">{LOCAL_UI_TEXT.profileForm.revisionText(proposal.profileRevision + 1)}</span>
          </p>
        </ConfirmDialog>
      )}
      {savedRevision === null ? null : (
        <p data-testid="job-login-stage-registered" role="status">{text.saved(LOCAL_UI_TEXT.profileForm.revisionText(savedRevision))}</p>
      )}
      {rejection === null ? null : (
        <Notice kind="caution">
          <div data-testid="job-login-stage-register-rejection" data-reason={rejection.reason}>
            <p>{text.rejected}</p>
            <p className="muted">{text.reasons[rejection.reason]}</p>
            {rejection.codes.length === 0 ? null : <p className="muted">{text.codes(listText(rejection.codes))}</p>}
          </div>
        </Notice>
      )}
    </>
  );
}
