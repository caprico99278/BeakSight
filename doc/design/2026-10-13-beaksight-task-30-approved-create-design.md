# BeakSight Task 30 承認された CREATE と登録結果の照合 設計書

作成日: 2026-10-13
状態: ユーザー承認済み（2026-10-13。10 章の 5 点を含む）。G30 承認済み（2026-10-14）
対象範囲: テスト環境の書き込みのモードのプロファイルで、承認されたシナリオ（Task 28）と入力の規則（Task 29）に従って、登録（CREATE）を 1 件だけ実際に送り、結果を判定し、登録した内容を READ で読み直して照合する。BeakSight が初めてサイトへ書き込みの要求を送る Task

## 1. 目的

承認の範囲の中の 1 件の登録だけを、厳しく照合したうえで送る。承認の範囲の外の書き込み・二重の登録・上限を超えた登録・結果が分からないのに成功と偽ること、を起こさない。

## 2. 根拠となる文書と、ロードマップからの読み替え

- 従う文書: ロードマップ `2026-10-09-beaksight-task-22-32-roadmap.md` の Task 30、3 章（I04、I07〜I15）、5 章（`ActionResult`・`ActionRunSummary`）、5.1、6.3〜6.6、7 章、8 章、9 章（検証条件）、13.2・13.4、RF4・RF5、ADR-013。Task 26（自動ログインの送信の守り）、Task 27（発見・READ・isolated world）、Task 28（承認・実行の許可・予約・`approvalExternalFactsOf`・`assertGrantStillValid`）、Task 29（入力の規則と生成）の設計書。
- 調査: 作業記録 `progress.md` の「T30 の調査」の行（場所つきの事実と実験）。
- ユーザーの判断（2026-10-13）:
  1. 送り方は、ページのフォームに生成した値を入れて送る。送る前にフォームを読み直して確かめ、送る中身（欄の名前と値）をブラウザの内部の層（Guard の CDP）で照合してから通す。CSRF のトークンはページのまま送り、BeakSight は読まない。
  2. 結果が分からない（`UNKNOWN`）ときは、件数を使ったものとして数え、シナリオは止めない（次の Run も実行できる）。
  3. 同じシナリオの連続の実行は、間隔 5 分以上・24 時間に 5 件まで。
  4. 成否の条件・登録の ID の取り方・生成した値で読み直す READ の照合を、シナリオの実行の条件にする（今の承認はすべて再承認になる）。
- 読み替え:
  - ロードマップの「1 Run 1 件・累積 20 件」は Task 28 の既定のとおり。「連続 Run の上限」はユーザーの判断 3 の値。
  - 「`UNKNOWN` は quota を保守的に消費」は、ユーザーの判断 2 のとおり、使ったものとして数える（止めない）。
  - ロードマップの `src/control/actions/create-executor.ts` は、ブラウザの中の送信をワーカーの側（`src/worker/`）に、要求の判定を `src/safety/` に、記録を `src/control/` に置くと読む。

## 3. 採用する設計

- **書き込みの段**（Task 26 のログインの段と同じ考え方）: 新しい factory の入口で、書き込みの段の Context を作る。Guard は、承認された要求の形（method `POST`、Origin、path、enctype）に完全に一致する main frame のナビゲーションの POST を 1 回だけ通す。送信の窓の間は、ほかのすべての要求を止める。許可 Origin の外へは段の全体で止める。Service Worker・iframe・popup・WebSocket は今の Guard のとおり止める。307・308 の再 POST は止める（結果は `UNKNOWN`）。
- **送る中身の照合**（純粋な関数 `src/safety/` の 1 か所。Guard が CDP の `Fetch.requestPaused` の本文で呼ぶ）: (a) 欄の名前は「送る欄」と「承認した候補の hidden・readonly の欄」だけ（ほかの名前があれば止める）、(b) 送る欄の値は生成した値と完全に一致、(c) enctype は `application/x-www-form-urlencoded` と `multipart/form-data` だけ（`text/plain` は止める）、(d) file の欄は空、(e) 文書の文字コードが UTF-8 でなければ止める。hidden・readonly の欄の値（CSRF のトークンを含む）は読まず、照らさず、記録しない（名前だけを照らす）。止めたら送らずに `BLOCKED`（予約は `RELEASED`）。
- **フォームの入力**: 入力の部品（fill・selectOption・check）は新しい owner（`src/browser/write-form-submitter.ts`）だけが持つ（Gate）。送る前の確かめ（Task 26 の `inspectLoginForm` の作り）: POST、action と `formaction` が承認の送信先と一致、enctype、target が自身、送る欄がすべて同じ form にある、prototype の getter で読む。確かめを入力の直前にもう一度行う。
- **フォームの画面の確かめ**: 書く前に、凍結した別の Context で書き込みの画面を開き、isolated world で候補を読み直し、承認に縛った候補の識別と規則の 2 つの digest と一致することを確かめる（一致しなければ送らずに止める）。そのあと新しい書き込みの段の Context で開き直して書く（画面の GET が 1 回増える）。
- **送る直前の確かめ直し**: ワーカーは管理データを読めないので、新しい IPC の往復（ワーカー → 親: 確かめの依頼、親 → ワーカー: 結果）で、親が `assertGrantStillValid` と `approvalExternalFactsOf` を求め直して返す。撤回などで外れれば送らずに止める。撤回のときは親が STOP も送る。
- **結果の判定**（Task 26 の結果の判定の作り）: 送信の後の main frame の文書で、429・5xx、人が決めた成功の条件と入力の誤りの条件（`{pathPrefix, selector}`）のちょうど 1 つに当たったときに決める。どれにも当たらない・2 つ以上に当たる・セッションが切れた、は `UNKNOWN`。
- **登録の ID**: シナリオの検証の指定で、成功の後の URL の path の型（例 `/items/{id}`）か、成功の画面の要素から取る。取れなければ `PARTIAL`（成功の条件には当たったが照合できない）。
- **READ による照合**: シナリオの検証の指定で、生成した値に結び付けた READ（送る値の一部を生成した値から取る。例: 検索の `q` = 生成した氏名）と期待（行の数が 1、詳細の項目が生成した値と一致など）。Task 27 の READ の部品を使う。照合できれば `VERIFIED`、照合できなければ `PARTIAL` か `UNKNOWN`。照合できない Run を `COMPLETE` にしない。
- **予約の締め**: 送信の後に応答を受けたら `COMMITTED`、Guard が POST を通した後に応答がない・接続が断たれた・ワーカーが落ちた、などは `UNKNOWN`、Guard が POST を通さなかったことをワーカーが報告できたときだけ `RELEASED`。ジョブの終わりで必ず締める。画面のサーバの再起動の後の回復で、締めていない予約を `UNKNOWN` で締める（自動ログインの未確定の試しの閉じ方と同じ）。
- **`UNKNOWN` の後**（ユーザーの判断 2）: 件数を使ったものとして数え、シナリオは止めない。送った値は「使った値」として生成の履歴に入れる（一意性と電話番号の重なりを避ける）。画面に `UNKNOWN` の結果をはっきり出し、テスト環境で確かめるよう促す。自動の再試行はしない。
- **連続の上限**（ユーザーの判断 3）: 実行の許可の発行で、同じシナリオの最後の書き込み（`COMMITTED`・`UNKNOWN` の予約の時刻）から `MIN_WRITE_INTERVAL_MS`（5 分）以上、24 時間の窓の中の書き込みが `MAX_WRITES_PER_DAY`（5 件）未満であることを確かめる（名前つきの定数。既定値を変えるのはユーザーの判断）。
- **検証の指定**（ユーザーの判断 4）: シナリオの内容に、成功の条件・入力の誤りの条件・ID の取り方・照合の READ を足す（承認の digest の項目に加わるので、今の承認はすべて再承認になる）。どれかが指定されていないシナリオは承認できるが実行の許可は出せない（`VERIFICATION_SPEC_MISSING`）。
- **外部への通知**: ブラウザの側は、書き込みの段で許可 Origin の外をすべて止める。サーバの側（登録を契機のメールや SMS）は自動では確かめられないので、シナリオの副作用の確認 `NO_EXTERNAL_NOTIFICATION` と、プロファイルの環境の証跡の参照（`environmentEvidenceRef`）を書き込みの実行の条件にする（空なら実行の許可を出さない）。
- **記録**: 管理データの版 8（版 7 は Task 29）。ジョブの表を作り直してジョブの種類 `WRITE_CREATE` を足し、書き込みの結果の表（ジョブ、シナリオ、版、許可、送った値（合成のテストデータなので平文。READ の定義と同じ扱い）、登録の ID、結果、照合の状態、時刻）を足す。成果物は Run のディレクトリの `action-run.json`（`schemas/action-run.schema.json`）。公開監査の `run.json` のスキーマは変えない。

採らなかった案:
- BeakSight が要求を組み立てて送る案（CSRF のトークンを読む必要があり、Playwright の `APIRequestContext` の要求は Guard にも中継の要求の方針にも見えない。調査の実験）。
- `UNKNOWN` の後に止める案（ユーザーの判断で採らない）。

## 4. 詳細設計の要点

- **Guard の書き込みの段**（`src/safety/passive-request-guard.ts`、`request-policy.ts`）: ログインの段の `LoginPostAdmission`・送信の窓の作りを、書き込みの段の口として足す（ログインの段の振る舞いは変えない）。本文の照合の関数を受け取る。記録は公開のスキーマを変えない形（Guard の段の指定の中）。
- **factory の入口**（`src/browser/context-factory.ts`）: 認証つきの Run の状態（ログインの後の状態）を持ち、書き込みの段の Guard と出口の中継（中継は http の二重の守り。https の CONNECT の中身は見えないので、強制は Guard）を付けた Context を作る。
- **Gate**: `src/` で Playwright の `APIRequestContext`（`context.request`、`page.request`、`request.newContext`）を使わない。入力の操作はログインと書き込みの 2 つの owner だけ。本文の照合の関数を owner の外に書かない。
- **IPC**: 親 → 子の START に書き込みの指定（シナリオの版、生成した値、検証の指定、許可の id）、子 → 親の確かめの依頼と送信の報告（`SENT`・`NOT_SENT`・`UNKNOWN`）、親 → 子の確かめの結果。
- **読み込みの回数と間隔**: ログイン、画面の確かめ（凍結した Context で GET 1 回）、書き込みの画面（GET 1 回）、POST 1 回、結果の画面（redirect の GET）、照合の READ（GET を定義の数だけ）。どの読み込みも設定の間隔（`crawl.minNavigationIntervalMs`）を守る。読み込み直しはしない。

## 5. SSOT と安全性への影響

| 項目 | owner | この設計での扱い |
| --- | --- | --- |
| 書き込みの段の要求の判定 | `src/safety/request-policy.ts` | 拡張（ログインの段と同じ owner） |
| 送る中身の照合 | `src/safety/`（新しい純粋な関数） | 新設 |
| フォームの入力 | `src/browser/write-form-submitter.ts` | 新設（入力の操作の 2 つ目の owner） |
| 承認・許可・予約 | `src/control/approval/` | 利用（予約の締め、連続の上限と検証の指定の確かめを足す） |
| 生成 | `src/control/data-rules/` | 利用 |
| READ の照合 | `src/discovery/` の READ の部品 | 利用（生成した値に結び付けた送る値と期待を足す） |

- 公開監査・認証つきの監査・発見・READ の振る舞いと出力は変えない。
- 書き込みは、書き込みのモードのプロファイルで、承認された許可を消費したジョブだけが送る。

## 6. テスト設計

- 書き込みの段の Guard: 承認の要求の形に一致する 1 回の POST だけが届く、2 回目・別の path・別の Origin・GET の書き込み・redirect の再 POST・iframe・popup・Worker・beacon・fetch・WebSocket は届かない（両方の Chromium。サーバの記録で数え、全部の回の後に 2 秒待ってもう一度数える）。
- 送る中身の照合: 未知の欄、値の違い、`text/plain`、file の中身、UTF-8 でない文書、CSRF の値を記録しない。
- フォームの確かめ: action・`formaction`・enctype・target・form の外の欄・DOM の書き換え（確かめの後に form を差し替える）・digest の不一致。
- 結果の判定と ID と照合: 成功・入力の誤り・429・5xx・どれにも当たらない・2 つに当たる・セッションの切れ・ID が取れない・READ の照合の一致と不一致。
- 予約の締め: 応答あり → `COMMITTED`、送らずに止めた → `RELEASED`、応答なし・接続の断・ワーカーの異常終了・画面のサーバの再起動 → `UNKNOWN`。`UNKNOWN` の後も次の Run を実行でき、件数に数え、送った値が使った値になる。
- 連続の上限（5 分、24 時間に 5 件）、撤回の後の送る直前の確かめ直しで止まる。
- test-only の fixture（127.0.0.1）で 1 件だけ永続化される。二重の登録 0、上限の超過 0。
- 目印の検査（資格情報・Cookie・CSRF のトークン・hidden の値が、成果物・管理データ・ログ・IPC・画面に出ない。送った値は出てよい場所が決まっている）。
- 回帰: 公開監査・認証つきの監査・自動ログイン・発見・READ・シナリオ・入力の規則。
- Gate: `APIRequestContext` の禁止、入力の操作の owner、本文の照合の owner。

## 7. 対象外

- UPDATE（Task 31）、複数の段のシナリオ、READ の結果の値を使う生成。
- サーバの側の通知の自動の確かめ（副作用の確認と環境の証跡に頼る）。
- 実テスト環境での実行（ADR-013。ロードマップの終わりに、ユーザーの承認とユーザーの起動で、累積の上限を 1 にして行う）。

## 8. 完了条件（G30）

- [ ] 承認の範囲の外の書き込み 0、意図した CREATE が 1 件、照合が一致、二重の登録 0、上限の超過 0、結果が分からないのに成功と偽る 0（fixture。両方の Chromium）。
- [ ] 公開監査と既存の機能が変わらない。
- [ ] 独立レビューで Critical 0、Important 0。`npm run verify:all` を承認の後に 1 回。

## 9. 実装計画の分け方（概要。承認の後に実装計画を書く）

T30a 契約（`ActionRun`・結果のコード・シナリオの検証の指定・承認の digest の項目の追加）→ T30b 書き込みの段の Guard と要求の判定と本文の照合と factory の入口（安全の中心）→ T30c 入力の部品と Gate → T30d 版 8（版 7 の固定を先に）と書き込みの結果の記録、予約の締めと回復、連続の上限と検証の指定の確かめ → T30e ジョブの管理と IPC（確かめ直しの往復、送信の報告）→ T30f ワーカーの流れ（画面の確かめ → 確かめ直し → 入力 → 送信 → 判定 → ID → READ の照合 → `action-run.json`）→ T30g 画面（開始、結果、`UNKNOWN` の表示、検証の指定の入力）→ T30h 永続化する fixture、目印の検査、回帰、手順書 → T30R 独立レビュー。

## 10. ユーザーの承認が要る点

1. **`UNKNOWN` の後の扱いの具体化**（判断 2）: 件数を使ったものとして数え、送った値を使った値に入れ、自動の再試行はせず、画面に `UNKNOWN` をはっきり出す。止めないので、テスト環境で二重の登録が起きうることを受け入れる（BeakSight は同じ値を二度と生成しない）。
2. **送る中身の照合の厳しさ**: 欄の名前は送る欄と承認した候補の hidden・readonly の欄だけ、送る値は生成した値と完全に一致、enctype は urlencoded と multipart だけ、file の欄は空、UTF-8 の文書だけ。hidden・readonly の欄の値（CSRF のトークン）は読まない。
3. **画面の確かめで GET が 1 回増える**: 書く前に、凍結した別の Context で書き込みの画面を開き、候補が承認のときと同じかを確かめる。
4. **環境の証跡を書き込みの条件にする**: プロファイルの `environmentEvidenceRef`（テスト環境であることの証跡の参照）が空なら、書き込みの実行の許可を出さない。
5. **検証の指定の形**: 成功の条件・入力の誤りの条件（`{pathPrefix, selector}`）、ID の取り方（path の型か要素）、照合の READ（Task 27 の READ の定義を参照し、送る値の一部を生成した値に結び付け、期待を選ぶ）。

## 11. 設計変更履歴

| 日付 | 理由 | 変更 | 影響 |
| --- | --- | --- | --- |
| 2026-10-13 | 初版 | T30 の調査とユーザーの判断（2 章）による | — |
| 2026-10-13 | T30a の報告（発見事項 2） | 5xx の応答は `FAILED` ではなく `UNKNOWN` にする（サーバが 5xx を返す前に登録を済ませていることがあり、失敗と言い切れないため）。429 は `FAILED`。予約は応答ありなので `COMMITTED`、送った値は使った値に入れる。結果の条件・path・セレクタの形と重なりの判定は、Task 26 の owner（`auth-setup-policy.ts` の非公開の関数）を公開して共用する。 | `action-outcome.ts`、`scenario-policy.ts` |
| 2026-10-13 | DEF-096（T31 の調査） | 送る中身の照合で、`_method` の値を承認した候補の上書き（`PUT`・`PATCH`・なし）と照らす（`METHOD_OVERRIDE_MISMATCH`）。名前だけの passthrough に `_method` を入れない。 | `write-payload-policy.ts`、`write-form-submitter.ts` |
| 2026-10-13 | Task 31 の設計 | 登録の ID は、path の 1 区切りに入れて安全な閉じた形（英数字・`_`・`-`、1〜64 文字。名前つきの定数）だけを受ける。Task 31 と共用する部品にする。外れる ID は `PARTIAL` の `RECORD_ID_UNSAFE`（T30f で入れる）。 | `src/control/actions/`、T30f |
| 2026-10-13 | T30f の Blocker | (1) `START` の `write` に `profileId` と `seedRecord`（親が生成で作った seed の記録）を足す（ワーカーが自己完結の `action-run.json` を書くため。IPC の版 2 は未公開なので版は上げない）。(2) 版 8 は未公開なので、理由 `RECORD_ID_UNSAFE` を足して版 8 の文を作り直す（SHA-256 の固定を更新する）。 | `worker-protocol.ts`、`worker-message.schema.json`、`write-job-start.ts`、`migrations.ts`、T30f |
| 2026-10-13 | DEF-099（応答の前に接続が切れると、Chromium が書き込みの POST を自動で送り直し、登録が 2 件。送り直しは CDP の Fetch より下の層で、https と本番の Chromium では Guard も中継も止められない。調査 `DEF-099-research-brief.md`） | ユーザーの判断（2026-10-13）「BeakSight が 1 回だけ送る」により、3 章の送り方を変える: ページのフォームに値を入れて押すところまでは今のまま。Guard が書き込みの段の承認の POST を Request の段で止め、送る中身の照合が通ったら、ブラウザに送らせず、Node の送り手（新しい owner）が照合した同じ bytes を中継を通して 1 回だけ送り（再試行なし、redirect を追わない）、応答を `Fetch.fulfillRequest` で返す（切れた・時間切れは `Fetch.failRequest`）。中継は http で窓の間の承認の POST を 1 回だけ通す重ねの守り。TLS は Node が OS の証明書で確かめる（確かめを切らない）。ブラウザが付ける `Sec-Fetch-*` などは、同じ Origin のナビゲーションの閉じた値で付け直す（完全には同じにならないことを手順書に書く）。自動ログインの段は送り方を変えず、ログインの POST に応答がなかった回は試した回数を 2 回と数える（ユーザーの判断）。 | `passive-request-guard.ts`、新しい送り手、`egress-proxy.ts`、`context-factory.ts`、`write-stage-boundary` の Gate、自動ログインの試しの数え方、T30h |
| 2026-10-14 | G30 | ユーザーが「Task 30を承認」。最後の `verify:all` は `verify` が 11,560 件のうち 2 件 FAIL（DEF-105 の揺れ）、`verify:ui` が 343 件のうち 1 件 FAIL（T30g の漏れ。直して 11 件 PASS）の結果で承認された。管理データの版 8 は公開になった。 | — |
| 2026-10-14 | DEF-108（T31R の C-1） | ユーザーの判断（2026-10-14）「更新と登録の両方で値も照らす」により、10 章の 2 の「hidden・readonly の欄の値は読まない」を変える: 秘密に見える名前（CSRF のトークンなど）を除く hidden・readonly・見えない欄の値を、送る前の読み取り（画面の確かめ）で読み、送る中身の照合で前の値と完全に一致することを照らす。秘密に見える名前の欄は名前だけ。読んだ値は記録しない。 | `write-form-submitter.ts`、`write-create-run.ts`、`write-payload-policy.ts`（必要なら） |
