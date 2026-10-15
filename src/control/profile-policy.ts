// 監査プロファイルの判定の唯一の owner（Task 22 の設計書 4.2、4.3。ロードマップ 3.1、3.2 の I01〜I04、I14、11 の RF1）。
// - プロファイルの検証（`validateSiteProfile`）: スキーマで形を確かめた後、組み合わせの表と各値の規則を確かめる。すべて fail-closed で、
//   当たった規則はすべて誤りとして返す。
// - 旧ターゲット JSON の解決（`resolveLegacyTargetProfile`）: つねに `PUBLIC_PASSIVE`・`NONE`・空の Origin（I01）。
// - 改訂の単調増加（`assertProfileRevisionAdvance`）。保存は Task 23 の owner。次の改訂は `validateSiteProfile` が受けた値（実行時の
//   閉じた一覧 `validatedProfiles` にある値）だけを受け、前の改訂は形を確かめ、改訂の番号は安全な整数どうしだけを比べる（T22d。T22R の I1）。
// - 取り消しの次の改訂の写し（`retiredRevisionOf`。T23c round 1）。保存してあった値の形だけを確かめ、改訂を 1 つ進めた凍結した写しを返す。
//   `validatedProfiles` に入れない（実行や `assertProfileRevisionAdvance` の `next` には使えない）。
// 入出力を持たない（ファイルを読まない）。参照するターゲット JSON は、呼び出し側が `loadConfig` で読んで `context` に渡す。
// Playwright と監査エンジン（`src/browser/`、`src/safety/`、`src/orchestration/`）を import しない。`src/config/validate-config.ts` は
// `src/safety/` を間接に読み込むので import しない（`src/config/types.ts` の型だけを参照する）。
// Origin の判定は、URL の意味の owner（`src/crawl/normalize-url.ts`）の部品を呼ぶだけにする（GATE-ARCH04）。
import type { AuditConfig } from '../config/types.js';
import { isPortableRelativeArtifactPath } from '../core/artifact-layout.js';
import { isRecord } from '../core/guards.js';
import { deepFreeze } from '../core/immutable.js';
import { hasBidiControl, hasControlOrLineSeparator, hasLoneSurrogate } from '../core/text.js';
import { canonicalHttpOriginOf, isLoopbackUrl, isOriginInAllowedOrigins } from '../crawl/normalize-url.js';
import {
  MAX_ENVIRONMENT_EVIDENCE_REF_LENGTH,
  MIN_PROFILE_REVISION,
  PROFILE_ID_PATTERN,
  SITE_PROFILE_SCHEMA_VERSION,
  type AuditMode,
  type AuthStrategy,
  type EnvironmentKind,
  type ProfileValidationError,
  type ProfileValidationErrorCode,
  type ProfileValidationResult,
  type SiteProfile,
  type ValidatedProfileResult,
  type ValidatedSiteProfile,
} from './contracts.js';
import { validateControlDocument } from './control-schema-validator.js';

/** 検証の文脈。参照するターゲット JSON を読み込んだ結果（`loadConfig` の結果）を、呼び出し側が渡す。 */
export interface ProfileValidationContext {
  readonly targetConfig: AuditConfig;
}

/** モードごとに受ける環境（設計書 4.3 の表）。表にない組み合わせは `PROFILE_MODE_ENVIRONMENT_MISMATCH`。 */
const ENVIRONMENTS_BY_MODE: Readonly<Record<AuditMode, readonly EnvironmentKind[]>> = Object.freeze({
  PUBLIC_PASSIVE: Object.freeze(['PUBLIC', 'TEST'] as const),
  TEST_AUTH_PASSIVE: Object.freeze(['TEST'] as const),
  TEST_APPROVED_WRITE: Object.freeze(['TEST'] as const),
});

/** モードごとに受ける認証の方式（設計書 4.3 の表）。表にない組み合わせは `PROFILE_AUTH_MISMATCH`。 */
const AUTH_STRATEGIES_BY_MODE: Readonly<Record<AuditMode, readonly AuthStrategy[]>> = Object.freeze({
  PUBLIC_PASSIVE: Object.freeze(['NONE'] as const),
  TEST_AUTH_PASSIVE: Object.freeze(['MANUAL_SESSION', 'AUTOMATED_LOGIN'] as const),
  TEST_APPROVED_WRITE: Object.freeze(['MANUAL_SESSION', 'AUTOMATED_LOGIN'] as const),
});

/** テスト環境の Origin と環境の証拠を必須にするモード（認証・書き込みのモード）。 */
const TEST_ORIGIN_MODES: readonly AuditMode[] = Object.freeze(['TEST_AUTH_PASSIVE', 'TEST_APPROVED_WRITE'] as const);

/** 環境の証拠を持たない環境（公開の環境）。 */
const ENVIRONMENT_WITHOUT_EVIDENCE: EnvironmentKind = 'PUBLIC';

/** プロファイルが参照してよいターゲット JSON のディレクトリ（区切りは `/`。末尾の `/` を含む）。 */
const TARGET_CONFIG_DIRECTORIES: readonly string[] = Object.freeze(['config/targets/', 'local/targets/']);

/** ターゲット JSON の拡張子。 */
const TARGET_CONFIG_EXTENSION = '.json';

/** 親の区切り（`..`）。名前の中にあっても拒む（fail-closed）。 */
const PARENT_SEGMENT = '..';

/** ドライブ名と NTFS の代替データストリームの区切り。パスのどこにあっても拒む。 */
const DRIVE_OR_STREAM_SEPARATOR = ':';

/** テスト環境の `https:` の scheme（`URL.protocol` の値）。`http:` は loopback の host だけ（ロードマップ 1.3）。 */
const HTTPS_PROTOCOL = 'https:';

/** ターゲット JSON への相対パスに使える文字の全体（ASCII の英数字と `.`、`_`、`/`、`-`。T22d。T22R の M4）。 */
const TARGET_CONFIG_PATH_CHARACTERS = /^[A-Za-z0-9._/-]+$/u;

/**
 * 環境の証拠の参照で、見えない文字（T22d。T22R の M1）: 空白（`\s`。`String.prototype.trim` が除く文字）と、ゼロ幅の文字
 * （U+200B〜U+200D、U+2060、U+FEFF）。これらだけの値は、空と同じに扱う。
 */
const EVIDENCE_INVISIBLE_CHARACTERS = /[\s\u200b-\u200d\u2060\ufeff]/gu;

/** 旧ターゲット JSON の `target.id` から `profileId` を作れないときの、決まった値。 */
export const LEGACY_FALLBACK_PROFILE_ID = 'legacy-target';

/** `PROFILE_ID_PATTERN` が受ける最大の長さ（先頭の 1 文字と、続く最大 62 文字）。 */
const MAX_PROFILE_ID_LENGTH = 63;

/** `profileId` に書けない文字（小文字の英数字とハイフン以外）。 */
const PROFILE_ID_FORBIDDEN_CHARACTERS = /[^a-z0-9-]/gu;
const PROFILE_ID_HYPHEN_RUNS = /-{2,}/gu;
const PROFILE_ID_LEADING_HYPHENS = /^-+/u;
const PROFILE_ID_SEPARATOR = '-';

const errorOf = (code: ProfileValidationErrorCode, detail: string): ProfileValidationError => Object.freeze({ code, detail });

const rejected = (errors: readonly ProfileValidationError[]): ValidatedProfileResult =>
  Object.freeze({ ok: false, errors: Object.freeze([...errors]) });

/**
 * `validateSiteProfile` が受けたプロファイル（凍結した写し）の閉じた一覧（T22d。T22R の I1）。このファイルの外から加えられない。
 * `assertProfileRevisionAdvance` は、次の改訂がこの一覧にあるときだけ受ける（型の変換で印を付けた値を拒否する）。
 */
const validatedProfiles = new WeakSet<object>();

/** 受けたプロファイルを凍結し、閉じた一覧に加えて、印の型で返す。 */
const accepted = (profile: SiteProfile): ValidatedProfileResult => {
  const frozen = deepFreeze(profile);
  validatedProfiles.add(frozen);
  return Object.freeze({ ok: true, profile: frozen as ValidatedSiteProfile });
};

/**
 * ターゲット JSON への相対パスとして受けるか（設計書 4.3）。使える文字は ASCII の `[A-Za-z0-9._/-]` だけ（T22d）。
 * 区切りは `/` の相対パス（`isPortableRelativeArtifactPath` の規則: 空・`.`・`..` の区切り、絶対パス、ドライブ名と scheme の接頭辞、
 * `\`、制御文字を含まない）で、`..` と `:` をどこにも含まず、`config/targets/` か `local/targets/` の下の、名前のある `.json`。
 * 公開する（T23c round 1）: 保存の部品は、呼び出し側がターゲット JSON を読む関数（`resolveContext`）を呼ぶ前に、この確かめを行う
 * （通らないパスのファイルを読ませない。判定の owner はここだけ）。
 */
export const isAcceptedTargetConfigPath = (path: string): boolean => {
  if (
    !TARGET_CONFIG_PATH_CHARACTERS.test(path)
    || !isPortableRelativeArtifactPath(path)
    || path.includes(PARENT_SEGMENT)
    || path.includes(DRIVE_OR_STREAM_SEPARATOR)
  ) {
    return false;
  }
  const directory = TARGET_CONFIG_DIRECTORIES.find((candidate) => path.startsWith(candidate));
  if (directory === undefined || !path.endsWith(TARGET_CONFIG_EXTENSION)) {
    return false;
  }
  const fileName = path.slice(path.lastIndexOf('/') + 1);
  return path.length > directory.length && fileName.length > TARGET_CONFIG_EXTENSION.length;
};

/** テスト環境の Origin として受ける形か: HTTP(S) の Origin の正規の直列化で、`https:` か、`http:` なら loopback の host。 */
const isAcceptedTestOriginForm = (value: string): boolean => {
  const canonical = canonicalHttpOriginOf(value);
  if (canonical === undefined) {
    return false;
  }
  const url = new URL(canonical);
  return url.protocol === HTTPS_PROTOCOL || isLoopbackUrl(url);
};

/**
 * 環境の証拠の参照として使えるか: UTF-16 のコード単位で `MAX_ENVIRONMENT_EVIDENCE_REF_LENGTH` 以下（スキーマの maxLength は
 * コードポイントで数えるので、ここで数え直す）、空白とゼロ幅の文字だけでない、制御文字・行と段落の区切り・向きを変える文字を
 * 含まない、対になっていないサロゲートを含まない（T22d。T22R の M1）。書けない文字は `src/core/text.ts` の判定を使う: 制御文字
 * （Cc）と行・段落の区切り（Zl、Zp。U+2028、U+2029）は `hasControlOrLineSeparator`、向きを変える文字は `hasBidiControl`（CCX-3 の
 * 設計者の判断で、ALM（U+061C）を含む）。
 */
const isUsableEvidenceRef = (value: string): boolean =>
  value.length <= MAX_ENVIRONMENT_EVIDENCE_REF_LENGTH
  && !hasLoneSurrogate(value)
  && value.replace(EVIDENCE_INVISIBLE_CHARACTERS, '').length > 0
  && !hasControlOrLineSeparator(value)
  && !hasBidiControl(value);

/** 組み合わせの表（環境 × モード × 認証）の誤り。 */
const combinationErrors = (profile: SiteProfile): readonly ProfileValidationError[] => {
  const errors: ProfileValidationError[] = [];
  if (!ENVIRONMENTS_BY_MODE[profile.mode].includes(profile.environment)) {
    errors.push(errorOf('PROFILE_MODE_ENVIRONMENT_MISMATCH', `mode ${profile.mode} is not allowed in environment ${profile.environment}`));
  }
  if (!AUTH_STRATEGIES_BY_MODE[profile.mode].includes(profile.auth)) {
    errors.push(errorOf('PROFILE_AUTH_MISMATCH', `auth ${profile.auth} is not allowed for mode ${profile.mode}`));
  }
  return errors;
};

/** テスト環境の Origin の誤り。 */
const testOriginErrors = (profile: SiteProfile, context: ProfileValidationContext): readonly ProfileValidationError[] => {
  const values = profile.approvedTestOrigins;
  if (!TEST_ORIGIN_MODES.includes(profile.mode)) {
    return values.length === 0
      ? []
      : [errorOf('PROFILE_TEST_ORIGIN_INVALID', `approvedTestOrigins must be empty for mode ${profile.mode}`)];
  }
  if (values.length === 0) {
    return [errorOf('PROFILE_TEST_ORIGINS_REQUIRED', `approvedTestOrigins must list at least one origin for mode ${profile.mode}`)];
  }
  const errors: ProfileValidationError[] = [];
  values.forEach((value, index) => {
    if (!isAcceptedTestOriginForm(value)) {
      errors.push(errorOf(
        'PROFILE_TEST_ORIGIN_INVALID',
        `approvedTestOrigins[${index}] must be a canonical https origin, or an http origin on a loopback host`,
      ));
    } else if (!isOriginInAllowedOrigins(context.targetConfig.site.allowedOrigins, value)) {
      errors.push(errorOf(
        'PROFILE_TEST_ORIGIN_OUTSIDE_TARGET',
        `approvedTestOrigins[${index}] is not included in site.allowedOrigins of the target configuration`,
      ));
    }
  });
  return errors;
};

/** 環境の証拠の参照の誤り。 */
const evidenceErrors = (profile: SiteProfile): readonly ProfileValidationError[] => {
  const evidence = profile.environmentEvidenceRef;
  const errors: ProfileValidationError[] = [];
  if (evidence === null) {
    if (TEST_ORIGIN_MODES.includes(profile.mode)) {
      errors.push(errorOf('PROFILE_ENVIRONMENT_EVIDENCE_REQUIRED', `environmentEvidenceRef is required for mode ${profile.mode}`));
    }
  } else if (profile.environment === ENVIRONMENT_WITHOUT_EVIDENCE) {
    errors.push(errorOf('PROFILE_MODE_ENVIRONMENT_MISMATCH', `environmentEvidenceRef must be null in environment ${profile.environment}`));
  } else if (!isUsableEvidenceRef(evidence)) {
    errors.push(errorOf(
      'PROFILE_ENVIRONMENT_EVIDENCE_REQUIRED',
      `environmentEvidenceRef must be at most ${MAX_ENVIRONMENT_EVIDENCE_REF_LENGTH} UTF-16 code units, must not be blank or only `
        + 'zero width characters, and must not contain control characters, line breaks, bidirectional controls or lone surrogates',
    ));
  }
  return errors;
};

/** 値の規則（設計書 4.3）の誤り。形はスキーマで確かめ済み。 */
const ruleErrors = (profile: SiteProfile, context: ProfileValidationContext): readonly ProfileValidationError[] => {
  const errors: ProfileValidationError[] = [];
  if (!PROFILE_ID_PATTERN.test(profile.profileId)) {
    errors.push(errorOf('PROFILE_ID_INVALID', `profileId must match ${PROFILE_ID_PATTERN.source}`));
  }
  if (!Number.isSafeInteger(profile.revision) || profile.revision < MIN_PROFILE_REVISION) {
    errors.push(errorOf('PROFILE_SCHEMA_INVALID', `revision must be a safe integer of at least ${MIN_PROFILE_REVISION}`));
  }
  if (!isAcceptedTargetConfigPath(profile.targetConfigPath)) {
    errors.push(errorOf(
      'PROFILE_TARGET_PATH_INVALID',
      `targetConfigPath must be a relative path with "/" separators to a ${TARGET_CONFIG_EXTENSION} file under `
        + `${TARGET_CONFIG_DIRECTORIES.join(' or ')}`,
    ));
  }
  return [...errors, ...combinationErrors(profile), ...testOriginErrors(profile, context), ...evidenceErrors(profile)];
};

/**
 * プロファイルを検証する（設計書 4.2、4.3）。入力を複製してから確かめるので、受けたプロファイルは呼び出し側の値と参照を共有しない
 * （凍結した写し）。スキーマの形の誤りは `PROFILE_SCHEMA_INVALID` だけを返し、値の規則は形が正しいときだけ確かめる（スキーマが受ける
 * 値に、値の規則の `PROFILE_SCHEMA_INVALID` が当たる場合は、ほかの規則のコードと一緒に返す。例: 安全な整数の範囲を超える `revision`）。
 * 受けたプロファイルは、印の型（`ValidatedSiteProfile`）で返し、閉じた一覧 `validatedProfiles` に加える（T22d）。
 * `context` の形の誤り（`targetConfig.site.allowedOrigins` がないなど）は、呼び出し側の誤りとして `TypeError` を投げることがある。
 */
export const validateSiteProfile = (input: unknown, context: ProfileValidationContext): ValidatedProfileResult => {
  let copy: unknown;
  try {
    copy = structuredClone(input);
  } catch {
    return rejected([errorOf('PROFILE_SCHEMA_INVALID', 'profile must be a plain JSON value')]);
  }
  const shape = validateControlDocument('profile', copy);
  if (!shape.ok) {
    return rejected(shape.errors.map((error) => errorOf('PROFILE_SCHEMA_INVALID', error)));
  }
  const profile = copy as SiteProfile;
  const errors = ruleErrors(profile, context);
  return errors.length > 0 ? rejected(errors) : accepted(profile);
};

/**
 * 旧ターゲット JSON の `target.id` から、`PROFILE_ID_PATTERN` に合う `profileId` を作る。
 * 小文字にする → 小文字の英数字とハイフン以外を `-` にする → 続く `-` を 1 つにまとめる → 先頭の `-` を除く → 最大の長さで切る。
 * 結果が空か、パターンに合わなければ `LEGACY_FALLBACK_PROFILE_ID`。
 */
const legacyProfileIdOf = (targetId: string): string => {
  const candidate = targetId
    .toLowerCase()
    .replace(PROFILE_ID_FORBIDDEN_CHARACTERS, PROFILE_ID_SEPARATOR)
    .replace(PROFILE_ID_HYPHEN_RUNS, PROFILE_ID_SEPARATOR)
    .replace(PROFILE_ID_LEADING_HYPHENS, '')
    .slice(0, MAX_PROFILE_ID_LENGTH);
  return PROFILE_ID_PATTERN.test(candidate) ? candidate : LEGACY_FALLBACK_PROFILE_ID;
};

/**
 * プロファイルのない旧ターゲット JSON を、公開の監査（`PUBLIC_PASSIVE`・`NONE`・空の Origin・証拠なし）のプロファイルに解決する（I01）。
 * 権限を増やす入力を受けない。`targetConfigPath` は呼び出し側の値のまま（形は `validateSiteProfile` が判定する）。
 */
export const resolveLegacyTargetProfile = (config: AuditConfig, targetConfigPath: string): SiteProfile =>
  deepFreeze({
    schemaVersion: SITE_PROFILE_SCHEMA_VERSION,
    profileId: legacyProfileIdOf(config.target.id),
    revision: MIN_PROFILE_REVISION,
    targetConfigPath,
    environment: 'PUBLIC',
    mode: 'PUBLIC_PASSIVE',
    auth: 'NONE',
    approvedTestOrigins: [],
    environmentEvidenceRef: null,
  });

/** 改訂の確かめの片側（前か次）の写しと、形の誤り。写せない値は、写しが `undefined`。 */
interface RevisionSide {
  readonly copy: unknown;
  readonly errors: readonly ProfileValidationError[];
}

/**
 * 改訂の確かめの片側の写しを取り（`structuredClone`。Proxy・関数・Symbol などの写せない値は拒否）、写しの形をスキーマで確かめる。
 * 以後は写しだけを読む（getter や Proxy の罠を、確かめと比べる時とで 2 回呼ばない）。
 */
const revisionSideOf = (label: 'previous' | 'next', value: unknown): RevisionSide => {
  let copy: unknown;
  try {
    copy = structuredClone(value);
  } catch {
    return { copy: undefined, errors: [errorOf('PROFILE_SCHEMA_INVALID', `${label} profile must be a plain JSON value`)] };
  }
  const shape = validateControlDocument('profile', copy);
  return {
    copy,
    errors: shape.ok ? [] : shape.errors.map((error) => errorOf('PROFILE_SCHEMA_INVALID', `${label} profile: ${error}`)),
  };
};

/** 写しの自身のプロパティの値（写しがオブジェクトでないか、プロパティがなければ `undefined`）。 */
const ownFieldOf = (copy: unknown, key: keyof SiteProfile): unknown =>
  isRecord(copy) && Object.hasOwn(copy, key) ? copy[key] : undefined;

/** 比べてよい改訂の番号か: `MIN_PROFILE_REVISION` 以上の安全な整数（`NaN`、`Infinity`、小数、文字列、`null` を除く）。 */
const isComparableRevision = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= MIN_PROFILE_REVISION;

/** 改訂の番号と `profileId` の誤り（写しから読む）。前がないときは、次の番号が比べてよい値かだけを確かめる。 */
const revisionAdvanceErrors = (previous: RevisionSide | undefined, next: RevisionSide): readonly ProfileValidationError[] => {
  const nextRevision = ownFieldOf(next.copy, 'revision');
  if (previous === undefined) {
    return isComparableRevision(nextRevision)
      ? []
      : [errorOf('PROFILE_REVISION_NOT_ADVANCED', `revision must be a safe integer of at least ${MIN_PROFILE_REVISION}`)];
  }
  const errors: ProfileValidationError[] = [];
  if (ownFieldOf(previous.copy, 'profileId') !== ownFieldOf(next.copy, 'profileId')) {
    errors.push(errorOf('PROFILE_REVISION_NOT_ADVANCED', 'profileId differs from the previous revision'));
  }
  const previousRevision = ownFieldOf(previous.copy, 'revision');
  if (!isComparableRevision(previousRevision) || !isComparableRevision(nextRevision)) {
    errors.push(errorOf(
      'PROFILE_REVISION_NOT_ADVANCED',
      `both revisions must be safe integers of at least ${MIN_PROFILE_REVISION} to be compared`,
    ));
  } else if (nextRevision <= previousRevision) {
    errors.push(errorOf(
      'PROFILE_REVISION_NOT_ADVANCED',
      `revision ${nextRevision} must be greater than the previous revision ${previousRevision}`,
    ));
  }
  return errors;
};

/**
 * 同じ `profileId` の改訂として受けるか（設計書 4.2 の 3。T22d で T22R の I1 を直した）。責務は「改訂の確かめ」だけ。
 * - `next` は、`validateSiteProfile` が受けた値（閉じた一覧 `validatedProfiles` にある、凍結した写し）だけを受ける。型の変換で
 *   印を付けた値、写し、Proxy は `PROFILE_SCHEMA_INVALID`（組み合わせの規則を確かめていない昇格のプロファイルを受けない）。
 * - `next` と、`previous` が null でないときの `previous` は、写しを取ってスキーマで形を確かめる（写せない値と形の誤りは
 *   `PROFILE_SCHEMA_INVALID`）。`previous` は保存してあった値なので、組み合わせの規則は確かめない。
 * - 改訂の番号は、どちらも `MIN_PROFILE_REVISION` 以上の安全な整数で、次が前より大きいときだけ受ける。`profileId` が違うものと
 *   合わせて、それ以外は `PROFILE_REVISION_NOT_ADVANCED`。前がなければ、次の番号が比べてよい値かだけを確かめる。
 * - 例外を投げず、当たった誤りのすべてを返す。受けるときは `next`（凍結した、受けた値そのもの）を返す。
 */
export const assertProfileRevisionAdvance = (
  previous: SiteProfile | null,
  next: ValidatedSiteProfile,
): ValidatedProfileResult => {
  const previousSide = previous === null ? undefined : revisionSideOf('previous', previous);
  const nextSide = revisionSideOf('next', next);
  const errors: ProfileValidationError[] = [...(previousSide?.errors ?? []), ...nextSide.errors];
  if (!validatedProfiles.has(next)) {
    errors.push(errorOf('PROFILE_SCHEMA_INVALID', 'next profile must be a profile accepted by validateSiteProfile'));
  }
  errors.push(...revisionAdvanceErrors(previousSide, nextSide));
  return errors.length > 0 ? rejected(errors) : Object.freeze({ ok: true, profile: next });
};

/** 取り消しで進める改訂の数。 */
const RETIRED_REVISION_STEP = 1;

/**
 * 取り消しの次の改訂の写しを作る（T23c round 1。Task 23 の設計書 11 章）。改訂の数え方の owner をここ 1 つに保つ。
 * - `previous` は保存してあった値なので、写しを取って形（スキーマ）だけを確かめ、組み合わせの規則や今のターゲット設定では確かめない
 *   （`assertProfileRevisionAdvance` の `previous` と同じ扱い）。写せない値と形の誤りは `PROFILE_SCHEMA_INVALID`。
 * - 改訂の番号が `MIN_PROFILE_REVISION` 以上の安全な整数で、1 つ進めても安全な整数のときだけ受ける。それ以外は
 *   `PROFILE_REVISION_NOT_ADVANCED`。
 * - 受けるときは、改訂を 1 つ進めた凍結した写しを返す。`validatedProfiles` に入れない（`ValidatedSiteProfile` ではない）。
 * - 例外を投げない。
 */
export const retiredRevisionOf = (previous: SiteProfile): ProfileValidationResult => {
  const side = revisionSideOf('previous', previous);
  if (side.errors.length > 0) {
    return rejected(side.errors);
  }
  const revision = ownFieldOf(side.copy, 'revision');
  if (!isComparableRevision(revision) || !Number.isSafeInteger(revision + RETIRED_REVISION_STEP)) {
    return rejected([errorOf(
      'PROFILE_REVISION_NOT_ADVANCED',
      `revision must be a safe integer of at least ${MIN_PROFILE_REVISION} that can be advanced by ${RETIRED_REVISION_STEP}`,
    )]);
  }
  const profile: SiteProfile = deepFreeze({ ...(side.copy as SiteProfile), revision: revision + RETIRED_REVISION_STEP });
  return Object.freeze({ ok: true, profile });
};
