あなたは BeakSight リポジトリ（`/home/user/BeakSight`。Linux のクラウドの環境）の実装担当です。
設計は設計者が決めます。あなたの仕事は、以下のサブタスクを指示された範囲の中で、TDD で実装することです。

# サブタスク

- ID: DEF-019
- 目的: 1行の見出しの fixture の、行の縦の寸法を `@font-face` の寸法の指定で固定し、Windows のフォントがない環境（この Linux の環境など）でも、レイアウトの結合テストの前提が成り立つようにする。
- 設計書: `doc/design/2026-09-26-beaksight-post-task-19-defects-design.md` の 3.2、7章
- 実装計画: `doc/design/2026-09-26-beaksight-post-task-19-defects-implementation-plan.md` の「DEF-019」

作業を始める前に、上の設計書と実装計画の該当箇所を必ず読んでください。設計書 3.2 に、設計者が実験で測った値があります。

# 変更してよいファイル

- `fixtures/site/layout-single-line-headings.html`
- `tests/integration/layout-accessibility.test.ts`（「compares the overshoot above and below a single line separately」の前提のコメントだけ。assert は変えない）

これ以外のファイルを変更する必要があると分かった場合は、変更せずに止まり、Blocker として報告してください。フォントのファイルを加えることは禁止です（設計書 3.2 の「採用しなかった案」）。

# 使うべき共通部品

| 名前 | 置き場所 | 用途 |
| --- | --- | --- |
| `LAYOUT_THRESHOLDS.clippedTextLineMinOutsideRatio` | `src/evidence/layout-collector.ts` | テストは引き続きこれを参照する（数値を書き写さない） |

新しい共通部品は作りません。

# 手順

1. RED: `npx vitest run tests/integration/layout-accessibility.test.ts -t "compares the overshoot above and below"` を実行し、前提の確かめ（`#heading-line-height-10` の上下の合計が行の高さの4分の1を超えない）で失敗することを見る。
2. 最小実装: fixture に次の `@font-face` を加え、`.single-line-heading` の `font-family` を、その family 名を先頭にしたもの（最後に `sans-serif`）に変える。
   - family 名は fixture 専用のもの（例: `BeakSight Fixture Heading`）。
   - `src: local("Meiryo"), local("Yu Gothic"), local("Noto Sans JP"), local("Segoe UI"), local("DejaVu Sans"), local("Liberation Sans"), local("Arial");`
   - `ascent-override: 106%; descent-override: 44%; line-gap-override: 0%;`
   - fixture の CSS のコメントに、寸法を固定する理由（行の矩形の高さを、環境のフォントによらずフォントの大きさの 1.5 倍にする。106% と 44% は、これまで前提にした Meiryo の寸法に合わせた値）を書く。
3. GREEN: 同じコマンド。
4. テストのコメント（641〜644 行付近）を、設計書 3.2 のとおりに書き換える（fixture の `@font-face` で縦の寸法を固定している。`local()` のどのフォントもない環境では前提が崩れ、ここで目に見える形で失敗する）。
5. 関連する検証: `npx vitest run tests/integration/layout-accessibility.test.ts`（ファイル全体。同じ fixture を使う「compares the overhang on the left and on the right of a line separately (I1)」を含む）。

# 受け入れ条件

- 変更の前に、対象のテストが前提の確かめで失敗する。変更の後に PASS する。
- `tests/integration/layout-accessibility.test.ts` の全件が PASS する。
- assert の条件は変わっていない（`git diff` で、テストファイルの変更がコメントだけであることを示す）。
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
