# T12d 実装報告（2回目。要約。設計者が保存）

## 結論

Rule の実装は完了した。Safety の Rule 7つを実装し、`SAFETY_RULES` に登録した。担当のテスト24件は PASS した。

`npm run typecheck` は失敗した。エラーは1件で、並行して作業中の T13b の `rule-engine.test.ts` から出ている。T13b の後に、設計者が型チェックを実行し直す。

## 実装した Rule

category と severity は、すべて SAFETY、version 1 である。

- `SAFETY_NON_READ_REQUEST_BLOCKED`
- `SAFETY_EXTERNAL_NAVIGATION_BLOCKED`
- `SAFETY_EXTERNAL_ACTION_BLOCKED`
- `SAFETY_DOWNLOAD_BLOCKED`
- `SAFETY_POPUP_BLOCKED`
- `SAFETY_WEBSOCKET_BLOCKED`
- `SAFETY_INTERACTION_CANDIDATE_EXCLUDED`

どの Rule も、ページとビューポートと Rule の組ごとに、1つの Finding にまとめる。`recordLimits.truncated` が真のときは、文言に、実際の件数はもっと多い可能性があると書く。

## 実装者の判断と、設計者の判断

1. Evidence の scope（PASSIVE か INTERACTION か）では絞らず、項目ごとに数える。→ 承認する。
   - Interaction の Context でも、凍結していない間は、Passive と同じ方針で遮断する。その記録は同じ項目に入る。
   - Finding から漏らさないために、scope では絞らない。
   - 設計書 5.4.1 の書き方を直した。
2. 重複を除いて並べる処理（`distinctSorted`、`joinDistinct`）は、CC-013 の対象に加える。→ T12f で行う。
3. 文言の理由コードは、英数字のまま書く。→ 受け入れる。
   - Rule が記録した事実として書く。
   - 利用者に見せるラベルは、Task 16 の表示カタログで扱う。
