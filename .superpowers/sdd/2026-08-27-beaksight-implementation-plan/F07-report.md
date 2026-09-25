# F07 実装報告（要約。設計者が保存）

## 結論

完了した。M1・M3・M4・M5・M6・M7 を直した。

- 振る舞いを変える修正は、修正前に RED、修正後に GREEN になることを確かめた。
- unit と component のテスト（28ファイル・714件）が PASS した。typecheck も PASS した。

## M5 で決まった型（Task 14 で使う）

- `ViewportAuditResult` には、次の項目がある（`status` と `incompleteReasons` は、これまでどおり）。
  - `requestedUrl`: `pageUrl` と同じ値
  - `finalUrl`: string、または null
  - `httpStatus`: number、または null
- `PageAuditResult.pageUrl`: クロールのキューで使う、要求した正規化済みのURL。
- `EvidenceRecordFor.viewport` と `Finding.viewport`: `ViewportProfile`、または null。`ViewportProfile` は、`VIEWPORT_PROFILES = ['desktop','mobile']` から導く。
- `UrlRejectionReason`: `INVALID_URL`、`UNSUPPORTED_SCHEME`、`CREDENTIALS_NOT_ALLOWED`、`URL_TOO_LONG` のいずれか。
- Link の payload: `LinkDiscoveryEvidence = {links, omittedLinkCount}`。`LinkEvidence.truncated` を加えた。
- `blockedActions` の説明に、次の2点を書いた。
  - 件数は下限であること。
  - 記録は、ページの Safety の Evidence が持つこと。

## 発見事項と、設計者の判断

1. `discoverLinks()` の戻り値を変えずに、`discoverLinkEvidence()` を新しく加えた（テストの型検査を通すため）。
   → 承認しない。同じ用途に第二の入口を作ることは、実装タスク指示 4.2 に反する。F08 で、正式な入口の `discoverLinks()` が `LinkDiscoveryEvidence` を返すように1つにまとめ、`discoverLinkEvidence()` は削除する。利用者（`tests/component/dom-collector.test.ts` など）も直す。
2. 正規化した後のURLが2048文字を超える場合は、受け入れない（`URL_TOO_LONG`）。→ 承認する。
3. DOM の Evidence に、リンクの切り捨ての件数がない。→ F08 で直す。
4. `ScreenshotEvidence.viewport` が、string のままになっている。→ F08 で `ViewportProfile` にする。
5. ブラウザから受け取る文字列は、Node 側で切り詰めている。→ 許容する。伏せ字を確実にするためである。
6. `context-factory.ts:44` のチェックが、正の有限の数を受け付ける。→ F08 で、正の安全な整数に直す。
7. 共通部品台帳への登録。→ 設計者が行う。
8. `ariaLabel` にも上限を設けた。→ 承認する。
