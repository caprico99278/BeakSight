import { useState } from 'react';
import { Link, createFileRoute, notFound, useNavigate, useRouter } from '@tanstack/react-router';
import { useServerFn } from '@tanstack/react-start';
import { formatDateTime } from '../../../../../../src/presentation/format.js';
import {
  LOCAL_UI_READ_CHECK_TEXT,
  LOCAL_UI_TEXT,
  READ_CHECK_DEFINITION_REJECTION_DESCRIPTIONS,
} from '../../../../../../src/presentation/messages.js';
import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { Notice } from '../../../components/Notice';
import { PageFrame } from '../../../components/PageFrame';
import { ReadCheckForm } from '../../../components/ReadCheckForm';
import { expectationText, parametersText } from '../../../display/read-checks';
import {
  cancelReadCheckFn,
  readCheckPageFn,
  updateReadCheckFn,
  type ReadCheckCancelView,
} from '../../../server/read-check-functions';

export const Route = createFileRoute('/read-checks/$profileId/$readCheckId')({
  loader: async ({ params }) => {
    const page = await readCheckPageFn({ data: { profileId: params.profileId } });
    const definition = page?.definitions.find((view) => view.readCheckId === params.readCheckId) ?? null;
    if (page === null || definition === null) {
      throw notFound();
    }
    return { page, definition };
  },
  component: EditReadCheckPage,
});

const text = LOCAL_UI_READ_CHECK_TEXT;

/**
 * READ の確かめの定義を変える・削除する（Task 27 の設計書 4.5、4.7。T27f）。変更は、画面が読んだ版と保存されている版が同じときだけ（違えば
 * `READ_CHECK_REVISION_CONFLICT` を出す）。対象の候補が最後の発見の結果になければ、変えられない（削除はできる）。削除は確かめのダイアログの後。
 */
function EditReadCheckPage() {
  const { page, definition } = Route.useLoaderData();
  const update = useServerFn(updateReadCheckFn);
  const cancel = useServerFn(cancelReadCheckFn);
  const navigate = useNavigate();
  const router = useRouter();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeRejection, setRemoveRejection] = useState<Extract<ReadCheckCancelView, { ok: false }> | null>(null);
  const { profile } = page;
  const backToList = (notice: 'saved' | 'removed'): void => {
    void router.invalidate().then(() =>
      navigate({ to: '/read-checks/$profileId', params: { profileId: profile.profileId }, search: { notice } }));
  };

  return (
    <PageFrame title={text.pages.editReadCheck}>
      <section className="panel">
        <h2 className="panel-heading">{text.formHeading}</h2>
        <dl className="facts" data-testid="read-check-current" data-revision={String(definition.revision)}>
          <dt>{text.columns.revision}</dt>
          <dd>{LOCAL_UI_TEXT.profileForm.revisionText(definition.revision)}</dd>
          <dt>{text.columns.updatedAt}</dt>
          <dd>{formatDateTime(definition.updatedAt)}</dd>
          <dt>{text.columns.parameters}</dt>
          <dd>{parametersText(definition.definition.parameters)}</dd>
          <dt>{text.columns.expectations}</dt>
          <dd>
            <ul>
              {definition.definition.expectations.map((expectation, index) => <li key={String(index)}>{expectationText(expectation)}</li>)}
            </ul>
          </dd>
        </dl>
        {!page.editable ? (
          <Notice kind="caution">
            <p data-testid="read-check-retired">{page.eligible ? text.retired : text.notEligible}</p>
          </Notice>
        ) : definition.candidate === null ? (
          <Notice kind="caution">
            <p data-testid="read-check-candidate-missing">{text.candidateMissing}</p>
          </Notice>
        ) : (
          <ReadCheckForm
            candidate={definition.candidate}
            form={page.form}
            initial={{ parameters: definition.definition.parameters, expectations: definition.definition.expectations }}
            onSave={(changed) => update({ data: { readCheckId: definition.readCheckId, expectedRevision: definition.revision, definition: changed } })}
            onSaved={() => backToList('saved')}
            onReload={() => {
              void router.invalidate();
            }}
          />
        )}
      </section>
      <section className="panel">
        {removeRejection === null ? null : (
          <Notice kind="critical" heading={text.removeRejectedHeading}>
            <p data-testid="read-check-remove-rejection" data-reason={removeRejection.reason}>
              {READ_CHECK_DEFINITION_REJECTION_DESCRIPTIONS[removeRejection.reason].description}
            </p>
            <p>{READ_CHECK_DEFINITION_REJECTION_DESCRIPTIONS[removeRejection.reason].action}</p>
          </Notice>
        )}
        <button type="button" className="button button--danger" data-testid="read-check-remove" onClick={() => setDialogOpen(true)}>
          {text.remove}
        </button>
        <ConfirmDialog
          open={dialogOpen}
          title={text.removeDialog.title}
          body={text.removeDialog.body}
          confirmLabel={text.removeDialog.confirm}
          cancelLabel={text.removeDialog.cancel}
          busy={removing}
          onCancel={() => setDialogOpen(false)}
          onConfirm={() => {
            setRemoving(true);
            void cancel({ data: { readCheckId: definition.readCheckId, expectedRevision: definition.revision } })
              .then((result) => {
                setDialogOpen(false);
                if (result.ok) {
                  setRemoveRejection(null);
                  backToList('removed');
                } else {
                  setRemoveRejection(result);
                }
              })
              .finally(() => setRemoving(false));
          }}
        />
      </section>
      <p>
        <Link to="/read-checks/$profileId" params={{ profileId: profile.profileId }} className="button">{text.backToList}</Link>
      </p>
    </PageFrame>
  );
}
