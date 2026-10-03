# C18h 実装報告（要約。設計者が保存）

## 結論

完了した。実装者の報告では、`npm run verify` は PASS した（96ファイル、3,479件）。

- `/__slow-redirect`（1.5秒の普通の 302）で、main frame と iframe の両方とも、偽の違反が出なくなった。リダイレクト先まで読み込める。
- 対応付けの本当の欠落と、件数の上限を超えた場合は、今までどおり違反になり、Context を閉じる（fail-closed）。

## 登録と消去（`src/safety/passive-request-guard.ts`）

- 登録
  - リクエストの段階（`:1244`）: 今までと同じ。開始から1秒。
  - 応答の段階（`:1078-1079`）: 3xx で `Location` を持つ場合に限り、登録し直す。受けた時点から1秒（`REDIRECT_PREDECESSOR_RETENTION_MS`）。
- 消去
  - 使われたとき（`take`、`:1163`）
  - 応答を受けたとき（`:1028`）
  - Guard がリクエストの段階で失敗させたとき（`:1268`）
  - page か Context が閉じたとき（`:1317`、`:1000`）
  - 期限が切れたとき（`#purge`）
- 件数の上限は、既存の `MAX_REDIRECT_PREDECESSORS`（64）のまま。
  - 応答の段階で上限を超えた場合も、`REDIRECT_PREDECESSOR_LIMIT_REACHED` の違反にし、リクエストを失敗させ、Context を閉じる。
- Document 以外のリクエスト: CDP の Fetch は Document だけを横取りする。subresource は `context.route` で判定し、対応付けを使わない。影響はない。
- `expectedCdpFailures` の期限（1秒）は、変えなくてよい。
  - 登録するのは、Guard 自身が `failRequest` を送る直前である。
  - 使われるまでの時間は、Chromium の中の処理の時間だけで、サーバの応答の時間に左右されない。

## 実装者の判断と、設計者の判断

1. リクエストの段階の登録（開始から1秒）を残し、3xx の応答で登録し直す方式にした。→ 承認する。応答の段階を通らないリダイレクト（Chromium の内部のリダイレクトなど）が、偽の違反にならないためである。
2. 登録し直す条件は、「3xx で `Location` を持つ」にした。`Location` のない 3xx は、完了として登録を消す。→ 承認する。
3. `REDIRECT_PREDECESSOR_RETENTION_MS` は、Guard のファイルの中に置いた。→ 承認する。Guard の内部の定数で、既存の `MAX_REDIRECT_PREDECESSORS` と同じ置き方である。
4. 共通部品台帳への追記。→ 不要とする。Guard の内部の仕組みで、ほかから使う部品ではない。
5. `git diff --stat` には、ほかのサブタスクの変更も含まれる。→ 了解した。

## 残りの推測

- 応答の段階を見られない Document のリダイレクト（HSTS の Internal Redirect など）は、リクエストの段階の登録で対応付ける。すぐに起きるので問題にならないと考えるが、実際のブラウザでは確かめていない。→ RC18b で確かめられる範囲で確かめる。
