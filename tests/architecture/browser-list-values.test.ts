/**
 * 画面のブラウザ側が読む閉じた一覧の値の Gate（PRE42-CC 組 UI-K2。台帳の CC-113）。
 * - 一覧の owner が Node の側のファイル（IPC の契約、ジョブの管理、管理データの store、発見の契約、画面のサーバ）にあると、ブラウザ側は値を import できず、
 *   `'CURRENT' satisfies AuthSetupFreshness` のような型で縛った書き写しを置いていた。一覧ごとに、値だけを持つ純粋な core のファイル（import を持たない。
 *   `src/core/audit-job-values.ts` と同じ形）に移し、元の owner は同じ名前で公開し直す。ブラウザ側は core から読む。
 * - (a) core の owner は import を持たず、一覧と名前つきの定数を定義する。元の owner は core を読んで公開し直し、一覧を定義し直さない。ほかのファイルも
 *   一覧の名前で定義し直さない。
 * - (b) 画面のブラウザ側（`apps/local-ui/src/` の `server/` の外）は、型で縛った値の書き写しを置かない（`'<値>' satisfies …`、`[…] satisfies readonly …[]`、
 *   この Gate の一覧の型での `: <型> = '<値>'`・`new Set<型>([`）。組 UI-K3: 承認と規則の一覧（再承認が要る理由、下書きを拒む理由、照合の READ の
 *   期待の種類、規則の値の作り方と出どころ）も core に移したので、除外は 0 件にした（除外の仕組みは残す。使われない除外は落とす）。
 * - (c) 画面（`apps/local-ui/src/`。サーバを含む）は、まとめて実行の状態（`chain.state`・`stageChain?.state`・`writeChain?.state`）、段の状態（`stage.state`）、
 *   認証の設定の新しさ（`…freshness`）、認証の状態（`…AuthState`）を、文字列リテラルと比べない（左右どちらでも）。core の名前つきの定数を読む。
 *   組 UI-K3: 範囲を `src/` にも広げた（ジョブの管理 `audit-job-manager.ts` の連鎖と段の状態、新しさ、認証の状態）。
 * - (c′) 組 Z: 連鎖と段の状態を読むファイルは、連鎖・段の状態の文字列リテラルを `.state` への代入とオブジェクトの値（`state: '<値>'`）にも書かない。
 *   メソッドの引数（`#closeChain(chain, null, NOT_NEEDED_CHAIN_STAGE_STATE)`）と `??` の既定は数えない（近似。ジョブの管理は定数で書いた）。
 * - (e) 組 UI-K3: 画面のブラウザ側は、READ の確かめの期待の種類（`…expectation.kind`）を文字列リテラルと比べず、`case '<種類>'` と `kind: '<種類>'` も
 *   書かない（core の名前つきの定数を読む）。表示の関数の、型で網羅を縛った `switch`（`display/read-checks.ts`）は、寄せない決まり（台帳の CC-113 の D）なので、
 *   ファイルと形の組で、理由を付けて除外する。
 * - (d) core に置いた部分の一覧（まだ決まっていない続けて更新する状態、行の数を照らす期待の種類、連絡先の欄の型）と同じ集合の、文字列リテラルだけの配列を、
 *   owner の外（`src/` と画面）に書かない（順は問わない。`new Set([...])` の中を含む。型をつけない書き写しも止める。`field-type-lists-ownership` と同じ作り）。
 * - 判定は、Node.js 標準の `fs`、正規表現、文字列の検索だけで行う（近似の検査。コメントは数えない）。1 秒以内に終える。
 */
import { describe, expect, it } from 'vitest';
import { AUTH_SETUP_FRESHNESS_VALUES } from '../../src/control/store/auth-setup-store.js';
import { CHAIN_STAGE_STATES, CHAIN_STATES } from '../../src/control/job/stage-chain-policy.js';
import { WORKER_AUTH_STATES } from '../../src/control/worker-protocol.js';
import { PENDING_WRITE_CHAIN_STATES, WRITE_CHAIN_STATES } from '../../apps/local-ui/src/server/write-chain-policy.js';
import { CONTACT_CANDIDATE_FIELD_TYPES } from '../../src/discovery/candidate-contracts.js';
import { READ_CHECK_EXPECTATION_KINDS, ROW_COUNT_EXPECTATION_KINDS } from '../../src/discovery/read-check-contracts.js';
import { VERIFICATION_EXPECTATION_KINDS } from '../../src/control/approval/scenario-contracts.js';
import {
  LOCAL_UI_SOURCE_DIRECTORY,
  MAX_GATE_MS,
  findModuleSpecifiers,
  readTypeScriptFilesUnder,
  scanSource,
  startCpuStopwatch,
  unusedExclusionsOf,
  type UnscannedFile,
} from './source-scan.js';

/** 判定の上限（ms。`source-scan.ts` の `MAX_GATE_MS`。PRE42-CC 組 G）。 */
const MAX_MS = MAX_GATE_MS;

const LOCAL_UI_FILES = readTypeScriptFilesUnder(LOCAL_UI_SOURCE_DIRECTORY);
const SOURCE_FILES = readTypeScriptFilesUnder('src');
const ALL_FILES: readonly UnscannedFile[] = [...SOURCE_FILES, ...LOCAL_UI_FILES];
const LOCAL_UI_SERVER_DIRECTORY = `${LOCAL_UI_SOURCE_DIRECTORY}/server/`;
const BROWSER_FILES = LOCAL_UI_FILES.filter(({ path }) => !path.startsWith(LOCAL_UI_SERVER_DIRECTORY));

/** (a) core の owner と、公開し直す元の owner、一覧の名前、名前つきの定数（名前と値）。 */
interface ListOwner {
  readonly owner: string;
  readonly reexporter: string;
  readonly lists: readonly string[];
  readonly constants: readonly (readonly [string, string])[];
}
const LIST_OWNERS: readonly ListOwner[] = [
  {
    owner: 'src/core/worker-auth-states.ts',
    reexporter: 'src/control/worker-protocol.ts',
    lists: ['WORKER_AUTH_STATES'],
    constants: [['WORKER_AWAITING_LOGIN_STATE', 'AWAITING_LOGIN']],
  },
  {
    owner: 'src/core/stage-chain-states.ts',
    reexporter: 'src/control/job/stage-chain-policy.ts',
    lists: ['CHAIN_STATES', 'CHAIN_STAGE_STATES'],
    constants: [
      ['RUNNING_CHAIN_STATE', 'RUNNING'],
      ['STOPPED_CHAIN_STAGE_STATE', 'STOPPED'],
      // 組 UI-K3: ジョブの管理が読む段の状態。
      ['RUNNING_CHAIN_STAGE_STATE', 'RUNNING'],
      ['PENDING_CHAIN_STAGE_STATE', 'PENDING'],
      // 組 Z: ジョブの管理が代入とオブジェクトの値に書く連鎖と段の状態。
      ['FINISHED_CHAIN_STATE', 'FINISHED'],
      ['STOPPED_CHAIN_STATE', 'STOPPED'],
      ['DONE_CHAIN_STAGE_STATE', 'DONE'],
      ['NOT_STARTED_CHAIN_STAGE_STATE', 'NOT_STARTED'],
      ['NOT_NEEDED_CHAIN_STAGE_STATE', 'NOT_NEEDED'],
    ],
  },
  {
    owner: 'src/core/write-chain-states.ts',
    reexporter: `${LOCAL_UI_SERVER_DIRECTORY}write-chain-policy.ts`,
    lists: ['WRITE_CHAIN_STATES', 'PENDING_WRITE_CHAIN_STATES'],
    constants: [],
  },
  {
    owner: 'src/core/auth-setup-freshness.ts',
    reexporter: 'src/control/store/auth-setup-store.ts',
    lists: ['AUTH_SETUP_FRESHNESS_VALUES'],
    constants: [['CURRENT_AUTH_SETUP_FRESHNESS', 'CURRENT'], ['STALE_AUTH_SETUP_FRESHNESS', 'STALE']],
  },
  {
    owner: 'src/core/audit-job-start-rejection-reasons.ts',
    reexporter: 'src/control/job/job-records.ts',
    lists: ['AUDIT_JOB_START_REJECTION_REASONS'],
    constants: [['PROFILE_RETIRED_START_REJECTION_REASON', 'PROFILE_RETIRED']],
  },
  {
    owner: 'src/core/read-check-expectation-kinds.ts',
    reexporter: 'src/discovery/read-check-contracts.ts',
    lists: ['READ_CHECK_EXPECTATION_KINDS', 'ROW_COUNT_EXPECTATION_KINDS'],
    constants: [
      ['ROW_COUNT_AT_LEAST_EXPECTATION_KIND', 'ROW_COUNT_AT_LEAST'],
      ['TEXT_CONTAINS_EXPECTATION_KIND', 'TEXT_CONTAINS'],
      ['DETAIL_FIELD_EQUALS_EXPECTATION_KIND', 'DETAIL_FIELD_EQUALS'],
    ],
  },
  {
    owner: 'src/core/candidate-field-types.ts',
    reexporter: 'src/discovery/candidate-contracts.ts',
    lists: ['CANDIDATE_FIELD_TYPES', 'CONTACT_CANDIDATE_FIELD_TYPES'],
    constants: [],
  },
  // 組 UI-K3（CC-113 の残り。承認と規則）。
  {
    owner: 'src/core/approval-invalidity-reasons.ts',
    reexporter: 'src/control/approval/approval-validity.ts',
    lists: ['APPROVAL_INVALIDITY_REASONS'],
    constants: [
      ['EXPIRED_INVALIDITY_REASON', 'EXPIRED'],
      ['REVOKED_INVALIDITY_REASON', 'REVOKED'],
      ['NOT_APPROVED_INVALIDITY_REASON', 'NOT_APPROVED'],
    ],
  },
  {
    owner: 'src/core/scenario-draft-rejection-reasons.ts',
    reexporter: 'src/control/approval/scenario-policy.ts',
    lists: ['SCENARIO_DRAFT_REJECTION_REASONS'],
    constants: [['PATH_NOT_BOUND_TO_LEDGER_ID_REJECTION_REASON', 'SCENARIO_UPDATE_PATH_NOT_BOUND_TO_LEDGER_ID']],
  },
  {
    owner: 'src/core/read-check-expectation-kinds.ts',
    reexporter: 'src/control/approval/scenario-contracts.ts',
    lists: ['VERIFICATION_EXPECTATION_KINDS'],
    constants: [['ROW_COUNT_EQUALS_EXPECTATION_KIND', 'ROW_COUNT_EQUALS']],
  },
  {
    owner: 'src/core/generation-methods.ts',
    reexporter: 'src/control/data-rules/rule-contracts.ts',
    lists: ['GENERATION_METHODS'],
    constants: [['FIXED_LIST_GENERATION_METHOD', 'FROM_FIXED_LIST'], ['TEMPLATE_GENERATION_METHOD', 'FROM_TEMPLATE']],
  },
  {
    owner: 'src/core/rule-origins.ts',
    reexporter: 'src/control/data-rules/rule-contracts.ts',
    lists: ['RULE_ORIGINS'],
    constants: [['DEFAULT_RULE_ORIGIN', 'HUMAN']],
  },
];

/** (b) この Gate の一覧の型（`: <型> = '<値>'`・`new Set<型>([` を数える）。 */
const OWNED_TYPES = [
  'WorkerAuthState', 'ChainState', 'ChainStageState', 'WriteChainState', 'WriteChainStateValue', 'AuthSetupFreshness',
  'AuditJobStartRejectionReason', 'ReadCheckExpectationKind', 'CandidateFieldType',
  // 組 UI-K3。
  'ApprovalInvalidityReason', 'ScenarioDraftRejectionReason', 'VerificationExpectationKind', 'GenerationMethod', 'RuleOrigin',
].join('|');
const TYPED_COPY_PATTERNS: readonly RegExp[] = [
  /(['"])[^'"\n]*\1\s+satisfies\b/gu,
  /\]\s*(?:as\s+const\s+)?satisfies\s+readonly\b/gu,
  new RegExp(String.raw`:\s*(?:${OWNED_TYPES})\s*=\s*['"]`, 'gu'),
  new RegExp(String.raw`\bnew\s+Set<(?:${OWNED_TYPES})>\(\s*\[`, 'gu'),
];
/**
 * (b) の除外（`<ファイル>: <形>` と理由）。除外の一覧は、このファイルの中の 1 か所だけ。組 UI-K3: 承認の 4 件（`display/scenarios.ts` の 3 つと
 * `ScenarioUpdateFields.tsx` の 1 つ）は core から読むようにしたので消した（今は 0 件）。
 */
const TYPED_COPY_EXCLUSIONS: ReadonlyMap<string, string> = new Map([]);

/** (c) 受け手と、比べてはいけない値の一覧。 */
const PREFIX = String.raw`(?:[\w$]+\s*\??\.\s*)*`;
const alternativesOf = (values: readonly string[]): string => [...new Set(values)].join('|');
const COMPARED_RECEIVERS: readonly (readonly [string, readonly string[]])[] = [
  [String.raw`${PREFIX}[\w$]*[cC]hain\s*\??\.\s*state(?![\w$])`, [...CHAIN_STATES, ...WRITE_CHAIN_STATES]],
  [String.raw`${PREFIX}\bstage\s*\??\.\s*state(?![\w$])`, CHAIN_STAGE_STATES],
  [String.raw`${PREFIX}[\w$]*[fF]reshness(?![\w$])`, AUTH_SETUP_FRESHNESS_VALUES],
  [String.raw`${PREFIX}[\w$]*[aA]uthState(?![\w$])`, WORKER_AUTH_STATES],
];
/** (c) 前の段で、比べてはいけない値の文字列も、比べる演算子もない本文を除く（走査は重い。DEF-107）。 */
const COMPARISON_PREFILTER = new RegExp(String.raw`[=!]==?\s*'(?:${alternativesOf(COMPARED_RECEIVERS.flatMap(([, values]) => values))})'|'(?:${
  alternativesOf(COMPARED_RECEIVERS.flatMap(([, values]) => values))})'\s*[=!]==?`, 'u');
const COMPARISON_PATTERNS: readonly RegExp[] =COMPARED_RECEIVERS.flatMap(([receiver, values]) => [
  new RegExp(String.raw`${receiver}\s*[=!]==?\s*'(?:${alternativesOf(values)})'`, 'gu'),
  new RegExp(String.raw`'(?:${alternativesOf(values)})'\s*[=!]==?\s*${receiver}`, 'gu'),
]);

/**
 * (c′) 組 Z（UI-K3 の発見）: 連鎖と段の状態を読むファイル（`stage-chain-states.ts`・`stage-chain-policy.ts` を import するもの）は、連鎖・段の状態の
 * 文字列リテラルを、`.state` への代入の右辺（`chain.state = … ? 'FINISHED' : 'STOPPED'`・`done.state = 'DONE'`。受け手の名前は問わない）にも、
 * オブジェクトの値（`{ state: 'RUNNING', jobId }`）にも書かない。core の名前つきの定数を読む。
 */
const CHAIN_STATE_VALUE_ALTERNATIVES = alternativesOf([...CHAIN_STATES, ...CHAIN_STAGE_STATES]);
const CHAIN_STATE_READER = /['"][./]+(?:[\w-]+\/)*stage-chain-(?:states|policy)\.js['"]/u;
const CHAIN_STATE_ASSIGNMENT_PATTERNS: readonly RegExp[] = [
  new RegExp(String.raw`${PREFIX}[\w$]+\s*\.\s*state\s*=(?![=>])[^;\n]*'(?:${CHAIN_STATE_VALUE_ALTERNATIVES})'`, 'gu'),
  new RegExp(String.raw`(?<![\w$.])state\s*:\s*'(?:${CHAIN_STATE_VALUE_ALTERNATIVES})'`, 'gu'),
];

/** (e) 組 UI-K3: READ の確かめの期待の種類の、比べ（受け手は `…expectation.kind`・`…Expectation.kind`）、`case`、オブジェクトの値 `kind:`。 */
const EXPECTATION_KIND_ALTERNATIVES = alternativesOf(READ_CHECK_EXPECTATION_KINDS);
const EXPECTATION_RECEIVER = String.raw`${PREFIX}[\w$]*[eE]xpectation\s*\??\.\s*kind(?![\w$])`;
const EXPECTATION_KIND_PATTERNS: readonly RegExp[] = [
  new RegExp(String.raw`${EXPECTATION_RECEIVER}\s*[=!]==?\s*'(?:${EXPECTATION_KIND_ALTERNATIVES})'`, 'gu'),
  new RegExp(String.raw`'(?:${EXPECTATION_KIND_ALTERNATIVES})'\s*[=!]==?\s*${EXPECTATION_RECEIVER}`, 'gu'),
  new RegExp(String.raw`\bcase\s+'(?:${EXPECTATION_KIND_ALTERNATIVES})'`, 'gu'),
  new RegExp(String.raw`(?<![\w$])kind\s*:\s*'(?:${EXPECTATION_KIND_ALTERNATIVES})'`, 'gu'),
];
const EXPECTATION_KIND_PREFILTER = new RegExp(String.raw`'(?:${EXPECTATION_KIND_ALTERNATIVES})'`, 'u');
/** (e) の除外（`<ファイル>: <形>` と理由）。表示の関数の、型で網羅を縛った `switch` は寄せない（台帳の CC-113 の D）。 */
const DISPLAY_SWITCH_REASON = '表示の関数の、型で網羅を縛った switch の case（期待の種類ごとの文。寄せない決まり。台帳の CC-113 の D）';
const EXPECTATION_KIND_EXCLUSIONS: ReadonlyMap<string, string> = new Map(READ_CHECK_EXPECTATION_KINDS.map((kind) => [
  `${LOCAL_UI_SOURCE_DIRECTORY}/display/read-checks.ts: case '${kind}'`,
  DISPLAY_SWITCH_REASON,
]));

/** (d) core に置いた部分の一覧（名前、要素、owner）。 */
const GUARDED_SUBSETS: readonly (readonly [string, readonly string[], string])[] = [
  ['PENDING_WRITE_CHAIN_STATES', PENDING_WRITE_CHAIN_STATES, 'src/core/write-chain-states.ts'],
  ['ROW_COUNT_EXPECTATION_KINDS', ROW_COUNT_EXPECTATION_KINDS, 'src/core/read-check-expectation-kinds.ts'],
  ['CONTACT_CANDIDATE_FIELD_TYPES', CONTACT_CANDIDATE_FIELD_TYPES, 'src/core/candidate-field-types.ts'],
  // 組 UI-K3: 照合の READ の期待の種類。
  ['VERIFICATION_EXPECTATION_KINDS', VERIFICATION_EXPECTATION_KINDS, 'src/core/read-check-expectation-kinds.ts'],
];
const STRING_ARRAY_PATTERN = /\[\s*(?:(?:'[^'\n]*'|"[^"\n]*")\s*,\s*)*(?:'[^'\n]*'|"[^"\n]*")\s*,?\s*\]/gu;
const STRING_LITERAL_PATTERN = /'([^'\n]*)'|"([^"\n]*)"/gu;
const sameSet = (left: readonly string[], right: readonly string[]): boolean =>
  new Set(left).size === new Set(right).size && left.every((value) => right.includes(value));
/** (d) 1 つの本文の、部分の一覧と同じ集合の配列（`<一覧の名前>: <配列>`。`owner` の一覧は数えない）。 */
const findSubsetCopies = (path: string, content: string): readonly string[] =>
  [...scanSource(content).code.matchAll(STRING_ARRAY_PATTERN)].flatMap(([array]) => {
    const values = [...array.matchAll(STRING_LITERAL_PATTERN)].map((match) => match[1] ?? match[2] ?? '');
    return GUARDED_SUBSETS.filter(([, list, owner]) => owner !== path && sameSet(values, list)).map(([name]) => `${name}: ${array}`);
  });

const matchesOf = (code: string, patterns: readonly RegExp[]): readonly string[] =>
  patterns.flatMap((pattern) => [...code.matchAll(pattern)].map((match) => match[0]));

/** (b) 1 つの本文の、型で縛った値の書き写し（コメントを除く）。 */
const findTypedCopies = (content: string): readonly string[] => matchesOf(scanSource(content).code, TYPED_COPY_PATTERNS);
/** (c) 1 つの本文の、状態・新しさと文字列リテラルの比べ（コメントを除く）。 */
const findLiteralComparisons = (content: string): readonly string[] => matchesOf(scanSource(content).code, COMPARISON_PATTERNS);
/** (c′) 1 つの本文の、連鎖・段の状態の文字列リテラルの代入とオブジェクトの値（コメントを除く。連鎖の状態を読むファイルだけで呼ぶ）。 */
const findChainStateLiteralAssignments = (content: string): readonly string[] =>
  matchesOf(scanSource(content).code, CHAIN_STATE_ASSIGNMENT_PATTERNS);
/** (e) 1 つの本文の、期待の種類の文字列リテラルの比べ・`case`・`kind:`（コメントを除く）。 */
const findExpectationKindLiterals = (content: string): readonly string[] => matchesOf(scanSource(content).code, EXPECTATION_KIND_PATTERNS);

const fileOf = (path: string): UnscannedFile | undefined => ALL_FILES.find((file) => file.path === path);
const basenameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1).replace(/\.ts$/u, '');

describe('Architecture Gate: the closed list values the browser side reads (PRE42-CC group UI-K2, CC-113)', () => {
  it('(a) defines each list in a pure core file, and the old owner only re-exports it', () => {
    const stopwatch = startCpuStopwatch();
    // 一覧の名前で定義した所（`<ファイル>: <名前>`）。本文の文字列で絞ってから、コメントを除いた本文を 1 回だけ走査する。
    const listNames = LIST_OWNERS.flatMap(({ lists }) => lists);
    const listPrefilter = new RegExp(String.raw`\b(?:${listNames.join('|')})\b`, 'u');
    const listDefinition = new RegExp(String.raw`\bconst\s+(${listNames.join('|')})\s*[:=]`, 'gu');
    const definitions = ALL_FILES.filter(({ content }) => listPrefilter.test(content))
      .flatMap(({ path, content }) => [...scanSource(content).code.matchAll(listDefinition)].map((match) => `${path}: ${match[1] ?? ''}`));
    for (const { owner, reexporter, lists, constants } of LIST_OWNERS) {
      const ownerFile = fileOf(owner);
      expect(ownerFile, owner).toBeDefined();
      const ownerCode = scanSource(ownerFile?.content ?? '').code;
      expect(findModuleSpecifiers(ownerCode), `${owner} imports nothing`).toEqual([]);
      for (const list of lists) {
        expect(new RegExp(String.raw`\bexport\s+const\s+${list}\s*=\s*Object\.freeze\(`, 'u').test(ownerCode), `${owner}: ${list}`).toBe(true);
        expect(definitions.filter((entry) => entry.endsWith(`: ${list}`) && !entry.startsWith(`${owner}: `)), list).toEqual([]);
      }
      for (const [name, value] of constants) {
        expect(new RegExp(String.raw`\bexport\s+const\s+${name}\s*=\s*'${value}'\s+satisfies\s+[\w$]+`, 'u').test(ownerCode), `${owner}: ${name}`).toBe(true);
      }
      const reexporterCode = scanSource(fileOf(reexporter)?.content ?? '').code;
      expect(reexporterCode, reexporter).toMatch(new RegExp(String.raw`['"][./]+(?:[\w-]+/)*${basenameOf(owner)}\.js['"]`, 'u'));
    }
    expect(stopwatch.elapsedMs()).toBeLessThan(MAX_MS);
  });

  it('(b) keeps no typed copy of a closed list value in the browser side', () => {
    const stopwatch = startCpuStopwatch();
    expect(BROWSER_FILES.length).toBeGreaterThan(0);
    const found = BROWSER_FILES.flatMap(({ path, content }) => findTypedCopies(content).map((copy) => `${path}: ${copy}`));
    expect(found.filter((entry) => !TYPED_COPY_EXCLUSIONS.has(entry))).toEqual([]);
    expect(unusedExclusionsOf(TYPED_COPY_EXCLUSIONS.keys(), found)).toEqual([]);
    expect(stopwatch.elapsedMs()).toBeLessThan(MAX_MS);
  });

  it('(c) compares no chain state, stage state, auth setup freshness or auth state with a literal in the local UI and src (UI-K3)', () => {
    const stopwatch = startCpuStopwatch();
    const found = ALL_FILES.filter(({ content }) => COMPARISON_PREFILTER.test(content))
      .flatMap(({ path, content }) => findLiteralComparisons(content).map((comparison) => `${path}: ${comparison}`));
    expect(found).toEqual([]);
    expect(stopwatch.elapsedMs()).toBeLessThan(MAX_MS);
  });

  it('(c′) assigns no chain or stage state literal, in the files that read the chain states (PRE42-CC group Z)', () => {
    const stopwatch = startCpuStopwatch();
    const readers = ALL_FILES.filter(({ content }) => CHAIN_STATE_READER.test(content));
    // 空の走査で PASS しない（ジョブの管理は連鎖の状態を読む）。
    expect(readers.map(({ path }) => path)).toContain('src/control/job/audit-job-manager.ts');
    const found = readers.flatMap(({ path, content }) => findChainStateLiteralAssignments(content).map((literal) => `${path}: ${literal}`));
    expect(found).toEqual([]);
    expect(stopwatch.elapsedMs()).toBeLessThan(MAX_MS);
  });

  it('(e) writes no READ check expectation kind literal in the browser side, except the exhaustive display switch (UI-K3)', () => {
    const stopwatch = startCpuStopwatch();
    const found = BROWSER_FILES.filter(({ content }) => EXPECTATION_KIND_PREFILTER.test(content))
      .flatMap(({ path, content }) => findExpectationKindLiterals(content).map((literal) => `${path}: ${literal}`));
    expect(found.filter((entry) => !EXPECTATION_KIND_EXCLUSIONS.has(entry))).toEqual([]);
    expect(unusedExclusionsOf(EXPECTATION_KIND_EXCLUSIONS.keys(), found)).toEqual([]);
    expect(stopwatch.elapsedMs()).toBeLessThan(MAX_MS);
  });

  it('(d) writes no array with the same values as a core subset list outside its owner', () => {
    const stopwatch = startCpuStopwatch();
    const found = ALL_FILES.flatMap(({ path, content }) => findSubsetCopies(path, content).map((copy) => `${path}: ${copy}`));
    expect(found).toEqual([]);
    // 空の走査で PASS しない（owner の一覧は見えている）。
    for (const [name, , owner] of GUARDED_SUBSETS) {
      expect(findSubsetCopies('elsewhere.ts', fileOf(owner)?.content ?? ''), name).not.toEqual([]);
    }
    expect(stopwatch.elapsedMs()).toBeLessThan(MAX_MS);
  });

  // 検出の関数の自己確認（現実的な書き方で RED になり、定数を読む形・意味の違う値・コメントでは RED にならない）。
  it('detects realistic copies and comparisons, and ignores the constant forms (detector self-check)', () => {
    // (d) 組 UI-K2 の前の書き写し（`ScenarioApiFields.tsx`・`ReadCheckForm.tsx`・`$jobId.tsx` の形）と、より大きな一覧。
    expect(findSubsetCopies('a.tsx', "const CONTACT_FIELD_TYPES: ReadonlySet<string> = new Set(['email', 'tel']);")).toHaveLength(1);
    expect(findSubsetCopies('a.tsx', "const R = new Set<ReadCheckExpectationKind>(['ROW_COUNT_AT_LEAST', 'ROW_COUNT_EQUALS']);")).toHaveLength(1);
    expect(findSubsetCopies('a.tsx', "const P = new Set(['CREATING', 'WAITING_LOGIN_INTERVAL'] satisfies readonly WriteChainStateValue[]);")).toHaveLength(1);
    expect(findSubsetCopies('a.ts', "export const USERNAME_INPUT_TYPES: ReadonlySet<string> = new Set(['text', 'email', 'tel']);")).toHaveLength(0);
    expect(findSubsetCopies('a.ts', "// new Set(['email', 'tel'])\nconst c = new Set<string>(CONTACT_CANDIDATE_FIELD_TYPES);")).toHaveLength(0);
    expect(findTypedCopies("const CURRENT_FRESHNESS = 'CURRENT' satisfies AuthSetupFreshness;")).toHaveLength(1);
    expect(findTypedCopies("const S = 'AWAITING_LOGIN' satisfies NonNullable<AuditJobDetailView['lastAuthState']>;")).toHaveLength(1);
    expect(findTypedCopies("const P: ReadonlySet<string> = new Set(['CREATING', 'WAITING_LOGIN_INTERVAL'] satisfies readonly WriteChainStateValue[]);"))
      .toHaveLength(1);
    expect(findTypedCopies("const C = new Set(['email', 'tel'] as const satisfies readonly CandidateFieldType[]);")).toHaveLength(1);
    expect(findTypedCopies("const TEXT_CONTAINS_KIND: ReadCheckExpectationKind = 'TEXT_CONTAINS';")).toHaveLength(1);
    expect(findTypedCopies("const R = new Set<ReadCheckExpectationKind>(['ROW_COUNT_EQUALS', 'ROW_COUNT_AT_LEAST']);")).toHaveLength(1);
    expect(findTypedCopies('const C = new Set<string>(CONTACT_CANDIDATE_FIELD_TYPES);')).toHaveLength(0);
    // 組 UI-K3: 承認と規則の一覧の型も数える（`DataRuleForm.tsx`・`display/scenarios.ts` の前の形）。
    expect(findTypedCopies("const M: GenerationMethod = 'FROM_TEMPLATE';")).toHaveLength(1);
    expect(findTypedCopies("const UNMARKED_ORIGIN: RuleOrigin = 'HUMAN';")).toHaveLength(1);
    expect(findTypedCopies("const REVOKED_REASON = 'REVOKED' satisfies ApprovalInvalidityReason;")).toHaveLength(1);
    expect(findTypedCopies("const M: SemanticKindValue = 'EMAIL';")).toHaveLength(0);
    expect(findSubsetCopies('a.tsx', "const O: readonly VerificationExpectationKind[] = Object.freeze(['ROW_COUNT_EQUALS', 'TEXT_CONTAINS', 'DETAIL_FIELD_EQUALS']);"))
      .toHaveLength(1);
    // (e) 期待の種類（`ScenarioVerificationFields.tsx` の前の形）と、定数を読む形・ほかの種類の値。
    expect(findExpectationKindLiterals("{expectation.kind === 'ROW_COUNT_EQUALS' ? <p /> : null}")).toEqual(["expectation.kind === 'ROW_COUNT_EQUALS'"]);
    expect(findExpectationKindLiterals("if (view.expectation.kind === 'DETAIL_FIELD_EQUALS') {}")).toHaveLength(1);
    expect(findExpectationKindLiterals("switch (kind) {\n  case 'TEXT_CONTAINS':\n    return 1;\n}")).toEqual(["case 'TEXT_CONTAINS'"]);
    expect(findExpectationKindLiterals("const next = { kind: 'ROW_COUNT_EQUALS', count: 1 };")).toEqual(["kind: 'ROW_COUNT_EQUALS'"]);
    expect(findExpectationKindLiterals('{expectation.kind === ROW_COUNT_EQUALS_EXPECTATION_KIND ? <p /> : null}')).toHaveLength(0);
    expect(findExpectationKindLiterals("const k = { kind: 'FORM' };\n// case 'TEXT_CONTAINS':")).toHaveLength(0);
    // (c) 組 UI-K3: ジョブの管理の段の状態の比べ（`audit-job-manager.ts` の前の形）。
    expect(findLiteralComparisons("} else if (stage.state === 'PENDING') {")).toEqual(["stage.state === 'PENDING'"]);
    expect(findLiteralComparisons("|| job.lastAuthState !== 'AWAITING_LOGIN' || job.stopRequested")).toHaveLength(1);
    expect(findTypedCopies("// const X = 'CURRENT' satisfies AuthSetupFreshness;\nconst y = 1;")).toHaveLength(0);
    expect(findLiteralComparisons("{chain.state !== 'RUNNING' ? null : <p />}")).toEqual(["chain.state !== 'RUNNING'"]);
    expect(findLiteralComparisons("return data?.stageChain?.state === 'RUNNING';")).toEqual(["data?.stageChain?.state === 'RUNNING'"]);
    expect(findLiteralComparisons("const pending = data?.writeChain?.state === 'CREATING';")).toHaveLength(1);
    expect(findLiteralComparisons("chain.stages.some((stage) => stage.state === 'STOPPED')")).toEqual(["stage.state === 'STOPPED'"]);
    expect(findLiteralComparisons("if (stored.freshness === 'STALE' || 'CURRENT' !== setup.freshness) {}")).toHaveLength(2);
    expect(findLiteralComparisons("if (job.lastAuthState === 'AWAITING_LOGIN') {}")).toHaveLength(1);
    expect(findLiteralComparisons('{chain.state !== RUNNING_CHAIN_STATE ? null : <p />}')).toHaveLength(0);
    expect(findLiteralComparisons("if (job.state === 'RUNNING' || step.state === 'STALE') {}")).toHaveLength(0);
    expect(findLiteralComparisons("// chain.state !== 'RUNNING'\nconst y = 1;")).toHaveLength(0);
    // (c′) 組 Z: ジョブの管理の連鎖と段の状態の代入とオブジェクトの値（`audit-job-manager.ts` の前の形）と、定数を読む形・比べ・ほかの値・コメント。
    expect(findChainStateLiteralAssignments("chain.state = stopReason === null ? 'FINISHED' : 'STOPPED';"))
      .toEqual(["chain.state = stopReason === null ? 'FINISHED' : 'STOPPED'"]);
    expect(findChainStateLiteralAssignments("      done.state = 'DONE';")).toEqual(["done.state = 'DONE'"]);
    expect(findChainStateLiteralAssignments("index === 0 ? { state: 'RUNNING', jobId } : { state: 'PENDING', jobId: null }"))
      .toEqual(["state: 'RUNNING'", "state: 'PENDING'"]);
    expect(findChainStateLiteralAssignments('chain.state = stopReason === null ? FINISHED_CHAIN_STATE : STOPPED_CHAIN_STATE;')).toHaveLength(0);
    expect(findChainStateLiteralAssignments("if (stage.state === 'PENDING') {}\nconst e = { kind: 'ENDED', state: 'FAILED' };")).toHaveLength(0);
    expect(findChainStateLiteralAssignments("entry.state = 'QUEUED';\n// done.state = 'DONE';")).toHaveLength(0);
  });
});
