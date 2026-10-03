# T12f 指示書: Rule の補助処理の共通化（CC-013）と、Cross-page rule の整理

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## サブタスク

- ID: T12f
- 目的:
  - Rule のファイルごとに重複している補助処理を、1か所にまとめる（CC-013）。
  - T13b の報告を受けて、Cross-page rule を2点整理する。
- 設計書: `doc/design/2026-09-23-beaksight-task-12-13-rules-design.md` の次の箇所
  - 5.1.1 の「共通化」
  - 第7章の `INCONSISTENT_ORIGIN`
- UI追補設計書: `doc/design/2026-09-23-beaksight-ui-ssot-design.md` の次の箇所
  - 表示用の書式の owner は `src/presentation/format.ts`
  - 依存の向き: `src/presentation/**` が import してよいのは、`src/core/**` と `src/config/types.ts` だけ
  - GATE-UI06: 日本語の文字列リテラルを置いてよいのは、文言カタログと `src/audit/*-rules.ts` だけ
- 前の報告: 作業記録置き場の `T12c-report.md`、`T12d-report-2.md`、`T12e-report.md`、`T13b-report.md`
- 共通化候補の台帳: 作業記録置き場の `commonization-candidates.md` の CC-013

T12a〜T13b の変更は、作業ツリーにそのまま残っています。HEAD に戻す操作は禁止です。

このサブタスクは単独で実行します。

## 変更してよいファイル

- 新規: `src/audit/rule-helpers.ts`、`src/presentation/format.ts`、`tests/unit/rule-helpers.test.ts`、`tests/unit/presentation-format.test.ts`
- `src/audit/technical-rules.ts`、`layout-rules.ts`、`accessibility-rules.ts`、`performance-rules.ts`、`safety-rules.ts`、`cross-page-rules.ts`、`rule-engine.ts`
- 対応する `tests/component/*-rules.test.ts` と `tests/component/rule-engine.test.ts`。変更は、import の変更と、`INCONSISTENT_ORIGIN` の変更に伴うものに限る。

## 修正する内容

1. **`src/audit/rule-helpers.ts`**（日本語の文字列リテラルを置かない）
   - 次の2つの処理を、ここにまとめる。
     - 入力のビューポートの、ある種類の Evidence を取り出す処理。型付きで、`EvidenceRecordFor<T>` を返す。
     - 重複を除いてコード単位の順に並べる処理。
   - まとめる前の処理は、Rule のファイルごとに別々に書かれている。例は、`layoutsOf` の一部、`safetyRecords`、`distinctSorted`、`joinDistinct` など。
   - 意味の違う処理は、無理にまとめない。例えば、`layoutsOf` のうち `stressSweep` を展開する部分は、layout の Rule に残す。
   - 呼び出し元を、すべてこの関数に置き換える。同じ意味の処理を、Rule のファイルに残さない。
2. **`src/presentation/format.ts`**（Task 16 の owner を先に作る）
   - 文言の中の数値の書式（例: 小数を丸めた値、px、ms、割合）を関数にする。
   - いま Rule のファイルにある `formatNumber`（`layout-rules.ts`、`performance-rules.ts`）を、この関数に置き換える。
   - 置き換えで、既存の Finding の文言が変わらないようにする。丸め方が Rule ごとに違う場合は、関数の引数で表すか、意味ごとに別の関数にする。
   - このファイルが import してよいのは、`src/core/**` と `src/config/types.ts` だけ。
   - Task 16 で、日時やデータ量などの書式が、このファイルに加わる。
3. **`compareRuleEvaluationFailures` の export**
   - `rule-engine.ts` の `compareRuleEvaluationFailures` を export する。
   - `cross-page-rules.ts` で、その場で書いた比較を、この関数に置き換える。
4. **`INCONSISTENT_ORIGIN` を canonical だけにする**
   - 最終URLの Origin が許可Originの外である事実は、`UNEXPECTED_ORIGIN_REDIRECT` だけで扱う。
   - `INCONSISTENT_ORIGIN` は、canonical の Origin だけを判定する。
   - テストを、この仕様に合わせて直す。最終URLが許可Originの外のページで、`INCONSISTENT_ORIGIN` ができないことを確かめるテストを加える。修正前に RED、修正後に GREEN になること。

## 受け入れ条件

- `rule-helpers.ts` と `format.ts` の単体テストがある。
- `INCONSISTENT_ORIGIN` のテストは、修正前に RED、修正後に GREEN になる。
- 既存の Rule のテストは、すべて PASS する。Finding の文言、fingerprint、並び順は、`INCONSISTENT_ORIGIN` 以外で変わらない。
- `src/audit/*.ts` に、`formatNumber`、`distinctSorted`、`joinDistinct` と同じ意味の関数の定義が残っていない。`grep` で確かめ、結果を報告する。
- `npm run typecheck` が PASS する。
- `npm run verify` が PASS する。このサブタスクでは build を実行してよい。

## 報告

共通ルールの形式で、日本語で報告してください。新しく作った関数のシグネチャを一覧にしてください。
