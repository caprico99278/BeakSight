あなたは BeakSight リポジトリ（`/home/user/BeakSight`。Linux のクラウドの環境）の実装担当です。
設計は設計者が決めます。あなたの仕事は、以下のサブタスクを指示された範囲の中で、TDD で実装することです。

# サブタスク

- ID: DEF-017
- 目的: CLI の `--headless` の説明に、設定の `browser.headed` を上書きすることを書き、`--headed` の説明とそろえる。
- 設計書: `doc/design/2026-09-26-beaksight-post-task-19-defects-design.md` の 3.1、7章
- 実装計画: `doc/design/2026-09-26-beaksight-post-task-19-defects-implementation-plan.md` の「DEF-017」

作業を始める前に、上の設計書と実装計画の該当箇所を必ず読んでください。

# 変更してよいファイル

- `src/presentation/messages.ts`（`CLI_OPTION_DESCRIPTIONS.headless.description` の文だけ）
- `tests/unit/cli.test.ts`

これ以外のファイルを変更する必要があると分かった場合は、変更せずに止まり、Blocker として報告してください。README は変えません。

# 使うべき共通部品

| 名前 | 置き場所 | 用途 |
| --- | --- | --- |
| `CLI_OPTION_DESCRIPTIONS` | `src/presentation/messages.ts` | オプションの説明の唯一の置き場所。テストでは文字列を書き写さず、これを参照する |
| `CLI_TEXT.usage` | `src/presentation/messages.ts` | 使い方の表示の見出し |
| `invokeCli` など | `tests/unit/cli.test.ts` の既存の補助 | 使い方の表示を得る |

新しい共通部品は作りません。

# 手順

1. RED: `tests/unit/cli.test.ts` に次のテストを加える。
   - `CLI_OPTION_DESCRIPTIONS.headed.description` と `CLI_OPTION_DESCRIPTIONS.headless.description` が、どちらも設定の `browser.headed` を上書きすることを書いている（例: どちらも `browser.headed` という語と「上書き」を含む）。
   - `--help` の使い方の表示で、`  --headless` の次の行が `CLI_OPTION_DESCRIPTIONS.headless.description` である（既存の「lists --help with its Japanese description among the options of the usage」と同じ形）。
   `npx vitest run tests/unit/cli.test.ts` で、1つめの確かめが今の説明で失敗することを見る。
2. 最小実装: `headless` の説明を `ブラウザの画面を表示せずに実行します。設定の browser.headed を上書きします。--headed と同時には指定できません。` に変える。
3. GREEN: `npx vitest run tests/unit/cli.test.ts`
4. 関連する検証: `npx vitest run tests/architecture tests/integration/cli.test.ts`、`npm run typecheck`

# 受け入れ条件

- 追加したテストが、変更の前に失敗し、変更の後に PASS する。
- `tests/unit/cli.test.ts`、`tests/architecture`、`tests/integration/cli.test.ts` がすべて PASS する。型チェックが PASS する。
- 変更したファイルが、上の2つだけである（`git status` で確かめる）。

# 守ること

- Git: コミットやプッシュは禁止です。作業ツリーやファイルを HEAD や過去の状態に戻す操作（`git checkout`、`git restore`、`git reset`、`git stash`、`git switch`、`git clean`、`git worktree`、`merge`、`rebase`、`pull` など）も禁止です。使ってよいのは表示だけの `git status`、`git diff`、`git log`、`git blame`、`git show` です。
- 不具合が「前からあったものか」を確かめるために、HEAD の状態に戻して試すことはしないでください。現在の状態で再現した事実だけを報告してください。
- テストを削除したり、条件を弱めたり、skip にしたりして PASS させないでください。
- 設計書の SSOT owner とは別の場所に、同じ判断や変換を実装しないでください。
- 新しい関数・定数・型・文字列を書く前に、同じ意味のものが `src/`・`tests/`・`fixtures/` にないかを検索し、あればそれを使ってください。変更してよいファイルの外にあって使えない場合は、複製を作らずに止まり、Blocker として報告してください。
- 上限値や閾値などの数値を、定義元から参照せずに直接書かないでください。
- CLI の出力や HTML レポートの文言・ラベル・書式を、表示する側で独自に持たないでください。
- `src/**` に target 固有の名前・domain・URL・selector を書かないでください。本来の監査対象のサイトには接続しないでください。`config/targets/` と `local/` の実サイトの設定を使わないでください。
- 依存パッケージを追加・更新しないでください。ブラウザを追加でインストールしないでください（Chromium は入っています）。
- Chromium は headless だけで起動してください。CLI の `run` を実行する場合は、必ず `--headless` を付け、fixture のサーバだけを対象にしてください。
- 一時ディレクトリに、リポジトリへのリンクを作らないでください。
- 実行していないコマンドやテストを PASS と書かないでください。
- この環境の Node は 22 で、`package.json` の `engines`（24）と違います。その違いが原因と思われる失敗があれば、区別して報告してください。

# 止まるべきとき（Blocker）

次の場合は、自分で回避策を考えて進めず、その時点で作業を止めて報告してください。

- 設計書・実装計画と実際のコードが食い違っていて、どちらに合わせるか判断が必要なとき
- 計画どおりのテストが RED にならない、または計画どおりの実装で GREEN にならないとき
- 変更してよいファイル以外を変更する必要があるとき
- SSOT の第二 owner や安全性の不変条件違反が必要になりそうなとき

# 範囲外の不具合を見つけたとき

今回のサブタスクとは別の原因による不具合を見つけた場合は、修正せずに報告の「発見事項」に書いてください。重複した処理や定数を見つけた場合も、まとめずに「発見事項」に書いてください（`パス:行` と、振る舞いに違いがあるかどうか）。

# 報告

作業の最後に、以下の形式で、意味の通る日本語で報告してください。英語は、識別子・ファイル名・コマンド・固有名詞に限ってください。結論を先に書き、「何を、どう変え、その結果どうなったか」が一度読んで分かるように書いてください。報告は、最後のメッセージとして返してください（ファイルには書かなくてよい）。

```markdown
# <サブタスクID> 実装報告

## 結論
完了 / 一部完了 / Blocker で停止
<1〜3文>

## 変更したファイル
| パス | 変更の内容 |
| --- | --- |

## TDDの記録
- RED: `<コマンド>` → 失敗（<失敗した理由。期待どおりの理由か>）
- GREEN: `<コマンド>` → PASS（テスト数 N、失敗 0、終了コード 0）
- 関連する検証: `<コマンド>` → <結果>

## 受け入れ条件の確認
- [x] <条件> — <確認方法と結果>

## 発見事項
<なければ「なし」>

## 未実行項目
<なければ「なし」>
```
