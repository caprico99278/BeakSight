# F10 指示書: click のときのスクロールによる偽の VERIFIED を防ぐ（R'1 の N1'）

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## サブタスク

- ID: F10
- 目的: 対象が固定表示の要素に覆われていると、Playwright は click を再試行しながらスクロールする。そのため、何もしないボタンが VERIFIED になることがある。これを防ぐ。
- レビューの結果: 作業記録置き場の `Rp1-review-result.md`
- 設計書: `doc/design/2026-09-23-beaksight-foundation-corrections-design.md` の 4.4（下の方式を、設計者が追記する）

同時に、ほかの実装者（F09）が、次のファイルを変更しています。これらのファイルは変更しないでください。

- `src/browser/controlled-scroll.ts`
- `src/evidence/dom-collector.ts`
- `src/config/validate-config.ts`
- `src/core/contracts.ts`、`src/core/evidence-types.ts`、`src/core/ids.ts`
- `schemas/*.json`

## 変更してよいファイル

- `src/interaction/isolated-auditor.ts`
- `src/interaction/discover-candidates.ts`
- `src/evidence/interaction-collector.ts`
- テスト: `tests/integration/isolated-interaction.test.ts`
- `fixtures/site/` への新しいページの追加

Evidence の型（`src/core/evidence-types.ts`）を変更する必要がある場合は、変更せずに止まって報告すること。スクロールの位置の記録は、auditor の内部の判定に使うだけにし、Evidence の型には加えない。

## 修正する内容

1. **スクロールしたときは、位置の変化を根拠にしない**
   - 変化を観測する前（click の前）と後で、対象の要素のスクロールする祖先のスクロール位置を記録する。祖先には、`window`（文書）と、`overflow` が `auto`・`scroll`・`overlay` の祖先の要素（open な shadow root をまたぐものを含む）が含まれる。
   - 祖先の走査は、既存の DOM の作業量の上限（共有の上限）の中で行う。上限に達した場合は、スクロールがあったかどうかを判定できないとみなす。この場合も、`boundingBox` の変化を根拠にしない。
   - 前後で1つでも位置が変わっていた場合は、`boundingBox` の変化を、VERIFIED の根拠（`changedFields`）から除く。ほかの変化（属性、テキスト、DOM の変化など）は、これまでどおり根拠にする。
   - `boundingBox` の変化しかなく、スクロールも起きていた場合は、`NOT_VERIFIABLE` にする。理由は、それが分かる文言にする。
2. **回帰テスト**（レビューの再現条件を fixture にする）
   - 共通の構成: `html, body {overflow:hidden}`、`#s {overflow-y:auto}` の内側の領域、固定表示の要素 `#ov {position:fixed; top:300px; height:100px}`。
   - (a) 何もしないボタンを内側の領域の画面外に置く。
   - (b) 何もしないボタンを初めから画面内に置き、`#ov` で覆う。
   - (a) と (b) のどちらも、修正前は VERIFIED になる（RED）ことを確かめる。修正後は NOT_VERIFIABLE になることを確かめる。
   - あわせて、何かが起きるボタン（アコーディオン）を同じ構成に置き、属性や表示の変化によって VERIFIED になることを確かめる（偽の NOT_VERIFIABLE を防ぐため）。
3. **Minor**
   - `isolated-auditor.ts:578-584` 付近で2回続いている `remaining() === 0` の検査を、1つにまとめる。

## 受け入れ条件

- 上の回帰テストで、修正前に RED、修正後に GREEN になる。
- `tests/integration/isolated-interaction.test.ts` と `tests/integration/passive-request-guard.test.ts` のすべてのテストが PASS する。`isolated-interaction.test.ts` は、2回続けて実行し、2回とも PASS すること。
- `npm run typecheck` の担当範囲が PASS する。

## 報告

共通ルールの形式で報告してください。
