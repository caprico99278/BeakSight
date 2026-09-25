# F09 指示書: 確認のレビュー R'2 の指摘の修正

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## サブタスク

- ID: F09
- 目的: 確認のレビュー R'2 で見つかった Important 3件と Minor を直す。
- レビューの結果: 作業記録置き場の `Rp2-review-result.md`
- 設計書: `doc/design/2026-09-23-beaksight-foundation-corrections-design.md` の 5.1〜5.4

同時に、別の独立レビュー（R'1: Interaction）が読み取り専用で動いています。このサブタスクは、`src/interaction/*` とそのテストを変更しません。

## 変更してよいファイル

- `src/browser/controlled-scroll.ts`
- `src/evidence/dom-collector.ts`
- `src/config/validate-config.ts`
- `src/core/contracts.ts`、`src/core/evidence-types.ts`、`src/core/ids.ts`（Evidence の種類を加えるときの接頭辞だけ）
- `schemas/*.json`
- テスト: `tests/integration/controlled-scroll.test.ts`、`tests/component/dom-collector.test.ts`、`tests/integration/layout-accessibility.test.ts`（`collectDomEvidence` の利用者の修正だけ）、`tests/unit/config.test.ts`、`tests/unit/core-contracts.test.ts`、`tests/unit/schema-validator.test.ts`
- `fixtures/site/` への新しいページの追加

## 修正する内容

1. **I-1（偽の COMPLETE）**
   - 完了と判定する前に、候補（文書、body、内側の領域）のスクロールできる量を測り直す。
   - その時点で別の候補のほうが大きい場合の扱い:
     - 文書か body なら、1回だけ対象を切り替えて、たどり直す。
     - 内側の領域なら、PARTIAL と `INNER_SCROLL_CONTAINER_NOT_TRAVERSED` を返す。
   - 2回目の測り直しでも対象が変わった場合は、PARTIAL と理由（例: `SCROLL_TARGET_UNSTABLE`）を返す。
   - レビューの再現条件（`html{height:100%;overflow:hidden} body{height:100%;overflow:auto}` のページで、10px の div を 150ms 後に 5000px にする）を fixture にする。修正前に COMPLETE（RED）、修正後に最下部まで達することを確かめる。
2. **I-2（スクロールの結果の Evidence）**
   - Evidence の種類に `scroll` を加える（`EvidencePayloadByType`、`createEvidenceId` の接頭辞、スキーマ）。
   - payload は、controlled scroll の結果（`ScrollResult`）が持つ事実を持たせる。事実とは、状態、理由、たどった対象、到達した位置、`restoration`、`innerScrollScan`（`scanLimitReached` を含む）のことである。
   - 型の定義は `src/core/evidence-types.ts` に1か所だけ置き、`controlled-scroll.ts` はそれを使う。
   - スキーマが、実際の `controlledScroll` の結果を受け付け、必須の項目が欠けたものを拒否することを、テストで確かめる。
3. **I-3（shadow DOM）**
   - 内側の領域を探す走査は、open な shadow root の中にも入るようにする。上限（`MAX_INNER_SCROLL_SCAN_ELEMENTS`）は shadow root の中の要素も含めて数える。
   - open な shadow root の中に `height:100vh;overflow:auto` の領域があるページで、修正前は COMPLETE（RED）、修正後は PARTIAL になることを確かめる。
4. **m1**
   - 文書をたどった後に、内側の領域の走査が上限に達して COMPLETE になり、`innerScrollScan.scanLimitReached` が true になる場合のテストを加える（偽のページでよい）。
5. **m2**
   - `contracts.ts:49` 付近の `INNER_SCROLL_CONTAINER_NOT_TRAVERSED` の説明を、N1 と I-1 の修正後の意味（スクロールできる量が最も大きい候補が内側の領域で、そこをたどらない）に直す。
6. **m3（Link の格納を1回にする）**
   - `DomEvidence` から `links` を外す。Link は、link の Evidence（`LinkDiscoveryEvidence`）の1か所だけに置く。
   - DOM の Evidence には、リンクの件数など、DOM の事実として必要なものがあれば残す。その場合は、型の説明に理由を書く。
   - `collectDomEvidence()` の引数から Link を外せる場合は外し、利用者を直す。
   - DOM の Evidence の `truncation.omittedLinkCount` も、link の Evidence の側にあるので外す。
7. **m4（shadow DOM の入力欄）**
   - open な shadow root の中の `input`・`select`・`textarea` も、form に属さない入力欄（`unassociatedFields`）として、上限付きで記録する。
8. **m5（設定の検証）**
   - `startUrl` について、`normalizeUrl` の結果が `URL_TOO_LONG` などで拒否される場合は、設定のエラーにする。
   - `locale` と `timezone` について、`Intl.DateTimeFormat` で受け付けられない値を、設定のエラーにする。

## 受け入れ条件

- 各項目で、修正前に RED、修正後に GREEN になる。型だけの変更は、typecheck で確かめる。
- `npm run verify` が PASS する（このサブタスクでは build を実行してよい）。

## 報告

共通ルールの形式で報告してください。変更した Evidence の形を一覧にしてください。
