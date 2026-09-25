# BeakSight Task 16・17 レポートと CLI 実装計画

作成日: 2026-09-24
状態: ユーザー承認済みの範囲内で、設計者が確定した（2026-09-23 のユーザーの開発指示に基づく）

- 設計書:
  - `doc/design/2026-09-23-beaksight-task-14-17-pipeline-report-cli-design.md` の第6章、6.1、第7章
  - `doc/design/2026-09-23-beaksight-ui-ssot-design.md`（UI追補設計書）
- 上位の計画: `doc/design/2026-08-27-beaksight-implementation-plan.md` の Task 16・17
- スキルの参照: `.claude/skills/beaksight-dev/references/ui-ux-ssot.md`

## 1. 目的

確定した Run（`AuditRunResult`）を、次の3つの表示面で示す。

- artifact（run.json、audit.json、page.json、visible-text.txt）
- 日本語の HTML レポート
- ChatGPT 用バンドル

CLI から、Run を実行できるようにする。

表示は、UI追補設計書の owner に分け、1つの表示用モデルから描く。

## 2. サブタスクの分け方と順序

| ID | 内容 | 主に作るファイル | 前提 |
| --- | --- | --- | --- |
| U16a | 表示の語彙と部品の土台 | `src/presentation/catalog.ts`、`messages.ts`（理由の説明）、`format.ts`（日時・データ量・未観測）、`src/report/html-tokens.ts`、`src/report/html-components.ts`、`tests/architecture/ui-ssot.test.ts`（UI02、UI03、UI05） | C15x |
| U16b | 表示用モデルと、artifact の書き出し | `src/report/view-model.ts`、`src/report/artifact-writer.ts`、`AuditRunResult.statusInput`（run-coordinator） | U16a |
| U16c | HTML レポート | `src/report/html-report.ts` | U16b |
| U16d | ChatGPT 用バンドル | `src/report/chatgpt-bundle.ts` | U16b |
| U17a | CLI | `src/cli/index.ts`、`src/cli/exit-codes.ts`、`messages.ts`（CLI と設定エラー）、`src/config/` の `ConfigError`、UI01 と UI06 の Gate | U16c、U16d |

- U16c と U16d は、変更するファイルが重ならない。そのため、並行で行ってよい。両方の指示書に、並行であることを書く。
- U16a の後に、UI Gate の UI04 を U16b で、UI01 を U16b〜U17a で、順に有効にする。
- Task 16 と Task 17 のそれぞれの後に、独立レビューを行う。チェックポイントは Task 18 だが、表示と安全（エスケープ、危険な URL）に関わるため、レビューを行う。

## 3. 各サブタスクの要点

### U16a 表示の語彙と部品の土台

- カタログ（`catalog.ts`）を作る。
  - 対象は、Severity、Run・Page Audit・Viewport・Interaction の各 Status、`FindingCategory`、Evidence の種類、ビューポート、`notVerifiableKind` である。
  - 持たせる属性は、日本語のラベル、表示の順、色のトークン名、説明、サイト品質か Safety かの区別である。
  - `as const` の配列と `satisfies Record<…>` を使い、書き漏れを型のエラーにする。
- 表示のカテゴリの対応（設計書 6.1.4）を、カタログに置く。
- 理由のコードの日本語の説明を、`messages.ts` に置く。`INCOMPLETE_REASON_CODES` のすべてについて書く。
- 書式（`format.ts`）に、次のものを加える。
  - 日時（`Asia/Tokyo`）
  - 時間
  - データ量
  - 「未観測」
- `html-tokens.ts` に、CSS のカスタムプロパティと、唯一のスタイルシートを置く。
- `html-components.ts` に、唯一のエスケープの関数と、部品を置く。
  - 部品は、バッジ、表、Finding の行、URL、Evidence の参照、スクリーンショットの参照、節の見出し、文書の骨組みである。
  - URL の部品は、設計書 6.1.6 のとおりにする。
- UI Gate の UI02、UI03、UI05 を作る。1秒以内に終わること。

### U16b 表示用モデルと、artifact の書き出し

- `AuditRunResult.statusInput` を加える（設計書 6.1.1）。Run Coordinator で入れる。
- 表示用モデルを作る（設計書 6.1.3）。
- `ArtifactWriter.writeRun` を作る（設計書 6.1.1、6.1.2）。
  - 書くのは、run.json、audit.json、page.json、visible-text.txt である。
  - スキーマに合わない場合は、Run Status を導き直す。
  - 一時ファイルと rename で書く。UTF-8 と LF にする。
- UI Gate の UI04 を有効にする。

### U16c HTML レポート

- `renderHtmlReport(viewModel): string` を作る。節と順は、設計書 6.1.4 のとおりにする。
  - 部品を組み合わせるだけにし、タグを直接書かない。
- 実装計画 Task 16 の Step 3 と Step 4 を満たすことを、テストで確かめる。
  - `href="mailto:`、`href="tel:` がない。
  - Evidence の値が、エスケープされる。
  - 件数、Run Status、ページの網羅がある。
  - アンカーが安全である。

### U16d ChatGPT 用バンドル

- `createChatGptBundle(viewModel, result, readArtifactFile): Promise<Uint8Array>` を作る（設計書 6.1.2、6.1.8、6.1.9）。ファイルは書かない。書くのは `ArtifactWriter.writePresentation` である。
- テストで、次のことを確かめる。
  - ZIP の中身とパスが、決定論的である。
  - 生のレスポンス本文を含まない。
  - `evidence-index.json` から、Evidence の場所をたどれる。

### U17a CLI

- 設計書 第7章と 6.1.5 を満たす。
  - `ConfigError`
  - 日本語の文言
  - 終了コードの表
  - `--headed` と `--headless` の排他
  - 出力先と件数の要約（表示用モデルから取る）
- 実装計画 Task 17 の Step 1〜3 を満たす。
- 既存の `tests/unit/cli.test.ts` の、英語の文言と終了コードを、新しい仕様に合わせて直す。
- Windows PowerShell で、日本語の出力が読めるかを確かめ、結果を報告する。
- UI Gate の UI01（CLI の分）と UI06 を有効にする。

## 4. 各サブタスクの共通の受け入れ条件

- TDD（RED → GREEN → 関連する検証）で進める。
- `npm run verify` が PASS する。並行作業の場合は、設計者が実行する。
- 共通部品台帳の部品を使い、同じ意味の処理を新しく書かない。
- UI Gate の各ファイルは、1秒以内に終わる。

## 5. 設計変更履歴

| 日付 | 契機 | 変更内容 | 影響範囲 |
| --- | --- | --- | --- |
| 2026-09-24 | 初版 | - | Task 16、17 |
| 2026-09-25 | U16b、C16a の報告 | C16a と C16b を加えた。`createChatGptBundle` の形を変えた（設計書 6.1.8、6.1.9） | U16c、U16d、U17a |

## 追補（2026-09-25）: C16a を U16b と U16c・U16d の間に入れる

U16b の報告を受けて、U16c・U16d の前に、整理のサブタスク C16a を行う（設計書 6.1.8）。

- 目的:
  - artifact の配置の owner を、`src/core/artifact-layout.ts` に移す。CC-023 と、report から orchestration への依存を解く。
  - `REQUIRED_ARTIFACT_INVALID` の detail の組み立てを、`src/core/status.ts` の1か所にする（CC-022）。
  - 「重大な指摘」を、`SEVERITY_CATALOG` の `criticalSection` で選ぶ。
  - `relatedFindingIds` の規則を広げる。
- 順序: U16b → **C16a** → U16c ∥ U16d → R16 → U17a
- U16c は、HTML を文字列で返す。U16d は、ZIP を `Uint8Array` で返す。どちらもファイルを書かない。

## 追補（2026-09-25）: C16b を C16a と U16c・U16d の間に入れる

- 目的: 表示のテストの Run の見本を、`tests/helpers/audit-run-fixture.ts` にまとめる（CC-024）。
  - U16c と U16d は、並行で進める。
  - そのため、それぞれが見本を複製しないように、先にまとめておく。
- 順序: U16b → C16a → **C16b** → U16c ∥ U16d → R16 → U17a

## 追補（2026-09-25）: C16c と C16d を、Task 16 のレビューの前に入れる

- C16c: CC-026（JSON の書式）と CC-027（パスの検証）を直す。U16c と並行で行った。
- C16d: 次の3つを直す（設計書 6.1.10）。
  - Safety の事象の一覧
  - Interaction の Evidence の場所
  - 整数の書式
  - ID の形の検証（C16c で緩くなったものを、`isRunId` と `isPageId` で戻す）
- 順序: U16c ∥ U16d ∥ C16c → **C16d** → **C16e** → R16 → U17a
- C16e: 事象の種類の値の一覧を、core（`SAFETY_EVENT_KINDS`）に移す。UI05 に、新しいカタログと `formatInteger` を加える。HTML の事象の表に、「候補」の列を加える（設計書 6.1.10）。

## 追補（2026-09-25）: R16 の後の修正

- R16 の指摘1・2・3・5・6 を、R16f で直す（設計書 6.1.11）。
- 指摘4は、DEF-009 として、Task 18 の前の整理で直す。
- R16f の確認は、Task 17 の独立レビュー（R17）で一緒に行う。
- 順序: R16 → **R16f** → U17a → R17

## 追補（2026-09-25）: U17a の後の整理

- C17a で、次のものを行う。
  - `--help`
  - 要約の文言の共通の名前
  - severity の絞り込みの補助の関数
  - 一時ビルドの `package.json`
  - CC-016
- その後、Task 17 の独立レビュー R17 を行う。R17 では、R16f の修正の確認も一緒に行う。
- 順序: U17a → **C17a** → R17 → Task 18 の前の整理
