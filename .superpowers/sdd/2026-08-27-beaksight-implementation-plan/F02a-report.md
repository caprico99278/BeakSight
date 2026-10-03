# F02a 実装報告（要約。設計者が保存）

## 結論

完了。担当11ファイルのうち7ファイルで、重複していた実装を共通部品に置き換えた。console、accessibility、dom、screenshot の4ファイルには、置き換える対象がなかった。

- 振る舞いが変わったのは、network-collector のエラーの文字列化だけである。その変化を確かめるテストを追加し、RED と GREEN を確認した。
- `src/core/guards.ts` に `isNonNegativeFiniteNumber` を追加した。
- 既存のテスト221件は、置き換えの前後とも PASS した。
- 関連する12ファイル・232件、unit と component の全体（25ファイル・312件）、typecheck が PASS した。

## 置き換えなかった主な箇所

- performance-collector の `DEADLINE` シンボル。Promise を待つ処理ではなく、同期処理の目印として使われているため。
- 成功時の結果を組み立てる関数。結果の形と成功を表す語が、場所ごとに違うため。
- ブラウザ内で実行する処理に書かれた上限値。
- `limits.ts` に同じ意味の値がないもの。
- 2^53 を超える整数を受け付けている検査。置き換えると、それらを拒否するように振る舞いが変わるため。

## 発見事項と、設計者の判断

1. network のエラーの文字列化で、Error 以外のオブジェクトの記録内容も変わる。→ 設計書 3.2 の範囲内として許容する。
2. `console-collector.ts:56-61` は、pageerror を上限なしで記録している。→ C7（設計書 5.8）で扱う。
3. performance の header のエラー文の上限（512）と、network の上限（2048）が違う。→ C7 で、エラー文の上限を `MAX_ERROR_MESSAGE_LENGTH` にそろえる。
