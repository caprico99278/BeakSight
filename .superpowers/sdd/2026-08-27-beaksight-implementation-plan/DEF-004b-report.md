# DEF-004b 実装報告（要約。設計者が保存）

## 結論

完了した。DEF-004 の条件に、`!isFrozenPhase(guardState.phase)` を加えた。

- 凍結中は、一覧に載るネットワークの層の失敗でも、これまでどおり違反とする。Context も無効にする。
- 凍結の前（Passive）の同じ失敗は、違反にしない。
- Guard のテスト146件と、関連する3ファイル・494件が PASS した。`npm run typecheck` も PASS した。
- 新しいテストを5回続けて実行し、5回とも PASS した。

## 発見事項と、設計者の判断

- Chromium は、再利用した keep-alive の接続が切れると、GET を1回だけ自動で送り直す。そのため、テストのサーバに、`Connection: close` を付けて扱った。
  - 判断: 受け入れる。テストのサーバの扱いで、Guard のコードには関係ない。
