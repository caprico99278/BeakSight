# F16 指示書: 安定性の確認と持続の確認、`<details>` の開閉、そのほか

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## サブタスク

- ID: F16
- 目的: click と関係のない属性の変化（タイマー、hover intent、focus、ripple）で、何もしないボタンが VERIFIED になるのを防ぐ。あわせて、`<details><summary>` を VERIFIED にできるようにする。
- 設計書: `doc/design/2026-09-23-beaksight-foundation-corrections-design.md` の 4.4.1（focus、安定性の確認、持続の確認、`<details>`）、4.4.2、4.4.4
- レビューの結果: 作業記録置き場の `R5-review-result.md`

このサブタスクは単独で実行します。

## 変更してよいファイル

- `src/interaction/isolated-auditor.ts`、`src/interaction/discover-candidates.ts`
- `src/evidence/interaction-collector.ts`
- `src/core/evidence-types.ts`、`schemas/page.schema.json`
  - 変わった属性の名前を Evidence に残すための変更に限る。
  - あわせて、`tests/unit/schema-validator.test.ts`、`tests/unit/core-contracts.test.ts`、`tests/unit/schema-enum-consistency.test.ts` も直す。
- テスト: `tests/integration/isolated-interaction.test.ts`、`tests/integration/passive-request-guard.test.ts`
  - `passive-request-guard.test.ts` は、偽の handle に `focus` などを加える場合に限る。
- `fixtures/site/` への新しいページの追加

## 修正する内容

1. **focus（N-3）**
   - 凍結の前の下準備で、hover の後に、対象の handle で focus する。期限を付けて待つ。
   - focus に失敗した場合と、期限を過ぎた場合は、NOT_VERIFIABLE にする。理由は、区別できる文言にする。
2. **安定性の確認（N-1）**
   - 落ち着くのを待った後、凍結の前に、一定の時間、観測を続ける。この時間の定数（例: `STABILITY_WINDOW_MS`）は、名前を付けて定義し、値とその理由を報告する。
   - 観測する項目は、click の後の根拠になる項目と同じにする。
   - この時間の間に1回でも変わった項目は、「不安定」として記録する。click の後に、その項目が変わっても、根拠にしない。
   - 観測の前の状態は、この時間の終わりに取る。
   - 期限の内側で行う。時間が足りない場合は、NOT_VERIFIABLE にする。
3. **持続の確認（N-3）**
   - click の後に、根拠になる変化を見つけたら、一定の時間（例: `PERSISTENCE_WINDOW_MS`）、観測を続ける。
   - その時間の終わりにも、同じ項目の変化が続いている場合だけ、VERIFIED の根拠にする。元に戻った変化は、根拠にしない。
   - 期限を過ぎた場合の扱いは、既存の期限切れの扱いにそろえる。
4. **`<details>` の開閉（N-2）**
   - 対象が `details` の `summary` の場合は、親の `details` の `open` の有無を、開閉の状態として記録する。
   - これが変われば、根拠にする（例: `detailsOpen`）。
   - 開いた状態と閉じた状態の両方の `<details>` で、VERIFIED になることを確かめる。
5. **hover で文字が変わるボタン（N-4）**
   - 下準備で hover した後の、同じ要素の状態（文字を含む）を取る。凍結の後に探し直すときは、その状態を目印にする。
   - 同じ要素であることは、下準備の handle で確かめる。
   - 受け入れの判定は、これまでどおり凍結の後に行う。
   - hover で「Following」が「Unfollow」になり、click で `aria-pressed` が切り替わるボタンが、VERIFIED になることを確かめる。
6. **変わった属性の名前を残す（N-5）**
   - `attributes` が根拠になった場合は、変わった属性の名前を、上限を付けて Interaction の Evidence に残す。
   - 型、スキーマ、テストを直す。
7. **理由の整形（N-6）**
   - `interactionFailureReason` で、次のものを取り除く。
     - 終端のない CSI の断片
     - C1 の制御文字（CSI の 0x9B など）
     - DCS・OSC の本体
     - 双方向の制御文字（U+202A〜U+202E、U+2066〜U+2069）
   - 切り詰めるときに、サロゲートペアを分けないようにする。

## 回帰テスト

**何もしないボタン（NOT_VERIFIABLE になること）**

- 300ms ごとに自分の class を切り替える
- rAF で style を書き換え続ける
- mouseenter の150ms後に class を付ける
- transition の終わりに class を付ける
- focus で `cdk-focused` を付ける
- focus で `data-focused` を付ける
- pointerdown で ripple の class を付け、400ms後に外す

**何かが起きる部品（VERIFIED になること）**

- `<details>`（閉じた状態から、開いた状態から）
- アコーディオン
- `aria-selected` のタブ
- class を切り替えるトグル
- `aria-pressed` のボタン
- hover で文字が変わり、click で `aria-pressed` が切り替わるボタン
- `aria-controls` のあるモーダル
- 大きさが変わるボタン（属性の変化）

どれも、修正前の結果を記録し、RED になるものは RED を確かめる。既存のテストで、タイミングの変化によって期待を直す必要があるものは、理由と一緒に報告する。

## 受け入れ条件

- 上の回帰テストが、設計どおりに PASS する。
- `tests/integration/isolated-interaction.test.ts` を2回続けて実行し、2回ともすべて PASS する。
- `tests/integration/passive-request-guard.test.ts` もすべて PASS する。
- `npm run verify` が PASS する（このサブタスクでは build を実行してよい）。
- 候補1つあたりの監査の時間が、どれだけ長くなったかを報告する。

## 報告

共通ルールの形式で報告してください。
