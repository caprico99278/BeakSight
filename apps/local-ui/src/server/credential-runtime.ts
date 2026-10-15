/**
 * 画面のサーバの資格情報のファイルの部品と、起動のときの準備（Task 26 の設計書 4.1 の「起動のとき」、4.2、変更履歴の「Blocker: T26d-2」。T26e）。
 * サーバだけで使う（ブラウザのバンドルに入らない。`process.platform` を読むのは、このファイルだけ）。
 * - 資格情報のファイルの部品は、この process に 1 つだけ作る（`createCredentialStore(<リポジトリの root>)`）。ジョブの管理（`audit-jobs.ts`）にも
 *   同じ部品を渡す（書くのは画面のサーバだけ。部品の中で、変更は 1 つずつ行う）。
 * - 起動のときの準備（`prepareLocalUiCredentials`）: 資格情報のフォルダに残った書きかけの一時のファイルを消し、暗号化の往復を 1 回確かめる
 *   （`src/control/credentials/credential-preparation.ts` の `prepareCredentialStorage`。`npm run setup:local` と同じ関数を使う。CCX-5）。
 *   結果（使える・使えない・Windows でない）を覚え、環境の状態と資格情報の画面に出す。値は出さない。使えなくても起動は止めない。
 *   本番の起動の部品は待ち受けの前に呼ぶ。開発のサーバでは、最初に要るときに 1 回だけ行う。
 * - Windows でないかの判定は、ここ（サーバの関数）で行い、結果だけを画面に渡す。比べる値は `credential-platform.ts` の `CREDENTIAL_PLATFORM`。資格情報の保存は、Windows でなければここで拒む（ファイルの部品も
 *   `CREDENTIAL_PLATFORM_UNSUPPORTED` で拒む）。
 */
import { join } from 'node:path';
import { CREDENTIAL_PLATFORM } from '../../../../src/control/credentials/credential-platform.js';
import { prepareCredentialStorage } from '../../../../src/control/credentials/credential-preparation.js';
import {
  createCredentialStore,
  type CredentialProtectionState,
  type CredentialStore,
} from '../../../../src/control/credentials/credential-store.js';
import { localUiRepositoryRoot } from './control-store';

/** 資格情報の暗号化を、この環境で使えるか（閉じた一覧。表示は `CREDENTIAL_ENVIRONMENT_CATALOG`）。 */
export const CREDENTIAL_ENVIRONMENT_STATES = Object.freeze(['AVAILABLE', 'UNAVAILABLE', 'NOT_WINDOWS'] as const);
export type CredentialEnvironmentState = (typeof CREDENTIAL_ENVIRONMENT_STATES)[number];

/** 暗号化が使える状態。 */
const PROTECTION_AVAILABLE = 'AVAILABLE' satisfies CredentialProtectionState;

/** 起動のときの準備の結果（値を持たない）。 */
export interface LocalUiCredentialPreparation {
  readonly state: CredentialEnvironmentState;
  /** 消した一時のファイルの数（フォルダを読めなかったときは `null`）。 */
  readonly removedTemporaryFiles: number | null;
}

let store: CredentialStore | null = null;
let preparation: Promise<LocalUiCredentialPreparation> | null = null;

/** この process の資格情報のファイルの部品の根（リポジトリの root。ジョブの管理の `credentials.root` にも渡す）。 */
export const localUiCredentialRoot = (): string => join(localUiRepositoryRoot());

/** この process の資格情報のファイルの部品（最初に使うときに作る）。 */
export const localUiCredentialStore = (): CredentialStore => {
  store ??= createCredentialStore(localUiCredentialRoot());
  return store;
};

/** 資格情報を保存できるプラットフォームか（サーバの判定）。 */
export const isCredentialPlatformSupported = (): boolean => process.platform === CREDENTIAL_PLATFORM;

/** プラットフォームと暗号化の往復の確かめから、環境の状態を決める。 */
export const credentialEnvironmentStateOf = (
  platformSupported: boolean,
  protection: CredentialProtectionState,
): CredentialEnvironmentState => {
  if (!platformSupported) {
    return 'NOT_WINDOWS';
  }
  return protection === PROTECTION_AVAILABLE ? 'AVAILABLE' : 'UNAVAILABLE';
};

const prepare = async (): Promise<LocalUiCredentialPreparation> => {
  const { protection, removedTemporaryFiles } = await prepareCredentialStorage(localUiCredentialStore());
  return Object.freeze({ state: credentialEnvironmentStateOf(isCredentialPlatformSupported(), protection), removedTemporaryFiles });
};

/** 起動のときの準備（1 回だけ行い、結果を覚える。2 回目からは同じ結果）。例外を投げない。 */
export const prepareLocalUiCredentials = (): Promise<LocalUiCredentialPreparation> => {
  preparation ??= prepare();
  return preparation;
};

/** 資格情報の暗号化を、この環境で使えるか（起動のときの準備の結果）。 */
export const localUiCredentialEnvironment = async (): Promise<CredentialEnvironmentState> => (await prepareLocalUiCredentials()).state;

/** 開始の前の確かめ（画面の表示の補助）に渡す、暗号化の状態。 */
export const protectionStateOf = (state: CredentialEnvironmentState): CredentialProtectionState =>
  state === 'AVAILABLE' ? PROTECTION_AVAILABLE : 'UNAVAILABLE';
