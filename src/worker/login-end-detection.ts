/**
 * 手動のログインの段で、ログインが済んだことを BeakSight が判定する部品（OP-1。設計書 `doc/design/2026-10-27-beaksight-one-pass-flow-design.md` 4.1 の D3。DEF-181）。
 * 手動のログインの段（`authenticated-login.ts`）だけが使う。ページを操作しない（押さない・入れない）。欄の値を読まない。読み込みも要求も足さない（isolated
 * world の CDP の命令と、Context の状態の読み取りだけ）。
 *
 * - 成功の条件があるか（`hasSuccessCondition`）: 成功の画面の path が空でないか、セレクタがある。空の条件（開始の URL がログインの画面や `/` のときの案）は、
 *   どの画面にも当たるので、それだけでは成功にしない（DEF-181 の実行時の守り）。
 * - 成功の条件がないときの判定（`detectsLoginEnd`）は、次の 2 つがそろったときだけ成功にする。
 *   1. ログインの画面を離れた（`hasLeftLoginPage`）: main frame が許可 Origin で、path がセッションの切れの path（`sessionLostPathPrefixOf`）の外にあり、
 *      見えるパスワードの欄がない（入口の確かめと同じ検出の部品 `readLoginFormFields` の `password.candidates`。入口の確かめの「ログインの画面に見える」と
 *      同じ数え方）。読めなければ離れていないとみなす。
 *   2. 新しい状態の名前が増えた（`hasNewStateNames`）: ログインの画面を開いたときの状態の名前（`stateNameKeysOf`。Cookie の domain と名前、ローカル
 *      ストレージと IndexedDB の Origin と名前。値は持たない）にない名前が、今の状態にある。
 * - 状態の名前は、このワーカーのメモリの中だけに置く（記録・IPC・ログに出さない）。
 */
import type { Page } from 'playwright';
import type { AuthSetup } from '../control/auth/auth-setup-contracts.js';
import { isEmptySuccessCondition, sessionLostPathPrefixOf } from '../control/auth/auth-setup-policy.js';
import type { AuthenticatedState } from '../control/auth/authenticated-state.js';
import { isSuccessPathPrefix } from '../control/worker-protocol.js';
import { isOriginInAllowedOrigins } from '../crawl/normalize-url.js';
import { readLoginFormFields } from './entry-check-page.js';

/** 認証の設定に、成功の条件があるか（path が空でないか、セレクタがある）。 */
export const hasSuccessCondition = (setup: AuthSetup): boolean => !isEmptySuccessCondition(setup);

/** 状態の名前の印の区切り（名前に入りうる文字と重ならない、制御の文字）。 */
const KEY_SEPARATOR = '\u0000';

/** 絞った状態の、名前の印の集まり（値は持たない。状態がなければ空）。 */
export const stateNameKeysOf = (state: AuthenticatedState | null): ReadonlySet<string> => {
  if (state === null) {
    return new Set();
  }
  return new Set([
    ...state.cookies.map(({ domain, name }) => ['cookie', domain, name].join(KEY_SEPARATOR)),
    ...state.origins.flatMap(({ origin, localStorage, indexedDB }) => [
      ...localStorage.map(({ name }) => ['localStorage', origin, name].join(KEY_SEPARATOR)),
      ...(indexedDB ?? []).map(({ name }) => ['indexedDB', origin, name].join(KEY_SEPARATOR)),
    ]),
  ]);
};

/** 今の名前に、始めになかった名前があるか。 */
export const hasNewStateNames = (baseline: ReadonlySet<string>, current: ReadonlySet<string>): boolean =>
  [...current].some((key) => !baseline.has(key));

const parsedUrl = (value: string): URL | null => {
  try {
    return new URL(value);
  } catch {
    return null;
  }
};

/**
 * OP-1（D3。成功の画面の path を観察から決める）: 成功の画面の URL の path の、区切りごとの前方のうち、ログインの画面の path にもセッションの切れの path にも
 * 文字列の前方で当たらない、いちばん短いもの（`/admin` の形。認証の設定の検証の「成功の条件がログインの画面に当たらない」と同じ比べ）。許可の形
 * （`isSuccessPathPrefix`。値に見える区切りを含まない）でなければ、または最後の区切りまで当たるなら `null`。
 */
export const successPathPrefixOf = (url: string, setup: AuthSetup): string | null => {
  const parsed = parsedUrl(url);
  const login = parsedUrl(setup.loginStartUrl);
  if (parsed === null || login === null) {
    return null;
  }
  const sessionLostPath = sessionLostPathPrefixOf(setup);
  const segments = parsed.pathname.split('/').slice(1).filter((segment) => segment.length > 0);
  for (let count = 1; count <= segments.length; count += 1) {
    const prefix = `/${segments.slice(0, count).join('/')}`;
    if (!isSuccessPathPrefix(prefix)) {
      return null;
    }
    if (!login.pathname.startsWith(prefix) && !sessionLostPath.startsWith(prefix) && !prefix.startsWith(sessionLostPath)) {
      return prefix;
    }
  }
  return null;
};

/**
 * page がログインの画面を離れたか（ファイルの先頭の 1）。許可 Origin で、path がセッションの切れの path の外にあり、見えるパスワードの欄がない。読めなければ偽。
 */
export const hasLeftLoginPage = async (page: Page, setup: AuthSetup, approvedTestOrigins: readonly string[]): Promise<boolean> => {
  if (page.isClosed()) {
    return false;
  }
  const url = parsedUrl(page.url());
  if (url === null || !isOriginInAllowedOrigins(approvedTestOrigins, url.origin) || url.pathname.startsWith(sessionLostPathPrefixOf(setup))) {
    return false;
  }
  const reading = await readLoginFormFields(page);
  return reading !== null && reading.fields.password.candidates === 0;
};
