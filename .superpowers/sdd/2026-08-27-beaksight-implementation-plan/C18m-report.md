# C18m 実装報告（CC-032: Guard の付いた Passive の page を開いて閉じる処理の、残りの複製）

## 結論
完了。「開く → 1つの処理 → 閉じる」の形の箇所を、8ファイルで `withGuardedPassivePage` に置き換えた（71件のテストと、`isolated-interaction` の補助関数 `discover` 1つ）。形の違う箇所は置き換えず、一覧にした。15ファイルの PASS の件数とテストの名前は、前と後で同じ。`npm run typecheck` は PASS。

## 変更したファイル
| パス | 変更の内容 |
|---|---|
| `tests/integration/slow-redirect.test.ts` | 2件 |
| `tests/integration/accessibility-evidence.test.ts` | 1件。`afterEach` はサーバを閉じる処理だけにした |
| `tests/integration/accessibility-guard-safety.test.ts` | 1件。`factory.getSafetyLedger(context)` を補助の `ledger` に替えた（同じオブジェクト） |
| `tests/integration/technical-evidence.test.ts` | 2件。`server` をテストの中の変数 `fixtureServer` に替えた（同じ値） |
| `tests/integration/screenshot-collector.test.ts` | `createFixturePage` を `withFixturePage` に替え、7件 |
| `tests/integration/layout-evidence-scale.test.ts` | `openFixture` を `withFixture` に替え、9件 |
| `tests/integration/layout-accessibility.test.ts` | `withFixture` と `DEFAULT_FIXTURE_VIEWPORT`（元の既定と同じ `400x300`）を加え、40件。下の4件のために `openFixture` と `afterEach` を残した |
| `tests/integration/isolated-interaction.test.ts` | `discover` と、候補の探索のテスト9件 |

`tests/helpers/`、`src/`、C18o の担当のファイルは変えていない。

## 前と後の比べ方（実装者）
- 15ファイルを `--reporter=json` で実行: 前 661件 PASS、後 661件 PASS（失敗 0）。
- 「ファイル | 名前 | 結果」の一覧を前と後で diff し、差はなかった。
- `isolated-interaction` 以外の変えたファイルで、`expect(` の数が HEAD と同じことを数えた（例: `layout-accessibility` 199 → 199）。
- 比べた結果のファイル: scratchpad の `c18m/`。

## 置き換えなかった箇所
- `layout-accessibility` の4件: 1つのテストで page を順に開き直す。
- `controlled-scroll` の13件: 途中で page を閉じてから Ledger を確かめる。`afterEach` が `forceCloseContextOnFailure: true` で閉じる。
- `page-navigation` の10件: DEF-005 のため、わざと page を閉じずに Context だけを閉じる。閉じる処理の結果と時間を確かめるものもある。
- `performance-evidence` の4件: page を作る前に、非同期の準備（`collector.installBeforeNavigation(context)`）がある。
- `page-auditor`、`page-auditor-interaction`、`site-metadata`、`stress-session`: Context を製品の部品が開いて閉じており、テストは開く処理と閉じる処理そのものを試している。

## 発見事項（実装者）
1. `isolated-interaction` の探索のテストは、前は `factory.closePassiveContext(context)` だけで閉じ、閉じる処理の失敗でテストも失敗した。今は `closePassiveResources` を使い、Context を閉じる処理の失敗は無視する。一方、page を作る処理が失敗しても Context が残らなくなった。
2. 閉じる時点が `afterEach` からテストの本体に移った（期限はどちらも30秒）。
3. 補助の形を変えれば置き換えられる箇所がある（`prepare` を非同期にする、`forceCloseContextOnFailure` を渡せるようにする、順に開き直すテストで補助を続けて呼ぶ）。

## 設計者の判断（2026-09-25）
1. 受け入れる。探索のテストは閉じる処理を確かめるためのものではない。閉じる処理は、専用のテスト（`passive-session-close` など）で確かめている。page の作成の失敗で Context が残らなくなる利点もある。
2. 受け入れる（実質の違いはない）。
3. 採らない。非同期の準備と、Context を必ず閉じる指定は、それぞれ別の目的の形であり、共通の補助に入れると補助が複雑になる。残りは「形が違うもの」として、置き換えの対象にしない。CC-032 は、これで完了とする。

## 設計者の verify（2026-09-25。C18n・C18o・C18m の後）

- `npm run verify`: 終了コード 0。98ファイル、3,629件 PASS。ビルド PASS。
