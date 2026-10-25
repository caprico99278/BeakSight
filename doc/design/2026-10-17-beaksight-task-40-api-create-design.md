# Task 40 設計書 — API の登録（CREATE）

状態: ユーザー承認済み（2026-10-17「Task 40の設計を承認する」）。G40 承認済み（2026-10-18）
作成: 2026-10-17（設計者）
ロードマップ: `2026-10-16-beaksight-task-33-42-roadmap.md` の Program E の Task 40（D3）。Task 38（承認）と Task 39（Guard と送り手）の結果。

## 1. 目的

承認した API の登録のシナリオを、書き込みのジョブで 1 回だけ実行できるようにする。ページの画面で欄に値を入れて保存を押し、Guard が照らした 1 回を送り手が送る（Task 39）。登録の ID を応答の本文から取り（D3）、照合の READ（`{id}` つきの画面）で確かめ、台帳・上限・報告（Task 30〜32 の部品）に API の形を足す。ここで初めて、API のシナリオに実行の許可を出す。

## 2. 前提（これまでの調査と実装で確かめた事実）

- 書き込みの流れは `src/worker/write-create-run.ts`（送る前の画面の確かめ、書き込みの段の Context、結果の判定、ID の取り方 `URL_PATH_PATTERN`・`ELEMENT`）。ジョブの種類は `WRITE_CREATE`・`WRITE_UPDATE`。台帳・上限（件数、5 分の間隔、1 日 5 件、予約）・報告（`action-evidence`・`approval-summary`・`action-run`）は form の形で作られている。
- IPC の書き込みの `START` は form の形だけ（`candidateFields`・`values`）で、画面の READ の照合を拒んでいる。開始の口（`writeStartSpecOf`）は form の要求のないシナリオの指定を作らない。発行の口は `API_WRITE_NOT_AVAILABLE` で拒む。
- Task 39 の部品: 入力と押下 `src/browser/api-write-submitter.ts`、Guard の API の分岐と送り手（`GuardApiWriteStage`、`recordIdOf`、`monitor.apiWriteRecordId()`・`apiWritePageKeyValues()`）、照合 `checkApiWritePayload`。
- 照合の READ の `{id}` の型（`readCheckPageTemplateUrlOf`）は、保存の時に代わりの値で確かめただけ（T38R の M-1）。

## 3. 設計

### 3.1 許可を出す（T40a）

- `issueIn` の `API_WRITE_NOT_AVAILABLE` を、API の登録（CREATE）のシナリオでは外す。API の更新（UPDATE）は Task 41 まで今のまま拒む。
- 許可の確かめは、今の有効性（T38R-fix の Origin の位置と最新の発見の改訂を含む）、入力の規則、上限、予約をそのまま使う。

### 3.2 開始と IPC（T40a）

- 開始の口と IPC の書き込みの `START` に、送り方 `API` の形を足す: 承認した API の指定（照合に要る項目）、生成した値（鍵ごと）、欄の識別、送信の要素の識別の digest、ID の取り方、照合の READ（`{id}` の型の画面の READ を含む）。
- 照合の READ の `{id}` の型は、IPC で開く（Task 38 の判断）。

### 3.3 ワーカーの流れ（T40b）

- 書き込みの段の Context を `transport: 'API'` で作る（Task 39）。`GuardApiWriteStage` に、照合の期待と、`recordIdOf: (body) => apiRecordIdOfResponseBody(body, recordId.key)` を渡す。
- 送る前の画面の確かめは、候補の識別と型（今の発見の索引と同じ）で行う。
- 入力と押下は `api-write-submitter.ts`（欄の識別は `api.keyFields`、値は生成した文字列）。
- 結果の判定: 送り手の結果（`RESPONDED` の状態が 2xx）と、応答の本文から取った ID。ID が取れなければ「分からない」（成功と偽らない）。
- 照合の READ: `{id}` に取った ID を入れた画面の path に、保存の時と同じ画面の READ の確かめ（読まないパス・危険な語・Origin・読む範囲）をかけ直してから読む（T38R の M-1）。結果は今の照合の写し（`VERIFIED`・`PARTIAL`・`READ_VERIFICATION_UNDETERMINED` など）。
- ページが決める鍵の値（`apiWritePageKeyValues()`）は、書き込みの結果の記録に残す（Task 38 の判断 (1)）。秘密に見える名前は承認で拒んでいる。

### 3.4 台帳・上限・報告（T40c）

- 台帳（`write_results`）に、送り方と API の型の要約を足す（管理データの版 14。版 13 を写しで固定してから）。登録の ID は今どおり台帳に残す。
- 上限（件数、間隔、1 日 5 件、予約）は今のまま使う。
- 報告（`action-evidence`・`approval-summary`・`action-run`・HTML・バンドル）を 1.1 にし、API の要求の型の要約（method、Origin、path の型、鍵）、送信の報告、ページが決める鍵の値、照合の結果を足す。`Authorization`・応答の本文は残さない。成果物に書く URL は伏せ字の部品を通す（T39R の未実行の項目: 止めた要求の URL の query の値）。

### 3.5 画面（T40d）

- 書き込みの開始の画面で、API の登録のシナリオを始められるようにする（今の form の書き込みの開始と同じ確かめ）。結果の画面と報告の表示に API の要約を出す。

## 4. 安全

- 承認した 1 回だけ（Task 39 の Guard・送り手・中継の予算）。再送しない。
- 結果が分からないときは成功と偽らない（ID が取れない、応答がない、照合の READ が分からない）。
- 二重の登録を防ぐ: 今の予約と、送信の報告が `SENT` のときの台帳の書き方を使う。
- 値・秘密を残さない（I22）。ページが決める鍵の値だけを、承認の判断どおりに残す。

## 5. 受け入れ条件（G40）

1. fixture の form のない登録の画面で、発見 → シナリオ → 承認 → 許可 → 書き込みのジョブ → 登録の ID → 照合の READ（MATCHED）→ 台帳 → 報告、が通る。サーバに届いた書き込みは 1 回（両方の Chromium）。
2. 承認の範囲外 0、二重の登録 0、上限の超過 0（同じシナリオを続けて始める、上限に届いた状態で始める）。
3. ID が取れない応答、応答なし、4xx・5xx、照合の READ が NOT_MATCHED・UNDETERMINED のときに、成功と偽らない。
4. 秘密の目印・応答の本文・`Authorization` が、管理データ（WAL を含む）・成果物・画面に出ない。
5. API の更新のシナリオは、まだ許可が出ない。
6. 回帰: form の書き込み（Task 28〜32）のテスト一式。独立レビュー（Critical 0、Important 0）。

## 6. 実装計画

| サブタスク | 内容 | 主なファイル |
| --- | --- | --- |
| T40a | 許可を出す、開始の口と IPC の API の形 | `execution-grant.ts`、`write-job-start.ts`、`worker-protocol.ts`、`worker-message.schema.json`、`audit-job-manager.ts` |
| T40b | ワーカーの API の書き込みの流れ（ID、照合の READ の確かめ直し） | `src/worker/write-create-run.ts`（か新しいファイル）、`read-check-run.ts` の照合の部品 |
| T40c | 台帳（管理データの版 14）と報告 1.1 | `migrations.ts`、`write-result-store`、`src/control/actions/`、`schemas/`、報告の表示 |
| T40d | 画面 | `apps/local-ui/` の書き込みの開始と結果 |
| T40R | 独立レビュー | — |

順: T40a → T40b → T40c → T40d。

## 7. 設計の変更の履歴

| 日付 | 理由 | 変更 |
| --- | --- | --- |
| 2026-10-17 | 作成 | Task 38・39 の結果と、Task 38 の調査の地図の 5 章に基づいて書いた。 |
| 2026-10-17 | ユーザーの判断 | 設計を承認（「Task 40の設計を承認する」）。 |
| 2026-10-17 | T40a の報告（API の検証の指定） | 3.3 の結果の判定（送り手の応答の状態と、ID）に合わせ、API のシナリオの検証の指定で求める項目を、照合の READ と ID の取り方だけにする（設計者の判断）。ID の取り方は、`api.recordId`（応答の本文の鍵）か、検証の指定の `recordId`（保存の後の画面の URL・要素）のどちらかがあればよい。成否の条件と入力の誤りの条件は、API では求めず、使わず、画面でも出さない（`START` では null）。結果の判定は今の閉じた一覧を使う: 応答の状態が 2xx なら `SUCCESS`（ID が取れなければ今どおり `RECORD_ID_NOT_FOUND`・`RECORD_ID_UNSAFE` で成功と偽らない）、429 は `RATE_LIMITED`、ほかの 4xx は `INPUT_ERROR`、5xx は `SERVER_ERROR`、それ以外は `NO_CONDITION_MATCHED`、応答なしは `NO_RESPONSE`。form のシナリオは今のまま 4 項目を求める。 |
| 2026-10-17 | 設計者の判断（順の入れ替え） | 書き込みの記録 `action-run.json` の版 1.0 は成否の条件を必須にしていて、API の結果を書けない。そこで、記録と報告の形（1.1）・親の読み取り・台帳の版 14 を先に作り（T40c）、ワーカーの流れ（T40b）はその形に書く。報告の HTML とバンドルの API の表示は、画面と合わせて T40d で行う。順: T40a → T40c → T40b → T40d。 |
| 2026-10-17 | T40c の報告 | 記録と報告の版 1.1 に `transport` と API の要約を足した（許すヘッダの名前は `httpFieldNames`。承認の要約は 1.0 のまま）。台帳の版 14 は `write_results` を作り直して、送り方と API の要約の列を足した。設計者の判断: (1) 版 13 から上げた行はすべて FORM（版 13 は未公開。T40a〜T40c の間に API の許可で書いた開発用のデータベースは作り直す。限界として記録）。(2) 送り手が受けた状態が 100〜599 の外なら、応答が分からないとして `httpStatus` と判定を null にし `UNKNOWN`。T40b を T40b-1（送るまでと結果と記録）と T40b-2（`{id}` の照合の READ）に分ける。 |
| 2026-10-18 | T40b-1 の報告 | API の流れは `write-create-run.ts` の中の分岐にした（Gate の `write-stage-boundary` が書き込みの段の口を参照してよいファイルをこの 1 つに閉じているため）。form・UPDATE・API が送る前の確かめ・段の画面の読み込み・窓の静けさ・押す直前の確かめを共有する。設計者の判断: (1) Guard の API の分岐は応答をページに返せなかったこと（`Fetch.fulfillRequest` の失敗）を印にしないので、API の `RESPONSE_NOT_DELIVERED` には届かない。結果は送り手が受けた応答で決め、ID は応答の本文か、届かなければ画面から取れずに `RECORD_ID_NOT_FOUND`（`PARTIAL`）になるので、成功と偽る経路ではない。Guard は変えず、限界として記録する（T40R で再び見る）。(2) 状態が 100〜599 の外の応答はページに返り、結果は `UNKNOWN`（違反ではない）。(3) 3.3 の「送る前の画面の確かめは候補の識別と型」は、送信の要素の識別と鍵の欄の確かめ（`inspectApiWriteInput`）で行い、型は書き込みの段の Guard の照合（`checkApiWritePayload`）が担う（規則の digest は API の候補には照らさない）。 |
| 2026-10-18 | T40b-2 の設計（照合の READ の確かめ直し） | 保存の時の画面の path の確かめ（`read-check-policy.ts` の `pageErrorsOf` の path の部分: 正規の形、読まないパス、読む範囲、ログインの画面、危険な語、開始の URL の Origin と許可 Origin）を、ワーカーからも使える 1 つの純粋な owner に移し、保存の確かめと実行のときの確かめ直しが同じ部品を呼ぶ（第二の owner を作らない）。ワーカーは、使える ID（`isUsableRecordId` の形）だけを `{id}` に入れ、組み立てた具体的な path にこの判定と `isReadUrlAllowed` をかけてから、画面の path の READ と同じ手順で 1 回読む。どれかに当たれば読まずに `UNDETERMINED`（`REQUEST_POLICY` など今の理由）。ID がなければ照合の READ は行わない（今の `RECORD_ID_NOT_FOUND`）。 |
| 2026-10-18 | T40b-2・T40d の報告 | 画面の path の確かめの唯一の owner は `src/control/read-check-page-path.ts`（既定の危険な語の owner が control にあるため control に置き、ワーカーの境界に許可を足した）。照合の READ の結果は、一致は `VERIFIED`、一致しないは `UNKNOWN`、判定できない・読まない path は `PARTIAL`。報告と画面には API の要約を出し、FORM の報告は変えない。限界: (1) 応答の判定のラベル（「成功の条件に当たった」など）は API では言い方がずれるので、報告の判定の説明で補う（Task 42 の文書の段で見直す）。(2) 画面の秘密の目印の検査は偽のワーカーで行う（本物の送信のヘッダの値と応答の本文の目印が管理データと成果物に出ないことは、ワーカーの結合で確かめている）。 |
| 2026-10-18 | T40R（Critical 0、Important 2、Minor 3） | (I-1) 送信の窓を値を入れる前に開いているので、ページの JS が入力の事象で承認どおりの要求を出すと、押す直前の確かめ直し（`recheck`）と止める印の前に 1 回届く。設計者は Important と判断する（承認と許可は開始の時点で有効で、型と 1 回は守られ、記録も残る。ただし開始の後の撤回を確かめ直しで止める約束が破れる）。直し: 窓を 2 段にする。値を入れる間は観察の段とし、承認した型の要求も含め、読み取りでない要求はすべて止めて数える（0 でなければ押さない）。Guard が照合にかけて通すのは、`readyToPress` の後に開く送信の段の中だけ。form の流れにも同じ形を当てる（form の窓も入力の前に開いている）。(I-2) ID を画面から取るシナリオで、登録の画面 `/admin/members/new` 自身が ID の型に当たり、`new` を ID として取り、照合の READ の期待が行の数だけなら `VERIFIED` になる（T40b-1 の判断 (1) の「画面から ID を取れない」は成り立たない）。直し: (a) API の `{id}` の照合の READ は、生成した値に結び付く期待を 1 つ以上求める（保存と IPC）。(b) 画面から ID を取る形では、書き込みの画面の path が型に当たる ID の型を保存で拒み、ワーカーは押す前の画面から同じ取り方で取れた値を ID として使わない。(c) Guard の API の分岐は、応答をページに返せなかったことを確かに見分けられるなら `responseDeliveryCanceled` に印し、画面から ID を取る形ではそれを `RESPONSE_NOT_DELIVERED` にする。(M-1) 秘密の名前の判定の漏れ（`priv_key`、`秘密鍵`、`暗証`、`セッション`、`passwort`、`pw`、NFKC で 1 文字になる結合文字の形）は、Task 41 の語の追加の判断にまとめる。(M-2) 送り方の値の定数を `scenario-contracts.ts` の名前つきの定数 1 つにする。「API は CREATE だけ」の判定は `apiWriteRejectionOf` だけにし、`writeStartSpecOf` はそれを呼ぶ。CC-103 も片付ける。(M-3) I-1 の直しで起きなくなる。限界: R2-I-1 の守りは、呼び出し側のまとめ（`mergeDiscoveryCandidates`）にある（索引の書き手は、まとめる前の行を渡されると型を合わせて入れる）。送る前にワーカーが止まった回も、予約は `UNKNOWN` で件数と間隔に数える（止める側に倒した既定）。 |
| 2026-10-18 | T40R-fix-A・B の報告 | (I-1) `WriteStageMonitor` に送信の段（`openSubmissionPhase`・`isSubmissionPhaseOpen`）を足し、`openSubmissionWindow` は観察の段にした。送信の段が開くまで、Guard は書き込みの段の残りの POST を 0 として判定するので、承認の形の要求も照合にかからず止まり、窓の中の止めた要求に数える。送信の段を開くのは入力の部品の押す直前（`readyToPress` の後）だけ。form にも同じ経路があり（修正の前は 1 回届いた）、同じ形で直した。(I-2) 保存と IPC は、API の `{id}` の READ に生成した値と比べる期待を求め（`hasGeneratedValueExpectation`）、API の URL の ID の型に書き込みの画面が当たれば拒む（`recordIdOfPathPattern`）。FORM のシナリオは、`/members/new` と `/members/{id}` のような正当な組が多いので、保存では拒まない。ワーカーは画面から ID を取る形で、押す前の画面から同じ取り方で取れた値と、URL が変わっていない値を使わない（`pageRecordIdBaselineOf`・`isPageRecordIdNew`）。設計者の判断: この押す前の値との比べは FORM の画面の ID にも当てる（取り違えの場合だけ振る舞いが変わり、成功と偽らない側に倒れる）。(c) Guard の `fulfillApiWrite` は、一時停止の ID が無効な形の失敗（ブラウザが先に取り消した）のときだけ `responseDeliveryCanceled` を印し、画面から ID を取る形では `RESPONSE_NOT_DELIVERED` にする。T40b-1 の判断 (1) の限界はなくなった。送り方の値は `src/core/scenario-transport.ts`、「API は CREATE だけ」の owner は `apiWriteRejectionOf` だけ。 |
| 2026-10-18 | T40R2（Critical 0、Important 0、Minor 3。I-1・I-2 は直った） | (M-1) 照合の READ の期待の確かめ（`hasGeneratedValueExpectation`）は種類だけを見るので、毎回同じ値の欄（入力の規則の 1 つの値の固定の一覧など）だけと比べる期待では、ページが古い ID を出したときに取り違えを見分けられない。直し: API の `{id}` の照合の READ は、実行のたびに変わる値（生成した値。毎回同じ値になる規則の欄ではない）と比べる期待を 1 つ以上求める（保存と IPC。判定は 1 か所）。(M-2) 応答を返せなかった印は、取り消しの時刻とブラウザによって付かないことがある（限界。最後の守りは毎回変わる値と比べる照合の READ）。(M-3) 送り方の生の文字列の比べが残る所（`scenario-policy.ts`・`scenario-store.ts`・`field-evaluation.ts`・`passive-request-guard.ts`）を、`src/core/scenario-transport.ts` の定数に替える。使える度合い（ユーザーの指示「最初の画面から「判定できない」を連発するようでは困る」による設計者の判断）: API の URL の ID の型が書き込みの画面に当たるときの保存の拒否（`SCENARIO_API_RECORD_ID_PATTERN_MATCHES_FORM_PAGE`）は、正当な REST の組（`/admin/members/new` と `/admin/members/{id}`）を拒むだけで、取り違えはワーカーの押す前の値との比べと、毎回変わる値の照合で防げている（T40R2 の U3b で `VERIFIED`）。そのため、保存は拒まず、保存の画面と詳細の画面に注意（応答の本文の鍵から取る形を勧める）を出す形に下げる。自動保存のサイトで書き込みのジョブが使えない（意図した止まり方）ことの次にできることの表示は、Task 44 で扱う。 |
| 2026-10-17 | T40a の報告（開始の画面の Origin） | `{id}` の型の照合の READ の対象の画面は、READ の確かめのジョブと同じく、ターゲット設定の開始の URL の Origin と型の path で決める。手書きの確かめで、書き込みの画面と同じ Origin であることを求める。 |
| 2026-10-18 | ユーザーの判断 | G40 を承認（「承認する（推奨）」）。T40R2 で Critical 0・Important 0、T40R2-fix で Minor を直した後に諮った。 |
