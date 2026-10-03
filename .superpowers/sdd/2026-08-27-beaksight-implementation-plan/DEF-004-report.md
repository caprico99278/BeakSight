# DEF-004 実装報告（要約。設計者が保存）

## 結論

完了した。

- 許可した読み取り（GET と HEAD）のメインフレームのナビゲーションが、閉じた一覧に載るネットワークの層の失敗で終わった場合は、Guard の違反として記録しない。Context も無効にしない。
- 一覧にない失敗は、これまでどおり違反とする。例えば、`ERR_FAILED` と `ERR_ABORTED` である。
- 関係する12ファイル・1144件のテストと、`npm run typecheck` は PASS した。

## 変更

- 新規: `src/safety/network-layer-failure.ts`
  - `NETWORK_LAYER_FAILURE_CODES`（完全一致で照合する14個）
  - `NETWORK_LAYER_FAILURE_CODE_PREFIXES`（`net::ERR_SSL_`、`net::ERR_CERT_`）
  - `isNetworkLayerFailure(errorText)`
    - 接頭辞の後ろには、英大文字、数字、`_` が1文字以上続く必要がある。
    - 接頭辞だけのものや、後ろに別の文字列が続くものは、一覧に載っていないと判定する（fail-closed）。
- `src/safety/passive-request-guard.ts`: 条件を1つ加えた（差分は7行）。
  - 加えたのは、ALLOW・ナビゲーション・メインフレームの条件がそろうブロックの中である。
  - `isReadMethod && isNetworkLayerFailure` が成り立つ場合は、違反にせずに戻る。
  - 既存の `ERR_ABORTED` の例外と、`boundedCorrelationRequest` が null の場合の違反は、変えていない。
- 設計者が承認したとおりに、既存のテスト9件を書き換えた。
  - 3785行目のテストは、期待値を修正後の振る舞いに変えた。確かめる項目は、2つから4つに増えた。
  - ほかのテストは、きっかけのコードを `ERR_FAILED` に変えただけである。期待値は、そのままである。
- 実ブラウザで、次のことを確かめた。
  - 接続拒否と、名前解決の失敗（`.invalid`）では、違反にならず、Guard は有効なまま、次のナビゲーションが通る。
  - `route.abort('failed')` の `ERR_FAILED` は、違反になり、Page が閉じる。

## 設計者の判断

- 閉じた一覧と、各コードを入れた理由を、承認する。
- 判断に迷うもの（`ERR_HTTP2_PROTOCOL_ERROR` など）を一覧に入れなかったことを、承認する。
- Guard の安全の性質の独立レビュー（RDEF4）を行う。
