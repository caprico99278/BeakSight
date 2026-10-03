# C18k 実装報告（CC-031 残りのテスト補助の重複）

## 結論
完了。CC-031 に挙がった重複を、`tests/helpers/` の補助を使う形に置き換えた。`report-generation.test.ts` の launcher は、いつも headless で起動する `createRunLauncher` に替えた。置き換えの前後で、各ファイルの PASS の件数は同じ。`npm run typecheck` は PASS。

## 変更したファイル
| パス | 変更の内容 |
|---|---|
| `tests/helpers/gate-harness.ts` | 補助を追加: `QUIET_PERIOD_MS`、`withGuardedPassivePage`、`FACTORY_MODES`、`FactoryMode`、`createModeFactories`、`factoryModeCases`。既存の補助は変えていない |
| `tests/helpers/external-scheme-fixture.ts` | 先頭のコメントだけを直した |
| `tests/integration/report-generation.test.ts` | 要求された headless の値をそのまま渡していた launcher と Run Coordinator の組み立てを、`createRunLauncher` と `runWithCoordinator` に置き換えた |
| `tests/integration/environment.test.ts` | `browserWithHangingNewContext` を `browserHangingNewContext` に置き換えた |
| `tests/component/discover-links.test.ts` | `chromium.launch()` を `launchHeadlessChromium()` に置き換えた |
| `tests/unit/cli.test.ts` | ローカルの `capture` を `captureCliOutput` に置き換えた |
| `tests/integration/safety-gates.test.ts` | `QUIET_PERIOD_MS`、`MODES`（2か所）と isolated の factory、Guard の付いた page の処理（`openGuardedPassivePage` の中身と3か所）を共通化 |
| `tests/integration/external-scheme-navigation.test.ts` | `QUIET_PERIOD_MS`、`FACTORY_MODES`、Guard の付いた page の処理（9か所）を共通化 |
| `tests/integration/oopif-guard.test.ts` | `QUIET_PERIOD_MS`、`FACTORY_MODES`、ローカルの `withGuardedPage` を共通化。`vi.restoreAllMocks()` を `afterEach` に移した |
| `tests/integration/gate-fixtures.test.ts` | Guard の付いた page の処理（1か所）を置き換えた |
| `fixtures/server.ts` | 外部スキームの宛先の値を `EXTERNAL_SCHEME_TARGETS` から作る形にした。76行目のコメントを直した |
| `tests/unit/external-scheme-fixture.test.ts`（新規） | fixture の HTML にある宛先の値の複製が `EXTERNAL_SCHEME_TARGETS` と同じであることを確かめる（3件。違う一覧では一致しないこと、一覧が見つからない場合は例外になることも確かめる） |

`src/`、`isolated-interaction.test.ts`、`fixtures/site/*.html` は変更していない。

## 置き換えの前後の件数
| ファイル | 前 | 後 |
|---|---|---|
| `tests/unit/cli.test.ts` | 32 | 32 |
| `tests/integration/report-generation.test.ts` | 5 | 5 |
| `tests/integration/environment.test.ts` | 12 | 12 |
| `tests/component/discover-links.test.ts` | 13 | 13 |
| `tests/integration/safety-gates.test.ts` | 85 | 85 |
| `tests/integration/external-scheme-navigation.test.ts` | 71 | 71 |
| `tests/integration/oopif-guard.test.ts` | 25 | 25 |
| `tests/integration/gate-fixtures.test.ts` | 41 | 41 |
| `tests/unit/external-scheme-fixture.test.ts`（新規） | なし | 3 |
| `tests/integration/fixture-server.test.ts`（参考） | 取っていない | 27 |

- テストの名前の違いは、`safety-gates` の9件の題名の表記だけ（`headed injected into a headless browser` → `headed (injected)`）。
- 置き換えの前の実行の途中で4つのファイル（`cli`、`report-generation`、`environment`、`discover-links`）の編集を始めたため、この4つは編集の後の中身で実行された可能性がある。ケースは変えていないので、件数と名前は同じ。

## fixture の宛先の値
- `fixtures/server.ts`: 1か所にできた。
- fixture の HTML: 1か所にできない（ブラウザの中のスクリプトは TypeScript の値を import できない。別のスクリプトで読ませるとリクエストが増え、Gate が数えるリクエストの一覧が変わる）。代わりに、単体テストで一致を確かめる。

## 実装者が設計者に確認を求めた点
1. `fixtures/server.ts` が `tests/helpers/external-scheme-fixture.ts` を import する向きでよいか。
2. 題名の表記を `headed (injected)` にそろえたため、`Passive (headed (injected))` のように括弧が重なる。
3. `oopif-guard` の Mock の戻し方を `afterEach` に移した。
4. 共通部品台帳の `gate-harness.ts` の行に、今回の補助を足す必要がある。

## 実装者の発見事項
- `tests/integration/slow-redirect.test.ts:26` に `QUIET_PERIOD_MS = 300` が残っている（範囲の外）。
- Guard の付いた Passive の page を開いて閉じる形は、範囲の外にも残っている（`slow-redirect`、`isolated-interaction`、`page-auditor`、`page-auditor-interaction`、`layout-*`、`component/context-factory` など）。
- headed の注入の設定を個別に書いている箇所が残っている（`passive-request-guard.test.ts:27`、`crawl-run.test.ts:454`、`page-auditor.test.ts:1484`）。

## 未実行項目（実装者）
- `npm run verify` と `npm run build`（指示により実行していない）。
- `fixtures/server.ts` を使うほかの統合テスト（`slow-redirect`、`auditor-gates` など）。

## 設計者の確認（2026-09-25）
- 変更の範囲: `git status` と `git diff --stat` で、指示の範囲に収まっていることを確かめた。
- headed の起動: `tests/` の中で、要求された値を Chromium にそのまま渡す起動はなくなった。`preflight.test.ts:156` の launcher は、起動せずに例外を投げる模造なので対象外。
- 全体の verify: C18e の完了の後に、設計者が実行する（下に追記する）。

## 設計者の verify（2026-09-25。C18e・C18k・C18k-fix-round-1 の後）

- `npm run verify`: 終了コード 0。型チェック PASS。98ファイル、3,523件が PASS（失敗 0）。ビルド PASS。テストの所要時間は 328秒。
