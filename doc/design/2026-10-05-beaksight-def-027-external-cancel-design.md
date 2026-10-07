# BeakSight DEF-027 応答の前に取り消された main frame の読み込み 設計書

- 状態: ユーザーの判断（2026-10-05「Guard も直す」）を反映した設計。実装の後に独立レビューを受ける。
- 関係する文書: 不具合台帳の DEF-027、DEF-026、DEF-029、DEF-004。DEF-026 の設計書（`2026-10-05-beaksight-def-026-guard-canceled-document-design.md`）。Task 19 の前の整理の設計書（RC18a、C18g）。

## 1. 目的

### 1.1 起きたこと

- Task 21 の2回目（2026-10-05、headed）で、利用者が Ctrl+C を押し、ブラウザの画面を閉じた（ユーザーの回答）。読み込み中のモバイルの main frame の要求が `net::ERR_ABORTED` で失敗し、Guard が `HTTP_MAIN_FRAME_DELIVERY_FAILED` の違反にして、Run が ABORTED_BY_SAFETY（再開できない）で止まった。
- DEF-027 の調査（ローカル、headless）で、同じ形を再現できたのは、読み込み中のタブを外から閉じた場合だけだった（5/5）。外からの停止、再読み込み、別の URL への移動、ページのスクリプトによる `location.replace` の連続でも、同じ違反になる。どれも、応答（ヘッダ）の前に、ブラウザが main frame の文書の要求を取り消したものである。
- Guard の `onRequestFailed` は、許可した main frame の読み取りの `net::ERR_ABORTED` を、BeakSight 自身が閉じる途中（`ownerClosingPages`、閉じる段階）のほかは、違反にする。誰が取り消したかを、Guard は区別できないためである（ダウンロードへの切り替わり、外部スキームへの 3xx（RC18a）も `net::ERR_ABORTED` になる）。

### 1.2 ユーザーの判断（2026-10-05）

- 「Guard も直す」: Guard が証拠で、外からの取り消しを違反にしないようにする。あわせて、README に、headed では画面を操作せず、止めるときは Ctrl+C を使うことを書く（SU4 で行う）。

## 2. 決めたこと

### 2.1 違反にしない条件

Guard の `onRequestFailed` は、許可した main frame のナビゲーションの要求の `net::ERR_ABORTED` を、次のすべてに当たる場合だけ、違反にしない（今の、閉じる途中の扱いと、DEF-004、DEF-029 の扱いは変えない）。

1. 凍結の段階でない（凍結中は、今のとおり違反）。
2. 読み取りの method（`isReadMethod`）である。
3. Guard の page の CDP の session に、その要求（`networkId` が N の文書の要求）について、次の証拠が**すべて**そろっている:
   - (a) Guard が、N を Request の段階で一時停止し、許可して進めた（`Fetch.continueRequest` が成功した）。
   - (b) 同じ session の `Network.loadingFailed` で、`requestId` が N、`canceled` が真、`type` が `Document`、`errorText` が `net::ERR_ABORTED`。
   - (c) N について、Response の段階の一時停止も、`Network.responseReceived` も、リダイレクト（`Network.requestWillBeSent` の `redirectResponse`）も受けていない。応答のヘッダを1つでも受けた要求（ダウンロード、204・205、3xx）は、対象にしない。
4. Playwright の要求（`onRequestFailed` が受ける `Request`）と N を、既存の対応付けと同じ形（page、method、URL。`boundedCorrelationRequest` の上限の内側）で、1対1に対応付けられる。同じ page、method、URL の証拠が2つ以上あって区別できない場合は、違反のまま。対応付けた証拠は、1回だけ使う（使ったら消す）。

どれかに当たらなければ、今のとおり違反にする（fail-closed）。

### 2.1.1 限界（2026-10-05 追補。独立レビューの指摘1への判断）

- Guard が Request の段階で進める前に取り消された要求（例: ページのスクリプトが 0〜5ms の間隔で `location.replace` を続ける。一時停止の通知が来ない、または、通知が取り消しの後に届き `Fetch.continueRequest` が無効な ID で失敗する）は、(a) を満たさないので、違反のまま残る。レビュー担当の再現では、その要求はサーバに届いていなかった（いちばん安全な場合が、違反のまま残る）。
- Guard が一度も進めなかった要求を「送られていない」と言い切るには、Guard の Fetch の層を通らずに送られた経路がないことの、新しい安全の分析が要る。DEF-028 と同じく、記録だけにし、実在のサイトで起きたら調べる（止まるのは安全側）。
- 直ったのは、Guard が進めた後に、応答の前に取り消された要求（外からの停止、再読み込み、別の URL への移動、間隔の長い `location.replace` の連続など）である。
- (b) の `Network.loadingFailed` の `canceled` は、204 とダウンロードでも真になる。それらを外すのは (c)（応答を受けていない）である。(b) は「取り消しの証拠」、(c) は「応答がページに渡っていないことの証拠」で、両方がそろって初めて違反にしない。

### 2.2 証拠の受け方と待ち方

- 証拠は、Guard の page の session で受ける（DEF-026 で `Network.enable` を済ませている）。OOPIF の session は、main frame の要求を扱わないので、対象にしない。
- `onRequestFailed`（Playwright の session の事象）と、Guard の session の事象の順は決まっていない。証拠がまだなければ、決めた時間（DEF-026 と同じ `CANCELED_DOCUMENT_EVIDENCE_WAIT_MS`）だけ待つ。Guard や page が閉じる途中なら待たない。待つ間に session を閉じた場合は、証拠なしで終える（違反）。
- 覚える数と時間に上限を置く（DEF-026 と同じ考え方。上限を超えた証拠は覚えない。その要求は違反のまま）。session を閉じたら、すべて消す。
- 証拠の部品は、DEF-026 の `CanceledDocumentRegistry` を広げるか、隣に置く。どちらにするかは、実装者が既存の形に合わせて決め、報告する。同じ意味の記録を2か所に持たない。

### 2.3 記録

- 違反にしない場合も、読み込みは失敗のまま残る（`navigatePage` は `FAILED:net::ERR_ABORTED`）。Network の Evidence には、今のとおり、失敗した要求が残る。Safety Ledger の形（スキーマ）は変えない。
- サイトの不調の判定（`siteUnavailabilityOf`）では、`net::ERR_ABORTED` は不調ではない（変えない）。

### 2.4 タブを外から閉じた場合（2026-10-05 改訂。DEF-027-fix の Blocker への判断）

- 実装者の事実: 外からタブを閉じると、読み込みの取り消し（`net::ERR_ABORTED`）は 2.1 で違反にならなくなる。しかし、その直後に Guard の page の CDP の session が閉じ、page は BeakSight 自身が閉じる途中ではないので、今の `onSessionClose` が `CDP_SESSION_DETACHED` の違反を記録し、Context を閉じる（3/3）。
- 判断: `CDP_SESSION_DETACHED` は、違反のまま残す（閉じる段階は変えない）。Guard の session が外れると、一時停止中の要求が Guard を通らずにサーバに届くことがある（DEF-026 の調査の事実）。target が壊れたことの確かな証拠で、この違反を外すには、DEF-028 と同じく、新しい安全の分析が要る。後で DEF-028 と合わせて考える。
- そのため、headed の Run で利用者がタブやウィンドウを閉じると、今も違反で止まることがある（違反のコードが `CDP_SESSION_DETACHED` に変わる）。README に、画面を閉じないこと、止めるときは Ctrl+C を使うことを書く（サイトの不調の機能の SU4）。
- Page Auditor を通した場合は、Page Auditor が読み込みの失敗の直後に page を閉じる途中にするので、session の切断より先なら、違反にならない（実装者の確かめで 5/5。時刻の競争なので、いつもそうなるとは限らない）。テストは、`HTTP_MAIN_FRAME_DELIVERY_FAILED` が記録されないことと、記録される違反が `CDP_SESSION_DETACHED` だけであることを確かめる。
- 既存のテスト `passive-request-guard.test.ts` の「印のない page の close」（許可したナビゲーションの途中）は、違反になり、Context が閉じることは変わらない。記録される違反のコードが、`HTTP_MAIN_FRAME_DELIVERY_FAILED` から `CDP_SESSION_DETACHED` に変わる（決まりの変更による直し）。

## 3. SSOT と安全性への影響

| 項目 | owner | 扱い |
| --- | --- | --- |
| main frame の失敗を違反にするか | `src/safety/passive-request-guard.ts`（`onRequestFailed`） | 2.1 の分岐を加える |
| 文書の要求の、ブラウザによる取り消しの証拠 | `src/safety/passive-request-guard.ts`（DEF-026 の部品） | 応答の有無と、許可して進めた記録を加える |

- 安全の不変条件: 弱めない。違反にしないのは、Guard 自身が許可して進めた読み取りの文書の要求で、応答のヘッダを1つも受けずに、ブラウザが取り消したと、Guard の session の証拠で確かめた場合だけである。応答はページに渡っていない。ダウンロード、204・205、外部スキームへの 3xx は、応答のヘッダを受けるので、違反のまま。
- 取り消しの前に、要求がサーバに届いていることはある（調査の事実）。その要求は、Guard が許可した GET か HEAD なので、読み取りの不変条件に反しない。

## 4. テスト設計

- 結合（実際の Chromium、Guard の付いた Context、127.0.0.1 のサーバ。応答をしばらく返さないパスで、読み込みの途中に取り消す）:
  - 外からタブを閉じる（`Target.closeTarget`）、外から止める（`Page.stopLoading`）、再読み込み、別の URL への移動、ページのスクリプトによる `location.replace` の連続: 違反は0件。
  - Page Auditor を通して、外からタブを閉じる: 違反は0件、Run は ABORTED_BY_SAFETY にならない（調査の再現と同じ形）。
  - 対照（違反のまま）: 応答のヘッダの後の取り消し（204、`Content-Disposition: attachment`、`application/octet-stream`）。凍結の段階での取り消し。証拠を受けない場合（`Network.loadingFailed` を受けない形を作れなければ、単体の範囲で確かめる）。同じ page、method、URL の証拠が2つあって区別できない場合（単体）。
  - 修正の前に、結合テストが違反で失敗する（RED）ことを確かめる。
- 単体: 証拠の部品の、応答の有無、許可の記録、数と時間の上限、session を閉じたときの扱い、対応付けの1回だけの使用。
- 既存の Safety Gate のテスト（Guard、OOPIF、DEF-026、DEF-029）が、変えずに PASS する。

## 5. 設計変更履歴

| 日付 | 契機 | 変更内容 | 影響範囲 |
| --- | --- | --- | --- |
| 2026-10-05 | 初版（DEF-027 の調査、ユーザーの回答と判断） | - | Guard の `onRequestFailed`、取り消しの証拠の部品、README（SU4） |
| 2026-10-05 | DEF-027-fix の Blocker（外からタブを閉じると `CDP_SESSION_DETACHED` が記録される） | `CDP_SESSION_DETACHED` は違反のまま残す。テストの期待と、既存のテスト1件の直しを決めた（2.4） | Guard のテスト、README（SU4） |
| 2026-10-05 | 独立レビュー（DEF-027-029-review。Important 1、Minor 4） | Guard が進める前に取り消された要求は違反のまま残る限界を書いた。(b) と (c) の役割を書き分けた（2.1.1） | Guard のテスト（対照を加える）、台帳 |
