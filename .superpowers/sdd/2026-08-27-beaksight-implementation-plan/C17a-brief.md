# C17a 指示書: Task 17 の後の整理（`--help`、要約の文言、severity の絞り込み、一時ビルド、CC-016）

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。末尾の「一時ディレクトリの扱い」も守ってください。

## サブタスク

- ID: C17a
- 目的: U17a の報告を受けた整理と、CC-016 を行う。
- 設計書:
  - `doc/design/2026-09-23-beaksight-task-14-17-pipeline-report-cli-design.md` の第7章（`--help` を加えた）
  - UI追補設計書 `doc/design/2026-09-23-beaksight-ui-ssot-design.md`
- 前の報告: 作業記録置き場の `U17a-report.md`（とくに判断3・4と、発見事項1・3）
- 共通化候補: 作業記録置き場の `commonization-candidates.md` の CC-016
- 共通部品台帳: `doc/design/beaksight-shared-components.md`

これまでの変更は、作業ツリーにそのまま残っています。HEAD に戻す操作は禁止です。

このサブタスクは単独で実行します。

## 変更してよいファイル

- `src/cli/arguments.ts`、`src/cli/main.ts`、`src/cli/output.ts`（`--help`、要約の文言、severity の絞り込みに限る）
- `src/presentation/messages.ts`、`src/presentation/catalog.ts`
- `src/report/view-model.ts`、`src/report/html-report.ts`（要約の文言の名前と、severity の絞り込みに限る）
- `src/audit/technical-rules.ts`、`src/audit/safety-rules.ts`、`src/audit/cross-page-rules.ts`（CC-016 に限る）
- `tests/helpers/temporary-build.ts`
- テスト（対応するものに限る）:
  - `tests/unit/cli.test.ts`、`tests/integration/cli.test.ts`
  - `tests/unit/presentation-*.test.ts`
  - `tests/unit/view-model.test.ts`、`tests/unit/html-report.test.ts`
  - Rule の各テスト（文言の期待値が変わる場合に限る）

## 直すもの

1. **`--help`**
   - `beaksight --help`、`beaksight run --help`、`beaksight validate-config --help` を受け付ける。
   - どれも、使い方（日本語。`messages.ts`）を標準出力に示し、終了コード 0 で終える。
   - Run は実行せず、設定も読まない。
   - 使い方の文言は、既存の使い方（引数の誤りのときに示すもの）と同じものを使う。2つ持たない。
2. **要約の文言の名前**
   - `HTML_REPORT_TEXT.summary` のうち、HTML と CLI の両方で使う要約の文言を、共通の名前（例: `RUN_SUMMARY_TEXT`）に移す。
   - HTML と CLI は、どちらもそこから取る。
   - 表示される文字は、変えない。
3. **severity の絞り込み**
   - カタログに、`severitiesInGroup(group)` のような補助の関数を置く。
     - 返す並びは、表示の順にする。
   - `view-model.ts` と `cli/output.ts` の `SEVERITIES.filter(…group…)` を、それに置き換える。
   - UI04 の Gate に、誤検知が出ないことを確かめる。
4. **一時ビルドの `package.json`**
   - `tests/helpers/temporary-build.ts` の一時ビルドの根に、`package.json` を写す。これで、`readToolVersion` が本番と同じ位置の `package.json` を読める。
   - 統合テスト（`tests/integration/cli.test.ts`）の中で写していた処理は、消す。
5. **CC-016 文言の中の一覧の書式**
   - `messages.ts` に、一覧の文言の関数を1つ置く（例: `listText(items)`）。
     - U17a の `cliListText` は、この関数に置き換える。
     - 名前は、Rule と CLI で共通に使える名前にする。
   - 一覧の一部だけを示し、残りの件数を添える書式（`cross-page-rules.ts` の `formatList`）も、`messages.ts` に移す。
   - Rule のファイルの `.join('、')` と、`formatStatuses` の区切りは、これらの関数を使う形にする。
   - Finding の文言として出る文字列は、変えない。Rule のテストの期待値が、そのまま PASS すること。
     - 変わる場合は、止まって報告してください。
   - `、` の区切りを、`messages.ts` の外に書かない。
     - これを確かめるテストを、どこに置くかは、実装者が決めて報告する。例えば、UI Gate のファイルに、`join('、')` を探す検査を加える方法がある。
     - 加える場合は、1秒以内に収める。

## 受け入れ条件

- 新しいテストが、修正前に RED、修正後に GREEN になる。
  - 名前の移動のように RED を作れないものは、代わりの確かめ方を報告に書く。
- 既存のテストのケースと期待値を、弱めない。表示される文字は、変わらない。
- UI Gate のファイルが、1秒以内に終わる。
- `npm run typecheck` が PASS する。
- `npm run verify` が PASS する。

## 報告

共通ルールの形式で、日本語で報告してください。
