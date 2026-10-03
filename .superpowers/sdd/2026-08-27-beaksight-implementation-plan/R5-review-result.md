# R5 F15 の確認のレビューの結果（2026-09-23）

総合判定: 修正が必要（Critical 0 / Important 3 / Minor 3）

## 前回の指摘の解消

- R''' の I-1、I-2、M-3 は解消した。
- 次の部品は VERIFIED になることを確かめた。
  - タブ（`aria-selected` を使うもの、class を切り替えるもの）
  - `aria-expanded` を使うハンバーガーメニュー
  - class を切り替えるトグル
  - `aria-pressed` を使うボタン
  - `aria-controls` のあるモーダル
- hover で始まる GET・POST の扱い、fail-closed、安全の判定の順序も確かめた。

## 新しい指摘と、設計者の判断

- **N-1 / Important**: click と関係なく、対象自身の属性が変わると VERIFIED になる。確かめた例は次のとおり。
  - タイマーで class を切り替えるもの
  - rAF で style を変え続けるもの
  - hover intent の150ms後に class を付けるもの
  - transition の終わりに class を付けるもの
- **N-3 / Important**: focus や pointerdown だけで付く class（cdk-focused、data-focused、ripple）でも、何もしないボタンが VERIFIED になる。
- **設計者の判断（N-1・N-3）**: 設計書 4.4.1 に、次の2つの確認を加える。F16 で実装する。
  - **安定性の確認**: 凍結の前の下準備で、hover と focus をしたうえで、落ち着くのを待つ。その後の一定の時間、観測を続け、その間に変わった項目は「不安定」として根拠から外す。
  - **持続の確認**: click の後の変化は、観測の最後まで続いている場合だけ根拠にする。
  - タイマーの周期がこの時間より長い場合は、防ぎきれない。これは 4.4.4 に、制約として書く。
- **N-2 / Important**: `<details><summary>` が NOT_VERIFIABLE になる。
  - 設計者の判断: 対象が `summary` のときは、親の `details` の `open` を、開閉の状態として記録し、根拠にする。GATE-A07 の中核なので、F16 で直し、テストを加える。
- **N-4 / Minor**: hover で文字が変わるボタンが、凍結の後の探し直しで見つからなくなる。
  - 設計者の判断: F16 で、hover の後の同じ要素の状態を、凍結の後の探し直しの目印にする。
- **N-5 / Minor**: どの属性が変わったかが、Evidence から分からない。また、対象の外の要素を切り替える部品の制約が、設計書に書かれていない。
  - 設計者の判断: 変わった属性の名前を、上限を付けて Evidence に残す（F16）。制約は 4.4.4 に書く。
- **N-6 / Minor**: 珍しい形のエスケープ、双方向の制御文字、サロゲートペアの片方が、理由に残る。
  - 設計者の判断: F16 で直す。

## 再実行の記録

- `isolated-interaction` を2回続けて実行し、2回とも244件が PASS した。
- ほかの3ファイル、185件が PASS した。
- typecheck が PASS した。
- テストとは別に、実際の Chromium で約40通りを確かめた。
