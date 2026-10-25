import { Link, createFileRoute, notFound, useNavigate, useRouter } from '@tanstack/react-router';
import { useServerFn } from '@tanstack/react-start';
import {
  LOCAL_UI_DISCOVERY_TEXT,
  LOCAL_UI_READ_CHECK_TEXT,
  READ_CHECK_DEFINITION_REJECTION_DESCRIPTIONS,
  READ_CHECK_TARGET_KIND_LABELS,
} from '../../../../../../src/presentation/messages.js';
import { Notice } from '../../../components/Notice';
import { PageFrame } from '../../../components/PageFrame';
import { ReadCheckForm } from '../../../components/ReadCheckForm';
import { createReadCheckFn, readCheckPageFn } from '../../../server/read-check-functions';

/** 識別の digest の形（`sha256:` と小文字の 16 進 64 桁）。形が違えば、候補を選んでいない扱いにする。 */
const IDENTITY_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;

/** T37d: 読む対象の種類（URL の search で渡す。閉じた一覧。省略は候補）。 */
const TARGET_KINDS = Object.freeze(['CANDIDATE', 'PAGE'] as const);
type TargetKind = (typeof TARGET_KINDS)[number];
const isTargetKind = (value: unknown): value is TargetKind => TARGET_KINDS.some((kind) => kind === value);

export const Route = createFileRoute('/read-checks/$profileId/new')({
  validateSearch: (search: Record<string, unknown>): { candidate?: string; target?: TargetKind } => {
    const candidate = search['candidate'];
    const target = search['target'];
    return {
      ...(typeof candidate === 'string' && IDENTITY_DIGEST_PATTERN.test(candidate) ? { candidate } : {}),
      ...(isTargetKind(target) ? { target } : {}),
    };
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
 * T37d（Task 37 の設計書 3.5）: 読む対象として「候補を読む」と「画面を読む」を選べる。「画面を読む」は、画面の path の欄と、直近の発見の結果の画面から
 * 選ぶ一覧（読めなければ入力だけ）。
 */
function NewReadCheckPage() {
  const page = Route.useLoaderData();
  const { candidate: digest, target } = Route.useSearch();
  const create = useServerFn(createReadCheckFn);
  const navigate = useNavigate();
  const router = useRouter();
  const { profile } = page;
  const kind: TargetKind = target ?? 'CANDIDATE';
  const candidate = page.candidates.find((view) => view.identityDigest === digest) ?? null;
  const onSaved = (): void => {
    void router.invalidate().then(() =>
      navigate({ to: '/read-checks/$profileId', params: { profileId: profile.profileId }, search: { notice: 'saved' } }));
  };
  const onReload = (): void => {
    void router.invalidate();
  };

  return (
    <PageFrame title={text.pages.newReadCheck}>
      {!page.editable ? (
        <Notice kind="caution">
          <p data-testid="read-check-retired">{page.eligible ? text.retired : text.notEligible}</p>
        </Notice>
      ) : (
        <section className="panel">
          <h2 className="panel-heading">{text.formHeading}</h2>
          <fieldset className="field-group" data-testid="read-check-target-kind">
            <legend className="field-group-heading">{text.page.targetHeading}</legend>
            {TARGET_KINDS.map((value) => (
              <label key={value} className="choice">
                <input
                  type="radio"
                  name="read-check-target-kind"
                  value={value}
                  checked={kind === value}
                  data-target-kind={value}
                  onChange={() => {
                    void navigate({
                      to: '/read-checks/$profileId/new',
                      params: { profileId: profile.profileId },
                      search: { ...(digest === undefined ? {} : { candidate: digest }), target: value },
                    });
                  }}
                />
                <span>{READ_CHECK_TARGET_KIND_LABELS[value]}</span>
              </label>
            ))}
          </fieldset>
          {kind === 'PAGE' ? (
            <ReadCheckForm
              key="page"
              target={{ kind: 'PAGE', pagePaths: page.pagePaths, initialPath: '' }}
              form={page.form}
              initial={null}
              onSave={(definition) => create({ data: { profileId: profile.profileId, definition } })}
              onSaved={onSaved}
              onReload={onReload}
            />
          ) : candidate === null ? (
            <Notice kind="caution">
              <p data-testid="read-check-candidate-missing">{READ_CHECK_DEFINITION_REJECTION_DESCRIPTIONS.READ_CANDIDATE_UNKNOWN.description}</p>
              <p>{text.page.candidateNote}</p>
              <p>
                <Link to="/read-checks/$profileId" params={{ profileId: profile.profileId }}>{text.page.chooseCandidate}</Link>
              </p>
            </Notice>
          ) : (
            <>
              <dl className="facts" data-testid="read-check-target">
                <dt>{text.columns.page}</dt>
                <dd><code>{`${page.showOrigins ? candidate.pageOrigin : ''}${candidate.pagePath}`}</code></dd>
                <dt>{text.columns.action}</dt>
                <dd><code>{candidate.actionPath === null ? LOCAL_UI_DISCOVERY_TEXT.noAction : `${page.showOrigins ? candidate.actionOrigin ?? '' : ''}${candidate.actionPath}`}</code></dd>
                <dt>{text.columns.submitterWords}</dt>
                <dd>{LOCAL_UI_DISCOVERY_TEXT.submitterWordsValue(candidate.submitterWords)}</dd>
              </dl>
              <ReadCheckForm
                key="candidate"
                target={{ kind: 'CANDIDATE', candidate }}
                form={page.form}
                initial={null}
                onSave={(definition) => create({ data: { profileId: profile.profileId, definition } })}
                onSaved={onSaved}
                onReload={onReload}
              />
            </>
          )}
        </section>
      )}
      <p>
        <Link to="/read-checks/$profileId" params={{ profileId: profile.profileId }} className="button">{text.backToList}</Link>
      </p>
    </PageFrame>
  );
}
