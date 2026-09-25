# F15 指示書: 対象の位置と大きさの変化だけでは VERIFIED にしない。hover を観測の前にそろえる

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## サブタスク

- ID: F15
- 目的: 何もしないボタンが、hover のスタイルや遅延読み込みによる大きさの変化で VERIFIED になる問題を、根本的に直す。
- 設計書: `doc/design/2026-09-23-beaksight-foundation-corrections-design.md` の 4.4.1（最終の方針）、4.4.2（下準備の手順に hover を加えたもの）、4.4.4（制約）
- レビューの結果: 作業記録置き場の `Rppp-review-result.md`

このサブタスクは単独で実行します。

## 変更してよいファイル

- `src/interaction/isolated-auditor.ts`
- `src/interaction/discover-candidates.ts`
- `src/evidence/interaction-collector.ts`
- テスト: `tests/integration/isolated-interaction.test.ts`、`tests/integration/passive-request-guard.test.ts`（偽の handle に `hover` が必要な場合の追加だけ）
- `fixtures/site/` への新しいページの追加
- Evidence の型（`src/core/evidence-types.ts`）とスキーマ（`schemas/page.schema.json`）: 対象の属性の変化を Evidence に記録するために必要な場合に限り、変更してよい。変更するときは、`tests/unit/schema-validator.test.ts`、`tests/unit/core-contracts.test.ts`、`tests/unit/schema-enum-consistency.test.ts` も直す。

## 修正する内容

1. **位置と大きさの変化だけでは根拠にしない**
   - `boundingBox` の変化（平行移動も大きさの変化も）は、VERIFIED の根拠（`changedFields`）に含めない。Evidence の before・after には、これまでどおり記録する。
   - 変化が位置と大きさだけのときの NOT_VERIFIABLE の理由は、そのことが分かる文言にする。
2. **対象自身の属性の変化を根拠にする**
   - 観測の前後で、対象の要素そのものの属性（名前と値）の一覧を比べる。いま観測していない場合は、観測に加える。
   - 属性が1つでも変われば、根拠にする（例: `changedFields` に `attributes` を加える）。子孫の属性は含めない。
   - 属性の件数と値の長さには、既存の上限（`INTERACTION_CANDIDATE_LIMITS` など）を使う。
   - ARIA の状態の変化と、`aria-controls` の先の表示の変化は、これまでどおり根拠にする。
3. **下準備で hover する**
   - 凍結の前の下準備で、`scrollIntoViewIfNeeded` の後に、対象の handle で `hover()` を期限付きで実行する。
   - hover に失敗した場合と期限を過ぎた場合は、その候補を NOT_VERIFIABLE にする。理由は区別できる文言にする。
   - その後、ページが落ち着くのを待ってから凍結し、観測の前の状態を取る。
4. **M-3（理由の整形）**
   - `lifecycle.reason`（`isolated-auditor.ts:973` 付近）と、Ledger に記録する理由（`:394` 付近）にも、`interactionFailureReason` と同じ整形を使う。
   - 整形の順序を、「制御文字と Call log を除く」から「上限で切り詰める」の順にする。こうすれば、切り詰めで切れた ANSI の断片が残らない。

## 回帰テスト

レビューの再現条件を fixture にする。

**何もしないボタン（NOT_VERIFIABLE になること）**
- `button:hover{transform:scale(1.2)}`
- `:hover{font-weight:bold}`
- `:hover` で padding を変え、transition を付けたもの
- ボタンの中に大きさを指定しない画像を置き、画像を後から大きくするもの（遅延読み込みの代わりに、`setTimeout` で要素の大きさを変える方式でよい）
- flex の行で、ボタンの隣の要素が後から大きくなるもの
- JavaScript の `mouseenter` で class を付けるもの（hover を下準備で行うので、観測の前の状態に含まれることを確かめる）

どれも、修正前に VERIFIED になる（RED）ことを確かめる。

**何かが起きるボタン（VERIFIED のままであること）**
- アコーディオン
- `self-growing-button.html`（click で style か class が変わるはずなので、属性の変化が根拠になる）
- `aria-controls` の先の表示が切り替わるもの
- 文字が切り替わるもの

既存のテストで、位置や大きさの変化だけで VERIFIED を期待しているものがあれば、設計書 4.4.1 に照らして是正する。直したテストの名前と理由は報告すること。

## 受け入れ条件

- 上の回帰テストが、設計どおりに PASS する。
- `tests/integration/isolated-interaction.test.ts` を2回続けて実行し、2回ともすべて PASS する。`tests/integration/passive-request-guard.test.ts` も、すべて PASS する。
- `npm run verify` が PASS する（このサブタスクでは build を実行してよい）。

## 報告

共通ルールの形式で報告してください。VERIFIED の根拠の一覧（`changedFields` の値ごとの意味）を書いてください。
