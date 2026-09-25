# U16a 実装報告（要約。設計者が保存）

## 結論

完了した。次のものを作った。

- カタログ
- 理由のコードの説明
- 書式
- CSS のトークン
- HTML の部品
- UI Gate の UI02・UI03・UI05

全体のテストは、76ファイル・2635件が PASS した（3件は todo）。UI Gate のファイルは、13ms で終わった。

## U16b〜U17a が使う型と関数

- `src/presentation/catalog.ts`
  - トーンとカタログ
    - `DISPLAY_TONES`、`DisplaySpec`
    - `SEVERITY_CATALOG`（`group: SITE_QUALITY | SAFETY`）
    - `RUN_STATUS_CATALOG`、`PAGE_AUDIT_STATUS_CATALOG`、`INTERACTION_STATUS_CATALOG`、`INTERACTION_NOT_VERIFIABLE_KIND_CATALOG`
    - `EVIDENCE_TYPE_CATALOG`、`VIEWPORT_PROFILE_CATALOG`、`SCREENSHOT_CAPTURE_TYPE_CATALOG`
  - レポートの節
    - `REPORT_SECTIONS`、`REPORT_SECTION_CATALOG`
    - `REPORT_CATEGORY_SECTIONS`、`REPORT_CATEGORY_SECTION_CATALOG`
    - `FINDING_CATEGORY_CATALOG`（`section` を持つ）
  - 補助の関数: `sortByDisplayOrder`、`findingCategoriesInSection`
- `src/presentation/messages.ts`
  - `NOT_OBSERVED_TEXT`、`FORMAT_UNIT_TEXT`
  - `INCOMPLETE_REASON_DESCRIPTIONS`、`describeIncompleteReason`
  - `REPORT_COMPONENT_TEXT`、`screenshotLinkText`
- `src/presentation/format.ts`（追加分）
  - `DISPLAY_TIME_ZONE`
  - `formatNotObserved`、`formatDateTime`、`formatDuration`、`formatBytes`、`formatCount`
- `src/report/html-tokens.ts`
  - `REPORT_COLOR_TOKENS`、`REPORT_CLASS_NAMES`、`toneClassName`、`REPORT_STYLESHEET`
- `src/report/html-components.ts`
  - 基本: `escapeHtml`、`SafeHtml`、`htmlText`、`joinHtml`
  - バッジ: `render*Badge`
  - 表: `renderTableRow`、`renderTable`
  - Finding: `renderFindingRow`、`renderFindingTable`
  - URL: `renderUrl`
  - 参照: `renderEvidenceRef`、`renderScreenshotRef`
  - アンカーと節: `toAnchorId`、`renderSectionHeading`、`renderSection`
  - 本文: `renderParagraph`、`renderKeyValueList`
  - 文書: `renderDocument`（CSP の meta を含む）

## 実装者の判断と、設計者の判断

1. `format.ts` から `messages.ts` を import した。→ 承認する。
   - UI追補設計書 4.1 の依存の規則は、表示の層の外への依存を制限するものである。同じ表示の層の中の import は、許される。
   - UI追補設計書に、補足を書いた。
2. category の節を、グループとして扱った（`REPORT_CATEGORY_SECTIONS`）。→ 承認する。設計書 6.1.4 の対応と合う。
3. 指示書の一覧にない、カタログと部品を加えた。→ 承認する。U16c が止まらないためである。
4. 部品の日本語の文言は、`messages.ts` に置いた。→ 承認する。UI06 に合う。
5. `renderDocument` に、CSP の meta（`script-src 'none'` など）を入れた。→ 承認する。多重の守りになる。
6. 負の数と有限でない数は、「未観測」とする。解析できない日時は、そのまま返す。→ 承認する。
7. `DISPLAY_TIME_ZONE` は、設定の時間帯とは別の定数にした。→ 承認する。意味が違うためである。
8. Evidence の ID の接頭辞は、カタログに入れなかった。→ 承認する。owner は `ids.ts` である。
9. URL のリンクの先と、示す文字を分けた。→ 承認する。
