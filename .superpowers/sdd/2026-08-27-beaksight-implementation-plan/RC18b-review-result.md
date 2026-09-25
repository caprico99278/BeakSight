# RC18b レビュー結果（要約。設計者が保存）

## 総合判定

修正が必要。Critical 0件、Important 1件（新しい N1）、Minor 2件。

## RC18a の指摘と DEF-013 の判定

- 指摘1（サーバのリダイレクト）: 一部解消。
  - 次の経路では、止めて記録される。
    - 同じプロセスの iframe、入れ子の iframe
    - main frame（2回続く場合、`#frag` がある場合、1.5秒の場合）
    - 凍結の前に始まり、凍結の後に応答が届いた場合
  - 別のプロセスの iframe（OOPIF）の中の移動は、止まらず、記録もされない（N1）。
- 指摘2（違反の後も監査を続ける）: 解消。
  - headed の設定で Run を3通り行った。どれも、最初の違反の後に、サーバへのリクエストは0件だった。
  - 次のページ、Mobile、次の幅、候補、再試行は、どれも始まらなかった。
- 指摘3（main frame の違反）: 解消。見逃しの経路もない。
- 指摘4（GATE-S03 のコメント）: 解消。
- DEF-013（遅いリダイレクト）: 解消。
  - 1.5秒のリダイレクトが2回続く場合、3秒の場合、OOPIF の遅いリダイレクトで、偽の違反は出なかった。
  - 本当の欠落と、件数の上限は、違反のままである。

## 新しい指摘と、設計者の判断

1. **N1（Important）**: 別のプロセスの iframe（OOPIF）の中の移動では、外部スキームへのリダイレクトを、止めることも記録することもできない。
   - 原因: CDP の session を、page の target だけに作っている（`passive-request-guard.ts:995`、`:1320-1325`）。
   - 完全版の Chromium（headed で使う）は、別のサイトの iframe を、標準で別のプロセスにする。広告の iframe は、この形になる。
   - 標準の `chrome-headless-shell` は、別のプロセスの iframe を作らない。そのため、今の GATE-S03 は、この欠落を検出できない。
   - スクリプトによる移動は、OOPIF の中でも検出される（Playwright の `request` の事象が来るため）。見逃しは、リダイレクトの経路だけである。
   - → **直す（C18i）。**
     - 別のプロセスの iframe にも、CDP の session を付け、同じ横取り（Request と Response の段階）を付ける。
       - 例: Playwright の `browserContext.newCDPSession(frame)`、または `Target.setAutoAttach`
     - session を付けられなかった場合は、fail-closed にする。
     - サイトの分離を無効にする起動の引数（`--disable-site-isolation-trials` など）は、使わない。ブラウザの安全の仕組みを弱めるためである。この方法を採る場合は、設計者の承認が要る。
     - Gate に、`--site-per-process` で起動するテストを加える。
     - 直すまでの間は、設計書 4.2.1 と DEF-012 に、この制約を書く（書いた）。
2. **N2（Minor）**: 幅の走査のセッションの中で違反が起きたときの理由が、`stress-layout:EVALUATION_FAILED` になる。→ C18i で、`stress-layout:SAFETY_VIOLATION_ABORT`（Guard が閉じたことが分かる理由）にする。
3. **N3（Minor）**: ページの中で違反を確かめるのは、ビューポート、幅、候補の前だけである。Context を閉じない種類の違反の後は、同じ Passive の page の収集が続く。→ 設計書 4.5 に、制約として書いた。
   - headed での外部スキームへの移動の違反は、Context を閉じる。そのため、主な危険には当たらない。

## 確認できなかった点

- 本物の headed で、OOPIF のリダイレクトから、外部のアプリが起動するかどうか。
- 応答の段階を通らないリダイレクト（HSTS の Internal Redirect など）の実際の動き。
- PREFLIGHT や環境の段階の違反が、metadata の取得を止めること（コードを読んで確かめただけ）。
