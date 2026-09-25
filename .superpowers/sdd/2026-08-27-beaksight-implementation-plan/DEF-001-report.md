# DEF-001 実装報告（要約。設計者が保存）

## 結論

一部完了。不具合の本体は修正した。Evidence への制約の記録は DEF-001b で行う。

## 原因として確かめた事実

- `@axe-core/playwright` 4.13.0 は、既定の方式では `finishRun()` の中で `context.newPage()` を呼んで `about:blank` の page を開き、最後に `blankPage.close()` で直接閉じる。
- Guard は、その page に CDP のセッションを付けていた。page が Guard を経由せずに閉じられたため、Guard はそのセッションの切り離しを `CDP_SESSION_DETACHED` として記録し、Context を無効化した。その結果、監査対象の page も閉じられた。
- Guard の判定そのものは正しく働いていた。

## 修正

- `new AxeBuilder({ page }).setLegacyMode(true).analyze()` に変更した。この方式では、axe は対象の page の中だけで実行され、`allowedOrigins` は `<same_origin>` になる。
- 新しい統合テスト `tests/integration/accessibility-guard-safety.test.ts` を加えた。このテストは、axe の実行中に別の page が開かれないこと、`invariantViolations` が0件であること、page が開いたままであること、Guard が有効なままであることを確かめる。修正前は RED になることを確かめ、修正後は GREEN になった。3回続けて実行し、3回とも PASS した。
- accessibility に関係する4ファイル・33件と、typecheck が PASS した。

## Blocker と、設計者の判断

- 「検査の範囲は、同じOriginの文書に限られる」という制約を Evidence に記録するには、`src/core/evidence-types.ts`（F05 の作業中）と `schemas/page.schema.json` の変更が必要になる。
- 提案された形は、`frameScope: 'SAME_ORIGIN_ONLY'` を必須の項目として持たせるものである。
- → 選択肢(a)を採る。F05 の完了後に、DEF-001b で、型・スキーマ・collector・テストをまとめて変更する。

## 発見事項と、設計者の判断

- 同じ Context に自分で page を開いて直接閉じるライブラリを使うと、Guard がその Context を無効化する。
  → これは仕様どおりの振る舞いである。collector を作るときの注意として、共通部品台帳に記録する。
