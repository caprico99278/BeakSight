# C16e 実装報告（要約。設計者が保存）

## 結論

完了した。実装者の報告では、`npm run verify` は PASS した（84ファイル、2912件。todo 1件）。UI Gate のファイルは 320ms で終わった。

- Safety の事象の種類の値の一覧を、core に置いた。
  - 置いたもの: `src/core/evidence-types.ts` の `SAFETY_EVENT_KINDS` と `SafetyEventKind`
  - 書き漏れと余分は、型のエラーになる。
  - カタログ、表示用モデル、テストの補助は、この一覧を使う。
- UI05 の対象を加えた。
  - `SAFETY_EVENT_KIND_CATALOG`
  - `formatInteger(null)` と `formatInteger(0)`
- HTML の事象の表に、「候補」の列を加えた（8列）。
- 既存のテストの列の期待値を、1か所だけ直した。列が増えたためである。

## 実装者の判断と、設計者の判断

1. `catalog.ts` は、core の型を、同じ名前で公開し直すだけにした。→ 承認する。
   - 公開するのは型の別名だけで、一覧は持っていない。
   - `src/` の中で使う側は、core から import する。
2. 型の検査のための型を、`evidence-types.ts` の中に置き、export しなかった。→ 承認する。
3. UI05 に、`formatInteger(0)` の検査も加えた。→ 承認する。

## 発見事項と、設計者の判断

1. 共通部品台帳に、core の `SAFETY_EVENT_KINDS` の行がない。→ 設計者が加えた。
2. Safety Ledger の分類の名前の型が、`string` である（`src/safety/safety-ledger.ts:271, 282`）。→ 共通化候補の CC-028 として登録した。
   - `SafetyEventKind` に絞れば、書き間違いを型のエラーにできる。
   - 安全の部品なので、Task 18 の前の整理で、DEF-008 と同じく Guard のレビューを受けて直す。
