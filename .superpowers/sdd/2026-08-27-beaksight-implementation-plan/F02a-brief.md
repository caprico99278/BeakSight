# F02a 指示書: 共通部品への移行（browser・evidence）

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## サブタスク

- ID: F02a
- 目的: F01 で新設した共通部品に、担当範囲の重複した実装を置き換える。振る舞いは変えない（例外は下に明記）。
- 設計書: `doc/design/2026-09-23-beaksight-foundation-corrections-design.md` の第3章（とくに 3.1、3.2）
- 実装計画: `doc/design/2026-09-23-beaksight-foundation-corrections-implementation-plan.md` の F02a
- 共通部品の一覧: `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/F01-report.md`（F01 の実装報告。部品の名前とシグネチャ）と、`src/core/` の実物
- 重複の実例: `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/commonization-candidates.md`

同時に、ほかの実装者が別の範囲の移行（F02b: safety・interaction、F02c: config・core・crawl）を行っています。担当範囲の外のファイルは変更しないでください。

## 変更してよいファイル

- `src/browser/page-settling.ts`
- `src/browser/controlled-scroll.ts`
- `src/evidence/performance-collector.ts`
- `src/evidence/network-collector.ts`
- `src/evidence/console-collector.ts`
- `src/evidence/color-collector.ts`
- `src/evidence/layout-collector.ts`
- `src/evidence/accessibility-collector.ts`
- `src/evidence/dom-collector.ts`
- `src/evidence/screenshot-collector.ts`
- `src/evidence/interaction-collector.ts`

対応するテストファイルは変更してよいですが、テストの内容（検証していること）は変えないでください。移行によってテストが失敗した場合は、振る舞いが変わったことを意味するので、テストを直すのではなく実装を見直してください。

## 置き換えるもの

- CC-001: `DEADLINE` / `beforeDeadline` / `wait` を `src/core/deadline.ts` に置き換える（page-settling、controlled-scroll、performance-collector）。
- CC-002: `network-collector.ts` の `errorMessage` を `src/core/errors.ts` に置き換える。**これは振る舞いが変わる唯一の箇所**です（上限と防御が加わる。設計書 3.2）。この変化を確かめるテストを1つ追加してください（getter が例外を投げる値、または非常に長いメッセージ）。
- CC-003: `isRecord`、`deepFreeze`、数値の述語、Node 側の文字列の切り詰めを `src/core/guards.ts`・`immutable.ts`・`text.ts` に置き換える。
- CC-006: `network-collector.ts` の `REQ-` の採番を `src/core/ids.ts` に置き換える。
- CC-007: 担当範囲の上限値のうち、`src/core/limits.ts` と同じ意味のもの（URLの最大長、selector の長さと深さ、ジオメトリの許容誤差）を置き換える。
- CC-009: 部分失敗の理由（`DEADLINE_EXCEEDED | EVALUATION_FAILED | PAGE_CLOSED`）の型を `src/core/contracts.ts` の `PartialFailureReason` に、performance-collector の観測状態の型を `ObservationStatus`（値が同じ場合）に置き換える。

## 置き換えないもの

- ブラウザ内で実行される関数（`page.evaluate`、`evaluateHandle`、`handle.evaluate` などに渡す関数）の中身。これらは import できないため、今回は対象外です（設計書 3.1）。ただし、Node 側で定義した上限値を引数として渡している箇所は、その値を `src/core/limits.ts` から取るように置き換えてください。
- 理由コードや状態の文字列の値（例: `'TIMED_OUT'`、`'SETTLED'`）。値を変えると Evidence の中身が変わるため、今回は変えません。型の定義を `src/core/contracts.ts` の共通の型に置き換えることは、値が同じ場合に限って行ってください。
- 意味が違う上限値（例: Interaction 候補の上限）。

## 受け入れ条件

- 担当範囲に、共通部品と同じ意味の独自実装が残っていない（残した場合は、その理由を報告する）。
- 担当範囲のテストと、`npm run typecheck` が PASS する。
- 振る舞いを変えていない（例外は上に明記したものだけ）。

## RED について

このサブタスクは振る舞いを変えない置き換えなので、原則として新しい RED は不要です。既存のテストが置き換えの前後で PASS することを確かめてください。 network-collector の変化については、追加したテストが置き換えの前に失敗し、後に PASS することを確かめてください。

## 報告

共通ルールの形式で報告してください。「置き換えた箇所」（ファイル・元の実装・置き換え先）と「置き換えなかった箇所とその理由」を一覧にしてください。

## 追加の指示（F01 の報告を受けて）

- `src/core/guards.ts` に「0以上の有限数」の述語（例: `isNonNegativeFiniteNumber`）を追加してよい。`performance-collector.ts` の `nonnegative()` と `layout-collector.ts:153` 付近の検査の置き換えに使う。`guards.ts` に対するほかの変更はしない（F02b・F02c は `guards.ts` を変更しない）。
