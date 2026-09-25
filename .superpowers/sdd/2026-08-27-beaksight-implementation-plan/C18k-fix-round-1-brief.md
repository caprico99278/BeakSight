# C18k 修正の回 1 の指示書: 外部スキームの宛先の値の置き場所と、残った定数

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。末尾の「一時ディレクトリの扱い」も守ってください。

## サブタスク

- ID: C18k-fix-round-1
- 前のサブタスクの報告: 作業記録置き場の `C18k-report.md`
- 共通化候補: 作業記録置き場の `commonization-candidates.md` の CC-031
- 共通部品台帳: `doc/design/beaksight-shared-components.md`

これまでの変更は、作業ツリーにそのまま残っています。HEAD に戻す操作は禁止です。

**このサブタスクは、C18e（`src/interaction/discover-candidates.ts`、`tests/integration/isolated-interaction.test.ts`、discover-candidates のテスト）と並行で実行します。**

- 下の「変えてよいファイル」の外は、変更しないでください。
- `npm run verify` と `npm run build` は、実行しないでください。全体の verify は、設計者が行います。
- 担当のテストと `npm run typecheck` は、実行してかまいません。ほかの実装者の作業中のファイルから出たエラーは、そのことを確かめて報告に書いてください。

## 設計者の判断（C18k の報告への回答）

1. **依存の向きを逆にする。** いまは、`fixtures/server.ts` が `tests/helpers/external-scheme-fixture.ts` を import しています。`fixtures/` はテストの補助より下の層です（テストの補助は `fixtures/server.ts` を import しています）。そのため、宛先の値は `fixtures/` の側に置き、テストの補助がそれを使う形にします。
2. 題名の表記 `headed (injected)` は、このままでよい。
3. `oopif-guard` の Mock の戻し方（`afterEach`）は、このままでよい。
4. 共通部品台帳は、設計者が更新する。

## 作業

### 1. 宛先の値を `fixtures/` に移す

- 新しいファイル `fixtures/external-scheme-targets.ts` を作り、`EXTERNAL_SCHEME_TARGETS`、`ExternalSchemeKey`、`EXTERNAL_SCHEME_KEYS` をそこに移す。
  - このファイルは、ほかのファイルを import しない（値だけを持つ）。
  - 先頭のコメントに、値の意味（すべて実在しない宛先であること）、HTML の複製があること、一致を確かめるテストの場所を書く。
- `fixtures/server.ts` は、`./external-scheme-targets.js` から import する。`tests/helpers/` を import しない。
- `tests/helpers/external-scheme-fixture.ts` は、3つの名前を `fixtures/external-scheme-targets.ts` から import し、そのまま export し直す（既存のテストの import を変えないため）。値の定義を、補助の側に残さない。
- `tests/unit/external-scheme-fixture.test.ts` の import とコメントを、必要に応じて直す。
- 値、名前、順序は変えない。

### 2. `slow-redirect` の定数

- `tests/integration/slow-redirect.test.ts:26` の `QUIET_PERIOD_MS = 300` を、`tests/helpers/gate-harness.ts` の `QUIET_PERIOD_MS` の import に置き換える。
- このファイルの、ほかの部分は変えない（Guard の付いた page の処理は、別のサブタスク C18m で扱う）。

## 変えてよいファイル

- `fixtures/external-scheme-targets.ts`（新規）
- `fixtures/server.ts`
- `tests/helpers/external-scheme-fixture.ts`
- `tests/unit/external-scheme-fixture.test.ts`
- `tests/integration/slow-redirect.test.ts`（上の2の1か所だけ）

## 受け入れ条件

- `fixtures/` の中のファイルが、`tests/` を import していない（grep の結果を報告する）。
- 宛先の値の定義が、`fixtures/external-scheme-targets.ts` の1か所だけにある（HTML の複製を除く）。
- 次のテストが、変更の前と後で同じ件数で PASS する（前と後の件数を報告する）:
  - `tests/unit/external-scheme-fixture.test.ts`
  - `tests/integration/fixture-server.test.ts`
  - `tests/integration/slow-redirect.test.ts`
  - `tests/integration/external-scheme-navigation.test.ts`
- `npm run typecheck` が PASS する。
- 既存のテストのケースと期待値を、変えない。弱めない。

## 厳守事項（このサブタスクに固有のもの）

- **Chromium は headless だけで起動する。** headed（`headless: false`）で起動してはいけない。
- 外部スキームの宛先は、実在しない値だけを使う（`tel:+10000000000`、`mailto:nobody@example.invalid`、`beaksight-test-app:probe`）。値を変えない。
- 本来の監査対象のサイトを含む、実在の外部のサイトにアクセスしない。
- `git commit`、`git push`、HEAD に戻す操作は禁止。
- 依存パッケージを追加・更新しない。

## 報告

共通ルールの形式で、日本語で報告してください。変更したファイル、前と後の件数、grep の結果を入れてください。
