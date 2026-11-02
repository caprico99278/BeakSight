/**
 * ワーカーの `START` に監査モードが入らないことの Gate（MI-F2。設計書 `doc/design/2026-10-26-beaksight-minimal-input-ux-design.md` 2 章の調査の事実、
 * 4.5、5 章の 1 つ目。独立レビュー MI-R の Minor 13 の (a)）。書き込みのモード（`TEST_APPROVED_WRITE`）で監査を許しても監査が読み取りだけのままなのは、
 * 送信の扱いがプロファイルのモードでなくジョブの種類で決まるため。その前提を構造で固定する。
 * - (a) IPC の契約: `START` の形（`schemas/control/worker-message.schema.json` の `start` と、その下の `startAuthentication`・`startAutomatedLogin`、
 *   `src/control/worker-protocol.ts` の `WorkerStartMessage`・`WorkerStartAuthentication`・`WorkerStartAutomatedLogin` の項目）に、監査モードの項目
 *   （名前に `mode` を含む項目）がない。スキーマは、知らない項目を受けない（`additionalProperties: false`）。
 * - (b) ワーカーの側（`src/worker`、`src/orchestration`、`src/safety`、`src/browser`）は、監査モードの値を参照しない: モードの値の文字列リテラル
 *   （`AUDIT_MODES` の値）と、モードの名前（`AUDIT_MODES`・`AuditMode`・`WRITE_AUDIT_MODE`）と、モードを持つプロファイルの型（`SiteProfile`・
 *   `StoredProfile`）を書かない（コメントは数えない）。
 * - 判定は、Node.js 標準の `fs`、正規表現、文字列の検索だけで行う（近似の検査）。本文の文字列で絞ってから走査する（DEF-107）。1 秒以内に終える
 *   （CPU の時間。`source-scan.ts` の `MAX_GATE_MS`）。
 */
import { describe, expect, it } from 'vitest';
import { AUDIT_MODES } from '../../src/control/contracts.js';
import {
  MAX_GATE_MS,
  matchingBracket,
  readLfTextFile,
  readTypeScriptFilesUnder,
  scanFile,
  startCpuStopwatch,
  type UnscannedFile,
} from './source-scan.js';

/** IPC の契約のスキーマと型の置き場所。 */
const WORKER_MESSAGE_SCHEMA_PATH = 'schemas/control/worker-message.schema.json';
const WORKER_PROTOCOL_PATH = 'src/control/worker-protocol.ts';
/** `START` の形のスキーマの定義（`$defs` の名前）。 */
const START_SCHEMA_DEFINITIONS: readonly string[] = ['start', 'startAuthentication', 'startAutomatedLogin'];
/** `START` の形の型（`worker-protocol.ts` の interface の名前）。 */
const START_INTERFACES: readonly string[] = ['WorkerStartMessage', 'WorkerStartAuthentication', 'WorkerStartAutomatedLogin'];
/** ワーカーの側のフォルダ（設計書 2 章の調査の事実の 4 つ）。 */
const WORKER_SIDE_DIRECTORIES: readonly string[] = ['src/worker', 'src/orchestration', 'src/safety', 'src/browser'];

/** 監査モードの項目の名前（`mode`・`auditMode`・`profileMode` など。大文字と小文字を問わない）。 */
const MODE_PROPERTY_NAME = /mode/iu;
/** 監査モードの値の文字列リテラル（`'TEST_APPROVED_WRITE'` など。`'`・`"`・`` ` `` のどれでも）。 */
const MODE_VALUE_LITERAL = new RegExp(`(['"\`])(?:${AUDIT_MODES.join('|')})\\1`, 'gu');
/** 監査モードの名前と、モードを持つプロファイルの型の名前（識別子の境目で当てる）。 */
const MODE_IDENTIFIER = /(?<![\w$])(?:AUDIT_MODES|AuditMode|WRITE_AUDIT_MODE|SiteProfile|StoredProfile)(?![\w$])/gu;
/** 走査の前に絞る、本文の文字列（どれも含まないファイルは走査しない）。 */
const PREFILTER = new RegExp(`${AUDIT_MODES.join('|')}|AUDIT_MODES|AuditMode|WRITE_AUDIT_MODE|SiteProfile|StoredProfile`, 'u');

// ---------------------------------------------------------------------------------------------------------------
// 検出の関数（近似）
// ---------------------------------------------------------------------------------------------------------------

/** JSON Schema の定義の項目の名前と、知らない項目を受けないか。 */
interface SchemaObjectShape {
  readonly properties: readonly string[];
  readonly closed: boolean;
}

/** スキーマの `$defs` の 1 つの定義の形（項目の名前と `additionalProperties: false`）。 */
const schemaShapeOf = (schema: unknown, name: string): SchemaObjectShape | undefined => {
  const definitions = (schema as { readonly $defs?: Readonly<Record<string, unknown>> }).$defs ?? {};
  const definition = definitions[name] as { readonly properties?: Readonly<Record<string, unknown>>; readonly additionalProperties?: unknown } | undefined;
  return definition === undefined
    ? undefined
    : { properties: Object.keys(definition.properties ?? {}), closed: definition.additionalProperties === false };
};

/** 開き括弧（入れ子の型の始まり。`source-scan.ts` の `matchingBracket` が対を数える種類）。 */
const NESTED_OPENERS = '({[';
/** 上の段の項目の名前（`readonly <名前>?:` の形。行の始まりか `;` の後）。 */
const TOP_LEVEL_PROPERTY = /(?:^|[;\n])\s*readonly\s+([\w$]+)\??\s*:/gu;

/**
 * `bare`（コメントと文字列の中身を除いた本文）の、`export interface <name> … {` の本体の、上の段の項目の名前（入れ子の型の中の項目は数えない。括弧の対は
 * `source-scan.ts` の `matchingBracket` で数える）。interface がなければ `undefined`。
 */
const interfacePropertiesOf = (bare: string, name: string): readonly string[] | undefined => {
  const head = new RegExp(`export\\s+interface\\s+${name}\\b[^{]*\\{`, 'u').exec(bare);
  if (head === null) {
    return undefined;
  }
  const open = head.index + head[0].length - 1;
  const close = matchingBracket(bare, open);
  const body = bare.slice(open + 1, close < 0 ? bare.length : close);
  let flat = '';
  for (let cursor = 0; cursor < body.length;) {
    const character = body[cursor] ?? '';
    if (NESTED_OPENERS.includes(character)) {
      const end = matchingBracket(body, cursor);
      flat += ' ';
      cursor = end < 0 ? body.length : end + 1;
      continue;
    }
    flat += character;
    cursor += 1;
  }
  return [...flat.matchAll(TOP_LEVEL_PROPERTY)].map((match) => match[1] ?? '');
};

/** ワーカーの側の 1 つのファイルの、監査モードの値と名前の参照（`<ファイル>: <当たった字句>`。コメントは数えない）。 */
const modeReferencesOf = ({ path, content }: UnscannedFile): readonly string[] => {
  if (!PREFILTER.test(content)) {
    return [];
  }
  const { code, bare } = scanFile({ path, content });
  return [
    ...[...code.matchAll(MODE_VALUE_LITERAL)].map((match) => match[0]),
    ...[...bare.matchAll(MODE_IDENTIFIER)].map((match) => match[0]),
  ].map((found) => `${path}: ${found}`);
};

// ---------------------------------------------------------------------------------------------------------------
// 検出の関数の単体テスト（違反の例と、違反でない例）
// ---------------------------------------------------------------------------------------------------------------

describe('the detection of the audit mode in the worker side (examples)', () => {
  it('finds the mode values and names in the code, and not in the comments', () => {
    const file = (content: string): UnscannedFile => ({ path: 'src/worker/example.ts', content });
    expect(modeReferencesOf(file("if (profile.mode === 'TEST_APPROVED_WRITE') {}"))).toEqual(["src/worker/example.ts: 'TEST_APPROVED_WRITE'"]);
    expect(modeReferencesOf(file('const mode = "PUBLIC_PASSIVE";'))).toEqual(['src/worker/example.ts: "PUBLIC_PASSIVE"']);
    expect(modeReferencesOf(file("import { WRITE_AUDIT_MODE } from '../control/contracts.js';"))).toEqual(['src/worker/example.ts: WRITE_AUDIT_MODE']);
    expect(modeReferencesOf(file('const read = (profile: SiteProfile): void => undefined;'))).toEqual(['src/worker/example.ts: SiteProfile']);
    expect(modeReferencesOf(file('type M = AuditMode;'))).toEqual(['src/worker/example.ts: AuditMode']);
    // コメントの中と、名前の一部の一致は数えない。
    expect(modeReferencesOf(file('// TEST_APPROVED_WRITE のプロファイルでも、送信の扱いはジョブの種類で決まる。\nconst x = 1;'))).toEqual([]);
    expect(modeReferencesOf(file('/** WRITE_AUDIT_MODE は読まない。 */\nconst MY_AUDIT_MODES_COUNT = 0; const SiteProfileView = 1;'))).toEqual([]);
    expect(modeReferencesOf(file("const kind = 'AUDIT'; const policy = 'READ_ONLY';"))).toEqual([]);
  });

  it('lists the top level properties of an interface, and not the nested ones', () => {
    const { bare } = scanFile({ path: 'src/control/example.ts', content: [
      'export interface Example extends Base<\'START\'> {',
      '  readonly jobId: string;',
      '  /** 入れ子の型と、コメントの中の { readonly mode: string } は数えない。 */',
      '  readonly nested?: { readonly mode: string };',
      '  readonly list: readonly { readonly auditMode: string }[];',
      '  readonly call: (input: { readonly profileMode: string }) => void;',
      '  readonly last?: boolean;',
      '}',
      'export interface Other { readonly mode: string; }',
    ].join('\n') });
    expect(interfacePropertiesOf(bare, 'Example')).toEqual(['jobId', 'nested', 'list', 'call', 'last']);
    expect(interfacePropertiesOf(bare, 'Other')).toEqual(['mode']);
    expect(interfacePropertiesOf(bare, 'Missing')).toBeUndefined();
  });

  it('reads the property names and the closed flag of a schema definition', () => {
    const schema = { $defs: { a: { additionalProperties: false, properties: { jobId: {}, mode: {} } }, b: { properties: {} } } };
    expect(schemaShapeOf(schema, 'a')).toEqual({ properties: ['jobId', 'mode'], closed: true });
    expect(schemaShapeOf(schema, 'b')).toEqual({ properties: [], closed: false });
    expect(schemaShapeOf(schema, 'c')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------------------------------------------

describe('the worker START has no audit mode, and the worker side does not read the mode (MI-F2, MI-R Minor 13 (a))', () => {
  it('the START shape of the schema has no mode property and accepts no unknown property', () => {
    const stopwatch = startCpuStopwatch();
    const schema: unknown = JSON.parse(readLfTextFile(WORKER_MESSAGE_SCHEMA_PATH));
    for (const name of START_SCHEMA_DEFINITIONS) {
      const shape = schemaShapeOf(schema, name);
      expect(shape, name).toBeDefined();
      expect(shape?.closed, name).toBe(true);
      expect(shape?.properties.length ?? 0, name).toBeGreaterThan(0);
      expect(shape?.properties.filter((property) => MODE_PROPERTY_NAME.test(property)), name).toEqual([]);
    }
    expect(stopwatch.elapsedMs()).toBeLessThan(MAX_GATE_MS);
  });

  it('the START types of worker-protocol.ts have no mode property', () => {
    const stopwatch = startCpuStopwatch();
    const { bare } = scanFile({ path: WORKER_PROTOCOL_PATH, content: readLfTextFile(WORKER_PROTOCOL_PATH) });
    for (const name of START_INTERFACES) {
      const properties = interfacePropertiesOf(bare, name);
      expect(properties, name).toBeDefined();
      expect(properties?.length ?? 0, name).toBeGreaterThan(0);
      expect(properties?.filter((property) => MODE_PROPERTY_NAME.test(property)), name).toEqual([]);
    }
    // 監査の段の送信の扱い（`auditSendPolicy`）とジョブの種類（`jobKind`）は、`START` が持つ（送信の扱いは、モードでなくこれらで決まる）。
    expect(interfacePropertiesOf(bare, 'WorkerStartMessage')).toEqual(expect.arrayContaining(['jobKind', 'auditSendPolicy']));
    expect(stopwatch.elapsedMs()).toBeLessThan(MAX_GATE_MS);
  });

  it('the worker side (src/worker, src/orchestration, src/safety, src/browser) does not refer to the audit mode', () => {
    const files = WORKER_SIDE_DIRECTORIES.flatMap((directory) => readTypeScriptFilesUnder(directory));
    const stopwatch = startCpuStopwatch();
    for (const directory of WORKER_SIDE_DIRECTORIES) {
      expect(files.some(({ path }) => path.startsWith(`${directory}/`)), directory).toBe(true);
    }
    expect(files.flatMap(modeReferencesOf)).toEqual([]);
    expect(stopwatch.elapsedMs()).toBeLessThan(MAX_GATE_MS);
  });
});
