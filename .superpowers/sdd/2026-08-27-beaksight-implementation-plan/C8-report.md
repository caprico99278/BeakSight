# C8 実装報告（要約。設計者が保存）

## 結論

完了した。Task 12〜16 が使う型を、collector の実際の出力に合わせて整えた。対象は、Evidence の型、ページの結果、run.json、未完了の理由、Finding の category である。

- スキーマの版は 1.0 のままにした。
- `npm run verify` は終了コード0で終わった。38ファイル・967件が PASS し、build も成功した。

## 主な変更

- `src/core/evidence-types.ts` を新設し、Evidence の型をここに集めた。collector 9ファイル、`discover-links.ts`、`controlled-scroll.ts`、`isolated-auditor.ts` は、core から型を import する。
- `src/core/contracts.ts` に、次のものを加えた。
  - 理由のコード: `INCOMPLETE_REASON_CODES`（28個）、`IncompleteReasonCode`、`IncompleteReason`
  - Finding の category: `FINDING_CATEGORIES`（11個）、`FindingCategory`
  - ビューポート: `ViewportProfile`、`ViewportAuditResult`
  - `RunSummary` の新しい項目: environment、effectiveConfig、safety、crawlLimits など
  - Evidence の種類: link と color
- スキーマ（page、run、finding）を、上の型と一致させた。型とスキーマの対応表は、実装者の報告のとおり。
- 型とスキーマが一致していることは、次の3つで確かめている。
  - 見本を `satisfies` で型検査する。
  - スキーマの一覧が TypeScript の定数と等しいことを確かめる。
  - fixture で実際に集めた Evidence を、スキーマで検証する。
- あわせて、次の修正も行った。
  - page-settling の失敗の判定を、`pageFailureReason` に置き換えた。
  - `NAVIGATION_FAILED` を加えた。
  - 実行の時刻によって失敗していたテストを直した（5回続けて実行し、すべて PASS した）。

## 発見事項と、設計者の判断

1. **既存の不具合 DEF-001**: axe を実行すると、Guard の付いた Passive Context に `CDP_SESSION_DETACHED` の違反が記録され、page が閉じられる。→ 不具合台帳に登録した。設計書 8.1 で修正の方針を決め、DEF-001 のサブタスクとして直す。
2. **SSOT**: ほかの owner の型（`NormalizedHttpUrlEvidence`、`LinkNormalizationEvidence`、`LinkAdmissionEvidence`、`InteractionCandidateEvidence`、`EffectiveAuditConfig`）を、core にもう一度定義している。→ F05 で、定義を1か所にする。
3. ids.ts に、link と color の接頭辞を加えた。→ 承認する。
4. 実装者が判断した点:
   - stress の遷移の期限切れは、`DEADLINE_EXCEEDED` のままにした。→ 承認する。
   - environment には、effectiveConfig と重なる項目を入れなかった。→ 承認する。
   - effectiveConfig の `output.directory` に、ローカルの絶対パスが入りうる。→ Task 16 で、ChatGPT 用のバンドルでは伏せ字にするか、除く。
5. 後続の Task への申し送り:
   - `DomEvidence.links` と link の Evidence に、同じリンクが二重に入る。→ Task 14 で、1回だけ格納する。
   - ページの Safety の Evidence の種類がない。→ Task 14 で加える。
   - `RunStatusInput.incompleteReasons` が文字列の配列のままである。→ F05 で構造化する。
   - Rule の評価の失敗、`InteractionOwnerCleanupError`、候補の走査の上限を表す理由のコードがない。→ Task 12・14 で加える。
