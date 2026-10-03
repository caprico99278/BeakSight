# C2 実装報告（要約。設計者が保存）

## 結論

完了。R3、R6、V1/M3、I1/Q3 と、追加の指示（`truncateText` で型を確かめること）を、TDD で修正した。`isolated-auditor.ts` は変更していない。

## 主な変更

- **safety-ledger**
  - 記録の上限に達したことを、`recordLimits` に記録する。`recordLimits` は、`truncated`、`droppedEventCount`、`uncountedBlockedRequestCount`、`truncatedTextCount`、`reachedCategories` を持つ。
  - 違反には、別の上限 `MAX_LEDGER_INVARIANT_VIOLATIONS = 256` を設けた。上限に達しても、既存の記録を上書きしない。総数は `invariantViolationCount` として数え続ける。
  - 長すぎる文字列は、切り詰めて記録し、その件数だけを数える。
  - `BlockedDownloadEvent.reason` は `'PASSIVE_DOWNLOAD' | 'INTERACTION_FROZEN'` のどちらかになる。
- **status**
  - `RunStatusInput` に、必須の `safetyLedgerTruncated` を加えた。true なら PARTIAL になる。
  - 違反の件数が、不正な値の場合や存在しない場合は、ABORTED_BY_SAFETY になる。
- **context-factory**
  - Context を `acceptDownloads: false` で作る。
  - `session.close()` で reject を握りつぶしていた処理を削除した。
- **passive-request-guard**
  - `CLOSED` 以外のすべてのフェーズで、ダウンロードを記録し、取り消す。
  - Passive フェーズで取り消しに失敗した場合は、`PASSIVE_DOWNLOAD_CANCEL_FAILED` を違反として記録し、Context を invalidate する。
- **text**
  - `truncateText` は、文字列でない入力に対して TypeError を投げる。
- **テスト**
  - 仕様違反を固定していた既存のテストを是正した（safety-ledger 4件、status 2か所、context-factory `:382`、isolated-interaction `:2505` と `:2404`）。是正したテストは、以前より条件を強めている。

## 検証

- 6ファイル・351件が PASS した（isolated-interaction、passive-request-guard、context-factory、safety-ledger、status、text）。
- 各項目で、RED になることを確かめてから GREEN にした。
- 全体の typecheck と、テスト全体は、並行して作業中の C1・C4・C7 の範囲のために失敗していた。これは C2 の範囲外の途中状態である。

## 発見事項と、設計者の判断

- 実装者が判断した3点を承認する。
  - 長すぎる文字列は件数を数えるだけにし、`truncated` にはしない。
  - Passive フェーズのダウンロードも取り消す。取り消しに失敗したら invalidate する。
  - 違反の件数が存在しない場合は、ABORTED_BY_SAFETY にする。
- `isolated-interaction.test.ts:2404` を是正したため、auditor の `lifecycle.reason` の文言が変わる。status は変わらない。→ 許容する。
- `isolated-auditor.ts:187` の `hasFreezeEvent` は、`blockedDownloads` の reason を見ていない。そのため、Passive フェーズのダウンロードでも、Interaction の結果が BLOCKED になる。→ C3 で、`reason === 'INTERACTION_FROZEN'` に絞る。
