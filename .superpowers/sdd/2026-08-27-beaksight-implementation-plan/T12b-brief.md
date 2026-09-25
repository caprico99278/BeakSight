# T12b 指示書: technical rule

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## 共通の前提

- 設計書: `doc/design/2026-09-23-beaksight-task-12-13-rules-design.md`
- 実装計画: `doc/design/2026-09-23-beaksight-task-12-13-rules-implementation-plan.md`
- 上位の計画: `doc/design/2026-08-27-beaksight-implementation-plan.md` の Task 12・13
- Rule の契約: T12a で作った `src/audit/rule.ts`、`src/audit/rule-catalog.ts`、`src/audit/rule-engine.ts`。作業記録置き場の `T12a-report.md` と `T12a2-report.md` に、シグネチャの一覧がある。T12a2 の後の型を正とする。
- 本物の Rule は、Evidence がない入力でも、例外を投げてはいけない（T12a の既定の Engine のテストが、これを確かめる）。
- 下書きの ruleId は、Rule の ruleId と一致させる。同一性の要素の名前に、予約名 `viewport` を使わない（設計書 第6章）。
- Evidence の型: `src/core/evidence-types.ts`、`src/core/contracts.ts`
- Rule は、Evidence だけを入力にする。ブラウザを操作しない。意味的な判断や美的な判断を、Finding にしない。
- Finding の `message` は、日本語で書く。文言には、判定に使った事実（URL、ステータス、値としきい値など）を含める。
- 観測できなかった値（`NOT_OBSERVED`、`UNSUPPORTED`、null）から Finding を作らない。
- 判定に使う定数は、その Rule のファイルの中に、名前付きの定数として置く。
- 各 Rule について、成立する Evidence と成立しない Evidence の両方でテストする。テストは、`tests/component/<ファイル名>.test.ts` に書く。
- Rule の登録は、自分の担当のファイルが export する配列に加えるだけにする。`rule-catalog.ts` は変更しない。

同時に、ほかの実装者が別の Rule のファイルを実装しています。担当のファイル以外は変更しないでください。

## 変更してよいファイル

- `src/audit/technical-rules.ts`（`TECHNICAL_RULES`）と `tests/component/technical-rules.test.ts`

## 実装する内容

設計書 5.1 の表のうち、category が `HTTP`、`LINK`（`INVALID_INTERNAL_URL` と `UNSUPPORTED_URL_SCHEME` だけ）、`RESOURCE`、`JAVASCRIPT`、`DOM`、`FORM` の Rule を実装する。`BROKEN_INTERNAL_LINK` と `TARGET_NAVIGATION_FAILED` は Cross-page rule なので、ここでは作らない。

- `HTTP_4XX` と `HTTP_5XX` は、メインフレームのナビゲーション応答（`isMainFrame` と `isNavigationRequest` の印）だけで判定する。iframe の文書やサブリソースでは判定しない。
- `PAGE_ERROR` は、同じ message・source・stack のものを1つにまとめる。
- `IMAGE_LOAD_FAILED` は、画像の読み込みの失敗、または `complete` かつ `naturalWidth = 0` で判定する。
- `EMPTY_VISIBLE_CONTENT` は、DOM の可視テキストが空で、しかも DOM の走査が上限に達していない場合だけ判定する。上限に達していた場合は、空とは言えないので判定しない。
- `UNLABELED_REQUIRED_CONTROL` は、form の中の入力欄と、form の外の入力欄（`unassociatedFields`）の両方を対象にする。可視（`visible: true`）の、required の入力欄で、`labels`・`aria-label`・`aria-labelledby`・`title` のどれもないものを判定する。
- 実装計画の Task 12 Step 1 に書かれているとおり、「交通事故」というリンク文言で `/symptoms` を指すリンクが Finding にならないことを、テストで確かめる。

## 受け入れ条件

- 担当の Rule が、すべて実装され、登録されている。
- 各 Rule について、成立する場合と成立しない場合のテストがある。修正前（実装前）に RED、実装後に GREEN になる。
- `npm run typecheck` と、担当のテストが PASS する。

## 報告

共通ルールの形式で報告してください。実装した Rule の一覧（ruleId、version、category、severity、判定の要点）を書いてください。
