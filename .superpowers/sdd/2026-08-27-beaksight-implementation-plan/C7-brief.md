# C7 指示書: performance・network・console・axe の修正

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## サブタスク

- ID: C7
- 目的: レビュー指摘 V6、V9（この4つのcollector）、V10、V11、V12 を修正する。
- 設計書: `doc/design/2026-09-23-beaksight-foundation-corrections-design.md` の 5.7、5.8（この4つのcollectorの分）、5.9（V10、V11、V12）
- 実装計画: `doc/design/2026-09-23-beaksight-foundation-corrections-implementation-plan.md` の C7
- レビュー記録（指摘の詳細と再現条件）: `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/` の `task-06-10-review-2026-09-23.md`（V6、V9〜V12）
- 共通部品: `doc/design/beaksight-shared-components.md`、`src/core/`（F01 で新設した deadline・errors・guards・immutable・text・limits）

同時に、ほかの実装者が別の範囲の修正（C1: 設定・クロール、C2: 安全まわり、C4: スクロールと収集位置）を行っています。担当範囲の外のファイルは変更しないでください。

## 変更してよいファイル

- `src/evidence/performance-collector.ts`
- `src/evidence/network-collector.ts`
- `src/evidence/console-collector.ts`
- `src/evidence/accessibility-collector.ts`
- `src/core/limits.ts`（件数・長さの上限の追加だけ）
- テスト: `tests/component/performance-collector.test.ts`、`tests/integration/performance-evidence.test.ts`、`tests/component/network-collector.test.ts`、`tests/integration/technical-evidence.test.ts`、`tests/integration/layout-accessibility.test.ts`（accessibility の部分だけ）、および新規のテストファイル
- `fixtures/site/` への新しいページの追加

## 修正する内容

- **V6**（設計書 5.7）: `resourceSummaries` は、観測できなかった場合に 0 ではなく「未観測」を表す値にする。`performance.setResourceTimingBufferSize` でバッファを広げ（上限値は `src/core/limits.ts` に定義）、`resourcetimingbufferfull` が起きた場合は切り捨ての事実を記録して `COMPLETE` にしない。Timing-Allow-Origin がなく転送量が 0 と報告される別Originの資源は、合計に 0 として入れず、「転送量が不明」として件数を分けて記録する。再現条件: PARTIAL でも全カテゴリが `count:0`。300件の stylesheet を読むページでも250件で `COMPLETE`。
- **V9**（5.8）: console、pageerror、request、response の件数と、本文・stack・URL の長さに上限を設ける（`src/core/limits.ts`）。この4つのcollectorで上限により切り捨てた場合は、切り捨てた件数か印を Evidence に残す。
- **V10**（5.9）: Network Evidence に、メインフレームのリクエストか、ナビゲーションのリクエストかの印を加える。レスポンスの転送量（取得できる場合）を加える。
- **V11**（5.9）: axe の `incomplete` を `violations` とは別の項目として記録する。axe の実行に期限を付ける（`src/core/deadline.ts`）。`failureSummary` などの文字列の長さに上限を設ける。
- **V12**（5.9）: web-vitals の `rating` を保存しない。

## 受け入れ条件

- 上の各項目について、修正前に RED になるテストを先に書き、修正後に GREEN になる。レビュー記録の「実測」の条件を、テストの入力に使う。
- 担当範囲の既存のテストと、`npm run typecheck` が PASS する。
- 変更した Evidence の形を、報告に一覧で示す（C8 で型を整えるときに使う）。

## 報告

共通ルールの形式で報告してください。各項目（例: R1、V2）ごとに、RED・GREEN の結果を示してください。

## 追加の指示（F02a の報告を受けて）

- `src/evidence/console-collector.ts:56-61` は、pageerror の `error.name`・`message`・`stack` を上限なしで記録している。V9 の一部として、上限を設ける。
- performance-collector が header のエラー文を 512（`MAX_TEXT_LENGTH`）で切り詰めている箇所は、network と同じく `MAX_ERROR_MESSAGE_LENGTH`（2048）にそろえる。エラー文の上限は、collector によって変えない。

## 追加の指示（テストファイルの競合を避けるため）

- `tests/integration/layout-accessibility.test.ts` は、同時に作業している C4 も変更する。accessibility の新しいテストは、このファイルに追加せず、新しいファイル（例: `tests/integration/accessibility-evidence.test.ts`）に書く。既存の accessibility のテストが修正で失敗する場合も、`layout-accessibility.test.ts` は変更せず、止まって報告する。
- テスト補助は `tests/helpers/`（`createTestConfig`、`useHeadlessChromium`、`closePassiveResources`、`createDeferred`）を使う。
