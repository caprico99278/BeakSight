# DEF-004 指示書: ネットワークの層の失敗で、Guard が安全の不変条件の違反を記録する不具合

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## サブタスク

- ID: DEF-004（既存不具合の修正）
- 不具合台帳: 作業記録置き場の `defects.md` の DEF-004（原因の分析と修正方針がある）
- 前の報告: 作業記録置き場の `R15a-report.md`
- Guard の設計: `doc/design/2026-09-23-beaksight-foundation-corrections-design.md`、`doc/design/2026-08-27-beaksight-implementation-tasks.md` の Safety Invariants

これまでの変更は、作業ツリーにそのまま残っています。HEAD に戻す操作は禁止です。不具合がいつからあったかを確かめるために、HEAD に戻すことも禁止です。

同時に、別の実装者（R15b と R15c）が、`src/crawl/site-metadata.ts`、`src/orchestration/preflight.ts`、`src/orchestration/environment.ts` と、そのテストを作っています。担当のファイル以外は変更しないでください。`npm run verify` は実行しないでください。

Guard は、安全の中核です。変更は最小限にしてください。修正方針に書いた場合以外の振る舞いは、変えないでください。

## 変更してよいファイル

- `src/safety/passive-request-guard.ts`
- 閉じた一覧を置くファイル。`src/safety/` の中の既存のファイルか、新しいファイル。
- テスト: `tests/integration/passive-request-guard.test.ts`、`tests/integration/page-auditor.test.ts`（R15a の接続拒否のテストの、違反の件数の確認を加えることに限る）
- 閉じた一覧の単体テスト（新しいファイルでもよい）

## 修正する内容

1. まず、不具合を再現するテストを書き、RED を確かめる。
   - Guard の付いた Passive Context で、127.0.0.1 の使っていないポートへナビゲーションする。
   - 次のことを確かめる。
     - Ledger に、`HTTP_MAIN_FRAME_DELIVERY_FAILED` の違反が記録されない。
     - Context が無効にならない。
   - Page Auditor のテスト（R15a の接続拒否のテスト）で、次のことを確かめる。
     - `outcome.safety.invariantViolationCount` が 0 である。
     - 閉じる処理の失敗の理由（`UNHANDLED_FAILURE`）が加わらない。
2. ネットワークの層の失敗の閉じた一覧を、1か所に置く。
   - `as const` の配列と、判定の関数にする。
   - 一覧の候補は、Chromium の `net::` のエラーのコードのうち、次のものである。
     - 接続: `ERR_CONNECTION_REFUSED`、`ERR_CONNECTION_RESET`、`ERR_CONNECTION_CLOSED`、`ERR_CONNECTION_ABORTED`、`ERR_CONNECTION_FAILED`、`ERR_CONNECTION_TIMED_OUT`、`ERR_TIMED_OUT`
     - 応答: `ERR_EMPTY_RESPONSE`
     - ネットワークの変化: `ERR_NETWORK_CHANGED`、`ERR_INTERNET_DISCONNECTED`
     - 名前解決と宛先: `ERR_NAME_NOT_RESOLVED`、`ERR_NAME_RESOLUTION_FAILED`、`ERR_ADDRESS_UNREACHABLE`、`ERR_ADDRESS_INVALID`
     - TLS: `ERR_SSL_` で始まるもの、`ERR_CERT_` で始まるもの
   - 一覧に入れないもの:
     - `ERR_ABORTED`、`ERR_FAILED`
     - `ERR_BLOCKED_BY_CLIENT`、`ERR_BLOCKED_BY_RESPONSE`
     - `ERR_UNSAFE_REDIRECT`、`ERR_UNSAFE_PORT`
     - `ERR_INVALID_RESPONSE`、`ERR_INVALID_REDIRECT`
     - そのほか一覧にないもの
   - 一覧の各コードを入れた理由を、報告に書く。判断に迷うものは、一覧に入れない（fail-closed）。
3. `requestfailed` の処理を直す。
   - 違反から外すのは、次の条件をすべて満たす場合だけにする。
     - `classifyPassiveRequest` の結果が ALLOW である。
     - メインフレームのナビゲーションのリクエストである。
     - メソッドが、`isReadMethod` で読み取りと判定される。
     - 失敗の理由が、閉じた一覧に載っている。
   - それ以外の場合は、これまでどおり、違反として記録し、Context を無効にする。例えば、`ERR_ABORTED` の扱いは変えない。
   - `boundedCorrelationRequest` が null の場合（1274行目付近）も、これまでどおり違反とする。
4. テストで、次のことを確かめる。
   - 一覧にあるエラーでは、違反にならない。確かめる例は、次の2つ。
     - 使っていないポート（接続拒否）
     - 存在しない名前（`http://beaksight-nonexistent.invalid/`。名前解決の失敗）
   - 一覧にないエラーは、これまでどおり違反になる。
     - 例: `route.abort('failed')` などで起こした `ERR_FAILED`
     - 既存のテストで確かめられていれば、その名前を報告する。
   - 既存の Guard のテストは、すべて PASS のまま。
   - GET 以外の遮断と、Interaction の凍結の振る舞いが、変わらない。

## 設計者の承認（Blocker の解消。2026-09-24）

- `tests/integration/passive-request-guard.test.ts` の既存のテストのうち、次のテストの書き換えを認めます。どれも、一覧に載るネットワークの失敗（`ERR_CONNECTION_REFUSED`、`ERR_CONNECTION_RESET`）を、違反のきっかけとして使っています。
  - **3785行目付近** `records a failed allowed main-frame delivery as an invariant`
    - この不具合の振る舞いそのものを期待しているので、期待値を、修正後の振る舞いに変えます。
      - 違反は0件
      - Page は閉じない
    - このテストは、再現テストを兼ねます。
    - あわせて、一覧にない `net::ERR_FAILED`（`route.abort('failed')` など）を使う実ブラウザのテストを加えます。このテストでは、これまでどおり違反になり、Page が閉じることを確かめます。
  - **718、865、904、2252、2399、2686行目付近のテスト**
    - きっかけのコードを、一覧にない `net::ERR_FAILED` に変えます。
    - 期待するメッセージも、それに合わせます。
    - これらのテストが確かめたいのは、無効化の順序、所有者、見逃さないことです。エラーのコードそのものではありません。そのため、テストの意図は保たれます。
- 書き換えたテストの一覧と、それぞれの書き換えの内容を、報告に書いてください。
- テストの条件を弱めていないことも、テストごとに書いてください。
- 受け入れ条件の「既存の Guard のテストは、すべて PASS のまま」は、上のとおり書き換えたうえで、すべて PASS することと読み替えます。

## 受け入れ条件

- 修正前に RED、修正後に GREEN になる。
- 既存のテストは、すべて PASS する。
- `npm run typecheck` と、担当のテストが PASS する。
- `npm run verify` は実行しない（並行作業のため）。全体の verify は、設計者が行う。

## 報告

共通ルールの形式で、日本語で報告してください。閉じた一覧と、各コードを入れた理由を書いてください。
