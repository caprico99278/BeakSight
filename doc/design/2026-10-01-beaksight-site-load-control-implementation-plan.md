# BeakSight 監査対象のサイトへの負荷の制御 実装計画

設計書: `doc/design/2026-10-01-beaksight-site-load-control-design.md`
目標: ページの読み込みの間隔、Interaction の候補の上限、待ち時間を除いた期限、Run 全体のキャッシュと届け方、負荷の記録と表示を作り、監査対象のサイトに短時間に大量の要求を送らないようにする。
作業記録置き場: `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/`

## 全体の制約

- 実装者は Git の commit・push をしない。HEAD に戻す操作（checkout、restore、reset、stash、switch など）も禁止。表示だけの `git status`・`git diff`・`git log`・`git blame`・`git show` は使ってよい。
- 依存パッケージの追加・更新をしない。実在の外部のサイト（本来の監査対象のサイトを含む）にアクセスしない。`local/` と `artifacts/` の中を読まない。検証はローカルの fixture（`fixtures/`、`127.0.0.1` のサーバ）で行う。
- `src/**` は target に依存しない形に保つ。
- テストの Chromium は headless だけで起動する。
- 同じファイルに触れるサブタスクは、並行で行わない。L2・L3・L5b は `page-auditor.ts` に触れるので、順に行う。
- テストを削除・弱体化・skip にしない。期限、Interaction、幅の走査、Guard の既存のテストは、変更の後も PASS させる。
- 共通部品台帳（`doc/design/beaksight-shared-components.md`）の部品と同じ意味の処理を、新しく書かない。

## サブタスク一覧

| ID | 内容 | 依存 | 状態 |
| --- | --- | --- | --- |
| L1 | 設定の2項目（型、既定値、検証、スキーマ、テストの補助、README の設定の表） | なし | 未着手 |
| L2 | `NavigationPacer` と、Passive・robots/sitemap・幅の走査・Interaction での待ちと、期限の延長 | L1 | 未着手 |
| L3 | Interaction の候補の上限（理由 `limit`） | L2 | 未着手 |
| L4 | `LoadMeter` と `run.json` の `load` | L2 | 未着手 |
| L5a | `ResourceCache` と `ResourceDelivery`（単体。判断の部品だけ） | L1 | 未着手 |
| L5b | Guard への届け方の注入、Context の役割、factory の配線、結合テスト | L3、L4、L5a | 未着手 |
| L6 | 負荷の記録の表示（表示用モデル、HTML、CLI、`summary.json`）と README の方針・制約の説明 | L5b | 未着手 |
| L7 | 実行中の進み具合と負荷の表示（設計書 4.8） | L5b、L6 | 未着手 |
| RL | 独立レビュー（読み取り専用） | L7 | 未着手 |

L5a は、ほかのサブタスクとファイルが重ならないので、L2〜L4 と並行で行ってよい。

## L1: 設定の2項目

**変更するファイル**
- 変更: `src/core/evidence-types.ts`（`EffectiveAuditConfig.crawl` に `minNavigationIntervalMs`、`maxInteractionsPerPage`）
- 変更: `src/config/defaults.ts`（5000、20）
- 変更: `src/config/validate-config.ts`（設計書 4.2 の検証。ループバックの判定はこのファイルの中に置く）
- 変更: `schemas/run.schema.json`（`effectiveConfig.crawl` の2項目を必須にする）
- 変更: `tests/helpers/test-config.ts`（`minNavigationIntervalMs` を 0 にする）
- 変更: CLI を別のプロセスで動かすテストが書く設定（例: `tests/integration/fixture-full-crawl.test.ts`）に、`minNavigationIntervalMs: 0` を加える
- 変更: `README.md` の設定の表
- テスト: `tests/unit/config.test.ts`、`tests/unit/schema-validator.test.ts` ほか、設定を組み立てているテスト

**手順**
1. RED: 既定値、下限（ループバックだけなら 0 を受け付け、非ループバックで 999 を拒み 1000 を受け付ける）、`maxInteractionsPerPage` の範囲（0 と 101 を拒み、1 と 100 を受け付ける）、スキーマのテストを書き、失敗を見る。
2. 最小実装。
3. GREEN。`npm run typecheck`。
4. 関連する検証: 設定を使う結合テストの代表（`tests/integration/page-auditor.test.ts`、`tests/integration/fixture-full-crawl.test.ts`）が、間隔 0 で今までどおり PASS する。

## L2: `NavigationPacer` と待ち・期限の延長

**変更するファイル**
- 新規: `src/crawl/navigation-pacer.ts`（設計書 4.1 の入出力。`initial` を含む）
- 変更: `src/orchestration/run-coordinator.ts`（Run の初めに1つ作り、PageAuditor と robots/sitemap の取得に渡す）
- 変更: `src/orchestration/page-auditor.ts`（Passive の初めの待ち、幅の走査の前後の期限の延長、Interaction の候補の前の待ちと段階の期限の延長、1件目の開始の時刻のずらし）
- 変更: `src/evidence/layout-collector.ts`（`collectStressLayout` に `beforeNavigation` を渡せるようにし、待った分だけ自分の期限を延ばす）
- 変更: `src/crawl/site-metadata.ts`（各ファイルの前の待ち）
- テスト: `tests/unit/navigation-pacer.test.ts`（新規）、`tests/integration/page-auditor.test.ts`、`tests/integration/crawl-run.test.ts` など

**手順**
1. RED（単体）: 設計書 第7章の `NavigationPacer` のテスト。
2. 最小実装（単体）→ GREEN。
3. RED（結合）: 間隔（200ms を設定し、fixture のサーバが受け取った文書の要求の時刻の間隔が 200ms 以上）。注入した待ち（期限より長い）で、Passive、幅の走査、1件目の候補が期限切れにならないこと。
4. 最小実装 → GREEN。
5. 関連する検証: 期限と Interaction と幅の走査と robots/sitemap の既存のテスト（`tests/integration/page-auditor.test.ts`、`tests/integration/page-auditor-interaction.test.ts`、`tests/integration/isolated-interaction.test.ts`、`tests/integration/stress-session.test.ts`、`tests/integration/layout-*.test.ts`、`tests/integration/site-metadata.test.ts`、`tests/integration/crawl-run.test.ts`、`tests/unit/run-coordinator.test.ts`、`tests/unit/stage-deadline.test.ts`）、Gate のテスト。

**守ること**
- 待ちは `beforeNavigation()` の呼び出しだけで行う。ほかの場所で `setTimeout` などで待たない。
- `environment.ts` の `about:blank` には待ちを入れない。
- 期限の計算の場所（`#interactionCandidateDeadline` など）を増やさない。延長は、既存の計算に渡す値を変える形で行う。

## L3: Interaction の候補の上限

**変更するファイル**
- 変更: `src/orchestration/page-auditor.ts`（`INTERACTION_STOP_REASONS` に `limit`。確かめる順は safety、limit、budget）
- 変更: `src/presentation/messages.ts`（`limit` の説明）
- テスト: `tests/integration/page-auditor.test.ts` または Interaction の結合テスト。候補の多い fixture（既存の `fixtures/site/candidate-overflow.html` などが使えるか確かめ、なければ新規）

**手順**
1. RED: 上限（テストでは小さい値、例: 2）を超える候補のページで、2件だけ監査し、`interaction:limit:remaining=<件数>` で PARTIAL になる。上限以下なら理由が付かない。
2. 最小実装 → GREEN。
3. 関連する検証: UI Gate（`tests/architecture/ui-ssot.test.ts`）、Interaction の結合テスト。

## L4: `LoadMeter` と `run.json` の `load`

**変更するファイル**
- 新規: `src/crawl/load-meter.ts`（設計書 4.5。状態の取り出しと作り直しを含む）
- 変更: `src/browser/context-factory.ts`（すべての Context の `requestfinished`・`requestfailed` を meter に渡す。Guard には触れない）
- 変更: `src/orchestration/run-coordinator.ts`（meter を作って factory に渡し、Run の結果に `load` を入れる）
- 変更: `src/core/evidence-types.ts` または `src/core/contracts.ts`（Run の結果の型に `load`）
- 変更: `schemas/run.schema.json`（`load`）
- テスト: `tests/unit/load-meter.test.ts`（新規）、結合テスト（fixture のサーバの受け取った数との比較）

**手順**
1. RED（単体）: 許可 Origin とそれ以外に分けて数える、`ERR_BLOCKED_BY_CLIENT` を数えない、キャッシュから返した印の付いた要求を数えない、1分あたりの最大、状態の取り出しと作り直し。
2. 最小実装 → GREEN。
3. RED（結合）: fixture の Run の `load` の数が、サーバが受け取った数と一致する（またはブラウザのキャッシュの分だけ多い）。スキーマに合う。
4. 最小実装 → GREEN。ブラウザのキャッシュから返した要求の事象が来るかを確かめ、報告に書く。

## L5a: `ResourceCache` と `ResourceDelivery`（判断の部品）

**変更するファイル**
- 新規: `src/browser/resource-delivery.ts`（設計書 4.6 の入れる条件、持つもの、LRU の上限。4.7 の届け方の表の判断。Playwright の Route を操作する処理は L5b で書く。ここでは、要求と応答の事実から判断を返す部品と、キャッシュの部品を作る）
- 変更: `src/safety/request-policy.ts`（非公開の `hasAllowedOrigin` を export するだけ。L4 の `LoadMeter` も使う）
- テスト: `tests/unit/resource-delivery.test.ts`（新規）

**手順**
1. RED: 入れる条件（種類、status、`Range`、`no-store`、5MB）、header の除外、LRU（合計の上限）、届け方の3つの場合（キャッシュから返す、送らない、ネットワーク）、文書の要求は判断の対象にしない。
2. 最小実装 → GREEN。

## L5b: Guard への届け方の注入と配線

**変更するファイル**
- 変更: `src/safety/passive-request-guard.ts`（設計書 4.7 の Guard の変更だけ。許可の判定、凍結、BLOCK の扱いは変えない）
- 変更: `src/browser/context-factory.ts`（Context の役割 `PRIMARY` と `REVISIT`。`response` の事象をキャッシュに渡す。`REVISIT` の Context の Guard に届け方の部品を渡す）
- 変更: `src/orchestration/stress-session.ts`、Interaction の session を作る箇所（`REVISIT` を選ぶ）
- 変更: `src/orchestration/run-coordinator.ts`（キャッシュを Run の初めに作る）
- 変更: `fixtures/`（2つ目の Origin の画像とスクリプトを読むページ。必要なら fixture のサーバの機能）
- テスト: 結合テスト（設計書 第7章の「キャッシュと届け方」「安全」）、Guard の既存のテスト、Safety Gate

**手順**
1. RED: 主の読み込みで取った画像とスクリプトを、幅の走査と Interaction の Context で、サーバが再び受け取らない。2つ目の Origin の画像とスクリプトが、読み込み直しの Context からはサーバに届かない。文書の要求は届く。凍結の後の要求は、キャッシュにあっても止められ Safety の記録に残る。主の Context ではキャッシュから返さない。
2. 最小実装 → GREEN。
3. 関連する検証: `tests/integration/safety-gates.test.ts`、`tests/integration/auditor-gates.test.ts`、`tests/integration/passive-request-guard.test.ts`、`tests/integration/oopif-guard.test.ts`、`tests/integration/isolated-interaction.test.ts`、`tests/architecture`。

**守ること**
- 届け方の部品に渡すのは、`PASSIVE_ACTIVE` で ALLOW の、ナビゲーションでない要求だけ。
- 「キャッシュから返す」と「送らない」の前に `expectedRouteFailures` に登録する。
- 部品の例外と `route.fulfill` の失敗を Guard の外に投げない。
- 送らなかった要求を Ledger に入れない。

## L6: 負荷の記録の表示と README

**変更するファイル**
- 変更: 表示用モデル（`src/report/view-model.ts`）、`src/report/html-report.ts`、`src/cli/` の結果の表示、`src/report/chatgpt-bundle.ts`（`summary.json`）、`src/presentation/messages.ts`
- 変更: `README.md`（負荷の方針、既定値、制約、full audit での `maxPages` と `maxRuntimeMs` の選び方）
- テスト: 表示の単体テスト、`tests/architecture/ui-ssot.test.ts`

**手順**
1. RED: 表示用モデルに `load` が1回だけ組み立てられ、HTML の要約の「サイトへの負荷」、CLI の1行、`summary.json` に同じ値が出る。
2. 最小実装 → GREEN。
3. 関連する検証: UI Gate、`npm run verify`。

## L7: 実行中の進み具合と負荷の表示

**変更するファイル**
- 変更: `src/core/contracts.ts`（進み具合の事実の型）、`src/crawl/load-meter.ts`（直近60秒の件数を返す関数）、`src/orchestration/run-coordinator.ts`（ページの後に受け手に渡す）、`src/cli/run-command.ts` か `src/cli/output.ts`（1行を出す）、`src/presentation/messages.ts`
- テスト: `tests/unit/load-meter.test.ts`、`tests/unit/run-coordinator.test.ts`、`tests/unit/cli.test.ts`、`tests/integration/cli.test.ts`

**手順**
1. RED: ページが終わるたびに受け手が呼ばれ、事実の値が正しい。受け手の例外で Run が止まらない。CLI の行の文言と書式。直近60秒の件数。
2. 最小実装 → GREEN。
3. 関連する検証: UI Gate、`tests/integration/cli.test.ts`、`tests/integration/fixture-full-crawl.test.ts`。

## RL: 独立レビュー

- 読み取り専用のレビュー担当に、設計書と L1〜L6 の報告を渡す。とくに、Guard の変更（L5b）で安全の性質が保たれること、期限の延長で既存の期限の性質（1件目の候補が予算に収まる、など）が保たれること、負荷の上限が設計どおり守られることを確かめる。
- Critical 0件、Important 0件で完了とする。
