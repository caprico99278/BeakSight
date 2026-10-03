# P14d 実装報告（要約。設計者が保存）

## 結論

完了した。Page Auditor に、Interaction の段階を加えた。crash の理由は `<段階>:PAGE_CRASHED` にした。実装者の報告では、`npm run verify` は PASS した（58ファイル、2148件。build を含む）。

- 候補は、除外されるものも含めて、すべて `auditInteraction` に渡す。Interaction の Safety の Evidence を入力にそろえてから、Rule を評価する。
  - 除外の事実から、`SAFETY_INTERACTION_CANDIDATE_EXCLUDED` と `SAFETY_EXTERNAL_ACTION_BLOCKED` の Finding ができることを、テストで確かめた。
- 予算が足りない場合の理由は `interaction:budget:remaining=<N>`、後片付けに失敗した場合の理由は `interaction:cleanup:remaining=<N>` とする。どちらも `PARTIAL` にする。
- 所要時間の目安は、次のとおり。
  - `VERIFIED` になるトグル1つ: 約1.3秒
  - 除外される候補1つ: 約0.14秒

## 実装者の判断と、設計者の判断

1. 候補ごとの結果の状態では、ビューポートの状態を変えない。`PARTIAL` にするのは、次の4つの場合だけである。
   - 候補の発見が完了しない。
   - 予算が足りない。
   - 後片付けに失敗する。
   - `auditInteraction` が例外を投げる。
   - → 承認する。
     - 候補の監査は最後まで実行されている。その結果は、Evidence に残っていて、隠していない。
     - ただし、Run Status への反映は、Task 15 で次のように設計する。Task 14〜17 の設計書 5.4 に書いた。
       - `EXECUTION_FAILED`: 作業の失敗とする（`failedRequiredWork`）。
       - `NOT_VERIFIABLE` のうち、確かめる作業そのものができなかったもの（期限切れ、下準備の失敗など）: 未確認の作業とする（`notVerifiedRequiredWork`）。
       - `NOT_VERIFIABLE` のうち、確かめたが変化が見えなかったもの: サイトの振る舞いの結果とする。Run の完了を妨げない。件数は、レポートで隠さずに示す。
       - この2種類を区別するために、Interaction の Evidence に、構造化した理由のコードを持たせる。Task 15 の前に、サブタスクとして行う。
2. detail の形は、`interaction:budget:remaining=<N>` と `interaction:cleanup:remaining=<N>` とする。→ 承認する。
3. 期限は、`#interactionCandidateDeadline` の1か所で計算し、`stageDeadline` を使う。→ 承認する。
4. `auditInteraction` が、後片付けの失敗以外の例外を投げた場合は、`interaction:<理由>` を記録し、次の候補に進む。→ 承認する。
5. `PAGE_CRASHED` は、detail の理由の部分に使う。→ 承認する。
6. 倍数の定数 `INTERACTION_TIMEOUT_COUNT_PER_CANDIDATE` を、`page-auditor.ts` に置いた。→ チェックポイントの後の整理で、`src/core/limits.ts` に移す。
7. Safety の Evidence の順序は、Passive → Interaction → 幅の走査とする。→ 承認する。
8. `targetUrl` には、要求した正規化済みのURLを渡す。→ 承認する。

## 発見事項と、設計者の判断

- `INTERACTION_CLEANUP_ALLOWANCE_MS` のコメントが、古い。→ チェックポイントの後の整理で直す。
