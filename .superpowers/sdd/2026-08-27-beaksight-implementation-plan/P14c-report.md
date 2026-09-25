# P14c 実装報告（要約。設計者が保存）

## 結論

完了した。`PageAuditor.audit(url, pageId)` は、Desktop と Mobile をこの順に監査する。Interaction の段階は、まだ含まない。新しい統合テスト19件と `npm run typecheck` は PASS した。

- 大きさの指定のない SVG 画像では、`IMAGE_LOAD_FAILED` は出なかった。Chromium は、この画像を 300×150 と報告した。
- 各段階の処理は、crash の事象と同時に待つ。これで、crash した page に対する処理で止まり続けることを避ける。

## シグネチャ

```ts
new PageAuditor({ contextFactory, config, allocator, clock, now, screenshotRootDirectory, createRuleEngine?, collectors? })
audit(url: NormalizedHttpUrlEvidence, pageId: PageId): Promise<PageAuditOutcome>
```

## 実装者の判断と、設計者の判断

1. 閉じる処理と Context の作成が失敗した場合は、理由を `UNHANDLED_FAILURE` とし、detail を `<場面>:<メッセージ>` とする。
   - 閉じる処理の失敗は、`PARTIAL` にする。
   - 作成の失敗は、`FAILED` にし、`navigationOutcome` を null にする。
   - → 承認する。
2. ページ全体の理由には、両方のビューポートの理由を並べ、同じものは1つにまとめる。→ 承認する。
   - Run Coordinator（Task 15）は、件数を、ビューポートの理由とページの理由の両方から数えてはいけない。これを、Task 15 の設計に書いた。
3. 理由の付け方を、次のようにする。→ 承認する。
   - DOM の準備は、`DOM_READINESS_FAILED` にする。
   - scroll は、scroll の理由のコードにし、detail を `scroll` にする。
   - 先頭に戻せなかった場合は、その理由を記録する。
4. 幅の走査の理由は、`stress-layout:<理由>` とする。主要な layout が例外を投げた場合は、走査しない。→ 承認する。
5. crash の理由が `EVALUATION_FAILED` になり、crash したことが結果から読み取れない。→ P14d で直す。
   - 理由のコードに、`PAGE_CRASHED` を加える。
   - crash した段階の理由は、`<段階>:PAGE_CRASHED` とする。
   - 設計書 4.5.5 を直した。
6. Rule の評価の失敗の detail は、`<ruleId>:<message>` とする。→ 承認する。
7. スクリーンショットは、根のディレクトリの下の `pages/<pageId>/<ビューポート>/viewport.png` と `full-page.png` に置く。→ 承認する。
   - Task 16 の artifact の配置は、これに合わせる。Task 16 の設計に書いた。
8. performance の照合には、収集の直前の network の snapshot を使う。記録する Evidence は、収集を終えた後に snapshot を取り直したものとする。→ 承認する。

## 発見事項と、設計者の判断

1. `discoverLinks` の `evaluateAll` には、期限がない。crash した page に対して呼ぶと、終わらない。
   - 判断: 受け入れる。呼び出し元は Page Auditor だけで、Page Auditor が crash と同時に待つ。
2. 「page を閉じてから Context を閉じる」処理が、2か所にある。1つは Page Auditor、もう1つは `stress-session.ts` である。
   - 判断: CC-018 として登録する。CC-017 と同じ時期（Task 14 のチェックポイントの後）に行う。
