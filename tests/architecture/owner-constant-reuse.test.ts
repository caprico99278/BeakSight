/**
 * 持ち主の定数を読み直す Gate（PRE42-CC の組 1a。台帳の CC-109・N4-8a・CC-084）。判定は `fs`、正規表現、文字列の走査だけ
 * （`source-scan.ts` の `readTypeScriptFilesUnder`・`scanFile`・`findModuleReferences` を共用する）。近似の検査である。
 * - (a) プロファイルの状態の値 `ACTIVE`（取り消していないプロファイル）は、`src/control/store/profile-records.ts` の `ACTIVE_PROFILE_STATUS`
 *   だけに書く。ほかの production のファイル（`src/**`、画面の `apps/local-ui/src/**`）は、それを import して読む（CC-109・N4-8a。
 *   `'ACTIVE' satisfies ProfileStatus`、`const ACTIVE: ProfileStatus = 'ACTIVE'`、`status !== 'ACTIVE'` の書き写しの戻りを止める）。
 *   - 文字列 `ACTIVE` を別の意味で使うファイル（閉じた一覧。理由つき。使われなくなった除外も誤りにする）だけを除く。除いたファイルでも、
 *     プロファイルの状態の形（`.status` との比べ、`ProfileStatus` の型の値）は誤りにする。
 * - (a′) プロファイルの状態の値 `RETIRED`（取り消したプロファイル）も、(a) と同じ形で `RETIRED_PROFILE_STATUS` だけに書く（PRE42-CC の組 1b。
 *   CC-109 の `'RETIRED'`）。文字列 `RETIRED` を別の意味（改訂の履歴の変更の種類 `ProfileChangeKind` など）で使うファイルは、閉じた一覧で除く。
 * - (a″) 実行のロックの判定の結果（`judgeRunLock` の `ACTIVE`・`STALE`）は、`src/core/process-lock.ts` の `RUN_LOCK_STATES` と、そこから読む
 *   `ACTIVE_RUN_LOCK_STATE` だけに書く（PRE42-CC の組 R。CC-110）。`judgeRunLock` を使う owner の外のファイルは、判定の結果と状態の文字列を
 *   比べない（`judgeRunLock(…) === 'ACTIVE'`、`state === 'ACTIVE'` の書き写しの戻りを止める）。画面のサーバのロック（`instance-lock.ts`）と
 *   出力先の開始のロック（`output-start-lock.ts`）は、(a) の除外にも入れない。
 * - (b) 画面のサーバ（`apps/local-ui/src/server/**`）の今の時刻（管理データの UTC の 14 桁）は、`timestamps.ts` の `nowCompactTimestamp` だけが
 *   `formatCompactUtcTimestamp(new Date(), …)` で作る（CC-109 の後半。保存の口ごとの `nowStamp` の書き写しの戻りを止める）。
 * - (c) 成果物の名前の定数（`*_ARTIFACT_FILE_NAME`・`*_ARTIFACT_FILE_NAMES`）と、1 つの名前の定数の値（`action-run.json` など）は、
 *   `src/core/artifact-layout.ts` だけに書き、ほかのファイルで定義し直したり公開し直したりしない（CC-084。`write-job-start.ts` の公開し直しの
 *   戻りを止める。使う側は core から直接 import する）。
 * - (d)（PRE42-CC の組 2。CC-106）: シナリオの種類の閉じた一覧（`SCENARIO_KINDS`）と、値の名前つきの定数（`CREATE_SCENARIO_KIND`・
 *   `UPDATE_SCENARIO_KIND`）は、`src/core/scenario-kind.ts` だけに書く。ほかの production のファイルは、値 `CREATE`・`UPDATE` の名前つきの定数
 *   （`const UPDATE_KIND = 'UPDATE' satisfies ScenarioKind`、`'CREATE' satisfies ScenarioContent['kind']`、`: ScenarioKind = 'UPDATE'`）と
 *   一覧を定義し直さない（core から、またはシナリオの契約の公開し直しから読む）。除くファイルはない（LG-2 で、前の版の写しを固定していた
 *   `src/control/store/migrations.ts` の除外を消した）。型で確かめられる比べ（`kind === 'UPDATE'`）は数えない（近似）。
 * - (e)（PRE42-CC の組 2。CC-102 の気づき）: API のシナリオの欄の識別から値（名前か CSS）を取り出す形（`field.kind === 'NAME' ? field.name :
 *   field.selector`）は、`src/core/api-field-identity.ts` の `apiFieldIdentityValueOf` だけに書く（承認の digest と鍵と欄の対応の digest が使う）。
 *   画面の表示（名前と CSS で文言を分ける）は値を取り出す形でないので当たらない。
 * - `worker-protocol.ts` の `toWellFormed()`（PRE42-CC の組 2）の戻りは、`text-character-classes.test.ts` の `toWellFormed call`（組 4）が止める。
 * - 1 ファイル 1 秒以内に終える。本文の文字列で絞ってから走査する（走査は文字ずつで重いため。DEF-107）。
 */
import { describe, expect, it } from 'vitest';
import {
  ACTION_EVIDENCE_ARTIFACT_FILE_NAME,
  ACTION_REPORT_ARTIFACT_FILE_NAME,
  ACTION_RUN_ARTIFACT_FILE_NAME,
  APPROVAL_SUMMARY_ARTIFACT_FILE_NAME,
  DISCOVERY_ARTIFACT_FILE_NAME,
  ENTRY_CHECK_ARTIFACT_FILE_NAME,
  READ_EVIDENCE_ARTIFACT_FILE_NAME,
} from '../../src/core/artifact-layout.js';
import { ACTIVE_PROFILE_STATUS, RETIRED_PROFILE_STATUS } from '../../src/control/store/profile-records.js';
import {
  findModuleReferences,
  LOCAL_UI_SOURCE_DIRECTORY,
  MAX_GATE_MS,
  readTypeScriptFilesUnder,
  resolveRelativeSpecifier,
  scanFile,
  sourceFileOf,
  startCpuStopwatch,
  type SourceFile,
  type UnscannedFile,
} from './source-scan.js';

/** 1 つのファイルの判定の上限（ms。`source-scan.ts` の `MAX_GATE_MS`。PRE42-CC 組 G）。 */
const MAX_MS_PER_FILE = MAX_GATE_MS;

/** 対象の production のファイル（`src/**` と画面の `apps/local-ui/src/**` の `.ts`・`.tsx`）。読み込みは 1 回だけ。 */
const PRODUCTION_FILES: readonly UnscannedFile[] = [...readTypeScriptFilesUnder('src'), ...readTypeScriptFilesUnder(LOCAL_UI_SOURCE_DIRECTORY)];

// ---------------------------------------------------------------------------------------------------------------
// (a) プロファイルの状態 `ACTIVE`
// ---------------------------------------------------------------------------------------------------------------

const PROFILE_STATUS_OWNER = 'src/control/store/profile-records.ts';

/** 文字列 `ACTIVE` を、プロファイルの状態でない意味で使うファイル（閉じた一覧。理由つき）。 */
const OTHER_MEANING_FILES: Readonly<Record<string, string>> = Object.freeze({
  'src/core/process-lock.ts': '実行のロックの状態（`RUN_LOCK_STATES`）の owner',
  'src/orchestration/run-checkpoint-session.ts': 'チェックポイントのセッションの段階（`SessionPhase`）',
});

/** 除いたファイルでも誤りにする、プロファイルの状態の形（`.status` との比べ、`ProfileStatus` の型の値）。 */
const PROFILE_STATUS_SHAPES: readonly RegExp[] = [
  /\bstatus\s*[!=]==?\s*['"]ACTIVE['"]/u,
  /['"]ACTIVE['"]\s*[!=]==?\s*[\w$.?]*\bstatus\b/u,
  /['"]ACTIVE['"]\s*(?:satisfies|as)\s+ProfileStatus\b/u,
  /:\s*ProfileStatus\s*=\s*['"]ACTIVE['"]/u,
];

/** ファイルの、文字列 `ACTIVE` の数（文字列リテラルの中身がちょうど `ACTIVE` のもの。コメントは数えない）。 */
const activeLiteralCountOf = (file: Pick<SourceFile, 'literals'>): number =>
  file.literals.filter((literal) => literal === ACTIVE_PROFILE_STATUS).length;

/** 本文（コメントを除き、文字列を残した形）の行のうち、形に当たる行（`<path>:<行> <行の本文>`）。 */
const matchingCodeLines = (file: Pick<SourceFile, 'path' | 'code'>, shapes: readonly RegExp[]): readonly string[] =>
  file.code.split('\n').flatMap((line, index) =>
    (shapes.some((shape) => shape.test(line)) ? [`${file.path}:${String(index + 1)} ${line.trim()}`] : []));

/** 文字列 `ACTIVE` を書いたファイル（絞ってから走査する）。 */
const filesWithActiveText = (): readonly SourceFile[] =>
  PRODUCTION_FILES.filter(({ content }) => content.includes(ACTIVE_PROFILE_STATUS)).map((file) => scanFile(file));

// ---------------------------------------------------------------------------------------------------------------
// (a′) プロファイルの状態 `RETIRED`（PRE42-CC の組 1b）
// ---------------------------------------------------------------------------------------------------------------

/** 文字列 `RETIRED` を、プロファイルの状態でない意味で使うファイル（閉じた一覧。理由つき）。 */
const RETIRED_OTHER_MEANING_FILES: Readonly<Record<string, string>> = Object.freeze({
  'src/control/store/profile-store.ts': '改訂の履歴の変更の種類 `RETIRED`（`ProfileChangeKind`。`replaceRow` の `change_kind`）',
});

/** 除いたファイルでも誤りにする、プロファイルの状態 `RETIRED` の形（`.status` との比べ、`ProfileStatus` の型の値）。 */
const RETIRED_PROFILE_STATUS_SHAPES: readonly RegExp[] = [
  /\bstatus\s*[!=]==?\s*['"]RETIRED['"]/u,
  /['"]RETIRED['"]\s*[!=]==?\s*[\w$.?]*\bstatus\b/u,
  /['"]RETIRED['"]\s*(?:satisfies|as)\s+ProfileStatus\b/u,
  /:\s*ProfileStatus\s*=\s*['"]RETIRED['"]/u,
];

/** ファイルの、文字列 `RETIRED` の数（文字列リテラルの中身がちょうど `RETIRED` のもの。コメントは数えない）。 */
const retiredLiteralCountOf = (file: Pick<SourceFile, 'literals'>): number =>
  file.literals.filter((literal) => literal === RETIRED_PROFILE_STATUS).length;

/** 文字列 `RETIRED` を書いたファイル（絞ってから走査する）。 */
const filesWithRetiredText = (): readonly SourceFile[] =>
  PRODUCTION_FILES.filter(({ content }) => content.includes(RETIRED_PROFILE_STATUS)).map((file) => scanFile(file));

// ---------------------------------------------------------------------------------------------------------------
// (a″) 実行のロックの判定の結果（PRE42-CC の組 R。CC-110）
// ---------------------------------------------------------------------------------------------------------------

const RUN_LOCK_STATE_OWNER = 'src/core/process-lock.ts';
/** ロックの判定の結果と、状態の文字列との比べ（`judgeRunLock(…) === 'ACTIVE'`、`state === 'ACTIVE'`、その逆。`STALE` も）。 */
const RUN_LOCK_STATE_COMPARISON_SHAPES: readonly RegExp[] = [
  /\)\s*[!=]==?\s*['"](?:ACTIVE|STALE)['"]/u,
  /\bstate\s*[!=]==?\s*['"](?:ACTIVE|STALE)['"]/u,
  /['"](?:ACTIVE|STALE)['"]\s*[!=]==?\s*[\w$.?]*\bstate\b/u,
];

/** ロックの判定（`judgeRunLock`）を使う、owner の外のファイル（絞ってから走査する）。 */
const filesJudgingRunLocks = (): readonly SourceFile[] =>
  PRODUCTION_FILES.filter(({ path, content }) => path !== RUN_LOCK_STATE_OWNER && content.includes('judgeRunLock')).map((file) => scanFile(file));

// ---------------------------------------------------------------------------------------------------------------
// (b) 画面のサーバの今の時刻
// ---------------------------------------------------------------------------------------------------------------

const LOCAL_UI_SERVER_DIRECTORY = `${LOCAL_UI_SOURCE_DIRECTORY}/server/`;
const NOW_TIMESTAMP_OWNER = `${LOCAL_UI_SERVER_DIRECTORY}timestamps.ts`;
const NOW_TIMESTAMP_FUNCTION = 'formatCompactUtcTimestamp';
/** 今の時刻から管理データの日時を作る形（`formatCompactUtcTimestamp(new Date(), …)`）。 */
const NOW_COMPACT_TIMESTAMP_SHAPE = /\bformatCompactUtcTimestamp\s*\(\s*new\s+Date\s*\(\s*\)/u;

// ---------------------------------------------------------------------------------------------------------------
// (c) 成果物の名前
// ---------------------------------------------------------------------------------------------------------------

const ARTIFACT_LAYOUT_OWNER = 'src/core/artifact-layout.ts';
const ARTIFACT_NAME_TEXT = '_ARTIFACT_FILE_NAME';
/** 成果物の名前の定数の定義（`const X_ARTIFACT_FILE_NAME =`・`… NAMES =`）。 */
const ARTIFACT_NAME_DEFINITION = /\b(?:const|let|var)\s+[A-Z0-9_]*_ARTIFACT_FILE_NAMES?\s*[:=]/u;
/** 成果物の名前の定数の公開（`export { …X_ARTIFACT_FILE_NAME… }`。`from` のあるなしを問わない。`{ … }` は行をまたいでよい）。 */
const ARTIFACT_NAME_EXPORT = /\bexport\s*(?:type\s+)?\{[^}]*\b[A-Z0-9_]*_ARTIFACT_FILE_NAMES?\b[^}]*\}/gu;
/** 1 つの名前の定数の値（ほかのファイルの文字列リテラルに書かない）。 */
const SINGLE_ARTIFACT_FILE_NAMES: readonly string[] = Object.freeze([
  DISCOVERY_ARTIFACT_FILE_NAME,
  READ_EVIDENCE_ARTIFACT_FILE_NAME,
  ENTRY_CHECK_ARTIFACT_FILE_NAME,
  ACTION_RUN_ARTIFACT_FILE_NAME,
  ACTION_EVIDENCE_ARTIFACT_FILE_NAME,
  APPROVAL_SUMMARY_ARTIFACT_FILE_NAME,
  ACTION_REPORT_ARTIFACT_FILE_NAME,
]);
const ARTIFACT_LAYOUT_TARGET = ARTIFACT_LAYOUT_OWNER.replace(/\.ts$/u, '');

/** ファイルの、成果物の名前の定義・公開し直し・値の書き写し（`<path>: <中身>`）。 */
const artifactNameCopiesOf = (file: SourceFile): readonly string[] => [
  ...matchingCodeLines(file, [ARTIFACT_NAME_DEFINITION]),
  ...[...file.code.matchAll(ARTIFACT_NAME_EXPORT)].map((match) => `${file.path}: ${match[0].replace(/\s+/gu, ' ')}`),
  ...findModuleReferences(file.code)
    .filter((reference) => reference.statement?.keyword === 'export' && reference.wholeModule)
    .filter((reference) => resolveRelativeSpecifier(file.path, reference.specifier)?.replace(/\.[cm]?[jt]s$/u, '') === ARTIFACT_LAYOUT_TARGET)
    .map((reference) => `${file.path}: ${reference.text}`),
  ...file.literals.filter((literal) => SINGLE_ARTIFACT_FILE_NAMES.includes(literal)).map((literal) => `${file.path}: '${literal}'`),
];

/** 成果物の名前を書いたかもしれないファイル（絞ってから走査する）。 */
const filesWithArtifactNameText = (): readonly SourceFile[] =>
  PRODUCTION_FILES
    .filter(({ path }) => path !== ARTIFACT_LAYOUT_OWNER)
    .filter(({ content }) => content.includes(ARTIFACT_NAME_TEXT) || content.includes('artifact-layout')
      || SINGLE_ARTIFACT_FILE_NAMES.some((name) => content.includes(name)))
    .map((file) => scanFile(file));

// ---------------------------------------------------------------------------------------------------------------
// (d) シナリオの種類（PRE42-CC の組 2。CC-106）
// ---------------------------------------------------------------------------------------------------------------

const SCENARIO_KIND_OWNER = 'src/core/scenario-kind.ts';
/**
 * 前の版の写しを固定する決まりで、値を書き写すファイル（閉じた一覧。理由つき）。LG-2: 管理データの版 1〜16 の段と写しの定数を捨てたので、
 * `src/control/store/migrations.ts` の除外を消した（今は空。基準の版 17 の文は凍結の SQL の文字だけで、名前つきの定数を書かない）。
 */
const SCENARIO_KIND_FROZEN_COPY_FILES: Readonly<Record<string, string>> = Object.freeze({});
/** シナリオの種類の値の書き写しの形（名前つきの定数の定義・`satisfies` と `as` の型の値・一覧の定義し直し）。 */
const SCENARIO_KIND_COPY_SHAPES: readonly RegExp[] = [
  /\b(?:const|let|var)\s+[\w$]+\s*(?::[^=]+)?=\s*['"](?:CREATE|UPDATE)['"]/u,
  /['"](?:CREATE|UPDATE)['"]\s*(?:satisfies|as)\s+(?:ScenarioKind\b|ScenarioContent\s*\[\s*['"]kind['"]\s*\])/u,
  /\bSCENARIO_KINDS\s*=\s*Object\.freeze\s*\(/u,
];
/** 絞りの文字（どれかを書いたファイルだけを走査する）。 */
const SCENARIO_KIND_TEXTS: readonly string[] = ["'CREATE'", "'UPDATE'", '"CREATE"', '"UPDATE"', 'SCENARIO_KINDS'];

// ---------------------------------------------------------------------------------------------------------------
// (e) API の欄の識別の値（PRE42-CC の組 2。CC-102 の気づき）
// ---------------------------------------------------------------------------------------------------------------

const API_FIELD_IDENTITY_OWNER = 'src/core/api-field-identity.ts';
/** 欄の識別から値（名前か CSS）を取り出す形（`x.kind === 'NAME' ? x.name : x.selector` と、その逆）。 */
const API_FIELD_IDENTITY_VALUE_SHAPES: readonly RegExp[] = [
  /\.kind\s*[!=]==?\s*['"]NAME['"]\s*\?\s*[\w$.?]+\.name\s*:\s*[\w$.?]+\.selector\b/u,
  /\.kind\s*[!=]==?\s*['"]SELECTOR['"]\s*\?\s*[\w$.?]+\.selector\s*:\s*[\w$.?]+\.name\b/u,
];

describe('Architecture Gate: the owner constants are read, not copied (PRE42-CC group 1a, CC-109, N4-8a, CC-084)', () => {
  it('writes the profile status ACTIVE only in profile-records.ts (other files read ACTIVE_PROFILE_STATUS)', () => {
    const stopwatch = startCpuStopwatch();
    const files = filesWithActiveText();
    const owner = files.find(({ path }) => path === PROFILE_STATUS_OWNER);
    expect(owner?.code).toMatch(/export const ACTIVE_PROFILE_STATUS = 'ACTIVE';/u);
    const copies = files
      .filter(({ path }) => path !== PROFILE_STATUS_OWNER && OTHER_MEANING_FILES[path] === undefined)
      .filter((file) => activeLiteralCountOf(file) > 0)
      .flatMap((file) => [`${file.path}: ${String(activeLiteralCountOf(file))}`, ...matchingCodeLines(file, PROFILE_STATUS_SHAPES)]);
    expect(copies).toEqual([]);
    // 別の意味で使うファイルでも、プロファイルの状態の形は書かない。使われなくなった除外を残さない。
    const otherMeaning = files.filter(({ path }) => OTHER_MEANING_FILES[path] !== undefined);
    expect(otherMeaning.flatMap((file) => matchingCodeLines(file, PROFILE_STATUS_SHAPES))).toEqual([]);
    expect(Object.keys(OTHER_MEANING_FILES).filter((path) => !otherMeaning.some((file) => file.path === path && activeLiteralCountOf(file) > 0)))
      .toEqual([]);
    expect(stopwatch.elapsedMs()).toBeLessThan(MAX_MS_PER_FILE * Math.max(files.length, 1));
  });

  it('writes the profile status RETIRED only in profile-records.ts (other files read RETIRED_PROFILE_STATUS)', () => {
    const stopwatch = startCpuStopwatch();
    const files = filesWithRetiredText();
    const owner = files.find(({ path }) => path === PROFILE_STATUS_OWNER);
    expect(/export const RETIRED_PROFILE_STATUS = 'RETIRED';/u.test(owner?.code ?? ''), 'RETIRED_PROFILE_STATUS').toBe(true);
    const copies = files
      .filter(({ path }) => path !== PROFILE_STATUS_OWNER && RETIRED_OTHER_MEANING_FILES[path] === undefined)
      .filter((file) => retiredLiteralCountOf(file) > 0)
      .flatMap((file) => [`${file.path}: ${String(retiredLiteralCountOf(file))}`, ...matchingCodeLines(file, RETIRED_PROFILE_STATUS_SHAPES)]);
    expect(copies).toEqual([]);
    // 別の意味で使うファイルでも、プロファイルの状態の形は書かない。使われなくなった除外を残さない。
    const otherMeaning = files.filter(({ path }) => RETIRED_OTHER_MEANING_FILES[path] !== undefined);
    expect(otherMeaning.flatMap((file) => matchingCodeLines(file, RETIRED_PROFILE_STATUS_SHAPES))).toEqual([]);
    expect(Object.keys(RETIRED_OTHER_MEANING_FILES)
      .filter((path) => !otherMeaning.some((file) => file.path === path && retiredLiteralCountOf(file) > 0))).toEqual([]);
    expect(stopwatch.elapsedMs()).toBeLessThan(MAX_MS_PER_FILE * Math.max(files.length, 1));
  });

  it('compares the run lock state only through ACTIVE_RUN_LOCK_STATE of process-lock.ts (PRE42-CC group R, CC-110)', () => {
    const stopwatch = startCpuStopwatch();
    const files = filesJudgingRunLocks();
    // 空の走査で PASS しない（ロックの判定の利用者が見えている）。LG-4F: 保存のセッション（`run-checkpoint-session.ts`）は、前の方式の取り直しを
    // 捨てて `judgeRunLock` を呼ばなくなった（判定は `takeOverStaleLock` の中）ので、利用者の一覧から外した。
    expect(files.map(({ path }) => path)).toEqual(expect.arrayContaining([
      'src/control/job/instance-lock.ts',
      'src/orchestration/output-start-lock.ts',
    ]));
    expect(files.flatMap((file) => matchingCodeLines(file, RUN_LOCK_STATE_COMPARISON_SHAPES))).toEqual([]);
    const owner = scanFile(PRODUCTION_FILES.find(({ path }) => path === RUN_LOCK_STATE_OWNER) ?? { path: RUN_LOCK_STATE_OWNER, content: '' });
    expect(owner.code).toMatch(/export const RUN_LOCK_STATES = Object\.freeze\(\['ACTIVE', 'STALE'\] as const\);/u);
    expect(owner.code).toMatch(/export const ACTIVE_RUN_LOCK_STATE = 'ACTIVE' satisfies RunLockState;/u);
    expect(stopwatch.elapsedMs()).toBeLessThan(MAX_MS_PER_FILE * Math.max(files.length + 1, 1));
  });

  it('makes the current compact timestamp of the local UI server only in timestamps.ts (nowCompactTimestamp)', () => {
    const stopwatch = startCpuStopwatch();
    const files = PRODUCTION_FILES
      .filter(({ path }) => path.startsWith(LOCAL_UI_SERVER_DIRECTORY) && path !== NOW_TIMESTAMP_OWNER)
      .filter(({ content }) => content.includes(NOW_TIMESTAMP_FUNCTION))
      .map((file) => scanFile(file));
    expect(files.flatMap((file) => matchingCodeLines(file, [NOW_COMPACT_TIMESTAMP_SHAPE]))).toEqual([]);
    const owner = scanFile(PRODUCTION_FILES.find(({ path }) => path === NOW_TIMESTAMP_OWNER) ?? { path: NOW_TIMESTAMP_OWNER, content: '' });
    expect(matchingCodeLines(owner, [NOW_COMPACT_TIMESTAMP_SHAPE])).toHaveLength(1);
    expect(stopwatch.elapsedMs()).toBeLessThan(MAX_MS_PER_FILE * Math.max(files.length + 1, 1));
  });

  it('defines and exports the artifact file names only in src/core/artifact-layout.ts (users import them from core)', () => {
    const stopwatch = startCpuStopwatch();
    const files = filesWithArtifactNameText();
    expect(files.flatMap((file) => artifactNameCopiesOf(file))).toEqual([]);
    expect(stopwatch.elapsedMs()).toBeLessThan(MAX_MS_PER_FILE * Math.max(files.length, 1));
  });

  it('finds the shapes placed on purpose, and does not count comments and other meanings (the control)', () => {
    const fileOf = sourceFileOf;
    // (a) 書き写しの形（寄せる前の形）。
    for (const source of [
      "const ACTIVE: ProfileStatus = 'ACTIVE';",
      "const ACTIVE_STATUS = 'ACTIVE' satisfies ProfileStatus;",
      "const ACTIVE_PROFILE_STATUS = 'ACTIVE';",
      "if (stored.status !== 'ACTIVE') {}",
      "const editable = profile.status === 'ACTIVE';",
      "[status !== 'ACTIVE', 'PROFILE_RETIRED'],",
    ]) {
      expect(activeLiteralCountOf(fileOf('control.ts', source)), source).toBe(1);
    }
    for (const source of [
      "const ACTIVE: ProfileStatus = 'ACTIVE';",
      "const ACTIVE_STATUS = 'ACTIVE' satisfies ProfileStatus;",
      "if (stored.status !== 'ACTIVE') {}",
      "if ('ACTIVE' === current?.status) {}",
    ]) {
      expect(matchingCodeLines(fileOf('control.ts', source), PROFILE_STATUS_SHAPES), source).toHaveLength(1);
    }
    for (const source of ["// status !== 'ACTIVE'", 'if (stored.status !== ACTIVE_PROFILE_STATUS) {}', "if (state === 'ACTIVE') {}"]) {
      expect(matchingCodeLines(fileOf('control.ts', source), PROFILE_STATUS_SHAPES), source).toEqual([]);
    }
    expect(activeLiteralCountOf(fileOf('control.ts', "// 'ACTIVE' のときだけ\nconst x = ACTIVE_PROFILE_STATUS;"))).toBe(0);
    // (a′) `RETIRED` の書き写しの形（寄せる前の形。PRE42-CC の組 1b）。
    for (const source of [
      "const RETIRED: ProfileStatus = 'RETIRED';",
      "const RETIRED_STATUS = 'RETIRED' satisfies ProfileStatus;",
      "const RETIRED_PROFILE_STATUS = 'RETIRED';",
      "if (stored.status === 'RETIRED') {}",
      "...(facts.profile.status === 'RETIRED' ? ['PROFILE_RETIRED' as const] : []),",
    ]) {
      expect(retiredLiteralCountOf(fileOf('control.ts', source)), source).toBe(1);
    }
    for (const source of [
      "const RETIRED: ProfileStatus = 'RETIRED';",
      "const RETIRED_STATUS = 'RETIRED' satisfies ProfileStatus;",
      "if (stored.status === 'RETIRED') {}",
      "const retired = 'RETIRED' !== detail.status;",
    ]) {
      expect(matchingCodeLines(fileOf('control.ts', source), RETIRED_PROFILE_STATUS_SHAPES), source).toHaveLength(1);
    }
    for (const source of [
      "// status === 'RETIRED'",
      'if (row.status === RETIRED_PROFILE_STATUS) {}',
      "replaceRow(connection, revision, profile, RETIRED_PROFILE_STATUS, 'RETIRED', at);",
    ]) {
      expect(matchingCodeLines(fileOf('control.ts', source), RETIRED_PROFILE_STATUS_SHAPES), source).toEqual([]);
    }
    expect(retiredLiteralCountOf(fileOf('control.ts', "// 'RETIRED' のときだけ\nreturn rejected('PROFILE_RETIRED');"))).toBe(0);
    // (a″) ロックの判定の結果の書き写し（寄せる前の形。PRE42-CC の組 R。CC-110）。
    for (const source of [
      "if (judgeRunLock(lock, { nowMs: host.nowMs, bootedAtMs: host.bootedAtMs, isProcessRunning }) === 'ACTIVE') {",
      "if (state === 'ACTIVE') {",
      "if (state !== 'STALE') {}",
      "if ('ACTIVE' === judged.state) {}",
    ]) {
      expect(matchingCodeLines(fileOf('src/control/job/x.ts', source), RUN_LOCK_STATE_COMPARISON_SHAPES), source).toHaveLength(1);
    }
    for (const source of [
      "// if (state === 'ACTIVE') {",
      'if (state === ACTIVE_RUN_LOCK_STATE) {',
      'if (judgeRunLock(lock, judgement) === ACTIVE_RUN_LOCK_STATE) {',
      "if (this.#phase !== 'ACTIVE') {",
    ]) {
      expect(matchingCodeLines(fileOf('src/control/job/x.ts', source), RUN_LOCK_STATE_COMPARISON_SHAPES), source).toEqual([]);
    }
    // (b) 今の時刻の書き写し。
    for (const source of [
      "const nowStamp = (): string => formatCompactUtcTimestamp(new Date(), 'save time');",
      "at: formatCompactUtcTimestamp( new Date() , 'grant time'),",
    ]) {
      expect(matchingCodeLines(fileOf('control.ts', source), [NOW_COMPACT_TIMESTAMP_SHAPE]), source).toHaveLength(1);
    }
    for (const source of [
      "at: formatCompactUtcTimestamp(deps.now(), 'credential change time'),",
      "formatCompactUtcTimestamp(new Date(next), 'next write time')",
      "// formatCompactUtcTimestamp(new Date(), 'x')",
    ]) {
      expect(matchingCodeLines(fileOf('control.ts', source), [NOW_COMPACT_TIMESTAMP_SHAPE]), source).toEqual([]);
    }
    // (c) 成果物の名前の公開し直しと定義と値。
    for (const source of [
      "export { ACTION_RUN_ARTIFACT_FILE_NAME } from '../../core/artifact-layout.js';",
      "export {\n  ACTION_RUN_ARTIFACT_FILE_NAME,\n} from '../../core/artifact-layout.js';",
      'export { DISCOVERY_ARTIFACT_FILE_NAME };',
      "const ACTION_RUN_ARTIFACT_FILE_NAME = 'x.json';",
      "export * from '../../core/artifact-layout.js';",
      "const name = 'action-run.json';",
    ]) {
      expect(artifactNameCopiesOf(fileOf('src/control/job/control.ts', source)), source).toHaveLength(1);
    }
    for (const source of [
      "import { ACTION_RUN_ARTIFACT_FILE_NAME } from '../../core/artifact-layout.js';",
      "// export { ACTION_RUN_ARTIFACT_FILE_NAME } from '../../core/artifact-layout.js';",
      "export * from './write-job-start.js';",
      "const read = await read(ACTION_RUN_ARTIFACT_FILE_NAME);",
    ]) {
      expect(artifactNameCopiesOf(fileOf('src/control/job/control.ts', source)), source).toEqual([]);
    }
  });
});

describe('Architecture Gate: the owner values and functions are read, not copied (PRE42-CC group 2, CC-106, CC-102)', () => {
  it('writes the scenario kinds only in src/core/scenario-kind.ts (other files read the core or the scenario contract re-export)', () => {
    const stopwatch = startCpuStopwatch();
    const files = PRODUCTION_FILES
      .filter(({ path }) => path !== SCENARIO_KIND_OWNER && SCENARIO_KIND_FROZEN_COPY_FILES[path] === undefined)
      .filter(({ content }) => SCENARIO_KIND_TEXTS.some((text) => content.includes(text)))
      .map((file) => scanFile(file));
    expect(files.flatMap((file) => matchingCodeLines(file, SCENARIO_KIND_COPY_SHAPES))).toEqual([]);
    const owner = scanFile(PRODUCTION_FILES.find(({ path }) => path === SCENARIO_KIND_OWNER) ?? { path: SCENARIO_KIND_OWNER, content: '' });
    expect(owner.code).toMatch(/export const SCENARIO_KINDS = Object\.freeze\(\['CREATE', 'UPDATE'\] as const\);/u);
    // 除いたファイルが、今も写しを持つ（使われなくなった除外を残さない）。
    expect(Object.keys(SCENARIO_KIND_FROZEN_COPY_FILES).filter((path) =>
      matchingCodeLines(scanFile(PRODUCTION_FILES.find((file) => file.path === path) ?? { path, content: '' }), SCENARIO_KIND_COPY_SHAPES).length === 0))
      .toEqual([]);
    expect(stopwatch.elapsedMs()).toBeLessThan(MAX_MS_PER_FILE * Math.max(files.length + 2, 1));
  });

  it('takes the value of an API field identity only in src/core/api-field-identity.ts (apiFieldIdentityValueOf)', () => {
    const stopwatch = startCpuStopwatch();
    const files = PRODUCTION_FILES
      .filter(({ path }) => path !== API_FIELD_IDENTITY_OWNER)
      .filter(({ content }) => content.includes('.selector'))
      .map((file) => scanFile(file));
    expect(files.flatMap((file) => matchingCodeLines(file, API_FIELD_IDENTITY_VALUE_SHAPES))).toEqual([]);
    const owner = scanFile(PRODUCTION_FILES.find(({ path }) => path === API_FIELD_IDENTITY_OWNER) ?? { path: API_FIELD_IDENTITY_OWNER, content: '' });
    expect(owner.code).toMatch(/export const apiFieldIdentityValueOf\b/u);
    expect(matchingCodeLines(owner, API_FIELD_IDENTITY_VALUE_SHAPES)).toHaveLength(1);
    expect(stopwatch.elapsedMs()).toBeLessThan(MAX_MS_PER_FILE * Math.max(files.length + 1, 1));
  });

  it('finds the copies placed on purpose, and does not count comments, comparisons and other meanings (the control)', () => {
    const fileOf = sourceFileOf;
    // (d) 寄せる前の形（`worker-protocol.ts`・`execution-grant.ts`・`ScenarioApiFields.tsx`・前の `scenario-contracts.ts`）。
    for (const source of [
      "const UPDATE_SCENARIO_KIND = 'UPDATE' satisfies ScenarioKind;",
      "const API_WRITE_AVAILABLE_KIND = 'CREATE' satisfies ScenarioContent['kind'];",
      "const UPDATE_KIND = 'UPDATE' satisfies ScenarioKind;",
      "export const CREATE_SCENARIO_KIND = 'CREATE';",
      'const KIND: ScenarioKind = "UPDATE";',
      "const kinds = ['CREATE' as ScenarioKind];",
      'export const SCENARIO_KINDS = Object.freeze([CREATE_SCENARIO_KIND, UPDATE_SCENARIO_KIND] as const);',
    ]) {
      expect(matchingCodeLines(fileOf('src/control/x.ts', source), SCENARIO_KIND_COPY_SHAPES), source).toHaveLength(1);
    }
    for (const source of [
      "// const UPDATE_KIND = 'UPDATE' satisfies ScenarioKind;",
      "if (scenario.kind === 'UPDATE') {}",
      'const UPDATE_KIND = UPDATE_SCENARIO_KIND;',
      'export const SCENARIO_KINDS = CORE_SCENARIO_KINDS satisfies readonly CandidateClassification[];',
      "const CANDIDATE_CLASSIFICATIONS = Object.freeze(['CREATE', 'UPDATE', 'READ'] as const);",
      "API_CREATE: Object.freeze({ kind: 'CREATE', method: 'POST' } as const),",
      "const outcome = choice.kind === 'CREATE' ? 'NOT_LINKED' : choice.kind;",
    ]) {
      expect(matchingCodeLines(fileOf('src/control/x.ts', source), SCENARIO_KIND_COPY_SHAPES), source).toEqual([]);
    }
    // (e) 欄の識別の値の取り出し。
    for (const source of [
      'JSON.stringify([key, type, field.kind, field.kind === \'NAME\' ? field.name : field.selector, fieldType]);',
      "const value = identity.kind !== 'SELECTOR' ? identity.selector : identity.name;",
    ]) {
      expect(matchingCodeLines(fileOf('src/control/x.ts', source), API_FIELD_IDENTITY_VALUE_SHAPES), source).toHaveLength(1);
    }
    for (const source of [
      "// field.kind === 'NAME' ? field.name : field.selector",
      "text.keyField(key, type, field.kind === 'NAME' ? text.fieldName(field.name) : text.fieldSelector(field.selector));",
      'JSON.stringify([key, type, field.kind, apiFieldIdentityValueOf(field), fieldType]);',
    ]) {
      expect(matchingCodeLines(fileOf('src/control/x.ts', source), API_FIELD_IDENTITY_VALUE_SHAPES), source).toEqual([]);
    }
  });
});
