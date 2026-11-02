/**
 * 開始の URL から、対象の設定のファイル `local/targets/<profileId>.json` を作り、それを指すプロファイルを作る部品（Task 43 の設計書 4.2。T43b）。
 * サーバだけで使う（`profile-functions.ts` の作成の Server Function）。
 * - 組み立て（`prepareGeneratedTargetConfig`）: 開始の URL と許可 Origin の欄の確かめ（`src/config/target-config-draft.ts`）の後、中身を
 *   `validateConfig`（設定の検証の owner）に通す。通った設定（`loadConfig` が読むときと同じ値）を、プロファイルの検証の文脈に使えるよう返す。
 * - 書き込み（`writeNewTargetConfig`）: パスは `local/targets/<id>.json` の形だけ（`display/start-url-draft.ts` の `generatedTargetConfigPathOf`
 *   と同じ形で、`isAcceptedTargetConfigPath` も通るもの）。任意のパスに書かない。同じフォルダの一時のファイル（`temporaryPathFor`）に書いて
 *   fsync してから、本体の名前へハードリンクを張る。名前がもうあればリンクは失敗する（`EEXIST`）ので、同じ名前のファイルを上書きしない。途中で
 *   止まっても、壊れた本体のファイルは残らない。一時のファイルは、成功でも失敗でも消す。ハードリンクを張れないファイルシステムでは、
 *   `TARGET_CONFIG_WRITE_FAILED` で止める（上書きしうる書き方に切り替えない）。
 *   T43R-fix-D（M-6）: 書く前に、置き場所（`local` と `local/targets`）がリンク（junction・symlink）でない本物のフォルダであることを確かめる
 *   （なければ作り、作った後にもう一度確かめる）。外れたら `TARGET_CONFIG_LOCATION_UNSAFE` で、何も書かずに止める。
 * - 片付け（`removeWrittenTargetConfig`）: ファイルを書いた後にプロファイルの保存が失敗したときに呼ぶ。書いた中身と同じときだけ消す（ほかの
 *   誰かが書き換えた中身は消さない。途中にリンクがあれば消さない）。消せなくても誤りにしない（呼び出し側は保存の失敗を返す）。
 * - 流れ（`createProfileWithGeneratedTarget`。T43b fix round 1 で `profile-functions.ts` から移し、部品を渡して確かめられるようにした）:
 *   0. 名前が Windows の予約名なら、`TARGET_CONFIG_NAME_RESERVED`（T43R-fix-D の M-6）。PL-U（14.1 の U7）: 作成の流れ（`createProfileFromRequest`）は、
 *      その前に番号を付けた名前にする（`withFileNameNotReserved`）ので、ここの拒否は、この関数を直接呼んだときの守りとしてだけ残る。
 *   1. パスはプロファイルの ID から決まる固定の形だけ（ID の形に合わなければ、ファイルを作らずに `PROFILE_ID_INVALID`）。
 *   2. 書く前に、中身を `validateConfig` に通し、その設定を文脈にしてプロファイルを `validateSiteProfile` で確かめ、同じ名前のプロファイルが
 *      ないことを確かめる（書いた後に保存が失敗する場合を減らす）。
 *   3. 書いた後は、書いたファイルを読み直した文脈で保存する。保存が拒まれたとき・投げたときは、書いたファイルを消す（安全側。残すと、次の作成で
 *      「同じ名前のファイルがある」になり、どのプロファイルも指さないファイルが残るため）。
 * - root はリポジトリの root（本番は `localUiRepositoryRoot()`。テストは一時のフォルダ）。テストの口は、`validateConfig` の差し替え（組み立て）と、
 *   ハードリンクの差し替え（書き込み）だけ。
 */
import { link as linkFile, mkdir, open, readFile, rename as renameFile, rm, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ConfigErrorKind } from '../../../../src/config/config-error.js';
import { targetConfigTextWithoutByteOrderMark, targetConfigWithDefaultsOf } from '../../../../src/config/load-config.js';
import {
  effectiveConfigInputOf,
  isReservedTargetConfigName,
  startsAtSameUrl,
  startUrlOriginOf,
  TARGET_CRAWL_LIMIT_FIELDS,
  targetConfigDocumentOf,
  targetSiteProblemsOf,
  type TargetConfigCreationFailure,
  type TargetCrawlLimitField,
  type TargetCrawlLimitProblemCode,
  type TargetCrawlLimits,
  type TargetCrawlLimitsChangeFailure,
  type TargetSiteInput,
  type TargetSiteProblem,
} from '../../../../src/config/target-config-draft.js';
import type { AuditConfig } from '../../../../src/config/types.js';
import { navigationIntervalFloorMsOf, validateConfig } from '../../../../src/config/validate-config.js';
import { inspectRealArtifactEntry } from '../../../../src/core/contained-artifact-file.js';
import { errorCodeOf } from '../../../../src/core/errors.js';
import { isNonNegativeSafeInteger, isPositiveSafeInteger, isRecord } from '../../../../src/core/guards.js';
import { MAX_CRAWL_MAX_PAGES } from '../../../../src/core/limits.js';
import { temporaryPathFor } from '../../../../src/core/temporary-file-name.js';
import { ENVIRONMENT_KINDS, type EnvironmentKind, type ProfileValidationErrorCode } from '../../../../src/control/contracts.js';
import { TEST_ORIGIN_MODES, environmentAcceptsEvidence } from '../../../../src/control/profile-combinations.js';
import { isAcceptedTargetConfigPath, validateSiteProfile, type ProfileValidationContext } from '../../../../src/control/profile-policy.js';
import type { ProfileContextResolver, ProfileStoreResult } from '../../../../src/control/store/profile-store.js';
import { LOCAL_TARGET_CONFIG_DIRECTORY, TARGET_CONFIG_EXTENSION } from '../../../../src/control/target-config-locations.js';
import { generatedTargetConfigPathOf, profileIdSuggestionOf, uniqueProfileIdOf } from '../display/start-url-draft';
import { isolationUnverifiedEvidenceRefOf } from './isolation-evidence-ref';

/** 名前がもうある（ハードリンクの失敗のコード）。 */
const ALREADY_EXISTS = 'EEXIST';

/** 置き場所のフォルダ（リポジトリの root からの相対。末尾の `/` を除く。`local` と `local/targets` を区切りごとに調べる）。 */
const LOCAL_TARGET_CONFIG_FOLDER = LOCAL_TARGET_CONFIG_DIRECTORY.slice(0, -1);

// 名前が Windows の予約名かの判定は、`src/config/target-config-draft.ts` の `isReservedTargetConfigName`（CC-101。画面の案と同じ部品）。

/**
 * 置き場所（`local` と `local/targets`）が、リンク（junction・symlink）でない本物のフォルダか（T43R-fix-D の M-6）。資格情報の保存（T26R の M1）と
 * 同じく、リポジトリの root から区切りごとに `lstat` で調べる `inspectRealArtifactEntry` を使う（リンクをたどらない）。ないときは `MISSING`。
 * 調べられないときは安全でないとみなす。
 */
const targetFolderStateOf = async (root: string): Promise<'DIRECTORY' | 'MISSING' | 'UNSAFE'> => {
  try {
    const entry = await inspectRealArtifactEntry(root, LOCAL_TARGET_CONFIG_FOLDER);
    return entry.kind === 'DIRECTORY' || entry.kind === 'MISSING' ? entry.kind : 'UNSAFE';
  } catch {
    return 'UNSAFE';
  }
};
/** 書く JSON の字下げ（`JSON.stringify` の空白の数）。 */
const JSON_INDENT = 2;

/** 設定の検証（`validateConfig` の形。テストの口）。 */
export type ConfigValidator = typeof validateConfig;

/** ハードリンクを張る（`node:fs/promises` の `link` の形。テストの口）。 */
export type LinkOperation = (existingPath: string, newPath: string) => Promise<void>;

/** 組み立ての結果。 */
export type PreparedTargetConfig =
  | {
    readonly ok: true;
    /** 書く中身（JSON と末尾の改行）。 */
    readonly content: string;
    /** `validateConfig` を通った設定（プロファイルの検証の文脈）。 */
    readonly targetConfig: AuditConfig;
  }
  | { readonly ok: false; readonly reason: 'TARGET_SITE_INVALID'; readonly siteProblems: readonly TargetSiteProblem[] }
  | { readonly ok: false; readonly reason: 'TARGET_CONFIG_INVALID'; readonly siteProblems: readonly TargetSiteProblem[] };

/** 書き込みの結果。 */
export type TargetConfigWriteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'TARGET_CONFIG_EXISTS' | 'TARGET_CONFIG_LOCATION_UNSAFE' | 'TARGET_CONFIG_WRITE_FAILED' };

/** 開始の URL と許可 Origin から、作るファイルの中身を組み立て、`validateConfig` に通す。 */
export const prepareGeneratedTargetConfig = (
  targetId: string,
  site: TargetSiteInput,
  validate: ConfigValidator = validateConfig,
): PreparedTargetConfig => {
  const siteProblems = targetSiteProblemsOf(site);
  if (siteProblems.length > 0) {
    return { ok: false, reason: 'TARGET_SITE_INVALID', siteProblems };
  }
  const document = targetConfigDocumentOf({ targetId, startUrl: site.startUrl, allowedOrigins: site.allowedOrigins });
  const validation = validate(effectiveConfigInputOf(document));
  if (!validation.ok) {
    return { ok: false, reason: 'TARGET_CONFIG_INVALID', siteProblems: [] };
  }
  return { ok: true, content: `${JSON.stringify(document, null, JSON_INDENT)}\n`, targetConfig: structuredClone(validation.value) };
};

/** パスが、作るファイルの形（`local/targets/<id>.json`。`id` はプロファイルの ID の形）で、プロファイルが参照してよいものか。 */
const isGeneratedTargetConfigPath = (targetConfigPath: string): boolean => {
  if (!targetConfigPath.startsWith(LOCAL_TARGET_CONFIG_DIRECTORY) || !targetConfigPath.endsWith(TARGET_CONFIG_EXTENSION)) {
    return false;
  }
  const targetId = targetConfigPath.slice(LOCAL_TARGET_CONFIG_DIRECTORY.length, -TARGET_CONFIG_EXTENSION.length);
  return generatedTargetConfigPathOf(targetId) === targetConfigPath && isAcceptedTargetConfigPath(targetConfigPath);
};

/** 一時のファイルに書いて fsync し、閉じる。 */
const writeTemporaryFile = async (temporaryPath: string, content: string): Promise<void> => {
  const handle = await open(temporaryPath, 'wx');
  try {
    await handle.writeFile(content, { encoding: 'utf8' });
    await handle.sync();
  } finally {
    await handle.close();
  }
};

/** 作るファイルを、上書きせずに書く（同じ名前があれば `TARGET_CONFIG_EXISTS`）。 */
export const writeNewTargetConfig = async (
  root: string,
  targetConfigPath: string,
  content: string,
  link: LinkOperation = linkFile,
): Promise<TargetConfigWriteResult> => {
  if (!isGeneratedTargetConfigPath(targetConfigPath)) {
    return { ok: false, reason: 'TARGET_CONFIG_WRITE_FAILED' };
  }
  // T43R-fix-D（M-6）: 書く前に、置き場所がリンクでない本物のフォルダであることを確かめる。なければ作り、作った後にもう一度確かめる。
  const before = await targetFolderStateOf(root);
  if (before === 'UNSAFE') {
    return { ok: false, reason: 'TARGET_CONFIG_LOCATION_UNSAFE' };
  }
  const path = join(root, targetConfigPath);
  if (before === 'MISSING') {
    try {
      await mkdir(dirname(path), { recursive: true });
    } catch {
      return { ok: false, reason: 'TARGET_CONFIG_WRITE_FAILED' };
    }
    if ((await targetFolderStateOf(root)) !== 'DIRECTORY') {
      return { ok: false, reason: 'TARGET_CONFIG_LOCATION_UNSAFE' };
    }
  }
  const temporaryPath = temporaryPathFor(path);
  try {
    await writeTemporaryFile(temporaryPath, content);
    await link(temporaryPath, path);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: errorCodeOf(error) === ALREADY_EXISTS ? 'TARGET_CONFIG_EXISTS' : 'TARGET_CONFIG_WRITE_FAILED' };
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
};

/** 書いたファイルを、書いた中身と同じときだけ消す。消したら真（ない、中身が違う、消せないときは偽）。 */
export const removeWrittenTargetConfig = async (root: string, targetConfigPath: string, content: string): Promise<boolean> => {
  if (!isGeneratedTargetConfigPath(targetConfigPath)) {
    return false;
  }
  const path = join(root, targetConfigPath);
  try {
    // T43R-fix-D（M-6）: 途中にリンク（junction・symlink）があれば、その先のファイルを消さない。
    if ((await inspectRealArtifactEntry(root, targetConfigPath)).kind !== 'FILE' || (await readFile(path, 'utf8')) !== content) {
      return false;
    }
    await unlink(path);
    return true;
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------------------------------------------
// T44d（Task 44 の設計書 P2-1。設計の変更の履歴の T44d の行の案 (a)）: プロファイルの画面から、負荷の 3 つの値（ページの上限・時間の上限・
// 読み込みの間隔）を、プロファイルが指す設定のファイルに書く。
// - 書けるのは、作るファイルと同じ形のパス（`local/targets/<id>.json`。`isEditableTargetConfigPath`）だけ。`config/targets/` などは書かない。
// - 値の範囲は `validateConfig` と同じ（欄の確かめの後に、変えた後の中身を `loadConfig` と同じ合わせ方で `validateConfig` に通す）。間隔の下限は
//   `navigationIntervalFloorMsOf`（検証と同じ部品）。値が同じなら書かない。
// - 置き換え（`replaceTargetConfig`）: 置き場所がリンクでない本物のフォルダで、ファイルがリンクでない本物のファイルで、中身が画面の読んだ中身と
//   同じときだけ、同じフォルダの一時のファイルに書いて fsync し、名前を変えて置き換える（途中で止まっても、壊れた本体は残らない）。読み直しから
//   名前の変更までの短い間に、ほかの誰かが書いた変更は上書きしうる（ローカルの 1 人の利用を前提にした限界）。
// ---------------------------------------------------------------------------------------------------------------

/** パスが、画面から書いてよい設定のファイル（作るファイルと同じ形 `local/targets/<id>.json`）か。 */
export const isEditableTargetConfigPath = (targetConfigPath: string): boolean => isGeneratedTargetConfigPath(targetConfigPath);

/** 設定のファイルの中身を JSON として読む（BOM は `loadConfig` と同じく 1 つだけ取り除く）。読めなければ undefined。 */
const parsedTargetDocumentOf = (content: string): Record<string, unknown> | undefined => {
  try {
    const parsed: unknown = JSON.parse(targetConfigTextWithoutByteOrderMark(content));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

/** 既定値を合わせて `validateConfig` に通した設定（通らなければ undefined）。 */
const validatedTargetConfigOf = (document: Record<string, unknown>, validate: ConfigValidator): AuditConfig | undefined => {
  const validation = validate(targetConfigWithDefaultsOf(document));
  return validation.ok ? validation.value : undefined;
};

const crawlLimitsOf = (config: AuditConfig): TargetCrawlLimits => ({
  maxPages: config.crawl.maxPages,
  maxRuntimeMs: config.crawl.maxRuntimeMs,
  minNavigationIntervalMs: config.crawl.minNavigationIntervalMs,
});

/** 今の負荷の値を読んだ結果。 */
export type TargetCrawlLimitsReading =
  | {
    readonly ok: true;
    readonly limits: TargetCrawlLimits;
    /** 読み込みの間隔の下限（ms。`navigationIntervalFloorMsOf`）。 */
    readonly minNavigationIntervalFloorMs: number;
    /** `validateConfig` を通った今の設定。 */
    readonly targetConfig: AuditConfig;
  }
  | { readonly ok: false };

/** 設定のファイルの中身から、今の負荷の値（既定値を合わせた値）と、間隔の下限を読む。 */
export const readTargetCrawlLimits = (content: string, validate: ConfigValidator = validateConfig): TargetCrawlLimitsReading => {
  const document = parsedTargetDocumentOf(content);
  const config = document === undefined ? undefined : validatedTargetConfigOf(document, validate);
  if (config === undefined) {
    return { ok: false };
  }
  return { ok: true, limits: crawlLimitsOf(config), minNavigationIntervalFloorMs: navigationIntervalFloorMsOf(config.site), targetConfig: config };
};

/** 欄の値の誤り。 */
export interface TargetCrawlLimitProblem {
  readonly field: TargetCrawlLimitField;
  readonly code: TargetCrawlLimitProblemCode;
}

/** 欄の値の確かめ（`validateConfig` と同じ範囲。間隔の下限は `floorMs`。T44R の M-3: ページの上限の上限は `MAX_CRAWL_MAX_PAGES`）。 */
const crawlLimitProblemsOf = (limits: TargetCrawlLimits, floorMs: number): readonly TargetCrawlLimitProblem[] =>
  TARGET_CRAWL_LIMIT_FIELDS.flatMap((field): TargetCrawlLimitProblem[] => {
    const value = limits[field];
    if (field !== 'minNavigationIntervalMs') {
      if (!isPositiveSafeInteger(value)) {
        return [{ field, code: 'NOT_POSITIVE_INTEGER' }];
      }
      return field === 'maxPages' && value > MAX_CRAWL_MAX_PAGES ? [{ field, code: 'ABOVE_MAX_PAGES' }] : [];
    }
    if (!isNonNegativeSafeInteger(value)) {
      return [{ field, code: 'NOT_NON_NEGATIVE_INTEGER' }];
    }
    return value < floorMs ? [{ field, code: 'BELOW_NAVIGATION_INTERVAL_FLOOR' }] : [];
  });

/** 変える前の確かめの結果。 */
export type PreparedTargetCrawlLimitsChange =
  | {
    readonly ok: true;
    /** 書く中身（JSON と末尾の改行）。 */
    readonly content: string;
    readonly before: TargetCrawlLimits;
    readonly after: TargetCrawlLimits;
    /** 変えた後の、`validateConfig` を通った設定。 */
    readonly targetConfig: AuditConfig;
  }
  | {
    readonly ok: false;
    readonly reason: Extract<TargetCrawlLimitsChangeFailure, 'TARGET_CONFIG_INVALID' | 'CRAWL_LIMITS_INVALID' | 'CRAWL_LIMITS_UNCHANGED'>;
    readonly problems: readonly TargetCrawlLimitProblem[];
  };

/** 今の中身の 3 つの値だけを `limits` に変えた中身を組み立て、確かめる（ほかの項目は変えない）。 */
export const prepareTargetCrawlLimitsChange = (
  content: string,
  limits: TargetCrawlLimits,
  validate: ConfigValidator = validateConfig,
): PreparedTargetCrawlLimitsChange => {
  const document = parsedTargetDocumentOf(content);
  const current = document === undefined ? undefined : validatedTargetConfigOf(document, validate);
  if (document === undefined || current === undefined) {
    return { ok: false, reason: 'TARGET_CONFIG_INVALID', problems: [] };
  }
  const after: TargetCrawlLimits = {
    maxPages: limits.maxPages,
    maxRuntimeMs: limits.maxRuntimeMs,
    minNavigationIntervalMs: limits.minNavigationIntervalMs,
  };
  const problems = crawlLimitProblemsOf(after, navigationIntervalFloorMsOf(current.site));
  if (problems.length > 0) {
    return { ok: false, reason: 'CRAWL_LIMITS_INVALID', problems };
  }
  const before = crawlLimitsOf(current);
  if (TARGET_CRAWL_LIMIT_FIELDS.every((field) => before[field] === after[field])) {
    return { ok: false, reason: 'CRAWL_LIMITS_UNCHANGED', problems: [] };
  }
  const currentCrawl = isRecord(document['crawl']) ? document['crawl'] : {};
  const changed = { ...document, crawl: { ...currentCrawl, ...after } };
  const targetConfig = validatedTargetConfigOf(changed, validate);
  if (targetConfig === undefined) {
    return { ok: false, reason: 'TARGET_CONFIG_INVALID', problems: [] };
  }
  return { ok: true, content: `${JSON.stringify(changed, null, JSON_INDENT)}\n`, before, after, targetConfig: structuredClone(targetConfig) };
};

/** 名前を変える（`node:fs/promises` の `rename` の形。テストの口）。 */
export type RenameOperation = (oldPath: string, newPath: string) => Promise<void>;

/** 置き換えの結果。 */
export type TargetConfigReplaceResult =
  | { readonly ok: true }
  | {
    readonly ok: false;
    readonly reason: Extract<
      TargetCrawlLimitsChangeFailure,
      'TARGET_CONFIG_NOT_EDITABLE' | 'TARGET_CONFIG_CHANGED' | 'TARGET_CONFIG_LOCATION_UNSAFE' | 'TARGET_CONFIG_WRITE_FAILED'
    >;
  };

/** 今の中身（ないときは undefined。読めないときは null）。 */
const currentContentOf = async (path: string): Promise<string | undefined | null> => {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    return errorCodeOf(error) === 'ENOENT' ? undefined : null;
  }
};

/** 設定のファイルを、画面が読んだ中身（`expectedContent`）のときだけ、`content` に置き換える。 */
export const replaceTargetConfig = async (
  root: string,
  targetConfigPath: string,
  expectedContent: string,
  content: string,
  rename: RenameOperation = renameFile,
): Promise<TargetConfigReplaceResult> => {
  if (!isGeneratedTargetConfigPath(targetConfigPath)) {
    return { ok: false, reason: 'TARGET_CONFIG_NOT_EDITABLE' };
  }
  if ((await targetFolderStateOf(root)) !== 'DIRECTORY') {
    return { ok: false, reason: 'TARGET_CONFIG_LOCATION_UNSAFE' };
  }
  let entryKind: string;
  try {
    entryKind = (await inspectRealArtifactEntry(root, targetConfigPath)).kind;
  } catch {
    return { ok: false, reason: 'TARGET_CONFIG_LOCATION_UNSAFE' };
  }
  if (entryKind === 'MISSING') {
    return { ok: false, reason: 'TARGET_CONFIG_CHANGED' };
  }
  if (entryKind !== 'FILE') {
    return { ok: false, reason: 'TARGET_CONFIG_LOCATION_UNSAFE' };
  }
  const path = join(root, targetConfigPath);
  const current = await currentContentOf(path);
  if (current === null) {
    return { ok: false, reason: 'TARGET_CONFIG_WRITE_FAILED' };
  }
  if (current !== expectedContent) {
    return { ok: false, reason: 'TARGET_CONFIG_CHANGED' };
  }
  const temporaryPath = temporaryPathFor(path);
  try {
    await writeTemporaryFile(temporaryPath, content);
    await rename(temporaryPath, path);
    return { ok: true };
  } catch {
    return { ok: false, reason: 'TARGET_CONFIG_WRITE_FAILED' };
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
};

/** 対象の設定を読んだ結果（`target-config.ts` の `loadTargetContext` の形）。 */
export interface GeneratedTargetContextReading {
  readonly context: ProfileValidationContext | undefined;
  readonly configError: ConfigErrorKind | null;
}

/** 流れに渡す部品（本番は `profile-functions.ts` が組み立てる）。 */
export interface GeneratedTargetProfileDependencies {
  /** リポジトリの root。 */
  readonly root: string;
  /** 同じ名前のプロファイルがあるか（取り消したものを含む）。 */
  readonly profileExists: (profileId: string) => boolean;
  /** 書いたファイルを読み直す（本番は `loadTargetContext`）。 */
  readonly loadContext: (targetConfigPath: string) => Promise<GeneratedTargetContextReading>;
  /** プロファイルを保存する（本番は `createProfile`）。 */
  readonly saveProfile: (profile: Readonly<Record<string, unknown>>, resolveContext: ProfileContextResolver) => ProfileStoreResult;
  /** テストの口: 設定の検証。 */
  readonly validate?: ConfigValidator;
  /** テストの口: ハードリンク。 */
  readonly link?: LinkOperation;
}

/** 流れの結果。 */
export type GeneratedTargetProfileOutcome =
  /** 対象の設定のファイルを作れなかった（プロファイルも作らない）。 */
  | { readonly kind: 'TARGET_REJECTED'; readonly reason: TargetConfigCreationFailure; readonly siteProblems: readonly TargetSiteProblem[] }
  /** 書く前の確かめで、プロファイルを拒んだ（ファイルを作らない）。 */
  | {
    readonly kind: 'PROFILE_REJECTED';
    readonly reason: 'PROFILE_INVALID' | 'PROFILE_ALREADY_EXISTS';
    readonly errorCodes: readonly ProfileValidationErrorCode[];
  }
  /** 書いた後の保存の結果（拒まれたら、書いたファイルを消したか）。 */
  | {
    readonly kind: 'SAVED';
    readonly result: ProfileStoreResult;
    readonly configError: ConfigErrorKind | null;
    readonly removedAfterFailure: boolean;
  };

/** 開始の URL から対象の設定のファイルを作り、それを指すプロファイルを保存する。保存が投げたら、書いたファイルを消してから投げ直す。 */
export const createProfileWithGeneratedTarget = async (
  input: Readonly<Record<string, unknown>>,
  site: TargetSiteInput,
  dependencies: GeneratedTargetProfileDependencies,
): Promise<GeneratedTargetProfileOutcome> => {
  const profileId = input['profileId'];
  // T43R-fix-D（M-6）: Windows の予約名の名前は、ファイルの名前にできないので、理由つきで拒む（パスの形の誤りとしては返さない）。
  if (typeof profileId === 'string' && isReservedTargetConfigName(profileId)) {
    return { kind: 'TARGET_REJECTED', reason: 'TARGET_CONFIG_NAME_RESERVED', siteProblems: [] };
  }
  const targetConfigPath = typeof profileId === 'string' ? generatedTargetConfigPathOf(profileId) : undefined;
  if (typeof profileId !== 'string' || targetConfigPath === undefined) {
    return { kind: 'PROFILE_REJECTED', reason: 'PROFILE_INVALID', errorCodes: ['PROFILE_ID_INVALID'] };
  }
  const prepared = prepareGeneratedTargetConfig(profileId, site, dependencies.validate);
  if (!prepared.ok) {
    return { kind: 'TARGET_REJECTED', reason: prepared.reason, siteProblems: prepared.siteProblems };
  }
  const profile = { ...input, targetConfigPath };
  const validation = validateSiteProfile(profile, { targetConfig: prepared.targetConfig });
  if (!validation.ok) {
    return { kind: 'PROFILE_REJECTED', reason: 'PROFILE_INVALID', errorCodes: validation.errors.map((error) => error.code) };
  }
  if (dependencies.profileExists(profileId)) {
    return { kind: 'PROFILE_REJECTED', reason: 'PROFILE_ALREADY_EXISTS', errorCodes: [] };
  }
  const { root } = dependencies;
  const written = await writeNewTargetConfig(root, targetConfigPath, prepared.content, dependencies.link);
  if (!written.ok) {
    return { kind: 'TARGET_REJECTED', reason: written.reason, siteProblems: [] };
  }
  try {
    const { context, configError } = await dependencies.loadContext(targetConfigPath);
    const result = dependencies.saveProfile(profile, (path) => (path === targetConfigPath ? context : undefined));
    const removedAfterFailure = result.ok ? false : await removeWrittenTargetConfig(root, targetConfigPath, prepared.content);
    return { kind: 'SAVED', result, configError, removedAfterFailure };
  } catch (error) {
    await removeWrittenTargetConfig(root, targetConfigPath, prepared.content);
    throw error;
  }
};

// ---------------------------------------------------------------------------------------------------------------
// MI-1（設計書 `doc/design/2026-10-26-beaksight-minimal-input-ux-design.md` 4.2 の「隠す値」の表、6 章の受け入れ条件 1）: 作成の画面は、開始の URL と
// 使い方の 2 択（と隔離の扱い）だけを送り、利用者が「詳しい設定」で直さなかった値の項目を送らない。送らなかった項目を、ここだけで決める（画面と
// サーバの 2 か所に同じ判断を書かない）:
// - 名前（`profileId` がない）: 開始の URL（なければ、使う設定のファイルの開始の URL）からの案（`profileIdSuggestionOf`）。既にあるプロファイルの名前と
//   重なれば `-2`、`-3`…を付ける（`uniqueProfileIdOf`）。新しくファイルを作るときは、作るファイルの名前が候補に既にある名前も使わない。
// - 設定のファイル: MI-C（MI-1 の報告。設計者の判断）で、選び方を入力の明示の項目（スキーマ `ui-profile-create` の `targetChoice`。ここでは
//   `ProfileTargetRequest`）にした（`targetConfigPath` の項目を「新しく作る」の印に使わない）。
//   - `AUTO`（作成の画面の既定）: 候補（`targetConfigCandidates`。作成の画面の選択肢と同じ集め方）のうち、開始の URL の Origin を `site.allowedOrigins`
//     に含み、かつ `site.startUrl` が入れた開始の URL と一致する（監査の開始と同じ正規化。`startsAtSameUrl`）ファイルがちょうど 1 つあれば、
//     それを使う（ファイルを作らない・書き換えない）。2 つ以上なら保存せずに `TARGET_AMBIGUOUS`。Origin が同じファイルはあるが、開始の URL が一致する
//     ものがないときは、新しいファイルを作らずに `TARGET_START_URL_MISMATCH`（同じ Origin のファイルを候補に返す。どちらも詳しい設定で選んでもらう）。
//     Origin が同じファイルがなければ、今どおり新しく作る（`createProfileWithGeneratedTarget`）。
//   - `NEW`（詳しい設定）: いつも新しく作る。`EXISTING`（詳しい設定・編集）: `profile.targetConfigPath` のファイルを使う。
// - テスト環境の Origin（`approvedTestOrigins` がない）: テスト環境のモード（`TEST_ORIGIN_MODES`）なら、新しく作るときは許可 Origin を写し、既にある
//   ファイルを使うときは、そのファイルの許可 Origin のうち開始の URL の Origin（開始の URL がなければ、ファイルの開始の URL の Origin）。ほかのモードは空。
// - 環境の証跡の参照（`environmentEvidenceRef` がない）: テスト環境（`environmentAcceptsEvidence`）なら、保存した日の隔離が未確認の参照
//   （`isolationUnverifiedEvidenceRefOf`）。公開の環境は `null`。
// - 承認したサービスの Origin の項目は作らない（手動のログインの観察だけが足す。送られた項目はそのまま検証に回す）。
// ---------------------------------------------------------------------------------------------------------------

/** 作成の流れに渡す部品（本番は `profile-functions.ts` が組み立てる）。 */
export interface ProfileCreationDependencies extends GeneratedTargetProfileDependencies {
  /** 今あるプロファイルの名前（取り消したものを含む。名前の案の重なりを避ける）。 */
  readonly profileIds: () => readonly string[];
  /** 設定のファイルの候補（`target-config.ts` の `targetConfigCandidatesIn`。作成の画面の選択肢と同じ集め方）。 */
  readonly targetConfigCandidates: () => readonly string[];
  /** 今の時刻（隔離が未確認の参照の日付）。 */
  readonly now: () => Date;
}

/**
 * MI-C: 対象の設定の選び方（スキーマ `ui-profile-create` の `targetChoice` の値。省略は `EXISTING`）。作成の画面の選択肢（`ProfileForm.tsx` の
 * `TargetSource`）も、この型を使う。
 */
export type ProfileTargetChoice = 'AUTO' | 'NEW' | 'EXISTING';

/** MI-C: 作成の入力の、対象の設定の選び方（開始の URL から決める選び方だけが、開始の URL と許可 Origin を持つ）。 */
export type ProfileTargetRequest =
  | { readonly choice: Exclude<ProfileTargetChoice, 'EXISTING'>; readonly site: TargetSiteInput }
  | { readonly choice: 'EXISTING' };

/** 作成の流れの結果（新しく作る流れの結果に、設定のファイルが 1 つに決まらなかったことを足したもの）。 */
export type ProfileCreationOutcome =
  | GeneratedTargetProfileOutcome
  /** 開始の URL の Origin を許可 Origin に含み、開始の URL も一致するファイルが 2 つ以上あった（何も保存しない。候補のパスを名前の順で返す）。 */
  | { readonly kind: 'TARGET_AMBIGUOUS'; readonly candidates: readonly string[] }
  /** MI-C: 開始の URL の Origin を許可 Origin に含むファイルはあるが、どれも別の開始の URL だった（何も保存しない。そのファイルを名前の順で返す）。 */
  | { readonly kind: 'TARGET_START_URL_MISMATCH'; readonly candidates: readonly string[] };

/** 読めた設定のファイル（パスと、`loadConfig` で読んだ文脈）。 */
interface ReadTargetConfig {
  readonly path: string;
  readonly context: ProfileValidationContext;
}

/** 入力に項目がないか（送らなかった項目は、この流れが決める）。 */
const lacks = (input: Readonly<Record<string, unknown>>, key: string): boolean => input[key] === undefined;

/** 開始の URL の Origin を許可 Origin に含む、読める設定のファイル（候補の順）。読めないファイルは候補にしない。 */
const targetConfigsAllowing = async (origin: string, dependencies: ProfileCreationDependencies): Promise<readonly ReadTargetConfig[]> => {
  const found: ReadTargetConfig[] = [];
  for (const path of dependencies.targetConfigCandidates()) {
    const { context } = await dependencies.loadContext(path);
    if (context !== undefined && context.targetConfig.site.allowedOrigins.includes(origin)) {
      found.push({ path, context });
    }
  }
  return found;
};

/** 使う設定のファイルの、テスト環境の Origin の案（開始の URL の Origin がファイルの許可 Origin にあればそれ、なければファイルの開始の URL の Origin）。 */
const testOriginOfExisting = (context: ProfileValidationContext, startUrl: string | undefined): readonly string[] => {
  const origin = startUrl === undefined ? undefined : startUrlOriginOf(startUrl);
  if (origin !== undefined && context.targetConfig.site.allowedOrigins.includes(origin)) {
    return [origin];
  }
  const fileOrigin = startUrlOriginOf(context.targetConfig.site.startUrl);
  return fileOrigin === undefined ? [] : [fileOrigin];
};

/** 送らなかった項目を決めるための事実。 */
interface CompletionFacts {
  /** 名前の案の元の URL。 */
  readonly suggestionUrl: string | undefined;
  /** 使えない名前。 */
  readonly takenIds: ReadonlySet<string>;
  /** テスト環境のモードのときの、テスト環境の Origin。 */
  readonly testOrigins: readonly string[];
  readonly now: Date;
}

/** 送らなかった項目を決めた入力（名前・テスト環境の Origin・環境の証跡の参照）。ほかの項目は、送られたまま。 */
const completedInputOf = (input: Readonly<Record<string, unknown>>, facts: CompletionFacts): Readonly<Record<string, unknown>> => {
  const { mode, environment } = input;
  const testMode = TEST_ORIGIN_MODES.some((candidate) => candidate === mode);
  const testEnvironment = ENVIRONMENT_KINDS.some((kind) => kind === environment) && environmentAcceptsEvidence(environment as EnvironmentKind);
  return {
    ...input,
    ...(lacks(input, 'profileId')
      ? { profileId: uniqueProfileIdOf(facts.suggestionUrl === undefined ? '' : profileIdSuggestionOf(facts.suggestionUrl), facts.takenIds) }
      : {}),
    ...(lacks(input, 'approvedTestOrigins') ? { approvedTestOrigins: testMode ? [...facts.testOrigins] : [] } : {}),
    ...(lacks(input, 'environmentEvidenceRef')
      ? { environmentEvidenceRef: testEnvironment ? isolationUnverifiedEvidenceRefOf(facts.now) : null }
      : {}),
  };
};

/** 作るファイルの名前（`local/targets/<名前>.json`）が候補に既にある名前（新しく作るときは、その名前も使わない）。 */
const generatedFileIdsOf = (candidates: readonly string[]): readonly string[] =>
  candidates.flatMap((path) => {
    const id = path.slice(LOCAL_TARGET_CONFIG_DIRECTORY.length, -TARGET_CONFIG_EXTENSION.length);
    return path.startsWith(LOCAL_TARGET_CONFIG_DIRECTORY) && generatedTargetConfigPathOf(id) === path ? [id] : [];
  });

/**
 * PL-U（設計書 `doc/design/2026-10-26-beaksight-plain-ui-design.md` 14.1 の U7）: 作るファイルの名前（＝名前）が Windows の予約名に当たるときは、拒まずに
 * 番号を付けた名前にする（作成の画面に名前の欄はないので、「別の名前にしてから」と言わない）。番号の付け方と予約名の判定は、名前の案の部品
 * `uniqueProfileIdOf`（予約名の判定は `isReservedTargetConfigName` の 1 か所）。予約名でない名前は、送られたまま（重なりは今どおり拒む）。
 */
const withFileNameNotReserved = (input: Readonly<Record<string, unknown>>, takenIds: ReadonlySet<string>): Readonly<Record<string, unknown>> => {
  const { profileId } = input;
  return typeof profileId === 'string' && isReservedTargetConfigName(profileId) ? { ...input, profileId: uniqueProfileIdOf(profileId, takenIds) } : input;
};

/** 新しく作る（送らなかった項目を決めてから、今の流れ `createProfileWithGeneratedTarget` に渡す）。 */
const createWithGeneratedTarget = (
  input: Readonly<Record<string, unknown>>,
  site: TargetSiteInput,
  dependencies: ProfileCreationDependencies,
): Promise<GeneratedTargetProfileOutcome> => {
  const takenIds = new Set([...dependencies.profileIds(), ...generatedFileIdsOf(dependencies.targetConfigCandidates())]);
  const completed = completedInputOf(input, { suggestionUrl: site.startUrl, takenIds, testOrigins: site.allowedOrigins, now: dependencies.now() });
  return createProfileWithGeneratedTarget(withFileNameNotReserved(completed, takenIds), site, dependencies);
};

/** 既にある設定のファイルを使って保存する（ファイルを作らない・書き換えない）。 */
const saveWithExistingTarget = (
  input: Readonly<Record<string, unknown>>,
  target: ReadTargetConfig,
  startUrl: string | undefined,
  dependencies: ProfileCreationDependencies,
): ProfileCreationOutcome => {
  const completed = completedInputOf(input, {
    suggestionUrl: startUrl ?? target.context.targetConfig.site.startUrl,
    takenIds: new Set(dependencies.profileIds()),
    testOrigins: testOriginOfExisting(target.context, startUrl),
    now: dependencies.now(),
  });
  const profile = { ...completed, targetConfigPath: target.path };
  const result = dependencies.saveProfile(profile, (path) => (path === target.path ? target.context : undefined));
  return { kind: 'SAVED', result, configError: null, removedAfterFailure: false };
};

/**
 * MI-1: 作成の画面の入力（`profile` と、対象の設定の選び方 `target`）から、プロファイルを作る（送らなかった項目は、この流れが決める。上の説明）。
 * 詳しい設定で「すでにある設定のファイルを使う」を選んだ入力（`EXISTING`）で、そのファイルを読めなければ、文脈なしで保存の部品に渡す
 * （保存の部品が今どおり拒み、設定の誤りの種類を返す）。
 */
export const createProfileFromRequest = async (
  input: Readonly<Record<string, unknown>>,
  target: ProfileTargetRequest,
  dependencies: ProfileCreationDependencies,
): Promise<ProfileCreationOutcome> => {
  if (target.choice === 'EXISTING') {
    const path = input['targetConfigPath'];
    const reading = typeof path === 'string' ? await dependencies.loadContext(path) : { context: undefined, configError: null };
    if (typeof path !== 'string' || reading.context === undefined) {
      const result = dependencies.saveProfile(input, () => undefined);
      return { kind: 'SAVED', result, configError: reading.configError, removedAfterFailure: false };
    }
    return saveWithExistingTarget(input, { path, context: reading.context }, undefined, dependencies);
  }
  const { site } = target;
  if (target.choice === 'NEW') {
    return createWithGeneratedTarget(input, site, dependencies);
  }
  const origin = startUrlOriginOf(site.startUrl);
  const sameOrigin = origin === undefined ? [] : await targetConfigsAllowing(origin, dependencies);
  if (sameOrigin.length === 0) {
    return createWithGeneratedTarget(input, site, dependencies);
  }
  // MI-C: 開始の URL の比べ方は `src/config/target-config-draft.ts` の `startsAtSameUrl`（監査の開始と同じ正規化。画面のサーバは src/crawl を直接読まない）。
  const matches = sameOrigin.filter((candidate) => startsAtSameUrl(candidate.context.targetConfig, site.startUrl));
  const [only, ...others] = matches;
  if (only === undefined) {
    return { kind: 'TARGET_START_URL_MISMATCH', candidates: sameOrigin.map((candidate) => candidate.path) };
  }
  if (others.length > 0) {
    return { kind: 'TARGET_AMBIGUOUS', candidates: matches.map((match) => match.path) };
  }
  return saveWithExistingTarget(input, only, site.startUrl, dependencies);
};
