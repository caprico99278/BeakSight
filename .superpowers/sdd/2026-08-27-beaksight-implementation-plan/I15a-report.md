# I15a 実装報告（要約。設計者が保存）

## 結論

完了した。`InteractionEvidence` に、`notVerifiableKind`（`OBSERVED_NO_CHANGE` / `CHECK_NOT_COMPLETED` / null）を加えた。実装者の報告では、`npm run verify` は PASS した（60ファイル、2220件）。

- NOT_VERIFIABLE を返す経路は、すべて1つの対応表 `INTERACTION_NOT_VERIFIABLE_REASONS`（`src/interaction/isolated-auditor.ts`）を通る。区分は、その対応表の code から決まる。
- 対応表への載せ忘れは、次の2つで防ぐ。
  - 型: `notVerifiable()` は、対応表の code しか受け取らない。
  - テスト: 対応表の code が、すべて使われていることを確かめる。
- `OBSERVED_NO_CHANGE`（ONC）は、次のものである。それ以外は、`CHECK_NOT_COMPLETED`（CNC）である。
  - `NO_OBSERVABLE_CHANGE`
  - `FOCUS_PREPARATION_STATE_CHANGED`
  - 位置か大きさだけが変わったもの（スクロールの位置を比べられた場合）
  - `RETAINED_IDENTITY_LOST`

## 実装者の判断と、設計者の判断

1. click の後の観測を1回以上終えていて、変化が見えず、持続の確認の途中でもない場合は、期限が切れた時点に関係なく `NO_OBSERVABLE_CHANGE`（ONC）とする。→ 承認する。
   - これは、振る舞いの変更である。
   - 観測を終えたうえで、変化がないと結論できるので、意味に合う。
2. `RETAINED_IDENTITY_LOST` を ONC とする。→ 承認する。click と観測を終えたうえで、サイトの振る舞い（対象の削除）のために確かめられなかったものである。
3. `CANDIDATE_IDENTITY_AMBIGUOUS` などを、CNC とする。→ 承認する。
   - 同じボタンが2つあるサイトの Run は、PARTIAL になりやすくなる。
   - それでも、BeakSight の識別の限界で確かめられなかったものを、完了とは報告しない。
   - 実際のサイトでどのくらい起きるかは、Task 19 以降で確かめる。多い場合は、識別の改善を設計する。
4. 区分は、Evidence の最上位にだけ置く。最終の状態が `BLOCKED_BY_SAFETY` の場合は、null とする。→ 承認する。
5. 共通部品台帳を、更新する必要がある。→ 設計者が更新した。
