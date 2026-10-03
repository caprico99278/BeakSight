# F01 指示書: 共通部品の新設

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## サブタスク

- ID: F01
- 目的: 既存コードに重複している処理のうち、Node側で共通化できるものを、共通部品として新設する。この時点では既存の呼び出し側を変更しない（呼び出し側の置き換えは次のサブタスク F02a〜c が行う）。
- 設計書: `doc/design/2026-09-23-beaksight-foundation-corrections-design.md` の第3章
- 実装計画: `doc/design/2026-09-23-beaksight-foundation-corrections-implementation-plan.md` の F01
- 重複の実例: `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/commonization-candidates.md`（CC-001〜007、009）

## 変更してよいファイル

- 新規: `src/core/deadline.ts`、`src/core/errors.ts`、`src/core/guards.ts`、`src/core/immutable.ts`、`src/core/text.ts`、`src/core/limits.ts`、`src/evidence/visibility.ts`
- 追加のみ: `src/core/ids.ts`（関数の追加）、`src/core/contracts.ts`（型の追加）、`src/crawl/normalize-url.ts`（関数の追加）
- テスト: `tests/unit/` に、新しい部品ごとのテストファイルを新規作成してよい。既存の `tests/unit/core-contracts.test.ts`、`tests/unit/normalize-url.test.ts` にテストを追加してよい。

既存の関数や型の振る舞いを変えないでください。既存の呼び出し側（collector など）を変更しないでください。

## 作るもの

既存の実装を読み、その振る舞いを正として共通部品にしてください。

1. `src/core/deadline.ts`（CC-001）
   - 元にする実装: `src/browser/page-settling.ts:25-71`、`src/browser/controlled-scroll.ts:34-89`、`src/evidence/performance-collector.ts:209-213, 373-400` の `DEADLINE` / `beforeDeadline<T>()`。`isolated-auditor.ts:292` の `yieldMacrotask`、`page-settling.ts:102` と `controlled-scroll.ts:91` の `wait`。
   - 提供するもの: 絶対時刻の期限までの待機（期限前に完了した値・期限切れ・reject を区別できる結果を返す。例外は投げない）、指定ミリ秒の待機、マクロタスクを1回譲る関数。
   - 要件: 期限切れの後に元の Promise が reject しても、unhandledRejection にならない（元の Promise に必ず rejection handler を付ける）。タイマーは完了時に解除する。
2. `src/core/errors.ts`（CC-002）
   - 元にする実装: `src/safety/passive-request-guard.ts:138-165`（正とする振る舞い）。比較用に `src/interaction/isolated-auditor.ts:107-119`、`src/evidence/network-collector.ts:139-141`。
   - 提供するもの: 不明な値を、例外を投げずに、呼び出し側が指定した長さ以内の文字列にする関数。取り出せなかったときの代替文言も1か所に定義する。
   - 要件: Error、文字列、`undefined`、`null`、数値、getter が例外を投げるオブジェクト、`message` が文字列でないオブジェクト、Proxy のすべてで、例外を投げずに長さ以内の文字列を返す。
3. `src/core/guards.ts`（CC-003）: `isRecord`（元: `validate-config.ts:5`、`load-config.ts:16`、`performance-collector.ts:406`）と、数値の述語（正の有限数、0以上の安全な整数、正の安全な整数。元: CC-003 の一覧）。
4. `src/core/immutable.ts`（CC-003）: `deepFreeze`（元: `load-config.ts:39-47`、`performance-collector.ts:416`）。
5. `src/core/text.ts`（CC-003）: 空白の正規化 `normalizeWhitespace`（`replace(/\s+/gu, ' ').trim()` と同じ結果）、長さの切り詰め（切り詰めたかどうかも分かる形）、`compareCodeUnits`（元: `src/core/ids.ts:71-79`、`src/crawl/normalize-url.ts:12-20`）。既存の `ids.ts` と `normalize-url.ts` の `compareCodeUnits` は、この時点ではそのまま残してよい。
6. `src/core/limits.ts`（CC-007）: 既存の値と同じ値で、URLの最大長 2048、エラーメッセージの最大長（`passive-request-guard.ts:36` の値）、HTTPメソッドの最大長 32、selector の最大長 512 と最大深さ 8、ジオメトリの許容誤差 0.5。名前は意味が分かるものにし、`Object.freeze` した1つのオブジェクトか、個別の定数にする。意味が違う値（Interaction 候補の上限など）はここに入れない。
7. `src/core/ids.ts` に追加（CC-006）: `REQ-` の採番（元: `network-collector.ts:119-121`、既存の6桁の書式を使う）、`sha256:` 形式のハッシュ文字列を作る関数と、その形式かを判定する関数（元: `ids.ts:68`、`discover-candidates.ts:226-228`、`interaction-policy.ts:68-69`）。既存の関数の振る舞いは変えない。
8. `src/core/contracts.ts` に追加（CC-009）: 部分失敗の理由 `PartialFailureReason = 'DEADLINE_EXCEEDED' | 'EVALUATION_FAILED' | 'PAGE_CLOSED'` と、観測状態 `ObservationStatus = 'OBSERVED' | 'NOT_OBSERVED' | 'UNSUPPORTED'`。値の一覧は `as const` の配列として定義し、型はそこから導出する。既存の型は変えない。
9. `src/crawl/normalize-url.ts` に追加（CC-004、CC-005）: `isHttpProtocol(protocol: string): boolean`（`http:` または `https:`）と、`canonicalizeAllowedOrigins`（元: `src/crawl/admission-policy.ts:11-24`、`src/safety/request-policy.ts:31-48`）。後者は、既存の2つの実装と同じ入力に対して同じ結果を返すことを、テストで確かめる（両方の既存実装を呼んで比較するテストでよい）。
10. `src/evidence/visibility.ts`（CC-008）: `VISIBILITY_CHECK_OPTIONS = Object.freeze({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })`。設計書 5.5 を参照。この値をブラウザ内で `element.checkVisibility(options)` に渡したとき、`body{opacity:0}` の子は不可視、`visibility:hidden` の祖先を持つ `visibility:visible` の子は可視、`display:none` の祖先を持つ子は不可視になることを、実ブラウザのテスト（`tests/component/` に新規作成）で確かめる。

## 受け入れ条件

- 新しい部品それぞれに単体テストがあり、PASS する。
- `npm run typecheck` が PASS する。
- `npx vitest run tests/unit` と、新規作成したテストが PASS する。
- 既存の呼び出し側が変更されていない（`git diff --stat` で確認し、報告に含める）。

## 報告

共通ルールの形式で報告してください。あわせて、次のサブタスク（呼び出し側の置き換え）のために、作った部品の名前・シグネチャ・既存実装との対応を一覧にしてください。
