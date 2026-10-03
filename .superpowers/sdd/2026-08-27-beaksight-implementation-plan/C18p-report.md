# C18p 実装報告（RC18 の Minor の修正）

## 結論
完了。M1・M3・M4・M5・M6・M8 を直した。実装者の `npm run verify`: 終了コード 0、100ファイル、3,632件 PASS、ビルド PASS。

## 変更したファイル
| パス | 変更の内容 |
| --- | --- |
| `src/presentation/messages.ts` | M1: `SAFETY_FREEZE_BLOCKED` と `OWNER_CLOSE_SAFETY_FAILURE` の説明を、実際の条件に合わせて書き直した。M8: `INTERACTION_LIFECYCLE_REASON_DESCRIPTIONS` と `describeInteractionLifecycleReason` を消した |
| `src/interaction/discover-candidates.ts` | M3: `PageInteractionProbeInput`（DISCOVER と RESOLVE）と `HandleInteractionProbeInput`（INSPECT）に型を分けた。ブラウザの中の処理は変えていない |
| `src/core/evidence-types.ts` | M6: `InteractionBoundingBoxEvidence = RectangleEvidence` の型の別名にした。スキーマは変えていない |
| `tests/helpers/gate-harness.ts` | M4: `withGuardedPassivePage` に `expectNoViolations` を追加。`run` の後、閉じる前に確かめ、違反があれば件数と一覧を示して失敗する。閉じる処理は必ず行う。既定は確かめない |
| `tests/integration/isolated-interaction.test.ts` | M4: `discover` と探索の9件で `expectNoViolations` を使う |
| `tests/integration/cli.test.ts` | M5: PARTIAL の Run の呼び出しに `--headless` を付けた |
| `tests/unit/presentation-messages.test.ts` | M8: lifecycle の説明の3件を消した（`has exactly one Japanese description for every interaction lifecycle reason code`、`gives different codes different descriptions`、`is frozen`） |
| `tests/unit/interaction-probe-input-types.test.ts`（新規） | M3 の型のテスト（`expectTypeOf` と `@ts-expect-error`） |
| `tests/unit/gate-harness.test.ts`（新規） | M4 の補助のテスト（4件。偽の factory） |

## M1 の新しい説明
- `SAFETY_FREEZE_BLOCKED`: 「安全のために通信を止めた後で、ページが、通信、ほかのページへの移動、ポップアップ、ダウンロード、外部のアプリ（電話やメールなど）を開く移動のどれかを試みました。外部のアプリを開く移動のほかは、遮断しました。外部のアプリを開く移動は、止められなかったおそれがあります。」
- `OWNER_CLOSE_SAFETY_FAILURE`: 「操作用のブラウザの環境を閉じる処理で、失敗、期限切れ、閉じた後も安全の確認の仕組みが終わりの状態にならない、のどれかが起きました。この異常は、安全の不変条件の違反として記録しました。環境は、その後に閉じました。」
- 確かめた条件: `isolated-auditor.ts` の `hasFreezeEvent`（527〜534行。Interaction の段階の外部スキームへの移動の試みを含む）、付く場所（546〜552、1400〜1401、1483〜1484、1489〜1490行）、`cleanupAnomaly`（1655〜1686行）、`finishClosed`（1688〜1694行）。

## テスト（実装者）
- M3: 型を広いままにして `tsc` が失敗することを確かめ（期待どおりの型のエラー5件）、狭めて通した。
- M4: 補助のテストで、違反があっても失敗しないことを RED で確かめ、GREEN にした。`isolated-interaction` 440件 PASS（探索のテストで違反は出ていない）。
- 関連: unit 9ファイルと `tests/architecture` で834件 PASS。
- `npm run verify`: 100ファイル、3,632件 PASS。
- M5: `tests/integration/cli.test.ts` で本物の CLI を起動するのは2か所だけで、両方に `--headless` が付いた。`tests/unit/cli.test.ts` はブラウザを起動しない（偽の launcher、`--help`、知らないコマンドだけ）。

## 発見事項
- 共通部品台帳に、消した lifecycle の説明の名前が残っていた → 設計者が直した。

## 設計者の確認（2026-09-26）
- 変更ファイルは指示の範囲と一致した（`tests/unit/cli.test.ts` の差分は、以前の C18k のもの）。
- 共通部品台帳の `messages.ts` の行から、消した名前を外した。`gate-harness.ts` の行に `expectNoViolations` を書き足した。
- 設計者の verify: 下に追記する。

## 設計者の verify（2026-09-26）

- 1回目の `npm run verify`: 終了コード 1。型チェック PASS。テストは 99ファイル、3,616件 PASS、失敗 0件。vitest のワーカーが1つ異常終了し、1ファイル（16件）の結果が出なかった。ビルドは実行されなかった。DEF-015 として登録した。
- 全テストの再実行（`npx vitest run --reporter=json`）: 100ファイル、3,632件がすべて PASS。
- `npm run build`: PASS。`npm run typecheck`: PASS。
- したがって、型チェック、全テスト、ビルドのすべてが、今の作業ツリーで PASS している。
