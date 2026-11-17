/**
 * FM-1（設計書 `doc/design/2026-10-19-beaksight-fewer-manual-steps-design.md` の 2.2 の画面）: プロファイルの表示の設定（ジョブのブラウザを表示する。既定は
 * 表示。AS-b から、監査の段の送信の扱いも。既定は読み取りだけ）を読む・保存する Server Function。保存の口は管理データの部品（`readProfileDisplaySettings`・`saveProfileDisplaySettings`。FM-2）で、承認に結ばれる
 * プロファイルの文書・改訂とは別に持つ（切り替えても、プロファイルの改訂と承認は変わらない）。保存は POST だけ（CSRF は画面のサーバの middleware）。
 */
import { createServerFn } from '@tanstack/react-start';
import {
  readProfileDisplayNames,
  readProfileDisplaySettings,
  saveProfileDisplayName,
  saveProfileDisplaySettings,
  type ProfileDisplayNameSaveResult,
  type ProfileDisplaySettings,
  type ProfileDisplaySettingsSaveResult,
} from '../../../../src/control/store/profile-store.js';
import { localUiStore } from './control-store';
import { requestOf } from './request-validation';

interface ProfileKeyRequest {
  readonly profileId: string;
}

/** 保存の入力（AS-b: 監査の段の送信の扱いは任意。省略は今の値を変えない）。 */
interface DisplaySettingsSaveRequest extends ProfileKeyRequest {
  readonly showJobBrowser: boolean;
  readonly auditSendPolicy?: ProfileDisplaySettings['auditSendPolicy'];
}

/** プロファイルの表示の設定（行がなければ既定。プロファイルがなくても既定）。 */
export const profileDisplaySettingsFn = createServerFn({ method: 'GET' })
  .validator(requestOf<ProfileKeyRequest>('ui-profile-key'))
  .handler(({ data }): ProfileDisplaySettings => readProfileDisplaySettings(localUiStore(), data.profileId));

/** プロファイルの表示の設定を保存する。 */
export const saveProfileDisplaySettingsFn = createServerFn({ method: 'POST' })
  .validator(requestOf<DisplaySettingsSaveRequest>('ui-profile-display-settings'))
  .handler(({ data }): ProfileDisplaySettingsSaveResult =>
    saveProfileDisplaySettings(localUiStore(), data.profileId, {
      showJobBrowser: data.showJobBrowser,
      ...(data.auditSendPolicy === undefined ? {} : { auditSendPolicy: data.auditSendPolicy }),
    }));

/** DN-1: 画面に出す名前の保存の入力。 */
interface DisplayNameSaveRequest extends ProfileKeyRequest {
  readonly displayName: string;
}

/**
 * DN-1（設計書 `2026-11-16-beaksight-profile-display-name-design.md` 2 章）: 画面に出す名前のあるサイトの、ID と名前の組。根の route の loader が読み、
 * 画面の名前の決め方（`display/site-name.ts` の `siteNameOf`）に渡す。
 */
export const siteNamesFn = createServerFn({ method: 'GET' }).handler((): Readonly<Record<string, string>> => readProfileDisplayNames(localUiStore()));

/** DN-1: 画面に出す名前を保存する（決まりと拒む理由は管理データの部品 `saveProfileDisplayName`）。 */
export const saveProfileDisplayNameFn = createServerFn({ method: 'POST' })
  .validator(requestOf<DisplayNameSaveRequest>('ui-profile-display-name'))
  .handler(({ data }): ProfileDisplayNameSaveResult => saveProfileDisplayName(localUiStore(), data.profileId, data.displayName));
