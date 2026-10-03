# T18d 指示書: Architecture の Gate（GATE-ARCH01〜08）

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。末尾の「一時ディレクトリの扱い」も守ってください。

## サブタスク

- ID: T18d
- 目的: Architecture の Gate（ARCH01〜08）を、名前付きの静的な検査として作る。
- 設計書: `doc/design/2026-09-25-beaksight-task-18-acceptance-gates-design.md`（とくに 4.1 と 4.4）
- 実装計画: `doc/design/2026-09-25-beaksight-task-18-acceptance-gates-implementation-plan.md` の T18d
- 上位の文書: `doc/design/2026-08-27-beaksight-implementation-tasks.md` の第5章（SSOT Owner Matrix）と第10章（Architecture Gates）
- 手本: `tests/architecture/ui-ssot.test.ts`（UI Gate。検出の関数と、その単体テストの形）
- スキルの参照: `.claude/skills/beaksight-dev/references/ui-ux-ssot.md` の第6章（検査の速さの要件）
- 共通部品台帳: `doc/design/beaksight-shared-components.md`

これまでの変更は、作業ツリーにそのまま残っています。HEAD に戻す操作は禁止です。

**このサブタスクは、T18a（`fixtures/` と `tests/integration/isolated-interaction.test.ts` の変更）と並行で実行します。**

- 下の「変更してよいファイル」の外は、変更しないでください。
- `npm run verify` と `npm run build` は、実行しないでください。全体の verify は、設計者が行います。
- 担当のテストと `npm run typecheck` は、実行してかまいません。

## 変更してよいファイル

- 新規: `tests/architecture/target-isolation.test.ts`（ARCH01）
- 新規: `tests/architecture/semantic-ownership.test.ts`（ARCH02〜08）
- 新規: `tests/architecture/` の中の共通の補助のファイル（必要な場合。例: ファイルの一覧と読み込みの補助）
  - `tests/architecture/ui-ssot.test.ts` のファイルの読み込みの処理を共通にしたい場合は、止まって報告してください。今回は、`ui-ssot.test.ts` を変えないでください。

`src/` は、変更しません。検査が、今のコードに違反を見つけた場合は、止まって報告してください。違反を直すかどうかは、設計者が決めます。

## 読み取りの許可

- ARCH01 の検査は、`config/targets/*.json` を読みます。**読むことは許可します。** これまでの指示書の「`config/targets/` を使わない」は、実サイトへのアクセスと、その設定での実行を禁止するものです。
- ただし、次のことは禁止です。
  - `config/targets/*.json` の中の URL にアクセスすること
  - その設定で、Run や CLI を実行すること
  - 設定の中身（ホスト名など）を、テストのファイルや報告に書き写すこと。テストは、実行時に読んで照らすだけにします。報告には、件数と、ホスト名の代わりの表記（例: 「設定のホスト名」）だけを書いてください。

## 作るもの

1. **テストの名前**
   - `GATE-ARCH01` 〜 `GATE-ARCH08` を、テストの名前の先頭にそのまま含める。
2. **各 Gate の検査**（設計書 4.4 の表）
   - ARCH01: `config/targets/*.json` から、次の文字列を取り出す。
     - `target.id`
     - 各 URL（開始の URL、許可 Origin など、設定の中の URL のすべて）のホスト名と origin
     - それらが、`src/**/*.ts` にないことを確かめる。
       - `target.id` は、文字列のリテラルの値として、そのまま一致するものだけを違反とする。
       - ホスト名と origin は、どこに現れても違反とする。コメントも含む。
     - `target.id` が、ファイルどうしで一意であることも確かめる。
   - ARCH02: `loadConfig` を呼ぶのが、`src/cli/**` だけである。定義の場所（`src/config/load-config.ts`）は除く。
   - ARCH03: anchor と href の抽出の owner が、`src/crawl/discover-links.ts` だけである。
     - Run Coordinator が、Page Auditor の `LinkEvidence` を再利用していることも確かめる。静的に確かめられる範囲でよい。例えば、Run Coordinator が Link の抽出の関数を import していないこと、link の Evidence を読んでいること、である。
     - `discover-candidates.ts` と `dom-collector.ts` の href の読み取りは、Evidence の取得であり、Link の抽出ではない。除外の一覧に、理由を付けて入れる。
   - ARCH04: URL の正規化と受け入れの判定の、別の実装がない。
     - 例: `normalizeUrl`・`classifyUrl` の owner の外で、URL の正規化にあたる処理（`new URL(...)` の結果の `hash` を消す、`origin` を組み立てる、など）を定義していないこと。
     - 検出の規則と除外の一覧は、実装者が決めて報告する。
       - 今のコードで、`new URL(` を使う所は、16ファイルほどある。
       - URL の妥当性の確認や、表示のための分解は、正規化ではない。
       - 近似でよい。誤検知は、理由を付けて除外する。
   - ARCH05: `deriveRunStatus(` を呼ぶのが、Run Coordinator と `ArtifactWriter` だけである。`RunStatus` の値を、ほかの場所で代入して決めていないことも、近似で確かめる。
   - ARCH06: `createFindingFingerprint(` を呼ぶのが、Rule Engine（`src/audit/rule-engine.ts`）だけである。`sha256` の fingerprint を、ほかで組み立てていないことも、近似で確かめる。
   - ARCH07:
     - Page Rule の登録先が、`RULE_CATALOG`（`src/audit/rule-catalog.ts`）の1か所だけである。
     - Rule Engine が、それだけを使う。
     - Cross-page の評価が、`evaluateCrossPageRules()` だけを通る。
     - `src/report/**` と `src/cli/**` が、Rule の評価の関数（`RuleEngine`、`evaluateCrossPageRules`、各 Rule の `evaluate` など）を import していない。
   - ARCH08:
     - `validateArtifact(` を呼ぶ所が、決まった一覧（PREFLIGHT、Run Coordinator、`ArtifactWriter`）の中だけである。
     - スキーマの検証（Ajv）を、ほかで直接使っていない。
     - 最終の書き出し（`writeFile` や `rename` で、run.json、audit.json、page.json、report.html、バンドルを書くこと）が、`src/report/artifact-writer.ts` だけにある。
     - スクリーンショットの PNG の書き込み（collector）は、Evidence の取得なので、理由を付けて除外する。
3. **検出の関数の単体テスト**
   - 各 Gate の検出の関数に、違反の例と、違反でない例を与え、正しく判定できることを確かめる。UI Gate と同じ形にする。
   - これが、検査が誤りを検出できることの RED の代わりになる。
4. **速さ**（`references/ui-ux-ssot.md` 第6章。2026-09-23 ユーザー指示）
   - `fs`、正規表現、文字列の検索だけで判定する。TypeScript のコンパイラ API、AST 解析、外部のツール、子プロセスは使わない。
   - `src/**` のファイルの一覧の取得と読み込みは、ファイルごとに1回だけにする。
   - 各テストのファイルが、1秒以内に終わること。所要時間を、報告に書く。
5. **除外の一覧**
   - 除外の一覧は、各 Gate のファイルの中に1か所だけ置く。各項目に、理由を書く。

## 受け入れ条件

- 検出の関数の単体テストが、違反の例を正しく検出する。
- 今のコードで、8つの Gate がすべて PASS する。PASS しない場合は、止まって報告する（`src/` は変えない）。
- 各テストのファイルが、1秒以内に終わる。
- `npm run typecheck` が PASS する。
- `npm run verify` は実行しない（並行作業のため）。

## 報告

共通ルールの形式で、日本語で報告してください。各 Gate の検出の規則と、除外の一覧（理由付き）を書いてください。R18 のレビューで使います。
