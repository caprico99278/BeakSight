# T19b 修正の回 1 の指示書: RT19 の指摘への対応

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。T19b の指示書（`T19b-brief.md`）の「厳守事項」と「クラウドの環境での追補」も、そのまま有効です。

## サブタスク

- ID: T19b 修正の回 1
- 目的: 独立の確認（RT19）の指摘 I-1、M-1〜M-7 に合わせて、`README.md` を直す。
- 指摘の本文: 作業記録置き場の `RT19-review.md`。各指摘に、README の行、食い違うコードの ファイル:行、直し方の案があります。
- 前の報告: `T19b-report.md`

## 作業

1. `RT19-review.md` を読み、指摘ごとに、書かれたコードの行を自分で開いて、指摘が正しいかを確かめる。
2. 正しい指摘は、`README.md` を直す。直し方の案は目安です。文は日本語の書き方の指針（`.claude/skills/beaksight-dev/references/japanese-writing-guide.md`）に従って整える。
   - I-1: headless でも、新しいウィンドウ（`window.open` など）で外部スキームを開こうとした場合は、違反（`FRAME_CLASSIFICATION_FAILED`）になり、Run が `ABORTED_BY_SAFETY` になることを書く。headless を勧めることは変えない。
   - M-1: ChatGPT 用のバンドルに、Finding の日本語の文言と、ページの可視テキストと URL が入ることを書く。アップロードの前に、扱ってよい内容かを確かめるよう案内する。
   - M-2〜M-7: 指摘のとおり、事実を正確にする。
3. 指摘が正しくないと判断した場合は、直さずに、理由（コードの ファイル:行）を報告に書く。
4. 直した後、README の中の URL が例の値（`https://example.com/` など）だけであることを確かめる。

## 変えてよいファイル

- `README.md` だけ。

## 確かめ方

- ブラウザを起動するコマンドは実行しない。
- 直した箇所の出どころ（ファイル:行）を、指摘ごとに報告に書く。

## 受け入れ条件

- I-1、M-1〜M-7 のそれぞれについて、直したか、直さなかった理由が報告にある。
- `README.md` のほかの部分を変えていない（指摘に関係しない書き換えをしない）。

## 報告

共通ルールの形式で、日本語で報告し、`T19b-fix-round-1-report.md` に保存してください。
