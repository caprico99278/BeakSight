# BeakSight 一覧の行から開く入力での更新 設計書

作成日: 2026-11-02
状態: ユーザー承認済み（2026-11-02）
対象範囲: 一覧の画面の各行から開く入力（窓・行の下に広がる欄）での更新を、どのサイトにも使える汎用の形で、操作さがし・自動の下書き・承認・書き込みの段・照合に通す。

## 1. 目的

今の更新は、行ごとに別の画面（`/items/{id}/edit` など）がある作りだけを扱えます。けれど、多くのサイトでは、一覧の画面の各行にある「編集」を押すと、その場に入力が開きます。この形は、今は更新の候補になりません。

この設計では、特定のサイトに合わせた作りを入れません。HTML と ARIA の標準の形（`<dialog>`・`role="dialog"`・行の中のフォーム）と、送り先の標準の形（query の filter・path の番号）で見分けます。行は、登録で送った毎回違う値で選びます。送る時の守りは、今の Guard（台帳の番号と完全一致する 1 件だけを通す）を使います。

## 2. 根拠となる文書と優先順位

- 従う文書:
  - `2026-08-27-beaksight-implementation-tasks.md`（SSOT Owner Matrix・Safety Invariants）
  - `2026-10-27-beaksight-one-pass-flow-design.md`（4.1.2 の R1、4.1.7 の N1・N2 と OP-REV3、4.1.8 の Q1、4.1.9 の R2）
  - `2026-10-18-beaksight-task-41-api-update-design.md`（API の更新・台帳と filter の結び付け・前の値）
  - `2026-10-13-beaksight-task-31-approved-update-design.md`（フォームの更新）
  - `2026-10-21-beaksight-probe-navigation-and-dialog-design.md`（DEF-145・窓の中の保存）
- この設計書が広げる箇所:
  - one-pass-flow 4.1.9 の R2（「一覧の画面で更新の候補を探す」は未設計だった）を、この設計書で決める。
  - task-41 の「更新の画面の path に `{id}` が要る」の決まりを、一覧の行の形に限って緩める（4.4）。
- 引き続き守る不変条件:
  - Passive Context では GET・HEAD のほかを送らない（操作さがしは凍結した Context で押す）。
  - 書き込みの段で送ってよいのは、承認した型と台帳の番号に完全一致する 1 件だけ。
  - 削除は、どの段でも止める。
  - `src/**` に対象のサイトに固有の名前・path・selector を書かない。
  - 第二の owner を作らない。

## 3. 調べで分かったこと（LU-research、2026-11-02）

127.0.0.1 の仮のサイトで、本物の factory と Guard を使って確かめました（2 つの Chromium で同じ結果）。

| 形 | 今の部品で | 足りないこと |
| --- | --- | --- |
| A_FILTER: 窓 + `PATCH /api/items?id=eq.N` | 保存は見つかるが `FILTER_NOT_PAGE_VALUE` | 分類・契約・押す段・行の選び方 |
| A_PATH: 窓 + `PATCH /api/items/N` | 型の path に番号が残り、行ごとに digest が変わる。Guard は `QUERY_MISMATCH` | 上の 4 つ + path の番号の型 |
| A_DRAFT: 窓を開くとサイトが下書きを POST | 「編集」が `API_CREATE` になり、登録の行ができる（DEF-186） | 分類の直し |
| B: 行の下に広がるフォーム（画面 `/items` → 送信先 `/items/N`） | フォームの更新が行の数だけ見つかり、番号の型は null | 送信先だけの番号の型・押す段・行の選び方 |
| C: 別の編集の画面 | 今のまま扱える | なし |

安全の実験:
- 操作さがし（凍結した Context）で「編集」を押して開く・閉じる: 読み取りでない要求は 0。
- 書き込みの段で窓の前（N2）に「編集」を押す: サイトの自動の下書きの POST が届いた（開くたびに 1 件）。
- 書き込みの段の N2 で、名前のないアイコンの削除（削除の語も DELETE もない `POST`）を押す: 届いた。
- Guard は、filter の PATCH を台帳の番号と完全一致の 1 件だけ通した。

## 4. 採用する設計

### 4.0 ユーザーが決めたこと（2026-11-02「おすすめのとおりで進めて」）

| # | 決めたこと |
| --- | --- |
| D1 | path に番号が入る形（A_PATH）も扱う |
| D2 | 書き込みの段では、窓の前（N2）で「編集」を押す。サイトの自動の下書きの送信は止めない（削除のほかは止めない方針） |
| D3 | 名前（文字・`aria-label`・`title`）のないアイコンだけの開き手は、書き込みの段で押さない |
| D4 | 作った行が一覧の最初の画面にちょうど 1 つ見つからないとき（0 か 2 以上）は、送らずに「更新できませんでした」。ページ送り・検索はしない |
| D5 | 行の下に広がるフォームの形（B）も範囲に入れる |
| D6 | A_DRAFT の分類の誤りは、別の不具合（DEF-186）として直す |
| D7 | 操作さがしでは、同じ識別の開き手は 1 つだけ押す |

### 4.0.1 設計者が決めたこと（ユーザーに確かめてもらう）

| # | 決めたこと | 理由 |
| --- | --- | --- |
| K1 | **前の値は、書き込みの段の中で「編集」を押した後に読む。** Guard の期待のうち前の値だけを、窓を開く前に 1 回だけ後から入れる口を足す。入れていなければ送らない | 形 A・B では、押すまで欄がない。凍結した Passive で押す案は、下書きの POST が余分に 1 回届くので採らない |
| K2 | 開き手の語は、`編集`・`修正`・`edit` の 3 つ（`classification-words.ts` の 1 か所）。削除の語があれば開き手にしない | 誤って押す範囲を狭くする。足すときは 1 か所で済む |
| K3 | 更新の後の照合は、一覧の画面を 1 回読み、選んだ行に変えた欄の新しい値があるかで行う。窓を開き直さない | 開き直すと、下書きの自動の送信がもう一度届く。新しい値が一覧に出ない欄なら「送ったが確かめられませんでした」（今の文） |
| K4 | `POST .../{番号}`（path の最後が番号の POST）は、登録にしない（`NOT_EXECUTABLE`） | 番号のある送り先への POST は、登録より更新か操作のことが多い。誤った登録の行を作らない |
| K5 | 型の digest（`beaksight:api-shape/2` → `/3`）と承認の digest（`beaksight-approval/5` → `/6`）の版を上げる | 型の path と台帳の中身が変わるため。**今の API の承認は、次の点検で 1 回だけチェックのし直しが要る** |
| K6 | 開き手を押した後に新しくできた窓（React などで、押すと文書に足される窓）の中の保存も、操作さがしで押せるようにする | 今の SPA の多くはこの作りで、外すと汎用と言えない。DEF-145 の限界を、ここで埋める |

### 4.0.2 採らなかった案

- 凍結した Passive で「編集」を押して前の値を読む案: Passive にも送信の扱い（PASS_EXCEPT_DELETE）が当たるので、下書きの POST が余分に届く。
- 窓を開いてから「編集」を押す案: 下書きを送るサイトでは毎回取りやめになり、使えない。
- ページ送り・検索で行を探す案: サイトへの読み込みが増える（D4）。

## 5. 詳細設計

### 5.1 操作さがし（`src/interaction/submission-probe.ts`、`src/discovery/submission-probe-contracts.ts`）

1. **同じ識別を 1 つだけ押す（D7）。** 押す候補を集めた直後に、名前（見える文字・`aria-label`・`title`）があり、開き手の語だけを持つ候補（SSOT の `isOpenerOnlySubmitter`）について、識別の digest ごとに文書の順で最初の 1 つだけを残す。残りには、観察しなかった新しい理由 `SAME_IDENTITY_PRESSED` を付ける（押す回数を使わない）。理由の閉じた一覧・スキーマの enum・表示カタログに足す。開き手でない候補（同じ識別の保存のボタンが 2 つある画面など）は、今までどおり 1 つずつ押す（DEF-189）。
2. **どの開き手から出たかを記録する。** 窓の中の保存を押したときの記録 `SubmissionProbeRecord` に、任意の項目 `opener` を足す。中身は、開き手の識別の digest・名前があるか（文字・`aria-label`・`title`）・開き手の語。値（行の中身）は記録しない。
3. **押した後にできた窓の中の保存を押す（K6）。** 開き手を押した結果が `NO_REQUEST` で、押す回数が残っていれば、開いた窓（`<dialog open>`・`role="dialog"`・`aria-modal="true"`）の中のボタンを読み直す。登録・更新の語のある候補を、待ち行列の先頭に入れる。窓の外のボタンは足さない。
4. **開き手の側の要求（DEF-186、D6）。** 押した候補が開き手の語（K2）だけを持ち、登録の語がないのに、結果が `API_CREATE` のときは、`NOT_EXECUTABLE` にして新しい理由 `OPENER_SIDE_REQUEST` を付ける。この理由のときも、3 の読み直しを行う。直すのは probe の記録を作る 1 か所だけにする（後ろの部品はみな probe の結果を使う）。
5. 押す回数の上限（1 画面 3 回）は変えない。

### 5.2 型と分類（`src/core/api-request-shape.ts`、`src/discovery/api-shape-classification.ts`）

1. `pathShapeOf` は、**最後の区切り**が番号の形（`isRecordIdLikePathSegment` に当たる数字・UUID）のときだけ、それを `{id}`（`PATH_TEMPLATE_ID_SEGMENT`）にする。途中の区切り（`/projects/7/items`）は変えない。`url-path-redaction.ts` は変えない（ログインの段と IPC も使っているため）。
2. filter の形に `valueIsRecordIdLike`（値が番号の形か）を足す。値そのものは型に入れない。
3. 分類の入力に `openedFromRow`（probe の記録に `opener` があるか）を足す。
4. PATCH の分類（PUT は今のまま `PUT_METHOD` で扱わない。書き込みの Guard の method も POST・PATCH だけのため）:
   - filter が 1 つで `eq`、かつ「画面の path の番号と同じ」か「`openedFromRow` で値が番号の形」なら `API_UPDATE`（A_FILTER）。
   - filter がなく、型の path の最後が `{id}` なら `API_UPDATE`（A_PATH）。
   - そのほかは今のまま。
5. POST で型の path の最後が `{id}` なら、`NOT_EXECUTABLE`（新しい理由 `CREATE_PATH_HAS_ID`）にする（K4）。
6. 確かめ直し（`scenario-policy.ts` の型だけでの分類し直し）にも `openedFromRow` を渡し、probe の結果と食い違わないようにする。
7. 型の digest の版を `/3` にする（K5）。

### 5.3 Guard（`src/safety/api-write-payload-policy.ts`、`src/safety/passive-request-guard.ts`）

1. **path の形の更新（D1）。** 期待の path に `{id}` がちょうど 1 つ、最後の区切りにあるときだけ、filter のない UPDATE を受ける。`{id}` を台帳の番号（`/` を含まない形）に置き換えた具体的な path で、今の完全一致を行う。filter と `{id}` の両方を持つ期待は `EXPECTATION_INVALID` にする。
2. **前の値を後から入れる口（K1）。** `WriteStageMonitor` に、前の値を 1 回だけ入れる口を足す。
   - 入れてよいのは、窓を一度も開いていない間だけ。窓を開いた後は拒む。
   - 2 回目は拒む。
   - 一覧の行の形の期待で前の値が入っていなければ、窓の中の送信は止める（fail-closed）。
   - 前の値の鍵の集合は、承認の時に決まっている（保つ欄の名前）。口で入れられるのは値だけで、鍵を足したり減らしたりできない。
3. 「承認した送信先とその下は通さない」（N2 の守り）は、今のまま（`{id}` はどの 1 区切りにも当たる）。path の形の期待では、`{id}` の 1 つ上の path（表の一覧の path）も守る送信先に足し、filter の形と同じ強さにする（LU-SREV1 の Important-1）。
   - 照合へ回す判定（`request-policy.ts` の `isAllowedApiWrite`）は、番号を入れた具体的な path と完全一致で比べる（`WriteStagePolicy` の任意の項目）。N2 の守りは型の path のまま。具体的な path の組み立ては照合の側（`approvedPathOf`）の 1 か所にする。
   - 番号の形の決まり（`isUsableRecordId`）は `src/core` の 1 か所にし、台帳の側と照合の側の両方が使う。
4. N2 で通るもの（D2）: 削除でなく、承認した送信先の下でない、読み取りでない要求。サイトの下書きの自動の送信は、これに当たる。窓を開いた後（N1）に読み取りでない要求が出たら、今のとおり取りやめにする（サイトが窓の間に自動で保存するときは「更新できませんでした」。既知の限界）。

### 5.4 台帳・下書き・承認（`src/control/approval/`）

1. **台帳に一覧の行の種類を足す。** `ScenarioApiLedger`・`ScenarioUpdateDraft` に任意の項目 `listRow` を足す。
   - `listPagePath`: 一覧の画面の path（`{id}` なし）。候補の画面の path と同じであること。
   - `openerIdentityDigest`: 開き手の識別の digest。
   - `rowKeyField`: 行を選ぶ欄（台帳の登録の、毎回違う欄。`uniqueEachRunFieldNamesOf` の中から 1 つ）。
   - スキーマ `schemas/control/scenario.schema.json` も変える。
2. **確かめ（`scenario-policy.ts`）。** `listRow` があるときは、`formPathTemplate` の `{id}` を求めない。代わりに次を確かめる。
   - 一覧の path が候補の画面と同じ。
   - 開き手に名前がある（D3）。名前がなければ下書きを作らない。
   - 行を選ぶ欄が、台帳の登録の毎回違う欄にある。なければ下書きを作らない。
   - A_PATH では filter が null でよい。
3. **台帳への結び付き。** 更新の型の path が、台帳の登録の型の path の後ろに `/{id}` を 1 つ足したものなら、同じ表として結び付ける。番号の鍵は、登録の応答の鍵（`apiRecordId.key`）を使う。番号の鍵の推し（同じ表の判定）にも、この決まりを使う。
4. **自動の下書き。**
   - API: `opener` のある候補では、一覧の path そのものを 1 つの型の案にする。
   - フォーム（形 B、D5）: `fingerprint.ts` に「送信先の最後の番号の区切りだけを `{id}` にした識別の digest」を足す（`pagePathTemplatedIdentityDigestOf` と対の部品）。行ごとのフォームを 1 行にまとめ、型を「画面 = 一覧の path、送信先 = `/items/{id}`」にする。
   - 変える欄は、今の `chooseUpdateChangedField` で選ぶ（K3 の照合のため、一覧に出る文字の欄を先にできるかは、実装の時に確かめる。できなければ今のまま）。
5. 承認の digest に `listRow` を入れ、版を `/6` にする（K5）。

### 5.5 書き込みの段（`src/worker/write-create-run.ts`、`src/browser/api-write-submitter.ts`、`src/browser/write-form-submitter.ts`、`src/discovery/read-executor.ts`）

一覧の行の形の流れ（API・フォームとも）:

0. **送る前の確かめ（LU-REV の I-1・I-1b）。** 書き込みの段の前に、登録と同じ送る前の READ（`preSubmitReadStop`）を、照合と同じ行の選び方（`rowSelection`）つきで 1 回読む。選んだ行に新しい値がもう見えていれば `VALUE_ALREADY_PRESENT`、判定できなければ `VERIFICATION_READ_UNAVAILABLE` で送らない。これで「行の今の値がもう新しい値を語として含む」形と「照合の READ の検索の語をページがそのまま描く」形の両方で、送らずに止まる（サーバが変えなくても VERIFIED になる経路を塞ぐ）。
1. 書き込みの段の Context で、一覧の画面を開く（GET 1 回）。
2. **行を探す（D4）。** 行の決まり（`read-executor.ts` の、`tbody tr` で `td` のあるもの・`ul`・`ol` の `li`）の owner を使い、「行を選ぶ欄の値を含む行」を返す読み取りを足す。ちょうど 1 つでなければ、送らずに止める（新しい理由 `ROW_NOT_UNIQUE`）。見つけた行が、変える欄の新しい値をもう含んでいれば（同じ部品 `findListRowsContainingValue` で、同じ行に当たれば）、送らずに止める（`VALUE_ALREADY_PRESENT`。0 の確かめと書き込みの段の間にページが変わる形の守り。GET は増えない）。
3. **開き手を探して押す（N2、D2・D3）。** その行の中で、識別の digest が `openerIdentityDigest` と同じで、名前のある開き手が、ちょうど 1 つあること。なければ止める（`OPENER_NOT_FOUND`）。押すのは `api-write-submitter.ts`（フォームは `write-form-submitter.ts`）に足す部品で行う。押す・入れる操作の閉じた一覧（`tests/architecture/worker-login-hooks.test.ts`）は広げない。
4. 欄が出るのを待つ（今の `inspectApiWriteInputWhenRendered`）。
5. **前の値を読み、Guard に入れる（K1）。** 保つ欄の前の値を読み、台帳の最後の値と比べる（今の確かめ）。違えば送らない。同じなら Guard に 1 回入れる。
6. 今の流れで、入れる・窓を開く・押す。フォームの形では、行の中のフォームの送信先が `/items/{台帳の番号}` であることを確かめる。あわせて、見つけた form の、送信先を型にした識別の digest（`listRowFormTemplatedIdentityDigestOf` と同じ部品）が、承認した候補の digest と同じことを確かめる（違えば `FORM_NOT_READY`）。送信ボタンは、押す前と押す時点（`pressWithPressTimeGuard` の確かめ）の両方で、語が承認した候補の送信ボタンの語と同じで、削除の語（`DISCOVERY_DESTRUCTIVE_WORDS`）を含まないことを確かめる（LU-REV の I-2。形 C・登録の候補の digest の照らしと同じ強さにする）。
   **書き込みのジョブの間の状態の受け継ぎ（LU-SREV4 の Important-1）。** 書き込みのジョブ（登録・更新）の間は、ページのスクリプトが書ける状態（localStorage・sessionStorage・IndexedDB・HttpOnly でなく、サーバの `Set-Cookie` で来たのでもない cookie）を、ジョブの始まりの世代に固定する。書き込みの段の Context だけでなく、送る前の READ・送る前の確かめなど、ジョブの中のどの Context の後でも、ページが書いた値は次の Context（照合の READ を含む）へ渡さない。受け継ぎの owner は factory の 1 か所（`writeStageCarriedStateOf` の当たる範囲を広げる）。ページのスクリプトがログインの値を回す作りでは、照合が「確かめられませんでした」になりうる（止める側）。
   Guard の N2 の型の path（`guardedPathShape`）は、更新の期待の書き込みの段では必須にする。渡されなければ `EXPECTATION_INVALID` で窓を開かない（LU-REV の M-1）。
7. 照合（K3）: 新しい凍結した Context で一覧の画面を 1 回読み、行を選ぶ欄の値で選んだ行に、変えた欄の新しい値があれば VERIFIED。

IPC（`src/control/worker-protocol.ts`、`src/control/job/write-job-start.ts`）: `listRow` のある START を受ける。そのときは、一覧の path と候補の画面の path の一致を求める（番号を入れた path の一致の代わり）。行の鍵の値は、台帳の最後の値（`knownKeptValuesOf`）から持ってくる。

### 5.6 画面（`apps/local-ui/`）

- 一覧の行の更新は、形 C の更新と同じく、登録の画面の行の結果に 1 行で出す。新しい画面の状態は足さない。
- 送らずに止めたとき（`ROW_NOT_UNIQUE`・`OPENER_NOT_FOUND`）の文は「更新できませんでした（作った行が一覧の最初のページに見つかりませんでした）」のような短い 1 文にし、`src/presentation/messages.ts` に足す。番号や技術の語は出さない。
- 名前のないアイコンだけで更新を扱えない画面（D3）は、今の `NOT_DECIDABLE` の 1 行にし、「この画面の更新は自動で扱えません」の短い文にする。理由の細部はログにだけ残す。

### 5.7 サイトへの負荷と速さの上限

- 操作さがし: 押す回数の上限は 1 画面 3 回のまま。同じ識別を 1 つにまとめるので、一覧の画面の押下は今より減る。
- 書き込みの段（1 件の更新）: 送る前の確かめの READ 1 回（照合の READ と同じ。画面の path の GET と READ の URL の GET の 1〜2 回。登録と同じ）、一覧の画面の読み込み 1 回、開き手の押下 1 回、保存 1 回。照合で一覧の画面の読み込み 1 回。ページ送り・検索・読み込み直しはしない。1 件の更新で BeakSight が読む GET は 3〜4 回。
- サイトの下書きの自動の送信: 開き手の押下 1 回につき、サイトが送る数（実験では 1 件）。BeakSight からは足さない。
- 要求の間隔は、今の書き込みの段の決まりに従う（変えない）。
- 操作さがし（5.8）: 「編集」で移った先の編集の画面を、1 回の操作さがしで最大 3 ページ GET で読む（間隔は変えない）。

### 5.8 「編集」で別の編集の画面へ移る一覧（DEF-190。2026-11-04 追補、設計者の既定）

実テスト環境で、一覧の画面の「編集」（リンクでないボタン）を押すと、ページのスクリプトが別の編集の画面（`/items/{番号}` の形。番号はハッシュのような値）へ移る作りが見つかった。操作さがしは、この押下を `PAGE_CHANGED` で終え、移った先の画面を読まなかった。編集の画面へのリンクがないので、巡回でもたどれない。形 C の更新（別の編集の画面）は今の仕組みで扱えるので、足りないのは「移った先の画面を読むこと」だけである。

1. **移った先を覚える。** 操作さがしで、開き手の語だけを持つ候補（SSOT の `isOpenerOnlySubmitter`）を押した後に main frame の URL が変わったら、移った先の URL を覚える。条件は次のすべて: 押した画面と同じ Origin、巡回のリンクと同じ除外（読まないパス・危険な語・読む範囲）に当たらない、path が押した画面の path の 1 つ下で、最後の区切りが使える番号（`isUsableRecordId`）。移りを止めた画面でも、URL が分かれば同じに扱う。URL が分からなければ、今のまま（`PAGE_CHANGED` だけ）。番号の値は、手で入れさせない（自動で拾う）。
2. **すぐに読む。** 覚えた画面は、巡回の待ち行列の先に入れ、今の画面の読みと同じ手順（Passive の GET、凍結、候補の発見と probe）で読む。数の上限は 1 回の操作さがしで `MAX_OPENED_EDIT_PAGE_READS = 3` ページ（登録の画面の先読みと同じく、`crawl.maxPages` の外で数える）。同じ型の path（番号を `{id}` にした形）は 1 回だけ読む。
3. **後は今の形 C のまま。** 読んだ編集の画面の保存は、今の probe で `API_UPDATE`（または form の更新）になり、更新の下書き・承認・書き込みの段（BeakSight が同じ点検で登録した行の番号で、その画面を開いて保存する）は今の形 C の流れを使う。新しい書き込みの経路は足さない。
4. **サイトへの負荷。** 足すのは、1 回の操作さがしで最大 3 ページの GET（読み込みの間隔は今の `crawl.minNavigationIntervalMs` のまま）。開き手の押下の数は変えない（D7 で同じ識別は 1 回）。

### 5.9 番号のほかに所属の絞り込みがある更新（DEF-198。2026-11-04 追補、設計者の既定）

実テスト環境の別の編集の画面の保存は、`PATCH /items?id=eq.<画面の番号>&tenant_id=eq.<所属の値>&select=…` だった（本文にも `id`・`tenant_id`）。登録の送信の本文にも、ページが入れる `tenant_id` がある。調べ（DEF-198-research、scratchpad `def198\`）で、値を照らさずに通す案（A）では別の所属の値の PATCH がサーバに届くことを確かめた（番号が所属ごとのサイトでは承認の外の行に当たりうる）。次の B と D を採る。

1. **分類（`api-shape-classification.ts`）。** PATCH の絞り込みのうち、画面の番号と一致する印（`valueMatchesPagePath`）を持つものがちょうど 1 つで、ほかは名前が重ならない `eq` だけなら、`API_UPDATE` にする。番号の絞り込みは並び順（`filters[0]`）でなく、この印で選ぶ。一覧の行から開いた形（番号を印で決められない）は、今のまま `FILTER_MULTIPLE`。
2. **承認の指定。** 番号の絞り込みの名前（`filterName`）のほかに、ほかの絞り込みの名前の一覧を指定に持つ。承認の digest には、一覧が空でないときだけ足す（今の承認は、そのまま有効）。
3. **照合（B。`api-write-payload-policy.ts`）。** 書き込みの段で、ほかの絞り込みはそれぞれちょうど 1 回、`eq.` で、値が「同じ点検で BeakSight が登録した行の、同じ名前のページが決めた値」と一致することを求める。値は、登録の成果物 `action-run.json` の `api.pageKeyValues`（Guard が登録の送信の本文を照合して返した、ページが決める鍵の値。今も残している）から、親が点検の連鎖の書き込みの段を締めるときに読み（確かめ済みの文書）、登録が VERIFIED のときだけ点検の連鎖のメモリ（`chain.lastWrite`）に持って、同じ点検の更新の開始の指定に渡す。Guard は取り付けのときに期待を写すので、写す項目に `otherFilterValues` を足す（`passive-request-guard.ts` の `snapshotApiWriteExpectation`）（DEF-198-fix の Blocker の後の設計者の判断。台帳の `submittedValues` は BeakSight が作った値だけで、ページが決める鍵の値は残らないため。データベースと成果物には新しく残さない。画面のサーバを起動し直すと消え、その後の更新は送らずに止まる）。値が取れなければ送らない（「更新できませんでした」）。
4. **本文の鍵（D）。** 本文の番号の鍵は台帳の番号、本文の所属の鍵は 3 で照らした値と同じことを求める。これらの鍵は、更新の画面の欄として見分けなくてよい（`SCENARIO_API_PAGE_KEY_NOT_IDENTIFIABLE` にしない）。
5. **変えないもの。** 絞り込み 1 つ・A_PATH・一覧の行から開く形の分類と型の digest は、今と同じ。`neq`・`in.`・`or=`・同じ名前が 2 つ・番号が 2 つは止める。
6. **サイトへの負荷。** 変わらない（GET も送信も増えない）。

### 5.10 更新の本文に、編集の画面の欄と結びつかない鍵がある（DEF-203。2026-11-05 追補、設計者の既定）

実テスト環境の編集の画面の保存は、5.9 の形に加えて、本文に欄と結びつかない鍵（区分の文字・公開の真偽・画像の URL の null）を持っていた。これらは、`pageKeyFieldOf` で更新の画面の欄として見分けられない（probe の欄に名前がない）。そのため、型の入口（`apiScenarioShapeRejectionOf`、T41a の「更新では前の値と照らせる鍵だけを受ける」）で `SCENARIO_API_PAGE_KEY_NOT_IDENTIFIABLE` になり、一覧の行は「登録だけ」になっていた。5.9 の B と同じ考え方で、次を採る（案 A）。

1. **照合。** 更新の本文の、欄と結びつかない鍵（番号・所属の鍵のほか）は、それぞれ値が「同じ点検で BeakSight が登録した行の、同じ名前のページが決めた値」（5.9 の 3 と同じ出所。`action-run.json` の `api.pageKeyValues` → `chain.lastWrite`）と完全に一致することを求める。型（文字・数・真偽・null）も一致を求める。値がない鍵・一致しない鍵があれば送らない（「更新できませんでした」）。
2. **下書きと承認。** 登録の送信にも同じ名前のページが決める鍵があるとき（登録の形の `pageKeys` に含まれるとき）に限り、更新の型の入口で `SCENARIO_API_PAGE_KEY_NOT_IDENTIFIABLE` にしない。登録の側にない鍵は、今のまま止める。照らす鍵の名前の一覧を承認の指定に持ち、空でないときだけ承認の digest に足す（今の承認はそのまま有効）。
3. **守りの意味。** 照らす値は BeakSight が登録した行の値なので、ページが公開の状態などを変える更新は送らない（T41a の「前の値と照らせる」を、登録の時の値で満たす）。変える欄は今の規則 F で 1 つだけ選ぶ。
4. **変えないもの。** 一覧の行から開く形、絞り込み 1 つの形、フォームの形、登録の側の扱い。
5. **サイトへの負荷。** 変わらない。
6. **既知の限界（SREV-1105 の Minor）。**
   - 登録の時の数の値は、正規の形（`JSON.stringify(Number(値))`）で残す。そのため、ページが数を別の表記（`1.50`、2^53 より大きい整数など）で送ると、正しい更新でも照合が合わずに送らない（止める側に倒れる）。
   - 照らす値の型の食い違いは、開始の指定と IPC では見つけず、ワーカーと Guard で止める。

## 6. SSOT と安全性への影響

| 項目 | owner | この設計での扱い |
| --- | --- | --- |
| 型の path | `src/core/api-request-shape.ts` `pathShapeOf` | 拡張（最後の番号の区切りを `{id}`） |
| 値の伏せ方 | `src/core/url-path-redaction.ts` | 変更なし |
| API の型の分類 | `src/discovery/api-shape-classification.ts` | 拡張 |
| 押す候補・押す順 | `src/discovery/submission-probe-contracts.ts` | 拡張（同じ識別を 1 つ・開き手の側の要求） |
| 語の一覧 | `src/discovery/classification-words.ts` | 開き手の語を 1 つ足す |
| 行の決まり | `src/discovery/read-executor.ts` | 拡張（値を含む行を返す読み取り） |
| 送る時の照合 | `src/safety/api-write-payload-policy.ts` | 拡張（path の形の更新） |
| 書き込みの段の Guard | `src/safety/passive-request-guard.ts` | 拡張（前の値を 1 回だけ後から入れる口）。**安全のレビューの対象** |
| 台帳・承認の確かめ | `src/control/approval/scenario-policy.ts` | 拡張 |
| 承認の digest | `src/control/approval/approval-digest.ts` | 版を上げる |

- 第二の owner は作らない。行を探す決まりは `read-executor.ts` の 1 つだけ。押す操作は今の送り手の部品に入れる。
- 対象のサイトに固有の名前・path・selector は書かない。見分けは HTML・ARIA の標準と、開き手の語の一覧（一般の語）だけで行う。

## 7. 共通部品と共通仕様

| 区分 | 名前 | 置き場所 | この設計での扱い |
| --- | --- | --- | --- |
| 利用 | `probeDiscoveredSubmissions`・押す順 | `submission-probe.ts`・`submission-probe-contracts.ts` | 拡張 |
| 利用 | `isRecordIdLikePathSegment`・`PATH_TEMPLATE_ID_SEGMENT`・`concretePathOfTemplate` | `src/core/` | 利用のみ |
| 利用 | `checkApiWritePayload`・`isApiWriteEndpointUrl` | `src/safety/` | 拡張 |
| 利用 | `inspectApiWriteInputWhenRendered`・`fillApiWriteInput`・`submitApiWriteInput` | `api-write-submitter.ts` | 利用のみ |
| 利用 | `uniqueEachRunFieldNamesOf`・`knownKeptValuesOf` | `varying-values.ts`・`write-job-start.ts` | 利用のみ |
| 利用 | `chooseUpdateChangedField` | `update-changed-field.ts` | 利用のみ |
| 利用 | 自動の下書きの共通部品 | `autodraft-shared.ts` | 拡張 |
| 新設 | 値を含む行を返す読み取り | `read-executor.ts` | 台帳に足す |
| 新設 | 行の中の開き手を押す部品 | `api-write-submitter.ts`（フォームも同じ部品を使う） | 台帳に足す |
| 新設 | 送信先を型にした識別の digest | `fingerprint.ts` | 台帳に足す |
| 新設 | 開き手の語の一覧 | `classification-words.ts` | 台帳に足す |

- 変更容易性: 開き手の語を足すときは `classification-words.ts` の 1 か所。窓の見分け（`dialog` など）を足すときは probe の 1 か所。

## 8. テスト設計

- 単体: 型（`/api/items/4` → `/api/items/{id}`、`/projects/7/items` は変わらない）、分類（A_FILTER・A_PATH・`POST …/{id}`）、Guard（path の形の通す・止める、前の値の口の 1 回だけ・窓の後は拒む・入れていなければ止める）、契約の確かめ、承認の digest。
- 結合: LU-research の仮のサイト（A_FILTER・A_PATH・A_DRAFT・B・C、各行に削除）を `fixtures/` に一般の名前で作る。
  - 操作さがし: 押すのは同じ識別で 1 回、保存の記録に `opener`、A_DRAFT で登録の行が出ない、押した後にできる窓の保存を押せる。
  - 書き込みのジョブ: A_FILTER・A_PATH・B で VERIFIED。行が 0・2 のときは送らない。名前のないアイコンは押さない。下書きの自動の送信は通り、削除は届かない。
- 安全: 本物の factory と Guard で、127.0.0.1 の自前のサーバに対し、2 つの Chromium で確かめる。サーバに届く要求を数える。
- 端末の負荷: 1 ファイルずつ、`--maxWorkers 1`。ブラウザは 1 つずつ。

## 9. 対象ファイル

| パス | 責務 | 変更の種類 |
| --- | --- | --- |
| `src/interaction/submission-probe.ts` | 操作さがし | 変更 |
| `src/discovery/submission-probe-contracts.ts` | 押す候補・理由 | 変更 |
| `src/discovery/classification-words.ts` | 語の一覧 | 変更 |
| `src/core/api-request-shape.ts` | 型 | 変更 |
| `src/discovery/api-shape-classification.ts` | 分類 | 変更 |
| `src/safety/api-write-payload-policy.ts` | 送る時の照合 | 変更 |
| `src/safety/passive-request-guard.ts` | 書き込みの段の Guard | 変更 |
| `src/control/approval/scenario-contracts.ts`・`scenario-policy.ts`・`approval-digest.ts` | 台帳・確かめ・digest | 変更 |
| `src/control/approval/api-scenario-autodraft.ts`・`api-scenario-draft.ts`・`update-autodraft.ts`・`form-scenario-autodraft.ts`・`autodraft-shared.ts` | 自動の下書き | 変更 |
| `src/discovery/fingerprint.ts` | 識別の digest | 変更 |
| `src/discovery/read-executor.ts` | 行の決まり | 変更 |
| `src/browser/api-write-submitter.ts`・`write-form-submitter.ts` | 押す・入れる | 変更 |
| `src/worker/write-create-run.ts` | 書き込みの段の流れ | 変更 |
| `src/control/worker-protocol.ts`・`src/control/job/write-job-start.ts` | IPC・開始 | 変更 |
| `schemas/control/scenario.schema.json`・`candidate.schema.json`・`schemas/discovery.schema.json` | スキーマ | 変更 |
| `src/presentation/messages.ts`・`catalog.ts`、`apps/local-ui/src/display/write-screen-values.ts` | 文・表示 | 変更 |
| `fixtures/`（一覧の行の仮のサイト） | テスト | 新規 |

## 10. 対象外

- ページ送り・検索・無限スクロール・仮想化した一覧で行を探すこと（D4）。古い順に並ぶ一覧では、作った行が最初の画面になく、更新できない。
- 名前のないアイコンだけの開き手（D3）。
- iframe・shadow DOM の中の窓。
- 行の番号が登録の応答から分からない形（今の台帳の決まりのまま）。
- 窓を開いている間にサイトが自動で保存する形（N1 で取りやめになる。「更新できませんでした」）。
- 本来の監査対象のサイトでの確かめ（最後に 1 回、ユーザーが行う）。
- PUT の更新（今の Guard が POST・PATCH だけを書き込みの method とするため）。
- BeakSight が名前を確かめた「編集」を押したことに反応して、ページが押した瞬間にボタンの中身を書き換え、別の処理を行う作り（`pointerdown` で書き換えて click で分けるなど）。確かめた本物の開き手を押した結果なので、サイトの「編集」が自分で送る通信と同じ扱い（D2）になる。ページが先に `window` の capture の段に付けた受け手も止められない（LU-SREV3 の Minor-4・LU-SFIX3-A の限界）。
- 行の下に広がるフォームの形で、状態を表す隠れた欄（値を照らす hidden）の前の値は、台帳に記録がないので、ページの値を信じる（LU-SREV3 の LU-12b の条件 3）。
- 行の中に入力の欄がある形（IN_ROW）で、すぐ下の行が自分の開き手を持つ作りでも、その行の中の、送信先が対象の番号の form を選んだ行に結ぶことがある（LU-REV の M-2）。送信先・識別の digest・保つ欄を台帳と照らすので、別の行は変わらない。ROW_BELOW の形では `FORM_NOT_FOUND` で止まる。
- サイトのサーバが `Set-Cookie` で返す値（時刻など）と、ページの JS の描き方を組み合わせて照合を偽る作り（LU-SREV5 の Minor-1）。サーバの `Set-Cookie` で来た cookie は、ログインを保つためにサーバの状態として受け継ぐ（5.5）。偽るにはサーバの側の手助けが要る。
- 行の下に広がるフォームの形は、入力の誤りの表示（`INPUT_ERROR`）を判定しない（LU-REV の M-3）。照合が一致しなければ「確かめられませんでした」か「一部だけ」になり、VERIFIED にはならない。

## 11. 完了条件

- [ ] 8 の単体・結合・安全のテストが、1 ファイルずつ PASS する。
- [ ] 安全のレビュー（読み取りだけ、実機の実験つき）で Critical 0・Important 0。Guard の前の値の口（5.3 の 2）と N2 の押下を必ず含める。
- [ ] DEF-186 の再現のテストが RED → GREEN。
- [ ] Git に載るファイルに、対象のサイトの名前・画面の名前・資源の名前が 0 件。
- [ ] ユーザーの承認の後に、`verify:all` を 1 回 PASS させる。
- [ ] 実テスト環境での確かめ（ユーザーの操作）を 1 回行い、結果を記録する。

## 12. 実装の分け方

実装者 1 人が 1 回で終えられる大きさに分けます。順序は依存のとおりです。

| # | 中身 | 主な production | 依存 |
| --- | --- | --- | --- |
| LU-1 | DEF-186 の直し（開き手の語、`OPENER_SIDE_REQUEST`） | `classification-words.ts`・`submission-probe-contracts.ts`・`submission-probe.ts` | なし |
| LU-2 | 型と分類（5.2） | `api-request-shape.ts`・`api-shape-classification.ts` | なし |
| LU-3 | 行を探す読み取り・行の中の開き手を押す部品 | `read-executor.ts`・`api-write-submitter.ts` | なし |
| LU-4 | 操作さがし（同じ識別を 1 つ、`opener`、押した後の窓） | `submission-probe.ts`・`submission-probe-contracts.ts` | LU-1・LU-2 |
| LU-5 | Guard の path の形の更新 | `api-write-payload-policy.ts` | LU-2 |
| LU-6 | 台帳の契約と確かめ・承認の digest | `scenario-contracts.ts`・`scenario-policy.ts`・`approval-digest.ts` | LU-2・LU-4 |
| LU-7 | 自動の下書き（API） | `api-scenario-autodraft.ts`・`api-scenario-draft.ts`・`update-autodraft.ts` | LU-6 |
| LU-8 | IPC と開始 | `worker-protocol.ts`・`write-job-start.ts` | LU-6 |
| LU-9 | Guard の前の値の口（安全のレビューを先に 1 回） | `passive-request-guard.ts` | LU-5 |
| LU-10 | ワーカーの流れ（API の形） | `write-create-run.ts` | LU-3・LU-8・LU-9 |
| LU-11 | 形 B の識別と下書き | `fingerprint.ts`・`autodraft-shared.ts`・`form-scenario-autodraft.ts` | LU-6 |
| LU-12 | 形 B の確かめと書き込み | `scenario-policy.ts`・`write-form-submitter.ts`・`write-create-run.ts` | LU-10・LU-11 |
| LU-13 | 画面の文と表示 | `messages.ts`・`write-screen-values.ts` | LU-10 |
| LU-REV | 全体の安全のレビュー（Critical 0・Important 0 まで） | − | LU-1〜13 |

並べて動かすのは、変えるファイルが重ならない LU-1・LU-2・LU-3 だけにします（端末の負荷のため、同時に 2 人まで）。

## 13. 設計変更履歴

| 日付 | 契機 | 変更内容 | 影響範囲 |
| --- | --- | --- | --- |
| 2026-11-02 | ユーザーの問い「汎用的な設計として作れるか」と LU-research | 初版 | 本設計書 |
| 2026-11-02 | LU-2 の報告 | 5.2 の 4 を PATCH だけにした（PUT は対象外）。filter の番号の形は数字と UUID だけ | 5.2・10 章 |
| 2026-11-02 | LU-5 の Blocker | 5.3 の 3 に、照合へ回す判定と N2 の守りで照らす path を分けること、番号の形の決まりを 1 か所にすることを足した | 5.3・`request-policy.ts`・`passive-request-guard.ts`・`context-factory.ts` |
| 2026-11-02 | LU-4 の Blocker | D7 は名前のある候補だけに当てる（名前のないアイコンは見た目が違っても同じ識別になりうる）。K6 の候補は discover-page.ts の候補を作る処理を切り出して使う | 5.1 |
| 2026-11-04 | DEF-189（LU の後の verify:all で見つかった後退） | D7 のまとめを、開き手の語だけを持つ候補（`isOpenerOnlySubmitter`）に絞る。5.1 の 1 の文が名前のある候補全部に広がっていて、同じ識別の保存のボタンの 2 つ目を押さなくなっていた（T38R2-fix R2-I-1 が 2 つの Chromium で FAIL）。直しは `src/interaction/submission-probe.ts` の `firstOfEachNamedIdentity` だけ | 5.1 |
| 2026-11-04 | DEF-190（実テスト環境の確かめ） | 5.8 を足した。一覧の「編集」で別の編集の画面へ移る作りで、移った先（押した画面の 1 つ下で最後が番号の path）を操作さがしで最大 3 ページ読み、形 C の更新につなぐ（設計者の既定） | 5.8・5.7 |
| 2026-11-04 | DEF-198（実テスト環境の確かめ。調べ DEF-198-research） | 5.9 を足した。番号の絞り込みを印で 1 つに決め、ほかの `eq` の絞り込み（所属）を登録の時のページが決めた値と照らす（B）。本文の番号・所属の鍵も同じ値を求める（D）。値を照らさない案（A）は、別の所属の PATCH が届くので採らない（設計者の既定） | 5.9 |
| 2026-11-04 | DEF-198-fix の Blocker（照らす値が台帳に残っていない） | 5.9 の 3 の値の出所を、登録の送信の本文からワーカーが取り、締めの報告で親のメモリへ渡す形に直した（案 1）。変えてよいファイルに `audit-job-manager.ts` を足した | 5.9 |
| 2026-11-04 | DEF-198-fix の 2 つ目の Blocker | 値の出所を、新しい IPC でなく確かめ済みの `action-run.json` の `api.pageKeyValues` にした（同じ値を 2 つ目の経路で運ばない）。Guard の期待の写しに `otherFilterValues` を足す（`passive-request-guard.ts` を範囲に足した） | 5.9 |
| 2026-11-02 | LU-SREV1 の Important-1 | path の形の期待で、N2 の守りに表の一覧の path を足した | 5.3 の 3 |
| 2026-11-03 | LU-SREV4 の Important-1 | 書き込みのジョブの間は、ページのスクリプトが書ける状態をジョブの始まりの世代に固定する（書き込みの段の Context だけでなく、ジョブの中のどの Context の後でも） | 5.5・`context-factory.ts` |
| 2026-11-03 | LU-REV の Important-1・1b・2、Minor-1〜3 | 一覧の行の更新にも登録と同じ送る前の READ と、書き込みの段の「行がもう新しい値を含む」の確かめを足した。形 B の form の識別の digest と送信ボタンの語・削除の語を、押す前と押す時点で照らす。更新の期待の `guardedPathShape` を必須にした。M-2・M-3 を対象外に書いた | 5.5・5.7・10 章・`write-create-run.ts`・`write-form-submitter.ts`・`passive-request-guard.ts` |
| 2026-11-05 | DEF-203（実テスト環境で更新が「登録だけ」になる） | 5.10 を足した。更新の本文の、欄と結びつかない鍵を、登録の時のページが決めた値との完全一致で照らす（5.9 の B と同じ出所） | 5.10 |
