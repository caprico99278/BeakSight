# F02c 指示書: 共通部品への移行（config・core・crawl）

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## サブタスク

- ID: F02c
- 目的: F01 で新設した共通部品に、担当範囲の重複した実装を置き換える。振る舞いは変えない（例外は下に明記）。
- 設計書: `doc/design/2026-09-23-beaksight-foundation-corrections-design.md` の第3章（とくに 3.1、3.2）
- 実装計画: `doc/design/2026-09-23-beaksight-foundation-corrections-implementation-plan.md` の F02c
- 共通部品の一覧: `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/F01-report.md`（F01 の実装報告。部品の名前とシグネチャ）と、`src/core/` の実物
- 重複の実例: `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/commonization-candidates.md`

同時に、ほかの実装者が別の範囲の移行（F02a: browser・evidence、F02b: safety・interaction）を行っています。担当範囲の外のファイルは変更しないでください。

## 変更してよいファイル

- `src/config/load-config.ts`
- `src/config/validate-config.ts`
- `src/core/status.ts`
- `src/core/ids.ts`（既存の `compareCodeUnits` を `src/core/text.ts` の利用に置き換えることだけ）
- `src/crawl/normalize-url.ts`（既存の `compareCodeUnits` を置き換えることと、既存の http/https 判定を `isHttpProtocol` に置き換えることだけ）
- `src/crawl/admission-policy.ts`
- `src/crawl/crawl-queue.ts`
- `src/crawl/discover-links.ts`
- `src/safety/request-policy.ts`
- `src/safety/redact.ts`

対応するテストファイルは変更してよいですが、テストの内容（検証していること）は変えないでください。移行によってテストが失敗した場合は、振る舞いが変わったことを意味するので、テストを直すのではなく実装を見直してください。

## 置き換えるもの

- CC-003: `isRecord`、`deepFreeze`、数値の述語、`compareCodeUnits` を `src/core/guards.ts`・`immutable.ts`・`text.ts` に置き換える。
- CC-004: `admission-policy.ts` の `canonicalizeAllowedOrigins` と `request-policy.ts` の `canonicalPassiveAllowedOrigins` を、`src/crawl/normalize-url.ts` の `canonicalizeAllowedOrigins` の利用に置き換える。`request-policy.ts` の `canonicalPassiveAllowedOrigins` は `src/browser/context-factory.ts` が import しているので、**名前は残し、中身を委譲にしてください**（context-factory は F02b の担当範囲なので変更しないこと）。
- CC-005: 担当範囲の http/https の判定を `isHttpProtocol` に置き換える。
- CC-007: 担当範囲の上限値のうち、`src/core/limits.ts` と同じ意味のものを置き換える。

## 置き換えないもの

- ブラウザ内で実行される関数（`page.evaluate`、`evaluateHandle`、`handle.evaluate` などに渡す関数）の中身。これらは import できないため、今回は対象外です（設計書 3.1）。ただし、Node 側で定義した上限値を引数として渡している箇所は、その値を `src/core/limits.ts` から取るように置き換えてください。
- 理由コードや状態の文字列の値（例: `'TIMED_OUT'`、`'SETTLED'`）。値を変えると Evidence の中身が変わるため、今回は変えません。型の定義を `src/core/contracts.ts` の共通の型に置き換えることは、値が同じ場合に限って行ってください。
- 意味が違う上限値（例: Interaction 候補の上限）。

## 受け入れ条件

- 担当範囲に、共通部品と同じ意味の独自実装が残っていない（残した場合は、その理由を報告する）。
- 担当範囲のテストと、`npm run typecheck` が PASS する。
- 振る舞いを変えていない（例外は上に明記したものだけ）。

## RED について

このサブタスクは振る舞いを変えない置き換えなので、原則として新しい RED は不要です。既存のテストが置き換えの前後で PASS することを確かめてください。

## 報告

共通ルールの形式で報告してください。「置き換えた箇所」（ファイル・元の実装・置き換え先）と「置き換えなかった箇所とその理由」を一覧にしてください。

## 追加の指示（F01 の報告を受けて）

- `src/core/ids.ts:68` の `sha256:` の書式の直書きを、同じファイルに追加された `createSha256Fingerprint` の利用に置き換える（出力が同じであることを確かめる）。
- `src/crawl/normalize-url.ts:51` 付近の http/https の直書きの判定を、同じファイルの `isHttpProtocol` に置き換える。
- `src/core/guards.ts` と `src/core/errors.ts` は変更しない（F02a・F02b が担当）。
