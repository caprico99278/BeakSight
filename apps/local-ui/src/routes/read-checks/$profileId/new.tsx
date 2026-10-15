import { Link, createFileRoute, notFound, useNavigate, useRouter } from '@tanstack/react-router';
import { useServerFn } from '@tanstack/react-start';
import { LOCAL_UI_DISCOVERY_TEXT, LOCAL_UI_READ_CHECK_TEXT, READ_CHECK_DEFINITION_REJECTION_DESCRIPTIONS } from '../../../../../../src/presentation/messages.js';
import { Notice } from '../../../components/Notice';
import { PageFrame } from '../../../components/PageFrame';
import { ReadCheckForm } from '../../../components/ReadCheckForm';
import { createReadCheckFn, readCheckPageFn } from '../../../server/read-check-functions';

/** 識別の digest の形（`sha256:` と小文字の 16 進 64 桁）。形が違えば、候補を選んでいない扱いにする。 */
const IDENTITY_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export const Route = createFileRoute('/read-checks/$profileId/new')({
  validateSearch: (search: Record<string, unknown>): { candidate?: string } => {
    const candidate = search['candidate'];
    return typeof candidate === 'string' && IDENTITY_DIGEST_PATTERN.test(candidate) ? { candidate } : {};
  },
  loader: async ({ params }) => {
    const page = await readCheckPageFn({ data: { profileId: params.profileId } });
    if (page === null) {
      throw notFound();
    }
    return page;
  },
  component: NewReadCheckPage,
});

const text = LOCAL_UI_READ_CHECK_TEXT;

/**
 * READ の確かめの定義を作る（Task 27 の設計書 4.5、4.7。T27f）。最後の「操作の候補を探す」の結果の、READ の確かめに使える候補から作る。送る値は
 * 値を送れる欄だけ、期待は閉じた一覧から選ぶ。保存はサーバの検証と保存の部品が決め、拒まれたら理由を項目ごとに出す。
 */
function NewReadCheckPage() {
  const page = Route.useLoaderData();
  const { candidate: digest } = Route.useSearch();
  const create = useServerFn(createReadCheckFn);
  const navigate = useNavigate();
  const router = useRouter();
  const { profile } = page;
  const candidate = page.candidates.find((view) => view.identityDigest === digest) ?? null;

  return (
    <PageFrame title={text.pages.newReadCheck}>
      {!page.editable ? (
        <Notice kind="caution">
          <p data-testid="read-check-retired">{page.eligible ? text.retired : text.notEligible}</p>
        </Notice>
      ) : candidate === null ? (
        <Notice kind="caution">
          <p data-testid="read-check-candidate-missing">{READ_CHECK_DEFINITION_REJECTION_DESCRIPTIONS.READ_CANDIDATE_UNKNOWN.description}</p>
          <p>{READ_CHECK_DEFINITION_REJECTION_DESCRIPTIONS.READ_CANDIDATE_UNKNOWN.action}</p>
        </Notice>
      ) : (
        <section className="panel">
          <h2 className="panel-heading">{text.formHeading}</h2>
          <dl className="facts" data-testid="read-check-target">
            <dt>{text.columns.page}</dt>
            <dd><code>{`${page.showOrigins ? candidate.pageOrigin : ''}${candidate.pagePath}`}</code></dd>
            <dt>{text.columns.action}</dt>
            <dd><code>{candidate.actionPath === null ? LOCAL_UI_DISCOVERY_TEXT.noAction : `${page.showOrigins ? candidate.actionOrigin ?? '' : ''}${candidate.actionPath}`}</code></dd>
            <dt>{text.columns.submitterWords}</dt>
            <dd>{LOCAL_UI_DISCOVERY_TEXT.submitterWordsValue(candidate.submitterWords)}</dd>
          </dl>
          <ReadCheckForm
            candidate={candidate}
            form={page.form}
            initial={null}
            onSave={(definition) => create({ data: { profileId: profile.profileId, definition } })}
            onSaved={() => {
              void router.invalidate().then(() =>
                navigate({ to: '/read-checks/$profileId', params: { profileId: profile.profileId }, search: { notice: 'saved' } }));
            }}
            onReload={() => {
              void router.invalidate();
            }}
          />
        </section>
      )}
      <p>
        <Link to="/read-checks/$profileId" params={{ profileId: profile.profileId }} className="button">{text.backToList}</Link>
      </p>
    </PageFrame>
  );
}
