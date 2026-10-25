# 設計書 — 外部のアプリの起動を Chromium の側で止める（EL）

状態: ユーザーの判断（2026-10-24）による。調べ（EL-0）の前。
作成: 2026-10-24（設計者）

## 1. 経緯

- ユーザーの依頼（2026-10-24）「テスト時のOutlook起動も抑制できるなら実施してほしい」。
- 調べ（`.superpowers/sdd/2026-08-27-beaksight-implementation-plan/defects.md` の DEF-171）で分かったこと:
  - Outlook（`olk.exe`）は、守りのない対照ではなく、Guard を付けた Interaction の Context から起動していた（`safety-gates` の GATE-S03 の mailto のボタン、CLI の Chromium、混雑の下）。Guard は `request` の事象で外部スキームを検出して Context を閉じるが、閉じるより先に Chromium が OS の handler を呼ぶ。
  - 本番の監査と同じ headed の Chromium（`channel: 'chromium'`）でも、確認の窓は出ずにそのまま起動する（守りのない Context、7 経路: goto・`location.href`・click・iframe・302 の main と frame・`window.open`）。既定の headless shell は起動しない。
  - 設計では、この経路は「検出して違反にし、Context を閉じる。起動そのものは防げない」既知の限界だった（`doc/spec/safety.md` の 36 行・195〜199 行、`passive-request-guard.ts` の R7d）。
  - 効かないもの: Chromium の起動の引数（`--disable-features=ExternalProtocolDialog` など）、`protocol_handler.*` の設定、CDP の命令、`context.route`、CDP の Fetch。
  - 効いたもの: 使い捨ての一時のプロファイルの `Default/Preferences` に `policy.url_blocklist`（`*`）と `policy.url_allowlist`（http・https・about・data・blob）を置く形。CLI の新しい headless と headed の両方で 0/7。
- ユーザーの判断（2026-10-24）: 「実環境の前に直す（推奨）」。

## 2. 守ること

- BeakSight の Browser は、どの Context（Passive、Interaction、ログイン、書き込みの段、発見、READ の確かめ）でも、許した種類の URL（http・https と、Chromium と Playwright が内部で使う最小の種類）のほかを、OS へ渡さない。
- Guard の今の検出（外部スキームへの移動を違反として記録し、Context を閉じる）は、検出の事象を替えても、同じ結果（記録の形、違反、閉じること）を保つ。
- OS の設定（既定のアプリ、レジストリ、ポリシー）は変えない。設定は、BeakSight が作って消す一時のプロファイルの中だけに置く。
- 設定が効いていることを、Browser を起動するたびに自己検査で確かめ、効いていなければ Run・ジョブを始めない（fail-closed。管理のポリシーが上書きする端末などを考える）。
- サイトへの負荷の上限、送信の判定、Guard の他の判定は変えない。

## 3. 設計の案（EL-0 の調べで確かめてから決める）

### 3.1 Browser の作り方

- 今の `chromium.launch` は `--user-data-dir` を使えないので、`chromium.launchPersistentContext(<一時のプロファイル>, options)` で起動し、その `browser()` から今と同じに `newContext()` で Context を作る（調べで、`newContext()` の Context にも設定が効くことを確かめた。3 経路）。persistent の既定の Context は使わない（頁を開かない）。
- 一時のプロファイルの置き場所・作り方・後片付け（成否にかかわらず消す。消せないときの扱い）、Preferences の中身（`url_blocklist: ["*"]`、`url_allowlist` の閉じた一覧）は、`src/browser/chromium-launch.ts` の 1 か所に置く。
- 起動の引数、channel、proxy（中継）、シグナルの扱いなど、今の `chromiumLaunchOptions` の値は、すべて同じに渡す。
- 置き換える起動の所: `src/cli/audit-run.ts`、`src/worker/audit-worker-process.ts`（ログインの Browser 2 つ）、Run Coordinator・preflight が受け取る起動の関数。

### 3.2 自己検査

- 起動の直後に、許していない独自のスキーム（例: `beaksight-launch-check:`）への移動が、Chromium のブロック（`ERR_BLOCKED_BY_ADMINISTRATOR` の類）になることを確かめる。ならなければ、閉じた理由（例: `EXTERNAL_LAUNCH_BLOCK_UNAVAILABLE`）で Run・ジョブを始めない。

### 3.3 Guard の検出

- ブロックされると、Playwright の `request` の事象が来ない経路がある（goto・302）。CDP の `Page.frameRequestedNavigation`・`Page.frameStartedNavigating` は来る。外部スキームの検出を、これらの事象（と今の事象）で行う形にし、記録の形（`blockedExternalActions`、`EXTERNAL_MAIN_FRAME_NAVIGATION` など）を保つ。
- ブロックで main frame が Chromium のエラーの頁へ移る場合の扱い（今は移動が取り消されて頁が残る）。Guard が違反で Context を閉じる今の流れで、監査の結果（Evidence、Finding、PARTIAL の理由）がどう変わるかを確かめ、変わるなら、変わらない形を設計する。
- `window.open` の popup の頁、iframe、OOPIF、Worker からの移動。

### 3.4 テスト

- 既定の headless shell は Preferences の設定を読まない（調べ）。テストの既定の Chromium と製品の Chromium で、外部スキームの記録の形が分かれる場合は、期待をブラウザの別に分ける。
- 外部のアプリが起動しないことを、本物の Chromium（CLI の起動の設定と headed）で、見張り（OS のプロセスの作成）なしに確かめられる形（例: 自己検査と同じブロックの確かめ）を Gate・結合のテストに置く。

### 3.5 EL-0 の調べの結果と決めたこと（2026-10-24）

調べの報告は `progress.md` の EL-0 の行と scratchpad の `el-0\`（起動の写し `el-launch.ts`、検出の写し `el2-emu.ts`、実験 `exp1`〜`exp5`）。

- **Browser の作り方**: `launchPersistentContext(<一時のプロファイル>, <今の chromiumLaunchOptions の値>)` の `browser()` に `newContext()`。3 種の Chromium で `browser()` は null にならない。本物の factory で Passive・popup・Interaction・中継・Shared Worker の無効が今と同じ。起動の時間もほぼ同じ。
- **既定の Context の頁**: headless は閉じる。headed は閉じると Browser が終わるので、残して `Browser.setWindowBounds` で最小化する。既定の Context は Guard の記録と数えに入らない。`browser.contexts()` に 1 つ入るので、それを前提にするテストを直す。
- **Preferences**: `policy.url_blocklist: ["*"]`、`policy.url_allowlist: ["http://*", "https://*", "about:*", "data:*", "blob:*"]`。エラーの頁・ダウンロード・PDF・WebSocket・blob などは今と同じ。変わるのは `view-source:` だけ（BeakSight は使わない）。
- **自己検査**: 既定の頁で、独自のスキームへの goto が `net::ERR_BLOCKED_BY_ADMINISTRATOR` になることだけを合格にする（設定が効かないと `ERR_ABORTED`。登録のないスキームなので、そのときもアプリは起動しない）。終わったら `about:blank` に戻す。失敗は閉じた理由 `EXTERNAL_LAUNCH_BLOCK_UNAVAILABLE` で Run・ジョブを始めない（preflight の項目と表示の文言・カタログに足す）。
- **検出（EL-2）は EL-1 と一緒に出す**: 設定を入れると、外部スキームの移動で Playwright の `request` が 7 経路のどれでも来ず、今の Guard は記録も閉じもしない（302 だけは Fetch の応答の段で今どおり止まる）。検出を CDP に一本化する: page と OOPIF の session に `Page.enable`、`Page.frameStartedNavigating`（url・frameId で main か sub か）と `Page.windowOpen`（opener の session。`javascript:` と空は除く）、予備として `Page.frameNavigated` の `unreachableUrl`。headless shell では `request` も CDP も来るので、**1 回だけ記録する**。記録の形（`blockedExternalActions`、`EXTERNAL_MAIN_FRAME_NAVIGATION`、`window.open` は今の形の ATTEMPTED と FRAME_CLASSIFICATION_FAILED）を保つ。
- **エラーの頁**: 検出の後に `Page.stopLoading` を送る。残る違い（未完了の理由の詳細が `PAGE_CLOSED` と `EVALUATION_FAILED` で揺れる）は既知の違いとして記録する（Run の状態・違反・記録・Evidence の数は同じ）。
- **後片付け**: `browser.close()` の後の `disconnected` で一時のプロファイルを消す（Windows では retry）。
- **既知の残る経路**（記録する）: 守りのない iframe が 302 で外部スキームへ向くと、設定ありの Chromium の Browser が落ちる（Chromium の CHECK の失敗。Guard を付けた Context では Guard が先に止める。Guard が取りこぼすと Run が Browser の切断で失敗する。止まる側）。headed で利用者が既定の窓を閉じると Browser が終わる。管理のポリシーの上書きは自己検査で止まる。headless shell は Preferences を読まない（もともと起動しない）。
- **テスト**: 記録の形は CDP に一本化すれば両方の Chromium で同じ。分かれるのは `page.url()`（エラーの頁になりうる）、popup の頁ができるか、未完了の理由の詳細だけ。足すテスト: OOPIF のスクリプトの外部スキームへの移動（今はない）、`a target=_blank` と `form target=_blank`、自己検査（設定あり・なし）、headed の最小化。`chromiumLaunchOptions` を直接使う結合のテスト（約 14 ファイル）は、製品の起動を確かめるものを新しい起動に替え、ほかは理由を書いて残す。

## 4. 実装の分け方

| サブタスク | 中身 |
| --- | --- |
| EL-0 | 調べ（済み。3.5） |
| EL-12 | Browser の作り方と自己検査（`chromium-launch.ts`、起動の所、preflight）と、Guard の外部スキームの検出の事象（`passive-request-guard.ts`）を一緒に。テストの補助の起動も合わせる |
| EL-3 | テストと文書（`doc/spec/safety.md` の既知の限界の記述を改める。足すテスト） |
| EL-R | 独立のレビュー（実機。Critical 0・Important 0 まで） |

## 5. 受け入れ条件

1. CLI の Chromium と headed で、Guard を付けたどの Context からも、7 経路の外部スキームで OS のアプリが起動しない（見張りで 0 回）。
2. Guard の検出・記録・違反・閉じることが、今と同じ形で残る。
3. 自己検査が、設定が効かない場合に Run・ジョブを始めない。
4. 安全のテストが両方の Chromium で通る。監査の結果（Evidence・Finding）が、外部スキームのない頁で変わらない。

## 6. 設計の変更の履歴

| 日付 | 理由 | 変更 |
| --- | --- | --- |
| 2026-10-24 | 作成 | ユーザーの依頼と判断、DEF-171 の調べによる。 |
