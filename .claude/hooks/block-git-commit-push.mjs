// PreToolUse フック: git commit / git push を含むコマンドの実行を拒否する。
// メインエージェント・サブエージェントの両方に適用される。
// 対象: Bash、PowerShell、Desktop Commander の start_process / interact_with_process。

import { readFileSync } from 'node:fs';

const input = JSON.parse(readFileSync(0, 'utf8'));
const toolInput = input.tool_input ?? {};
const command = [toolInput.command, toolInput.input]
  .filter((value) => typeof value === 'string')
  .join('\n');

// git（git.exe を含む）の後に、-C <path> や -c <key=value>、--xxx などのオプションが続き、
// その次のサブコマンドが commit または push であるものを検出する。
const GIT_COMMIT_OR_PUSH =
  /(?:^|[^\w-])git(?:\.exe)?(?:\s+(?:-[cC]\s+\S+|--?[\w-]+(?:=\S+)?))*\s+(commit|push)(?=\s|$|[;&|)'"])/im;

const match = command.match(GIT_COMMIT_OR_PUSH);
if (match) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `このリポジトリでは git ${match[1].toLowerCase()} は禁止されています。` +
          'コミットとプッシュはユーザーが自分で行います。変更は作業ツリーに残したまま、ユーザーに報告してください。',
      },
    }),
  );
}
process.exit(0);
