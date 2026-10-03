# T12c 実装報告（要約。設計者が保存）

## 結論

完了した。LAYOUT の Rule 9個、ACCESSIBILITY の Rule 2個、PERFORMANCE の Rule 5個を実装し、登録した。担当のテスト57件と `npm run typecheck` は PASS した。

## 実装した Rule（すべて version 1）

- LAYOUT: `DOCUMENT_HORIZONTAL_OVERFLOW`（ERROR）、`ELEMENT_OUTSIDE_VIEWPORT`、`ELEMENT_OVERLAP`、`CONTENT_COLLISION`、`TEXT_CLIPPING`、`FIXED_ELEMENT_OCCLUSION`、`ZERO_SIZE_INTERACTIVE_ELEMENT`、`OVERSIZED_FIXED_ELEMENT`、`DYNAMIC_LAYOUT_SHIFT`（ERROR 以外はすべて WARN）
- ACCESSIBILITY:
  - `COLOR_CONTRAST_VIOLATION`
  - `A11Y_AXE`（`ruleIdPrefix: 'A11Y_'`）
  - severity は impact で決める。critical・serious は ERROR、moderate は WARN、minor は INFO、impact がない場合は WARN。
- PERFORMANCE: `POOR_LCP` > 4000、`POOR_FCP` > 3000、`POOR_CLS` > 0.25、`POOR_TTFB` > 1800、`POOR_INP` > 500（すべて WARN。`OBSERVED` の値だけを使う）

## layout の定数

| 定数 | 値 |
| --- | --- |
| はみ出しの許容 | 0 px |
| 重なりの割合 | 25% |
| 固定要素が覆う割合 | 25% |
| 大きすぎる固定要素 | ビューポートの面積の 30% |
| 1回の shift | 0.1 |
| 切り詰めの許容 | 1 px |
| visually hidden の判定 | 1 px |

根拠は経験則なので、`DOCUMENT_HORIZONTAL_OVERFLOW` 以外は WARN にした。

## 実装者の判断と、設計者の判断

1. レスポンシブの幅ごとの結果（`stressSweep`）は、判定していない。→ 判定するよう、T12e で直す。
   - 上位の設計書 14.9 は、幅ごとの確認の対象を、DOM geometry、overflow、collision、fixed occlusion と定めている。
   - そこで、次の5つの Rule を、幅ごとの layout の結果にも当てはめる。
     - `DOCUMENT_HORIZONTAL_OVERFLOW`
     - `ELEMENT_OUTSIDE_VIEWPORT`
     - `ELEMENT_OVERLAP`
     - `CONTENT_COLLISION`
     - `FIXED_ELEMENT_OCCLUSION`
   - 幅は、同一性の要素 `stressWidth` に加える。
   - 主要なビューポートと同じ幅の結果は、重複するので判定しない。
   - Rule の設計書 5.1 に書き加えた。
2. 「静的配置」を `position: static` だけとした。`CONTENT_COLLISION` は、見出しと段落どうしだけにした。テキストの要素と、テキストでない要素の組は、判定しない。→ 承認する。誤検知を避ける側の解釈である。
3. Evidence が足りないため、次の3点は近似になる。→ 受け入れる。Rule の設計書 5.1 に、制約として書いた。
   - ellipsis や line-clamp による意図した切り詰めを、除けない。
   - 見出しが固定要素の子孫かどうかが分からない。
   - stacking context の入れ子を扱えない。
4. 共通化の候補がある。→ CC-013 として登録し、T12f で行う。
   - 「入力のビューポートの、ある種類の Evidence を取り出す」処理を、`src/audit/rule-helpers.ts` にまとめる。
   - 文言の中の数値の書式を、`src/presentation/format.ts`（UI追補設計書の owner）にまとめる。
