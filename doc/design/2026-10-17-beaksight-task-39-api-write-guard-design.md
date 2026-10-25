# Task 39 設計書 — API の書き込みの段の Guard と送り手

状態: ユーザー承認済み（2026-10-17「承認する（推奨）」。窓の中の読み取りは 7 章の履歴）
作成: 2026-10-17（設計者）
ロードマップ: `2026-10-16-beaksight-task-33-42-roadmap.md` の Program E の Task 39（I20・I21・I22）。Task 38 の設計書（承認済み）の 3〜4 章と 7 章の履歴。

## 1. 目的

承認した API のシナリオについて、ページの JS が組み立てた fetch の要求（`POST`・`PATCH`）を、書き込みの段の Guard が止めて、承認した型と生成した値に照らし、一致した 1 回だけを BeakSight の送り手が送る（I20）。再送しない。応答はページに返す。Task 39 では、Guard・照合・送り手までを作り、書き込みのジョブの流れ（台帳、ID の取り方、照合の READ）は Task 40・41 で組み込む。

## 2. 前提（読み取り専用の調査で確かめた事実）

- 今の書き込みの段は、main frame のナビゲーションの form の POST だけを、残り 1 回のときに許す（`request-policy.ts` の `isAllowedWritePost`）。Document の段で本文（urlencoded・multipart）を `checkWritePayload` で照らし、`submitAdmittedWrite` が同じ本文の bytes を `sendWriteSubmissionOnce`（`write-submission-sender.ts`）で中継を通して 1 回だけ送り、応答を `Fetch.fulfillRequest` で返す。
- 書き込みの段の Context には監査の段の口を渡していない。そのため、サービスの Origin への要求は `OUTSIDE_ALLOWED_ORIGINS` で止まる。SPA の画面は描けず、承認した fetch も通らない（T37a fix round 1 の発見）。
- 中継は Guard が通した宛先への CONNECT だけを通す（DEF-125）。中継の予算は POST と送信先だけを数える。
- 値を JSON の型に変える部品は `src/control/data-rules/json-value.ts`（T38e）。承認の digest v4 の API の項目は、Guard が照らす型の項目と同じ並び（T38c）。

## 3. 設計

### 3.1 書き込みの段の Context の読み取り（T39b）

- 書き込みの段の Context にも監査の段の口を渡す。押下の前（送信の窓の前）は、承認したサービスの Origin への GET・HEAD を、今の監査の段と同じ判定と上限で通す（SPA の画面を描くため）。登録した読み取りの手続きの呼び出しは、書き込みのジョブでは通さない（実装は `jobContextFactoryOptions(..., 'NONE')`。2026-10-18 RT-prep の報告で、この行の古い記述を直した。画面がその呼び出しなしで描けないサイトでは、送る前の確かめで止まる見込みで、実テスト環境では未検証）。
- 送信の窓の中は、承認した 1 回の書き込みだけを通し、ほかの読み取りでない要求は止める（今の form の窓と同じ）。窓の中のサービスの Origin への読み取り（書き込みの後の画面の更新）は、**設計者の既定（ユーザーの確認待ち）**: 窓の中でも上限の中で通す。
- 押す直前の確かめ（鍵の消失・上限。T37a）を、書き込みの段の中の数でも行う。

### 3.2 JSON の照合（T39a）

純粋な部品（`write-payload-policy.ts` と同じ形の新しいファイル）。照らすもの:

- method: CREATE は `POST`、UPDATE は `PATCH`。method を上書きするヘッダと本文の `_method` はない。
- Origin: 承認した文字列と完全一致。path: 承認した型と一致（UPDATE は台帳の ID の位置を含めて完全一致）。
- query: 名前の集合が承認と一致（`select` と、UPDATE の filter 1 つだけ）。UPDATE の filter は `<名前>=eq.<台帳の ID>` の形で、値が台帳の ID と完全一致。
- ヘッダ: ページが付けた名前の集合が承認した名前の集合の中（ブラウザが付ける名前は除く）。`Content-Type` の媒体の型が承認と一致。`Prefer` は閉じた一覧の値で承認と一致。
- 本文: JSON の object。鍵の集合が承認と完全一致（欄の鍵とページが決める鍵）。欄の鍵の値は、生成した値を `jsonValueOf` で変えたものと型も値も完全一致。ページが決める鍵の値は JSON の型だけを照らし、値を記録に残す（Task 38 の判断 (1)。秘密に見える名前は承認で拒んでいる）。上限の大きさ（名前つきの定数）の中。array・入れ子の object の値は拒む（I21）。
- 照らした結果の理由は閉じた一覧。値は記録・例外の文に残さない（ページが決める鍵の値だけは、書き込みの結果の記録に残す）。

### 3.3 Guard（T39b）

- サブリソースの流れ（CDP の要求の層）に、書き込みの段の API の分岐を足す。判定は `decideGuardRequest` の 1 か所に寄せる。
- 事前確認は今どおり Guard が満たす（I18）。
- 窓の中の、承認した Origin への `POST`・`PATCH` の 1 回目だけを照合にかけ、一致すれば送り手に渡す。2 回目以降と不一致は止めて記録する。窓の外の読み取りでない要求は止める。

### 3.4 送り手（T39c）

- `write-submission-sender.ts` を fetch の形に広げる: `Sec-Fetch-Mode: cors`・`Sec-Fetch-Dest: empty`、`Sec-Fetch-User` なし。`Authorization` などのヘッダは一時停止の要求のヘッダを素通しし、記録しない（I22）。
- 同じ本文の bytes を中継を通して 1 回だけ送る。再送しない。応答は `Fetch.fulfillRequest` でページに返す。
- 応答の状態と、応答の本文から取り出す ID（Task 40 の D3）は、メモリで扱い、使える形の ID だけを返す。応答の本文は記録しない。
- 中継の予算に、承認した API の Origin への 1 回の `POST`・`PATCH` を足す。

### 3.5 入力の部品（T39d）

- `NEEDS_BINDING` の form と、form のない画面（BUTTON）の欄に値を入れて押す部品（`write-form-submitter.ts` の今の形は action のある form が前提）。欄は `api.keyFields[].field`（`NAME` か `SELECTOR`）で探し、probe の時の送信の要素の識別で押す。ページを操作してよいファイルの閉じた一覧 (q) を守る。

## 4. 安全

- I20: 照合は型・本文・ヘッダの名前・query のすべて。1 回だけ送り、再送しない。
- I21: method、手続きの呼び出し、upsert、array、filter なし、method の上書きは、probe の分類・シナリオの下書き・Guard の 3 か所で照らす。
- I22: `Authorization`・API の鍵・token の値、応答の本文は残さない。
- 承認だけでは書き込まない: Task 40 まで `API_WRITE_NOT_AVAILABLE` で許可を出さない（Task 39 のテストは、許可を直に作る口で行う）。

## 5. 受け入れ条件（G39）

1. 敵対的な形がすべて止まり、サーバに届かない: 2 回送る、本文の値の書き換え、鍵の追加・削除、filter の値の書き換え、別の Origin・path、upsert（`Prefer`・`on_conflict`）、array、method の上書き、許していないヘッダ、窓の外の送信、ページの JS が送信の直前に本文を書き換える、fetch を Worker・iframe から送る。両方の Chromium。
2. 一致した 1 回だけが届き、応答がページに返る。
3. 押下の前は SPA の画面が描ける（サービスの Origin の読み取りが上限の中で通る）。
4. 秘密の目印と応答の本文が、記録・管理データ・成果物に出ない。
5. 回帰: form の書き込み（Task 28〜32）の Guard と送り手のテスト。独立レビュー（Critical 0、Important 0）。

## 6. 実装計画

| サブタスク | 内容 | 主なファイル |
| --- | --- | --- |
| T39a | JSON の照合の純粋な部品と理由の閉じた一覧 | `src/safety/` の新しいファイル、`request-policy.ts` の口 |
| T39b | 書き込みの段の Context の読み取りと、Guard の API の分岐 | `src/safety/passive-request-guard.ts`、`src/browser/context-factory.ts` |
| T39c | 送り手の fetch の形と応答の返し方、中継の予算 | `src/safety/write-submission-sender.ts`、`passive-request-guard.ts` |
| T39d | form のない画面の入力と押下の部品 | `src/browser/write-form-submitter.ts` か新しいファイル |
| T39R | 独立レビュー（127.0.0.1 の fixture の防御の品質確認） | — |

順: T39a → T39b → T39c、T39d は T39a と並行してよい。

## 7. 設計の変更の履歴

| 日付 | 理由 | 変更 |
| --- | --- | --- |
| 2026-10-17 | 作成 | 読み取り専用の調査（Task 38 の地図の 4 章）と Task 38 の結果に基づいて書いた。設計者の既定（ユーザーの確認待ち）: 送信の窓の中のサービスの Origin への読み取りを上限の中で通す。 |
| 2026-10-17 | ユーザーの判断 | 設計を承認（「承認する（推奨）」）。送信の窓の中の承認したサービスの Origin への読み取りは「上限の中で通す（推奨）」。 |
| 2026-10-17 | T39a の報告 | 層の決まり（control の外は control を import しない）のため、`jsonValueOf` を `src/core/json-value.ts` へ、ブラウザが付けるヘッダの名前と method の一覧を `src/core/api-request-shape.ts` へ移した。限界: 承認の path の型に伏せた区切りがあると照合は `EXPECTATION_INVALID` で止まる（path に ID を持つ REST の形の UPDATE は扱わない。filter の形だけ）。 |
| 2026-10-17 | T39R（Critical 0、Important 0、Minor 6。承認した 1 回のほかに届く要求なし） | (M-1) 中継の予算は承認の endpoint（Origin と path）への POST・PATCH だけを数える。(M-2) 窓の中で照合にかけるのは承認の endpoint の path に当たる要求だけにし、ほかの読み取りでない要求は今の決まりで止めて記録する（書き込みの機会を使い切らない）。(M-4) Guard の照合でも upsert の `Prefer`（`resolution=`）と手続きの呼び出しの path を `EXPECTATION_INVALID` にする（I21 を 3 か所で）。(M-5) `Prefer` と `Content-Type` の読み方を `api-request-shape.ts` の 1 か所にし、閉じた一覧の外の項目（`other`）を持つ型は分類で実行できないにする。本文の上限は型の作り手と照合でそろえる（64 KiB を超える本文の型は実行できない）。限界（文書に書く）: main frame の判定は要求を作った realm で決まり、同じ Origin の子の frame が `parent.fetch` を呼ぶ形は main frame の要求になる（守りの本体は照合と 1 回の上限）。ヘッダの値は `Content-Type` と `Prefer` のほかは照らさない（`Authorization`・API の鍵の値、ブラウザが付ける名前の値）。`select` の値は照らさない。ID の口は安全な形の値をそのまま返す。Reporting API の報告が Guard を通らずに届くかは未確定。 |
