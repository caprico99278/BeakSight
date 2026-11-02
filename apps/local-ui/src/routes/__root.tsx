import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { HeadContent, Link, Outlet, Scripts, createRootRoute, useRouter, useRouterState, type ErrorComponentProps } from '@tanstack/react-router';
import { useServerFn } from '@tanstack/react-start';
import { LOCAL_UI_AUDIT_TEXT, LOCAL_UI_FRAME_TEXT, LOCAL_UI_TEXT } from '../../../../src/presentation/messages.js';
import { PageFrame } from '../components/PageFrame';
import { UiPresence } from '../components/UiPresence';
import type { CredentialEnvironmentState } from '../server/credential-runtime';
import { environmentStatusFn, type EnvironmentStatusView } from '../server/profile-functions';
import appCssUrl from '../styles/app.css?url';
import tokensCssUrl from '../styles/tokens.css?url';

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: LOCAL_UI_TEXT.appName },
    ],
    links: [
      { rel: 'stylesheet', href: tokensCssUrl },
      { rel: 'stylesheet', href: appCssUrl },
    ],
  }),
  shellComponent: RootDocument,
  component: Outlet,
  notFoundComponent: NotFoundPage,
  errorComponent: ErrorPage,
});

/** プロファイルの登録の画面の path。 */
const NEW_PROFILE_PATH = '/profiles/new';

/** 環境の状態の画面の path。 */
const ENVIRONMENT_PATH = '/environment';

/**
 * 環境に、利用者が知るべき問題があるか（PL-V。設計書 `2026-10-26-beaksight-plain-ui-design.md` 13 章の 14）: 管理データの整合性の確かめが通らない
 * （環境の状態の画面が誤りの知らせを出す条件）か、Windows で資格情報の暗号化を確かめられない（環境の状態の画面が「使えません」を出す状態）とき。
 * Windows でない環境（`NOT_WINDOWS`）は、直せる問題ではなく、自動ログインを使う画面がそれぞれ理由を出すので、ここでは問題に数えない。
 */
const environmentNeedsAttention = (status: EnvironmentStatusView): boolean =>
  !status.quickCheckOk || status.credentialEnvironment === UNAVAILABLE_CREDENTIAL_ENVIRONMENT;

/** 資格情報の暗号化を確かめられなかった状態（`CREDENTIAL_ENVIRONMENT_STATES` の値）。 */
const UNAVAILABLE_CREDENTIAL_ENVIRONMENT: CredentialEnvironmentState = 'UNAVAILABLE';

/** 左のメニューの、環境の状態の項目（問題があるときだけ出す。状態はページを開いたときに 1 回だけ読む）。 */
function EnvironmentProblemItem({ current }: Readonly<{ current: boolean }>) {
  const fetchStatus = useServerFn(environmentStatusFn);
  const status = useQuery({
    queryKey: ['environment-status'],
    queryFn: () => fetchStatus(),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  if (status.data === undefined || !environmentNeedsAttention(status.data)) {
    return null;
  }
  return (
    <li>
      <Link to={ENVIRONMENT_PATH} className="nav-link nav-link--problem" aria-current={current ? 'page' : undefined}>
        {LOCAL_UI_FRAME_TEXT.environmentProblem}
      </Link>
    </li>
  );
}

/**
 * 左のメニュー（T24f で「実行履歴」を、T43a で「新しいプロファイル」を足した）。PL-V（13 章の 14）: サイトの一覧・サイトを足す・これまでの結果の 3 つ。
 * 環境の状態は、問題があるときだけ出す（画面の URL は残す）。
 */
function Sidebar() {
  const text = LOCAL_UI_TEXT;
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  // T43a（Task 43 の設計書 4.1。ユーザーの確認）: 登録の画面は「新しいプロファイル」のメニューに入る。
  const newProfileCurrent = pathname === NEW_PROFILE_PATH;
  // 一覧と、編集・監査の開始の画面は、同じ「サイトとプロファイル」のメニューに入る。
  const profilesCurrent = !newProfileCurrent && (pathname === '/' || pathname.startsWith('/profiles/') || pathname.startsWith('/start/'));
  // 実行履歴と、ジョブの詳細（進み具合）の画面は、「実行履歴」のメニューに入る（T24f）。
  const jobsCurrent = pathname === '/jobs' || pathname.startsWith('/jobs/');
  const environmentCurrent = pathname === ENVIRONMENT_PATH;
  return (
    <nav className="sidebar" aria-label={text.navigationLabel}>
      <p className="brand">
        <span className="brand-name">{text.appName}</span>
        <span className="brand-tagline">{text.appTagline}</span>
      </p>
      <ul className="nav-list">
        <li>
          <Link to="/" className="nav-link" aria-current={profilesCurrent ? 'page' : undefined}>
            {text.pages.profiles}
          </Link>
        </li>
        <li>
          <Link to={NEW_PROFILE_PATH} className="nav-link" aria-current={newProfileCurrent ? 'page' : undefined}>
            {text.pages.newProfile}
          </Link>
        </li>
        <li>
          <Link to="/jobs" className="nav-link" aria-current={jobsCurrent ? 'page' : undefined}>
            {LOCAL_UI_AUDIT_TEXT.pages.jobs}
          </Link>
        </li>
        <EnvironmentProblemItem current={environmentCurrent} />
      </ul>
    </nav>
  );
}

function Shell({ children }: Readonly<{ children: ReactNode }>) {
  // 監査のジョブの進み具合の読み直し（TanStack Query のポーリング。T24f）のための、画面ごとの Query の入れ物。
  const [queryClient] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={queryClient}>
      {/* UI-close: 管理画面のブラウザを閉じたら、画面のサーバも止まるように、開いている間と閉じるときに知らせる。 */}
      <UiPresence />
      <div className="app-shell">
        <Sidebar />
        <div className="main-column">{children}</div>
      </div>
    </QueryClientProvider>
  );
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="ja">
      <head>
        <HeadContent />
      </head>
      <body>
        <a className="skip-link" href="#main-content">{LOCAL_UI_TEXT.skipToContent}</a>
        <Shell>{children}</Shell>
        <Scripts />
      </body>
    </html>
  );
}

/** 見つからない画面。 */
function NotFoundPage() {
  return (
    <PageFrame title={LOCAL_UI_TEXT.notFound.title}>
      <section className="panel">
        <p>{LOCAL_UI_TEXT.notFound.body}</p>
        <Link to="/" className="button">{LOCAL_UI_TEXT.backToList}</Link>
      </section>
    </PageFrame>
  );
}

/** 画面を描けなかったとき（誤りの詳細は画面に出さない）。 */
function ErrorPage(_props: ErrorComponentProps) {
  const router = useRouter();
  return (
    <PageFrame title={LOCAL_UI_TEXT.error.title}>
      <section className="panel" role="alert">
        <p>{LOCAL_UI_TEXT.error.body}</p>
        <button type="button" className="button" onClick={() => void router.invalidate()}>
          {LOCAL_UI_TEXT.reload}
        </button>
      </section>
    </PageFrame>
  );
}
