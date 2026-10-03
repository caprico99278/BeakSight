# C18k-fix-round-1 実装報告

## 結論
完了。宛先の値を `fixtures/external-scheme-targets.ts` の1か所に移した。`fixtures/` は `tests/` を import しなくなった。`slow-redirect` の `QUIET_PERIOD_MS` は、`gate-harness.ts` からの import に置き換えた。

## 変更したファイル
| パス | 変更の内容 |
|---|---|
| `fixtures/external-scheme-targets.ts`（新規） | `EXTERNAL_SCHEME_TARGETS`、`ExternalSchemeKey`、`EXTERNAL_SCHEME_KEYS` を定義。ほかのファイルを import しない。値、名前、順序は元のまま |
| `fixtures/server.ts` | import 元を `./external-scheme-targets.js` に変え、コメントを直した |
| `tests/helpers/external-scheme-fixture.ts` | 値の定義を消し、`fixtures/external-scheme-targets.js` から import して export し直す |
| `tests/unit/external-scheme-fixture.test.ts` | 先頭のコメントだけを直した |
| `tests/integration/slow-redirect.test.ts` | ローカルの `QUIET_PERIOD_MS` を消し、`gate-harness.js` からの import に替えた |

## 検証（実装者）
- 変更の前と後で、同じ件数が PASS: `external-scheme-fixture` 3件、`fixture-server` 27件、`slow-redirect` 2件、`external-scheme-navigation` 71件（合計103件）。
- `npm run typecheck`: PASS。
- `fixtures/` の import: `tests/` を import する文はない（当たったのはコメントの1行だけ）。
- 値の定義: `fixtures/external-scheme-targets.ts:17-19` だけ。HTML の複製は `external-scheme-navigation.html:13-15` と `external-scheme-button.html:13-15`。

## 発見事項（実装者）
- `fixture-server.test.ts:228-230` などのテストの期待値やデータに、同じ宛先の値が直接書かれている。

## 設計者の確認と判断（2026-09-25）
- `fixtures/*.ts` の import を表示し、`tests/` を import していないことを確かめた。`slow-redirect.test.ts` は `QUIET_PERIOD_MS` を import している。
- 発見事項の扱い: テストの期待値やデータに書かれた値は、定義の複製ではなく、独立した確かめである。定数を誤って変えたときに気づけるように、このまま残す。共通化候補にはしない。
- 全体の verify は、C18e の完了の後に設計者が行う。

## 設計者の verify（2026-09-25。C18e・C18k・C18k-fix-round-1 の後）

- `npm run verify`: 終了コード 0。型チェック PASS。98ファイル、3,523件が PASS（失敗 0）。ビルド PASS。テストの所要時間は 328秒。
