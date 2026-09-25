# C18p 指示書: RC18 の Minor の修正

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。末尾の「一時ディレクトリの扱い」も守ってください。

## サブタスク

- ID: C18p
- 目的: 整理の全体の確認のレビュー RC18 の Minor のうち、コードとテストで直すものを直す。
- レビューの結果: 作業記録置き場の `RC18-review-result.md`（M1〜M8 と、設計者の対応）
- 設計書: `doc/design/2026-09-25-beaksight-pre-task-19-cleanup-design.md` の 4.2、4.2.1、5.1
- 共通化候補: `commonization-candidates.md` の CC-033
- 共通部品台帳: `doc/design/beaksight-shared-components.md`

これまでの変更は、作業ツリーにそのまま残っています。HEAD に戻す操作は禁止です。このサブタスクは、ほかの実装者と並行ではありません。

## 作業

1. **M1: 説明の文を、実際の条件に合わせる**（`src/presentation/messages.ts`）
   - `SAFETY_FREEZE_BLOCKED`: `src/interaction/isolated-auditor.ts` を読み、このコードが付くすべての条件を確かめる（凍結の後の作用の遮断と、Interaction の段階の外部スキームへの移動の試み、など）。説明を、すべての条件に当てはまり、止められなかった可能性を隠さない文にする（設計書 4.2 の「止められなかった可能性を隠さず、正直に報告する」）。
   - `OWNER_CLOSE_SAFETY_FAILURE`: このコードが付く実際の条件（閉じる処理の失敗、期限切れ、閉じた後に Guard が終わりの状態に達しない、など）を確かめ、それに合う文にする。
   - どちらも、1つの文に1つの内容で、利用者が一度で分かる日本語にする。条件が複数あるときは、文を分けてよい。
   - 確かめたコードの条件（ファイル:行）を報告に書く。
2. **M3: page 用と handle 用の型を分ける**（`src/interaction/discover-candidates.ts`）
   - `pageInteractionCandidateProbe` の入力の型を、`DISCOVER` と `RESOLVE` だけにする。`handleInteractionCandidateProbe` の入力の型を、`INSPECT` だけにする。
   - ブラウザの中の処理の振る舞いは変えない（型だけの変更）。誤った呼び方が型のエラーになることを、テストで確かめる（`// @ts-expect-error` を使う型のテストなど。既存の型のテストの書き方があれば、それに合わせる）。
3. **M4: 探索のテストで、Guard の違反を見逃さない**
   - `tests/helpers/gate-harness.ts` の `withGuardedPassivePage` に、処理が終わった後に Safety Ledger の違反が0件であることを確かめる指定（例: `expectNoViolations: true`）を加える。既定は、今の振る舞いのまま（確かめない）にする。違反を確かめるテストが、この補助を使っているためである。
   - 確かめは、page と Context を閉じる前に行う。違反があった場合は、違反の内容が分かる形でテストを失敗させる。閉じる処理は、失敗しても必ず行う。
   - `tests/integration/isolated-interaction.test.ts` の `discover` と、候補の探索のテスト（C18m で置き換えた9件）で、この指定を使う。
   - 指定が働くことを、補助のテストで確かめる（違反のある場合に失敗し、ない場合に通ること）。補助のテストのファイルがなければ、`tests/unit/` か `tests/component/` の適切な場所に作る。
4. **M5: CLI のテストの headless を固定する**（`tests/integration/cli.test.ts:194` 付近）
   - 別のプロセスで本物の CLI を動かす呼び出しに、130行目と同じように `--headless` を付ける。ほかの呼び出しにも同じ問題があれば、同じように直し、報告する。
5. **M6: 矩形の型の別名**（`src/core/evidence-types.ts`）
   - `InteractionBoundingBoxEvidence` を、`RectangleEvidence` の型の別名にする（例: `export type InteractionBoundingBoxEvidence = RectangleEvidence;`）。スキーマは変えない。型のエラーが出ないことを確かめる。
6. **M8: 使われない lifecycle の説明を消す**（`src/presentation/messages.ts`）
   - `INTERACTION_LIFECYCLE_REASON_DESCRIPTIONS` と `describeInteractionLifecycleReason` を消す。製品のコードのどこからも使われていないためである（lifecycle の理由は、表示していない）。
   - `tests/unit/presentation-messages.test.ts` の、これらを確かめるテスト（3件）を消す。消したテストの名前を報告する。
   - 消す前に、`src/` と `tests/` のどこからも使われていないことを grep で確かめる。

## TDD の進め方

- M3（型のエラーのテスト）、M4（補助の指定のテスト）は、先に RED を確かめる。
- M1 は、説明の文を確かめる既存のテスト（網羅、日本語、重なりなし）が PASS することを確かめる。文の中身を固定するテストは加えなくてよい。
- M5、M6、M8 は、関係するテストが PASS することを確かめる。

## 変えてよいファイル

- `src/presentation/messages.ts`
- `src/interaction/discover-candidates.ts`（型の別名だけ）
- `src/core/evidence-types.ts`（型の別名だけ）
- `tests/helpers/gate-harness.ts`
- `tests/integration/isolated-interaction.test.ts`
- `tests/integration/cli.test.ts`
- `tests/unit/presentation-messages.test.ts`
- 補助の指定のテストと、型のテストの新しいファイル（`tests/unit/` か `tests/component/`）
- 上に無いファイルを変える必要が出たら、Blocker として止まる。

## 受け入れ条件

- M1、M3、M4、M5、M6、M8 が、上のとおりに直っている。
- 既存のテストのケースを消していない（M8 の3件を除く）。確かめる内容を弱めていない。
- UI Gate と ARCH の Gate が PASS する。
- `npm run verify` が PASS する（型チェック → 全テスト → ビルド）。

## 厳守事項

- **Chromium は headless だけで起動する。** headed（`headless: false`）で起動してはいけない。
- 外部スキームの宛先は、実在しない値だけを使う（`tel:+10000000000`、`mailto:nobody@example.invalid`、`beaksight-test-app:probe`）。
- 本来の監査対象のサイトを含む、実在の外部のサイトにアクセスしない。`config/targets/` と `local/` の実サイトの設定を使わない。
- `git commit`、`git push`、HEAD に戻す操作は禁止。
- 依存パッケージを追加・更新しない。
- Blocker に当たったら、回避策を自分で考えずに止まり、報告する。

## 報告

共通ルールの形式で、日本語で報告してください。M1 の新しい説明の文と、確かめたコードの条件（ファイル:行）を入れてください。`npm run verify` の結果（ファイル数、件数）も入れてください。
