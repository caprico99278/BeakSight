// MI-F1（設計書 `doc/design/2026-10-26-beaksight-minimal-input-ux-design.md` 4.7.1。独立レビュー MI-R の Critical C-1・Important I-1）: 資格情報の送信先の
// 不変条件の判定の唯一の owner。純粋な部品（入出力を持たない）。
// - 1（承認したサービスの Origin を足すのは観察からだけ）・2（自動ログインへは切り替えだけで入る）: プロファイルの作成と編集の口（画面のサーバの Server
//   Function）が `profileSaveGuardRejectionOf` で判定する。保存の部品の層は、観察からの登録・切り替え・テストの準備も使うので、そこでは判定しない（4.7.1 の 4）。
// - 3（自動ログインのプロファイルでは、資格情報の送信先を変えない）: 管理データの保存の部品（プロファイルの更新、認証の設定の保存、まとめて保存）が、
//   トランザクションの中で「今保存してある値」と「保存の後の値」を `profileCredentialDestinationChangesOf`・`authSetupCredentialDestinationChangesOf` で比べ、
//   変わった送信先の項目が 1 つでもあれば `CREDENTIAL_DESTINATION_LOCKED` で拒む。保存の前も後も `AUTOMATED_LOGIN` のときだけ（切り替えと、手動へ戻すことは
//   当たらない）。
// - どの項目が送信先かは、下の表（`PROFILE_DESTINATION_CHANGED`・`AUTH_SETUP_DESTINATION_CHANGED`）の 1 か所だけに置く。表にない項目（読まないパス、読む範囲の
//   パス、成功の条件、セッションの切れの条件、失敗の条件、上限、監査の段の読み取りの手続きの呼び出し、モード、環境の証跡の参照など）は送信先でない。
// - Origin の比べは、URL の意味の owner の部品（`isOriginInAllowedOrigins`。GATE-ARCH04）で行う。
// - MI-F5（設計書 4.7.1 の 6・7。再レビュー MI-R2 の Critical C-A）: 6（ログインの送信先は、観察からだけ入る。方式によらない）は、3 と同じ表と同じ判定
//   （`authSetupCredentialDestinationChangesOf`）に、画面の保存の口が渡す選択肢（`observedOnly`）で当てる。選択肢があると、方式によらず比べ、比べる相手は、
//   今保存してある設定と、口が渡す観察の案（行から開いた下書きの保存の、行の観察を足した設定）。設定がまだない（最初の保存）ときは、口が渡す案（最後の入口の
//   確かめの案）か、送信先のない形（ログインの画面の URL だけを人が入れる形。`noDestinationBaselineOf`）。保存の部品は、この選択肢をトランザクションの中で
//   当て、変わった送信先の項目があれば `CREDENTIAL_DESTINATION_OBSERVED_ONLY` で拒む（3 が当たる自動ログインのプロファイルは、今どおり
//   `CREDENTIAL_DESTINATION_LOCKED`）。観察の口（自動の登録、表の行の「登録する」、入口の確かめの後の案の保存、切り替え、書き込みにも使う）とテストの準備は、
//   選択肢を渡さない（今どおり）。
import { isOriginInAllowedOrigins } from '../../crawl/normalize-url.js';
import { AUTOMATED_LOGIN_AUTH_STRATEGY, type AuthStrategy, type SiteProfile } from '../contracts.js';
import { SCRIPT_REQUEST_TRANSPORT, type AuthSetup, type LoginPostEndpoint, type LoginSideRequest, type ScriptLoginTarget } from './auth-setup-contracts.js';

/** 保存の部品が、自動ログインのプロファイルの送信先を変える保存を拒む理由（プロファイルの保存の部品と認証の設定の保存の部品の、両方の理由の一覧に入る）。 */
export const CREDENTIAL_DESTINATION_LOCKED_REASON = 'CREDENTIAL_DESTINATION_LOCKED';

/**
 * MI-F5（設計書 4.7.1 の 6）: 認証の設定の保存の部品が、画面の保存の口の選択肢（`observedOnly`）で、観察していない送信先の保存を拒む理由（3 が当たる自動ログインの
 * プロファイルを除く。認証の設定の保存の部品の理由の一覧に入る）。
 */
export const CREDENTIAL_DESTINATION_OBSERVED_ONLY_REASON = 'CREDENTIAL_DESTINATION_OBSERVED_ONLY';

/**
 * MI-C 項目 12: プロファイルの認証の方式が自動ログインか（自動ログインの文脈の、プロファイルの側の判定。MI-F1 で `manual-login-registration.ts` から移した）。
 */
export const isAutomatedLoginProfileAuth = (auth: AuthStrategy): boolean => auth === AUTOMATED_LOGIN_AUTH_STRATEGY;

/**
 * 今の一覧（`current`）に Origin として含まれない、新しく足す Origin（比べ方は許可 Origin と同じ `isOriginInAllowedOrigins`。足す一覧の中の重なりも 1 つに
 * する）。正規の直列化でない値は、含まれない（新しい）と扱う（拒む側に倒す）。MI-C 項目 12 の `newServiceOriginsOf` を MI-F1 で移し、承認したサービスの
 * Origin のほか、テスト環境の Origin・IdP の Origin にも使う名前にした。
 */
export const newOriginsOf = (current: readonly string[], add: readonly string[]): readonly string[] =>
  Object.freeze(add.filter((origin, index) => !isOriginInAllowedOrigins(current, origin) && !isOriginInAllowedOrigins(add.slice(0, index), origin)));

// ---------------------------------------------------------------------------------------------------------------
// 1・2: プロファイルの作成と編集の口の判定
// ---------------------------------------------------------------------------------------------------------------

/**
 * プロファイルの作成と編集の口が拒む理由（閉じた一覧）。
 * - `SERVICE_ORIGIN_ADD_NOT_OBSERVED`: 承認したサービスの Origin を、手動のログインの観察（自動の登録、表の行の「登録する」、ジョブの行に結びつく下書きからの
 *   保存）からでなく足そうとした（編集で足す、作成で持つ、下書きの保存でジョブの行の観察にない Origin を足す）。
 * - `AUTOMATED_LOGIN_SWITCH_REQUIRED`: 作成か編集で、認証の方式を自動ログインにしようとした（自動ログインへは、手でログインするサイトの 1 回目の点検で、手でのログインの値を BeakSight が受け取って切り替えるときだけ入る。OP-1）。
 */
export const PROFILE_SAVE_GUARD_REJECTIONS = Object.freeze(['SERVICE_ORIGIN_ADD_NOT_OBSERVED', 'AUTOMATED_LOGIN_SWITCH_REQUIRED'] as const);
export type ProfileSaveGuardRejection = (typeof PROFILE_SAVE_GUARD_REJECTIONS)[number];

/** 判定に使う、保存してあるプロファイルの項目（作成では `null`）。 */
export type ProfileSaveGuardBefore = Pick<SiteProfile, 'auth' | 'approvedServiceOrigins'> | null;

/** 入力のままの値の、文字列の一覧（形の誤りは保存の部品の検証に任せる。文字列でない値は数えない）。 */
const stringsOf = (value: unknown): readonly string[] =>
  (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);

/**
 * プロファイルの作成（`before` が `null`）と編集で、画面のサーバの口が拒む理由（なければ `null`）。`after` は入力のままの文書。
 * 1: 承認したサービスの Origin に、保存してある値にないものが 1 つでもあれば拒む（方式によらない。消すのは受ける）。
 * 2: 保存の後の方式が自動ログインで、保存の前が自動ログインでない（作成を含む）なら拒む。今ある自動ログインのプロファイルを方式を変えずに保存するのと、手動へ
 *    戻すのは受ける（送信先の変更は、保存の部品の層の 3 が拒む）。
 */
export const profileSaveGuardRejectionOf = (
  before: ProfileSaveGuardBefore,
  after: Readonly<Record<string, unknown>>,
): ProfileSaveGuardRejection | null => {
  if (newOriginsOf(before?.approvedServiceOrigins ?? [], stringsOf(after['approvedServiceOrigins'])).length > 0) {
    return 'SERVICE_ORIGIN_ADD_NOT_OBSERVED';
  }
  const afterAuth = after['auth'];
  if (typeof afterAuth === 'string' && isAutomatedLoginProfileAuth(afterAuth as AuthStrategy) && (before === null || !isAutomatedLoginProfileAuth(before.auth))) {
    return 'AUTOMATED_LOGIN_SWITCH_REQUIRED';
  }
  return null;
};

// ---------------------------------------------------------------------------------------------------------------
// 3: 自動ログインのプロファイルの、資格情報の送信先の項目
// ---------------------------------------------------------------------------------------------------------------

/**
 * 資格情報の送信先の項目（閉じた一覧。設計書 4.7.1 の 3）。プロファイルの項目と、認証の設定の項目。
 * - `TARGET_CONFIG`: 設定のファイル（許可 Origin とテスト環境の Origin の元）。`TEST_ORIGINS_ADDED`: テスト環境の Origin を足すこと。
 *   `SERVICE_ORIGINS_ADDED`: 承認したサービスの Origin を足すこと（消すのは受ける）。
 * - `LOGIN_START_URL`: ログインの画面の URL。`LOGIN_TRANSPORT`: ログインの送り方。`SCRIPT_LOGIN_TARGET`: token の送信先（Origin・path・必須の query。
 *   どれかが違えば変わった）。`LOGIN_SIDE_REQUESTS`: ログインに伴う送信の送信先（新しい送信先を足すこと、回数を増やすこと。消すこと・減らすことは受ける）。
 *   `LOGIN_POST_ENDPOINTS`: フォームの送信先（新しい送信先を足すこと。消すのは受ける）。`AUTOMATED_LOGIN_SELECTORS`: 自動ログインの 3 つのセレクタ
 *   （資格情報を入れる欄と送信のボタン。外すことは受ける）。`IDP_ORIGINS_ADDED`: IdP の Origin を足すこと。
 */
export const CREDENTIAL_DESTINATION_ITEMS = Object.freeze([
  'TARGET_CONFIG',
  'TEST_ORIGINS_ADDED',
  'SERVICE_ORIGINS_ADDED',
  'LOGIN_START_URL',
  'LOGIN_TRANSPORT',
  'SCRIPT_LOGIN_TARGET',
  'LOGIN_SIDE_REQUESTS',
  'LOGIN_POST_ENDPOINTS',
  'AUTOMATED_LOGIN_SELECTORS',
  'IDP_ORIGINS_ADDED',
] as const);
export type CredentialDestinationItem = (typeof CREDENTIAL_DESTINATION_ITEMS)[number];

/** 比べるプロファイルの項目。 */
export type CredentialDestinationProfile = Pick<SiteProfile, 'auth' | 'targetConfigPath' | 'approvedTestOrigins' | 'approvedServiceOrigins'>;

type ProfileDestinationItem = Extract<CredentialDestinationItem, 'TARGET_CONFIG' | 'TEST_ORIGINS_ADDED' | 'SERVICE_ORIGINS_ADDED'>;
type AuthSetupDestinationItem = Exclude<CredentialDestinationItem, ProfileDestinationItem>;

const sameOrigin = (left: string, right: string): boolean => isOriginInAllowedOrigins([left], right);

/** token の送信先が同じか（Origin・path・必須の query の組。query は順によらず、組の集まりが同じなら同じ）。 */
const sameScriptLogin = (before: ScriptLoginTarget | null, after: ScriptLoginTarget | null): boolean => {
  if (before === null || after === null) {
    return before === after;
  }
  const queryOf = (target: ScriptLoginTarget): readonly string[] => target.requiredQuery.map(({ name, value }) => JSON.stringify([name, value])).sort();
  return sameOrigin(before.origin, after.origin) && before.path === after.path && JSON.stringify(queryOf(before)) === JSON.stringify(queryOf(after));
};

/** 保存の後のログインに伴う送信が、どれも保存の前にある送信先（Origin・path・method が同じで、回数が増えていない）か。 */
const sideRequestsWithin = (before: readonly LoginSideRequest[], after: readonly LoginSideRequest[]): boolean =>
  after.every((side) => before.some((known) => sameOrigin(known.origin, side.origin) && known.path === side.path && known.method === side.method
    && side.maxPerLoginStage <= known.maxPerLoginStage));

/** 保存の後のフォームの送信先が、どれも保存の前にある送信先か。 */
const postEndpointsWithin = (before: readonly LoginPostEndpoint[], after: readonly LoginPostEndpoint[]): boolean =>
  after.every((endpoint) => before.some((known) => sameOrigin(known.origin, endpoint.origin) && known.path === endpoint.path));

/** 自動ログインの 3 つのセレクタ（なければ `null`）。 */
const selectorsOf = (setup: AuthSetup): string | null => (setup.automatedLogin === null
  ? null
  : JSON.stringify([setup.automatedLogin.usernameSelector, setup.automatedLogin.passwordSelector, setup.automatedLogin.submitSelector]));

/** プロファイルの送信先の項目ごとの「変わった」の判定（表。送信先の項目の唯一の一覧の半分）。 */
const PROFILE_DESTINATION_CHANGED: Readonly<Record<ProfileDestinationItem, (before: CredentialDestinationProfile, after: CredentialDestinationProfile) => boolean>> =
  Object.freeze({
    TARGET_CONFIG: (before, after) => before.targetConfigPath !== after.targetConfigPath,
    TEST_ORIGINS_ADDED: (before, after) => newOriginsOf(before.approvedTestOrigins, after.approvedTestOrigins).length > 0,
    SERVICE_ORIGINS_ADDED: (before, after) => newOriginsOf(before.approvedServiceOrigins ?? [], after.approvedServiceOrigins ?? []).length > 0,
  });

/** 認証の設定の送信先の項目ごとの「変わった」の判定（表。送信先の項目の唯一の一覧の残りの半分）。 */
const AUTH_SETUP_DESTINATION_CHANGED: Readonly<Record<AuthSetupDestinationItem, (before: AuthSetup, after: AuthSetup) => boolean>> = Object.freeze({
  LOGIN_START_URL: (before, after) => before.loginStartUrl !== after.loginStartUrl,
  LOGIN_TRANSPORT: (before, after) => before.loginTransport !== after.loginTransport,
  SCRIPT_LOGIN_TARGET: (before, after) => !sameScriptLogin(before.scriptLogin, after.scriptLogin),
  LOGIN_SIDE_REQUESTS: (before, after) => !sideRequestsWithin(before.loginSideRequests, after.loginSideRequests),
  LOGIN_POST_ENDPOINTS: (before, after) => !postEndpointsWithin(before.loginPostEndpoints, after.loginPostEndpoints),
  // MI-F5: 自動ログインの設定を外す（手動のログインへ戻す）のは受ける（資格情報を入れる欄がなくなる。ほかの送信先の「消すのは受ける」と同じ）。
  AUTOMATED_LOGIN_SELECTORS: (before, after) => selectorsOf(after) !== null && selectorsOf(before) !== selectorsOf(after),
  IDP_ORIGINS_ADDED: (before, after) => newOriginsOf(before.allowedIdpOrigins, after.allowedIdpOrigins).length > 0,
});

/** 送信先を変えない決まりが当たるか（保存の前も後も、認証の方式が自動ログイン）。 */
export const isCredentialDestinationLocked = (beforeAuth: AuthStrategy, afterAuth: AuthStrategy): boolean =>
  isAutomatedLoginProfileAuth(beforeAuth) && isAutomatedLoginProfileAuth(afterAuth);

const changedItemsOf = <Item extends string, T>(table: Readonly<Record<Item, (before: T, after: T) => boolean>>, before: T, after: T): readonly Item[] =>
  Object.freeze((Object.keys(table) as Item[]).filter((item) => table[item](before, after)));

/** プロファイルの保存で変わる送信先の項目（決まりが当たらなければ空）。 */
export const profileCredentialDestinationChangesOf = (
  before: CredentialDestinationProfile,
  after: CredentialDestinationProfile,
): readonly CredentialDestinationItem[] =>
  (isCredentialDestinationLocked(before.auth, after.auth) ? changedItemsOf(PROFILE_DESTINATION_CHANGED, before, after) : Object.freeze([]));

/**
 * MI-F5（設計書 4.7.1 の 6）: 画面の保存の口が渡す選択肢。`baselines` は、今保存してある設定のほかに受ける送信先の案（行の観察を足した設定、最初の保存の入口の
 * 確かめの案）。送信先の項目だけを比べる（ほかの欄は問わない）。
 */
export interface ObservedDestinationsOnly {
  readonly baselines: readonly AuthSetup[];
}

/**
 * MI-F5: 送信先のない形（最初の保存で、入口の確かめの案がなくても受ける形）。ログインの画面の URL は人が入れた値のまま（許可 Origin の中かは保存の検証）、
 * 送り方はスクリプトの送信で、token の送信先・ログインに伴う送信・フォームの送信先・自動ログインのセレクタ・IdP の Origin がない（token の送信先などは、手動の
 * ログインの観察が入れる）。
 */
const noDestinationBaselineOf = (after: AuthSetup): AuthSetup => ({
  ...after,
  loginTransport: SCRIPT_REQUEST_TRANSPORT,
  scriptLogin: null,
  loginSideRequests: [],
  loginPostEndpoints: [],
  automatedLogin: null,
  allowedIdpOrigins: [],
});

/** MI-F5: 案にログインの画面の URL がない（入口の確かめで伏せた path だった）ときは、人が入れたログインの画面の URL と比べる（受ける）。 */
const withEnteredLoginStartUrl = (baseline: AuthSetup, after: AuthSetup): AuthSetup =>
  (baseline.loginStartUrl.length === 0 ? { ...baseline, loginStartUrl: after.loginStartUrl } : baseline);

/**
 * 認証の設定の保存で変わる送信先の項目（決まりが当たらなければ空）。`beforeAuth`・`afterAuth` は、保存の前と後のプロファイルの認証の方式。
 * - 選択肢（`observedOnly`）がないとき（3）: 保存の前も後も自動ログインのときだけ、保存してある設定と比べる。保存してある設定がない（`before` が `null`）ときは、
 *   比べる今の値がないので空（観察の口とテストの準備。画面の道では、MI-F5 の選択肢が最初の保存を確かめる）。
 * - 選択肢があるとき（MI-F5。6）: 方式によらず、比べる相手（設定があれば、それと `baselines`。なければ `baselines` と送信先のない形）のどれかと送信先の項目が
 *   同じなら空。どれとも違えば、最初の相手と比べて変わった項目。
 */
export const authSetupCredentialDestinationChangesOf = (input: {
  readonly beforeAuth: AuthStrategy;
  readonly afterAuth: AuthStrategy;
  readonly before: AuthSetup | null;
  readonly after: AuthSetup;
  readonly observedOnly?: ObservedDestinationsOnly;
}): readonly CredentialDestinationItem[] => {
  const { before, after, observedOnly } = input;
  if (observedOnly === undefined) {
    return before === null || !isCredentialDestinationLocked(input.beforeAuth, input.afterAuth)
      ? Object.freeze([])
      : changedItemsOf(AUTH_SETUP_DESTINATION_CHANGED, before, after);
  }
  const candidates: readonly AuthSetup[] = before === null
    ? [...observedOnly.baselines.map((baseline) => withEnteredLoginStartUrl(baseline, after)), noDestinationBaselineOf(after)]
    : [before, ...observedOnly.baselines];
  const changes = candidates.map((candidate) => changedItemsOf(AUTH_SETUP_DESTINATION_CHANGED, candidate, after));
  return changes.some((changed) => changed.length === 0) ? Object.freeze([]) : changes[0] ?? Object.freeze([]);
};
