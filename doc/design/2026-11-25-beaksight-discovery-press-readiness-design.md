# BeakSight 操作さがしの「押す前の準備の確かめ」の打ち切りを減らす（PREADY）

- 日付: 2026-11-25
- 状態: ユーザーの指示（2026-11-25「押す前の待ちの打ち切りも合わせて直して」）。直し方は調査の結果から設計者が選んだ。
- 根拠: 調査担当の実験（指示書 `PREADY-investigation-brief.md`。127.0.0.1 の自前のサーバ・本物の `executeDiscoveryRun`・窓は本番の 5 秒・各 3 回）
- 拡張する文書: DEF-295・DEF-299（準備の確かめ）、DEF-289（押し直し）、REV-DQWF、DBG-1・DTIME

## 1. 原因（実験で確かめた事実）
- 準備の確かめ（`pressReadinessOf`、hover の trial）の窓は 5,000 ms（`readyCheckMsOf`）。実 Run の 25.6 分は、ほぼ打ち切り 295 回 × 5 秒。
- 待たずに分かるのに 5 秒待つ物: 大きさ 0 の要素（見えるかの読み取りが `checkVisibility` だけで大きさを見ない）、動き続ける radio（送信ボタンと違い、動きを読まない）。
- 打ち切りが押下より多くなる経路:
  - A: 済まなかった対象を、同じ文書で押下が 1 つ進むたびに確かめ直す（上限なし。済まない対象 k × 段の数だけ 5 秒）。
  - B: hover の名残の規則（REV-DQWF Minor-1）が、済まなかった対象そのものを読み込み直しに回す（読み込み直し 1 回と 5 秒がもう 1 回）。
  - form のない範囲に動く radio が 1 つあると、範囲のすべての送信ボタンの押下が、その radio で 5 秒ずつ打ち切られる（実験 f5: 6 回・25 秒・押下 0）。
- 無効のボタンは原因でない（約 50 ms で済む）。

## 2. 決めたこと（調査の案 1 → 案 2。窓の長さは変えない。新しい秒の値を足さない）

### 2.1 待たずに分かる物は待たない（案 1）
- 押す前の見えるかの読み取り（`readSubmitterVisibilityInPage`・`splitByVisibility`・`elementVisibleOf`・欄の radio の見えるか）を、大きさも見る `StandardReaders.isVisible` に揃える（共通の部品を使う。写しを作らない）。
- radio の動き続けるかを、送信ボタンと同じ 2 フレームの矩形の比べ（`submitterMovingOf` の部品）で読み、動けば hover を呼ばずに `TARGET_NOT_STABLE`。form のない範囲では、動く radio は触らない欄にして、送信ボタンは押す（入れる欄が減るだけ。凍結・押す時点の確かめ・削除の判定は変えない）。
- hit-test が「中心が画面の外」で `UNKNOWN` のときも、`reachTargetOf` で 1 回置き直してから判定する。

### 2.2 同じ対象を同じ理由で何度も確かめない（案 2）
- 文書ごとに「要素＋理由」の済まなかった記録を持つ。確かめ直すのは、安い読み取り（見えるか・矩形・hit-test・`isDisabled`）の事実が前と変わったときだけ。
- 名残の規則（REV-DQWF Minor-1）は、済まなかった対象そのものを読み込み直しに回さない。

### 2.3 測りの記録（DBG-1）
- 点 `DISCOVERY_READINESS` を閉じた一覧に足す。1 回の確かめごとに 1 行。`part` は `<結果>:<役割>:<道>:<hit>`（結果 `READY`・`COVERED_BY_OTHER`・`TARGET_NOT_VISIBLE`・`TARGET_NOT_STABLE`・`NO_FACT`、役割 `SUBMITTER`・`RADIO`・`OPTION`、道 `PRESS`・`REPLAY`・`RELOAD`・`SURVEY`、hit `REACHABLE`・`OFFSCREEN`・`NO_SIZE`・`UNKNOWN`）。`counts` は `{ ms, attempt }`。
- 文の事実がないときは `TARGET_NOT_STABLE` に混ぜず `NO_FACT` と記録する（成果物の理由の値は今のまま）。
- 選択肢の確かめの打ち切りは、時間と同じ区分（`INPUT_CHECKS`）で数え、区分のずれをなくす。
- URL・値を書かない。成果物の `timeBreakdown` の形は変えない。
- 使われない行（`READINESS_FACTS` の `'element is not enabled'`）は消す。

## 3. 受け入れ
- 調査の場面 b2・b3・c2・f3・f4・f5・g1 を fixture にして、打ち切りが b2・b3・c2・f3・f4・g1 で 0、f5 で 1 以下（押下は 0 → 5）。f3・g1 の読み込み直し 0。
- 止まる・消える物（1〜2 秒後にアニメーションが止まる・幕が消える）は、事実が変わったときに確かめ直して押す（取りこぼさない）。
- サーバに届く読み取りでない要求 0 は変わらない。
- 測りの入のとき `DISCOVERY_READINESS` の行が書かれ、URL・値が入らない。切のとき何もしない。
- tsc（root と `apps/local-ui`）0。関係する単体・architecture。ブラウザの結合は、変えた所を import するものだけを 1 本ずつ。

## 4. 速さと負荷
- 押下の回数は増えうる（f5 のように今まで押せなかった送信ボタンが押せる）。読み込み直しは減る。見込み: 実 Run の打ち切り 24.6 分の大半（推測。次の実 Run の `DISCOVERY_READINESS` で確かめる）。

## 設計変更履歴
- 2026-11-25 新規。
