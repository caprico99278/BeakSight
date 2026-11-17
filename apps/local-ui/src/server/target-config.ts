/**
 * プロファイルが指すターゲット設定（JSON）を、既存の `loadConfig` で読む（T23f で作り、T24f でプロファイル・監査のジョブ・成果物の共用にした）。
 * - `isAcceptedTargetConfigPath` を通ったパスだけを読む（通らないパスでは、ファイルを読まない）。設定の検証の owner を写さない。
 * - パスはリポジトリの root（`localUiRepositoryRoot`）から解決する。監査のワーカーも、cwd をリポジトリの root にして同じファイルを読む。
 */
import { readdirSync, type Dirent } from 'node:fs';
import { join, posix } from 'node:path';
import type { ConfigErrorKind } from '../../../../src/config/config-error.js';
import { isConfigError } from '../../../../src/config/config-error.js';
import { loadConfig } from '../../../../src/config/load-config.js';
import { isAcceptedTargetConfigPath, type ProfileValidationContext } from '../../../../src/control/profile-policy.js';
import { TARGET_CONFIG_DIRECTORIES, TARGET_CONFIG_EXTENSION } from '../../../../src/control/target-config-locations.js';
import { localUiRepositoryRoot } from './control-store';

/** フォルダの中の `.json` の、root からの相対パス（名前だけを列挙する。中身は読まない）。 */
const listJsonFiles = (root: string, directory: string): readonly string[] => {
  let entries: Dirent[];
  try {
    entries = readdirSync(join(root, directory), { recursive: true, withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(TARGET_CONFIG_EXTENSION))
    .map((entry) => posix.relative(root.replaceAll('\\', '/'), `${entry.parentPath.replaceAll('\\', '/')}/${entry.name}`));
};

/**
 * 設定のファイルの候補（`config/targets/` と `local/targets/` の `.json` のうち、`isAcceptedTargetConfigPath` が受けるもの。ファイルの名前の一覧だけ。
 * 並びは名前の順）。作成の画面の選択肢（`targetConfigCandidatesFn`）と、MI-1 の作成の流れの自動の選び方が、同じ集め方を使う（T43b fix round 1 の
 * フォルダの一覧は `target-config-locations.ts` の `TARGET_CONFIG_DIRECTORIES`）。`root` はリポジトリの root（テストは一時のフォルダ）。
 */
export const targetConfigCandidatesIn = (root: string): readonly string[] =>
  TARGET_CONFIG_DIRECTORIES.flatMap((directory) => listJsonFiles(root, directory)).filter(isAcceptedTargetConfigPath).sort();

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
