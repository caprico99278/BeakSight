import { Link, createFileRoute } from '@tanstack/react-router';
import { formatPlainDateTime } from '../../../../../src/presentation/format.js';
import { LOCAL_UI_AUDIT_TEXT, LOCAL_UI_JOB_SUMMARY_TEXT } from '../../../../../src/presentation/messages.js';
import { PageFrame } from '../../components/PageFrame';
import { auditJobKindDisplay, auditJobStateDisplay, runStatusDisplay, toneClass, type DisplayValue } from '../../display/labels';
import { listAuditJobsFn, type AuditJobRowView } from '../../server/audit-job-functions';

export const Route = createFileRoute('/jobs/')({
  loader: () => listAuditJobsFn(),
  component: JobListPage,
});

/**
 * 1 行の結果（PL-2: 終わった点検は点検の回の状態、ほかは作業の状態。ラベルは表示カタログのまま。英字の識別子は出さない）。
 */
const resultOf = (job: AuditJobRowView): DisplayValue =>
  (job.runStatus === null ? auditJobStateDisplay(job.state) : runStatusDisplay(job.runStatus));

/**
 * 作業の履歴（新しい順。Task 24 の設計書 4.8）。PL-2（設計書 `2026-10-26-beaksight-plain-ui-design.md` 3 章の 2）: 行は「何の作業か・いつ・結果」の 3 つ
 * だけ（点検の回の ID・終わり方・終わりの日時は出さない。作業の画面の詳しい内容にある）。
 */
function JobListPage() {
  const jobs = Route.useLoaderData();
  const text = LOCAL_UI_AUDIT_TEXT.jobs;
  const columns = LOCAL_UI_JOB_SUMMARY_TEXT.listColumns;
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
                  <th scope="col">{columns.what}</th>
                  <th scope="col">{columns.when}</th>
                  <th scope="col">{columns.result}</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => {
                  const result = resultOf(job);
                  return (
                    <tr key={job.jobId} data-job-id={job.jobId}>
                      <th scope="row" data-kind={job.jobKind}>
                        {auditJobKindDisplay(job.jobKind).label}
                        {' '}
                        <span className="muted">{job.profileId}</span>
                      </th>
                      <td className="nowrap">
                        <Link to="/jobs/$jobId" params={{ jobId: job.jobId }}>
                          {formatPlainDateTime(job.createdAt)}
                        </Link>
                      </td>
                      <td><span className={toneClass(result.tone)}>{result.label}</span></td>
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
