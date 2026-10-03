# R15d 実装報告（要約。設計者が保存）

## 結論

実装は完了した。ただし、`npm run verify` で、全2464件のうち1件が失敗した（`tests/integration/page-navigation.test.ts:191`）。
- `npm run typecheck` は PASS した。
- build も PASS した。

## Task 16・17 が使うシグネチャ

```ts
new RunCoordinator({ config, launchBrowser, createSafetyLedger, clock, now, outputDirectory,
  createPageAuditor?, collectSiteMetadata?, runPreflight?, collectRunEnvironment?, readToolVersion? })
run(): Promise<AuditRunResult>
runArtifactDirectory(outputDirectory, runId): string   // join(根, runId)。Task 16 の書き出しも、この関数で求める
RETRYABLE_NAVIGATION_FAILURE_DETAILS                   // navigationFailureDetail で作る
viewportSizeFor(config, profile)                        // src/config/viewport-size.ts（CC-020）
```

- 新しいファイル: `run-coordinator.ts`、`crawl-frontier.ts`（URL の状態）、`run-aggregation.ts`（集計）、`src/config/viewport-size.ts`
- `run()` が reject するのは、次の2つの場合だけである。それ以外の例外は、`unhandledFailures` に数え、Run を確定して返す。
  - 時計が不正な値を返した場合
  - `package.json` を読めない場合
- テストは、単体テスト34件と、統合テスト11件である。統合テストでは、次のことを、実際の Chromium で確かめた。
  - 深さ3までのクロール
  - `BROKEN_INTERNAL_LINK`
  - sitemap の2つの Rule
  - 上限による `PARTIAL`
  - スキーマとの整合
  - GET 以外が送られないこと
  - fixture の全体で `COMPLETE` になること

## 実装者の判断と、設計者の判断

1. Run のディレクトリは、`<outputDirectory>/<runId>` とする。→ 承認する。Task 16 の配置（`beaksight-output/<run-id>/`）に合う。
2. テスト用の差し替え口を加えた。対象は、`runPreflight`、`collectRunEnvironment`、`readToolVersion` である。→ 承認する。
3. 予期しない例外が起きた場合は、クロールを止める。残りの URL は、`EXECUTION_INCOMPLETE` の SKIPPED とする。Run の理由には、`UNHANDLED_FAILURE` を加える。→ 承認する。
4. metadata の取得の失敗は、Evidence に残すだけにする。閉じる処理の失敗は、Run の理由にする。→ 承認する。
5. Safety の集計には、Coordinator の Ledger と、再試行の前の試行の分も含める。→ 承認する。
6. 上限の理由を先に並べる。スキーマに合わない場合の理由は、`REQUIRED_ARTIFACT_INVALID` とし、detail を `<スキーマ>:<ID>:<最初の誤り>` とする。→ 承認する。
7. `effectiveConfig` には、`structuredClone` した写しを使う。→ 承認する。
8. `evidenceOfType` を、orchestration から使った。→ 承認する。台帳の「使ってよい場所」を、orchestration にも広げた。
9. テストより先に実装を書いた。代わりに、実装をわざと壊し、10通りでテストが失敗することを確かめた。→ 受け入れる。TDD の順序の逸脱として、記録する。

## 発見事項と、設計者の判断

1. `page-navigation.test.ts` の1件（191行目）が、後片付けの期限切れ（30秒）で失敗する。
   - 判断: 既存不具合 DEF-005 として登録し、原因の調査と修正を依頼する。
   - DEF-004 の後の設計者の verify では、PASS していた。
   - 製品のコードで、Context を閉じる処理が止まる問題かどうかを、確かめる必要がある。
2. 重複の候補が3つある。
   - `UNHANDLED_FAILURE` の `<場面>:<メッセージ>` の組み立て
   - Rule の失敗の理由の `${ruleId}:${message}`
   - 違反の件数の上限付きの加算
   - 判断: CC-021 として登録する。Task 16 の前に、整理のサブタスクで行う。
3. 共通部品台帳への登録。→ 設計者が登録した。
