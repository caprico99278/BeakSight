/**
 * T44a（設計書 `doc/design/2026-10-21-beaksight-task-44-efficiency-precision-usability-design.md` 2 章）: fixture の代表のサイトの正解（fixture の側の
 * 記録）。測りの部品（`audit-metrics.ts`）が、見つけた数と比べる。値は fixture の作りから決めたもので、製品の判定を写したものではない。
 * - 静的なサイト（公開の監査）: `fixtures/site/full-crawl/`（`startFixtureServer({ siteMetadataDirectory: 'full-crawl' })`）。
 * - スクリプトでログインする SPA の管理画面: `spa-auth-site-fixture.ts`（`SPA_REPRESENTATIVE_OPTIONS` と、会員 2 人）。T44c: 実テスト環境の形を足したもの
 *   （`SPA_REAL_ENV_SHAPE_OPTIONS`）。
 * 静的なサイトの一覧は、`tests/integration/fixture-full-crawl.test.ts` の `EXPECTED_AUDITED_PATHS`・`EXPECTED_RULE_IDS_BY_PATH` と同じ中身（そのテストは
 * 別のプロセスの CLI を確かめるので、ここからは読まない。共通化の候補として記録する）。
 */
import {
  SPA_APP_PATHS,
  SPA_CROWDED_ICON_BUTTON_COUNT,
  SPA_HIDDEN_PRESS_TARGET_WORDS,
  SPA_TOOLBAR_PRESS_WORDS,
  spaMemberDetailPathOf,
  spaMemberEditPathOf,
  type SpaAuthSiteOptions,
} from './spa-auth-site-fixture.js';

// ---------------------------------------------------------------------------------------------------------------
// 静的なサイト（公開の監査）
// ---------------------------------------------------------------------------------------------------------------

/** 静的なサイトのサイトの metadata のディレクトリ（`fixtures/site/` からの相対）。 */
export const STATIC_SITE_METADATA_DIRECTORY = 'full-crawl';
/** 静的なサイトの開始の path。 */
export const STATIC_SITE_START_PATH = '/full-crawl/index.html';

/** 静的なサイトで監査されるべきページ（入口から幅優先。`missing.html` はこのサーバにない 404 のページ）。 */
export const STATIC_SITE_EXPECTED_PAGES: readonly string[] = Object.freeze([
  '/full-crawl/index.html',
  '/full-crawl/links.html',
  '/full-crawl/technical.html',
  '/full-crawl/layout.html',
  '/full-crawl/control.html',
  '/full-crawl/missing.html',
  '/full-crawl/contrast.html',
  '/full-crawl/accessibility.html',
]);

/** 静的なサイトで、壊したページごとに出るべき Finding の ruleId（`fixtures/site/full-crawl/` の作り）。 */
export const STATIC_SITE_EXPECTED_RULE_IDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  '/full-crawl/links.html': ['BROKEN_INTERNAL_LINK'],
  '/full-crawl/missing.html': ['HTTP_4XX'],
  '/full-crawl/technical.html': ['IMAGE_LOAD_FAILED', 'PAGE_ERROR'],
  '/full-crawl/layout.html': ['DOCUMENT_HORIZONTAL_OVERFLOW'],
  '/full-crawl/contrast.html': ['COLOR_CONTRAST_VIOLATION'],
  '/full-crawl/accessibility.html': ['A11Y_BUTTON_NAME'],
});

// ---------------------------------------------------------------------------------------------------------------
// スクリプトでログインする SPA の管理画面
// ---------------------------------------------------------------------------------------------------------------

/**
 * 代表の SPA の振る舞い（実テスト環境の観察の形）: ログインの画面と管理画面のテナントの手続きの呼び出し（結果がなければ誤り）、一覧の手続きの呼び出し、
 * アプリの Origin への計測の送信、form のない会員の画面、会員の詳細の画面（READ の確かめ用。一覧からのリンクはない）。
 */
export const SPA_REPRESENTATIVE_OPTIONS: SpaAuthSiteOptions = Object.freeze({
  preLoginRpc: 'required',
  rpcReads: true,
  rumBeacon: true,
  memberScreenLayout: 'formless',
  memberDetailPage: true,
});

/** 代表の SPA に足す会員の名前（足した順に ID が 1 から振られる）。 */
export const SPA_REPRESENTATIVE_MEMBERS: readonly string[] = Object.freeze(['一覧花子', '一覧太郎']);

/** 代表の SPA の開始の URL の path（ログインの後の管理画面。利用者が入れる開始の URL）。 */
export const SPA_REPRESENTATIVE_START_PATH = SPA_APP_PATHS.admin;

/** 代表の SPA で、監査と発見が読むべき画面（管理画面からリンクでたどれる画面。ログアウトは読まないパス）。 */
export const SPA_EXPECTED_SCREENS: readonly string[] = Object.freeze([
  SPA_APP_PATHS.admin,
  SPA_APP_PATHS.memberNew,
  ...SPA_REPRESENTATIVE_MEMBERS.map((_name, index) => spaMemberEditPathOf(index + 1)),
]);

/** 代表の SPA で、読まないパスとして除かれるべき画面。 */
export const SPA_EXPECTED_EXCLUDED_SCREENS: readonly string[] = Object.freeze([SPA_APP_PATHS.logout]);

/**
 * 代表の SPA の、発見の probe の正解（画面の path → 送らずに観察した送り方の結果）。登録の画面の保存は `API_CREATE`、更新の画面の保存は `API_UPDATE`。
 * 更新の画面の削除のボタンは押さない（数えない）。
 */
export const SPA_EXPECTED_API_CANDIDATES: Readonly<Record<string, readonly ('API_CREATE' | 'API_UPDATE')[]>> = Object.freeze({
  [SPA_APP_PATHS.memberNew]: ['API_CREATE'],
  ...Object.fromEntries(SPA_REPRESENTATIVE_MEMBERS.map((_name, index) => [spaMemberEditPathOf(index + 1), ['API_UPDATE']])),
});

/** 代表の SPA の、READ の確かめの定義（画面の path の定義）と、その正解（どれも `MATCHED`）。 */
export const SPA_EXPECTED_READ_CHECKS = Object.freeze({
  list: Object.freeze({ id: 'read-list', path: SPA_APP_PATHS.admin, expected: 'MATCHED' }),
  detail: Object.freeze({ id: 'read-detail', path: spaMemberDetailPathOf(1), expected: 'MATCHED' }),
} as const);

// ---------------------------------------------------------------------------------------------------------------
// T44c: 代表の SPA に、実テスト環境の形を足したもの（設計書の履歴の「T44a の報告」の (1)）
// ---------------------------------------------------------------------------------------------------------------

/**
 * T44c: 代表の SPA（`SPA_REPRESENTATIVE_OPTIONS`）に、実テスト環境で多かった形を足した振る舞い。
 * - 登録の画面: 欄と保存のボタンが閉じたダイアログの中にあり、開くボタンの後に見える（`createSaveInDialog`）。
 * - 更新の画面: 先頭に多くの文字のないボタン、保存の後に登録・更新の語の道具のボタン、最後に見えないボタン（`crowdedEditScreen`。押す回数の上限を使い切る形）。
 * - 管理画面: 一覧の表が内側のスクロールの領域の中（`innerScrollList`。`INNER_SCROLL_CONTAINER_NOT_TRAVERSED` になる形）、一覧の後のサービスへの読み取り
 *   （`serviceReadOnList`。幅の走査の読み込みでも出る）、閉じるときの計測の送信（`closingBeacon`）。
 * 画面・API の候補・READ の確かめの正解は、代表の SPA と同じ（`SPA_EXPECTED_SCREENS`・`SPA_EXPECTED_API_CANDIDATES`・`SPA_EXPECTED_READ_CHECKS`）。
 */
export const SPA_REAL_ENV_SHAPE_OPTIONS: SpaAuthSiteOptions = Object.freeze({
  ...SPA_REPRESENTATIVE_OPTIONS,
  createSaveInDialog: true,
  crowdedEditScreen: true,
  innerScrollList: true,
  serviceReadOnList: true,
  closingBeacon: true,
});

/**
 * T44c: 実テスト環境の形の SPA の、probe の正解（fixture の作りから決めた数。更新の画面ごと）。押す回数は 1 画面 3 回（`MAX_SUBMISSION_PROBE_PRESSES_PER_PAGE`）。
 * - 見えないボタン（`SPA_HIDDEN_PRESS_TARGET_WORDS`）は、押す数を数える前に除く（`TARGET_NOT_FOUND`）。
 * - 押すのは、保存（`API_UPDATE`）と、その後の道具のボタンの 2 つ（`NO_REQUEST`）。残りの道具のボタンは、押す数の上限で押せなかった登録・更新の語の候補
 *   （`PRESS_LIMIT_REACHED`）。文字のないボタンも `PRESS_LIMIT_REACHED`（登録・更新の語ではない）。
 */
export const SPA_REAL_ENV_EXPECTED_EDIT_SCREEN_PROBES = Object.freeze({
  targetNotFound: SPA_HIDDEN_PRESS_TARGET_WORDS.length,
  noRequest: 2,
  priorityPressLimitReached: SPA_TOOLBAR_PRESS_WORDS.length - 2,
  otherPressLimitReached: SPA_CROWDED_ICON_BUTTON_COUNT,
} as const);

/** T44c: 実テスト環境の形の SPA の、登録の画面の probe の正解（開くボタンは `NO_REQUEST`、ダイアログの中の保存は `API_CREATE`）。 */
export const SPA_REAL_ENV_EXPECTED_CREATE_SCREEN_PROBES = Object.freeze({ noRequest: 1, apiCreate: 1 } as const);

/** T44c: 実テスト環境の形の SPA で、監査が `INNER_SCROLL_CONTAINER_NOT_TRAVERSED` になるべき画面（一覧の表が内側のスクロールの領域の中）。 */
export const SPA_REAL_ENV_EXPECTED_INNER_SCROLL_PAGES: readonly string[] = Object.freeze([SPA_APP_PATHS.admin]);
