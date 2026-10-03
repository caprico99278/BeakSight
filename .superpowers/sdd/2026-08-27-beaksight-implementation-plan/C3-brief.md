# C3 指示書: Task 11 の修正（Interaction）

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## サブタスク

- ID: C3
- 目的: Task 11 のレビュー指摘 I2・I3、Q1、Q2、M1、M2、Q4、Q6 を修正し、discover-candidates の可視判定を統一する。
- 設計書: `doc/design/2026-09-23-beaksight-foundation-corrections-design.md` の 4.2〜4.6、4.8、5.5（discover-candidates の分）
- 実装計画: `doc/design/2026-09-23-beaksight-foundation-corrections-implementation-plan.md` の C3
- レビュー記録（指摘の詳細と再現条件）: 作業記録置き場（`.superpowers/sdd/2026-08-27-beaksight-implementation-plan/`）の `task-11-review-2026-09-23-spec.md`、`task-11-review-2026-09-23-quality.md`
- 共通部品: `doc/design/beaksight-shared-components.md`、`src/core/`（deadline・errors・guards・immutable・text・limits）、`src/evidence/visibility.ts`
- これまでの修正の報告: 作業記録置き場の `F01-report.md`、`F02a-report.md`、`F02b-report.md`、`F02c-report.md`、および `C2-report.md`（C2 で `session.close()` の意味と Safety Ledger が変わっている）

同時に、ほかの実装者が C5（dom・color・layout の collector）を修正しています。担当範囲の外のファイルは変更しないでください。

## 変更してよいファイル

- `src/interaction/isolated-auditor.ts`
- `src/interaction/discover-candidates.ts`
- `src/evidence/interaction-collector.ts`
- `src/safety/interaction-policy.ts`
- `src/safety/safety-ledger.ts`（設計書 4.6 の記録の種類の追加だけ）
- テスト: `tests/integration/isolated-interaction.test.ts`、`tests/unit/interaction-policy.test.ts`、`tests/unit/safety-ledger.test.ts`、および新規のテストファイル
- `fixtures/site/` への新しいページの追加

## 修正する内容

- **I2**（設計書 4.2）: クリーンアップの自動再試行と期限の現在の実装が、設計書 4.2 の記述と一致しているかを確かめる。一致しない点があれば、設計書 4.2 に合わせる。`finalizeInteractionOutcome` の `NON_TERMINAL` の分岐が到達しないことを確かめたうえで削除する。`NON_TERMINAL` が公開の型の値として使われていて、型から除くと `src/**` のほかのファイルに影響する場合は、止まって報告する。
- **I3**（4.2）: 作業記録 `task-11-cleanup-deadline-interaction-dom-budget-brief.md` の「Mandatory behavioral RED」の1〜7の各振る舞いについて、それを確かめるテストが `tests/integration/isolated-interaction.test.ts` にあるかを確かめる。テスト名と行番号の対応表を報告に書く。ないものは、テストを追加する（今の実装で PASS するなら、そのことを報告する。当時の RED は取り戻せないので、ここでは RED を求めない）。
- **Q1**（4.3）: 作業フェーズのすべてのブラウザ内評価（`page.evaluate`、`evaluateHandle`、`handle.evaluate`、`getProperties`、`jsonValue`）を、`effectiveDeadlineAtMs` までの期限付きで待つ（`src/core/deadline.ts` の `awaitBeforeDeadline`）。期限を過ぎたら、その候補を `NOT_VERIFIABLE`（理由は期限切れ）としてクリーンアップに進む。期限切れで放置した Promise が後で reject しても、unhandledRejection にならないようにする。再現条件: `setTimeout(()=>{while(true){}})` を仕込んだページで、`auditInteraction` が止まったままになる。注意: 無限ループでブラウザのメインスレッドが止まっている場合、クリーンアップの close も遅れることがある。その場合も、設計書 4.2 の期限で `InteractionOwnerCleanupError` になるなど、プロセスが止まり続けないことを確かめる。
- **Q1 補足**（4.3）: 可視判定の置き換え（下の 5.5）で style の正規表現による検査がなくなる場合は、style の長さの上限は不要になる。残る場合は、style 文字列を `INTERACTION_CANDIDATE_LIMITS.maxAttributeLength` までに切り詰めてから検査する。
- **5.5**: `discover-candidates.ts` の可視判定（`:421` 付近と `:699` 付近の2か所）を、`element.checkVisibility(VISIBILITY_CHECK_OPTIONS)` に置き換える。オプションは `src/evidence/visibility.ts` の値を `evaluate` の引数として渡す。DOM作業量の数え方（祖先1つあたりの消費）は、`checkVisibility` を1回呼ぶごとに1とするなど、上限の管理が崩れない形にする。設計書 5.5 の3つの場合（`body{opacity:0}`、`visibility:hidden` の祖先を持つ `visibility:visible` の子、`display:none` の祖先）でテストする。
- **Q2**（4.4）: 変化の検出で比べる `boundingBox` を、ページ座標（ビューポート座標にスクロール量を足したもの）で記録する。画面外にある無反応ボタンが VERIFIED にならないことの回帰テストを追加する。再現条件: y が 2008 から 289 に変わり、`changedFields=['boundingBox']` で VERIFIED になる。
- **M1**（4.5）: discovery の completeness に `TEXT_NODE_LIMIT_REACHED` を加え、テキストのノード上限に達したことを、DOM作業量の上限と区別する。auditor は、それに対応する理由を記録する。これを固定している既存のテスト（`isolated-interaction.test.ts:290`、`664-707` 付近）は、新しい区別に合わせて直す（設計書 4.5 に明記した是正）。
- **M2**（4.6）: Safety Ledger に、機械的に除外した Interaction 候補を記録する種類を加える（候補ID、除外理由）。`SUBMISSION_CONTROL`、`RESET_CONTROL`、`FORM_ASSOCIATED`、同一Originの `NAVIGATION_HREF` はそこに記録する。`blockedExternalActions` には、外部への作用（外部Origin、`tel:`、`mailto:`、ダウンロードなど）だけを記録する。
- **Q4**（4.8）: `isolated-interaction.test.ts:3564`、`3578` 付近の判定枠から、実ブラウザのセッション生成時間を除く。`:3672` 付近は、`INTERACTION_OWNER_CLOSE_TIMED_OUT` の記録を確かめる形にし、期限切れと reject の順序を区別する。
- **Q6**（4.8）: テストの不要な `as unknown as`（`:3506`、`:3853-3866` 付近）を除く。`discover-candidates.ts:834` 付近は、`boundingBox` が null の場合も、上限付きのメッセージで拒否する。

## 受け入れ条件

- 上の各項目について、修正前に RED になるテストを先に書き、修正後に GREEN になる。レビュー記録の「実測」の条件を、テストの入力に使う。
- 担当範囲の既存のテストと、`npm run typecheck` が PASS する。
- `tests/integration/isolated-interaction.test.ts`、`tests/integration/passive-request-guard.test.ts`、`tests/component/context-factory.test.ts`、`tests/unit/interaction-policy.test.ts`、`tests/unit/safety-ledger.test.ts` がすべて PASS する。
- DOM作業量のテストの所要時間を報告する（品質レビューでは、1件あたり約8秒だった）。

## 報告

共通ルールの形式で報告してください。各項目（例: Q1、V4）ごとに、RED と GREEN の結果を示してください。

## 追加の指示（C2 の報告を受けて）

- C2 で、Safety Ledger の `BlockedDownloadEvent.reason` が `'PASSIVE_DOWNLOAD' | 'INTERACTION_FROZEN'` になった。`src/interaction/isolated-auditor.ts:187` 付近の `hasFreezeEvent` は、`blockedDownloads.length > 0` で判定しているため、Interaction session の Passive フェーズ（ページの読み込み中）のダウンロードでも、候補が `BLOCKED_BY_SAFETY` になる。freeze の後のイベント（`reason === 'INTERACTION_FROZEN'`）だけで判定するように直す。Passive フェーズのダウンロードは、Ledger に記録されていれば足りる。テストで確かめる。
- C2 で `session.close()` の意味が変わり（invalidation を経た終端では reject する）、Safety Ledger に `recordLimits` と違反の別の上限が加わった。詳細は作業記録置き場の `C2-report.md` を読むこと。
