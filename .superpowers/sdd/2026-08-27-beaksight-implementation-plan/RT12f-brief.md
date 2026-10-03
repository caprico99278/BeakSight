# RT12f 指示書: 1行の箱の見切れの誤検知と、見えない子孫・画面の外の子孫の扱い

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## サブタスク

- ID: RT12f
- 目的: 確認のレビュー RT12r2 の I1・M1・M2 を直す。
- 設計書: `doc/design/2026-09-23-beaksight-task-12-13-rules-design.md` の 5.1.2（RT12r2 を受けて加えた箇所）
- レビューの結果: 作業記録置き場の `RT12r2-review-result.md`
- 共通部品台帳: `doc/design/beaksight-shared-components.md`（可視性の判定 `VISIBILITY_CHECK_OPTIONS`）

これまでの変更は、作業ツリーにそのまま残っています。HEAD に戻す操作は禁止です。

このサブタスクは単独で実行します。

## 変更してよいファイル

- `src/evidence/layout-collector.ts`
- テスト: `tests/integration/layout-accessibility.test.ts`、`tests/component/layout-collector.test.ts`（必要な場合に限る）
- `fixtures/site/` の layout の fixture への追記と、新しいページの追加

## 修正する内容

1. **I1 上下を別々に比べる**
   - 縦方向では、行の矩形が箱の上に出た量と下に出た量を、別々に、その行の高さの4分の1と比べる。どちらかが超えれば、「またぐ」とする。
   - 横方向も同じように、左と右を別々に、2 px と比べる。
   - fixture とテストで、次のことを確かめる。
     - 1行の `h2`（`overflow:hidden`、`font-size:32px`、行の高さ 1.0 と 1.1）で、Finding ができない。修正前に RED、修正後に GREEN になること。
       - フォントは、`font-family` に `Meiryo, "Noto Sans JP", "Segoe UI", sans-serif` を指定する。
       - テストの前提として、実際に使われたフォントで、上下の出た量の合計が行の高さの4分の1を超えていることを確かめる。こうしないと、RED が偶然に左右される。
       - 前提を満たすフォントがこの環境にない場合は、止まって報告する。
     - 見出しの横に線を引く形（`overflow:hidden` と `::after`）でも、Finding ができない。
     - これまでの fixture の結果は、変わらない。
2. **M1 見えない子孫のテキスト**
   - 行の矩形を集めるときに、次の2つを判定に使わない。
     - 見えない要素の中のテキスト（`visibility:hidden`、`opacity:0` など）
     - 見えない要素そのもの
   - 見えるかどうかは、`src/core/visibility.ts` の `VISIBILITY_CHECK_OPTIONS` と同じ設定の `checkVisibility` で決める。ブラウザの中の関数には、引数で渡す。同じ設定を、別に書かない。
   - fixture とテストで、次のことを確かめる。
     - `opacity:0` の、背の高いスライドを重ねた箱で、Finding ができない。
     - 見えるテキストが本当に切れている箱では、Finding ができる。
3. **M2 画面の外の子孫**
   - `hasRenderedDescendant` の判定で、次の子孫を数えない。
     - 文書の左か上の外に、丸ごと置かれた子孫（文書の座標で、右端か下端が 0 以下のもの）
   - fixture とテストで、次のことを確かめる。
     - `position:absolute; left:-9999px` のテキストだけを持つ、大きさ0のリンクで、Finding ができる。修正前に RED、修正後に GREEN になること。
     - float の画像や absolute のアイコンを持つリンクでは、引き続き Finding ができない。

## 受け入れ条件

- 各項目で、修正前に RED、修正後に GREEN になる。
- 既存のテストは、すべて PASS する。
- 規模のテストが、目安（1秒）に収まる。所要時間を報告する。
- `npm run typecheck` が PASS する。
- `npm run verify` が PASS する。このサブタスクでは build を実行してよい。

## 報告

共通ルールの形式で、日本語で報告してください。
