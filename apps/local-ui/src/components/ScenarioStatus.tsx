/**
 * シナリオの承認の状態の表示（Task 28 の設計書 4.6。T28e）。一覧と詳細が共用する。状態のバッジ（ラベルと色。色だけに頼らない）と、再承認が
 * 要る理由の一覧（判定の順）。管理データの外の事実を求められなかったとき（`status` が null）は、確かめられないことを示す。
 */
import { LOCAL_UI_SCENARIO_TEXT } from '../../../../src/presentation/messages.js';
import { approvalInvalidityReasonDisplay, scenarioDisplayStateDisplay, toneClass } from '../display/labels';
import type { ScenarioStatusView } from '../server/scenario-functions';

export function ScenarioStatus({ status, showDescriptions }: Readonly<{ status: ScenarioStatusView | null; showDescriptions: boolean }>) {
  if (status === null) {
    return <span className={toneClass('caution')} data-testid="scenario-state" data-state="">{LOCAL_UI_SCENARIO_TEXT.factsUnavailable}</span>;
  }
  const display = scenarioDisplayStateDisplay(status.displayState);
  return (
    <>
      <span className={toneClass(display.tone)} data-testid="scenario-state" data-state={status.displayState}>{display.label}</span>
      {showDescriptions && display.description !== null ? <p className="muted">{display.description}</p> : null}
      {status.reasons.length === 0 ? null : (
        <ul data-testid="scenario-reasons">
          {status.reasons.map((reason) => {
            const reasonDisplay = approvalInvalidityReasonDisplay(reason);
            return (
              <li key={reason} data-reason={reason}>
                {reasonDisplay.label}
                {showDescriptions && reasonDisplay.description !== null ? <span className="muted">{` ${reasonDisplay.description}`}</span> : null}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
