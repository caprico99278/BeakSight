// 資格情報のファイルの唯一の owner（Task 26 の設計書 4.1、4.2 の変更の種類、4.7、10 章の 1。T26a）。
// - 場所: `<リポジトリの根>/local/secrets/<profileId>.credential.json`（`resolveCredentialDirectory`。`local/` は Git の管理の外）。
//   資格情報のフォルダの名前（`CREDENTIAL_DIRECTORY_NAME`）を定義するのは、このファイルだけ（`tests/architecture/credential-boundary.test.ts`）。
// - 形: `beaksight-credential/1`（`schemas/control/credential-file.schema.json`）。値は、ユーザー名とパスワードを別々に DPAPI で暗号化した
//   暗号文だけを持つ。entropy は `beaksight-credential/1|<profileId>|<loginOrigin>|<username か password>`（項目ごとに別。ほかのプロファイル・
//   Origin への付け替えと、ユーザー名とパスワードの入れ替えでは戻せない）。
// - 権限（Windows だけ）: フォルダがなければ作り、中に書く前に、icacls（絶対パス）で継承を外し、今の利用者の SID だけに完全な権限を与える。
//   書く前に毎回、フォルダの所有者が今の利用者で、許可が今の利用者だけであることを読んで確かめ、違えば書かない（`CREDENTIAL_STORAGE_UNSAFE`）。
//   SID と許可は、固定の文の PowerShell（.NET の `WindowsIdentity`・`DirectorySecurity`。SID で返すので、表示の言語に依らない）で読む。
//   Windows 以外では、保存の操作をすべて拒む（`CREDENTIAL_PLATFORM_UNSUPPORTED`）。
// - 置き換え: 同じフォルダに一時のファイル（`temporaryPathFor`）を `wx` で作り、書いて fsync して閉じてから、本体へ rename する。rename が
//   一時的な失敗で失敗したら、短く待って決まった回数だけやり直し（`src/core/rename-retry.ts` の `renameWithRetry`）、だめなら一時のファイルを消し、古いファイルを残したまま
//   `CREDENTIAL_REPLACE_FAILED` で失敗にする。`credentialRevision` は、置き換えが成功したときだけ 1 上がる。読む側は `readFile`（開いてすぐ閉じる）。
// - リンクの拒否（T26R の M1）: 読む前（`readMetadata`、`decrypt`）と書く前（登録、変更、入れ直し、削除、一時のファイルの片付け）に、
//   `local` と `local/secrets` がリンク（junction、symlink。Windows の `lstat` は junction を `isSymbolicLink()` で返すことを実機で確かめた）で
//   ない本物のフォルダであること、資格情報のファイルが普通のファイルで symlink でなく、リンクの数が 1（ハードリンクでない）であることを、
//   リポジトリの根から区切りごとに `lstat` で確かめる（既存の `inspectRealArtifactEntry`）。外れたら `CREDENTIAL_STORAGE_UNSAFE`（読み出しでも
//   値を返さない）。確かめてから使うまでの間に入れ替えられる競争（TOCTOU）は、完全には防げない（同じ Windows の利用者の権限を持つ
//   プログラムなら入れ替えられる。手順書 `doc/spec/automated-login.md` の受け入れる危険）。
// - 一部の変更では、選ばなかった方の暗号文をそのまま写し、復号しない。保存した `loginOrigin` が今の Origin と違えば拒む（`CREDENTIAL_STALE`）。
// - 誤りは、固定のコードの閉じた一覧（`CREDENTIAL_STORE_ERROR_CODES`）と項目の名前だけ。値を入れない。暗号化の誤りは、暗号化の部品の
//   `CredentialProtectionError` のまま返す。
// - 本番の入口（`createCredentialStore(repoRoot)`）は、本物の暗号化の部品・子プロセス・時刻を使う。テストは `createCredentialStoreWith` に
//   偽物を渡す。
import { mkdir, open, readdir, readFile, rename, rm, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { inspectRealArtifactEntry, type RealArtifactEntry } from '../../core/contained-artifact-file.js';
import { resolveTimeoutMs, wait } from '../../core/deadline.js';
import { errorCodeOf } from '../../core/errors.js';
import { deepFreeze } from '../../core/immutable.js';
import { renameWithRetry } from '../../core/rename-retry.js';
import { isTemporaryFileName, temporaryPathFor } from '../../core/temporary-file-name.js';
import { hasLoneSurrogate } from '../../core/text.js';
import { formatCompactUtcTimestamp } from '../../core/utc-timestamp.js';
import { canonicalHttpOriginOf } from '../../crawl/normalize-url.js';
import { PROFILE_ID_PATTERN } from '../contracts.js';
import { validateControlDocument } from '../control-schema-validator.js';
import { CREDENTIAL_PLATFORM } from './credential-platform.js';
import {
  CREDENTIAL_PROCESS_TIMEOUT_MS,
  CREDENTIAL_SCRIPT_FAILURE_EXIT_CODE,
  WINDOWS_POWERSHELL_PATH,
  createDpapiCredentialProtector,
  powerShellArgumentsFor,
  runCredentialProcess,
  spawnCredentialProcess,
  type CredentialProcessSpawner,
  type CredentialProtector,
} from './dpapi-protector.js';

// ---------------------------------------------------------------------------------------------------------------
// 名前つきの定数と閉じた一覧
// ---------------------------------------------------------------------------------------------------------------

/** 資格情報のフォルダの親（リポジトリの根の直下。Git の管理の外）。 */
export const CREDENTIAL_PARENT_DIRECTORY_NAME = 'local';

/** 資格情報のフォルダの名前（`local/` の直下）。 */
export const CREDENTIAL_DIRECTORY_NAME = 'secrets';

/** 資格情報のファイルの名前の末尾（`<profileId>.credential.json`）。 */
export const CREDENTIAL_FILE_SUFFIX = '.credential.json';

/** ファイルの形の名前（entropy の先頭にも使う）。 */
export const CREDENTIAL_FILE_FORMAT = 'beaksight-credential/1';

/** 暗号化の方式（Windows の DPAPI の CurrentUser）。 */
export const CREDENTIAL_PROTECTION_KIND = 'DPAPI_CURRENT_USER';

/** 最後の変更の種類（閉じた一覧。設計書 4.2）。 */
export const CREDENTIAL_CHANGE_KINDS = Object.freeze(['CREATED', 'USERNAME_CHANGED', 'PASSWORD_CHANGED', 'BOTH_CHANGED'] as const);
export type CredentialChangeKind = (typeof CREDENTIAL_CHANGE_KINDS)[number];

/** 暗号化する項目（entropy の末尾）。 */
export const CREDENTIAL_FIELDS = Object.freeze(['username', 'password'] as const);
export type CredentialField = (typeof CREDENTIAL_FIELDS)[number];

/** 暗号化の往復の確かめの結果（値は返さない）。 */
export const CREDENTIAL_PROTECTION_STATES = Object.freeze(['AVAILABLE', 'UNAVAILABLE'] as const);
export type CredentialProtectionState = (typeof CREDENTIAL_PROTECTION_STATES)[number];

/** ユーザー名とパスワードの長さの上限（UTF-16 の単位）。 */
export const MAX_CREDENTIAL_VALUE_LENGTH = 256;

/** 読む資格情報のファイルの大きさの上限（バイト）。超えたら壊れたファイルとみなす。 */
export const MAX_CREDENTIAL_FILE_BYTES = 65_536;

/** `local/secrets`（リポジトリの根からの相対。区切りは `/`。リンクの確かめ `inspectRealArtifactEntry` に渡す）。 */
const CREDENTIAL_DIRECTORY_RELATIVE_PATH = `${CREDENTIAL_PARENT_DIRECTORY_NAME}/${CREDENTIAL_DIRECTORY_NAME}`;

/** 資格情報のファイルに許すリンクの数（ハードリンクを拒む。`lstat` の bigint の `nlink` と比べる。T26R の M1）。 */
const CREDENTIAL_FILE_LINK_COUNT = 1n;

/** 最初の改訂の番号。 */
const FIRST_CREDENTIAL_REVISION = 1;

// rename のやり直しの決まり（失敗のコード、回数、待ち）は、成果物の書き出しと共用するため、`src/core/rename-retry.ts` の
// `renameWithRetry` に移した（CC-062。CCX-11）。

/** icacls の絶対パス（PATH の検索をしない）。 */
export const ICACLS_PATH = 'C:\\Windows\\System32\\icacls.exe';

/** 完全な権限（`FileSystemRights.FullControl`）の値。 */
const FULL_CONTROL_RIGHTS = 2_032_127;
/** フォルダの中のファイルとフォルダへ受け継ぐ（`ContainerInherit` と `ObjectInherit`。icacls の `(OI)(CI)`）。 */
const CONTAINER_AND_OBJECT_INHERIT = 3;
/** 受け継ぎの伝わり方の指定なし（`PropagationFlags.None`）。 */
const NO_PROPAGATION = 0;

/** icacls の成功の終了コード。 */
const SUCCESS_EXIT_CODE = 0;

/** 暗号化の往復の確かめに使う、目印でない仮の値と entropy。 */
const PROTECTION_SELF_CHECK_TEXT = 'beaksight-credential-self-check';
const PROTECTION_SELF_CHECK_ENTROPY = `${CREDENTIAL_FILE_FORMAT}|self-check`;

/** 資格情報のファイルの部品の誤りのコード（閉じた一覧）。 */
export const CREDENTIAL_STORE_ERROR_CODES = Object.freeze([
  /** プロファイルの ID が `PROFILE_ID_PATTERN` に合わない。 */
  'CREDENTIAL_PROFILE_ID_INVALID',
  /** ログインの Origin が、HTTP(S) の Origin の正規の直列化でない。 */
  'CREDENTIAL_ORIGIN_INVALID',
  /** 値が空。 */
  'CREDENTIAL_VALUE_EMPTY',
  /** 値が `MAX_CREDENTIAL_VALUE_LENGTH` を超える。 */
  'CREDENTIAL_VALUE_TOO_LONG',
  /** 値が文字列でない、または対にならないサロゲートを含む。 */
  'CREDENTIAL_VALUE_MALFORMED',
  /** 一部の変更で、どちらの項目も選ばれていない。 */
  'CREDENTIAL_CHANGE_EMPTY',
  /** 新しく登録しようとしたが、ファイルがすでにある。 */
  'CREDENTIAL_ALREADY_EXISTS',
  /** ファイルがない。 */
  'CREDENTIAL_MISSING',
  /** 保存した Origin が今の Origin と違う（入れ直しが要る）。 */
  'CREDENTIAL_STALE',
  /** ファイルが壊れている（JSON でない、形が違う、プロファイルが違う、大きすぎる）。 */
  'CREDENTIAL_FILE_INVALID',
  /** ファイルやフォルダを読めない（ないことを除く）。 */
  'CREDENTIAL_READ_FAILED',
  /** Windows でないので、保存できない。 */
  'CREDENTIAL_PLATFORM_UNSUPPORTED',
  /** フォルダの所有者か許可が、今の利用者だけでない（確かめられない場合を含む）。書かない。 */
  'CREDENTIAL_STORAGE_UNSAFE',
  /** 置き換えができなかった（古いファイルはそのまま）。 */
  'CREDENTIAL_REPLACE_FAILED',
  /** 削除ができなかった。 */
  'CREDENTIAL_DELETE_FAILED',
] as const);
export type CredentialStoreErrorCode = (typeof CREDENTIAL_STORE_ERROR_CODES)[number];

/** 資格情報のファイルの部品の誤り。持つのは固定のコードと項目の名前だけ（値を持たない）。 */
export class CredentialStoreError extends Error {
  readonly code: CredentialStoreErrorCode;
  /** 値の決まりの誤りの項目（ほかの誤りでは `null`）。 */
  readonly field: CredentialField | null;

  constructor(code: CredentialStoreErrorCode, field: CredentialField | null = null) {
    super(field === null ? `credential store error (${code})` : `credential store error (${code}, ${field})`);
    this.name = 'CredentialStoreError';
    this.code = code;
    this.field = field;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// 形
// ---------------------------------------------------------------------------------------------------------------

/** 資格情報のファイル（`beaksight-credential/1`）。`username` と `password` は暗号文（base64）。 */
export interface CredentialFileDocument {
  readonly format: typeof CREDENTIAL_FILE_FORMAT;
  readonly profileId: string;
  readonly loginOrigin: string;
  readonly credentialRevision: number;
  /** UTC の 14 桁。 */
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastChangeKind: CredentialChangeKind;
  readonly protection: typeof CREDENTIAL_PROTECTION_KIND;
  readonly username: string;
  readonly password: string;
}

/** 秘密でない項目だけ（画面とジョブの確かめが読む）。 */
export type CredentialMetadata = Omit<CredentialFileDocument, 'format' | 'username' | 'password'>;

/** 復号した値（ワーカーだけが使う。使った後にすぐ捨てる）。 */
export interface DecryptedCredential {
  readonly credentialRevision: number;
  readonly username: string;
  readonly password: string;
}

/** 新しく登録・すべて入れ直しの入力（両方の値が必須）。 */
export interface CredentialReplaceInput {
  readonly profileId: string;
  readonly loginOrigin: string;
  readonly username: string;
  readonly password: string;
}

/** 一部の変更の入力（変える項目だけを渡す。どちらもなければ拒む）。 */
export interface CredentialChangeInput {
  readonly profileId: string;
  /** 今の認証の設定のログインの Origin（保存した Origin と違えば拒む）。 */
  readonly loginOrigin: string;
  readonly username?: string;
  readonly password?: string;
}

/** 資格情報のファイルの部品。 */
export interface CredentialStore {
  /** 資格情報のフォルダ（絶対パス）。 */
  readonly directory: string;
  register(input: CredentialReplaceInput): Promise<CredentialMetadata>;
  replaceAll(input: CredentialReplaceInput): Promise<CredentialMetadata>;
  change(input: CredentialChangeInput): Promise<CredentialMetadata>;
  readMetadata(profileId: string): Promise<CredentialMetadata | null>;
  decrypt(profileId: string, loginOrigin: string): Promise<DecryptedCredential>;
  remove(profileId: string): Promise<boolean>;
  removeTemporaryFiles(): Promise<number>;
  checkProtection(): Promise<CredentialProtectionState>;
}

/** ファイルの部品の内部の作り（テストが偽物を渡す）。 */
export interface CredentialStoreDependencies {
  readonly protector: CredentialProtector;
  readonly spawnProcess: CredentialProcessSpawner;
  readonly now: () => Date;
  /** 実行している環境（`process.platform` の値）。 */
  readonly platform: string;
  /** 一時のファイルを本体へ移す関数（本番は `rename`）。 */
  readonly renameFile: (from: string, to: string) => Promise<void>;
  /** rename をやり直す前の待ち（本番は `wait`）。 */
  readonly waitBeforeRetry: (delayMs: number) => Promise<void>;
  /** 子プロセスを待つ時間の上限（ms。既定は `CREDENTIAL_PROCESS_TIMEOUT_MS`）。 */
  readonly processTimeoutMs?: number;
}

// ---------------------------------------------------------------------------------------------------------------
// 場所と entropy
// ---------------------------------------------------------------------------------------------------------------

/** 資格情報のフォルダ（絶対パス）。`repoRoot` は絶対パスで渡す（`resolveControlDatabasePath` と同じ）。 */
export const resolveCredentialDirectory = (repoRoot: string): string => {
  if (typeof repoRoot !== 'string' || repoRoot.length === 0 || !isAbsolute(repoRoot)) {
    throw new RangeError('the repository root for the credential files must be an absolute path');
  }
  return join(repoRoot, CREDENTIAL_PARENT_DIRECTORY_NAME, CREDENTIAL_DIRECTORY_NAME);
};

/** プロファイルの資格情報のファイルの場所。`profileId` は `PROFILE_ID_PATTERN` に合うものだけ。 */
export const credentialFilePathFor = (directory: string, profileId: string): string => {
  if (!isProfileId(profileId)) {
    throw new CredentialStoreError('CREDENTIAL_PROFILE_ID_INVALID');
  }
  return join(directory, `${profileId}${CREDENTIAL_FILE_SUFFIX}`);
};

/** プロファイルの資格情報のファイルの、リポジトリの根からの相対パス（区切りは `/`。リンクの確かめに使う）。 */
const credentialRelativePathOf = (profileId: string): string =>
  `${CREDENTIAL_DIRECTORY_RELATIVE_PATH}/${profileId}${CREDENTIAL_FILE_SUFFIX}`;

/** 項目ごとの entropy。 */
export const credentialEntropyFor = (profileId: string, loginOrigin: string, field: CredentialField): string =>
  [CREDENTIAL_FILE_FORMAT, profileId, loginOrigin, field].join('|');

// ---------------------------------------------------------------------------------------------------------------
// 値の確かめ
// ---------------------------------------------------------------------------------------------------------------

const isProfileId = (value: unknown): value is string => typeof value === 'string' && PROFILE_ID_PATTERN.test(value);

const storeError = (code: CredentialStoreErrorCode, field: CredentialField | null = null): never => {
  throw new CredentialStoreError(code, field);
};

const requireProfileId = (profileId: unknown): string => (isProfileId(profileId) ? profileId : storeError('CREDENTIAL_PROFILE_ID_INVALID'));

const requireOrigin = (loginOrigin: unknown): string =>
  (typeof loginOrigin === 'string' && canonicalHttpOriginOf(loginOrigin) === loginOrigin ? loginOrigin : storeError('CREDENTIAL_ORIGIN_INVALID'));

/** 値の決まり（空でない、上限まで、対にならないサロゲートがない）。誤りは項目の名前だけを持つ。 */
const requireValue = (field: CredentialField, value: unknown): string => {
  if (typeof value !== 'string') {
    return storeError('CREDENTIAL_VALUE_MALFORMED', field);
  }
  if (value.length === 0) {
    return storeError('CREDENTIAL_VALUE_EMPTY', field);
  }
  if (value.length > MAX_CREDENTIAL_VALUE_LENGTH) {
    return storeError('CREDENTIAL_VALUE_TOO_LONG', field);
  }
  return hasLoneSurrogate(value) ? storeError('CREDENTIAL_VALUE_MALFORMED', field) : value;
};

const FILE_NOT_FOUND = 'ENOENT';
const ALREADY_EXISTS = 'EEXIST';

// ---------------------------------------------------------------------------------------------------------------
// 権限の読み取り（固定の文。フォルダのパスは stdin で渡す）
// ---------------------------------------------------------------------------------------------------------------

/**
 * フォルダの今の利用者の SID・所有者・継承の有無・許可（SID で）を読む固定の文。stdin の 1 行目にフォルダのパスの UTF-8 の base64 を
 * 受け、`USER`・`OWNER`・`PROTECTED`・`RULE`（SID、Allow か Deny、権限、受け継ぎ、伝わり方、受け継いだか）の行を stdout に書く。
 */
const STORAGE_ACCESS_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'try {',
  '  $target = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String([System.Console]::In.ReadLine()))',
  '  $sidType = [System.Security.Principal.SecurityIdentifier]',
  '  $security = [System.IO.Directory]::GetAccessControl($target)',
  '  $lines = New-Object System.Collections.Generic.List[string]',
  "  $lines.Add('USER ' + [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value)",
  "  $lines.Add('OWNER ' + $security.GetOwner($sidType).Value)",
  "  $lines.Add('PROTECTED ' + $security.AreAccessRulesProtected)",
  '  foreach ($rule in $security.GetAccessRules($true, $true, $sidType)) {',
  "    $lines.Add('RULE ' + $rule.IdentityReference.Value + ' ' + $rule.AccessControlType + ' ' + [int]$rule.FileSystemRights + ' ' + "
    + "[int]$rule.InheritanceFlags + ' ' + [int]$rule.PropagationFlags + ' ' + $rule.IsInherited)",
  '  }',
  '  [System.Console]::Out.Write([string]::Join([string][char]10, $lines))',
  '} catch {',
  `  exit ${CREDENTIAL_SCRIPT_FAILURE_EXIT_CODE}`,
  '}',
  `exit ${SUCCESS_EXIT_CODE}`,
].join('\n');
const STORAGE_ACCESS_ARGUMENTS = powerShellArgumentsFor(STORAGE_ACCESS_SCRIPT);

const SID_PATTERN = /^S-1-\d+(?:-\d+)+$/u;
const BOOLEAN_TEXT: Readonly<Record<string, boolean>> = Object.freeze({ True: true, False: false });
const ACCESS_TYPES: ReadonlySet<string> = new Set(['Allow', 'Deny']);
const NON_NEGATIVE_INTEGER_PATTERN = /^\d{1,10}$/u;

interface StorageRule {
  readonly sid: string;
  readonly type: string;
  readonly rights: number;
  readonly inheritance: number;
  readonly propagation: number;
  readonly inherited: boolean;
}

interface StorageAccess {
  readonly user: string;
  readonly owner: string;
  readonly protectedRules: boolean;
  readonly rules: readonly StorageRule[];
}

/** 一つの行（`<名前> <値…>`）の値の部分。名前が違えば `null`。 */
const fieldsOf = (line: string | undefined, name: string, count: number): readonly string[] | null => {
  const parts = (line ?? '').split(' ');
  return parts[0] === name && parts.length === count + 1 ? parts.slice(1) : null;
};

const ruleOf = (line: string): StorageRule | null => {
  const fields = fieldsOf(line, 'RULE', 6);
  if (fields === null) {
    return null;
  }
  const [sid = '', type = '', rights = '', inheritance = '', propagation = '', inherited = ''] = fields;
  const numbers = [rights, inheritance, propagation];
  if (!SID_PATTERN.test(sid) || !ACCESS_TYPES.has(type) || !numbers.every((text) => NON_NEGATIVE_INTEGER_PATTERN.test(text))
    || !Object.hasOwn(BOOLEAN_TEXT, inherited)) {
    return null;
  }
  return { sid, type, rights: Number(rights), inheritance: Number(inheritance), propagation: Number(propagation), inherited: BOOLEAN_TEXT[inherited] === true };
};

/** 権限の読み取りの出力を、厳しく読む。形が違えば `null`（安全でないとみなす）。 */
const parseStorageAccess = (stdout: string): StorageAccess | null => {
  const lines = stdout.replace(/\r?\n$/u, '').split('\n').map((line) => line.replace(/\r$/u, ''));
  const [user] = fieldsOf(lines[0], 'USER', 1) ?? [];
  const [owner] = fieldsOf(lines[1], 'OWNER', 1) ?? [];
  const [protectedText] = fieldsOf(lines[2], 'PROTECTED', 1) ?? [];
  if (user === undefined || owner === undefined || protectedText === undefined || !SID_PATTERN.test(user) || !SID_PATTERN.test(owner)
    || !Object.hasOwn(BOOLEAN_TEXT, protectedText)) {
    return null;
  }
  const rules = lines.slice(3).map(ruleOf);
  if (rules.some((rule) => rule === null)) {
    return null;
  }
  return { user, owner, protectedRules: BOOLEAN_TEXT[protectedText] === true, rules: rules.filter((rule) => rule !== null) };
};

/** 所有者が今の利用者で、継承を外してあり、許可が今の利用者の完全な権限（中へ受け継ぐ）だけか。 */
const isOnlyCurrentUser = (access: StorageAccess): boolean =>
  access.protectedRules
  && access.owner === access.user
  && access.rules.length > 0
  && access.rules.every((rule) => rule.sid === access.user && rule.type === 'Allow' && !rule.inherited)
  && access.rules.some((rule) => rule.rights === FULL_CONTROL_RIGHTS && rule.inheritance === CONTAINER_AND_OBJECT_INHERIT
    && rule.propagation === NO_PROPAGATION);

// ---------------------------------------------------------------------------------------------------------------
// ファイルの部品
// ---------------------------------------------------------------------------------------------------------------

const metadataOf = (document: CredentialFileDocument): CredentialMetadata => deepFreeze({
  profileId: document.profileId,
  loginOrigin: document.loginOrigin,
  credentialRevision: document.credentialRevision,
  createdAt: document.createdAt,
  updatedAt: document.updatedAt,
  lastChangeKind: document.lastChangeKind,
  protection: document.protection,
});

/** ファイルの部品の内部の作り（テストが偽物を渡す）。本番は `createCredentialStore`。 */
export const createCredentialStoreWith = (repoRoot: string, dependencies: CredentialStoreDependencies): CredentialStore => {
  const directory = resolveCredentialDirectory(repoRoot);
  const parentDirectory = join(repoRoot, CREDENTIAL_PARENT_DIRECTORY_NAME);
  const timeoutMs = resolveTimeoutMs(dependencies.processTimeoutMs, CREDENTIAL_PROCESS_TIMEOUT_MS);
  const { protector, spawnProcess, now, platform, renameFile, waitBeforeRetry } = dependencies;

  /** 変更（登録・入れ直し・一部の変更・削除）を 1 つずつ行う（読んでから書くまでの間に、ほかの変更が入らない）。 */
  let queue: Promise<unknown> = Promise.resolve();
  const serialized = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = queue.then(operation, operation);
    queue = result.catch(() => undefined);
    return result;
  };

  const requireWindows = (): void => {
    if (platform !== CREDENTIAL_PLATFORM) {
      storeError('CREDENTIAL_PLATFORM_UNSUPPORTED');
    }
  };

  const timestamp = (): string => formatCompactUtcTimestamp(now(), 'credential change time');

  const readStorageAccess = async (): Promise<StorageAccess | null> => {
    const outcome = await runCredentialProcess(spawnProcess, {
      file: WINDOWS_POWERSHELL_PATH,
      args: STORAGE_ACCESS_ARGUMENTS,
      stdinText: `${Buffer.from(directory, 'utf8').toString('base64')}\n`,
      captureStdout: true,
      timeoutMs,
    });
    return outcome.kind === 'EXITED' && outcome.exitCode === SUCCESS_EXIT_CODE ? parseStorageAccess(outcome.stdout) : null;
  };

  /** 新しく作ったフォルダの継承を外し、今の利用者の SID だけに完全な権限を与える。 */
  const restrictNewDirectory = async (): Promise<void> => {
    const access = await readStorageAccess();
    if (access === null) {
      storeError('CREDENTIAL_STORAGE_UNSAFE');
      return;
    }
    const outcome = await runCredentialProcess(spawnProcess, {
      file: ICACLS_PATH,
      args: [directory, '/inheritance:r', '/grant:r', `*${access.user}:(OI)(CI)F`],
      stdinText: null,
      captureStdout: false,
      timeoutMs,
    });
    if (outcome.kind !== 'EXITED' || outcome.exitCode !== SUCCESS_EXIT_CODE) {
      storeError('CREDENTIAL_STORAGE_UNSAFE');
    }
  };

  /**
   * 資格情報の場所を、リポジトリの根から区切りごとに `lstat` で調べる（リンクをたどらない。`inspectRealArtifactEntry`）。調べられなければ
   * （パスの形の誤りを含む）`CREDENTIAL_STORAGE_UNSAFE`。
   */
  const inspectLocation = async (relativePath: string): Promise<RealArtifactEntry> => {
    try {
      return await inspectRealArtifactEntry(repoRoot, relativePath);
    } catch {
      return storeError('CREDENTIAL_STORAGE_UNSAFE');
    }
  };

  /** フォルダ（`local` か `local/secrets`）があるか。あれば、途中を含めてリンク（junction、symlink）でない本物のフォルダでなければ拒む。 */
  const directoryExists = async (relativePath: string): Promise<boolean> => {
    const entry = await inspectLocation(relativePath);
    if (entry.kind === 'MISSING') {
      return false;
    }
    return entry.kind === 'DIRECTORY' ? true : storeError('CREDENTIAL_STORAGE_UNSAFE');
  };

  /**
   * 資格情報のファイルがあるか。あれば、`local` と `local/secrets` がリンクでなく、ファイルが普通のファイル（symlink でない）で、リンクの数が
   * `CREDENTIAL_FILE_LINK_COUNT`（ハードリンクでない）でなければ拒む（T26R の M1）。
   */
  const credentialFileExists = async (profileId: string): Promise<boolean> => {
    const entry = await inspectLocation(credentialRelativePathOf(profileId));
    if (entry.kind === 'MISSING') {
      return false;
    }
    return entry.kind === 'FILE' && entry.stats.nlink === CREDENTIAL_FILE_LINK_COUNT ? true : storeError('CREDENTIAL_STORAGE_UNSAFE');
  };

  /** フォルダがなければ作って絞り、書く前の確かめ（リンクでないこと、所有者と許可が今の利用者だけ）をする。違えば `CREDENTIAL_STORAGE_UNSAFE`。 */
  const prepareDirectory = async (): Promise<void> => {
    if (!(await directoryExists(CREDENTIAL_PARENT_DIRECTORY_NAME))) {
      await mkdir(parentDirectory, { recursive: true }).catch(() => storeError('CREDENTIAL_STORAGE_UNSAFE'));
    }
    let created = false;
    try {
      await mkdir(directory);
      created = true;
    } catch (error) {
      if (errorCodeOf(error) !== ALREADY_EXISTS) {
        storeError('CREDENTIAL_STORAGE_UNSAFE');
      }
    }
    // 作った後にも、`local` と `local/secrets` がリンクでない本物のフォルダであることを確かめる。
    if (!(await directoryExists(CREDENTIAL_DIRECTORY_RELATIVE_PATH))) {
      storeError('CREDENTIAL_STORAGE_UNSAFE');
    }
    if (created) {
      await restrictNewDirectory();
    }
    const access = await readStorageAccess();
    if (access === null || !isOnlyCurrentUser(access)) {
      storeError('CREDENTIAL_STORAGE_UNSAFE');
    }
  };

  /** 書く前の確かめの後、同じフォルダの一時のファイルに書いて fsync し、本体へ rename する。失敗したら一時のファイルを消す。 */
  const writeDocument = async (document: CredentialFileDocument): Promise<CredentialMetadata> => {
    if (!validateControlDocument('credential-file', document).ok) {
      storeError('CREDENTIAL_FILE_INVALID');
    }
    await prepareDirectory();
    const path = credentialFilePathFor(directory, document.profileId);
    const temporaryPath = temporaryPathFor(path);
    try {
      const handle = await open(temporaryPath, 'wx');
      try {
        await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8' });
        await handle.sync();
      } finally {
        await handle.close();
      }
      await renameWithRetry(renameFile, waitBeforeRetry, temporaryPath, path);
    } catch {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      storeError('CREDENTIAL_REPLACE_FAILED');
    }
    return metadataOf(document);
  };

  /** 保存したファイルを読む（なければ `null`）。形・プロファイル・Origin・大きさを確かめる。 */
  const readDocument = async (profileId: string): Promise<CredentialFileDocument | null> => {
    if (!(await credentialFileExists(profileId))) {
      return null;
    }
    let content: Buffer;
    try {
      content = await readFile(credentialFilePathFor(directory, profileId));
    } catch (error) {
      return errorCodeOf(error) === FILE_NOT_FOUND ? null : storeError('CREDENTIAL_READ_FAILED');
    }
    if (content.length > MAX_CREDENTIAL_FILE_BYTES) {
      return storeError('CREDENTIAL_FILE_INVALID');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content.toString('utf8')) as unknown;
    } catch {
      return storeError('CREDENTIAL_FILE_INVALID');
    }
    if (!validateControlDocument('credential-file', parsed).ok) {
      return storeError('CREDENTIAL_FILE_INVALID');
    }
    const document = parsed as CredentialFileDocument;
    if (document.profileId !== profileId || canonicalHttpOriginOf(document.loginOrigin) !== document.loginOrigin) {
      return storeError('CREDENTIAL_FILE_INVALID');
    }
    return deepFreeze(document);
  };

  const requireDocument = async (profileId: string): Promise<CredentialFileDocument> =>
    (await readDocument(profileId)) ?? storeError('CREDENTIAL_MISSING');

  const protectField = (profileId: string, loginOrigin: string, field: CredentialField, value: string): Promise<string> =>
    protector.protect(value, credentialEntropyFor(profileId, loginOrigin, field));

  const replaceInputOf = (input: CredentialReplaceInput): CredentialReplaceInput => ({
    profileId: requireProfileId(input.profileId),
    loginOrigin: requireOrigin(input.loginOrigin),
    username: requireValue('username', input.username),
    password: requireValue('password', input.password),
  });

  /** 両方の値を暗号化して書く（登録と、すべて入れ直し）。 */
  const writeBoth = async (
    input: CredentialReplaceInput,
    previous: CredentialFileDocument | null,
  ): Promise<CredentialMetadata> => {
    const username = await protectField(input.profileId, input.loginOrigin, 'username', input.username);
    const password = await protectField(input.profileId, input.loginOrigin, 'password', input.password);
    const at = timestamp();
    return writeDocument({
      format: CREDENTIAL_FILE_FORMAT,
      profileId: input.profileId,
      loginOrigin: input.loginOrigin,
      credentialRevision: previous === null ? FIRST_CREDENTIAL_REVISION : previous.credentialRevision + 1,
      createdAt: previous === null ? at : previous.createdAt,
      updatedAt: at,
      lastChangeKind: previous === null ? 'CREATED' : 'BOTH_CHANGED',
      protection: CREDENTIAL_PROTECTION_KIND,
      username,
      password,
    });
  };

  return Object.freeze({
    directory,

    register(input: CredentialReplaceInput): Promise<CredentialMetadata> {
      return serialized(async () => {
        const checked = replaceInputOf(input);
        requireWindows();
        // リンクやハードリンクのファイルは、ある・なしの前に拒む（`CREDENTIAL_STORAGE_UNSAFE`）。
        if (await credentialFileExists(checked.profileId)) {
          storeError('CREDENTIAL_ALREADY_EXISTS');
        }
        return writeBoth(checked, null);
      });
    },

    replaceAll(input: CredentialReplaceInput): Promise<CredentialMetadata> {
      return serialized(async () => {
        const checked = replaceInputOf(input);
        requireWindows();
        return writeBoth(checked, await requireDocument(checked.profileId));
      });
    },

    change(input: CredentialChangeInput): Promise<CredentialMetadata> {
      return serialized(async () => {
        const profileId = requireProfileId(input.profileId);
        const loginOrigin = requireOrigin(input.loginOrigin);
        const username = input.username === undefined ? null : requireValue('username', input.username);
        const password = input.password === undefined ? null : requireValue('password', input.password);
        if (username === null && password === null) {
          storeError('CREDENTIAL_CHANGE_EMPTY');
        }
        requireWindows();
        const previous = await requireDocument(profileId);
        if (previous.loginOrigin !== loginOrigin) {
          storeError('CREDENTIAL_STALE');
        }
        // 選ばなかった方は、暗号文をそのまま写す（復号しない）。
        const usernameCipher = username === null ? previous.username : await protectField(profileId, loginOrigin, 'username', username);
        const passwordCipher = password === null ? previous.password : await protectField(profileId, loginOrigin, 'password', password);
        const lastChangeKind: CredentialChangeKind = username === null
          ? 'PASSWORD_CHANGED'
          : password === null ? 'USERNAME_CHANGED' : 'BOTH_CHANGED';
        return writeDocument({
          ...previous,
          credentialRevision: previous.credentialRevision + 1,
          updatedAt: timestamp(),
          lastChangeKind,
          username: usernameCipher,
          password: passwordCipher,
        });
      });
    },

    async readMetadata(profileId: string): Promise<CredentialMetadata | null> {
      const document = await readDocument(requireProfileId(profileId));
      return document === null ? null : metadataOf(document);
    },

    async decrypt(profileId: string, loginOrigin: string): Promise<DecryptedCredential> {
      const checkedProfileId = requireProfileId(profileId);
      const checkedOrigin = requireOrigin(loginOrigin);
      const document = await requireDocument(checkedProfileId);
      if (document.loginOrigin !== checkedOrigin) {
        storeError('CREDENTIAL_STALE');
      }
      const username = await protector.unprotect(document.username, credentialEntropyFor(checkedProfileId, checkedOrigin, 'username'));
      const password = await protector.unprotect(document.password, credentialEntropyFor(checkedProfileId, checkedOrigin, 'password'));
      try {
        return Object.freeze({
          credentialRevision: document.credentialRevision,
          username: requireValue('username', username),
          password: requireValue('password', password),
        });
      } catch {
        return storeError('CREDENTIAL_FILE_INVALID');
      }
    },

    remove(profileId: string): Promise<boolean> {
      return serialized(async () => {
        const checkedProfileId = requireProfileId(profileId);
        if (!(await credentialFileExists(checkedProfileId))) {
          return false;
        }
        const path = credentialFilePathFor(directory, checkedProfileId);
        try {
          await unlink(path);
          return true;
        } catch (error) {
          return errorCodeOf(error) === FILE_NOT_FOUND ? false : storeError('CREDENTIAL_DELETE_FAILED');
        }
      });
    },

    async removeTemporaryFiles(): Promise<number> {
      // リンクの先のフォルダの一時のファイルを消さない。
      if (!(await directoryExists(CREDENTIAL_DIRECTORY_RELATIVE_PATH))) {
        return 0;
      }
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        return errorCodeOf(error) === FILE_NOT_FOUND ? 0 : storeError('CREDENTIAL_READ_FAILED');
      }
      let removed = 0;
      for (const entry of entries) {
        if (entry.isFile() && isTemporaryFileName(entry.name) && entry.name.includes(CREDENTIAL_FILE_SUFFIX)) {
          await rm(join(directory, entry.name), { force: true });
          removed += 1;
        }
      }
      return removed;
    },

    async checkProtection(): Promise<CredentialProtectionState> {
      if (platform !== CREDENTIAL_PLATFORM) {
        return 'UNAVAILABLE';
      }
      try {
        const cipherText = await protector.protect(PROTECTION_SELF_CHECK_TEXT, PROTECTION_SELF_CHECK_ENTROPY);
        const plainText = await protector.unprotect(cipherText, PROTECTION_SELF_CHECK_ENTROPY);
        return plainText === PROTECTION_SELF_CHECK_TEXT ? 'AVAILABLE' : 'UNAVAILABLE';
      } catch {
        return 'UNAVAILABLE';
      }
    },
  });
};

/** ファイルの部品の本番の入口（リポジトリの根だけを受ける。本物の暗号化の部品・子プロセス・時刻を使う）。 */
export const createCredentialStore = (repoRoot: string): CredentialStore => createCredentialStoreWith(repoRoot, {
  protector: createDpapiCredentialProtector(),
  spawnProcess: spawnCredentialProcess,
  now: () => new Date(),
  platform: process.platform,
  renameFile: rename,
  waitBeforeRetry: wait,
});
