# C18e 実装報告（CC-008 の残りと、CC-010 の残りの調査）

## 結論
一部完了。第1段階（CC-008 の残り）は完了した。第2段階（CC-010 の残り）は、調べて報告するところで止めた（指示どおり）。

## 第1段階: まとめ方
- `src/interaction/discover-candidates.ts` のブラウザ内の処理を、1つの関数 `interactionCandidateProbe` にまとめた。入力の `mode`（`DISCOVER`、`RESOLVE`、`INSPECT`）で処理を選ぶ。1324行から1194行に減った。
- 作業量のカウンタ、要素の走査（`nextCandidateElement`）、テキストの切り詰め、可視判定、アクセシブルネーム、候補の組み立て（`collectCandidate`）、`incompleteStatus` を、内側の関数として1つだけ持つ。
- `page.evaluate`・`page.evaluateHandle` は（入力）で、`ElementHandle.evaluate` は（要素, 入力）で関数を呼ぶ。2つ目の引数の有無で入力を見分ける。型のための別名 `pageInteractionCandidateProbe` と `handleInteractionCandidateProbe` を置いた。
- `resolveInteractionCandidateHandle` の中の同じ走査も、`RESOLVE` のモードとしてまとめた（指示書の2関数の外。判断を報告）。
- `INSPECT` は、保持した要素が文書にあるか（`isConnected`）を確かめてから走査する（走査は遅延して作る）。
- 打ち切りの状態の決め方（テキストのノードの上限なら `TEXT_NODE_LIMIT_REACHED`、それ以外は `DOM_WORK_BUDGET_REACHED`）は、探索と読み取りで同じだったので、`incompleteStatus()` の1か所にした。
- Node 側の変更: 戻り値を `unknown` で受ける。`completeness` の確認を型の述語 `isDiscoveryCompleteness` にした（判定は同じ）。
- テストのファイルは変えていない。

## 第1段階: まとめる前と後の比べ方
- scratchpad に記録用のスクリプトを置き、リポジトリの vitest で実行した。Chromium は headless だけ。外への通信はすべて止めた。
- 対象: `fixtures/site` のすべての HTML（止まり続ける `page-auditor-busy-loop.html` を除く）と、境界を試す自作のページ10種。JS の有効と無効で、合わせて256件。
- 記録: 探索の結果の全体。作業量の上限を0から使った量まで変えた、探索・解決・読み取りの状態・作業量・結果のハッシュ（約94,000通り）。101番目以降の要素、body、切り離した要素の読み取り。
- 通った状態: `COMPLETE`、`CANDIDATE_LIMIT_REACHED`、`DOM_WORK_BUDGET_REACHED`、`TEXT_NODE_LIMIT_REACHED`、`CONNECTED`、`DISCONNECTED`。
- 結果: まとめる前の2回の記録（before1、before2）と、まとめた後の記録（after1）は、`js:animation-frame-style-button.html` の1件を除いて一致した。その1件は、アニメーションで style の値（`--phase`）が毎回変わるためで、before1 と before2 の間でも違う。`--phase` を伏せると、3つがすべて一致した。

## 第1段階: テスト（実装者）
- `isolated-interaction`、`page-auditor-interaction`、`schema-validator`: 3ファイル、785件 PASS
- `safety-gates`、`auditor-gates`、`gate-fixtures`、`passive-request-guard`: 4ファイル、347件 PASS
- `tests/architecture`（ARCH と UI）: 3ファイル、50件 PASS
- `npm run typecheck`: PASS。`spawn EPERM` は起きなかった。

## 第2段階: 調べた結果（要約）
- `reason` の値は、すべて `src/interaction/isolated-auditor.ts` から来る。
  - REJECTED_UNSAFE: 9種のコード（`INTERACTION_REJECTION_REASONS`、`evidence-types.ts:1326`。`:1456`）
  - NOT_VERIFIABLE: 54個のコードに対応する英文（`:140-352`）。英文とコード・値の連結（`:575-578`、`:584-587`、`:1582`）。click の期限切れのエラーの文言（`:623-627`）
  - VERIFIED: `'Observable interaction state changed'`（`:1609`）
  - BLOCKED_BY_SAFETY: `'Interaction activity was blocked by safety freeze'`（`:656`、`:1503`、`:1586`、`:1592`）、`'Interaction owner close reported a safety failure'`（`:663`）
  - EXECUTION_FAILED: 整えたエラーの文言。空なら `'Interaction click failed'`（`:119`）か `'Interaction execution failed'`（`:417`）
- `work.reason` は同じ値。最終の status が BLOCKED_BY_SAFETY に変わった場合だけ違う。
- `lifecycle.reason`: null、`INTERACTION_SESSION_NOT_OPENED_LIFECYCLE_REASON`、`'Interaction owner close timed out…'`、close のエラーの文言（`:889`、`:1698`、`:1727-1729`、`:1762`）
- 使う場所: 型 `evidence-types.ts:1384-1415`、記録 `page-auditor.ts:745-746`、スキーマ `page.schema.json:2108`・`:2118`・`:2126`、表示用モデル `view-model.ts:246-255`・`:456-465`、HTML `html-report.ts:346`（`renderCode`）。バンドルは `page.json` をそのまま入れる。Rule は読まない（`run-aggregation.ts:91` は `status` と `notVerifiableKind` だけ）。
- 案A（推奨）: `reason` を閉じた一覧のコードにし、`reasonDetail` を加える。案B: `reason` の英文を残し、`reasonCode` を加える。
- 案A の影響: スキーマ、型、`isolated-auditor.ts`、`view-model.ts`、`html-report.ts`、`messages.ts`（約67個の説明）。テストの期待値は、上限で数えて `isolated-interaction` 約163行、`schema-validator` 約68行、`audit-run-fixture` 21行、`view-model` 18行、`chatgpt-bundle` 9行、`html-report` 4行、`safety-gates` 4行、`page-auditor-interaction` 2行。

## 発見事項
- `discover-candidates.ts` の `domWork.exhausted` は、書き込まれるだけで読まれない（以前から）。
- `CLICK_TIMED_OUT` の英文（`:301`）と、EXECUTION_FAILED の代わりの文言（`:119`）が同じで、英文では見分けられない。

## 設計者の判断（2026-09-25）
1. `resolveInteractionCandidateHandle` の走査もまとめたこと: 受け入れる。同じ複製であり、CC-008 の目的に合う。
2. 2つ目の引数の有無で入力を見分けること: 受け入れる。Playwright の呼び方に合っており、関数の先頭のコメントに前提が書かれている。256件の比べ方で同じ結果を確かめている。
3. 共通部品台帳: `interactionCandidateProbe` を設計者が載せる。
4. 第2段階: 案A を採る（設計書 5.1）。
   - `lifecycle.reason` も同じ形にする。
   - スキーマの版は上げない（未公開。この整理の中のほかの変更でも上げていない）。
   - 説明の文言を日本語にすることは、UI 追補設計書で承認済みの範囲である。
   - 実装は C18n（Evidence、スキーマ、`isolated-auditor.ts`）と C18o（説明と表示）に分ける。
- 発見事項の `domWork.exhausted` は、C18n で消す。`CLICK_TIMED_OUT` の見分けは、案A で解消する。

## 未実行項目（実装者）
- `npm run verify` と `npm run build`（並行作業のため。設計者が実行する）。

## 設計者の verify（2026-09-25。C18e・C18k・C18k-fix-round-1 の後）

- `npm run verify`: 終了コード 0。型チェック PASS。98ファイル、3,523件が PASS（失敗 0）。ビルド PASS。テストの所要時間は 328秒。
