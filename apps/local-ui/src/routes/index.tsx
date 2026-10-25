import { Link, createFileRoute } from '@tanstack/react-router';
import { formatDateTime } from '../../../../src/presentation/format.js';
import { LOCAL_UI_AUDIT_TEXT, LOCAL_UI_LOGIN_CHECK_TEXT, LOCAL_UI_NEXT_STEP_TEXT, LOCAL_UI_TEXT } from '../../../../src/presentation/messages.js';
import { PageFrame } from '../components/PageFrame';
import { LastRunCell } from '../components/LastRunCell';
import {
  auditModeDisplay,
  authStrategyDisplay,
  environmentDisplay,
  profileStatusDisplay,
  toneClass,
  usesAutomatedLogin,
} from '../display/labels';
import { auditStartUnavailableReasonOf } from '../display/next-steps';
import { listAuditJobsFn, type AuditJobRowView } from '../server/audit-job-functions';
import { listProfilesFn } from '../server/profile-functions';

export const Route = createFileRoute('/')({
  loader: async () => {
    const [profiles, jobs] = await Promise.all([listProfilesFn(), listAuditJobsFn()]);
    return { profiles, jobs };
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

/** サイトとプロファイルの一覧（Task 23 の設計書 4.7。T24f で「最後の Run」の欄と「監査を始める」を足した）。 */
function ProfileListPage() {
  const { profiles, jobs } = Route.useLoaderData();
  const text = LOCAL_UI_TEXT.profileList;
  const columns = text.columns;
  const lastJobs = lastJobsByProfile(jobs);
  return (
    <PageFrame title={LOCAL_UI_TEXT.pages.profiles}>
      <div className="toolbar">
        <Link to="/profiles/new" className="button button--primary">{text.newProfile}</Link>
      </div>
      <section className="panel">
        {profiles.length === 0 ? (
          <p data-testid="profile-list-empty">{text.empty}</p>
        ) : (
          <div className="table-wrap">
            <table className="data-table" data-testid="profile-list">
              <caption>{text.caption}</caption>
              <thead>
                <tr>
                  <th scope="col">{columns.profileId}</th>
                  <th scope="col">{columns.environment}</th>
                  <th scope="col">{columns.mode}</th>
                  <th scope="col">{columns.auth}</th>
                  <th scope="col">{columns.status}</th>
                  <th scope="col">{columns.revision}</th>
                  <th scope="col">{columns.updatedAt}</th>
                  <th scope="col">{columns.lastRun}</th>
                </tr>
              </thead>
              <tbody>
                {profiles.map((row) => {
                  const status = profileStatusDisplay(row.status);
                  // T25e: 今実行できるモードと認証の方式の組み合わせだけ（認証の設定の有無は、開始の画面が理由と案内を出す）。
                  // T43a（Task 43 の設計書 4.1）: 始められない行は、ボタンを黙って消さずに、理由を短く出す（判定は `next-steps.ts` の
                  // `auditStartUnavailableReasonOf`。`execution-policy.ts` の判定を呼ぶだけ）。
                  const unavailableReason = auditStartUnavailableReasonOf(row.status, row.mode, row.auth);
                  return (
                    <tr key={row.profileId} data-profile-id={row.profileId}>
                      <th scope="row" className="nowrap">
                        <Link to="/profiles/$profileId" params={{ profileId: row.profileId }}>
                          {row.profileId}
                        </Link>
                      </th>
                      <td>{environmentDisplay(row.environment).label}</td>
                      <td className="cell-break">{auditModeDisplay(row.mode).label}</td>
                      <td>{authStrategyDisplay(row.auth).label}</td>
                      <td><span className={toneClass(status.tone)}>{status.label}</span></td>
                      <td>{LOCAL_UI_TEXT.profileForm.revisionText(row.revision)}</td>
                      <td>{formatDateTime(row.updatedAt)}</td>
                      <td className="cell-wrap" data-testid="last-run">
                        <LastRunCell job={lastJobs.get(row.profileId) ?? null} />
                        {unavailableReason !== null ? (
                          <p className="cell-action muted" data-testid="profile-start-unavailable" data-reason={unavailableReason}>
                            {LOCAL_UI_NEXT_STEP_TEXT.auditStartUnavailable[unavailableReason]}
                          </p>
                        ) : (
                          <p className="cell-action">
                            <Link to="/start/$profileId" params={{ profileId: row.profileId }} className="button button--primary">
                              {LOCAL_UI_AUDIT_TEXT.profileList.startAudit}
                            </Link>
                            {/* T26e: 自動ログインのプロファイルは、ログインだけを確かめられる（始められない理由は、その画面が出す）。 */}
                            {usesAutomatedLogin(row.mode, row.auth) ? (
                              <>
                                {' '}
                                <Link to="/login-check/$profileId" params={{ profileId: row.profileId }} className="button">
                                  {LOCAL_UI_LOGIN_CHECK_TEXT.profileList.loginCheck}
                                </Link>
                              </>
                            ) : null}
                          </p>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </PageFrame>
  );
}
