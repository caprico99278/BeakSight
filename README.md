# local/

このディレクトリはGit管理対象外です（`.gitignore` 参照）。実行時に必要だが
決してコミットしてはならない、端末固有・非公開の情報はここに置きます。
顧客を特定できる実際のターゲット設定もここに含まれます。

## ターゲット設定

`config/targets/` にはGitで公開しても問題のない汎用的なサンプル設定のみを
置きます。顧客を特定できる実際のターゲット設定は、代わりにここへ配置してください。

```
local/targets/<対象名>.json
```

実行時は `--config` で明示的に指定します。

```bash
node dist/cli/index.js run --config local/targets/<対象名>.json
```

`loadConfig()` は `config/targets/` 配下に `*.json` がちょうど1つだけ存在する
場合にのみ自動選択します。`local/` 配下のファイルは自動選択の対象にならないため、
必ず `--config` で明示的に参照してください。
