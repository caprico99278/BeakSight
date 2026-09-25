# C18g 実装報告（要約。設計者が保存）

## 結論

完了した。

- サーバのリダイレクト（3xx の `Location` が外部スキーム）を、Guard がたどる前に止める。
  - 方法: CDP の `Fetch` に `{ resourceType: 'Document', requestStage: 'Response' }` を加えた（`passive-request-guard.ts:1262`）。
  - 応答の処理: `handlePausedDocumentResponse`（`:999`）
  - 止めたものは、`externalSchemeNavigations` に `EXTERNAL_SCHEME_REDIRECT_BLOCKED` で記録する。
- headed でも、違反にしない。止めて防ぐためである。
- 解析できない `Location` は、fail-closed にする（`EXTERNAL_SCHEME_DETECTION_FAILED`、Context を閉じる）。
  - `failRequest` に失敗した場合は、`CDP_FAIL_REQUEST_FAILED` の違反にする。
- 新しい Rule `SAFETY_EXTERNAL_SCHEME_REDIRECT_BLOCKED` を加えた。既存の Rule は、スクリプトによる試み（`EXTERNAL_SCHEME_NAVIGATION`）だけを数える。
- main frame で Guard 自身が止めたリクエストの失敗は、`expectedCdpFailures` に登録して、`HTTP_MAIN_FRAME_DELIVERY_FAILED` の違反にしない（`:1059-1073`）。
  - 照合は、同じ page、同じメソッドと URL、`net::ERR_BLOCKED_BY_CLIENT` で行う。1回で消費し、1秒で期限が切れる。
  - Playwright の `requestfailed` からは CDP の requestId を読めないので、照合はこの条件で近似している。
  - 対照として、次のものは違反のままであることを確かめた。
    - 別の URL の失敗
    - 別の理由の失敗
    - 2回目の失敗
    - `failRequest` の失敗
  - 開始のページがリダイレクトする CLI の Run では、ページは `FAILED`、Run は `PARTIAL` になる。
- GATE-S03 に、リダイレクトの経路を加えた。
  - iframe、main frame、headed の注入、Run の段階
  - RC18a の指摘4のコメントも加えた。
- テスト: 関連する14ファイルで、1,024件が PASS した。typecheck も PASS した。

## 実装者の判断と、設計者の判断

1. 新しい Rule を加え、既存の Rule と分けた。→ 承認する。
2. 理由ごとのカタログは作らず、種類の説明の中で、2つの理由の意味を示した。→ 承認する。
3. 3xx はすべて調べ、`Location` が複数ある場合は、1つでも外部スキームなら止める。→ 承認する。保守的な判定である。
4. すべての Document の応答が、CDP で1往復多く一時停止する。→ 承認する。
5. 試験用のパスの定数が、3つのテストファイルにある。→ CC-029 に加えた。
6. main frame の違反の扱い（RC18a の指摘3）。→ 設計者の判断で、止めたリクエストに限って、予期した失敗にした（上のとおり）。

## 発見事項と、設計者の判断

1. **DEF-013 を再現した。**
   - 1.5秒待ってから同じ Origin へ返す普通の 302 で、`REDIRECT_PREDECESSOR_MISSING` の違反が出た。main frame と iframe の両方で起きた。
   - ナビゲーションは失敗し、Context は閉じる。
   - C18g の変更の前からある不具合である。
   - 原因: `RedirectPredecessorRegistry` は、リクエストの段階で登録してから 1,000ms（`EXPECTED_CDP_FAILURE_RETENTION_MS`）で、登録を期限切れにする。
   - fixture: `/__slow-redirect`（`fixtures/server.ts:89`、`:346`）
   - → C18h で直す（設計書 4.6）。実サイトの Run が、偽の違反で止まりうるため、Task 20 の前に必ず直す。
2. 別のホストの iframe（OOPIF かは未確認）でも、リダイレクトが止まり、記録された。→ RC18b で確かめる。
