/**
 * MI-F3 項目 6: 資格情報の処理（`credential-service.ts`）の、本番の基本の部品（管理データ、資格情報のファイルの部品、ジョブの管理、サーバの判定、時刻）の組み立ての
 * 1 か所。サーバだけで使う。
 * - 資格情報の画面の Server Functions（`credential-functions.ts` の `localUiCredentialServiceDependencies`）は、これに画面だけが使う部品（承認が外れるシナリオの
 *   数、入口の確かめの欄の案）を足す。
 * - 起動の部品の入口（`launcher-bridge.ts`）の、使えないプロファイルの取り消しの後の資格情報の片付けは、これを直接使う（Server Function を定義するファイルを
 *   起動の部品の入口から読むと、ビルドの Server Function の表が画面のサーバの入口の外へ移るため）。
 */
import { localUiAuditJobs } from './audit-jobs';
import { localUiStore } from './control-store';
import type { CredentialServiceDependencies } from './credential-service';
import { isCredentialPlatformSupported, localUiCredentialEnvironment, localUiCredentialStore } from './credential-runtime';

/** 資格情報の処理の、本番の基本の部品。 */
export const localUiCredentialBaseDependencies = (): CredentialServiceDependencies => ({
  database: localUiStore(),
  store: localUiCredentialStore(),
  checkCredentialChange: (profileId) => localUiAuditJobs().checkCredentialChange(profileId),
  platformSupported: isCredentialPlatformSupported,
  environment: localUiCredentialEnvironment,
  now: () => new Date(),
});
