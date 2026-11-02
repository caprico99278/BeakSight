// PreToolUse フック: Git に載るファイルへ、Git に載せない語（local/secret-terms.txt の一覧）を書くことを拒否する。
// メインエージェント・サブエージェントの両方に適用される。
// 対象: Write・Edit・MultiEdit・NotebookEdit と、Desktop Commander の write_file・edit_block。
// - 書く先が Git に載る path のときだけ調べる。Git に載らない path（`git check-ignore` で無視されるもの、リポジトリの外）は通す。
// - 調べる文字列: Write は書く中身、Edit は new_string（MultiEdit は全部の new_string）、NotebookEdit は new_source。
// - 判定は共通の部品（tools/secret-terms/scan.mjs）の文字列の検査を import して使う（子 process を増やさない）。
// - 一覧がないとき（クラウドやほかの PC の clone）は通す。
// 限界: Bash などで書いたファイルは、ここでは止められない（コミットのときに Git の pre-commit で止まる）。

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { findSecretTermHits, loadSecretTerms, REPOSITORY_ROOT } from '../../tools/secret-terms/scan.mjs';

const input = JSON.parse(readFileSync(0, 'utf8'));
const toolName = typeof input.tool_name === 'string' ? input.tool_name : '';
const toolInput = input.tool_input ?? {};

const DESKTOP_COMMANDER = 'mcp__plugin_desktop-commander_desktop-commander__';

/** 書く先の path と、調べる文字列（複数）。対象でない道具は null。 */
function target() {
  const strings = (values) => values.map((value) => (typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value)));
  switch (toolName) {
    case 'Write':
      return { path: toolInput.file_path, texts: strings([toolInput.content]) };
    case 'Edit':
      return { path: toolInput.file_path, texts: strings([toolInput.new_string]) };
    case 'MultiEdit':
      return {
        path: toolInput.file_path,
        texts: strings((Array.isArray(toolInput.edits) ? toolInput.edits : []).map((edit) => edit?.new_string)),
      };
    case 'NotebookEdit':
      return { path: toolInput.notebook_path, texts: strings([toolInput.new_source]) };
    case `${DESKTOP_COMMANDER}write_file`:
      return { path: toolInput.path, texts: strings([toolInput.content]) };
    case `${DESKTOP_COMMANDER}edit_block`:
      return { path: toolInput.file_path, texts: strings([toolInput.new_string, toolInput.content]) };
    default:
      return null;
  }
}

/** リポジトリの中の相対の path（外なら null）。 */
function repositoryRelativePath(path) {
  const base = typeof input.cwd === 'string' && input.cwd !== '' ? input.cwd : process.cwd();
  const rel = relative(REPOSITORY_ROOT, resolve(base, path));
  if (rel === '' || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) return null;
  return rel.split(sep).join('/');
}

/** Git に載らない path か（`git check-ignore` で無視される、または `.git/` の中）。調べられなければ載るものとして扱う。 */
function isIgnoredByGit(rel) {
  if (rel === '.git' || rel.startsWith('.git/')) return true;
  const result = spawnSync('git', ['check-ignore', '-q', '--', rel], { cwd: REPOSITORY_ROOT, stdio: 'ignore', windowsHide: true });
  return !result.error && result.status === 0;
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }),
  );
}

const found = target();
if (found !== null && typeof found.path === 'string' && found.path !== '') {
  const rel = repositoryRelativePath(found.path);
  const list = rel === null ? null : loadSecretTerms();
  if (rel !== null && list !== null && list.terms.length > 0) {
    const hits = found.texts.flatMap((text, index) =>
      findSecretTermHits(text, list.terms).map((hit) => ({ ...hit, part: index + 1 })),
    );
    if (hits.length > 0 && !isIgnoredByGit(rel)) {
      const several = found.texts.length > 1;
      const places = hits
        .map((hit) => {
          const numbers = hit.termNumbers.map((number) => `${number} 行目`).join('・');
          const where = several ? `${hit.part} 番目の書き換えの ${hit.line} 行目` : `書く文字列の ${hit.line} 行目`;
          return `${where}（伏せる語の一覧の ${numbers}の語）`;
        })
        .join('、');
      deny(
        `${rel} は Git に載るファイルです。書く中身に、Git に載せない語が含まれています: ${places}。` +
          '一般の形（登録の画面、/rest/v1/<x> など）で書き直してください。',
      );
    }
  }
}
process.exit(0);
