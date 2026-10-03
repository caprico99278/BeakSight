# F01 実装報告（実装者の報告を設計者が保存）

## 結論

完了。新しい共通部品（deadline、errors、guards、immutable、text、limits、visibility）を作った。`ids.ts`、`contracts.ts`、`normalize-url.ts` には、関数と型を追加しただけである。既存の呼び出し側は変更していない。

## 検証

- RED: シグネチャだけを持つ仮の実装で、新しいテスト9ファイルを実行した。46件が失敗し（すべて AssertionError）、振る舞いを保つことを確かめる40件は通過した。
- GREEN: 同じ9ファイル・86件が PASS した。
- `npx vitest run tests/unit` は18ファイル・227件、`npx vitest run tests/component` は7ファイル・81件がすべて PASS した。`npm run typecheck` も PASS した。
- 未実行: `tests/integration` と `npm run build`。今回の変更は既存の呼び出し側に触れていないため、実行していない。

## 部品一覧

| 部品（シグネチャ） | 置き場所 | 置き換える既存実装 | 既存との違い |
| --- | --- | --- | --- |
| `awaitBeforeDeadline<T>(operation: PromiseLike<T>, deadlineAtMs: number): Promise<DeadlineOutcome<T>>`（`FULFILLED`+`value` / `REJECTED`+`reason` / `DEADLINE_EXCEEDED`、凍結済み） | `src/core/deadline.ts` | page-settling、controlled-scroll、performance-collector の `beforeDeadline` と `DEADLINE` | reject されたときは、例外を投げずに `REJECTED` を返す。期限が非有限の数なら、期限切れとして扱う |
| `wait(delayMs: number): Promise<void>` | 同上 | `page-settling.ts:102`、`controlled-scroll.ts:91` | 同じ |
| `yieldMacrotask(): Promise<void>` | 同上 | `isolated-auditor.ts:292` | 同じ |
| `safeErrorMessage(error: unknown, maxLength: number): string`、`ERROR_MESSAGE_FALLBACK` | `src/core/errors.ts` | `passive-request-guard.ts:138`（正とする実装）、`isolated-auditor.ts:107`、`network-collector.ts:139` | 最大長が不正なら `RangeError`。代替文言の引数は F02b で追加する |
| `isRecord`、`isPositiveFiniteNumber`、`isNonNegativeSafeInteger`、`isPositiveSafeInteger` | `src/core/guards.ts` | CC-003 の各所 | 同じ。0以上の有限数の述語は F02a で追加する |
| `deepFreeze<T>(value: T): T` | `src/core/immutable.ts` | `load-config.ts:39`、performance-collector | 循環参照があっても止まる |
| `normalizeWhitespace`、`truncateText(value, maxLength): { text, truncated }`、`compareCodeUnits` | `src/core/text.ts` | CC-003 の各所 | `truncateText` は、最大長が不正なら `RangeError` |
| `MAX_URL_LENGTH`（2048）、`MAX_ERROR_MESSAGE_LENGTH`（2048）、`MAX_HTTP_METHOD_LENGTH`（32）、`MAX_SELECTOR_LENGTH`（512）、`MAX_SELECTOR_DEPTH`（8）、`GEOMETRY_EPSILON_PX`（0.5） | `src/core/limits.ts` | CC-007 | 値は同じ |
| `createRequestId`、`createSha256Fingerprint`、`isSha256Fingerprint` | `src/core/ids.ts` | `network-collector.ts:119`、`discover-candidates.ts:226`、`interaction-policy.ts:69` | 不正な連番には `RangeError` |
| `PARTIAL_FAILURE_REASONS`/`PartialFailureReason`、`OBSERVATION_STATUSES`/`ObservationStatus` | `src/core/contracts.ts` | `page-settling.ts:21`、`controlled-scroll.ts:30`、`performance-collector.ts:202, 42` | 値は同じ |
| `isHttpProtocol`、`canonicalizeAllowedOrigins(allowedOrigins: Iterable<string>): ReadonlySet<string>` | `src/crawl/normalize-url.ts` | CC-004、CC-005 | 同じ（25種類の入力で、既存の2つの実装と一致することを確認済み） |
| `VISIBILITY_CHECK_OPTIONS` | `src/evidence/visibility.ts` | C5・C3 で使う | 新規。実際の Chromium で3つの場合を確認済み |

## 発見事項と、設計者の判断

1. 代替文言を1つにすると、既存のテストが失敗する。→ `safeErrorMessage` に代替文言の引数を加え、場所ごとの文言を保つ（F02b。設計書 3.2 に追記）。
2. isolated-auditor の振る舞いが変わる（`String(error)` から、正とする振る舞いへ）。→ 許可する（設計書 3.2 に追記）。
3. `ids.ts:68` と `normalize-url.ts:51` に直書きが残っている。→ F02c で置き換える。
4. `interaction-policy.ts:68` の接頭辞付きの正規表現は、そのままでは置き換えられない。→ F02b で、置き換えられる場合だけ置き換える。
5. 「0以上の有限数」の述語がない。→ F02a で追加する。
6. 共通部品台帳が未更新。→ 設計者が更新する。
