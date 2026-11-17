import { useState } from 'react';
import { useRouter } from '@tanstack/react-router';
import { useServerFn } from '@tanstack/react-start';
import { formatInteger } from '../../../../src/presentation/format.js';
import { LOCAL_UI_WRITE_SCREENS_TEXT } from '../../../../src/presentation/messages.js';
import { writeScreenRowResultLinesOf, type WriteScreenResultLine } from '../display/write-screen-values';
import { Notice } from './Notice';
import {
  saveWriteScreenCheckFn,
  type WriteScreenCheckRejection,
  type WriteScreenRowView,
  type WriteScreensView,
} from '../server/write-screen-functions';

const text = LOCAL_UI_WRITE_SCREENS_TEXT;

/** 行の結果の 1 行の種類の、テストの目印。 */
const RESULT_LINE_TEST_IDS: Readonly<Record<WriteScreenResultLine['kind'], string>> = Object.freeze({
  LAST_NOT_TRIED: 'write-screen-last-not-tried',
  LAST_RESULT: 'write-screen-last-result',
  UPDATE_STATE: 'write-screen-update-state',
});

/** 行 1 つ（チェックの欄と画面の名前。変えたら、その場で保存する）。 */
function WriteScreenRow({ profileId, row, unnamedPosition, onSaved }: Readonly<{
  profileId: string;
  row: WriteScreenRowView;
  /** OP-G（指示書の 7）: 見出しの取れない行の、名前のない行の中の順（1 から。名前のある行は null）。 */
  unnamedPosition: number | null;
  onSaved: () => void;
}>) {
  const save = useServerFn(saveWriteScreenCheckFn);
  const [busy, setBusy] = useState(false);
  const [rejection, setRejection] = useState<WriteScreenCheckRejection | 'REQUEST_FAILED' | null>(null);
  const checkable = row.state !== 'NOT_CHECKABLE';
  const checked = row.state === 'CHECKED';
  // OP-G（指示書の 7）: 見出しが取れないときは、英字の path の語を出さず、やさしい形（「登録の画面（1）」）にする。
  const name = row.screenName ?? text.unnamedScreen(formatInteger(unnamedPosition ?? 1));
  // 前の点検の結果と更新の 1 行（OP-F: 送らずに締めた回は「前回は試せませんでした」と理由の 1 行。OP-H: 結果 → 更新の 1 行の順）。文と並びは表示の値の 1 か所。
  const resultLines = writeScreenRowResultLinesOf(row);
  return (
    <li data-testid="write-screen-row" data-row-key={row.rowKey} data-state={row.state}>
      <label className="choice">
        <input
          type="checkbox"
          data-testid="write-screen-check"
          checked={checked}
          disabled={!checkable || busy}
          onChange={(event) => {
            const next = event.target.checked;
            setBusy(true);
            void save({ data: { profileId, rowKey: row.rowKey, checked: next, mayNotifyShown: checkable && row.mayNotify } })
              .then((result) => {
                setRejection(result.ok ? null : result.reason);
                onSaved();
              })
              .catch(() => setRejection('REQUEST_FAILED'))
              .finally(() => setBusy(false));
          }}
        />
        <span>{name}</span>
      </label>
      {busy ? <p className="field-hint">{text.saving}</p> : null}
      {row.state === 'CHECKED' || row.state === 'CHECKABLE' ? null : (
        <p className="field-hint" data-testid="write-screen-state">{text.states[row.state]}</p>
      )}
      {/* OP-L（L3）: 理由のコード（閉じた一覧の値。値を含まない）は、画面の文に出さず、行の属性にだけ残す（次の点検で、原因が分かるように）。 */}
      {row.notCheckableKind === null ? null : (
        <p className="field-hint" data-testid="write-screen-not-checkable-reason" data-kind={row.notCheckableKind} data-reason={row.notCheckableReason ?? undefined}>
          {text.notCheckable[row.notCheckableKind]}
        </p>
      )}
      {checkable && row.mayNotify ? <p className="field-hint" data-testid="write-screen-may-notify">{text.mayNotify}</p> : null}
      {resultLines.map((line) => (
        <p key={line.kind} className="field-hint" data-testid={RESULT_LINE_TEST_IDS[line.kind]} data-state={line.kind === 'UPDATE_STATE' ? line.updateState : undefined}>
          {line.text}
        </p>
      ))}
      {rejection === null ? null : (
        <Notice kind="critical">
          <p data-testid="write-screen-rejection" data-reason={rejection}>
            {rejection === 'REQUEST_FAILED' ? text.requestFailed : text.rejections[rejection]}
          </p>
        </Notice>
      )}
    </li>
  );
}

/**
 * OP-2（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1.1 の D7'）: サイトの画面の「登録・更新を試せる画面」の一覧。上に 1 行で何が起きるかを出し、行ごとに
 * チェックの欄を置く（ボタンは置かない。チェックを変えたら、その場で保存する。確認のダイアログはない）。値はサーバの 1 か所（`writeScreensFn`）が決め、ここは描くだけ。
 */
export function WriteScreenList({ view }: Readonly<{ view: WriteScreensView }>) {
  const router = useRouter();
  return (
    <section className="panel" data-testid="write-screens">
      <h2 className="panel-heading">{text.heading}</h2>
      <p data-testid="write-screens-intro">{text.intro}</p>
      {view.rows.length === 0 ? <p data-testid="write-screens-none">{text.none}</p> : (
        <ul className="plain-list">
          {view.rows.map((row, index) => (
            <WriteScreenRow
              key={row.rowKey}
              profileId={view.profileId}
              row={row}
              unnamedPosition={row.screenName === null ? view.rows.slice(0, index + 1).filter(({ screenName }) => screenName === null).length : null}
              onSaved={() => { void router.invalidate(); }}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
