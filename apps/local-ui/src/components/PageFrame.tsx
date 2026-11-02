/**
 * 画面の枠（上の帯と本文）。PL-V（設計書 `2026-10-26-beaksight-plain-ui-design.md` 13 章）:
 * - 今どこにいるかの 1 行（13 章の 4）: h1 の上に「サイトの一覧 ＞ ◯◯ ＞ 点検」の形の 1 行を出す（`trail`）。各画面の一番下にあった戻るボタンの
 *   代わり。項目の名前と行き先はこの部品の中だけで決め（`TrailStepLink`）、区切りもこの部品の中の 1 か所だけ（`LOCAL_UI_FRAME_TEXT.trailSeparator`）。
 *   最後の項目は今の画面（題と同じ語。リンクにしない）。
 * - 自動で次へ移ったとき（3 章の 5、13 章の最後）: 移った先の画面の search に印（`ARRIVAL_SEARCH`）があれば、h1 にフォーカスを置く（読み上げで、
 *   画面が替わったことと題が伝わるように）。印は、移す側が `navigate({ search: { ...ARRIVAL_SEARCH } })` の形で付け、移った先の route の
 *   `validateSearch` は `arrivalSearchOf` で受ける（この部品は location の search を直接読むので、受けなくても働く）。
 */
import { Link, useRouterState } from '@tanstack/react-router';
import { Fragment, useEffect, useRef, type ReactNode } from 'react';
import {
  LOCAL_UI_FRAME_TEXT,
  LOCAL_UI_READ_CHECK_TEXT,
  LOCAL_UI_SCENARIO_TEXT,
  LOCAL_UI_TEXT,
} from '../../../../src/presentation/messages.js';

/**
 * 今どこにいるかの 1 行の、今の画面より上の 1 項目（行き先の画面の種類）。名前はこの部品が決める: 一覧と種類の画面は、その画面の題と同じ語。
 * サイトはサイトの名前（プロファイルの ID。一覧の画面と同じ）。シナリオは ID を画面に出さない（設計書 3 章の 2）ので、詳細の画面の題の語。
 */
export type PageTrailStep =
  | { readonly kind: 'sites' }
  | { readonly kind: 'site'; readonly profileId: string }
  | { readonly kind: 'readChecks'; readonly profileId: string }
  | { readonly kind: 'scenarios'; readonly profileId: string }
  | { readonly kind: 'scenario'; readonly profileId: string; readonly scenarioId: string };

/** 1 つのサイトの画面の 1 行（「サイトの一覧 ＞ <サイト>」）。サイトの下の画面の多くが使う。 */
export const siteTrail = (profileId: string): readonly PageTrailStep[] => [{ kind: 'sites' }, { kind: 'site', profileId }];

/** READ の確かめの一覧の下の画面の 1 行（「… ＞ <サイト> ＞ READ の確かめ」）。 */
export const readChecksTrail = (profileId: string): readonly PageTrailStep[] => [...siteTrail(profileId), { kind: 'readChecks', profileId }];

/** シナリオの一覧の下の画面の 1 行（「… ＞ <サイト> ＞ シナリオ」）。 */
export const scenariosTrail = (profileId: string): readonly PageTrailStep[] => [...siteTrail(profileId), { kind: 'scenarios', profileId }];

/** 1 つのシナリオの下の画面の 1 行（「… ＞ シナリオ ＞ シナリオの詳細」）。 */
export const scenarioTrail = (profileId: string, scenarioId: string): readonly PageTrailStep[] =>
  [...scenariosTrail(profileId), { kind: 'scenario', profileId, scenarioId }];

/** 自動で次の画面へ移ったことを示す search の鍵と値（`ARRIVAL_SEARCH`）。 */
const ARRIVAL_SEARCH_KEY = 'arrived';
const ARRIVAL_SEARCH_VALUE = 'auto';

/** 自動で次の画面へ移すときに、移った先の search に足す印。 */
export const ARRIVAL_SEARCH = Object.freeze({ [ARRIVAL_SEARCH_KEY]: ARRIVAL_SEARCH_VALUE } as { readonly arrived: 'auto' });

/** route の `validateSearch` で、自動で移った印を受ける（印がなければ空）。 */
export const arrivalSearchOf = (search: Readonly<Record<string, unknown>>): { readonly arrived?: 'auto' } =>
  search[ARRIVAL_SEARCH_KEY] === ARRIVAL_SEARCH_VALUE ? ARRIVAL_SEARCH : {};

/**
 * 1 行のリンクを、今の画面の上の画面として印を付けない（TanStack Router の Link は、行き先が今の path の前の部分なら `aria-current` を付ける。
 * 今の画面の印は、1 行の最後の項目だけに付ける）。
 */
const TRAIL_ACTIVE_OPTIONS = Object.freeze({ exact: true });

/** 1 行の 1 項目のリンク（名前と行き先）。 */
function TrailStepLink({ step }: Readonly<{ step: PageTrailStep }>) {
  switch (step.kind) {
    case 'sites':
      return <Link to="/" activeOptions={TRAIL_ACTIVE_OPTIONS}>{LOCAL_UI_TEXT.pages.profiles}</Link>;
    case 'site':
      return <Link to="/profiles/$profileId" params={{ profileId: step.profileId }} activeOptions={TRAIL_ACTIVE_OPTIONS}>{step.profileId}</Link>;
    case 'readChecks':
      return <Link to="/read-checks/$profileId" params={{ profileId: step.profileId }} activeOptions={TRAIL_ACTIVE_OPTIONS}>{LOCAL_UI_READ_CHECK_TEXT.pages.readChecks}</Link>;
    case 'scenarios':
      return <Link to="/scenarios/$profileId" params={{ profileId: step.profileId }} activeOptions={TRAIL_ACTIVE_OPTIONS}>{LOCAL_UI_SCENARIO_TEXT.pages.scenarios}</Link>;
    case 'scenario':
      return <Link to="/scenarios/$profileId/$scenarioId" params={{ profileId: step.profileId, scenarioId: step.scenarioId }} activeOptions={TRAIL_ACTIVE_OPTIONS}>{LOCAL_UI_SCENARIO_TEXT.pages.scenario}</Link>;
  }
}

/** 区切り（読み上げでは読まない）。 */
function TrailSeparator() {
  return <span className="page-context-separator" aria-hidden="true">{LOCAL_UI_FRAME_TEXT.trailSeparator}</span>;
}

/** 上の帯（今どこにいるかの 1 行、今の画面の名前、待ち受けの小さな表示）と本文。 */
export function PageFrame({ title, trail, children }: Readonly<{
  title: string;
  /** 今どこにいるかの 1 行の、今の画面より上の項目（上から順。ないときは 1 行を出さない）。 */
  trail?: readonly PageTrailStep[];
  children: ReactNode;
}>) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const arrived = useRouterState({
    select: (state) => (state.location.search as Readonly<Record<string, unknown>>)[ARRIVAL_SEARCH_KEY] === ARRIVAL_SEARCH_VALUE,
  });
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  useEffect(() => {
    if (arrived) {
      titleRef.current?.focus();
    }
  }, [arrived, pathname]);
  return (
    <>
      <header className="top-bar">
        <div className="top-bar-titles">
          {trail === undefined || trail.length === 0 ? null : (
            <p className="page-context" data-testid="page-context">
              {trail.map((step, index) => (
                // 項目の並びは画面ごとに決まっていて、入れ替わらない。
                <Fragment key={`${step.kind}:${String(index)}`}>
                  <TrailStepLink step={step} />
                  <TrailSeparator />
                </Fragment>
              ))}
              <span aria-current="page">{title}</span>
            </p>
          )}
          <h1 ref={titleRef} className="page-title" tabIndex={-1}>{title}</h1>
        </div>
        <span className="badge badge--positive">{LOCAL_UI_TEXT.listeningBadge}</span>
      </header>
      <main id="main-content" className="content" tabIndex={-1}>
        {children}
      </main>
    </>
  );
}
