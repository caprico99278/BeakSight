# BeakSight DEF-029 応答を受けた後の main frame の読み込みの失敗 設計書

- 状態: 設計者の判断（2026-10-05）。実装の後に独立レビューを受ける。
- 関係する文書: 不具合台帳の DEF-029、DEF-027、DEF-004。Task 19 の前の整理の設計書（RC18a、C18g）。サイトが応答しないときに Run を止める設計書（`2026-10-05-beaksight-site-unavailability-stop-design.md`）。

## 1. 目的

### 1.1 起きること

- DEF-027 の調査（ローカルのサーバ）で、次の main frame の読み込みが、Guard の違反（`HTTP_MAIN_FRAME_DELIVERY_FAILED`）になり、Run が ABORTED_BY_SAFETY で止まると分かった。
  - 本文が空の 4xx・5xx の応答: `net::ERR_HTTP_RESPONSE_CODE_FAILURE`（Chromium は、本文のない失敗の応答を描かずに、読み込みを失敗にする）。空の 503 で起き、本文が空の 404 の robots.txt では、Run が開始直後に止まった。
  - 401 Basic: `net::ERR_INVALID_AUTH_CREDENTIALS`（認証の情報がないので、Chromium が読み込みを失敗にする）。
  - 本文の途中の切断: `net::ERR_CONTENT_LENGTH_MISMATCH`。
- Guard の `onRequestFailed`（`src/safety/passive-request-guard.ts`）は、許可した main frame の読み取りの失敗を、閉じる途中の `net::ERR_ABORTED`、ネットワークの層の失敗（DEF-004 の閉じた一覧）、Guard 自身が止めた予期した失敗のほかは、違反にする。上の3つは、どれにも当たらない。

### 1.2 解決すること

- メンテナンス中のサイトが、本文の空の 503 を返しても、違反で止めずに、サイトの不調として止める（再開できる）。
- robots.txt が本文の空の 404 のサイトでも、Run を始められる。
- 安全の不変条件は弱めない（2章）。

## 2. 決めたこと

### 2.1 本文の途中の切断を、ネットワークの層の失敗に加える

- `NETWORK_LAYER_FAILURE_CODES`（`src/safety/network-layer-failure.ts`）の「応答」の組に、`net::ERR_CONTENT_LENGTH_MISMATCH` と `net::ERR_INCOMPLETE_CHUNKED_ENCODING`（chunked の本文の途中の切断。同じ意味）を加える。
- 理由: どちらも、サーバか経路が、本文の途中で接続を切った失敗である。Guard の中断や配送の取りこぼしを示さない（DEF-004 の一覧の基準に合う）。
- 影響: Guard は、凍結の前の許可した読み取りなら、違反にしない（DEF-004 の扱い）。サイトの不調の判定（`siteUnavailabilityOf`）は、ネットワークの層の失敗として、不調とみなす。

### 2.2 応答を受けた後の失敗の閉じた一覧を作る

- 同じファイルに、応答（ヘッダ）を受けた後に、Chromium が読み込みを失敗にする理由の閉じた一覧を加える（例: `RESPONSE_RECEIVED_FAILURE_CODES = ['net::ERR_HTTP_RESPONSE_CODE_FAILURE', 'net::ERR_INVALID_AUTH_CREDENTIALS']`、判定は `isResponseReceivedFailure(errorText)`。完全一致）。
- Guard の `onRequestFailed` は、次のすべてに当たる場合だけ、違反にしない:
  1. 許可した（`classifyPassiveRequest` が `ALLOW`）、main frame のナビゲーションの要求である。
  2. 読み取りの method（`isReadMethod`）である。
  3. 凍結の段階でない（DEF-004b と同じ。凍結中は違反のまま）。
  4. 失敗の理由が、2.2 の一覧に完全一致する。
  5. その要求の応答（Playwright の `request.response()`）があり、HTTP の status が 400〜599 である。応答がない、取り出しが失敗する、status が範囲の外の場合は、違反のまま（fail-closed）。
- 理由: 応答のヘッダを受けているので、要求はサーバに届き、サーバが失敗の status で答えた（配送は確か）。ダウンロードへの切り替わり（`net::ERR_ABORTED`）、外部スキームへの 3xx（`net::ERR_ABORTED`）、Guard の中断（`net::ERR_BLOCKED_BY_CLIENT`）は、理由が違うので、この扱いに入らない。
- 違反にしない場合も、読み込みは失敗のまま残る（`navigatePage` は `FAILED`、robots.txt と sitemap.xml は `FAILED`）。

### 2.3 やらないこと

- `net::ERR_ABORTED` の扱い（DEF-027）は変えない。
- robots.txt と sitemap.xml の取得で、2.2 の失敗のときに、応答の status から `NOT_FOUND` を導くこと（今は `FAILED`）。サイトの不調の機能の SU3 で、観測の status を使うときに扱う。
- Passive のビューポートの結果の `httpStatus`（失敗のときは `null`）は変えない。

## 3. SSOT と安全性への影響

| 項目 | owner | 扱い |
| --- | --- | --- |
| ネットワークの層の失敗の閉じた一覧 | `src/safety/network-layer-failure.ts` | 2つの理由を加える |
| 応答を受けた後の失敗の閉じた一覧 | `src/safety/network-layer-failure.ts` | 新設（共通部品台帳に加える） |
| main frame の失敗を違反にするか | `src/safety/passive-request-guard.ts`（`onRequestFailed`） | 2.2 の条件の分岐を加える |

- 安全の不変条件: 弱めない。違反にしないのは、許可した読み取りで、サーバの応答のヘッダを受けたことを確かめた場合だけである。GET と HEAD 以外、凍結中、許可しない要求、応答のない失敗は、今までどおり違反にする。

## 4. テスト設計

- 単体: 一覧の値と凍結。`isResponseReceivedFailure` の完全一致（前後に文字がある、大文字小文字が違うものは当たらない）。`isNetworkLayerFailure` に、加えた2つが当たる。
- 結合（実際の Chromium、Guard の付いた Context、127.0.0.1 のサーバ）:
  - 本文が空の 503 と 404 の main frame の読み込み: 読み込みは失敗するが、違反は0件。サーバは GET を1回受ける。
  - 401 Basic（`WWW-Authenticate: Basic`、本文あり・なし）: 違反は0件。
  - `Content-Length` より短い本文で接続を切る、chunked の本文の途中で切る: 違反は0件。
  - 対照（違反のまま）: 凍結の段階での同じ失敗。応答のない失敗（接続の後、ヘッダの前に `ERR_ABORTED` になるもの。既存のテスト）。許可しない要求。
  - robots.txt が本文の空の 404 の fixture で、Run Coordinator を通して、Run が始まり、ABORTED_BY_SAFETY にならない（robots.txt の記録は、DEF-029 の時点では `FAILED`。サイトの不調の機能の SU3b の後は、観測した status から `NOT_FOUND`。2.3）。
- 既存の Safety Gate のテストが、変えずに PASS する。

## 5. 設計変更履歴

| 日付 | 契機 | 変更内容 | 影響範囲 |
| --- | --- | --- | --- |
| 2026-10-05 | 初版（DEF-027 の調査で見つかった DEF-029） | - | Guard の `onRequestFailed`、ネットワークの層の失敗の一覧、サイトの不調の判定（加えた2つ） |
| 2026-10-05 | サイトの不調の機能の SU3b（2.3 の「やらないこと」を SU3b で行った） | 応答を受けた後の失敗で、robots.txt と sitemap.xml の記録を観測した status から導くようにした。本文の空の 404 の robots.txt は `NOT_FOUND`。結合テストの期待を、決まりの変更による直しとして直す | `guard-response-received-failures.test.ts` の1件 |
| 2026-10-05 | SUR の指摘 M4 | robots.txt と sitemap.xml の取得が例外で終わった場合、2.2 の失敗に限らず（時間切れを含む）、観測の status が 2xx でなければ、その status の応答として扱う（SU3b の実装の決まり。例: 404 のヘッダの後の時間切れは `NOT_FOUND`、503 の時間切れは `FAILED` で `httpStatus` が 503、失敗の詳細は残らない）。サーバがその status で答えたことは確かなので、妥当とする | なし（記述を実装に合わせた） |
