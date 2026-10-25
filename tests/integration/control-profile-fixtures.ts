// プロファイルの保存のテストの共通の値（Task 23 の T23c）。親のテストと、子 process（`control-profile-child.ts`）の両方が使う。
// - 例の値は匿名の値だけ（`example.invalid`、`config/targets/example.json` など）。
// - 子 process は TypeScript のソースを直接読む（Node の型の除去）。`.js` の指定子は、同じ名前の `.ts` に読み替える
//   （`module.registerHooks` の resolve。子 process の中だけで使う。本文は `tests/helpers/typescript-source-hook.ts`）。
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { SITE_PROFILE_SCHEMA_VERSION, type SiteProfile } from '../../src/control/contracts.js';
import type { ProfileValidationContext } from '../../src/control/profile-policy.js';
import type { ProfileContextResolver } from '../../src/control/store/profile-store.js';
import { createTestConfig } from '../helpers/test-config.js';
import { TYPESCRIPT_SOURCE_RESOLVE_HOOK } from '../helpers/typescript-source-hook.js';

export const TEST_ORIGIN = 'https://app.example.invalid';
/** ターゲット設定が変わった後に許される、別の Origin。 */
export const OTHER_TEST_ORIGIN = 'https://other.example.invalid';

/** 解決できるターゲット JSON のパス（テストの resolver が知るもの）。 */
export const PUBLIC_TARGET_PATH = 'config/targets/example.json';
export const SECOND_PUBLIC_TARGET_PATH = 'config/targets/example-second.json';
export const TEST_TARGET_PATH = 'local/targets/example-test.json';
/** resolver が知らないパス（形は正しい）。 */
export const UNKNOWN_TARGET_PATH = 'config/targets/unknown.json';

const KNOWN_TARGET_PATHS: ReadonlySet<string> = new Set([PUBLIC_TARGET_PATH, SECOND_PUBLIC_TARGET_PATH, TEST_TARGET_PATH]);

/** テストの検証の文脈（`TEST_ORIGIN` を許すターゲット）。 */
export const PROFILE_CONTEXT: ProfileValidationContext = Object.freeze({ targetConfig: createTestConfig(TEST_ORIGIN) });

/** 知っているパスだけを解決する resolver。 */
export const resolveTestContext: ProfileContextResolver = (targetConfigPath) =>
  KNOWN_TARGET_PATHS.has(targetConfigPath) ? PROFILE_CONTEXT : undefined;

/** ターゲット設定が変わった後の文脈（`TEST_ORIGIN` を許さず、`OTHER_TEST_ORIGIN` だけを許す）。 */
export const DRIFTED_CONTEXT: ProfileValidationContext = Object.freeze({ targetConfig: createTestConfig(OTHER_TEST_ORIGIN) });

/** ターゲット設定が変わった後の resolver（知っているパスに、変わった後の文脈を返す）。 */
export const resolveDriftedContext: ProfileContextResolver = (targetConfigPath) =>
  KNOWN_TARGET_PATHS.has(targetConfigPath) ? DRIFTED_CONTEXT : undefined;

/** 公開の監査のプロファイル。 */
export const publicProfile = (profileId: string, revision: number, targetConfigPath = PUBLIC_TARGET_PATH): SiteProfile => ({
  schemaVersion: SITE_PROFILE_SCHEMA_VERSION,
  profileId,
  revision,
  targetConfigPath,
  environment: 'PUBLIC',
  mode: 'PUBLIC_PASSIVE',
  auth: 'NONE',
  approvedTestOrigins: [],
  environmentEvidenceRef: null,
});

/** テスト環境の認証つきの読み取りのプロファイル。 */
export const testAuthProfile = (profileId: string, revision: number, origin = TEST_ORIGIN): SiteProfile => ({
  schemaVersion: SITE_PROFILE_SCHEMA_VERSION,
  profileId,
  revision,
  targetConfigPath: TEST_TARGET_PATH,
  environment: 'TEST',
  mode: 'TEST_AUTH_PASSIVE',
  auth: 'MANUAL_SESSION',
  approvedTestOrigins: [origin],
  environmentEvidenceRef: 'evidence/example-test-env/isolation-check-1',
});

/** テスト環境の書き込みのモードのプロファイル（T28b。モード以外は `testAuthProfile` と同じ）。 */
export const testWriteProfile = (profileId: string, revision: number, origin = TEST_ORIGIN): SiteProfile => ({
  ...testAuthProfile(profileId, revision, origin),
  mode: 'TEST_APPROVED_WRITE',
});

/** 子 process の始めに動かす本文（`.js` を `.ts` に読み替えてから、引数の 1 つ目のモジュールを読み込む）。 */
const TYPESCRIPT_CHILD_LOADER = `
${TYPESCRIPT_SOURCE_RESOLVE_HOOK}
await import(process.argv[1]);
`;

/** 子 process のモジュール（`control-profile-child.ts`）の URL。 */
export const PROFILE_CHILD_MODULE_URL = new URL('./control-profile-child.ts', import.meta.url).href;

/** TypeScript の子 process を起動する（標準入出力はパイプ）。`args` は子の `process.argv.slice(2)` になる。 */
export const spawnTypeScriptChild = (moduleUrl: string, args: readonly string[]): ChildProcessWithoutNullStreams =>
  spawn(process.execPath, ['--input-type=module', '-e', TYPESCRIPT_CHILD_LOADER, moduleUrl, ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

/** 子 process との決まり（標準入出力の 1 行ずつ）。 */
export const CHILD_PROTOCOL = Object.freeze({
  /** 子の動き: 命令を待って更新する／書き込みのトランザクションの途中で止まる／更新を繰り返す。 */
  serveMode: 'serve',
  holdMode: 'hold',
  loopMode: 'loop',
  /** 子 → 親: 開いて準備ができた。 */
  ready: 'READY',
  /** 親 → 子: `UPDATE <期待する今の改訂> <targetConfigPath>`。 */
  update: 'UPDATE',
  /** 親 → 子: 閉じて終わる。 */
  exit: 'EXIT',
  /** 子 → 親: 更新の結果（成功）。失敗は理由の値。 */
  updated: 'OK',
  /** 子 → 親: 書き込みのトランザクションの途中（この後は止まったまま）。 */
  inTransaction: 'IN_TRANSACTION',
  /** 子 → 親: 1 回の更新を終えた（`DONE <改訂>`）。 */
  done: 'DONE',
});

/** 子 process が更新するプロファイルの識別子。 */
export const CHILD_PROFILE_ID = 'example-shared';
