# F13b・F13c 実装報告（要約。設計者が保存）

## 結論

どちらも完了した。

timezone は、次の3つの条件をすべて満たす場合に受け付ける。

- IANA の名前の書き方である（区切りごとに、大文字の英字か数字で始まる）。
- `Intl.DateTimeFormat` が例外を投げない。
- `Intl` が解決した名前と比べたとき、大文字・小文字だけが違う、という関係にない。

## 判定の例

| 値 | 結果 | 理由 |
| --- | --- | --- |
| `Asia/Kolkata`、`Etc/UTC`、`GMT`、`US/Pacific`、`Asia/Tokyo`、`UTC`、`Pacific/Auckland` | 受け付ける | 正式な名前、または別名 |
| `asia/tokyo`、`ASIA/TOKYO`、`Asia/TOKYO` | 拒否する | 大文字・小文字の誤り |
| `+09:00`、`-0530` | 拒否する | オフセットの形 |
| `Not/AZone` | 拒否する | `Intl` が受け付けない |

## 検証

- 各項目で、修正前に RED、修正後に GREEN になることを確かめた。
- unit のテスト（20ファイル・752件）と、typecheck が PASS した。
- 実際の Chromium で、`Asia/Kolkata` と `Etc/UTC` を使って、Context と page を作れることを確かめた（component テスト）。
