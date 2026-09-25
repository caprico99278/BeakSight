# C5 実装報告（要約。設計者が保存）

## 結論

完了。V4、V5（DOM の分）、V7（dom・color・layout）、V9（dom・color）、V14 を、RED を確かめてから GREEN にした。担当範囲に関係する14ファイル・179件が PASS した。

## 変更した Evidence の形（C8 で使う）

- **DomEvidence**
  - `duplicateIds: {id, count, truncated}[]` を追加した。
  - `truncation` を追加した。
  - 見出し・画像・フォームの各項目に `truncated` を追加した。
- **SemanticRegionKind**
  - `'other'` を追加した。
- **VisibleTextEvidence**
  - `truncated`、`ariaHiddenText`、`omittedRegionCount` を追加した。
  - `text` は、body の中のすべての可視テキストを、文書の順に並べたものに変えた。
  - `regions` は、landmark ごとの区分と、最後に置く `other` の区分からなる。
- **ImageDomEvidence**
  - `resolvedUrl` を追加した。
- **FormFieldEvidence**
  - `hasAriaLabel`、`hasAriaLabelledby`、`hasTitle` を追加した。
- **DOM_LIMITS**
  - `dom-collector.ts` に、新しく定義した。
- **ColorEvidence**
  - `textSamplesTruncated`、`omittedDistributionEntryCount` を追加した。
  - 各標本に `truncated` を追加した。
- **layout の VisibilityEvidence.visible**
  - `checkVisibility` の結果にした。

## 発見事項と、設計者の判断

1. 可視テキストを自前の走査で集めるようにしたので、innerText と結果が違う。
   - `text-transform` を反映しない。→ 許容する（元の文字列を記録する）。
   - `<select>` の option を含めない。→ 許容する。
   - `display:contents` の要素の直下のテキストが落ちる。→ 不具合として扱い、C5b で直す。
2. `VISIBILITY_CHECK_OPTIONS` の `contentVisibilityAuto: true` を使うと、描画が省かれている画面外の区画が不可視と判定されるおそれがある。
   → 設計の誤りと判断する。`false` に改める（設計書 5.5 を改訂し、F04 で値を変更する）。
3. 見出しは、可視判定をしていない。→ C5b で、ほかの要素と同じ可視判定にそろえる。
4. color は、aria-hidden を記録しない。→ 許容する。
5. `contracts.ts` の `DomEvidencePayload` とスキーマは、今の形と合っていない。→ C8 で整える。
6. `selectorFor` の重複。→ C6 と CC-008 の範囲で扱う。
