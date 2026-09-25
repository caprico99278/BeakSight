# C18k 指示書: CC-029 の後に残った、テストの補助の重複（CC-031）

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。末尾の「一時ディレクトリの扱い」も守ってください。

## サブタスク

- ID: C18k
- 目的: C18d の後に残った、テストの補助の重複（CC-031）をなくす。
- 共通化候補: 作業記録置き場の `commonization-candidates.md` の CC-031（対象の一覧がある）
- 前の報告: 作業記録置き場の `C18d-report.md`
- 共通部品台帳: `doc/design/beaksight-shared-components.md`（テスト補助の行。`run-harness.ts`、`browser-proxies.ts`、`external-scheme-fixture.ts`、`chromium.ts`、`gate-harness.ts`）

これまでの変更は、作業ツリーにそのまま残っています。HEAD に戻す操作は禁止です。

**このサブタスクは、C18e（`src/interaction/discover-candidates.ts` と、そのテスト）と並行で実行します。**

- 下の「変更してよいファイル」の外は、変更しないでください。
- `npm run verify` と `npm run build` は、実行しないでください。全体の verify は、設計者が行います。
- 担当のテストと `npm run typecheck` は、実行してかまいません。
  - ほかの実装者の作業中のファイルから、型のエラーやテストの失敗が出た場合は、自分のファイルのものでないことを確かめて、報告に書いてください。

## 変更してよいファイル

- `tests/helpers/`（補助を加える、まとめることに限る。既存の補助の振る舞いは変えない）
- `tests/unit/cli.test.ts`
- `tests/integration/report-generation.test.ts`
- `tests/integration/environment.test.ts`
- `tests/component/discover-links.test.ts`
- `tests/integration/safety-gates.test.ts`、`tests/integration/external-scheme-navigation.test.ts`、`tests/integration/oopif-guard.test.ts`、`tests/integration/gate-fixtures.test.ts`
  - `QUIET_PERIOD_MS`、headless と headed の注入の組み合わせ、Guard の付いた Passive の page を開いて閉じる処理の共通化に限る。
- `fixtures/server.ts`
  - コメントの直しに限る。
  - 外部スキームの宛先の値を1か所にする場合は、`tests/helpers/external-scheme-fixture.ts` と同じ値を使う形にしてよい。ただし、fixture の経路の振る舞いは変えない。
- `fixtures/site/` の、外部スキームの宛先の値を持つ HTML（値の出どころを1か所にする場合に限る。振る舞いは変えない）

`src/` と、`tests/integration/isolated-interaction.test.ts` は、変更しません（C18e が触れる可能性があるため）。

## 作るもの

1. CC-031 に挙げた重複を、`tests/helpers/` の補助を使う形にする。
   - とくに、`report-generation.test.ts` の launcher は、要求された `headless` の値をそのまま Chromium に渡している。これを、いつも headless で起動する `createRunLauncher`（または同じ扱いの補助）に置き換える。安全の面から、これは必ず行う。
   - `QUIET_PERIOD_MS`、headless と headed の注入の組み合わせ（`MODES`、`FACTORY_MODES`）、Guard の付いた Passive の page を開いて閉じる処理は、`tests/helpers/` の1か所にまとめる。題名の書き方もそろえる。
2. `fixtures/server.ts:76` のコメントを、今の置き場所（`tests/helpers/external-scheme-fixture.ts`）を指す形に直す。
   - 宛先の値の複製（`fixtures/server.ts:79`、fixture の HTML）を1か所にできるかを確かめる。
   - できる場合は、1か所にする。ブラウザの中の HTML と Node のサーバで値を共有できない場合は、その理由を報告し、複製が同じ値であることを確かめるテストを置く。
3. テストのケースと期待値は、変えない。置き換えの前後で、各ファイルの PASS の件数が同じであること。前後の件数を、表にして報告する。

## 厳守事項（このサブタスクに固有のもの）

- **Chromium は headless だけで起動する。** headed（`headless: false`）で起動してはいけない。
- 外部スキームの URL には、実在する宛先を使わない。

## 受け入れ条件

- 置き換えの前後で、各ファイルの PASS の件数が同じである。
- テストのケースと期待値を、削除したり弱めたりしていない。
- `npm run typecheck` が PASS する。
- `npm run verify` は実行しない（並行作業のため）。

## 報告

共通ルールの形式で、日本語で報告してください。
