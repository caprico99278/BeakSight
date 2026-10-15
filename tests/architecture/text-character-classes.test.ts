/**
 * 制御文字・行と段落の区切り・向きを変える文字・対になっていないサロゲートの判定の Architecture Gate（CCX-3。共通化の台帳の CC-052、
 * CC-053。`CC-plan.md` の「設計者の判断」の 2）。
 * - 判定と正規表現は、`src/core/text.ts`（`CHARACTER_CLASS_OWNER`）の 1 か所に、名前を付けた変種（Cc だけ、Cc と Zl・Zp、向きを変える
 *   文字、対になっていないサロゲート）として置く。
 * - (a) owner の外の `src/**` に、次の形を書かない（コメントは除き、文字列と正規表現のリテラルは見る）。
 *   - Unicode の性質のエスケープ: `\p{Cc}`、`\p{Zl}`、`\p{Zp}`、`\p{Cs}`、`\p{Bidi_C}` など（`\P{…}`、`gc=` の形を含む）。
 *   - C0 の範囲（`\u0000-\u001f`、`\x00-\x1f`）と、DEL から C1 の範囲（`\u007f-\u009f`、`\x7f-\x9f`）。
 *   - 向きを変える文字（U+061C、U+200E、U+200F、U+202A〜U+202E、U+2066〜U+2069）と、行・段落の区切り（U+2028、U+2029）の
 *     `\u` のエスケープ（`\u{…}` を含む）と、その文字そのもの。
 *   - サロゲートの範囲（`\ud800-\udfff` など）と、`.isWellFormed(` の呼び出し（`hasLoneSurrogate` を使う）。
 *   意味の違う正規表現（`normalize-url.ts` の C0 と空白の `[\u0000- ]`、`isolated-auditor.ts` の ANSI のエスケープシーケンス、
 *   `profile-policy.ts` のゼロ幅の文字）には当たらない形にしてある。正当な使い方（ブラウザの中の関数など）は、`EXCLUSIONS` に理由を
 *   付けて置く（除外の一覧は、このファイルの中の 1 か所だけ。今は空）。
 * - (b) owner は、上の形を自分で持つ（判定が owner にあることの確かめ）。
 * - (c) 元の場所は、owner から import する。
 * - (d) CCX-15（CC-069）: Unicode の正規化（NFKC）と大文字小文字の畳み込みは、owner の `foldNfkcCase` の 1 か所に置く。owner の外の
 *   `src/**` と `apps/local-ui/src/**` に、`'NFKC'` の文字列リテラル（引用符の種類を問わない。`normalize('NFKC')`、`normalize("NFKC")`、
 *   `` normalize(`NFKC`) ``、定数に置いて渡す形、`['normalize']('NFKC')` の形を含む。大文字と小文字を問わない）を書かない。コメントは数えない。
 *   owner は自分で持ち、元の場所（要求の判定の owner と、発見の分類）は owner から import する（`src/safety/` と `src/discovery/` が
 *   `src/core/` を import できることは、`discovery-boundary.test.ts` などの層の Gate が確かめる）。
 * - `src/**` の読み込みは、このファイルの読み込み時に 1 回だけ行う。判定は、`fs`、正規表現、文字列の走査だけで行う（近似の検査）。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findImportSpecifiers, loadSourceFiles, REPOSITORY_ROOT, scanSource, type ScannedSource, type SourceFile } from './source-scan.js';

const SOURCE_FILES = loadSourceFiles();

/** (d) 画面のコードのフォルダ（`apps/local-ui/src/`）と、走査する拡張子。 */
const LOCAL_UI_SOURCE_DIRECTORY = 'apps/local-ui/src/';
const LOCAL_UI_SOURCE_EXTENSION = /\.tsx?$/u;
const LOCAL_UI_SOURCE_FILES: readonly SourceFile[] = readdirSync(join(REPOSITORY_ROOT, LOCAL_UI_SOURCE_DIRECTORY), {
  recursive: true,
  encoding: 'utf8',
})
  .map((relativePath) => `${LOCAL_UI_SOURCE_DIRECTORY}${relativePath.replaceAll('\\', '/')}`)
  .filter((path) => LOCAL_UI_SOURCE_EXTENSION.test(path))
  .sort()
  .map((path) => {
    const content = readFileSync(join(REPOSITORY_ROOT, path), 'utf8');
    return { path, content, ...scanSource(content) };
  });

/** 文字の種類の判定の owner。 */
const CHARACTER_CLASS_OWNER = 'src/core/text.ts';

/** owner から import する、元の場所。 */
const CHARACTER_CLASS_USERS: readonly string[] = [
  'src/core/artifact-layout.ts',
  'src/cli/output.ts',
  'src/control/profile-policy.ts',
  'src/control/worker-protocol.ts',
  'src/control/auth/auth-setup-policy.ts',
  'src/interaction/isolated-auditor.ts',
  'src/control/credentials/dpapi-protector.ts',
  'src/control/credentials/credential-store.ts',
];

/** 禁止の形（名前 → 検出の正規表現）。 */
const FORBIDDEN_FORMS: ReadonlyMap<string, RegExp> = new Map([
  [
    'unicode property escape',
    /\\[pP]\{(?:(?:gc|General_Category)=)?(?:Cc|Control|Zl|Line_Separator|Zp|Paragraph_Separator|Cs|Surrogate|Bidi_C|Bidi_Control)\}/gu,
  ],
  ['C0 range', /\\(?:u0000|x00|u\{0+\})-\\(?:u001[fF]|x1[fF]|u\{0*1[fF]\})/gu],
  ['DEL and C1 range', /\\(?:u007[fF]|x7[fF]|u\{0*7[fF]\})-\\(?:u009[fF]|x9[fF]|u\{0*9[fF]\})/gu],
  ['bidirectional control escape', /\\u(?:061[cC]|200[eEfF]|202[a-eA-E]|206[6-9])|\\u\{0*(?:61[cC]|200[eEfF]|202[a-eA-E]|206[6-9])\}/gu],
  ['line separator escape', /\\u202[89]|\\u\{0*202[89]\}/gu],
  ['raw bidirectional control or line separator', /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]/gu],
  ['surrogate range', /\\u[dD][89a-fA-F][0-9a-fA-F]{2}-\\u[dD][89a-fA-F][0-9a-fA-F]{2}/gu],
  ['isWellFormed call', /\.isWellFormed\s*\(/gu],
]);

/** `source.code`（コメントを除いた本文）の中の、禁止の形（`<形の名前>: <書いたままの形>`）。 */
const findCharacterClassForms = (source: ScannedSource): readonly string[] =>
  [...FORBIDDEN_FORMS].flatMap(([name, pattern]) => [...source.code.matchAll(pattern)].map((match) => `${name}: ${match[0]}`));

/**
 * 除外（`<ファイル>: <検出した形>` → 理由）。ブラウザの中で動く関数（外の値を参照できない）など、owner の部品を使えない正当な場所だけを
 * 置く。今は該当がない（6 か所の正規表現は、どれも Node の側で使われている）。
 */
const EXCLUSIONS: ReadonlyMap<string, string> = new Map();

const detects = (text: string): readonly string[] => findCharacterClassForms(scanSource(text));

const sourceFile = (path: string): SourceFile => {
  const file = SOURCE_FILES.find((candidate) => candidate.path === path);
  expect(file, path).toBeDefined();
  return file ?? { path, content: '', ...scanSource('') };
};

describe('character class forms detector (CCX-3)', () => {
  it('detects the forms of the control, line separator, bidirectional control and surrogate checks', () => {
    expect(detects('const A = /\\p{Cc}/u;')).toEqual(['unicode property escape: \\p{Cc}']);
    expect(detects('const A = /[\\p{Cc}\\p{Zl}\\p{Zp}]/gu;')).toHaveLength(3);
    expect(detects('const A = /\\P{gc=Cs}/u;')).toEqual(['unicode property escape: \\P{gc=Cs}']);
    expect(detects('const A = /[\\u0000-\\u001f\\u007f-\\u009f]/gu;')).toEqual([
      'C0 range: \\u0000-\\u001f',
      'DEL and C1 range: \\u007f-\\u009f',
    ]);
    expect(detects('const A = /[\\x00-\\x1F]/u;')).toEqual(['C0 range: \\x00-\\x1F']);
    expect(detects('const A = /[\\u202A-\\u202E\\u2066-\\u2069\\u200e\\u200f\\u061c]/u;')).toHaveLength(7);
    expect(detects("const A = '\\u{202e}';")).toEqual(['bidirectional control escape: \\u{202e}']);
    expect(detects('const A = /[\\p{Cc}\\u2028\\u2029]/u;')).toHaveLength(3);
    expect(detects('const A = "x\u202ey";')).toEqual(['raw bidirectional control or line separator: \u202e']);
    expect(detects('const A = /[\\ud800-\\udfff]/gu;')).toEqual(['surrogate range: \\ud800-\\udfff']);
    expect(detects('const ok = value.isWellFormed();')).toEqual(['isWellFormed call: .isWellFormed(']);
  });

  it('ignores comments and the regular expressions with a different meaning', () => {
    expect(detects('// /\\p{Cc}/u and \\u202e\nconst A = 1;')).toEqual([]);
    expect(detects('/** value.isWellFormed() */\nconst A = 1;')).toEqual([]);
    // URL の前の C0 の制御文字と空白（normalize-url.ts）。
    expect(detects('const A = /^([\\u0000- ]*(?:[A-Za-z]+:)?)@/u;')).toEqual([]);
    // ANSI のエスケープシーケンス（isolated-auditor.ts）。
    expect(detects('const A = /(?:\\u001b[PX\\]^_]|[\\u0090\\u0098\\u009d-\\u009f])[^\\u0007\\u001b\\u009c]*/gu;')).toEqual([]);
    // ゼロ幅の文字（profile-policy.ts）。
    expect(detects('const A = /[\\s\\u200b-\\u200d\\u2060\\ufeff]/gu;')).toEqual([]);
    // サロゲートペアの文字（範囲ではない）と、ほかの Unicode の性質。
    expect(detects("const A = '\\ud83d\\ude00'; const B = /[^\\p{L}\\p{N}]+/gu;")).toEqual([]);
    expect(detects('const A = text.toWellFormed();')).toEqual([]);
  });
});

describe('character class Gate (CCX-3)', () => {
  it(`(a) only ${CHARACTER_CLASS_OWNER} writes the control, line separator, bidirectional control and surrogate checks in src/**`, () => {
    const detections = SOURCE_FILES
      .filter((file) => file.path !== CHARACTER_CLASS_OWNER)
      .flatMap((file) => findCharacterClassForms(file).map((match) => `${file.path}: ${match}`));
    for (const key of EXCLUSIONS.keys()) {
      expect(detections, `除外が古くなっている: ${key}`).toContain(key);
    }
    expect(detections.filter((detection) => !EXCLUSIONS.has(detection))).toEqual([]);
  });

  it('(b) the owner holds the named checks', () => {
    const forms = findCharacterClassForms(sourceFile(CHARACTER_CLASS_OWNER)).map((form) => form.slice(0, form.indexOf(':')));
    expect(new Set(forms)).toEqual(new Set(['unicode property escape', 'bidirectional control escape', 'surrogate range', 'isWellFormed call']));
  });

  it('(c) the original places import the checks from the owner', () => {
    for (const path of CHARACTER_CLASS_USERS) {
      const specifiers = findImportSpecifiers(sourceFile(path).code);
      expect(specifiers.some((specifier) => specifier.endsWith('/core/text.js') || specifier === './text.js'), path).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// (d) NFKC と大文字小文字の畳み込み（CCX-15。共通化の台帳の CC-069）
// ---------------------------------------------------------------------------------------------------------------

/** (d) owner の畳み込みを使う、元の場所。 */
const NFKC_FOLD_USERS: readonly string[] = ['src/safety/request-policy.ts', 'src/discovery/classify.ts'];
/** (d) owner の畳み込みの関数の名前。 */
const NFKC_FOLD_FUNCTION = 'foldNfkcCase';
/** (d) NFKC の正規化の形の名前の文字列リテラル（大文字と小文字を問わない）。 */
const NFKC_FORM_LITERAL = /^nfkc$/iu;

/** (d) `'NFKC'` の文字列リテラル（テンプレートは固定の部分ごと。コメントは数えない）。 */
const findNfkcLiterals = (source: ScannedSource): readonly string[] =>
  source.literals.filter((literal) => NFKC_FORM_LITERAL.test(literal));

describe('NFKC case folding detector (CCX-15)', () => {
  it('detects the NFKC form in every kind of quote, also through a constant or an indexed call', () => {
    expect(findNfkcLiterals(scanSource("const a = text.normalize('NFKC');"))).toEqual(['NFKC']);
    expect(findNfkcLiterals(scanSource('const a = text.normalize("NFKC");'))).toEqual(['NFKC']);
    expect(findNfkcLiterals(scanSource('const a = text.normalize(`NFKC`);'))).toEqual(['NFKC']);
    expect(findNfkcLiterals(scanSource("const a = text?.normalize( 'NFKC' ).toUpperCase().toLowerCase();"))).toEqual(['NFKC']);
    expect(findNfkcLiterals(scanSource("const FORM = 'NFKC';\nconst a = text.normalize(FORM);"))).toEqual(['NFKC']);
    expect(findNfkcLiterals(scanSource("const a = text['normalize']('nfkc');"))).toEqual(['nfkc']);
  });

  it('ignores comments, other normalization forms and texts that only mention NFKC', () => {
    expect(findNfkcLiterals(scanSource("// text.normalize('NFKC')\n/** `normalize('NFKC')` */\nconst a = 1;"))).toEqual([]);
    expect(findNfkcLiterals(scanSource("const a = text.normalize('NFC');\nconst b = text.normalize();"))).toEqual([]);
    expect(findNfkcLiterals(scanSource("const a = 'Unicode の NFKC の正規化';\nconst b = foldNfkcCase(text);"))).toEqual([]);
  });
});

describe('NFKC case folding Gate (CCX-15)', () => {
  it('reads src/** and apps/local-ui/src/** once', () => {
    expect(LOCAL_UI_SOURCE_FILES.some((file) => file.path === `${LOCAL_UI_SOURCE_DIRECTORY}start.ts`)).toBe(true);
    expect(LOCAL_UI_SOURCE_FILES.some((file) => file.path.endsWith('.tsx'))).toBe(true);
  });

  it(`(d) only ${CHARACTER_CLASS_OWNER} writes the NFKC normalization in src/** and apps/local-ui/src/**`, () => {
    const detections = [...SOURCE_FILES, ...LOCAL_UI_SOURCE_FILES]
      .filter((file) => file.path !== CHARACTER_CLASS_OWNER)
      .flatMap((file) => findNfkcLiterals(file).map((literal) => `${file.path}: ${literal}`));
    expect(detections).toEqual([]);
  });

  it('(d) the owner holds the named folding', () => {
    const owner = sourceFile(CHARACTER_CLASS_OWNER);
    expect(findNfkcLiterals(owner)).toEqual(['NFKC']);
    expect(owner.bare).toMatch(new RegExp(`\\bexport\\s+const\\s+${NFKC_FOLD_FUNCTION}\\s*=`, 'u'));
  });

  it('(d) the original places import the folding from the owner', () => {
    for (const path of NFKC_FOLD_USERS) {
      const file = sourceFile(path);
      expect(findImportSpecifiers(file.code).some((specifier) => specifier.endsWith('/core/text.js')), path).toBe(true);
      expect(file.bare, path).toMatch(new RegExp(`\\b${NFKC_FOLD_FUNCTION}\\b`, 'u'));
    }
  });
});
