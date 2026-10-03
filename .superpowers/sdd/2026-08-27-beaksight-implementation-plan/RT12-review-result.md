# RT12 Task 12・13 の独立レビューの結果（2026-09-24）

総合判定: 修正が必要（Critical 0 / Important 5 / Minor 4）

## 指摘と、設計者の判断

- **I1 `ELEMENT_OUTSIDE_VIEWPORT` の誤検知**
  - 問題: `overflow:hidden` の中のカルーセルや、横にスクロールできる表が、Finding になる。入れ子の要素ごとに、重ねて Finding ができる。
  - 判断: Evidence に次の2つを加える。
    - 横方向に最も近い、切り取る祖先の種類（`horizontalClipAncestor`: `NONE`、`CLIPPED`、`SCROLLABLE`）
    - 一覧の中の、最も近い祖先の番号
  - Rule は、次の3つを守るようにする。
    - `NONE` の要素だけを対象にする。
    - 主要要素（kind が `other` 以外）だけを対象にする。
    - 一覧に祖先がある要素は、報告しない。
  - RT12a で行う。
- **I2 `TEXT_CLIPPING` の誤検知**
  - 問題: テキストでない中身がはみ出しても、見切れと判定される。
  - 判断: Evidence に `partiallyClippedText` を加える。これは、子孫のテキストの行の矩形が、要素の箱の境界をまたいでいるかを表す。Rule は、これが真の場合だけ Finding にする。
    - 箱の外に丸ごと出ているテキスト（カルーセルの隠れたスライドなど）は、またいでいないので対象にならない。
  - RT12a で行う。
- **I3 `ZERO_SIZE_INTERACTIVE_ELEMENT` の誤検知**
  - 問題: float の画像や absolute の子を包むリンクが、Finding になる。
  - 判断: Evidence に `hasRenderedDescendant` を加える。Rule は、これが真の要素を除く。
  - RT12a で行う。
- **I4 `TARGET_NAVIGATION_FAILED` の重複**
  - 問題: 外部の SSO へのリダイレクトで、ERROR になる。同じ事実から、`UNEXPECTED_ORIGIN_REDIRECT` も作られる。
  - 判断: 1つの事実から作る Finding は、1つだけにする。リンク先の `navigationOutcome` に応じて、次のように分ける。
    - `TIMEOUT`: `NAVIGATION_TIMEOUT` だけで扱う。
    - `BLOCKED_EXTERNAL_REDIRECT`: `UNEXPECTED_ORIGIN_REDIRECT` だけで扱う。
    - `FAILED`: `TARGET_NAVIGATION_FAILED` の対象にする。
  - RT12b で行う。
- **I5 technical の Rule のビューポートのテストがない**
  - 判断: 別のビューポートの Evidence から Finding を作らないことを確かめるテストを加える。
  - RT12b で行う。
- **M6 しきい値ちょうどの値のテストがない（layout）**
  - 判断: 加える。RT12a で行う。
- **M7 `DUPLICATE_CANONICAL` の誤検知**
  - 問題: 正常なリダイレクトの後に、自分自身を canonical にしているページでも、WARN になる。
  - 判断: canonical が自分自身かどうかは、最終URLでも比べる。RT12b で行う。
- **M8 下書きの ruleVersion と category を検査していない。`CROSS_PAGE_RULES` を Catalog と同じように検査していない**
  - 判断: 下書きの ruleVersion と category が、Rule の定義と一致するかを検査する。`CROSS_PAGE_RULES` も `freezeCatalog` で検査する。RT12b で行う。
  - fingerprint の衝突は、T12a の承認のとおり受け入れる。
- **M9 スキーマと定数の細部**
  - 判断: 次の2つを行う。RT12b で行う。
    - `finding.schema.json` の `evidenceRefs` に、`minItems: 1` を加える。
    - HTTP のステータスの範囲の定数を、`rule-helpers.ts` の1か所にまとめる。
- **確認できなかった点（sitemap の切り詰め）**
  - 判断: Task 15 で、sitemap を取り込むときに、`SitemapEvidence` に切り詰めの印を加える。切り詰めがある場合は、`DISCOVERED_URL_NOT_IN_SITEMAP` を判定しない。Task 15 の設計に書いた。

## 再実行の記録

- 対象の12ファイルで、393件が PASS した。ほかの2ファイルで、275件が PASS した。typecheck は PASS した。
- 検証用のテストで、誤検知を再現した（layout 9件、Cross-page 2件）。
