# BeakSight DEF-026 Guard の CDP の層で、ブラウザが取り消した文書の要求を違反にしない 設計書

- 状態: 設計者の判断（2026-10-05）。不具合の修正で、仕様の範囲は変えない。実装の後に独立レビューを受ける。
- 対象: `src/safety/passive-request-guard.ts`（Guard の CDP の層の文書の横取り）、`src/browser/playwright-errors.ts`（Playwright と CDP のエラーの文言の閉じた一覧）
- 関係: Task 19 の前の整理の設計書（`2026-09-25-beaksight-pre-task-19-cleanup-design.md`）の C18g（外部スキームへのリダイレクトを、たどる前に止める）と C18i（OOPIF の session）。実装タスク指示の Safety Invariants。
- 不具合台帳: 作業記録置き場の `defects.md` の DEF-026。調査: `DEF-026-investigation-brief.md` と、その報告（`progress.md`）

## 1. 起きたこと

- Task 21（本来の監査対象のサイト）の1回目（2026-10-05）で、1ページ目の Interaction の Context の読み込みの初めに、`CDP_CONTINUE_REQUEST_FAILED`（`Fetch.continueRequest: Invalid InterceptionId.`）が2件記録され、Guard が Context を閉じた。Run は `ABORTED_BY_SAFETY` で止まった。
- 調査（ローカルの fixture で再現）で分かったこと（事実）:
  - ページの読み込みの途中で、iframe が消される、`src` が変わる、iframe の読み込み中に main frame が別の URL へ移る、などがあると、ブラウザは、その iframe の文書の要求を取り消す。
  - Guard の CDP の層は、文書の要求を、Playwright の route より先に一時停止する。一時停止の通知を受けてから、Guard の命令（`Fetch.continueRequest`、`Fetch.failRequest`）がブラウザに届くまでの間に要求が取り消されると、一時停止の ID が無効になり、命令が `Invalid InterceptionId` で失敗する。Guard は、命令の失敗を fail-closed で違反にする。
  - 取り消しの事象は、命令の失敗の応答より先に届いた。Playwright の `requestfailed`（`net::ERR_ABORTED`）は 352/352件、Guard の session で Network を有効にした場合の `Network.loadingFailed`（`canceled: true`。`requestId` は、一時停止の通知の `networkId` と同じ）は 103/103件。
  - Request の段階で取り消された要求（287件）は、サーバに1件も届かなかった。Response の段階の取り消しでは、要求は届いていたが、Guard と route の両方が許可した GET で、応答がページに渡らなかっただけだった。`Fetch.failRequest`（止める命令）が同じ理由で失敗した場合も、止めたかった要求は届かなかった。
  - 読み込み直しの Context（`REVISIT`）では、キャッシュから返したスクリプトがすぐに動くので、この競合が起きやすい（実験で 20回中 3〜4回）。iframe を消すページでは、`PRIMARY` でも起きる。

## 2. 方針

- 命令の失敗のうち、次の2つを満たす場合だけ、違反にしない（「ブラウザが取り消した要求」として扱う）。
  1. 失敗の文言が、一時停止の ID が無効であることを表す、閉じた一覧の文言と完全に一致する（page の session の形と、OOPIF の session の形の2つ。`src/browser/playwright-errors.ts` に置く）。
  2. その要求の取り消しの証拠を、Guard が受けている。証拠は、同じ session の `Network.loadingFailed` で、`canceled` が真で、`requestId` が、一時停止の通知の `networkId` と同じもの。
- どちらかを満たさない場合は、今のとおり違反にし、Context を閉じる（fail-closed）。
  - 一時停止の通知に `networkId` がない場合も、違反にする。
  - 取り消しの証拠が、命令の失敗の応答より遅れて届く場合に備え、証拠を短い時間（名前付きの定数。500ms）だけ待つ。待っても届かなければ、違反にする（下の「取り消しの証拠は、一時停止の通知より先に届く」の項目も参照）。
- エラーの文言だけで違反にしない案は、採らない。Guard 自身の不具合（同じ ID への2回目の命令など）による失敗も隠してしまうためである。
- 違反にしなかった場合の扱い:
  - `Fetch.continueRequest` の失敗（Guard は進めるつもりだった）: 記録を増やさない（ページが取り消した要求で、BeakSight の判定の結果は変わらない）。
  - `Fetch.failRequest` の失敗（Guard は止めるつもりだった）: 今の止めた記録（`recordBlockedDecision`）を、止める命令が成功した場合と同じく残す（止めたかった要求は、送られていない）。main frame の予期した失敗の登録（`expectedCdpFailures`）も、成功した場合と同じ扱いにする。
- 取り消しの証拠を受けるため、Guard の CDP の session（page の session と、各 OOPIF の session）で、`Network.enable` を行う。`Network.enable` が失敗した場合は、今の Guard の取り付けの失敗と同じく扱う（fail-closed）。
- 取り消しの証拠は、一時停止の通知より先に届く（DEF-026-fix の実験。282件のすべてで、一時停止の通知の 3〜55ms 前に届いた。2026-10-05 Blocker の解消）。そのため、session ごとに、`Network.loadingFailed` のうち、`canceled` が真で、`type` が `Document` のものの `requestId` を、一時停止の有無によらず覚える。覚える数と時間には上限を置く（名前付きの定数。数は 256、時間は 5秒。40個の iframe を読むページで、同時に約40件になったことから、余裕を見て決めた）。上限を超えた分は覚えない（その要求の失敗は、違反のまま。fail-closed）。
- 命令が失敗したら、一時停止の通知の `networkId` が、覚えた中にあるかを見る。なければ、短い時間（500ms）だけ待つ（後から届く場合に備える）。それでもなければ、違反にする。
- 覚えた証拠は、時間の上限（5秒）か、session を閉じるときにだけ消す。命令が成功した要求の証拠も、すぐには消さない（同じ `networkId` の Response の段階の一時停止と取り消しが、Request の段階の成功の処理より先に Node に届くことがあり、成功の時点で消すと、後の段階の正しい判定を壊すため。DEF-026-fix の報告）。期限を過ぎた証拠では、違反を防がない。
- Playwright の route（Guard の本体）、許可の判定、凍結の段階、閉じている段階、届け方の部品の分岐は、変えない。

## 3. 安全への影響

- 違反にしないのは、ブラウザ自身が取り消した要求で、取り消しの証拠を ID で対応付けられたものだけである。調査では、そうした要求がサーバに届いた例はなかった。届いた場合も（Response の段階）、Guard と route の両方が許可した GET である。
- 証拠がない失敗、文言が違う失敗（対象の session が閉じた、など）は、今のとおり違反にする。fail-closed の性質は変えない。

## 4. テスト設計

- 単体: 偽の channel と事象で、次を確かめる。
  - 文言が一覧と一致し、証拠がある → 違反にしない（continue）。止めた記録が残る（fail）。
  - 文言が一致し、証拠がない（待っても届かない）→ 違反。
  - 文言が違う → 違反。
  - 証拠が、失敗の応答の後に、待ちの時間の中で届く → 違反にしない。
  - `networkId` がない → 違反。
  - 覚える数の上限を超えた → 違反。
  - `Network.enable` の失敗 → 取り付けの失敗。
- 結合（ローカルの fixture）: 読み込みの途中で iframe を消すページ（同じ Origin、許可 Origin の外、OOPIF の中の入れ子）を、CLI の起動の設定で、`PRIMARY` と `REVISIT` の Context で開く。違反が0件で、Context が閉じず、取り消された要求がサーバに届かない（Request の段階）ことを確かめる。修正の前に、同じテストが違反で失敗する（RED）ことを確かめる。
- 既存の Safety Gate、Auditor Gate、外部スキーム、OOPIF のテストが、変えずに PASS する。

## 5. 対象外

- Response の段階で取り消された要求の、応答の扱い（今のとおり、ページに渡らない）。
- 記録の形（Safety Ledger のスキーマ）の変更。

## 6. 設計変更履歴

| 日付 | 契機 | 変更内容 | 影響範囲 |
| --- | --- | --- | --- |
| 2026-10-05 | 初版（DEF-026。Task 21 の1回目が違反で止まった。調査で原因を確定） | - | Guard の CDP の層、`playwright-errors.ts` |
| 2026-10-05 | Blocker: DEF-026-fix の報告（取り消しの証拠が、一時停止の通知より先に届く） | 取り消しの証拠を、一時停止の有無によらず、文書の要求の取り消しだけを、上限（256件、5秒）付きで覚えることにした（2章） | DEF-026-fix |
| 2026-10-05 | DEF-026-fix の報告 | 証拠を消す時期（時間の上限か session を閉じるときだけ）を2章に加えた | DEF-026-fix |
| 2026-10-05 | DEF-027 で部品を広げた（独立レビューの指摘3） | 取り消しの証拠は、時間の上限と session を閉じるときのほかに、DEF-027 の確かめ（main frame の要求で、応答の段階の一時停止がない場合）で使ったときにも消す。DEF-026 の命令の判定を壊す経路はない（レビュー担当が確かめた）。詳しくは DEF-027 の設計書 2.1、2.2 | なし（記述の追補） |
