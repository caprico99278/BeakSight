# C18m 指示書: Guard の付いた Passive の page を開いて閉じる処理の、残りの複製（CC-032）

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。末尾の「一時ディレクトリの扱い」も守ってください。

## サブタスク

- ID: C18m
- 目的: テストのファイルごとに書かれている「Guard の付いた Passive の page を開く → 1つの処理 → 閉じる」の形を、`tests/helpers/gate-harness.ts` の `withGuardedPassivePage` に寄せる。
- 共通化候補: 作業記録置き場の `commonization-candidates.md` の CC-032
- 実装計画: `doc/design/2026-09-25-beaksight-pre-task-19-cleanup-implementation-plan.md` の C18m
- 前のサブタスクの報告: `C18k-report.md`（`withGuardedPassivePage` を作ったときのもの）
- 共通部品台帳: `doc/design/beaksight-shared-components.md`（`gate-harness.ts` の行）

これまでの変更は、作業ツリーにそのまま残っています。HEAD に戻す操作は禁止です。

**このサブタスクは、C18o（`src/presentation/messages.ts`、`src/report/view-model.ts`、`src/report/html-report.ts`、`tests/unit/` と `tests/component/` の表示のテスト（`view-model`、`html-report`、`chatgpt-bundle`、`messages`、`catalog`））と並行で実行します。**

- 下の「変えてよいファイル」の外は、変更しないでください。
- `npm run verify` と `npm run build` は、実行しないでください。全体の verify は、設計者が行います。
- 担当のテストと `npm run typecheck` は、実行してかまいません。ほかの実装者の作業中のファイルから出たエラーは、そのことを確かめて報告に書いてください。

## 作業

1. 対象の候補のファイルを読み、`createPassiveContext` と `closePassiveResources`（または同じ役割の閉じ方）の組を洗い出す。
   - 候補: `slow-redirect`、`isolated-interaction`、`page-auditor`、`page-auditor-interaction`、`layout-accessibility`、`layout-evidence-scale`、`accessibility-evidence`、`accessibility-guard-safety`、`controlled-scroll`、`page-navigation`、`performance-evidence`、`screenshot-collector`、`site-metadata`、`stress-session`、`technical-evidence` の各テスト（`tests/integration/`）
2. 「開く → 1つの処理 → 閉じる」の形と同じものだけを、`withGuardedPassivePage` に置き換える。
   - 次のようなテストは、置き換えずに一覧にして報告する。
     - 途中で Context や page の状態を変える（閉じる、差し替える、Mock を入れるなど）
     - 閉じる処理そのものの結果や順序を確かめる
     - 1つのテストで複数の page を並べて使う、または Context を複数の page で共有する
     - `withGuardedPassivePage` の引数（`prepare` など）で表せない準備がある
   - `withGuardedPassivePage` の形を変える必要があると考えた場合は、変えずに止まり、案を報告する（C18k と C18o 以外の多くのテストが使っているため）。
3. 置き換えの前と後で、各ファイルの PASS の件数とテストの名前が同じであることを確かめる。

## 対象の外（変えない）

- `tests/unit/passive-session-open.test.ts`、`tests/integration/passive-session-close.test.ts`、`tests/component/context-factory.test.ts`、`tests/unit/run-coordinator.test.ts`、`tests/unit/schema-validator.test.ts`、`tests/integration/preflight.test.ts`。開く処理と閉じる処理そのもの、または別の組み立てを試すためである。

## 変えてよいファイル

- 上の「作業」の1の候補の15ファイル（`tests/integration/`）
- `tests/helpers/passive-cleanup.ts` は、読むだけにする。

## 受け入れ条件

- 置き換えた箇所の数と、置き換えなかった箇所の一覧（理由つき）を報告する。
- 各ファイルの PASS の件数とテストの名前が、置き換えの前と後で同じである（前と後の件数を表にする）。
- テストのケースと期待値を、消していない。弱めていない。
- `npm run typecheck` が PASS する。

## 厳守事項

- **Chromium は headless だけで起動する。** headed（`headless: false`）で起動してはいけない。
- 外部スキームの宛先は、実在しない値だけを使う（`tel:+10000000000`、`mailto:nobody@example.invalid`、`beaksight-test-app:probe`）。
- 本来の監査対象のサイトを含む、実在の外部のサイトにアクセスしない。`config/targets/` と `local/` の実サイトの設定を使わない。
- `git commit`、`git push`、HEAD に戻す操作は禁止。
- 依存パッケージを追加・更新しない。
- Blocker に当たったら、回避策を自分で考えずに止まり、報告する。

## 報告

共通ルールの形式で、日本語で報告してください。
