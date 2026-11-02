import { useState } from 'react';
import { Link, createFileRoute, notFound, useNavigate, useRouter } from '@tanstack/react-router';
import { useServerFn } from '@tanstack/react-start';
import {
  LOCAL_UI_DISCOVERY_TEXT,
  LOCAL_UI_READ_CHECK_TEXT,
  READ_CHECK_DEFINITION_REJECTION_DESCRIPTIONS,
  READ_CHECK_TARGET_KIND_LABELS,
} from '../../../../../../src/presentation/messages.js';
import { Notice } from '../../../components/Notice';
import { PageFrame, readChecksTrail } from '../../../components/PageFrame';
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
  // MI-7（設計書 `2026-10-26-beaksight-minimal-input-ux-design.md` 4.8）: 対象の種類は、来たリンクで決める（候補から来たら候補、「画面を読む定義を作る」から
  // 来たら画面）。リンクなしで開いたときだけ、選ぶ radio を出す（選んでも URL は変えない。radio を出したまま）。
  const linkedKind: TargetKind | null = target ?? (digest === undefined ? null : 'CANDIDATE');
  const [chosenKind, setChosenKind] = useState<TargetKind>('CANDIDATE');
  const kind: TargetKind = linkedKind ?? chosenKind;
  const candidate = page.candidates.find((view) => view.identityDigest === digest) ?? null;
  const onSaved = (): void => {
    void router.invalidate().then(() =>
      navigate({ to: '/read-checks/$profileId', params: { profileId: profile.profileId }, search: { notice: 'saved' } }));
  };
  const onReload = (): void => {
    void router.invalidate();
  };

  return (
    <PageFrame title={text.pages.newReadCheck} trail={readChecksTrail(profile.profileId)}>
      {!page.editable ? (
        <Notice kind="caution">
          <p data-testid="read-check-retired">{page.eligible ? text.retired : text.notEligible}</p>
        </Notice>
      ) : (
        // PL-5 の修正の 1 回目（設計書 3 章の 1）: 要点のパネル（対象と入力、主のボタン「保存」1 つ）。直す欄はこのフォームだけなので、詳しい内容は置かない。
        <section className="panel" data-testid="read-check-new-summary">
          <h2 className="panel-heading">{text.formHeading}</h2>
          {linkedKind !== null ? null : (
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
                    onChange={() => setChosenKind(value)}
                  />
                  <span>{READ_CHECK_TARGET_KIND_LABELS[value]}</span>
                </label>
              ))}
            </fieldset>
          )}
          {kind === 'PAGE' ? (
            <ReadCheckForm
              key="page"
              // MI-7（設計書 4.8）: 画面の path は、直近の発見の結果の先頭を既定にする（読めた画面がなければ空。期待の既定は変えない）。
              target={{ kind: 'PAGE', pagePaths: page.pagePaths, initialPath: page.pagePaths[0] ?? '' }}
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
                {/* PL-5 の修正の 1 回目（設計書 3 章の 2）: 画面のアドレスの後ろだけ（サイトのアドレスと送信先は出さない）。 */}
                <dt>{text.columns.page}</dt>
                <dd>{candidate.pagePath}</dd>
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
    </PageFrame>
  );
}
