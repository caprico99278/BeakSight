import { Link, createFileRoute } from '@tanstack/react-router';
import { formatDateTime } from '../../../../../src/presentation/format.js';
import { LOCAL_UI_AUDIT_TEXT, LOCAL_UI_LOGIN_CHECK_TEXT } from '../../../../../src/presentation/messages.js';
import { PageFrame } from '../../components/PageFrame';
import { auditJobEndKindDisplay, auditJobKindDisplay, auditJobStateDisplay, runStatusDisplay, toneClass } from '../../display/labels';
import { listAuditJobsFn } from '../../server/audit-job-functions';

export const Route = createFileRoute('/jobs/')({
  loader: () => listAuditJobsFn(),
  component: JobListPage,
});

/** 実行履歴（監査のジョブの一覧。新しい順。Task 24 の設計書 4.8）。 */
function JobListPage() {
  const jobs = Route.useLoaderData();
  const text = LOCAL_UI_AUDIT_TEXT.jobs;
  const columns = text.columns;
  const none = LOCAL_UI_AUDIT_TEXT.job.none;
  return (
    <PageFrame title={LOCAL_UI_AUDIT_TEXT.pages.jobs}>
      <section className="panel">
        {jobs.length === 0 ? (
          <p data-testid="job-list-empty">{text.empty}</p>
        ) : (
          <div className="table-wrap">
            <table className="data-table" data-testid="job-list">
              <caption>{text.caption}</caption>
              <thead>
                <tr>
                  <th scope="col">{columns.createdAt}</th>
                  <th scope="col">{columns.profileId}</th>
                  <th scope="col">{LOCAL_UI_LOGIN_CHECK_TEXT.job.kind}</th>
                  <th scope="col">{columns.state}</th>
                  <th scope="col">{columns.runId}</th>
                  <th scope="col">{columns.runStatus}</th>
                  <th scope="col">{columns.endKind}</th>
                  <th scope="col">{columns.finishedAt}</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => {
                  const state = auditJobStateDisplay(job.state);
                  const runStatus = job.runStatus === null ? null : runStatusDisplay(job.runStatus);
                  return (
                    <tr key={job.jobId} data-job-id={job.jobId}>
                      <th scope="row" className="nowrap">
                        <Link to="/jobs/$jobId" params={{ jobId: job.jobId }}>
                          {formatDateTime(job.createdAt)}
                        </Link>
                      </th>
                      <td>{job.profileId}</td>
                      <td data-kind={job.jobKind}>{auditJobKindDisplay(job.jobKind).label}</td>
                      <td><span className={toneClass(state.tone)}>{state.label}</span></td>
                      <td className="nowrap">{job.runId ?? none}</td>
                      <td>{runStatus === null ? none : <span className={toneClass(runStatus.tone)}>{runStatus.label}</span>}</td>
                      <td>{job.endKind === null ? none : auditJobEndKindDisplay(job.endKind).label}</td>
                      <td>{job.finishedAt === null ? none : formatDateTime(job.finishedAt)}</td>
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
