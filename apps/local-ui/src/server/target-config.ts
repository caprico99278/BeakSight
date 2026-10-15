/**
 * プロファイルが指すターゲット設定（JSON）を、既存の `loadConfig` で読む（T23f で作り、T24f でプロファイル・監査のジョブ・成果物の共用にした）。
 * - `isAcceptedTargetConfigPath` を通ったパスだけを読む（通らないパスでは、ファイルを読まない）。設定の検証の owner を写さない。
 * - パスはリポジトリの root（`localUiRepositoryRoot`）から解決する。監査のワーカーも、cwd をリポジトリの root にして同じファイルを読む。
 */
import { join } from 'node:path';
import type { ConfigErrorKind } from '../../../../src/config/config-error.js';
import { isConfigError } from '../../../../src/config/config-error.js';
import { loadConfig } from '../../../../src/config/load-config.js';
import { isAcceptedTargetConfigPath, type ProfileValidationContext } from '../../../../src/control/profile-policy.js';
import { localUiRepositoryRoot } from './control-store';

/** 読んだ結果（読めなければ文脈なしと、設定の誤りの種類。パスを受けない場合は、どちらもなし）。 */
export interface TargetContextReading {
  readonly context: ProfileValidationContext | undefined;
  readonly configError: ConfigErrorKind | null;
}

/** 設定の文脈を読む（受けるパスだけ）。設定の誤りでない失敗は、そのまま投げる。 */
export const loadTargetContext = async (targetConfigPath: unknown): Promise<TargetContextReading> => {
  if (typeof targetConfigPath !== 'string' || !isAcceptedTargetConfigPath(targetConfigPath)) {
    return { context: undefined, configError: null };
  }
  try {
    const targetConfig = await loadConfig(join(localUiRepositoryRoot(), targetConfigPath));
    return { context: { targetConfig }, configError: null };
  } catch (error) {
    if (isConfigError(error)) {
      return { context: undefined, configError: error.kind };
    }
    throw error;
  }
};
