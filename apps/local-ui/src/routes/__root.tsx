import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HeadContent, Link, Outlet, Scripts, createRootRoute, useRouter, useRouterState, type ErrorComponentProps } from '@tanstack/react-router';
import { LOCAL_UI_AUDIT_TEXT, LOCAL_UI_TEXT } from '../../../../src/presentation/messages.js';
import { PageFrame } from '../components/PageFrame';
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

/** 左のメニュー（使える画面だけ。T24f で「実行履歴」を足した）。 */
function Sidebar() {
  const text = LOCAL_UI_TEXT;
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  // 一覧と、登録・編集・監査の開始の画面は、同じ「サイトとプロファイル」のメニューに入る。
  const profilesCurrent = pathname === '/' || pathname.startsWith('/profiles/') || pathname.startsWith('/start/');
  // 実行履歴と、ジョブの詳細（進み具合）の画面は、「実行履歴」のメニューに入る（T24f）。
  const jobsCurrent = pathname === '/jobs' || pathname.startsWith('/jobs/');
  const environmentCurrent = pathname === '/environment';
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
          <Link to="/jobs" className="nav-link" aria-current={jobsCurrent ? 'page' : undefined}>
            {LOCAL_UI_AUDIT_TEXT.pages.jobs}
          </Link>
        </li>
        <li>
          <Link to="/environment" className="nav-link" aria-current={environmentCurrent ? 'page' : undefined}>
            {text.pages.environment}
          </Link>
        </li>
      </ul>
    </nav>
  );
}

function Shell({ children }: Readonly<{ children: ReactNode }>) {
  // 監査のジョブの進み具合の読み直し（TanStack Query のポーリング。T24f）のための、画面ごとの Query の入れ物。
  const [queryClient] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={queryClient}>
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
