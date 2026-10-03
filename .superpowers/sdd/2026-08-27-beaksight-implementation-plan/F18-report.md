# F18 実装報告（要約。設計者が保存）

## 結論

完了した。R6 の I-1・I-2・M-2・M-3・M-4 を直した。`npm run verify` は PASS した（41ファイル、1519件）。

## 主な変更

- `InteractionAuditInput` に、必須の `navigationTimeoutMs` を加えた。読み込みと初期描画は、この期限で待つ。Interaction の期限は、その後から数え始める。
- 読み込みの期限切れは、NOT_VERIFIABLE にした（理由は `Interaction deadline expired during initial load`）。
- style の変化は、`--*` 以外の宣言だけで比べる。class は、名前の集まりとして比べる。
- 安定性の確認では、class の名前ごとに記録する。
- 理由から、LRM・RLM・ALM と孤立したサロゲートを取り除く。
- `detailsOpenBefore` と `detailsOpenAfter` を Evidence に残す。

## 実装者の判断と、設計者の判断

1. 読み込みの期限は、呼び出す側（Task 14）が設定の `crawl.navigationTimeoutMs` を渡す。→ 承認する。Task 14 の設計書に書き加える。
2. 読み込みの期限切れを、EXECUTION_FAILED から NOT_VERIFIABLE に変えた。→ 承認する。「確かめられなかった」ので、NOT_VERIFIABLE が意味に合う。設計書 4.4.1 に書き加える。
3. 既存のテスト2件を、仕様に合わせて直した。条件は弱めていない。→ 承認する。
4. 分解できない値は、これまでの値の比べ方に戻す。class の比較ができない場合は、class を根拠にしない（fail-closed）。→ 承認する。
5. class の名前の順序や空白だけの変化は、変化とみなさない。→ 承認する。
6. `detailsOpenBefore` と `detailsOpenAfter` は、スキーマの必須の項目にした。→ 承認する。まだ成果物を出力したことがないため、互換性の問題はない。
