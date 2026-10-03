# F14 指示書: 対象の平行移動だけの変化を、VERIFIED の根拠にしない

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## サブタスク

- ID: F14
- 目的: 対象の要素が平行移動しただけ（x・y だけの変化）の場合は、VERIFIED の根拠にしない。これで、click と関係のない位置の変化（遅延読み込みによるずれ、スクロール、アニメーション）による偽の VERIFIED を、まとめて防ぐ。
- 設計書: `doc/design/2026-09-23-beaksight-foundation-corrections-design.md` の 4.4（整理し直した版。とくに 4.4.1）
- レビューの結果: 作業記録置き場の `Rpp1-review-result.md`

同時に、ほかの実装者（F13）が、`src/config/validate-config.ts`、`src/core/evidence-types.ts`、`src/evidence/dom-collector.ts`、`schemas/page.schema.json` と、それらのテストを変更しています。これらのファイルは変更しないでください。

## 変更してよいファイル

- `src/evidence/interaction-collector.ts`
- `src/interaction/isolated-auditor.ts`
- `src/interaction/discover-candidates.ts`（必要な場合に限る）
- テスト: `tests/integration/isolated-interaction.test.ts`、`tests/integration/passive-request-guard.test.ts`（期待値が変わる場合に限る）、および新規のテストファイル
- `fixtures/site/` への新しいページの追加

Evidence の型（`src/core/evidence-types.ts`）を変更する必要がある場合は、変更せずに止まって報告してください。

## 修正する内容

1. **平行移動を根拠にしない**
   - 変化を判定するとき（`interactionGeometryChanged` とその利用者）、対象の `boundingBox` の変化を、次のように分けて扱う。
     - 大きさ（幅・高さ）の変化が許容誤差を超えた場合は、これまでどおり VERIFIED の根拠（`changedFields` の `boundingBox`）にしてよい。
     - x・y だけが変わった場合は、根拠にしない。
   - 平行移動だけの変化があったことは、Evidence にこれまでどおり記録する。`before`・`after` の `boundingBox` は残る。
   - `aria-controls` の先の要素の表示状態と layout の変化、ARIA の変化など、ほかの根拠は変えない。
   - 変化が平行移動だけだった場合の NOT_VERIFIABLE の理由は、そのことが分かる文言にする。
2. **回帰テスト**（レビューの再現条件を fixture にする）
   - 何もしないボタンを画面外に置き、その直上に大きさを指定しない `<img loading=lazy>` を置く。画像の応答は、fixture サーバで遅らせる。サーバに遅延の仕組みがない場合は、IntersectionObserver と `setTimeout` で、後から要素を挿入してレイアウトをずらす方式でよい。
   - 修正前は VERIFIED になる（RED）ことを確かめ、修正後は NOT_VERIFIABLE になることを確かめる。
   - あわせて、次のテストも加える。
     - 大きさが変わるボタン（例: 押すと自分が広がるボタン）が、VERIFIED になること。
     - アコーディオンが、引き続き VERIFIED になること。
3. **click の失敗の理由の整理**
   - `isolated-auditor.ts:190-199` 付近で、click が失敗したときの理由の文字列から、ANSI の制御文字と、Playwright の `Call log:` 以降を取り除く。
   - 取り除く処理は `src/core/text.ts` などの共通の部品にはせず、この用途の関数として置いてよい。ただし、既存の `safeErrorMessage` の上限付きの切り詰めは使う。
   - 制御文字を含む失敗の理由が、きれいな文字列になることを確かめる。

## 受け入れ条件

- 各項目で、修正前に RED、修正後に GREEN になる。
- 既存のテストのうち、平行移動だけで VERIFIED を期待していたものがあれば、報告する。直してよいのは、設計書 4.4.1 に照らして仕様の是正になる場合だけとする。直した場合は、テストの名前と理由を報告すること。
- `tests/integration/isolated-interaction.test.ts` を2回続けて実行し、2回ともすべて PASS する。`tests/integration/passive-request-guard.test.ts` もすべて PASS する。
- `npm run typecheck` の担当範囲が PASS する。

## 報告

共通ルールの形式で報告してください。
