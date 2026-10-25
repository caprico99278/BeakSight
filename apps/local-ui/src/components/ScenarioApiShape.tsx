import type { ScenarioApiFieldIdentity, ScenarioApiSpec, ScenarioTransport } from '../../../../src/control/approval-view.js';
import { LOCAL_UI_SCENARIO_TEXT, listText } from '../../../../src/presentation/messages.js';
import { scenarioTransportDisplay } from '../display/labels';
import { Notice } from './Notice';

const text = LOCAL_UI_SCENARIO_TEXT.api;

/** 一覧の表示（空なら「なし」）。 */
const listOrNone = (values: readonly string[]): string => (values.length === 0 ? text.none : listText(values));

/** 欄の識別の表示（名前か CSS）。 */
const fieldTextOf = (field: ScenarioApiFieldIdentity): string => (field.kind === 'NAME' ? text.fieldName(field.name) : text.fieldSelector(field.selector));

/**
 * T38c（Task 38 の設計書 3.3）: API のシナリオの要求の型の要約（承認の画面と詳細）。method、Origin、path の型、query の名前、媒体の型、`Prefer`、本文の
 * 鍵と欄、ページが決める鍵、ページが付けるヘッダの名前、更新の filter の名前。値は持たない（型と名前だけ）。filter の名前は目立たせ、列の名前を
 * 確かめていないこと（Task 37 の限界）を注意として出す。T38f: 送り方と、登録の ID の取り方も出す。詳細の画面と、承認の確認のダイアログが共用する。
 * T40R-fix-B（CC-103）: 送り方は、表示のカタログのラベル（`scenarioTransportDisplay`）で出す（生の値と、送り方の値の定数を画面に書かない。値は呼び出し側が
 * サーバの値から渡す）。
 * T41e（Task 41 の設計書 3.5）: 更新のシナリオは、保つ鍵と欄（`keptKeys`）と、ページが決める鍵の照らす欄の識別も出す。
 * DEF-147（設計書 `2026-10-21-beaksight-api-state-keys-design.md` 2 章）: 公開の状態にあたる鍵には、注意の印と、その説明を出す。
 */
export function ScenarioApiShape({ api, transport, testId, publicationStateKeys = [] }: Readonly<{
  api: ScenarioApiSpec;
  transport: ScenarioTransport;
  testId: string;
  /** DEF-147: 公開の状態にあたる鍵（注意の印を付ける。サーバが契約の 1 か所 `scenarioApiPublicationStateKeysOf` で求めた値）。 */
  publicationStateKeys?: readonly string[];
}>) {
  const { request } = api;
  /** DEF-147: 公開の状態にあたる鍵の注意の印（その鍵のときだけ）。 */
  const mark = (key: string) => (publicationStateKeys.includes(key)
    ? <span className="field-hint" data-testid={`${testId}-publication-state`} data-key={key}>{text.publicationStateKey}</span>
    : null);
  return (
    <div data-testid={testId} data-shape-digest={api.shapeDigest}>
      <h3>{text.heading}</h3>
      <p className="field-hint">{text.note}</p>
      <dl className="facts">
        {/* T38f: 送り方（API のシナリオだけがこの要約を持つ）。 */}
        <dt>{text.transport}</dt>
        <dd data-item="transport" data-transport={transport}>{scenarioTransportDisplay(transport).label}</dd>
        <dt>{text.method}</dt>
        <dd data-item="method"><code>{request.method}</code></dd>
        <dt>{text.origin}</dt>
        <dd data-item="origin"><code>{request.origin}</code></dd>
        <dt>{text.pathShape}</dt>
        <dd data-item="pathShape"><code>{request.pathShape}</code></dd>
        <dt>{text.queryNames}</dt>
        <dd data-item="queryNames">{listOrNone(request.queryNames)}</dd>
        <dt>{text.contentType}</dt>
        <dd data-item="contentType">{request.contentType ?? text.none}</dd>
        <dt>{text.prefer}</dt>
        <dd data-item="prefer">{listOrNone(request.prefer)}</dd>
        <dt>{text.keyFields}</dt>
        <dd data-item="keyFields">
          {api.keyFields.length === 0 ? text.none : (
            <ul>
              {api.keyFields.map(({ key, type, field }) => (
                <li key={key} data-key={key}>{text.keyField(key, type, fieldTextOf(field))}{mark(key)}</li>
              ))}
            </ul>
          )}
        </dd>
        {/* T41e: 更新の保つ鍵（更新のシナリオだけが持つ。値は送る前の画面の値のまま）。 */}
        {api.keptKeys === undefined ? null : (
          <>
            <dt>{text.keptKeys}</dt>
            <dd data-item="keptKeys">
              {api.keptKeys.length === 0 ? text.none : (
                <ul>
                  {api.keptKeys.map(({ key, type, field }) => <li key={key} data-key={key}>{text.keptKey(key, type, fieldTextOf(field))}{mark(key)}</li>)}
                </ul>
              )}
            </dd>
          </>
        )}
        <dt>{text.pageKeys}</dt>
        <dd data-item="pageKeys">
          {api.pageKeys.length === 0 ? text.none : (
            <ul>
              {/* T41e: 更新のページが決める鍵は、照らす欄の識別も出す。 */}
              {api.pageKeys.map(({ key, type, field }) => (
                <li key={key} data-key={key}>
                  {field === undefined ? text.pageKey(key, type) : text.pageKeyField(key, type, fieldTextOf(field))}{mark(key)}
                </li>
              ))}
            </ul>
          )}
        </dd>
        <dt>{text.headerNames}</dt>
        <dd data-item="headerNames">{listOrNone(api.headerNames)}</dd>
        {api.filterName === null ? null : (
          <>
            <dt>{text.filterName}</dt>
            <dd data-item="filterName"><strong><code>{api.filterName}</code></strong></dd>
          </>
        )}
        {/* T38f: 登録の ID の取り方（応答の本文の鍵。指定がなければ、検証の指定の取り方）。 */}
        <dt>{text.recordId}</dt>
        <dd data-item="recordId">{api.recordId === null ? text.recordIdUnset : api.recordId.key}</dd>
      </dl>
      {api.filterName === null ? null : (
        <Notice kind="caution" heading={text.filterCautionHeading}>
          <p data-testid={`${testId}-filter-caution`}>{text.filterCaution}</p>
        </Notice>
      )}
      {/* DEF-147: 公開の状態にあたる欄の注意（その鍵があるときだけ）。 */}
      {publicationStateKeys.length === 0 ? null : (
        <Notice kind="caution" heading={text.publicationStateCautionHeading}>
          <p data-testid={`${testId}-publication-state-caution`}>{text.publicationStateCaution}</p>
        </Notice>
      )}
    </div>
  );
}
