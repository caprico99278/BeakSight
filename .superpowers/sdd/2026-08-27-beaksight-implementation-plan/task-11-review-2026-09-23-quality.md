# Task 11 品質レビュー（2026-09-23、独立レビュー担当）

総合判定: 修正が必要（Critical 0 / Important 2 / Minor 4）

レビューした対象は、owner-retention/requestfailed 修正と、記録のない cleanup deadline・DOM作業量共有の修正（2026-09-22 brief）の両方を含む、現在のコード。

## 指摘

- **Q1 / Important**（`src/interaction/isolated-auditor.ts:335, 366, 390, 465, 489`、呼び出し先 `discover-candidates.ts:69, 371, 613`）: 作業フェーズのブラウザ内評価（`page.evaluate`、`evaluateHandle`、`handle.evaluate`、`getProperties`、`jsonValue`）に時間の上限がない。`setTimeout(()=>{while(true){}})` を仕込んだページで `page.evaluate` が5秒たっても完了しないことを実測した。敵対的なページでは `auditInteraction` が止まったままになり、クリーンアップの期限にも到達しない。また、可視判定でインライン style を正規表現で検査するとき（`discover-candidates.ts:425-431, 703-709`）、style 文字列の長さに上限がない（1MB で祖先1つあたり 0.84ms、DOM作業量の上限 16,384 まで回ると約14秒と推定）。期待: 各評価を `effectiveDeadlineAtMs` までの期限付きで待ち、期限を過ぎたら NOT_VERIFIABLE を返してクリーンアップに進む。style は長さを切り詰めてから検査する。
- **Q2 / Important**（`src/evidence/interaction-collector.ts:31-40`、`isolated-auditor.ts:524`）: 画面外にある、何も起きないボタンが VERIFIED になる。`boundingBox` はビューポート基準の座標で、click の前に要素が画面内にスクロールされるため、座標が変わる（実測で y が 2008 から 289 に変化）。その結果 `changedFields=['boundingBox']` となる。期待: スクロール量を差し引くか、スクロールしてから before を取る。画面外の無反応ボタンの回帰テストを追加する。
- **Q3 / Minor**（`src/browser/context-factory.ts:137-141`）: 仕様レビューの I1 と同じ。前回の close が非終端で失敗していると、それ以降の終端到達時の reject をすべて握りつぶす。`factory.closePassiveContext` の振る舞いと揃っていない。
- **Q4 / Minor**（`tests/integration/isolated-interaction.test.ts:3564, 3578, 3672`）: 240ms の判定枠に実ブラウザのセッション生成時間が含まれ、負荷が高いと失敗しうる（推測）。`:3672` は、前半の期限切れ（50ms）と reject（60ms）の差が10msしかなく、どちらが先でも同じ期待値で PASS するため、テスト名の内容を検証できていない。`INTERACTION_OWNER_CLOSE_TIMED_OUT` の記録を確認するべき。
- **Q5 / Minor**（`isolated-auditor.ts:527`）: 観測ループがフレームごとに文書の先頭から対象までを走査し直し、共有のDOM作業量を消費する。中規模のページでは十数フレームで上限に達しうる（推測）。
- **Q6 / Minor**: テストに不要な `as unknown as` が残っている（`:3506`、`:3853-3866`）。`discover-candidates.ts:834` の `raw as RawInteractionCandidate` で、`boundingBox` が null だと、上限付きのメッセージではなく TypeError になる。

## 再実行

4ファイル 290件 PASS（約88秒。内訳: isolated-interaction 132件/76秒、passive-request-guard 117件/6秒、context-factory 19件/1.3秒、interaction-policy 22件）。DOM作業量のテスト7件はそれぞれ約8秒かかる（タイムアウトは30秒）。`-t "Task 11 cleanup deadline"` を4並列で実行し、4回とも PASS。
