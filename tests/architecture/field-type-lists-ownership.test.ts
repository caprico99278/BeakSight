/**
 * 候補の欄の型の一覧の Architecture Gate（T30f fix round 2。Task 30 の設計書 3 章の「送る中身の照合」、DEF-098 の発見事項 2）。
 * - 欄の型の一覧のうち、複数の場所が同じ意味で使うもの（select の型 `SELECT_FIELD_TYPES`、既定の値が分からない欄の型
 *   `DEFAULT_VALUE_FIELD_TYPES`、選択の欄の型 `CHOICE_FIELD_TYPES`、値を入れて送れる欄の型 `VALUE_INPUT_FIELD_TYPES`（CCX-20））は、
 *   候補の欄の形の owner（`src/discovery/candidate-contracts.ts`）の
 *   1 か所に置く。書き込みの入力の部品（`write-form-submitter.ts`）とシナリオの下書きの確かめ（`scenario-policy.ts`）は同じ
 *   `DEFAULT_VALUE_FIELD_TYPES`（の判定 `isDefaultValueFieldType`）を使う（片方だけ変えて、承認できても実行で必ず送らないシナリオを作らせない）。
 * - (a) owner の外の `src/**` と `apps/local-ui/src/**` に、文字列リテラルだけの配列で、要素の集合が上の一覧のどれかと同じもの
 *   （順と重複は問わない。`new Set([...])` の中を含む）を書かない（コメントは数えない）。上の一覧を含む、より大きな一覧（例: 汎用の規則の型）は
 *   別の意味なので当たらない。
 * - (b) owner は一覧を持ち、元の場所（入力の部品、下書きの確かめ、業務テンプレート、欄の評価）は owner から import する。
 * - `src/**` の読み込みは、このファイルの読み込み時に 1 回だけ行う。判定は正規表現と文字列の走査だけで行う（近似の検査。1 秒以内）。
 */
import { describe, expect, it } from 'vitest';
import {
  CANDIDATE_FIELD_TYPES,
  CHOICE_FIELD_TYPES,
  DEFAULT_VALUE_FIELD_TYPES,
  SELECT_FIELD_TYPES,
  VALUE_INPUT_FIELD_TYPES,
} from '../../src/discovery/candidate-contracts.js';
import { findNamedImports, loadLocalUiSourceFiles, loadSourceFiles, scanSource, violationsOf, type SourceFile } from './source-scan.js';

const SOURCE_FILES: readonly SourceFile[] = [...loadSourceFiles(), ...loadLocalUiSourceFiles()];

const OWNER = 'src/discovery/candidate-contracts.ts';

/** 守る一覧（名前と要素）。 */
const GUARDED_LISTS: readonly (readonly [string, readonly string[]])[] = [
  ['SELECT_FIELD_TYPES', SELECT_FIELD_TYPES],
  ['DEFAULT_VALUE_FIELD_TYPES', DEFAULT_VALUE_FIELD_TYPES],
  ['CHOICE_FIELD_TYPES', CHOICE_FIELD_TYPES],
  ['VALUE_INPUT_FIELD_TYPES', VALUE_INPUT_FIELD_TYPES],
];

/**
 * (b) owner の一覧（か、その一覧の判定）を import する元の場所と、その名前。入力の部品と下書きの確かめは、同じ判定
 * `isDefaultValueFieldType`（`DEFAULT_VALUE_FIELD_TYPES` の判定）を使う。
 */
const USERS: readonly (readonly [string, string])[] = [
  ['src/browser/write-form-submitter.ts', 'isDefaultValueFieldType'],
  ['src/browser/write-form-submitter.ts', 'SELECT_FIELD_TYPES'],
  ['src/control/approval/scenario-policy.ts', 'isDefaultValueFieldType'],
  ['src/control/data-rules/business-templates.ts', 'CHOICE_FIELD_TYPES'],
  ['src/control/data-rules/field-evaluation.ts', 'CHOICE_FIELD_TYPES'],
  ['src/control/data-rules/business-templates.ts', 'VALUE_INPUT_FIELD_TYPES'],
];

/** 文字列リテラルだけの配列（コメントを除いた本文）。 */
const STRING_ARRAY_PATTERN = /\[\s*(?:(?:'[^'\n]*'|"[^"\n]*")\s*,\s*)*(?:'[^'\n]*'|"[^"\n]*")\s*,?\s*\]/gu;
const STRING_LITERAL_PATTERN = /'([^'\n]*)'|"([^"\n]*)"/gu;

const sameSet = (left: readonly string[], right: readonly string[]): boolean => {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === rightSet.size && [...leftSet].every((value) => rightSet.has(value));
};

/** (a) 守る一覧と同じ集合の、文字列リテラルだけの配列（`<一覧の名前>: <配列>`）。 */
const copiedListsOf = (code: string): readonly string[] =>
  [...code.matchAll(STRING_ARRAY_PATTERN)].flatMap(([array]) => {
    const values = [...array.matchAll(STRING_LITERAL_PATTERN)].map((match) => match[1] ?? match[2] ?? '');
    return GUARDED_LISTS.filter(([, list]) => sameSet(values, list)).map(([name]) => `${name}: ${array.replace(/\s+/gu, ' ')}`);
  });

/** 一覧の書き写し（`<パス>: <見つけたもの>`。`source-scan.ts` の `violationsOf`。PRE42-CC 組 G）。 */
const copiedListViolationsOf = (files: readonly SourceFile[]): readonly string[] => violationsOf(files, (file) => copiedListsOf(file.code));

describe('field type lists (T30f fix round 2)', () => {
  it('lists the value input field types as the candidate field types without password, file and hidden (CCX-20)', () => {
    expect([...VALUE_INPUT_FIELD_TYPES]).toEqual(CANDIDATE_FIELD_TYPES.filter((type) => !['password', 'file', 'hidden'].includes(type)));
    expect(Object.isFrozen(VALUE_INPUT_FIELD_TYPES)).toBe(true);
  });

  it('detects a copied list in an array or a set, in any order, and ignores comments and larger lists', () => {
    const detected = copiedListsOf(scanSource([
      "const a = new Set(['select-multiple', 'select-one']);",
      "const b = Object.freeze(['select-one', 'select-multiple', 'range', 'color'] as const);",
      'const c = ["checkbox", "radio", "select-one", "select-multiple"];',
      "const g = ['text', 'search', 'textarea', 'email', 'url', 'tel', 'number', 'range', 'date', 'month', 'week', 'time', 'datetime-local', 'color', 'checkbox', 'radio', 'select-one', 'select-multiple'];",
      "// const d = ['select-one', 'select-multiple'];",
      "const e = ['number', 'select-one', 'select-multiple'];",
      "const f = [...SELECT_FIELD_TYPES, 'range', 'color'];",
    ].join('\n')).code);
    expect(detected.map((violation) => violation.split(':')[0]))
      .toEqual(['SELECT_FIELD_TYPES', 'DEFAULT_VALUE_FIELD_TYPES', 'CHOICE_FIELD_TYPES', 'VALUE_INPUT_FIELD_TYPES']);
  });

  it('(a) keeps the lists in the owner only', () => {
    expect(SOURCE_FILES.some((file) => file.path === OWNER)).toBe(true);
    expect(copiedListViolationsOf(SOURCE_FILES.filter((file) => file.path !== OWNER))).toEqual([]);
  });

  it('(b) the owner has the lists, and the users import them from the owner', () => {
    const owner = SOURCE_FILES.find((file) => file.path === OWNER);
    for (const [name] of GUARDED_LISTS) {
      expect(owner?.code, name).toMatch(new RegExp(`export const ${name}\\b`, 'u'));
    }
    for (const [path, name] of USERS) {
      const file = SOURCE_FILES.find((candidate) => candidate.path === path);
      const imported = findNamedImports(file?.code ?? '')
        .some((entry) => entry.names.includes(name) && entry.specifier.endsWith('discovery/candidate-contracts.js'));
      expect(imported, `${path} imports ${name}`).toBe(true);
    }
  });
});
