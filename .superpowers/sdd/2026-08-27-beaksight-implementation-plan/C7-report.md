# C7 実装報告（要約。設計者が保存）

## 結論

完了。V6、V9（console・network・performance・axe の4つ）、V10、V11、V12 を、RED を確かめてから GREEN にした。

- 担当範囲の8ファイル・100件が PASS した。
- テスト全体は、36ファイル・760件が PASS した。typecheck も PASS した。

## 変更した Evidence の形（C8 で使う）

- **Console**
  - `omittedConsoleMessageCount`、`omittedPageErrorCount` を追加した。
  - 各記録に `truncated` を追加した。
- **Network**
  - `omittedRequestCount`、`omittedResponseCount`、`omittedFailureCount` を追加した。
  - 各記録に、`isNavigationRequest`、`isMainFrame`（boolean、または null）、`truncated` を追加した。
  - responses に `transferSize` を追加した。値は、`OBSERVED`（ヘッダ・本文・合計の大きさ）、`NOT_OBSERVED`、`FAILED` のいずれか。
- **Accessibility**
  - 結果は、`{status:'COMPLETE', violations, incomplete}` か、`{status:'PARTIAL', reason:'DEADLINE_EXCEEDED'|'EVALUATION_FAILED', violations:[], incomplete:[]}` のどちらかになる。
  - 各ルールに `omittedNodeCount` を、各要素に `truncated` を追加した。
  - 第2引数で `{deadlineAtMs}` を受け取れるようにした。
  - axe の実行が失敗したときは、例外を投げずに `EVALUATION_FAILED` を返すようにした。
- **Performance**
  - `rating` を削除した。
  - `resources[]` に `sizeStatus`（`OBSERVED` / `CROSS_ORIGIN_RESTRICTED`）を追加した。
  - `resourceSummaries.*` に `sizeUnknownCount` を追加した。観測できなかった場合は、集計全体を null にする。
  - `resourceCoverage` と `truncation` を追加した。
  - PARTIAL の理由に `RESOURCE_LIMIT_REACHED` を追加した。
- **上限値**
  - `src/core/limits.ts` に、次の8つを追加した: `MAX_CONSOLE_MESSAGES`、`MAX_PAGE_ERRORS`、`MAX_CONSOLE_TEXT_LENGTH`、`MAX_ERROR_NAME_LENGTH`、`MAX_STACK_LENGTH`、`MAX_NETWORK_REQUESTS`、`MAX_HEADER_VALUE_LENGTH`、`MAX_RESOURCE_TIMING_ENTRIES`。

## 発見事項と、設計者の判断

1. `limits.ts` の冒頭のコメント（意味が同じ値だけを置く）が、今回の追加と合わない。これは、指示書が設計書 CC-007 の方針と食い違っていたためで、設計者の誤りである。
   → 方針を改める。`limits.ts` には、共通の上限と、Evidence を収集するときの上限を置く。特定のowner が意味を決める上限（Interaction 候補の上限など）は、そのowner に置く。設計書 3章を改訂し、コメントは F04 で直す。
2. 共通部品台帳への登録。→ 設計者が行う。
3. 対応していない小さな切り捨て（`clearResourceTimings` を検知できない、`statusText` に上限がない、axe の `help` などに上限がない）。→ 影響が小さいので見送る。
4. C8 への申し送り（`RESOURCE_LIMIT_REACHED` と、accessibility の PARTIAL の理由）。→ C8 の指示書に追記する。
