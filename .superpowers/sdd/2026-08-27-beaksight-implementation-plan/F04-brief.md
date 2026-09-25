# F04 指示書: 小さな整理（C1 の発見事項）

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## サブタスク

- ID: F04
- 目的: C1 の報告で見つかった、小さな重複と、必ず PASS してしまうテストを整理する。
- 背景: 作業記録置き場の `C1-report.md` の発見事項3と4

## 変更してよいファイル

- `src/crawl/admission-policy.ts`
- `src/safety/redact.ts`
- `src/crawl/normalize-url.ts`
- `src/core/limits.ts` または新規の `src/core/redaction.ts`（伏せ字の文字列を定義する置き場所。どちらか一方に置く）
- テスト: `tests/unit/admission-policy.test.ts`、`tests/unit/redact.test.ts`、`tests/unit/normalize-url.test.ts`

## 修正する内容

1. `src/crawl/admission-policy.ts:22` 付近で、`username` と `password` を直接確かめている箇所を、`normalize-url.ts` の `hasUrlCredentials` に置き換える（振る舞いは変えない）。
2. 伏せ字の文字列 `'[REDACTED]'` を、1か所の定数として定義する。`src/safety/redact.ts` と `src/crawl/normalize-url.ts` の両方で、その定数を使う（振る舞いは変えない）。
3. `tests/unit/normalize-url.test.ts` の「crawl admission policy と同じ Origin を許可する」テストは、`classifyUrl` が `canonicalizeAllowedOrigins` に委譲するようになったため、同じ関数どうしを比べている。これを、代表的な入力に対して、`classifyUrl` の判定結果を固定の期待値と比べるテストに書き直す。

## 受け入れ条件

- 変更したファイルのテストと、`npm run typecheck` が PASS する。
- 振る舞いを変えていない。

## 追加（C7 の報告を受けて）

4. `src/core/limits.ts` の冒頭のコメントを、設計書 3章の CC-007 の改訂後の方針（複数のownerで同じ意味を持つ上限と、Evidence の収集の上限を置く。特定のownerが意味を決める上限はそのownerに置く）に合わせて直す。値は変えない。変更してよいファイルに `src/core/limits.ts` を加える。

## 追加（C4b の報告を受けて）

5. `src/evidence/visibility.ts` の `VISIBILITY_CHECK_OPTIONS` を、`src/core/visibility.ts` に移す。`src/browser/controlled-scroll.ts` が `src/evidence` に依存しないようにするためである。すべての利用者（`src/browser/controlled-scroll.ts`、`src/evidence/*.ts`、`src/interaction/discover-candidates.ts`、テスト）の import を直す。`src/evidence/visibility.ts` は削除する（再 export を残さない。入口を1つにするため）。変更してよいファイルに、これらの利用者の import の行を加える。値は変えない。

## 追加（C5 の報告を受けて）

6. `VISIBILITY_CHECK_OPTIONS` の値を、`{ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: false }` に改める（設計書 5.5 の改訂）。`content-visibility:auto` で描画が省かれている、ビューポートの外の区画を、不可視と判定しないためである。`tests/component/visibility.test.ts` に、`content-visibility:auto` のビューポートの外の要素が可視と判定されることを確かめるテストを加える（修正前に RED、修正後に GREEN）。値の変更の後、`dom-collector`、`color-collector`、`layout-collector`、`controlled-scroll`、`discover-candidates` の関連するテストがすべて PASS することを確かめる。

## 追加（C6 の報告を受けて）

7. `src/evidence/layout-collector.ts` の `pageFailureReason` と、`src/browser/controlled-scroll.ts:397` 付近の `failureReason`（ページの失敗の理由を判定する同じ処理）を1つにまとめる。`isClosed` が例外を投げた場合も扱う方（layout 側）を正とする。置き場所は `src/browser/` の新規ファイル（例: `page-failure.ts`）にし、両方から使う。変更してよいファイルに、`src/evidence/layout-collector.ts`、`src/browser/controlled-scroll.ts`、新規ファイルを加える。振る舞いは変えない（controlled-scroll で `isClosed` が例外を投げた場合の扱いが変わるなら、その点を報告する）。
