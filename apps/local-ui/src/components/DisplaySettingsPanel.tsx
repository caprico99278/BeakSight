/**
 * FM-1（設計書 `doc/design/2026-10-19-beaksight-fewer-manual-steps-design.md` の 2.2 の画面）: プロファイルの画面の表示の設定（ジョブのブラウザを表示する。
 * 既定は表示）。保存しても、プロファイルの改訂と承認は変わらない（画面は移らない）。文言はカタログ。
 * AS-b（設計書 `doc/design/2026-10-19-beaksight-audit-send-policy-design.md` 2.1）: 同じ欄に、監査の段の送信の扱い（既定は読み取りだけ）を置く。通す側へ切り替える
 * ときは、確認のダイアログ（ページが出す書き込みの送信がサイトに届く。削除と危険な語の送信は止める）を出し、やめると切り替えない。読み取りだけへ戻すときは
 * ダイアログを出さない。保存は表示の設定と一緒（改訂の外）。
 * FM-3: 欄の専用の保存のボタンはなくし、チェックを切り替えたらその場で保存する（通す側へは、確認のダイアログで「通す」を選んだ時点）。保存の間はチェックを
 * 押せず、保存できたら欄の中に「保存しました」を出す。保存できなければ（拒まれた・Server Function が例外を投げた）、チェックを元の値に戻し、理由を出す。
 */
import { useServerFn } from '@tanstack/react-start';
import { useEffect, useId, useRef, useState } from 'react';
import { AUDIT_SEND_PASS_EXCEPT_DELETE, AUDIT_SEND_READ_ONLY } from '../../../../src/core/audit-send-policy.js';
import { LOCAL_UI_DISPLAY_SETTINGS_TEXT } from '../../../../src/presentation/messages.js';
import type {
  ProfileDisplaySettings,
  ProfileDisplaySettingsRejectionReason,
  ProfileDisplaySettingsSaveResult,
} from '../../../../src/control/store/profile-store.js';
import { closedListReason, settleServerFunction, type ServerFunctionOutcome } from '../display/server-function-outcome';
import { saveProfileDisplaySettingsFn } from '../server/display-settings-functions';
import { ConfirmDialog } from './ConfirmDialog';
import { Notice } from './Notice';

const text = LOCAL_UI_DISPLAY_SETTINGS_TEXT;

/** FM-3: 保存の応答の読み方（DEF-146 で共通の部品 `server-function-outcome.ts` にまとめた）。 */
type SaveOutcome = ServerFunctionOutcome<Extract<ProfileDisplaySettingsSaveResult, { ok: true }>, ProfileDisplaySettingsRejectionReason>;

/** FM-3: 保存できなかった理由（拒まれた理由か、Server Function が例外を投げた・結果の形でない値で終わったこと）。 */
type SaveFailure = Exclude<SaveOutcome, { readonly kind: 'ACCEPTED' }>;

/** 拒む理由の閉じた一覧の値か（一覧はカタログの鍵と同じ。網羅は `catalog-coverage.ts`）。 */
const isRejectionReason = closedListReason(text.reasons);

/** FM-3: 保存できた結果は、保存した設定を持つ（持たない値は、例外と同じく `REQUEST_FAILED`）。 */
const hasSettings = (value: Readonly<Record<string, unknown>>): boolean => 'settings' in value;

export function DisplaySettingsPanel({ profileId, settings, editable }: Readonly<{
  profileId: string;
  settings: ProfileDisplaySettings;
  /** 保存できるか（有効なプロファイルだけ）。 */
  editable: boolean;
}>) {
  const save = useServerFn(saveProfileDisplaySettingsFn);
  const [current, setCurrent] = useState<ProfileDisplaySettings>(settings);
  /** AS-b: 通す側へ切り替える確認のダイアログを開いているか。 */
  const [confirmingPass, setConfirmingPass] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [failure, setFailure] = useState<SaveFailure | null>(null);
  const showJobBrowserRef = useRef<HTMLInputElement>(null);
  const auditSendRef = useRef<HTMLInputElement>(null);
  /** 保存の後にフォーカスを戻すチェック（保存の間はチェックを押せなくするので、フォーカスが外れる）。 */
  const focusAfterSaveRef = useRef<HTMLInputElement | null>(null);
  const noteId = `${useId()}-note`;
  const hintId = `${noteId}-hint`;
  const auditSendHintId = `${noteId}-audit-send`;

  useEffect(() => {
    if (!busy && focusAfterSaveRef.current !== null) {
      focusAfterSaveRef.current.focus();
      focusAfterSaveRef.current = null;
    }
  }, [busy]);

  /** 切り替えた値を、その場で保存する（できなければ、切り替える前の値に戻す）。 */
  const persist = (next: ProfileDisplaySettings, toggled: HTMLInputElement | null): void => {
    const previous = current;
    setCurrent(next);
    setBusy(true);
    setSaved(false);
    setFailure(null);
    focusAfterSaveRef.current = toggled;
    // 入力の検証の誤りと通信の誤り（Server Function の呼び出しが例外を投げた）は、共通の読み方で `REQUEST_FAILED` になる。
    void settleServerFunction<Extract<ProfileDisplaySettingsSaveResult, { ok: true }>, ProfileDisplaySettingsRejectionReason>(
      save({ data: { profileId, showJobBrowser: next.showJobBrowser, auditSendPolicy: next.auditSendPolicy } }),
      isRejectionReason,
      hasSettings,
    )
      .then((outcome: SaveOutcome) => {
        if (outcome.kind === 'ACCEPTED') {
          setCurrent(outcome.result.settings);
          setSaved(true);
        } else {
          setCurrent(previous);
          setFailure(outcome);
        }
      })
      .finally(() => setBusy(false));
  };

  return (
    <section className="panel" data-testid="profile-display-settings">
      <h2 className="panel-heading">{text.heading}</h2>
      <p className="muted" id={noteId}>{text.autoSaveNote}</p>
      <p className="field">
        <label>
          <input
            ref={showJobBrowserRef}
            type="checkbox"
            checked={current.showJobBrowser}
            disabled={!editable || busy}
            aria-describedby={`${noteId} ${hintId}`}
            onChange={(event) => persist({ ...current, showJobBrowser: event.target.checked }, showJobBrowserRef.current)}
          />
          {' '}
          {text.showJobBrowser}
        </label>
        <span className="field-hint" id={hintId}>{text.hint}</span>
      </p>
      <p className="field">
        <label>
          <input
            ref={auditSendRef}
            type="checkbox"
            checked={current.auditSendPolicy === AUDIT_SEND_PASS_EXCEPT_DELETE}
            disabled={!editable || busy}
            aria-describedby={`${noteId} ${auditSendHintId}`}
            data-testid="profile-audit-send-policy"
            data-policy={current.auditSendPolicy}
            onChange={(event) => {
              if (event.target.checked) {
                // 通す側へは、確認のダイアログで「通す」を選んだときだけ切り替えて保存する。
                setSaved(false);
                setFailure(null);
                setConfirmingPass(true);
              } else {
                persist({ ...current, auditSendPolicy: AUDIT_SEND_READ_ONLY }, auditSendRef.current);
              }
            }}
          />
          {' '}
          {text.auditSendPassExceptDelete}
        </label>
        <span className="field-hint" id={auditSendHintId}>{text.auditSendHint}</span>
      </p>
      {!confirmingPass ? null : (
        <ConfirmDialog
          open
          title={text.auditSendDialogTitle}
          body={text.auditSendDialogBody}
          confirmLabel={text.auditSendConfirm}
          cancelLabel={text.auditSendCancel}
          busy={false}
          onConfirm={() => {
            setConfirmingPass(false);
            persist({ ...current, auditSendPolicy: AUDIT_SEND_PASS_EXCEPT_DELETE }, auditSendRef.current);
          }}
          onCancel={() => {
            setConfirmingPass(false);
            auditSendRef.current?.focus();
          }}
        />
      )}
      {busy ? <p data-testid="profile-display-settings-saving" role="status">{text.saving}</p> : null}
      {saved ? <p data-testid="profile-display-settings-saved" role="status">{text.saved}</p> : null}
      {failure === null ? null : (
        <Notice kind="caution">
          {failure.kind === 'REJECTED' ? (
            <div data-testid="profile-display-settings-rejection" data-reason={failure.reason}>
              <p>{text.rejected}</p>
              <p className="muted">{text.reasons[failure.reason]}</p>
            </div>
          ) : (
            <div data-testid="profile-display-settings-request-failed">
              <p>{text.rejected}</p>
              <p className="muted">{text.requestFailed}</p>
            </div>
          )}
        </Notice>
      )}
    </section>
  );
}
