# T18a 実装報告（要約。設計者が保存）

## 結論

完了した。fixture を6つと、それを確かめるテスト（`tests/integration/gate-fixtures.test.ts`、7件）を加えた。DEF-010 のパスも直した。実装者の報告では、`npm run verify` は PASS した（90ファイル、3148件）。

- パスを直した後も、ポップアップと移動の遮断のテストは PASS した。遮断は、実際に働いている。
- 対照の確認:
  - Guard のない Context では、同じボタンで、`GET /popup-target.html` と `GET /navigation-target.html` が、サーバに届く。
  - Guard の付いた Passive の Context で直接開いても、GET が数えられる。
- `fixtures/server.ts` は、変えていない。既存の `/__mutation` が、PATCH と POST を受け付けて数えるためである。

## fixture の一覧（T18b・T18c 向け）

| fixture | 試みるリクエスト | 起きる時 |
| --- | --- | --- |
| `/popup-target.html` | なし（開かれる先） | `/popup-button.html` の「Open popup」 |
| `/navigation-target.html` | なし（開かれる先） | `/navigation-button.html` の「Attempt navigation」 |
| `/passive-patch-request.html` | `PATCH /__mutation` を1回 | 読み込んだとき |
| `/patch-request.html` | `PATCH /__mutation` を1回 | ボタン「Send PATCH」（`#send-patch`） |
| `/service-worker-post.html` | `GET /service-worker-post-worker.js` | 読み込んだときと、ボタン「Register posting worker」 |
| `/service-worker-post-worker.js` | `POST /__mutation` を1回（Worker 自身） | Worker の install の時 |

## 実装者の判断と、設計者の判断

1. Worker を登録するページを1つにし、読み込んだときとボタンの両方で登録する。→ 承認する。1ページで、両方の段階の S08 に使える。
2. Worker の POST とページの POST は、サーバでは区別できない。→ 承認する。
   - このページのスクリプトは、GET と HEAD 以外を送らない。そのため、届く POST は、Worker のものである。
   - テストで、ページの HTML に `method: 'POST'` がないことも確かめている。
3. 新しいテストは、新規のファイルに置いた。→ 承認する。

## 発見事項と、設計者の判断

1. サーバは 404 のリクエストも記録するので、パスを直すだけでも、遮断の漏れは見つけられたはずである。→ 了解した。fixture を置いたことで、対照の確認で、ページが実際に開くことまで確かめられるようになった。
2. 遮断を止めて、直した確認が FAIL することまでは、試していない（`src/` を変えないため）。→ 受け入れる。対照の確認で代える。
3. verify の時点では、T18d の新しいファイルは、まだなかった。→ 設計者の verify で、全体を確かめる。
