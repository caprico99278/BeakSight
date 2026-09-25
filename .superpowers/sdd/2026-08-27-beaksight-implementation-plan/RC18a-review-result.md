# RC18a レビュー結果（要約。設計者が保存）

## 総合判定

修正が必要。Critical 0件、Important 2件、Minor 2件。

## 問題がなかった点

- 主な経路の検出と記録:
  - 設計書 4.1 の7経路のほか、次の経路も確かめた。
    - `location.replace`、大文字のスキーム、`window.open(_self)`
    - 入れ子の iframe、`srcdoc`、sandbox の iframe、`about:blank` の iframe への代入、`top.location`
    - name で iframe を指す anchor、form の POST、`Refresh` のヘッダ
  - Passive と凍結の後の両方で、frame と段階の記録も正しかった。
- `window.open` と `<a target=_blank>` は、`FRAME_CLASSIFICATION_FAILED` の違反のままだった。
- headed の値の経路と、fail-closed の扱い。
- 誤検知はなかった。確かめたもの: `javascript:`、`data:`、`blob:`、`about:blank`、`chrome-error://`、`view-source:`、`file:`、`chrome://`
- 記録と表示は、一貫していた。

## 指摘と、設計者の判断

1. **Important**: サーバのリダイレクト（3xx）で外部スキームへ移る経路を、検出できない。
   - 例: iframe が許可 Origin の URL を読み、`302 Location: beaksight-test-app:probe` が返る場合。
   - 記録も違反もない（headed の設定でも同じ）。
   - Guard を付けた状態では、外部スキームへの `request` の事象が来ない。そのため、設計書 4.1 の「`request` の事象はどの経路でも来る」は、成り立たない。
   - → **直す（C18g）。リダイレクトを、たどる前に止める。**
     - Guard が、Document のリクエスト（main frame と subframe）の応答の段階で、3xx の `Location` が外部スキームかを調べる。
     - 外部スキームなら、リダイレクトをたどる前に、リクエストを失敗させる。
     - 失敗させた場合は、`externalSchemeNavigations` に記録する（止めたことが分かる形で）。
     - この経路は止めて防げるので、headed でも違反にしない。
     - スクリプトによる移動は、今までどおり止められない経路である。headed で違反にするのは、こちらだけである。
     - 設計書 4.1 と 4.2 を直した。
2. **Important**: headed で違反が起きても、Run は次のページへ進み、同じ危険を繰り返す。
   - 確かめ方: `mailto:` へ移るページ3つのサイトで、headed を注入した。
   - 結果: 違反が6件（3ページ × 2ビューポート）起きた。
   - → **直す（C18f）。違反を検出したら、それ以降の監査を始めない。**
     - 対象は、違反の種類を問わない。どんな違反でも、Run は最後に `ABORTED_BY_SAFETY` になる。
     - 違反の後も監査を続けると、危険を繰り返すだけである。
     - 違反を検出した後は、新しいページ、ビューポート、Interaction の候補を始めない。残りのページは、理由付きの `SKIPPED` にする。
     - 設計書に 4.5 を加えた。
3. **Minor**: main frame が外部スキームへリダイレクトされると、既存の `HTTP_MAIN_FRAME_DELIVERY_FAILED` の違反になる。原因が、記録から読み取れない。
   - → 指摘1の対策（C18g）で、あわせて扱う。
   - Guard が止めた場合は、`externalSchemeNavigations` に記録する。
   - 既存の違反を緩めるかどうかは、C18g の実装者が事実を確かめて報告する。設計者が、その報告を見て決める。
4. **Minor**: GATE-S03 の「サーバには GET だけ」と「URL が変わらない」は、Guard がなくても同じ結果になる。見分けているのは、Ledger の記録の確認だけである。
   - → C18g で、この2つが補助の確認であることを、テストのコメントに書く。

## 確認できなかった点

- 本物の headed の Chrome で、リダイレクトの経路で外部のアプリが起動するかどうか（厳守事項により実行していない）。
- Service Worker からの移動（`serviceWorkers: 'block'` のため試せない）。
