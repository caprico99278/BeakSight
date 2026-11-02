import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router';
import { useServerFn } from '@tanstack/react-start';
import { AUDIT_JOB_START_REJECTION_DESCRIPTIONS, LOCAL_UI_TEXT } from '../../../../../src/presentation/messages.js';
import { PageFrame } from '../../components/PageFrame';
import { EMPTY_PROFILE_FORM, ProfileForm, profileCreateInputOf } from '../../components/ProfileForm';
import { closedListReason, settleServerFunction } from '../../display/server-function-outcome';
import type { AuditJobStartView } from '../../server/audit-job-functions';
import { startEntryCheckFn } from '../../server/entry-check-functions';
import { createProfileFn, targetConfigCandidatesFn } from '../../server/profile-functions';

export const Route = createFileRoute('/profiles/new')({
  loader: () => targetConfigCandidatesFn(),
  component: NewProfilePage,
});

/** 入口の確かめの開始を拒む理由（閉じた一覧。鍵は文言のカタログと同じ）。 */
const isEntryCheckRejection = closedListReason(AUDIT_JOB_START_REJECTION_DESCRIPTIONS);

/**
 * プロファイルの登録（設計書 4.7）。T43b（Task 43 の設計書 4.2）: 既定は、開始の URL から対象の設定のファイルを決める（作成の入力に開始の URL と
 * 許可 Origin を足す）。MI-1（設計書 `doc/design/2026-10-26-beaksight-minimal-input-ux-design.md` 4.2）: 見える入力は 4 つだけ（`ProfileForm`）。
 * MI-2（同 4.2「保存して入口を確かめる」）: テスト環境のプロファイルは、保存に続けて、同じ押下で入口の確かめを 1 回始める（プロファイルの詳細の
 * 「入口を確かめる」と同じ Server Function `startEntryCheckFn`。開始の確かめはジョブの管理が行う）。始めたらジョブの画面へ移る。拒まれたとき
 * （Browser の自己検査の失敗、ロックなど）と、要求が届かなかったときは、プロファイルは保存したまま、プロファイルの詳細へ移り、理由を出す（詳細の
 * 入口の確かめの欄に「入口を確かめる」のボタンがある）。
 * OP-1（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1 の D11、4.1.3 の 3）: ボタンは「点検を始める」の 1 つ。下調べに、続けて点検を始める印を付ける
 * （始めるかはジョブの管理が決める。作業の画面が、始めた点検の作業へ移る。始めなかったときはサイトの画面へ移る）。OP-1 修正の 2 回目（設計者の判断）: ログイン
 * しなくても見られるサイトも同じ流れ（前は、保存だけでサイトの画面へ移り、下調べを自動で始めなかった）。公開のサイトの点検は、ジョブの管理が単独の点検で始める。
 * MI-F3（独立レビュー MI-R の Minor 14b）: 応答を取れなかった（`REQUEST_FAILED`）ときは、実際にはジョブが始まっていることがある。プロファイルの詳細は、その
 * プロファイルの入口の確かめのジョブ（動いているもの・終わったもの）を、「入口を確かめる」を押す前に見られる形で出す（もう一度始める案内は、ジョブがない
 * ときだけ）。動いている間に押し直しても、ジョブの管理の開始の守り（終わっていないジョブがあれば `JOB_ALREADY_ACTIVE`）で、二重には始まらない。
 */
function NewProfilePage() {
  const candidates = Route.useLoaderData();
  const create = useServerFn(createProfileFn);
  const startEntryCheck = useServerFn(startEntryCheckFn);
  const navigate = useNavigate();
  const router = useRouter();
  return (
    <PageFrame title={LOCAL_UI_TEXT.pages.newProfile} trail={[{ kind: 'sites' }]}>
      <section className="panel">
        <ProfileForm
          kind="create"
          initialValues={EMPTY_PROFILE_FORM}
          targetConfigCandidates={candidates}
          onSave={(values) => create({ data: profileCreateInputOf(values) })}
          onSaved={async (view) => {
            const { profile } = view.detail;
            const toProfile = (entryCheckNotStarted?: Extract<AuditJobStartView, { ok: false }>['reason'] | 'REQUEST_FAILED') => navigate({
              to: '/profiles/$profileId',
              params: { profileId: profile.profileId },
              search: { saved: 'created', ...(entryCheckNotStarted === undefined ? {} : { entryCheckNotStarted }) },
            });
            const outcome = await settleServerFunction<Extract<AuditJobStartView, { ok: true }>, Extract<AuditJobStartView, { ok: false }>['reason']>(
              startEntryCheck({ data: { profileId: profile.profileId, expectedRevision: profile.revision, thenStartAudit: true } }),
              isEntryCheckRejection,
            );
            switch (outcome.kind) {
              case 'ACCEPTED':
                await navigate({ to: '/jobs/$jobId', params: { jobId: outcome.result.jobId } });
                return;
              case 'REJECTED':
                await toProfile(outcome.reason);
                return;
              default:
                await toProfile(outcome.kind);
            }
          }}
          onReload={() => void router.invalidate()}
        />
      </section>
    </PageFrame>
  );
}
