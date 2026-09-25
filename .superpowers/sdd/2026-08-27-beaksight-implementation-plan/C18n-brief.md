# C18n 指示書: Interaction の理由をコードと詳細に分ける（CC-010 の残りの1）

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。末尾の「一時ディレクトリの扱い」も守ってください。

## サブタスク

- ID: C18n
- 目的: Interaction の Evidence の `reason`（`work.reason`、`lifecycle.reason` を含む）を、閉じた一覧の理由のコードと、技術的な詳細 `reasonDetail` に分ける。
- 設計書: `doc/design/2026-09-25-beaksight-pre-task-19-cleanup-design.md` の **5.1**（必ず全部読むこと）
- 実装計画: `doc/design/2026-09-25-beaksight-pre-task-19-cleanup-implementation-plan.md` の C18n
- 調べた結果: 作業記録置き場の `C18e-report.md` の「第2段階」（値の出どころの行番号と、使う場所）
- 関係する設計書:
  - UI 追補設計書 `doc/design/2026-09-23-beaksight-ui-ssot-design.md`（JSON の理由は英数字のコード。表示で日本語に変える）
  - Task 14〜17 の設計書 `doc/design/2026-09-23-beaksight-task-14-17-pipeline-report-cli-design.md` の 6.1.5
- 共通部品台帳: `doc/design/beaksight-shared-components.md`

これまでの変更は、作業ツリーにそのまま残っています。HEAD に戻す操作は禁止です。このサブタスクは、ほかの実装者と並行ではありません。

## 作業

1. **コードの一覧を作る**（`src/core/evidence-types.ts`）
   - `InteractionReasonCode`（と、その値の一覧の定数）を作る。中身は設計書 5.1.2 のとおり。
     - REJECTED_UNSAFE の9種（今の `INTERACTION_REJECTION_REASONS`）
     - NOT_VERIFIABLE の54個（今の `INTERACTION_NOT_VERIFIABLE_REASONS` のキー。一覧をここに移す）
     - `OBSERVABLE_STATE_CHANGED`、`SAFETY_FREEZE_BLOCKED`、`OWNER_CLOSE_SAFETY_FAILURE`、`EXECUTION_FAILED`、`CLICK_FAILED`
   - `InteractionLifecycleReasonCode` を作る（例: `SESSION_NOT_OPENED`、`OWNER_CLOSE_TIMED_OUT`、`OWNER_CLOSE_FAILED`）。
   - まず、`isolated-auditor.ts` の中で `reason` に入るすべての値を洗い出す。一覧に漏れがないことを確かめる。既存のコードと同じ意味の、新しい名前を作らない。足りないコードが見つかったら、名前を付けて加え、報告に書く。
2. **Evidence の型を変える**
   - `reason: InteractionReasonCode` と `reasonDetail: string | null`（必須）。`work` も同じ形。
   - `lifecycle` は `reason: InteractionLifecycleReasonCode | null` と `reasonDetail: string | null`。
3. **`src/interaction/isolated-auditor.ts` を直す**
   - すべての経路で、`reason` にコードを入れ、詳細（completeness の値、identityStatus の値、整えたエラーの文言）を `reasonDetail` に入れる。詳細がないときは `null`。
   - `INTERACTION_NOT_VERIFIABLE_REASONS` は、コードから区分（`notVerifiableKind`）への対応だけを持つ形にする。英文は消す。型で、一覧のすべてのコードに区分があることを保証する。
   - エラーの文言は、今と同じ整え方（`safeErrorMessage` など、上限付きのもの）を通す。
   - `CLICK_TIMED_OUT` と、EXECUTION_FAILED の代わりの経路（`CLICK_FAILED`、`EXECUTION_FAILED`）が、コードで見分けられるようにする。
   - status、`notVerifiableKind`、安全の判定、作業の順序は変えない。
4. **スキーマを変える**（`schemas/page.schema.json` の `interactionEvidence`）
   - `reason` を enum にし、`reasonDetail` を必須（`string` か `null`）で加える。`work`、`lifecycle` も同じ。
   - スキーマの版は上げない。`reasonDetail` に新しい長さの上限を加えない。
   - enum の値は、コードの一覧の定数と一致していることを、テストで確かめる（手で写した一覧が、ずれないように）。すでに同じ種類の一致のテストがあれば、それに加える。
5. **表示用モデルは、型が通るだけの最小の変更にする**（`src/report/view-model.ts`）
   - 今は `reason` を文字列でそのまま移している。コードをそのまま移す形にし、詳細も同じ場所に並べて渡す（例: `reasonDetail` を加える）。日本語の説明と HTML は、次のサブタスク C18o で行う。
   - `src/report/html-report.ts` は、型が通らない場合だけ最小に直す。
6. **`src/interaction/discover-candidates.ts` の `domWork.exhausted` を消す**（書き込むだけで読まれない）。ほかは変えない。

## TDD の進め方

- まず、REDになるテストを書く:
  - すべての status の経路で、`reason` が一覧のコードで、英文でないこと（`isolated-interaction.test.ts` などの既存の経路の試験に、確かめを加える）
  - `CLICK_TIMED_OUT` と EXECUTION_FAILED の代わりの経路が、違うコードになること
  - スキーマが、一覧にない `reason` と、`reasonDetail` の欠けを拒むこと
  - スキーマの enum と、コードの一覧の定数が一致すること
- 既存のテストの期待値は、新しい形に合わせて直す。**確かめる内容を弱めない。** 英文の一致で確かめていたものは、コードの一致と、必要なら詳細の一致で確かめる。期待値を消したり、`expect.any(String)` のような弱い形に替えたりしない。
- 期待値を直したテストの数と、ファイルごとの前と後の件数を報告する。

## 変えてよいファイル

- `src/core/evidence-types.ts`
- `schemas/page.schema.json`
- `src/interaction/isolated-auditor.ts`
- `src/interaction/discover-candidates.ts`（`domWork.exhausted` だけ）
- `src/orchestration/page-auditor.ts`（Evidence の記録で型が通らない場合だけ）
- `src/report/view-model.ts`、`src/report/html-report.ts`（型を通すための最小の変更だけ）
- テスト: `tests/integration/isolated-interaction.test.ts`、`tests/integration/page-auditor-interaction.test.ts`、`tests/unit/schema-validator.test.ts`、`tests/helpers/audit-run-fixture.ts`、`tests/integration/safety-gates.test.ts`（理由の期待値だけ）、表示のテスト（`view-model`、`chatgpt-bundle`、`html-report`）は、型や見本の変更で通らなくなる期待値だけ
- 上に無いファイルを変える必要が出たら、Blocker として止まる。

## 使うべき共通部品（台帳から）

- `safeErrorMessage`（`src/core/errors.ts`）: エラーの文言の整え方
- `deepFreeze`（`src/core/immutable.ts`）: 定数の一覧の不変化
- ページの未完了の理由（`IncompleteReason` の `code` と `detail`）の形と考え方を、手本にする。
- スキーマの見本は `tests/helpers/audit-run-fixture.ts` の組み立てを使い、テストに見本を複製しない。

## 受け入れ条件

- Evidence の `reason` と `work.reason` に英文が入らない。`lifecycle.reason` は null かコード。
- `CLICK_TIMED_OUT` と EXECUTION_FAILED の代わりの経路が、コードで見分けられる。
- スキーマが、一覧にない値と `reasonDetail` の欠けを拒む。enum とコードの一覧が一致する。
- 既存のテストのケースを消していない。確かめる内容を弱めていない。
- `npm run verify` が PASS する（型チェック → 全テスト → ビルド）。
- すべての Gate（S、A、ARCH、UI）が PASS する。

## 厳守事項

- **Chromium は headless だけで起動する。** headed（`headless: false`）で起動してはいけない。
- 外部スキームの宛先は、実在しない値だけを使う（`tel:+10000000000`、`mailto:nobody@example.invalid`、`beaksight-test-app:probe`）。
- 本来の監査対象のサイトを含む、実在の外部のサイトにアクセスしない。`config/targets/` と `local/` の実サイトの設定を使わない。
- `git commit`、`git push`、HEAD に戻す操作は禁止。
- 依存パッケージを追加・更新しない。
- Blocker に当たったら、回避策を自分で考えずに止まり、報告する。

## 報告

共通ルールの形式で、日本語で報告してください。次のものを入れてください。

- コードの一覧の最終の形（status ごと）と、洗い出しの方法
- 経路ごとの `reason` と `reasonDetail` の対応（旧の値 → 新のコードと詳細）
- 期待値を直したテストの数と、ファイルごとの前と後の件数
- `npm run verify` の結果（ファイル数、件数）

## 追補（2026-09-25、Blocker の後）

- 変えてよいファイルに追加: `tests/unit/run-coordinator.test.ts`、`tests/integration/page-auditor.test.ts`、`tests/unit/audit-run-fixture.test.ts`、`tests/unit/schema-enum-consistency.test.ts`（見本と期待値だけ。確かめる内容を弱めない）
- NOT_VERIFIABLE のコードは55個。lifecycle のコードに `OWNER_CLOSE_NON_TERMINAL` を加える。`InteractionOwnerCleanupError` の `lifecycle` も同じ形にする。Safety Ledger の文言は変えない。
- 設計書 5.1.2 と 5.1.3 に反映済み。同じ実装者に伝えて再開した。
