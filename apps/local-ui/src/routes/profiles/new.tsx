import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router';
import { useServerFn } from '@tanstack/react-start';
import { LOCAL_UI_TEXT } from '../../../../../src/presentation/messages.js';
import { PageFrame } from '../../components/PageFrame';
import { EMPTY_PROFILE_FORM, FIRST_REVISION, ProfileForm, profileDocumentOf } from '../../components/ProfileForm';
import { createProfileFn, targetConfigCandidatesFn } from '../../server/profile-functions';

export const Route = createFileRoute('/profiles/new')({
  loader: () => targetConfigCandidatesFn(),
  component: NewProfilePage,
});

/** プロファイルの登録（設計書 4.7）。 */
function NewProfilePage() {
  const candidates = Route.useLoaderData();
  const create = useServerFn(createProfileFn);
  const navigate = useNavigate();
  const router = useRouter();
  return (
    <PageFrame title={LOCAL_UI_TEXT.pages.newProfile}>
      <section className="panel">
        <ProfileForm
          kind="create"
          initialValues={EMPTY_PROFILE_FORM}
          targetConfigCandidates={candidates}
          onSave={(values) => create({ data: { profile: profileDocumentOf(values, FIRST_REVISION) } })}
          onSaved={(view) => {
            void navigate({ to: '/profiles/$profileId', params: { profileId: view.detail.profile.profileId }, search: { saved: 'created' } });
          }}
          onReload={() => void router.invalidate()}
        />
      </section>
    </PageFrame>
  );
}
