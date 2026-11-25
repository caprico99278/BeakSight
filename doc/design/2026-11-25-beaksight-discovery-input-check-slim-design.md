# BeakSight 操作さがしの入力の確かめを番号の型でまとめる・測りを足す（SLIM）

- 日付: 2026-11-25
- 状態: ユーザーの指示（2026-11-25「重い画面の内、合理的に短縮できる操作のさがしを洗い出して、探索の高速化・スリム化を進めて」）。直し方は調査の結果から設計者が選んだ。
- 根拠: 調査担当の実験（指示書 `SLIM-investigation-brief.md`。127.0.0.1 の自前のサーバ・本物の `executeDiscoveryRun`・本番の窓・各 3 回）
- 拡張する文書: ISKIP（`2026-11-24-beaksight-discovery-input-check-skip-design.md`）、CALDAY（`2026-11-25-beaksight-discovery-sibling-press-design.md`）、PREADY（測りの口）、DBG-1・DTIME

## 1. 原因（実験で確かめた事実）
- form の外の文字の欄は、欄ごとに `typeIntoLoneFields` が入れて `waitAfterPress`（最短 2 秒＋落ち着き）を置く。1 欄 2.63 秒。60 欄で約 157 秒。
- select の選択肢は、`surveyOptionChoices` が 1 つずつ選んで落ち着きを待つ。1 つ 0.67 秒。300 で約 200 秒。
- ISKIP の欄の識別は生の name を使うので、`rows[0].name` と `rows[1].name` は別の欄になる。状態の鍵の側（`fieldNameTemplateOf`）はすでに番号を型にしており、食い違っている。
- form の中の欄は長くならない（押下 1 回で入れるだけ）。
- 押した後の最短の待ち 2 秒は、遅れて出る反応（遅れた書き込み・debounce・遅れて開く窓・遅れた検索）を拾っている。短くすると取りこぼす（500 ms で 1.5 秒以上の遅れ、1 ms で 0.8 秒以上の遅れ）。
- 実 Run の 196.6 秒の 1 回が、表の形か多い選択肢の形かは、今の記録では決められない。

## 2. 決めたこと

### 2.1 番号だけ違う欄を 1 つの組にする（調査の案 A・A'）
- 入力の確かめの組の鍵を「場所の鍵（`dataFreePathKeyOf`）＋種類＋`digitTemplateOf(name)`＋型」にする。select はさらに、選択肢の digest の並びが同じことを条件にする。数字を型にする部品は `digitTemplateOf` の 1 か所を使う（写しを作らない）。
- 文書の順で最初の 1 つを確かめる（代表）。残りを確かめないのは、代表に違いが出なかったときだけ:
  - 文字の欄: 代表に入れたとき読み取り（`searchTriggers`）が出なかった。
  - select: 全部の選択肢で状態の鍵が変わらず、読み取りも出なかった。
- 違いが出たら、今どおり全部を確かめる。確かめなかった数を記録に残す（数と閉じた語だけ）。数の上限は置かない。
- 数えるのは今どおり押す輪の 1 か所（`isFirstInputCheck` の所）。

### 2.2 押した後の最短の待ちは変えない
- 2 秒は取りこぼしを防いでいる（実験）。次の実 Run の測り（2.3 の押した後の反応）を見てから決める。

### 2.3 測りを足す（数と閉じた語だけ。URL・名前・入力値を書かない）
- (a) 記録を画面 1 枚ごとに書き出す: `src/worker/discovery-run.ts` の `persist` の先頭で `debugTiming.flush()`（読んだ画面・読まなかった画面の両方が通る 1 か所）。監査の段（`run-coordinator.ts`）も同じ形にする。
- 記録だけ足す口を 1 つにする: `PageTimeRecorder` に 1 つの口、`screen-watch.ts` に `noteOnScreen(page, entry)`。PREADY の `DISCOVERY_READINESS` もこの口に載せ直す（口を 2 つにしない）。
- 点 `DISCOVERY_PRESS_REACTION`: 押下 1 回と、打つだけの欄 1 つごとに 1 行。`part` は `<最初の反応>:<道>:<組>`（反応 `REQUEST`・`DOM`・`NAVIGATION`・`NONE`、道 `PRESS`・`TYPE`・`REPLAY`、組 `REPRESENTATIVE`・`SIBLING`・`SINGLE`）。`counts` は `{ firstMs, requestMs?, domMs?, navigationMs?, minimumMs, windowMs, siblings }`。測るのは `waitAfterPress` の中、窓の間だけ（要求と移動は page の事象、DOM は isolated world の MutationObserver の最初の時刻を窓の終わりに 1 回読む）。
- 点 `DISCOVERY_INPUT_CHECK`: `INPUT_CHECKS` の 1 回ごとに 1 行。`part` は `TYPE`・`SURVEY`・`CHOOSE`。`counts` は `{ fields, checked, skippedEarlier, skippedSibling, fills, options, chosen, unchanged, triggers }`。
- 点は `debug-timing.ts` の閉じた一覧に足す。切のときは何もしない。

### 2.4 今回しないこと
- 番号だけ違う選択肢をまとめる案（調査の案 B）は、次の実 Run の `DISCOVERY_INPUT_CHECK` で 196 秒の画面の形を確かめてから決める。数で打ち切る案は採らない。

## 3. 受け入れ
- 調査の場面（20 行 × 3 欄の form の外の表、20 行 × (文字 1 欄＋select 5 択)、名前の違う 60 欄、form の中の表）を fixture にして:
  - 表の形: 入力の確かめが 3 欄分（行 1 つ分）だけ。select も行 1 つ分だけ。
  - 名前の違う 60 欄: 今どおり 60 欄（まとめない）。
  - 代表に入れると読み取りが出る表: 全部を確かめる。
  - サーバに届く読み取りでない要求 0。
- 測り: 入のとき 3 つの点と画面ごとの書き出しが書かれ、URL・値が入らない。切のとき何もしない。
- CALDAY・PREADY の結合（`discovery-sibling-press`・`discovery-press-readiness`）が通る。
- tsc（root と `apps/local-ui`）0。関係する単体・architecture。ブラウザの結合は、変えた所を import するものだけを 1 本ずつ。

## 4. 速さと負荷
- 入れる回数・選ぶ回数は減るだけ。見込み（推測）: 表の形の画面で 1 回 157 秒 → 約 8 秒。実 Run の 10 秒を超える 8 回（10.6 分）の大半。
- 測りの読み取りは窓の終わりに 1 回だけで、サイトへの要求を増やさない。

## 設計変更履歴
- 2026-11-25 新規。
