/**
 * ジョブの詳細の「ログインの段」の欄の、ログインの後のブラウザの状態の名前の記録（DEF-139。設計書 `2026-10-20-beaksight-login-state-carryover-design.md` 2.1）。
 * Cookie（ドメイン、パス、送る先、名前の形）、ローカル ストレージの鍵と IndexedDB のデータベース（Origin、名前の形）の、それぞれを監査に引き継いだか外したかを
 * 出す。ジョブの記録の写しをそのまま出す（名前は先頭と末尾の一般の語の形だけで、値・中身・名前の全体は記録にない。リンクにしない）。文言はカタログ
 * （`LOCAL_UI_LOGIN_STATE_NAMES_TEXT`。名前の形の書き方はセッションの切れの記録と同じ `shapeText`）。
 */
import type { LoginStateNameShape, LoginStateNameList, LoginStateStorageNameRow } from '../../../../src/control/auth/authenticated-state.js';
import type { WorkerLoginStateNames } from '../../../../src/control/worker-protocol.js';
import { formatCount } from '../../../../src/presentation/format.js';
import { LOCAL_UI_AUTH_TEXT, LOCAL_UI_LOGIN_STATE_NAMES_TEXT } from '../../../../src/presentation/messages.js';

const text = LOCAL_UI_LOGIN_STATE_NAMES_TEXT;

/** 名前の形（形がなければ、その旨）。 */
function ShapeText({ shape }: Readonly<{ shape: LoginStateNameShape | null }>) {
  return shape === null
    ? <span className="muted">{text.noShape}</span>
    : <code>{LOCAL_UI_AUTH_TEXT.job.sessionLoss.shapeText(shape.prefix, shape.suffix)}</code>;
}

/** 表の上限を超えた名前の数（なければ何も出さない）。 */
function Unlisted({ count, testId }: Readonly<{ count: number; testId: string }>) {
  return count === 0 ? null : <p data-testid={testId}>{text.unlisted(formatCount(count))}</p>;
}

/** ローカル ストレージの鍵か IndexedDB のデータベースの表。 */
function StorageNames({ list, caption, testId }: Readonly<{ list: LoginStateNameList<LoginStateStorageNameRow>; caption: string; testId: string }>) {
  return (
    <>
      {list.rows.length === 0 ? <p className="muted" data-testid={`${testId}-none`}>{caption}: {text.none}</p> : (
        <div className="table-wrap">
          <table data-testid={testId}>
            <caption>{caption}</caption>
            <thead>
              <tr>
                <th scope="col">{text.columns.origin}</th>
                <th scope="col">{text.columns.shape}</th>
                <th scope="col">{text.columns.outcome}</th>
                <th scope="col">{text.columns.count}</th>
              </tr>
            </thead>
            <tbody>
              {list.rows.map((row) => (
                <tr key={JSON.stringify([row.origin, row.shape, row.outcome])} data-outcome={row.outcome}>
                  <td className="cell-break"><code>{row.origin}</code></td>
                  <td className="cell-break"><ShapeText shape={row.shape} /></td>
                  <td>{text.outcomeLabels[row.outcome]}</td>
                  <td>{formatCount(row.count)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Unlisted count={list.unlisted} testId={`${testId}-unlisted`} />
    </>
  );
}

/** 状態の名前の記録（記録がなければ何も出さない）。 */
export function LoginStageStateNames({ names }: Readonly<{ names: WorkerLoginStateNames | undefined }>) {
  if (names === undefined) {
    return null;
  }
  const { cookies } = names;
  return (
    <div data-testid="job-login-state-names">
      <h3>{text.heading}</h3>
      <p className="muted">{text.note}</p>
      {cookies.rows.length === 0 ? <p className="muted" data-testid="job-login-state-cookies-none">{text.cookiesCaption}: {text.none}</p> : (
        <div className="table-wrap">
          <table data-testid="job-login-state-cookies">
            <caption>{text.cookiesCaption}</caption>
            <thead>
              <tr>
                <th scope="col">{text.columns.domain}</th>
                <th scope="col">{text.columns.path}</th>
                <th scope="col">{text.columns.hostOnly}</th>
                <th scope="col">{text.columns.shape}</th>
                <th scope="col">{text.columns.outcome}</th>
                <th scope="col">{text.columns.count}</th>
              </tr>
            </thead>
            <tbody>
              {cookies.rows.map((row) => (
                <tr key={JSON.stringify([row.domain, row.path, row.hostOnly, row.shape, row.outcome])} data-outcome={row.outcome}>
                  <td className="cell-break"><code>{row.domain}</code></td>
                  <td className="cell-break"><code>{row.path}</code></td>
                  <td>{row.hostOnly ? text.hostOnlyLabels.hostOnly : text.hostOnlyLabels.domain}</td>
                  <td className="cell-break"><ShapeText shape={row.shape} /></td>
                  <td>{text.outcomeLabels[row.outcome]}</td>
                  <td>{formatCount(row.count)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Unlisted count={cookies.unlisted} testId="job-login-state-cookies-unlisted" />
      <StorageNames list={names.localStorage} caption={text.localStorageCaption} testId="job-login-state-local-storage" />
      <StorageNames list={names.indexedDB} caption={text.indexedDBCaption} testId="job-login-state-indexed-db" />
    </div>
  );
}
