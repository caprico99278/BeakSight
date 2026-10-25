/**
 * テストの中の HTTP のサーバの Gate（PRE42-CC の組 8。台帳の CC-043）。判定は `fs`、正規表現、文字列の検索だけ（`source-scan.ts` の
 * `readTypeScriptFilesUnder`・`scanFile`・`scanSource`・`findModuleReferences` を共用する）。近似の検査である。
 * - 見る所: 結合のテスト（`tests/integration/**`）、部品のテスト（`tests/component/**`）、単体のテスト（`tests/unit/**`）、テストの補助
 *   （`tests/helpers/**`）、画面のテスト（`apps/local-ui/tests/**`）。
 * - 127.0.0.1 で待ち受けて、受けた接続を記録し、閉じるときにその接続を切るテストのサーバは、`tests/helpers/loopback-server.ts` の
 *   `startLoopbackHttpServer` だけが作る。ほかのファイルで、HTTP のサーバを手で作る形を数える:
 *   - `node:http`・`node:https`・`node:http2`（`node:` のない形も）から名前つきで読んだ `createServer`・`createSecureServer` の呼び出し
 *     （別名 `createServer as createHttpServer` も追う）と、`Server` の `new`。
 *   - 同じモジュールを名前空間・既定で読んだ形（`http.createServer(`・`new http.Server(`）。
 *   - 同じモジュールの動的な読み込み（`import('node:http')`・`require('node:http')`）。1 つにつき 1 件と数える。
 *   - 数えない: `node:net` の生のサーバ（応答の形を持たない別の部品）、コメントと文字列の中、型だけの import。
 * - 除外は閉じた一覧（ファイル → 件数と理由）。件数がちょうど合うことを確かめる（除外のファイルに新しいサーバを足しても、寄せて減らしても
 *   落ちる。使われなくなった除外も誤りにする）。
 * - 1 ファイル 1 秒以内に終える。本文の文字列で絞ってから走査する（走査は文字ずつで重いため。DEF-107）。
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_GATE_MS,
  TEST_SOURCE_DIRECTORIES,
  escapeRegExp,
  findModuleReferences,
  judgeWithFileExceptions,
  modulePattern,
  readLfTypeScriptFilesUnder,
  scanFile,
  sourceFileOf,
  startCpuStopwatch,
  type FileExceptionJudgement,
  type ModuleReference,
  type ModuleReferenceForm,
  type SourceFile,
  type UnscannedFile,
} from './source-scan.js';

const LOOPBACK_SERVER_OWNER = 'tests/helpers/loopback-server.ts';

/** 見るファイル（読み込みは 1 回だけ。改行は LF にそろえる。`source-scan.ts` の `readLfTypeScriptFilesUnder`）。 */
const FILES: readonly UnscannedFile[] = readLfTypeScriptFilesUnder(TEST_SOURCE_DIRECTORIES);

/** HTTP のサーバを作るモジュールの指定子（`node:` の有無を問わない。`source-scan.ts` の `modulePattern`。PRE42-CC 組 G）。 */
const HTTP_SERVER_MODULE = modulePattern(['http', 'https', 'http2']);
/** サーバを作る関数の名前。 */
const SERVER_FACTORY_NAMES: ReadonlySet<string> = new Set(['createServer', 'createSecureServer']);
/** サーバの class の名前。 */
const SERVER_CLASS_NAME = 'Server';

const IDENTIFIER = String.raw`[A-Za-z_$][\w$]*`;
/** 名前空間の import の節（`* as http`）。 */
const NAMESPACE_BINDING = new RegExp(String.raw`\*\s*as\s+(${IDENTIFIER})`, 'u');
/** 名前つきの import の項目（`createServer`・`createServer as createHttpServer`）。 */
const NAMED_ITEM = new RegExp(String.raw`^(${IDENTIFIER})(?:\s+as\s+(${IDENTIFIER}))?$`, 'u');
/** 指定子を文字列で読み込む形（静的な import の文のほか）。 */
const LOADING_FORMS: ReadonlySet<ModuleReferenceForm> = new Set(['dynamic-import', 'require', 'create-require', 'builtin-module']);

/**
 * HTTP のサーバを作る式の形（`bare` に当てる）。import の文は `source-scan.ts` の `findModuleReferences` で取り出す（指定子の正規表現は
 * そこだけに書く。CCX-9）。
 */
const serverShapesOf = (references: readonly ModuleReference[]): readonly RegExp[] => {
  const shapes: RegExp[] = [];
  for (const reference of references) {
    if (reference.form !== 'static' || reference.typeOnly || reference.statement?.keyword !== 'import' || !HTTP_SERVER_MODULE.test(reference.specifier)) {
      continue;
    }
    const objectNames = [reference.defaultBinding ?? undefined, NAMESPACE_BINDING.exec(reference.statement.clause)?.[1]]
      .filter((name) => name !== undefined);
    for (const name of objectNames) {
      shapes.push(new RegExp(String.raw`(?<![\w$.])${escapeRegExp(name)}\s*\.\s*(?:createServer|createSecureServer)\s*\(`, 'gu'));
      shapes.push(new RegExp(String.raw`\bnew\s+${escapeRegExp(name)}\s*\.\s*${SERVER_CLASS_NAME}\s*\(`, 'gu'));
    }
    for (const item of reference.namedBindings) {
      const named = NAMED_ITEM.exec(item);
      const imported = named?.[1];
      const local = named?.[2] ?? imported;
      if (imported === undefined || local === undefined) {
        continue;
      }
      if (SERVER_FACTORY_NAMES.has(imported)) {
        shapes.push(new RegExp(String.raw`(?<![\w$.])${escapeRegExp(local)}\s*(?:<[^<>()]*>)?\s*\(`, 'gu'));
      } else if (imported === SERVER_CLASS_NAME) {
        shapes.push(new RegExp(String.raw`\bnew\s+${escapeRegExp(local)}\s*(?:<[^<>()]*>)?\s*\(`, 'gu'));
      }
    }
  }
  return shapes;
};

/**
 * HTTP のサーバを手で作った所（当たった本文。本文の中の順）。`bare` はテンプレートの中の改行を除くので、行の番号は出さない。
 * 動的な読み込み（`import('node:http')` など）は、1 つにつき 1 件として最後に並べる。
 */
const handWrittenServersOf = (file: Pick<SourceFile, 'code' | 'bare'>): readonly string[] => {
  const references = findModuleReferences(file.code);
  const found = serverShapesOf(references)
    .flatMap((shape) => [...file.bare.matchAll(shape)].map((match) => ({ index: match.index, text: match[0] })))
    .sort((left, right) => left.index - right.index)
    .map(({ text }) => text);
  const loaded = references
    .filter((reference) => LOADING_FORMS.has(reference.form) && HTTP_SERVER_MODULE.test(reference.specifier))
    .map((reference) => reference.text);
  return [...found, ...loaded].map((text) => text.replace(/\s+/gu, ' ').trim());
};

/** 除外（ファイル → 手で作るサーバの件数と理由）。寄せたら件数を減らすか、消す。 */
const HAND_WRITTEN_SERVER_EXCEPTIONS: Readonly<Record<string, { readonly count: number; readonly reason: string }>> = Object.freeze({
  'tests/helpers/chromium-egress-recorder.ts': {
    count: 1,
    reason: '記録用の中継（要求を 127.0.0.1 へ転送する HTTP の proxy。CONNECT のトンネルを持つ。CC-043 の D）',
  },
  'apps/local-ui/tests/request-guard.test.ts': {
    count: 1,
    reason: '守りの部品（`guardNodeRequest`）を掛けて要求 1 件ごとに起こして閉じるサーバ（接続を記録して切る形ではない。CC-043 の D）',
  },
});

/** 文字列 `http` を書いたファイル（絞ってから走査する）。 */
const filesWithHttpText = (): readonly SourceFile[] => FILES
  .filter(({ path, content }) => path !== LOOPBACK_SERVER_OWNER && content.includes('http'))
  .map((file) => scanFile(file));

/** 当たったファイルを、除外と見つけたものに分ける（除外は件数がちょうど合うこと。`source-scan.ts` の `judgeWithFileExceptions`）。 */
const judge = (files: readonly SourceFile[]): FileExceptionJudgement =>
  judgeWithFileExceptions(files, handWrittenServersOf, HAND_WRITTEN_SERVER_EXCEPTIONS);

const sample = (content: string): SourceFile => sourceFileOf('tests/integration/planted.test.ts', content);

describe('Gate: the test servers on 127.0.0.1 come from tests/helpers/loopback-server.ts (PRE42-CC group 8, CC-043)', () => {
  it('reads the files and the owner', () => {
    const paths = FILES.map(({ path }) => path);
    expect(paths).toEqual(expect.arrayContaining([LOOPBACK_SERVER_OWNER, ...Object.keys(HAND_WRITTEN_SERVER_EXCEPTIONS)]));
    const owner = FILES.find(({ path }) => path === LOOPBACK_SERVER_OWNER)?.content ?? '';
    expect(owner).toMatch(/^export async function startLoopbackHttpServer\(/mu);
  });

  it('writes no HTTP server by hand outside tests/helpers/loopback-server.ts (CC-043)', () => {
    const stopwatch = startCpuStopwatch();
    const files = filesWithHttpText();
    const { found, countMismatches, unusedExceptions } = judge(files);
    expect(found).toEqual([]);
    expect(countMismatches, 'exceptions whose count does not match').toEqual([]);
    expect(unusedExceptions, 'exceptions that are no longer used').toEqual([]);
    expect(stopwatch.elapsedMs()).toBeLessThan(MAX_GATE_MS * Math.max(1, files.length));
  });

  it('finds the shapes placed on purpose, and does not count raw net servers, comments, strings and types (the control)', () => {
    expect(handWrittenServersOf(sample([
      "import { createServer, type IncomingMessage } from 'node:http';",
      "import {\n  createServer as createHttpsServer,\n} from 'https';",
      "import * as http from 'node:http';",
      "import http2, { Server as H2 } from 'node:http2';",
      "import { createServer as createNetServer } from 'node:net';",
      "import type { Server } from 'node:http';",
      'const a = createServer((request, response) => response.end());',
      'const b = createHttpsServer({ cert, key }, handler);',
      'const c = http.createServer(handler);',
      'const d = new http.Server(handler);',
      'const e = http2.createSecureServer({});',
      'const f = new H2();',
      "const g = await import('node:http');",
      // 当たらない: 生の net のサーバ、コメント、文字列、ほかの物の同じ名前のメソッド。
      'const h = createNetServer();',
      '// const i = createServer(handler);',
      "const j = 'createServer(handler)';",
      'const k = other.createServer(handler);',
    ].join('\n')))).toEqual([
      'createServer(',
      'createHttpsServer(',
      'http.createServer(',
      'new http.Server(',
      'http2.createSecureServer(',
      'new H2(',
      "import('node:http'",
    ]);
    expect(handWrittenServersOf(sample([
      "import { createServer } from 'node:net';",
      'const server = createServer();',
    ].join('\n')))).toEqual([]);
  });
});
