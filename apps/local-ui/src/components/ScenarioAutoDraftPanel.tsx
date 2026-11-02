/**
 * 操作さがしの画面の「書き込みの手順を作る」（手を減らす段 2 の設計書 3A.2。5 章の 2026-10-22 の FM2b の Blocker の判断（案 2））。PL-5（設計書
 * `2026-10-26-beaksight-plain-ui-design.md` 3 章の 1、4 章の 6）で、要点のパネルの中の主のボタンと、作った結果の部品にした。
 * - 押せるときだけ、操作さがしの画面の要点が、この部品のボタンを主のボタンとして置く（押せない「下書きを作る」は出さない。押せない理由は要点の文）。
 * - PL-U の修正の 1 回目（設計書 14.1 の判断、U3）: 押すとすぐに作る（確認のダイアログはなくした。下書きは何も送らず、書き込みの OK の前に中身を見られる
 *   ので、安全のための確認ではない）。作った結果（作った書き込みの手順の数の 1 行、書き込みの手順へのリンク、決められなかった理由の 1 行）を出す。
 * - 送り方・アドレスの形・推した値・照合の READ の型・入れる値の決まりの中身は出さない（3 章の 2。作った書き込みの手順の画面と成果物に残る）。
 * - 更新は作らず、作成の画面へのリンク（候補・型・前もって選ぶ台帳と画面の型。ID と型だけ）を出す（作ったデータの一覧の「書き換えを試す」と同じ行き先）。
 */
import { useState } from 'react';
import { Link, useRouter } from '@tanstack/react-router';
import { useServerFn } from '@tanstack/react-start';
import { formatInteger } from '../../../../src/presentation/format.js';
import {
  LOCAL_UI_AUTO_DRAFT_TEXT,
  SCENARIO_DRAFT_REJECTION_DESCRIPTIONS,
  SCENARIO_REQUEST_REJECTION_DESCRIPTIONS,
} from '../../../../src/presentation/messages.js';
import {
  createScenarioAutoDraftsFn,
  type AutoDraftCreatePreviewView,
  type AutoDraftCreateResultView,
  type AutoDraftPreviewView,
  type AutoDraftResultView,
  type AutoDraftUpdateResultView,
} from '../server/scenario-autodraft-functions';
// 自動の下書きの案内から開いた作成の画面の印（URL の引数。承認に結ばない。値の 1 か所は `auto-draft-search.ts`）。
import { AUTO_DRAFT_SEARCH_MARK } from '../display/auto-draft-search';
import { Notice } from './Notice';

const text = LOCAL_UI_AUTO_DRAFT_TEXT;

/** PL-6b: フォームの形の登録の、決められなかった理由（1 行ずつ）。 */
function Gaps({ gaps }: Readonly<{ gaps: AutoDraftCreatePreviewView['gaps'] }>) {
  return gaps.length === 0 ? null : (
    <ul data-testid="auto-draft-gaps">
      {gaps.map((gap) => <li key={gap} data-gap={gap}>{text.formGaps[gap]}</li>)}
    </ul>
  );
}

/** 作った結果の 1 行（PL-D2: 作った書き込みの手順が 0 個のときは、作らなかったことが分かる 1 行）。 */
function createdCountText(creates: readonly AutoDraftCreateResultView[]): string {
  const created = creates.filter(({ status }) => status === 'CREATED').length;
  return created === 0 ? text.noneCreated : text.createdCount(formatInteger(created));
}

/** 作った結果の、登録の行 1 つ。 */
function CreateResult({ profileId, item }: Readonly<{ profileId: string; item: AutoDraftCreateResultView }>) {
  const statusText = item.status === 'CREATED' ? text.createdStatus : item.status === 'FAILED' ? text.failedStatus : text.createStatuses[item.status];
  return (
    <li data-testid="auto-draft-result-create" data-status={item.status} data-scenario-id={item.scenarioId ?? ''} data-shape-digest={item.shapeDigest}>
      <p>{item.pagePath}: <strong>{statusText}</strong></p>
      {item.failure === null ? null : <p className="field-hint">{SCENARIO_REQUEST_REJECTION_DESCRIPTIONS[item.failure].description}</p>}
      {item.reason === null ? null : <p className="field-hint">{SCENARIO_DRAFT_REJECTION_DESCRIPTIONS[item.reason].description}</p>}
      <Gaps gaps={item.gaps} />
      {item.status !== 'CREATED' || item.rules?.attached === true ? null : <p data-testid="auto-draft-rules-failed">{text.rulesFailed}</p>}
      {item.scenarioId === null ? null : (
        <p>
          <Link to="/scenarios/$profileId/$scenarioId" params={{ profileId, scenarioId: item.scenarioId }} data-testid="auto-draft-open-scenario">
            {text.openScenario}
          </Link>
        </p>
      )}
    </li>
  );
}

/** 作った結果の、更新の行 1 つ（作成の画面へのリンク。変える欄は人が選ぶ）。 */
function UpdateResult({ profileId, item }: Readonly<{ profileId: string; item: AutoDraftUpdateResultView }>) {
  const { link } = item;
  return (
    <li data-testid="auto-draft-result-update" data-status={item.status} data-shape-digest={item.shapeDigest}>
      <p>{item.pagePath}: <strong>{text.updateStatuses[item.status]}</strong></p>
      {item.reason === null ? null : <p className="field-hint">{SCENARIO_DRAFT_REJECTION_DESCRIPTIONS[item.reason].description}</p>}
      {link === null ? null : (
        <p>
          <Link
            to="/scenarios/$profileId/new"
            params={{ profileId }}
            search={{
              candidate: link.candidate,
              ...(link.shape === '' ? {} : { shape: link.shape }),
              ...(link.ledger === null ? {} : { ledger: link.ledger }),
              ...(link.template === null ? {} : { template: link.template }),
              autoDraft: AUTO_DRAFT_SEARCH_MARK,
            }}
            data-testid="auto-draft-open-create-form"
            data-preset-ledger={item.presetLedger?.value ?? ''}
          >
            {text.openCreateForm}
          </Link>
        </p>
      )}
    </li>
  );
}

/**
 * 操作さがしの画面と書き込みの手順の 0 件の一覧の要点の、「書き込みの手順を作る」のボタンと作った結果（PL-U で確認のダイアログをなくした）。押せる値（`preview` の押せない理由が null）のときだけ、
 * 呼び出し側が置く。`label` はボタンの語（要点の主のボタンの語）。作った後は、呼び出し側が読み直した値で主のボタンを決める（この部品は結果だけを出す）。
 */
export function ScenarioAutoDraftPanel({ profileId, preview, label, showButton }: Readonly<{
  profileId: string;
  preview: AutoDraftPreviewView;
  label: string;
  /** ボタンを出すか（作る登録の形があるときだけ。作った後も、結果は出し続ける）。 */
  showButton: boolean;
}>) {
  const create = useServerFn(createScenarioAutoDraftsFn);
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AutoDraftResultView | null>(null);
  const makeDrafts = (): void => {
    if (preview.discoveryJobId === null) {
      return;
    }
    setBusy(true);
    void create({ data: { profileId, expectedRevision: preview.expectedRevision, discoveryJobId: preview.discoveryJobId } })
      .then((made) => {
        setResult(made);
        return router.invalidate();
      })
      .finally(() => setBusy(false));
  };

  return (
    <div data-testid="auto-draft-panel">
      {result === null && showButton ? (
        <div className="button-row">
          <button type="button" className="button button--primary" disabled={busy} data-testid="auto-draft-open" onClick={makeDrafts}>
            {busy ? text.creating : label}
          </button>
        </div>
      ) : null}
      {result === null ? null : result.ok ? (
        <div data-testid="auto-draft-result">
          <h3>{text.resultHeading}</h3>
          <p data-testid="auto-draft-created-count">{createdCountText(result.creates)}</p>
          {/* PL-F（PL-D2 の発見）: 作る形が 0 件のときは、上の 1 行（`noneCreated`）だけにする。 */}
          {result.creates.length === 0 ? null : (
            <ul>{result.creates.map((item) => <CreateResult key={`${item.identityDigest} ${item.shapeDigest}`} profileId={profileId} item={item} />)}</ul>
          )}
          {result.updates.length === 0 ? null : (
            <ul>{result.updates.map((item) => <UpdateResult key={`${item.identityDigest} ${item.shapeDigest}`} profileId={profileId} item={item} />)}</ul>
          )}
        </div>
      ) : (
        <Notice kind="critical" heading={text.cannotHeading}>
          <div data-testid="auto-draft-result-blocker" data-reason={result.blocker}>
            <p>{text.blockers[result.blocker].description}</p>
            <p>{text.blockers[result.blocker].action}</p>
          </div>
        </Notice>
      )}
    </div>
  );
}
