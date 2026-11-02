import { Link, createFileRoute } from '@tanstack/react-router';
import { formatPlainDateTime } from '../../../../src/presentation/format.js';
import { LOCAL_UI_NEXT_STEP_TEXT, LOCAL_UI_TEXT } from '../../../../src/presentation/messages.js';
import { PageFrame } from '../components/PageFrame';
import { LastRunCell } from '../components/LastRunCell';
import { auditModeDisplay } from '../display/labels';
import { listAuditJobsFn, type AuditJobRowView } from '../server/audit-job-functions';
import { listProfilesFn } from '../server/profile-functions';
import { profileStagesFn, type ProfileListStageView } from '../server/profile-onboarding-functions';

export const Route = createFileRoute('/')({
  loader: async () => {
    const [profiles, jobs, stages] = await Promise.all([listProfilesFn(), listAuditJobsFn(), profileStagesFn()]);
    return { profiles, jobs, stages };
  },
  component: ProfileListPage,
});

/** プロファイルごとの、最後の（いちばん新しい）監査のジョブ。実行履歴は新しい順に並んでいる。 */
const lastJobsByProfile = (jobs: readonly AuditJobRowView[]): ReadonlyMap<string, AuditJobRowView> => {
  const lastJobs = new Map<string, AuditJobRowView>();
  for (const job of jobs) {
    if (!lastJobs.has(job.profileId)) {
      lastJobs.set(job.profileId, job);
    }
  }
  return lastJobs;
};

/** 行の短い文（段の文。自動ログインの間隔の中は、始められる時刻も）。 */
const stageLineOf = (view: ProfileListStageView): string => {
  const line = LOCAL_UI_NEXT_STEP_TEXT.listStages[view.stage.stage];
  return view.stage.stage === 'AUTO_LOGIN_WAIT' && view.nextAllowedAt !== null
    ? `${line}。${LOCAL_UI_NEXT_STEP_TEXT.waitUntil(formatPlainDateTime(view.nextAllowedAt))}`
    : line;
};

/**
 * サイトの一覧（Task 23 の設計書 4.7。T24f で「前回の点検」の欄を足した）。PL-1（設計書 `2026-10-26-beaksight-plain-ui-design.md` 3 章、13 章の 12）:
 * - 行がないときは、何をする道具かの 1 行の直下に、主のボタン「サイトを足す」を置く。行があるときも、main の主のボタンは「サイトを足す」1 つ。
 * - 行ごとのボタンは「続ける」1 つ（行き先はサイトの画面。主のボタンの見た目は使わない）。行の短い文は、サイトの画面と同じ判定（サーバの `profileStagesFn`。
 *   `profileStageOf`）の段の文。取り消した行は、ボタンを出さずに段の文だけ。
 * - 2 章の「出さないもの」（版、日時の細かい行）と、使い方で決まる列（サイトの種類、ログインのしかた、状態）は出さない。
 * - OP-I（I3。設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1.5）: 表は本文の幅に収める（横のスクロールを出さない）。「次にすること」の段の文は
 *   折り返す。狭い画面（13 章の 5）では、行ごとの縦の並び（`data-table--stack`。列の名前は各値の前。`data-label`）にする。
 */
function ProfileListPage() {
  const { profiles, jobs, stages } = Route.useLoaderData();
  const text = LOCAL_UI_TEXT.profileList;
  const columns = text.columns;
  const lastJobs = lastJobsByProfile(jobs);
  const stageByProfile = new Map(stages.map((view) => [view.profileId, view]));
  return (
    <PageFrame title={LOCAL_UI_TEXT.pages.profiles}>
      <section className="panel" data-testid="profile-list-summary">
        <p>{text.intro}</p>
        {profiles.length === 0 ? <p data-testid="profile-list-empty">{text.empty}</p> : null}
        <div className="button-row">
          <Link to="/profiles/new" className="button button--primary">{text.newProfile}</Link>
        </div>
      </section>
      {profiles.length === 0 ? null : (
        <section className="panel">
          <div className="table-wrap">
            <table className="data-table data-table--stack" data-testid="profile-list">
              <caption>{text.caption}</caption>
              <thead>
                <tr>
                  <th scope="col">{columns.profileId}</th>
                  <th scope="col">{columns.mode}</th>
                  <th scope="col">{columns.lastRun}</th>
                  <th scope="col">{columns.next}</th>
                </tr>
              </thead>
              <tbody>
                {profiles.map((row) => {
                  const stage = stageByProfile.get(row.profileId) ?? null;
                  return (
                    <tr key={row.profileId} data-profile-id={row.profileId}>
                      <th scope="row" className="nowrap" data-label={columns.profileId}>
                        <Link to="/profiles/$profileId" params={{ profileId: row.profileId }}>
                          {row.profileId}
                        </Link>
                      </th>
                      <td className="cell-break" data-label={columns.mode}>{auditModeDisplay(row.mode).label}</td>
                      <td className="cell-wrap" data-testid="last-run" data-label={columns.lastRun}>
                        <LastRunCell job={lastJobs.get(row.profileId) ?? null} />
                      </td>
                      <td className="cell-wrap" data-testid="profile-row-next" data-stage={stage?.stage.stage ?? ''} data-label={columns.next}>
                        {stage === null ? null : <p className="cell-text muted">{stageLineOf(stage)}</p>}
                        {stage === null || stage.stage.stage === 'SITE_RETIRED' ? null : (
                          <p className="cell-action">
                            <Link to="/profiles/$profileId" params={{ profileId: row.profileId }} className="button" data-testid="profile-row-continue">
                              {LOCAL_UI_NEXT_STEP_TEXT.continue}
                            </Link>
                          </p>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </PageFrame>
  );
}
