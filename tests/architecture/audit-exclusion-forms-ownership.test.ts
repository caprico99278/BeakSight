/**
 * CC-100: 監査の除外で比べる path の形の作り方の owner の Gate。
 * - (a) 形の作り方の部品（percent-encode を戻す、`/` をまとめる、segment の引数を外す、`.` と `..` の解決、形を重ねる）と、その上限の定数を
 *   定義するのは `src/core/audit-exclusion-forms.ts` だけ（`src/**`）。名前の一覧は、まとめる前の 3 か所の名前を含む。
 * - (b) 使う 3 か所（Guard の `request-policy.ts`、認証の設定の `auth-setup-policy.ts`、READ の確かめの画面の path の確かめの owner。T40b-2 で
 *   `read-check-policy.ts` から `read-check-page-path.ts` へ移した）は、owner から
 *   形を読み、`decodeURIComponent` で自分で path を解かない。
 * - 判定は、`fs`、正規表現、文字列の検索だけで行う（`source-scan.ts` の走査を共用する）。1 ファイル 1 秒以内に終える。
 */
import { describe, expect, it } from 'vitest';
import { MAX_GATE_MS, loadSourceFiles, startCpuStopwatch, type SourceFile } from './source-scan.js';

const OWNER = 'src/core/audit-exclusion-forms.ts';
const CONSUMERS: readonly string[] = Object.freeze([
  'src/safety/request-policy.ts',
  'src/control/auth/auth-setup-policy.ts',
  'src/control/read-check-page-path.ts',
]);
/** 形の作り方の部品と上限の名前（まとめる前の名前を含む）。 */
const FORM_BUILDER_NAMES: readonly string[] = Object.freeze([
  'fullyDecoded',
  'fullyPercentDecoded',
  'collapsedSlashesPath',
  'withoutSegmentParametersPath',
  'resolvedDotSegmentsPath',
  'auditPathForms',
  'pathFormsOf',
  'pagePathFormsOf',
  'MAX_PERCENT_DECODE_ROUNDS',
  'MAX_AUDIT_PATH_FORMS',
  'MAX_PAGE_PATH_DECODES',
  'PATH_DELIMITER_ESCAPES',
  'AUDIT_SCOPE_PATH_TRANSFORMS',
  'EXCLUSION_MATCH_PATH_TRANSFORMS',
]);
const DEFINITION = new RegExp(`\\b(?:const|let|function)\\s+(${FORM_BUILDER_NAMES.join('|')})\\b`, 'u');
const OWNER_IMPORT = /from\s+'(?:\.\.\/)+core\/audit-exclusion-forms\.js'/u;
const DECODE_CALL = /\bdecodeURIComponent\s*\(/u;

const FILES = loadSourceFiles();

/** (a) owner の外で、形の作り方の部品か上限を定義したファイル（`<path>: <名前>`）。 */
const definitionViolations = (files: readonly SourceFile[]): readonly string[] => files
  .filter((file) => file.path !== OWNER)
  .flatMap((file) => {
    const match = DEFINITION.exec(file.code);
    return match === null ? [] : [`${file.path}: ${match[1] ?? ''}`];
  });

/** (b) owner から読まないか、自分で path を解く、使う所のファイル。 */
const consumerViolations = (files: readonly SourceFile[]): readonly string[] => CONSUMERS.flatMap((path) => {
  const file = files.find((candidate) => candidate.path === path);
  if (file === undefined) {
    return [`${path}: missing`];
  }
  return [
    ...(OWNER_IMPORT.test(file.code) ? [] : [`${path}: no import of the owner`]),
    ...(DECODE_CALL.test(file.code) ? [`${path}: decodeURIComponent`] : []),
  ];
});

describe('CC-100: the owner of the forms of a path to compare with the audit exclusions', () => {
  it('detects the definitions and the consumers (the detection works)', () => {
    const scanned = (path: string, code: string): SourceFile => ({ path, content: code, code, bare: code, literals: [], wholeLiterals: [] });
    expect(definitionViolations([
      scanned('src/control/a.ts', 'const pagePathFormsOf = (path) => [path];'),
      scanned('src/safety/b.ts', 'function fullyDecoded(value) { return value; }'),
      scanned(OWNER, 'export const fullyPercentDecoded = (value) => value;'),
      scanned('src/control/c.ts', 'const pagePath = 1;'),
    ])).toEqual(['src/control/a.ts: pagePathFormsOf', 'src/safety/b.ts: fullyDecoded']);
    expect(consumerViolations([
      scanned(CONSUMERS[0] ?? '', "import { x } from '../core/audit-exclusion-forms.js';"),
      scanned(CONSUMERS[1] ?? '', 'const decoded = decodeURIComponent(path);'),
    ])).toEqual([
      `${CONSUMERS[1]}: no import of the owner`,
      `${CONSUMERS[1]}: decodeURIComponent`,
      `${CONSUMERS[2]}: missing`,
    ]);
  });

  it('(a) defines the path form builders and their limits only in src/core/audit-exclusion-forms.ts', () => {
    const stopwatch = startCpuStopwatch();
    expect(FILES.some((file) => file.path === OWNER)).toBe(true);
    expect(definitionViolations(FILES)).toEqual([]);
    expect(stopwatch.elapsedMs()).toBeLessThan(MAX_GATE_MS);
  });

  it('(b) the Guard and the two save checks read the forms from the owner and do not decode paths by themselves', () => {
    const stopwatch = startCpuStopwatch();
    expect(consumerViolations(FILES)).toEqual([]);
    expect(stopwatch.elapsedMs()).toBeLessThan(MAX_GATE_MS);
  });
});
