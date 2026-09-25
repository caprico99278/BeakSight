# U16a 指示書: 表示の語彙と部品の土台（カタログ、文言、書式、HTML の部品、UI Gate の一部）

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。末尾の「一時ディレクトリの扱い」も守ってください。

## サブタスク

- ID: U16a
- 目的: Task 16 の表示の owner のうち、語彙と部品の土台を作る。
- 設計書:
  - `doc/design/2026-09-23-beaksight-ui-ssot-design.md`（UI追補設計書。とくに、第3章、第4章、第6章）
  - `doc/design/2026-09-23-beaksight-task-14-17-pipeline-report-cli-design.md` の第6章と 6.1（とくに 6.1.4〜6.1.7）
- 実装計画: `doc/design/2026-09-24-beaksight-task-16-17-implementation-plan.md` の U16a
- スキルの参照: `.claude/skills/beaksight-dev/references/ui-ux-ssot.md`
- 共通部品台帳: `doc/design/beaksight-shared-components.md`

これまでの変更は、作業ツリーにそのまま残っています。HEAD に戻す操作は禁止です。

同時に、別のレビュー担当が、Task 15 のファイルを読み取り専用で確かめています。既存のファイルの変更は、下の「変更してよいファイル」に限ってください。

## 変更してよいファイル

- 新規:
  - `src/presentation/catalog.ts`、`src/presentation/messages.ts`
  - `src/report/html-tokens.ts`、`src/report/html-components.ts`
  - `tests/architecture/ui-ssot.test.ts`
  - 対応する単体テスト（`tests/unit/presentation-*.test.ts`、`tests/unit/report-*.test.ts` など）
- `src/presentation/format.ts`（書式を加えることに限る。既存の関数の振る舞いは、変えない）
- `tests/unit/presentation-format.test.ts`

## 作るもの

1. **カタログ（`catalog.ts`）**（UI追補設計書 4.2、スキルの参照の第2章）
   - 対象の値:
     - `SEVERITIES`
     - `RUN_STATUSES`
     - `PAGE_AUDIT_STATUSES`
     - `INTERACTION_STATUSES`
     - `INTERACTION_NOT_VERIFIABLE_KINDS`
     - `FINDING_CATEGORIES`
     - `EVIDENCE_TYPES`
     - `VIEWPORT_PROFILES`
   - 各値に持たせる属性:
     - 日本語のラベル
     - 表示の順
     - 色のトークンの名前
     - 説明（必要なもの）
   - Severity には、サイト品質か Safety かの区別を持たせる。
   - `as const` の配列の値のすべてについて、`satisfies Record<…>` で書き漏れを型のエラーにする。
   - カタログは、値の意味を決めない。ラベル、順、色、説明だけを持つ。
   - 表示のカテゴリの対応（設計書 6.1.4）も、カタログに置く。
     - 例: HTTP と RESOURCE は「ネットワーク」、LINK は「リンク」
     - 節の順も、カタログに置く。
2. **文言（`messages.ts`）**（設計書 6.1.5）
   - `INCOMPLETE_REASON_CODES` のすべてについて、日本語の説明を書く。書き漏れは、型のエラーにする。
   - CLI と設定のエラーの文言は、Task 17 で加える。ここでは作らない。
3. **書式（`format.ts`）**（UI追補設計書 4.1、スキルの参照の第4章）
   - 次の書式を加える。
     - 日時（`Asia/Tokyo`。例: `2026-09-24 15:30:00 JST`）
     - 時間（ms と秒）
     - データ量（B、KB、MB）
     - 件数
     - 「未観測」
   - 観測できなかった値（null、`NOT_OBSERVED` など）を、0 や空文字にしない。
   - 既存の4つの関数の振る舞いは、変えない。
4. **トークン（`html-tokens.ts`）**
   - CSS のカスタムプロパティと、唯一のスタイルシートを置く。
   - 色の値は、このファイルにだけ置く。
   - 色は、ライトとダークの両方と、コントラストを考える。
5. **HTML の部品（`html-components.ts`）**（UI追補設計書 4.2、スキルの参照の第3章、設計書 6.1.6）
   - 唯一のエスケープの関数を置く。対象の文字は、`&`、`<`、`>`、`"`、`'` である。
   - 部品は、どれも受け取った文字列を、必ずエスケープしてから使う。
     - 例外は、ほかの部品が作った HTML を受け取る場合だけである。この場合は、ブランド型などで区別する。
   - 部品の一覧:
     - Severity と状態のバッジ（色だけに頼らず、ラベルの文字も示す）
     - 表（見出しのセルを持つ）
     - Finding の行
     - URL（設計書 6.1.6）
       - `classifyUrl` の結果で、リンクにするかどうかを決める。
       - 外部へのリンクには、`rel="noopener noreferrer"` を付ける。
       - `mailto:`、`tel:`、不正な URL は、リンクにしない。
     - Evidence の参照
     - スクリーンショットの参照
     - 節の見出しとアンカー（アンカーは、安全な文字だけにする）
     - 文書の骨組み（`<html lang="ja">`、唯一のスタイルシート）
   - `style=""` の属性は、使わない。
   - 各部品の単体テストを書く。確かめること:
     - 危険な文字列（`<script>`、`"onerror=`、`javascript:` など）がエスケープされる。
     - `href="mailto:` と `href="tel:` が出ない。
6. **UI Gate の一部**（`tests/architecture/ui-ssot.test.ts`。UI追補設計書 6.1・6.2、設計書 6.1.7）
   - この時点で、次の3つを有効にする。
     - UI02: 色の値を、トークンのファイル以外に書かない。除外は、`src/evidence/color-collector.ts` と `src/report/html-tokens.ts` である。16進数の検出の形は、設計書 6.1.7 のとおりにする。
     - UI03: HTML のタグを含む文字列を、部品のファイル以外に書かない。対象は、`src/report/**` である。
     - UI05: カタログに、すべての値がある。「未観測」を、0 や空文字にしない（実行時の検査）。
   - UI01、UI04、UI06 は、後のサブタスクで有効にする。
     - ここでは、`it.todo` などで、未実装であることが分かる形にしておく。
     - 検査の対象が、まだないためである。
   - ファイルの一覧の取得と読み込みは、1回だけにする。
   - 判定は、`fs` と正規表現と文字列の検索だけで行う。
   - ファイルの全体が、1秒以内に終わること。所要時間を、報告に書く。

## 受け入れ条件

- 各項目で、修正前に RED、修正後に GREEN になる。
- UI Gate のファイルが、1秒以内に終わる。
- 既存のテストは、すべて PASS する。
- `npm run typecheck` と、担当のテストが PASS する。
- `npm run verify` は実行しない（レビュー担当が並行して作業しているため）。全体の verify は、設計者が行う。

## 報告

共通ルールの形式で、日本語で報告してください。U16b〜U17a の実装者が使うので、作った型と関数のシグネチャを一覧にしてください。
