# F02b 指示書: 共通部品への移行（safety・interaction）

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## サブタスク

- ID: F02b
- 目的: F01 で新設した共通部品に、担当範囲の重複した実装を置き換える。振る舞いは変えない（例外は下に明記）。
- 設計書: `doc/design/2026-09-23-beaksight-foundation-corrections-design.md` の第3章（とくに 3.1、3.2）
- 実装計画: `doc/design/2026-09-23-beaksight-foundation-corrections-implementation-plan.md` の F02b
- 共通部品の一覧: `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/F01-report.md`（F01 の実装報告。部品の名前とシグネチャ）と、`src/core/` の実物
- 重複の実例: `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/commonization-candidates.md`

同時に、ほかの実装者が別の範囲の移行（F02a: browser・evidence、F02c: config・core・crawl）を行っています。担当範囲の外のファイルは変更しないでください。

## 変更してよいファイル

- `src/safety/passive-request-guard.ts`
- `src/safety/safety-ledger.ts`
- `src/safety/interaction-policy.ts`
- `src/interaction/isolated-auditor.ts`
- `src/interaction/discover-candidates.ts`
- `src/browser/context-factory.ts`

対応するテストファイルは変更してよいですが、テストの内容（検証していること）は変えないでください。移行によってテストが失敗した場合は、振る舞いが変わったことを意味するので、テストを直すのではなく実装を見直してください。

## 置き換えるもの

- CC-001: `isolated-auditor.ts` の `yieldMacrotask`、手書きのタイムアウト（`awaitInitialRender`、`observeCloseUntil` など）、`passive-request-guard.ts` の `drainGuardTasks` の期限付き待機を、`src/core/deadline.ts` で書けるものは置き換える。**タイミングの意味（期限の起点、マクロタスクを譲る回数、rejection の封じ込め）を変えないこと**。置き換えると意味が変わる箇所は、置き換えずに理由を報告してください。
- CC-002: `isolated-auditor.ts` と `passive-request-guard.ts` の `errorMessage` を `src/core/errors.ts` に置き換える。それぞれの既存の上限（512、2048）を引数で指定し、振る舞いを保つ。代替文言も共通のものにする（文言が変わる場合は、それを確かめているテストがないかを確認し、あれば報告する）。
- CC-003: 数値の述語、Node 側の文字列の切り詰めを置き換える（同じ名前でも `null` を返すものと例外を投げるものがあるので、振る舞いが一致する場合だけ置き換える）。
- CC-006: `discover-candidates.ts` の `sha256:` の書式と、`interaction-policy.ts` のその検証を、`src/core/ids.ts` に置き換える。
- CC-005: `isolated-auditor.ts`、`passive-request-guard.ts`、`discover-candidates.ts`（Node 側の部分だけ）の http/https の判定を `isHttpProtocol` に置き換える。
- CC-007: URLの最大長、エラーメッセージの最大長、HTTPメソッドの最大長を `src/core/limits.ts` に置き換える。

## 置き換えないもの

- ブラウザ内で実行される関数（`page.evaluate`、`evaluateHandle`、`handle.evaluate` などに渡す関数）の中身。これらは import できないため、今回は対象外です（設計書 3.1）。ただし、Node 側で定義した上限値を引数として渡している箇所は、その値を `src/core/limits.ts` から取るように置き換えてください。
- 理由コードや状態の文字列の値（例: `'TIMED_OUT'`、`'SETTLED'`）。値を変えると Evidence の中身が変わるため、今回は変えません。型の定義を `src/core/contracts.ts` の共通の型に置き換えることは、値が同じ場合に限って行ってください。
- 意味が違う上限値（例: Interaction 候補の上限）。

## 受け入れ条件

- 担当範囲に、共通部品と同じ意味の独自実装が残っていない（残した場合は、その理由を報告する）。
- 担当範囲のテストと、`npm run typecheck` が PASS する。
- 振る舞いを変えていない（例外は上に明記したものだけ）。

## RED について

このサブタスクは振る舞いを変えない置き換えなので、原則として新しい RED は不要です。既存のテストが置き換えの前後で PASS することを確かめてください。 Task 11 の範囲のファイルは、非同期処理のタイミングに敏感です。置き換えの後、`tests/integration/isolated-interaction.test.ts`、`tests/integration/passive-request-guard.test.ts`、`tests/component/context-factory.test.ts`、`tests/unit/interaction-policy.test.ts`、`tests/unit/safety-ledger.test.ts` をすべて実行して PASS することを確かめてください。

## 報告

共通ルールの形式で報告してください。「置き換えた箇所」（ファイル・元の実装・置き換え先）と「置き換えなかった箇所とその理由」を一覧にしてください。

## 追加の指示（F01 の報告を受けて）

- `src/core/errors.ts` の `safeErrorMessage` に、省略可能な代替文言の引数を追加してよい（省略時は `ERROR_MESSAGE_FALLBACK`）。`passive-request-guard.ts` では `'Guard error could not be safely normalized'`、`isolated-auditor.ts` では `'Interaction error could not be safely normalized'` を渡し、既存のテスト（`tests/integration/passive-request-guard.test.ts:1289, 1318, 1346, 1399, 2148, 2149`、`tests/integration/isolated-interaction.test.ts:2877, 2966, 3004`）の期待値を変えずに済むようにする。`errors.ts` に対するほかの変更はしない。
- `isolated-auditor.ts` の `errorMessage` は、Error 以外のオブジェクトを `String(error)` で文字列にしていたが、正とする振る舞いに置き換えてよい（設計書 3.2 に追記済みの、許可された振る舞いの変化）。上限 512 は保つ。この変化によって既存のテストが失敗した場合は、そのテストの期待値を新しい振る舞いに合わせてよいが、変更したテストと理由を報告すること。
- `interaction-policy.ts:68` の `interaction-candidate:sha256:` の正規表現は、接頭辞が付くため `isSha256Fingerprint` では置き換えられない。接頭辞を除いた部分の判定に `isSha256Fingerprint` を使える場合だけ置き換える。
