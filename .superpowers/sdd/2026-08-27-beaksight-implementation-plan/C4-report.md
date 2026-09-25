# C4 実装報告（要約。設計者が保存）

## 結論

完了。V2 と V3 を、RED を確かめてから GREEN にした。担当範囲の4ファイル（49件）が PASS した。

## 主な変更

- **controlled-scroll**
  - 実際にスクロールする要素（`scrollingElement`、または独自にスクロールする `body`）を特定し、固定して追う。
  - スクロールする要素を特定できない場合は、`PARTIAL / SCROLL_TARGET_UNRESOLVED` を返す。
  - スクロールしても位置が進まない場合と、一度もスクロールしていないのに内容がビューポートより高い場合は、`PARTIAL / SCROLL_NOT_ADVANCED` を返す。
  - 終了時に先頭（0, 0）へ戻し、戻せたかどうかを `restoration` に記録する。
  - 公開した型と関数: `ScrollTarget`、`ScrollPosition`、`ScrollOriginRestoration`、`scrollDocumentToOrigin`。
- **layout と color**
  - 収集した時点のスクロール位置を、`scrollPosition` として記録する。
  - color の標本は、文書全体から取る。固定要素だけは、ビューポートの範囲で扱う。
- **screenshot**
  - 2枚とも、先頭に戻してから撮る。撮影時の位置を `scrollPosition` として記録する。
- **fixture**
  - 4ページを追加した: `body-scroll`、`unscrollable-overflow`、`scroll-locked`、`fixed-header-scroll`。

## 発見事項と、設計者の判断

1. lazy-content の既存テストの意味を、設計書 5.2 に合わせて変えた。→ 承認する。
2. スクロール位置を読み取る式が、ブラウザ内で2か所に書かれている。→ 設計書 3.1 の範囲内として許容する。定義の説明は `ScrollPosition` の1か所にある。
3. 共通部品台帳への登録。→ 設計者が行う。
4. `SCROLL_TARGET_UNRESOLVED` と `SCROLL_NOT_ADVANCED` を、`incompleteReasons` の構造化の対象に含める。layout と screenshot の payload に、スクロール位置を反映する。→ どちらも C8 で扱う。
5. color の判定で、`body{overflow:hidden}` のページでも、ビューポートの外の本文が標本に入るようになった。→ 許容する。
6. html と body の両方が `overflow:hidden` で、内側の div だけがスクロールするページでは、スクロールしないまま COMPLETE になる。これは偽の COMPLETE にあたる。→ C4b で、内側のスクロール領域を検出したら、PARTIAL と理由を返すようにする。
