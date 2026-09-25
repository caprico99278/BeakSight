# BeakSight 基盤修正と共通化 実装計画

設計書: `doc/design/2026-09-23-beaksight-foundation-corrections-design.md`
目標: Task 1〜11 のレビュー指摘を修正し、共通化候補を実施して、Task 12 に進める土台を作る。
作業記録置き場: `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/`

## 全体の制約

- Gitの commit・push は禁止。HEADに戻す操作（checkout、restore、reset、stash、switch、clean、worktree、merge、rebase、pull など）も禁止。表示だけの `git status`・`git diff`・`git log`・`git blame`・`git show` は使ってよい。
- 依存パッケージを追加・更新しない。
- 実サイトにアクセスしない（とくに、本来の監査対象のサイト）。`local/` を使わない。検証はローカルfixtureで行う。
- `src/**` は target-agnostic に保つ。
- 各サブタスクは、RED → 最小実装 → GREEN → 関連する検証、の順で進める。
- 各サブタスクは、「変更してよいファイル」以外を変更しない。必要になったら止まって報告する。
- 同じファイルを変更するサブタスクは、同時に実行しない。

## サブタスク一覧と実行順

| 順 | ID | 内容 | 設計書 | 変更してよい production ファイル | 並列 |
| --- | --- | --- | --- | --- | --- |
| 1 | F01 | 共通部品の新設 | 3章 | `src/core/deadline.ts`、`errors.ts`、`guards.ts`、`immutable.ts`、`text.ts`、`limits.ts`（新規）、`src/core/ids.ts`、`src/core/contracts.ts`（部分失敗の理由と観測状態の型の追加だけ）、`src/crawl/normalize-url.ts`（`isHttpProtocol`、`canonicalizeAllowedOrigins` の追加だけ）、`src/evidence/visibility.ts`（新規） | 単独 |
| 2 | F02a | 共通部品への移行（browser・evidence） | 3章 | `src/browser/page-settling.ts`、`controlled-scroll.ts`、`src/evidence/performance-collector.ts`、`network-collector.ts`、`console-collector.ts`、`color-collector.ts`、`layout-collector.ts`、`accessibility-collector.ts`、`dom-collector.ts`、`screenshot-collector.ts`、`interaction-collector.ts` | F02b・F02c と並列 |
| 2 | F02b | 共通部品への移行（safety・interaction） | 3章 | `src/safety/passive-request-guard.ts`、`safety-ledger.ts`、`interaction-policy.ts`、`src/interaction/isolated-auditor.ts`、`discover-candidates.ts`、`src/browser/context-factory.ts` | F02a・F02c と並列 |
| 2 | F02c | 共通部品への移行（config・core・crawl） | 3章 | `src/config/load-config.ts`、`validate-config.ts`、`src/core/status.ts`、`src/crawl/admission-policy.ts`、`crawl-queue.ts`、`discover-links.ts`、`src/safety/request-policy.ts`、`src/safety/redact.ts` | F02a・F02b と並列 |
| 3 | F03 | テスト補助の共通化 | 3章 CC-011 | なし（`tests/helpers/` の新設と、`tests/**` の準備処理の置き換え） | 単独 |
| 4 | C1 | Task 1〜4 の修正 | 6.1、6.2、6.4、6.6、6.7、6.8 | `src/config/*`、`src/crawl/discover-links.ts`、`normalize-url.ts`、`fixtures/server.ts` | C2・C4・C7 と並列 |
| 4 | C2 | 安全まわりの修正 | 4.1、4.7、6.3、6.5 | `src/safety/safety-ledger.ts`、`passive-request-guard.ts`、`src/core/status.ts`、`src/browser/context-factory.ts` | C1・C4・C7 と並列 |
| 4 | C4 | スクロールと収集位置 | 5.1、5.2 | `src/browser/controlled-scroll.ts`、`src/evidence/layout-collector.ts`、`color-collector.ts`、`screenshot-collector.ts` | C1・C2・C7 と並列 |
| 4 | C7 | performance・network・console・axe | 5.7、5.8（この4つ）、5.9 | `src/evidence/performance-collector.ts`、`network-collector.ts`、`console-collector.ts`、`accessibility-collector.ts` | C1・C2・C4 と並列 |
| 5 | C3 | Task 11 の修正 | 4.2〜4.6、4.8、5.5（discover-candidates の分） | `src/interaction/isolated-auditor.ts`、`discover-candidates.ts`、`src/evidence/interaction-collector.ts`、`src/safety/safety-ledger.ts`（4.6 の記録の種類の追加だけ）、`src/safety/interaction-policy.ts` | C5 と並列 |
| 5 | C5 | 可視判定と DOM の Evidence | 5.3、5.4（DOM の分）、5.5（dom・color・layout の分）、5.8（dom・color の分）、5.9 V14 | `src/evidence/dom-collector.ts`、`color-collector.ts`、`layout-collector.ts`（可視判定の置き換えだけ） | C3 と並列 |
| 5 | C4b | 内側のスクロール領域の検出（C4 の発見事項6） | 5.1 | `src/browser/controlled-scroll.ts` | C3・C5 と並列 |
| 6 | C6 | layout の Evidence と性能 | 5.4（layout の分）、5.6、5.8（layout の分） | `src/evidence/layout-collector.ts` | C5b と並列 |
| 6 | C5b | DOM の可視テキストの修正（C5 の発見事項） | 5.3、5.5 | `src/evidence/dom-collector.ts` | C6 と並列 |
| 7 | C8 | 型とスキーマの整備 | 7章 | `src/core/contracts.ts`、`src/core/evidence-types.ts`（新規）、`schemas/*.json`、`src/core/schema-validator.ts`、各 collector の型の import の置き換え | 単独 |
| 7 | F04 | 小さな整理（C1 の発見事項） | 3章 | `src/crawl/admission-policy.ts`、`src/safety/redact.ts`、`src/crawl/normalize-url.ts`、伏せ字の定数の置き場所 | C8 と並列（ファイルが重ならない範囲で） |
| 7.5 | DEF-001 | axe の実行で Passive Context が閉じられる不具合の修正 | 8.1 | `src/evidence/accessibility-collector.ts` | F05 と並列 |
| 7.5 | F05 | 型の定義元を1か所にする、Run Status の入力の構造化（C8 の発見事項） | 3章、7章 | `src/core/evidence-types.ts`、`contracts.ts`、`status.ts`、`src/crawl/normalize-url.ts`、`admission-policy.ts`、`src/safety/interaction-policy.ts`、`src/config/types.ts` | DEF-001 と並列 |
| 8 | R | 独立レビュー（R1〜R4。結果は作業記録置き場の `R1-review-result.md`〜`R4-review-result.md`） | 9章 | なし | 並列 |
| 9 | F06 | R1・R2 の指摘の修正（Interaction） | 4.4 の改訂 | `src/interaction/isolated-auditor.ts`、`discover-candidates.ts`、`src/evidence/interaction-collector.ts` | F07 と並列 |
| 9 | F07 | R3 の指摘の修正（型・スキーマ・設定・Link） | 6章、7章 | `src/config/validate-config.ts`、`src/core/contracts.ts`、`evidence-types.ts`、`src/crawl/*`、`schemas/*.json` | F06 と並列 |
| 10 | F08 | R4 の指摘の修正（スクロールの対象、form の外の入力欄、ほか） | 5.1〜5.5 | `src/browser/controlled-scroll.ts`、`src/evidence/dom-collector.ts`、`accessibility-collector.ts`、`layout-collector.ts`、`src/core/evidence-types.ts`、`schemas/*.json` | 単独 |
| 11 | R' | 修正箇所の確認のレビュー | 9章 | なし | - |
| 99 | R（旧） | 独立レビュー（Task 11 の仕様・品質、Task 1〜10 の修正） | 9章 | なし | 並列 |

テストファイルは、各サブタスクの production ファイルに対応するものを変更してよい。複数のサブタスクが同じテストファイルに触れる場合は、実行順が重ならないように、上の表の並列の指定を守る。

## 各サブタスクの受け入れ条件

### F01

- 新しい共通部品それぞれに単体テストがある。
- `src/core/deadline.ts`: 期限付きの待機が、期限の前に完了した値・期限切れ・reject を区別して返す。期限切れの後で元の Promise が reject しても、unhandledRejection にならない。マクロタスクを1回譲る関数を持つ。
- `src/core/errors.ts`: どんな値（Error、文字列、`undefined`、getter が例外を投げるオブジェクト、Proxy）を渡しても例外を投げず、指定の長さ以内の文字列を返す。
- `src/core/limits.ts`: URLの最大長 2048、エラーメッセージの最大長、HTTPメソッドの最大長 32、selector の長さ 512 と深さ 8 を定義する。既存の値と同じ値にする。
- `src/core/ids.ts`: `REQ-` の採番と `sha256:` の書式の関数を持つ。
- `src/core/contracts.ts`: 部分失敗の理由（`DEADLINE_EXCEEDED | EVALUATION_FAILED | PAGE_CLOSED`）と観測状態（`OBSERVED | NOT_OBSERVED | UNSUPPORTED`）の型を持つ。
- `src/crawl/normalize-url.ts`: `isHttpProtocol` と `canonicalizeAllowedOrigins` を持つ。`canonicalizeAllowedOrigins` は、admission-policy と request-policy の既存の2つの実装と同じ結果を返すことを、テストで確かめる。
- `src/evidence/visibility.ts`: `VISIBILITY_CHECK_OPTIONS = { opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true }` を定義する。
- 既存の呼び出し側は変更しない。

### F02a・F02b・F02c

- 担当範囲の重複を、F01 の共通部品に置き換える。置き換えた後に、同じ意味の独自実装が担当範囲に残っていない。
- 振る舞いは変えない。ただし network-collector のエラーの文字列化は、上限と防御が加わる（設計書 3.2）。
- 既存のテストがすべて PASS する。

### F03

- `tests/helpers/` に、テスト用の設定の生成、Chromium と factory の起動と終了、`Deferred` を置く。
- 各テストファイルの複製を置き換える。検証の内容は各テストに残す。
- テストの件数が減っていない。

### C1〜C8

- 設計書の該当節の内容を満たす。
- 修正前にREDになるテストを先に書き、修正後にGREENにする。
- レビューで指摘された再現条件（レビュー記録の「実測」）を、テストの入力として使う。

### R

- Task 11 の仕様レビューと品質レビューをやり直し、Critical 0・Important 0 にする。
- Task 1〜10 の修正について独立レビューを受け、Critical 0・Important 0 にする。
- `npm run verify` が PASS する。
