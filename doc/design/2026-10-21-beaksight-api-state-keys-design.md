# 設計書 — API の登録・更新で、公開の状態の欄を「論理削除」と分けて通す（DEF-147）

状態: ユーザーの判断（2026-10-21「従来の方針通り、登録・更新は通す。削除は通さない」）。実装中。
作成: 2026-10-21（設計者）

## 1. 経緯（実テスト環境の事実）

管理画面の発見（140 ページ）で、登録・更新の送信の形が観察できた。どれも `NOT_EXECUTABLE`・`SOFT_DELETE_KEY` に分類された。

| 画面の操作 | 送信 | 本文の鍵のうち、状態の語に当たったもの（見立て） |
| --- | --- | --- |
| ブログの新規の「保存」 | `POST /rest/v1/blog_posts` | `status`、`published_at` |
| 動画の新規の「保存」 | `POST /rest/v1/videos` | `is_published` |
| 推薦者の新規の「保存」 | `POST /rest/v1/recommenders` | `is_published` |
| 採用情報の編集の「保存」 | `PATCH /rest/v1/recruits?id=eq.<画面の ID>` | `status` |

今の分類（`src/discovery/api-shape-classification.ts`）は、本文の鍵の名前が状態の語の一覧（`fieldNameHasStateWord`。status・published・unpublished など）に当たると、`SOFT_DELETE_KEY` で実行しない側にする（T37R-fix-A）。この一覧は、論理削除の語と、公開の状態の語を区別していない。

そのほかに観察できたもの:
- `/functions/v1/assist-page-text` の `API_CREATE`: 文章を作る補助の関数で、レコードの登録ではない（シナリオに使わない）。
- 手続きの呼び出し（`/rest/v1/rpc/…`）: 保存の手続きを含む。今どおり実行しない。
- `DELETE`: 今どおり実行しない。
- `site_settings` の upsert: 今どおり実行しない。

## 2. 設計

- **論理削除の鍵と、公開の状態の鍵を分ける。**
  - 論理削除の語（例: deleted、deleted_at、is_deleted、removed、archived、trashed。今の一覧のうち「消す・捨てる」の意味のもの）を、名前つきの閉じた一覧にする。本文の鍵がこれに当たる API の型は、今どおり `NOT_EXECUTABLE`・`SOFT_DELETE_KEY`。
  - 公開の状態の語（status、published、unpublished、is_published、published_at、visibility など）だけに当たる型は、`SOFT_DELETE_KEY` にしない。ほかの決まり（method、filter、型の上限など）で `API_CREATE`・`API_UPDATE` を決める。
  - 当てるのは、API の型の分類（`classifyApiShapeObservation`）と、観察の部品の `stateKeyPresent`（伏せる前の名前で見た真偽）だけ。フォームの送信の分類（`hasStateField` など）は変えない。
- **値**: 公開の状態の欄の値は、ほかの欄と同じく、入力の規則で利用者が決める（ユーザーの方針「登録・更新は通す」）。承認の画面の API の要求の型に、公開の状態の欄の鍵を、注意の印つきで出す（例:「公開の状態にあたる欄」）。値を固定する決まりは足さない。
- **更新の既定**: API の更新では、公開の状態の欄を「保つ欄」の既定の候補にする（変えない欄の既定。今の保つ欄の決まりに合わせる）。利用者が変える欄に移せる。
- **digest への影響**: 語の一覧を分けることで、識別や規則の digest（`rule_digest` など）が変わる場合は、止まって報告する（承認や索引に響くため）。変わらない形（分類の判定だけを変える）を優先する。

## 3. 受け入れ条件

1. 単体: 本文の鍵に `status`・`is_published`・`published_at` だけを持つ POST は `API_CREATE`、filter が画面の ID の PATCH は `API_UPDATE`。`deleted_at`・`is_deleted` を持つものは、今どおり `SOFT_DELETE_KEY`（RED → GREEN）。
2. 結合（fixture）: 公開の状態の欄のある登録の画面で、probe の結果が `API_CREATE` になり、シナリオの下書きが作れる。承認の画面に注意の印が出る。サーバに何も届かない（両方の Chromium）。
3. 回帰: フォームの送信の分類、論理削除の分類、今の承認と索引のテスト（digest が変わらないこと）。

## 4. 設計の変更の履歴

| 日付 | 理由 | 変更 |
| --- | --- | --- |
| 2026-10-21 | 作成 | 実テスト環境の発見と、ユーザーの判断による。 |
