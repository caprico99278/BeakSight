/**
 * MI-F1（設計書 `doc/design/2026-10-26-beaksight-minimal-input-ux-design.md` 4.7.1 の 1・2・4）: 画面のテストの準備で、プロファイルを管理データの保存の部品で直接
 * 作る・更新する補助（テストだけの操作）。
 * - 画面のサーバの口（`createProfileFn`・`updateProfileFn`）は、承認したサービスの Origin を足す保存と、作成・編集で自動ログインにする保存を拒む（自動ログインへは
 *   「次から自動でログインする」の切り替えだけで入り、承認したサービスの Origin は手動のログインの観察だけが足す）。この守りは口に置き、保存の部品の層には置かない
 *   （観察からの登録・切り替え・テストの準備も使うため）。そこで、手動のログインの観察と切り替えの後の、今ある形のプロファイル（設計書 4.4: そのまま動く）を、
 *   テストの準備ではここから作る。保存の部品の層の守り（自動ログインのプロファイルの送信先を変えない）は、ここでもかかる。
 * - 対象の設定は、一時の root のプロファイルが指すファイルを、今の読み込みの部品（`loadConfig`）で読む。画面のサーバが開いている管理データを、同じ場所で開く。
 */
import { loadConfig } from '../../../../src/config/load-config.js';
import { saveAuthSetup, type AuthSetupStoreResult } from '../../../../src/control/store/auth-setup-store.js';
import { closeControlDatabase, openControlDatabase } from '../../../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../../../src/control/store/database-path.js';
import { saveProfileAndAuthSetup, type ProfileAndAuthSetupSaveResult } from '../../../../src/control/store/profile-auth-setup-store.js';
import { createProfile, getProfile, updateProfile, type ProfileStoreResult } from '../../../../src/control/store/profile-store.js';
import { switchToWriteMode, type WriteModeSwitchResultView } from '../../src/server/write-mode-switch';

/** プロファイルの文書の、対象の設定のパス（文字列でなければ止める。テストの書き誤り）。 */
const profileTargetConfigPathOf = (profile: Readonly<Record<string, unknown>>): string => {
  const path = profile['targetConfigPath'];
  if (typeof path !== 'string') {
    throw new Error('the profile of the test has no targetConfigPath');
  }
  return path;
};

/** 一時の root の管理データで、保存の部品を 1 回呼ぶ（対象の設定は、プロファイルが指すファイルを読む）。 */
const withStore = async <TResult>(
  root: string,
  profile: Readonly<Record<string, unknown>>,
  write: (database: ReturnType<typeof openControlDatabase>, resolveContext: (path: string) => { readonly targetConfig: Awaited<ReturnType<typeof loadConfig>> } | undefined) => TResult,
): Promise<TResult> => {
  const path = profileTargetConfigPathOf(profile);
  const targetConfig = await loadConfig(`${root}/${path}`);
  const database = openControlDatabase(resolveControlDatabasePath(root));
  try {
    return write(database, (requested) => (requested === path ? { targetConfig } : undefined));
  } finally {
    closeControlDatabase(database);
  }
};

/** プロファイルを、保存の部品で直接作る（テストの準備。結果は `createProfile` のまま）。 */
export const createProfileInStore = (root: string, profile: Readonly<Record<string, unknown>>): Promise<ProfileStoreResult> =>
  withStore(root, profile, (database, resolveContext) => createProfile(database, profile, { resolveContext }));

/** プロファイルを、保存の部品で直接次の改訂に更新する（テストの準備。結果は `updateProfile` のまま）。 */
export const updateProfileInStore = (root: string, profile: Readonly<Record<string, unknown>>, expectedRevision: number): Promise<ProfileStoreResult> =>
  withStore(root, profile, (database, resolveContext) => updateProfile(database, { profile, expectedRevision }, { resolveContext }));

/**
 * MI-F5（設計書 4.7.1 の 6）: 認証の設定を、保存の部品（`saveAuthSetup`）で直接保存する（テストの準備。結果は `saveAuthSetup` のまま）。画面の認証の設定の保存
 * （`saveAuthSetupFn`）は、方式によらず送信先（token の送信先、ログインに伴う送信、フォームの送信先など）を変える保存と、入口の確かめの案と違う送信先の最初の
 * 保存を拒む（送信先は、入口の確かめと手動のログインの観察からだけ入る）。そこで、手動のログインの観察の後の、今ある形の認証の設定は、テストの準備ではここから
 * 保存する。保存の部品の層の守り（自動ログインのプロファイルの送信先を変えない）は、ここでもかかる。対象の設定は、管理データのプロファイルが指すファイルを読む。
 */
export const saveAuthSetupInStore = async (root: string, setup: Readonly<Record<string, unknown>>): Promise<AuthSetupStoreResult> => {
  const profileId = setup['profileId'];
  const database = openControlDatabase(resolveControlDatabasePath(root));
  let profile: Readonly<Record<string, unknown>>;
  try {
    const stored = typeof profileId === 'string' ? getProfile(database, profileId) : null;
    if (stored === null) {
      throw new Error('the auth setup of the test has no stored profile');
    }
    profile = stored.profile as unknown as Readonly<Record<string, unknown>>;
  } finally {
    closeControlDatabase(database);
  }
  return withStore(root, profile, (store, resolveContext) => saveAuthSetup(store, setup, { resolveContext }));
};

/**
 * MI-F5: \`saveAuthSetupInStore\` を、画面の保存（\`saveAuthSetupFn\`）の入力の形（\`{ setup }\`）で呼ぶ（テストの準備の呼び出しを、入力の形を変えずに置き換えるため）。
 * \`root\` は一時の root（\`TemporaryUiRoot\`）か、そのフォルダ。
 */
export const saveAuthSetupRequestInStore = (
  root: string | { readonly root: string } | undefined,
  request: { readonly setup: Readonly<Record<string, unknown>> },
): Promise<AuthSetupStoreResult> => {
  if (root === undefined) {
    throw new Error('一時の root がない');
  }
  return saveAuthSetupInStore(typeof root === 'string' ? root : root.root, request.setup);
};

/**
 * プロファイルの次の改訂と認証の設定を、保存の部品（`saveProfileAndAuthSetup`）で直接まとめて保存する（テストの準備。手動のログインのプロファイルを、送信先を
 * 変えた設定で自動ログインに戻す、切り替えと同じ形の保存に使う。結果は `saveProfileAndAuthSetup` のまま）。
 */
export const saveProfileAndAuthSetupInStore = (
  root: string,
  profile: Readonly<Record<string, unknown>>,
  expectedRevision: number,
  setup: Readonly<Record<string, unknown>>,
): Promise<ProfileAndAuthSetupSaveResult> =>
  withStore(root, profile, (database, resolveContext) => saveProfileAndAuthSetup(database, { profile, expectedRevision, setup }, { resolveContext }));

/**
 * OP-3（設計書 `doc/design/2026-10-27-beaksight-one-pass-flow-design.md` 4.1 の D7'）: 書き込みのモードへの切り替えの部品（`switchToWriteMode`。一覧のチェックの
 * 保存が中で使う）を、管理データで直接呼ぶ（テストの準備。前の Server Function `switchToWriteModeFn` は使い先がなくなったので消した）。結果は部品のまま。
 * 隔離の参照は渡さない（チェックの保存と同じ、保存の日の「確かめていない」の参照）。
 */
export const switchToWriteModeInStore = async (root: string, profileId: string, expectedRevision: number): Promise<WriteModeSwitchResultView> => {
  const database = openControlDatabase(resolveControlDatabasePath(root));
  let profile: Readonly<Record<string, unknown>> | null;
  try {
    const stored = getProfile(database, profileId);
    profile = stored === null ? null : stored.profile as unknown as Readonly<Record<string, unknown>>;
  } finally {
    closeControlDatabase(database);
  }
  const deps = (store: ReturnType<typeof openControlDatabase>) => ({ database: store, now: () => new Date(), approvedScenarioCount: async () => 0 });
  if (profile === null) {
    const store = openControlDatabase(resolveControlDatabasePath(root));
    try {
      return switchToWriteMode(deps(store), { profileId, expectedRevision }, { resolveContext: () => undefined });
    } finally {
      closeControlDatabase(store);
    }
  }
  return withStore(root, profile, (store, resolveContext) => switchToWriteMode(deps(store), { profileId, expectedRevision }, { resolveContext }));
};

/**
 * PL-1（設計書 `doc/design/2026-10-26-beaksight-plain-ui-design.md` 2 章）: サイトの画面に改訂（何回目の変更か）と状態を出さなくなったので、画面のテストは
 * 管理データから読んで確かめる（テストだけの読み取り）。プロファイルがなければ `null`。
 */
export const readProfileInStore = (root: string | { readonly root: string } | undefined, profileId: string): ReturnType<typeof getProfile> => {
  if (root === undefined) {
    throw new Error('一時の root がない');
  }
  const database = openControlDatabase(resolveControlDatabasePath(typeof root === 'string' ? root : root.root));
  try {
    return getProfile(database, profileId);
  } finally {
    closeControlDatabase(database);
  }
};
