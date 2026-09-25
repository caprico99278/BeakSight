# P18c 実装報告（要約。設計者が保存）

## 結論

完了した。担当の8ファイル（611件）と typecheck は PASS した。並行作業のため、verify は実行していない。Guard と factory は、変えていない。

## 期限を付けた箇所（RP18 用）

| ファイル:行 | 期限の値 | 期限を過ぎたときの扱い |
| --- | --- | --- |
| `page-auditor.ts:339` Passive の Context と page の作成 | `SESSION_OPEN_TIMEOUT_MS` とページの期限の早い方 | ビューポートを `FAILED` にし、`{code:'DEADLINE_EXCEEDED', detail:'passive-context'}` を付ける。Context は部品が閉じる |
| `page-auditor.ts:479` page と Context の終了（`finally`） | page は `PAGE_CLOSE_TIMEOUT_MS`、Context は `CONTEXT_CLOSE_TIMEOUT_MS` | `UNHANDLED_FAILURE`（`passive-page-close:` か `passive-context-close:`） |
| `page-auditor.ts:716-722` Interaction の `ContextConstructionError` の Context の終了 | `CONTEXT_CLOSE_TIMEOUT_MS` | `interaction-context-close:` |
| `page-auditor.ts:521` 幅の走査の session の作成と終了 | 作成は `SESSION_OPEN_TIMEOUT_MS` と `collectorDeadlineAtMs` の早い方 | 今の失敗と同じ `stress-layout:EVALUATION_FAILED` |
| `isolated-auditor.ts:1664` Interaction の session の作成 | 読み込みの期限（候補の予算の中）と `SESSION_OPEN_TIMEOUT_MS` の早い方 | 結果を `NOT_VERIFIABLE`（`CHECK_NOT_COMPLETED`、`SESSION_OPEN_DEADLINE`）にする。遅れて届いた session は閉じる |
| `page-auditor.ts:708` 遅れて届いた `ContextConstructionError` | `CONTEXT_CLOSE_TIMEOUT_MS` | Context を閉じ、結果は捨てる |
| `isolated-auditor.ts:1313` 凍結を待つ処理（`failClosed` の無効化を含む） | 凍結を始めてから `CONTEXT_CLOSE_TIMEOUT_MS` | 待つのをやめ、今の凍結の失敗と同じ `EXECUTION_FAILED` にする。違反は加えず、Guard の状態も変えない |

- DEF-006 のテストは、12,908ms から 3,927ms になった。残りは、実際の監査の時間である。
  - 条件は、「page を閉じ始めてから Context を閉じ始めるまでが、注入した期限以上、`PAGE_CLOSE_TIMEOUT_MS` 未満」になった。元より厳しい。
- `layout-collector.ts` の変更は、不要だった。P18a で、期限を守る形になっていた。

## 実装者の判断と、設計者の判断

1. 作成の期限切れの理由を、既存のコードの `{code:'DEADLINE_EXCEEDED', detail:'passive-context'}` にした。→ 承認する。
   - `COLLECTOR_INCOMPLETE` の形は、作成に当たる段階の名前がないため、使わなかった。
2. Interaction の対応表に、`SESSION_OPEN_DEADLINE` を加えた。→ 承認する。
   - 原因を区別するためである。
   - 英文の理由は、CC-010 の残り（Task 18 の後）で扱う。
3. session を作れなかった場合の結果は、必須の項目を次の値で埋めた。その結果、Page Auditor は、中身が空の INTERACTION の Safety の Evidence を記録する。→ 承認する。
   - `lifecycle` は、`CLOSED`（理由付き）である。
   - `safety` は、空の Ledger の snapshot である。
   - 観測した事象がないことを、そのまま記録する形である。事象を隠していない。
4. 凍結を待つ期限を、`CONTEXT_CLOSE_TIMEOUT_MS` にした。→ 承認する。
   - 待つ対象は、Context を閉じる処理（無効化）である。
   - 候補の期限を過ぎた後でも、凍結の成功は受け取る必要がある。
   - 凍結が止まった場合に限り、候補の予算を最大5秒超える。これは受け入れる。
5. 幅の走査の `notAfterMs` に、`collectorDeadlineAtMs`（ページの期限の500ms前）を渡した。→ 承認する。

## 発見事項と、設計者の判断

1. `layout-collector.ts` の変更は、不要だった。→ 確認した。
2. 共通部品台帳の更新。→ 設計者が行った。
3. 指示書の `awaitInteractionBrowserWork` は、実際には `awaitBrowserWork` だった。→ 設計者の書き誤りである。
