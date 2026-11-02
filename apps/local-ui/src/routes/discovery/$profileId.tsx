import { useState } from 'react';
import { Link, createFileRoute, notFound, useRouter } from '@tanstack/react-router';
import { ACTIVE_PROFILE_STATUS } from '../../../../../src/control/store/profile-records.js';
import { compareCodeUnits } from '../../../../../src/core/text.js';
import { CANDIDATE_CLASSIFICATION_CATALOG } from '../../../../../src/presentation/catalog.js';
import { formatCount } from '../../../../../src/presentation/format.js';
import {
  DISCOVERY_INCOMPLETE_REASON_DESCRIPTIONS,
  DISCOVERY_UNREAD_REASON_LABELS,
  LOCAL_UI_AUTO_DRAFT_TEXT,
  LOCAL_UI_DISCOVERY_TEXT,
  LOCAL_UI_TEXT,
  LOCAL_UI_WRITE_STAGE_TEXT,
  cliFieldText,
} from '../../../../../src/presentation/messages.js';
import { AdvancedSettings } from '../../components/AdvancedSettings';
import { Notice } from '../../components/Notice';
import { PageFrame, siteTrail } from '../../components/PageFrame';
import { StartReasonDetails } from '../../components/StartReasonDetails';
import { candidateClassificationDisplay, discoveryEndReasonDisplay, toneClass, usesScenarios } from '../../display/labels';
import type { AuditJobStartView } from '../../server/audit-job-functions';
import { discoveryPageFn, type DiscoveryCandidateView, type DiscoveryPageView } from '../../server/discovery-functions';
import { DiscoveryStartButton } from '../../components/DiscoveryStartButton';
import { scenarioAutoDraftPreviewFn, type AutoDraftPreviewView } from '../../server/scenario-autodraft-functions';
import { ScenarioAutoDraftPanel } from '../../components/ScenarioAutoDraftPanel';

export const Route = createFileRoute('/discovery/$profileId')({
  loader: async ({ params }) => {
    // FM2b: 書き込みの手順の下書きをボタン 1 回で作るまとまりの値（押せない理由と、確認のダイアログの一覧。保存しない）も読む。
    const [page, autoDraft] = await Promise.all([
      discoveryPageFn({ data: { profileId: params.profileId } }),
      scenarioAutoDraftPreviewFn({ data: { profileId: params.profileId } }),
    ]);
    if (page === null) {
      throw notFound();
    }
    return { ...page, autoDraft };
  },
  component: DiscoveryPage,
});

const text = LOCAL_UI_DISCOVERY_TEXT;
const stageText = LOCAL_UI_WRITE_STAGE_TEXT.discovery;

/** 候補の画面のまとまり（画面の path。PL-5: サイトのアドレスは出さないので、path だけで分ける）。 */
interface CandidateGroup {
  readonly path: string;
  readonly candidates: readonly DiscoveryCandidateView[];
}

/** 候補を、画面ごとにまとめる。まとまりは path の順、まとまりの中は分類の表示の順、識別の digest の順。 */
const groupsOf = (page: DiscoveryPageView): readonly CandidateGroup[] => {
  const groups = new Map<string, DiscoveryCandidateView[]>();
  for (const candidate of page.candidates) {
    groups.set(candidate.pagePath, [...(groups.get(candidate.pagePath) ?? []), candidate]);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([path, candidates]) => ({
      path,
      candidates: [...candidates].sort((left, right) =>
        CANDIDATE_CLASSIFICATION_CATALOG[left.classification].order - CANDIDATE_CLASSIFICATION_CATALOG[right.classification].order
        || compareCodeUnits(left.identityDigest, right.identityDigest)),
    }));
};

/** 書き込みの段の要点の状態（判定は下書きの部品の値 `AutoDraftPreviewView` だけ。画面は描くだけ）。 */
interface WriteSummary {
  /** 書き込める操作（登録と書き換えの形のうち、作れない形を除く）の数。 */
  readonly writable: number;
  /** 作る登録の形がある（「書き込みの手順を作る」を押せる）。 */
  readonly creatable: boolean;
  /** 書き込みの手順を作ってある（既にある登録の形がある）。 */
  readonly drafted: boolean;
}

const REJECTED_ROW_STATUS = 'REJECTED';
const NEW_ROW_STATUS = 'NEW';
const EXISTING_ROW_STATUS = 'EXISTING';

const writeSummaryOf = (preview: AutoDraftPreviewView | null): WriteSummary | null => {
  if (preview === null || preview.blocker !== null || preview.discoveryJobId === null) {
    return null;
  }
  const rows = [...preview.creates, ...preview.updates].filter((row) => row.status !== REJECTED_ROW_STATUS);
  return {
    writable: rows.length,
    creatable: preview.creates.some((row) => row.status === NEW_ROW_STATUS),
    drafted: preview.creates.some((row) => row.status === EXISTING_ROW_STATUS),
  };
};

/**
 * 操作さがし（Task 27 の設計書 4.4、4.7。T27f。PL-5 で設計書 `2026-10-26-beaksight-plain-ui-design.md` 3 章の形に作り直した）。上から: 要点のパネル（今の様子の文
 * 「書き込める操作が N 件見つかりました」、主のボタン 1 つ（操作をさがす／書き込みの手順を作る／書き込みの手順を見る）と二次の「もう一度さがす」）→ 詳しい内容 1 つ
 * （前回の操作さがしの終わり方と読んだ画面の数、見つかった操作の画面と分類）。候補の種類・送信先・送り方・ドリフト・分類の理由・欄の型は出さない（3 章の 2）。
 * 押せない「下書きを作る」は出さない（4 章の 6）。
 */
function DiscoveryPage() {
  const page = Route.useLoaderData();
  const router = useRouter();
  const [rejection, setRejection] = useState<Extract<AuditJobStartView, { ok: false }> | null>(null);
  const { profile, latest } = page;
  const startable = page.eligible && profile.status === ACTIVE_PROFILE_STATUS && page.start.blocker === null;
  const result = latest?.result ?? null;
  const groups = groupsOf(page);
  const writes = usesScenarios(profile.mode, profile.auth);
  const writeSummary = writes ? writeSummaryOf(page.autoDraft) : null;
  const draftBlocker = writes && latest !== null && page.autoDraft !== null ? page.autoDraft.blocker : null;
  // 主のボタン（段で 1 つ）: 作る登録の形がある → 作る。作ってある → 書き込みの手順を見る。ほか → 操作をさがす。
  const primary: 'CREATE' | 'OPEN' | 'SEARCH' = writeSummary?.creatable === true ? 'CREATE' : writeSummary?.drafted === true ? 'OPEN' : 'SEARCH';
  const startButton = (isPrimary: boolean) => (startable ? (
    <DiscoveryStartButton profileId={page.profile.profileId} revision={page.profile.revision} primary={isPrimary}
      label={latest === null ? text.submit : stageText.searchAgain} onRejected={setRejection} />
  ) : null);

  return (
    <PageFrame title={text.pages.discovery} trail={siteTrail(profile.profileId)}>
      {/* 3 章の 1: 要点のパネル。 */}
      <section className="panel" data-testid="discovery-summary" data-primary={primary}>
        <h2 className="panel-heading">{LOCAL_UI_WRITE_STAGE_TEXT.summaryHeading}</h2>
        {page.eligible ? null : (
          <Notice kind="caution">
            <p data-testid="discovery-not-eligible">{text.notEligible}</p>
          </Notice>
        )}
        {latest === null ? (
          <>
            <p data-testid="discovery-no-records">{text.noDiscovery}</p>
            <p data-testid="discovery-guidance">{text.guidance}</p>
          </>
        ) : null}
        {latest !== null && writes && writeSummary !== null ? (
          <p data-testid="discovery-found" data-count={String(writeSummary.writable)}>
            {writeSummary.writable === 0 ? stageText.foundNone : stageText.found(formatCount(writeSummary.writable))}
          </p>
        ) : null}
        {latest !== null && !writes ? <p data-testid="discovery-found" data-count={String(page.candidates.length)}>{stageText.foundReadOnly(formatCount(page.candidates.length))}</p> : null}
        {/* UX-1 の D 章（19）: 前回の操作さがしの終わり方と、その意味（読み切れなかったときに次にすることが分かるように、要点に出す）。 */}
        {result === null ? null : (
          <p>
            <span className={toneClass(discoveryEndReasonDisplay(result.endReason).tone)} data-testid="discovery-end-reason" data-reason={result.endReason}>
              {discoveryEndReasonDisplay(result.endReason).label}
            </span>
          </p>
        )}
        {result === null || discoveryEndReasonDisplay(result.endReason).description === null ? null : (
          <p className="muted">{discoveryEndReasonDisplay(result.endReason).description}</p>
        )}
        {/* 押せないときは、ボタンを出さずに理由と次にすること（カタログの文言）。 */}
        {draftBlocker === null ? null : (
          <div data-testid="auto-draft-blocker" data-reason={draftBlocker}>
            <p>{LOCAL_UI_AUTO_DRAFT_TEXT.blockers[draftBlocker].description}</p>
            <p>{LOCAL_UI_AUTO_DRAFT_TEXT.blockers[draftBlocker].action}</p>
          </div>
        )}
        {primary === 'CREATE' ? <p>{stageText.nextCreate}</p> : null}
        {primary === 'OPEN' ? <p data-testid="discovery-drafted">{stageText.drafted}</p> : null}
        {page.start.blocker === null ? null : (
          <Notice kind="critical" heading={text.cannotStartHeading}>
            <StartReasonDetails
              profileId={profile.profileId}
              reason={page.start.blocker}
              errorCodes={page.start.errorCodes}
              configError={page.configError}
              authSetupErrors={page.start.authSetupErrors}
              nextAllowedAt={page.start.nextAllowedAt}
              showLoginCheckLink
            />
          </Notice>
        )}
        {rejection === null ? null : (
          <Notice kind="critical" heading={text.rejectedHeading}>
            <StartReasonDetails
              profileId={profile.profileId}
              reason={rejection.reason}
              errorCodes={rejection.errorCodes}
              configError={null}
              authSetupErrors={rejection.authSetupErrors}
              nextAllowedAt={rejection.nextAllowedAt ?? null}
              showLoginCheckLink
            />
            <div className="button-row">
              <button type="button" className="button" onClick={() => void router.invalidate().then(() => setRejection(null))}>
                {LOCAL_UI_TEXT.reload}
              </button>
            </div>
          </Notice>
        )}
        {/* FM2b・PL-5: 作る登録の形があるときだけ、主のボタン「書き込みの手順を作る」（確認のダイアログと作った結果つき）。 */}
        {writes && page.autoDraft !== null && writeSummary !== null ? (
          <ScenarioAutoDraftPanel profileId={profile.profileId} preview={page.autoDraft} label={stageText.createDrafts} showButton={primary === 'CREATE'} />
        ) : null}
        <div className="button-row" data-testid="discovery-summary-actions">
          {primary === 'OPEN' ? (
            <Link to="/scenarios/$profileId" params={{ profileId: profile.profileId }} className="button button--primary" data-testid="discovery-open-scenarios">
              {stageText.openScenarios}
            </Link>
          ) : null}
          {startButton(primary === 'SEARCH')}
        </div>
      </section>

      {/* 3 章の 1: 詳しい内容 1 つ（前回の操作さがしの結果と、見つかった操作の画面と分類）。 */}
      <section className="panel">
        <AdvancedSettings testId="discovery-advanced">
          {result === null ? null : (
            <section data-testid="discovery-latest">
              <h3>{text.latestHeading}</h3>
              <dl className="facts">
                <dt>{text.pagesRead}</dt>
                <dd data-testid="discovery-pages-read">{formatCount(result.pagesRead)}</dd>
              </dl>
              {result.unreadReasons.length === 0 ? null : (
                <>
                  <h4>{text.unreadReasonsHeading}</h4>
                  <ul data-testid="discovery-unread-reasons">
                    {result.unreadReasons.map(({ reason, count }) => (
                      <li key={reason} data-reason={reason}>{cliFieldText(DISCOVERY_UNREAD_REASON_LABELS[reason], formatCount(count))}</li>
                    ))}
                  </ul>
                </>
              )}
              {result.incompletePages.length === 0 ? null : (
                <>
                  <h4>{text.incompletePagesHeading}</h4>
                  <ul data-testid="discovery-incomplete-pages">
                    {result.incompletePages.map((incomplete) => (
                      <li key={incomplete.url}>
                        {incomplete.path ?? incomplete.url}
                        {': '}
                        {incomplete.reasons.map((reason) => DISCOVERY_INCOMPLETE_REASON_DESCRIPTIONS[reason]).join(' ')}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>
          )}
          <section data-testid="discovery-candidates">
            <h3>{stageText.candidatesHeading}</h3>
            {groups.length === 0 ? <p data-testid="discovery-no-candidates">{text.noCandidates}</p> : groups.map((group) => (
              <section key={group.path} data-testid="discovery-page" data-page-path={group.path}>
                <h4>{stageText.pageHeading(group.path)}</h4>
                <ul>
                  {group.candidates.map((candidate) => {
                    const classification = candidateClassificationDisplay(candidate.classification);
                    return (
                      <li key={candidate.identityDigest} data-testid="discovery-candidate" data-digest={candidate.identityDigest}
                        data-classification={candidate.classification}>
                        <span className={toneClass(classification.tone)}>{classification.label}</span>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </section>
        </AdvancedSettings>
      </section>
    </PageFrame>
  );
}
