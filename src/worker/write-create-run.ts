/**
 * 書き込みのジョブ（`WRITE_CREATE`）の流れ（Task 30 の設計書 3 章の「書き込みの段」「フォームの画面の確かめ」「送る直前の確かめ直し」「結果の判定」
 * 「登録の ID」「READ による照合」「予約の締め」、4 章の「読み込みの回数と間隔」。T30f）。ワーカーの流れ（`audit-worker-session.ts`）が、ログインの段
 * の後に、認証の指定（`RunAuthentication`）と `START` の書き込みの指定と IPC の 2 つの口（確かめ直し、送信の報告）を付けて呼ぶ。書き込みの段の
 * Context を開き（`createWriteStageContext`）、書き込みのフォームの入力の部品（`write-form-submitter.ts`）を呼ぶのは、このファイルだけ（Gate
 * `write-stage-boundary` の (c)(d)）。
 *
 * 1. Run の始めと終わり（発見と READ の確かめと同じ部品 `startWorkerRun`・`endWorkerRun`）。
 * 2. Run の前の確認（`runPreflight`。認証の指定を付けた factory）。
 * 3. 送る前の確かめ（どれかで止まれば、送らずに `NOT_SENT`（`PRECHECK_FAILED`））:
 *    a. 書き込みの画面の URL を事前の判定（READ の確かめと同じ `isReadUrlAllowed`。許可 Origin、監査の段の除外、セッションの切れの path）に通す。
 *    b. フォームの画面の確かめ: 凍結した Context で書き込みの画面を 1 回読み（GET）、発見の入口で候補を読み直し、承認に縛った候補の識別と規則の
 *       2 つの digest が同じ候補が、ちょうど 1 つあること。
 * 4. 書き込みの段: 書き込みの段の Context（Guard の照合の期待は、承認の要求の形と、`writePayloadFieldsOf` が作る欄の部分。DEF-098 で、
 *    送る欄に選ばなかった見える欄の期待を含む）で、書き込みの画面を 1 回読み（GET）、`inspectWriteForm` → `fillWriteForm`（送信の窓を開いてから
 *    入れる）→ 窓の中で止めた要求がないことを確かめる → 押す前の読み込みの間隔を守る（最後の待ち）→ 止める印を確かめる → 送る直前の確かめ直し
 *    （IPC の往復。親が `assertGrantStillValid` と `approvalExternalFactsOf` を求め直す。拒まれる・時間切れなら送らない）→ もう一度止める印を
 *    確かめる → `submitWriteForm`。T30R-fix-1（DEF-103）: 確かめ直しを、最後の待ちと止める印の確かめの後、押す直前に移した（確かめ直しの結果を
 *    受けてから押すまでの間に、待ちと読み込みを入れない。前は書き込みの段の前で、その後の待ちと読み込みの間に撤回されても押していた）。親は、
 *    撤回とシナリオの変更のときに、動いている書き込みのジョブに `STOP` を送る。送る欄は、`values` のすべての欄（null は checkbox を外す・
 *    radio を選ばない。ほかの型に null があれば送らない）。
 * 5. 結果の判定（送った場合。Task 26 の結果の判定の作り）: Guard が通した POST の応答と、その後の main frame の文書で決める: 307・308（再 POST は
 *    Guard が止める）→ `REPOST_REDIRECT`、429 → `RATE_LIMITED`、5xx → `SERVER_ERROR`、セッションの切れ → `SESSION_LOST`、成功の条件と入力の誤りの
 *    条件（`{ pathPrefix, selector }`）のちょうど 1 つ → `SUCCESS`・`INPUT_ERROR`、2 つ → `MULTIPLE_CONDITIONS_MATCHED`、期限までにどれにも当たら
 *    ない → `NO_CONDITION_MATCHED`。応答がなければ判定なし（`NO_RESPONSE`）。T30R2-fix-1（M-b）: 応答を受けても、送り手の応答をブラウザに返せ
 *    なかった（Guard の `responseDeliveryCanceled`）か、押した後に main frame の POST のナビゲーションの要求がブラウザで失敗した（ブラウザが
 *    取り消した。ページの JS が別の画面へ移ったなど）なら、今の画面は POST の応答ではないので、成功の条件と ID を判定せず
 *    `RESPONSE_NOT_DELIVERED`（結果は `UNKNOWN`）にする（307・308 の判定の後。再 POST を Guard が止めた失敗と取り違えない）。
 * 6. 登録の ID（成功のときだけ）: 検証の指定の取り方（成功の後の URL の path の型、または成功の画面の要素の文字）で取る。成果物に書くのは、記録して
 *    よい値（`recordableRecordIdOf`）だけ。使える形（`isUsableRecordId`）かは、判定（`actionOutcomeOf`）が決める（形の外は `RECORD_ID_UNSAFE`）。
 *    T40R-fix-A2: 押す直前に同じ取り方で読んだ値（`pageRecordIdBaselineOf`）と同じ値、URL の型で URL が押す前から変わっていないときは、ID として使わない
 *    （`isPageRecordIdNew`。`RECORD_ID_NOT_FOUND`）。
 * 7. 送信の報告: 書き込みの段の Context を閉じた後（もう送れない時点）に、Guard の送信の報告から決めて 1 回だけ送る（`NOT_SENT` は、Guard が
 *    送る中身の照合で止めたなら `PAYLOAD_MISMATCH`、ほかは `PRECHECK_FAILED`）。
 * 8. READ による照合（成功のときだけ）: 書き込みの段を閉じた後、照合の READ（生成した値を結び付けた定義）を、READ の確かめの部品
 *    （`verifyReadCheck`。凍結した Context で候補を確かめ、別の Context で READ の URL を読む）で行う。
 * T31R-fix-1（C-1。DEF-108）: 3b の画面の確かめで、同じ画面の値を照らす hidden・readonly・見えない欄（秘密に見える名前でない欄）の値を読み
 *    （`readWritePassthroughValues`。記録しない）、照合の期待に入れる（送信の直前にページの JS が書き換えれば、Guard が止める）。UPDATE は、前の
 *    読み取りの `passthroughValues` で同じく照らし、更新の後の照合では比べない。
 * 9. `action-run.json` を、ArtifactWriter（`writeActionRun`。スキーマ `action-run`）で書く。判定は `actionOutcomeOf`、予約の締め方は
 *    `reservationSettlementOf`（親も決め直す）。資格情報・Cookie・CSRF のトークン・hidden の値は持たない（送った値は合成のテストデータ）。
 *    T32e（Task 32 の設計書 4.1）: その前に、書き込みの報告の承認の要約（`writeApprovalSummary`。`START` の承認の要約の事実をそのまま）と証拠
 *    （`writeActionEvidence`。送る前の確かめ、送信、応答と判定の時刻、照合の READ の証拠の全体、Guard の数の要約、人の値の印）を書く。3 つの文書は
 *    同じ事実から `writeRunDocumentsOf` で 1 回だけ組み立てる。どれかが書けなければ、`action-run.json` が書けないときと同じく reject する。
 *    T32f: 続けて、HTML の報告（`action-report.html`）と書き込みのバンドル（ZIP）を `writeActionPresentation` で書く（伏せ字の後の文書から
 *    `createActionPresentation` で 1 回だけ組み立てる）。`action-run.json` は最後。
 * 読み込み: 画面の確かめ（GET 1）、書き込みの画面（GET 1）、POST（と結果の画面への redirect）、照合の READ（対象の画面と READ の URL の GET 2）。
 * どれも設定の間隔（`crawl.minNavigationIntervalMs`。`NavigationPacer`）を守る。読み込み直しはしない。止める要求は、押す前の各段の前で確かめる
 * （押した後は止めない）。
 *
 * PL-6a（設計書 `doc/design/2026-10-26-beaksight-plain-ui-design.md` 8.1。調査 FV-0 の案 (b2)）: form の書き込みの結果の判定を、人が入れる条件（検証の
 * 指定の成功の条件と入力の誤りの条件。契約から外し、結果の判定のしかたの印 `FORM_STRUCTURE` に置き換えた）から、構造の判定に変えた。form の登録の ID は、
 * ID の型の一覧（`URL_PATH_PATTERNS`。2 つまで）だけから取る。記録は版 1.2（成否の条件の代わりに印）。上の 5・6・8 のうち form の部分を、次で置き換える。
 * - 送る前の確かめ（事前の READ。登録だけ）: 3b の画面の確かめの後、同じ値で照合の READ を 1 回読む（`preSubmitReadStop`。GET 1〜2）。値がもう見えて
 *   いれば `VALUE_ALREADY_PRESENT`、判定できなければ `VERIFICATION_READ_UNAVAILABLE` で送らない（`PRECHECK_FAILED`）。
 * - 押した後（`judgeFormResult`）: 307・308 と応答を返せなかった回は今のまま。ほかは、押す前に作った進行中の要求の数え方で、送った後の画面が落ち着く
 *   まで待って、発見の入口で 1 回読む（凍結。以後この Context では読み込まない）。最後の文書の状態、送ったフォームと同じ「フォームの形」
 *   （`formShapeKeyOf`）の候補の有無、その form が送った値を保っているか（`submittedValuesKept`）、送った後の URL の ID（`recordIdOfResultUrl`。押す前の
 *   URL と比べる）を観察として返す。状態が 2xx・3xx でセッションが切れていれば `SESSION_LOST`。
 * - 書き込みの段を閉じた後（`formSentFactsOf`）: 状態が 2xx・3xx なら、成否によらず照合する（登録は照合の READ、更新は更新の後の照合。更新の照合の READ
 *   は、更新の後の照合が一致して成功と判定したときだけ）。判定は `formResultJudgementOf`（4xx は入力の誤り、5xx は分からない、照合が一致すれば成功、
 *   一致しなければ、送った値を保った同じフォームが出たときだけ入力の誤り、ほかは判定できない）。結果は今どおり `actionOutcomeOf`。
 * - 読み込み（登録）: 画面の確かめ（GET 1）、送る前の答え合わせ（GET 1〜2）、書き込みの画面（GET 1）、POST（と redirect）、照合の READ（GET 2）。
 *   読み込み（更新）: 今と同じ（更新の後の読み取りは、成功でない 2xx・3xx の回にも 1 回読む）。1 件の予約、送り直しをしない、結果が分からないときに
 *   止める、の決まりは変えない。
 *
 * T31g-2（Task 31 の設計書 3 章の「更新の前の読み取り」「送信」「結果の判定」「更新の後の照合」「証拠と記録」、4 章の「読み込みの回数と間隔」）:
 * 更新の書き込みのジョブ（`WRITE_UPDATE`。`write.update` を持つ指定）も、この流れで行う（CREATE と同じ段を共有し、違う所だけを分ける。書き込みの段の
 * Context と入力の部品を使うのは、今どおりこのファイルだけ）。`formPage` と `request` の path は、親が対象の ID を入れた具体的な path。
 * - 3b の代わりに、更新の前の読み取り: 凍結した Context で具体的な更新の画面を 1 回読み（GET）、発見の入口で候補を読み直し、型にした識別の digest
 *   （`write.update.templatedIdentityDigest`）と規則の digest が同じ候補がちょうど 1 つあること。型にした digest は、候補の画面の path と送信先の
 *   path で、値が対象の ID と同じ区切りの組から求める（発見の部品の `templatedIdentityDigestForRecordIdOf`。T31i で共通化。組がちょうど 1 つで
 *   なければ、その候補は照らさない。fail-closed）。同じ画面で、書き込みの
 *   入力の部品（`readUpdateFormValues`）が前の値（変える欄と保つ欄、状態の名前の欄、組の hidden）を読む。L12b: 前の値の長さの上限
 *   （前は `MAX_SUBMITTED_VALUE_LENGTH`）は撤廃した。
 * - 照合の期待は `updatePayloadFieldsOf`（保つ欄・状態の欄・組は前の値）。書き込みの段では、`inspectUpdateForm`（書き込みの画面の値が前の値と
 *   同じか）→ `fillWriteForm`（変える欄だけ）→ … → `submitWriteForm`（4 と同じ順。押す直前の確かめ直しと止める印も同じ）。
 * - 結果の判定は 5 と同じ。成功のときは 6 の ID（取れた ID。対象の ID と違えば `RECORD_ID_MISMATCH`）を取り、書き込みの段を閉じた後に、更新の後の
 *   照合: 凍結した Context で具体的な更新の画面をもう一度 1 回読み、同じ候補の確かめと読み取りをして、欄ごとに `sameValue` で比べる（変えた欄は
 *   新しい値、保つ欄・状態の名前の欄・組の hidden は前の値）。読めなければ、どの欄も照合できない（null）。一致しない欄がなければ、8 の照合の READ
 *   （新しい値を結び付けた形）を行う。
 * - 証拠（`action-run.json` の `update`）: 欄ごとに 1 つ。変えた欄は `CHANGED`（前の値と送った新しい値。前の値がない checkbox などは空の値）、
 *   保つ欄・状態の名前の欄（組の hidden は組の名前の欄に含める）は `KEPT`（値なし）。結果は `actionOutcomeOf` に対象の ID と
 *   `fieldsMatchedOf`（証拠の欄の一致）を渡して決める。
 * - 読み込み: 更新の前の読み取り（GET 1）、書き込みの画面（GET 1）、POST（と redirect）、更新の後の読み取り（GET 1）、照合の READ（GET 2）。
 *
 * T40b-1（Task 40 の設計書 3.3、4 章、7 章の履歴の「T40a の報告（API の検証の指定）」）: 送り方 API の登録の書き込みのジョブ（`write` が
 * `WorkerStartApiWrite`）も、この流れで行う（Run の始めと終わり、PREFLIGHT、監査の段の確かめ `auditStageStopsWrite`、送信の報告を 1 回だけ送る作り、
 * 文書を書く順、`writeRunStatusOf` は form と共通。書き込みの段の Context と API の入力の部品 `api-write-submitter.ts` を使うのも、今どおりこのファイル
 * だけ）。違う所:
 * - 3b の代わりに、送る前の画面の確かめ（`checkApiFormPage`）: 凍結した Context で書き込みの画面を 1 回読み（form と同じ `checkWritePage`。読む URL の
 *   判定 `isReadUrlAllowed`）、`inspectApiWriteInput` で、送信の要素（`submitterIdentityDigest`）がちょうど 1 つあり、鍵の欄（`api.keyFields` の欄の識別）が
 *   そろうことを、値を入れずに確かめる（結果は `candidateDigestMatched`）。外れたら送らずに `PRECHECK_FAILED`。
 *   OP-L（L1）: SPA が欄と送信の要素を後から描くので、確かめは、出そろうのを待ってから行う（L12b: 待つ上限なし。L0 の進みの見張りが終える）
 *   （`inspectApiWriteInputWhenRendered`。同じ画面を読み直すだけで、読み込みは足さない。書き込みの段で開き直した画面も同じ）。候補が合わなかったときは、
 *   どこが違ったか（`candidateMismatch`。理由・候補の数・外れた鍵の欄の位置。値は含まない）を `action-evidence.json` の `precheck` に残す。
 * - 書き込みの段の Context は `transport: 'API'` で、Guard の照合の期待は承認した API の指定と鍵ごとの生成した値（`apiExpectationOf`）、ID を応答の本文から
 *   取るなら `recordIdOf`（`apiRecordIdOfResponseBody` を ID の鍵で包む）。段の中: 書き込みの画面を 1 回読み → `inspectApiWriteInput` → `fillApiWriteInput`
 *   （送信の窓を開いてから入れる）→ 窓の中で止めた要求がないことを確かめる → form と同じ押す直前の確かめ（`readyToPress`）→ `submitApiWriteInput`。
 *   OP-O（O1）: 書き込みの段の確かめ・入力・押す操作が失敗して送らなかったときは、段・理由・欄の位置・欄の種類・属性の有無・値の変わり方の区分（値と、値の
 *   長さは含まない）を `action-evidence.json` の `precheck.inputFailure` に残す（form の書き込みも同じ形。`inputFailureOf`・`formInputFailureOf`）。画面には
 *   出さない。
 * - 結果の判定（`judgeApiResult`。期限は form と同じ `resultTimeoutMs`）: 送らなかった・送り手が書いた後に応答がない・状態が 100〜599 の外は判定なし
 *   （`apiResponseFactsOf`。T40c の発見事項 3 への判断）。応答をブラウザに返せなかった（Guard の `responseDeliveryCanceled`。form と同じ部品）なら
 *   `RESPONSE_NOT_DELIVERED`（ID を取らない）。ほかは `apiResponseJudgementOf` の判定で、成功のときだけ、セッションの切れを
 *   form と同じ部品で見てから、ID を取り方（`apiRecordIdSourceOf`）で取る（応答の本文なら `monitor.apiWriteRecordId()`、画面なら期限まで `recordIdOf`）。
 * - 照合の READ（T40b-2）: form と同じ条件（成功で違反がなく、ID が使える形 `isUsableRecordId`）のときだけ、`{id}` に ID を入れた画面を
 *   `verifyRecordPageReadCheck`（`read-check-run.ts`。保存の時と同じ画面の path の確かめと事前の判定をかけ直し、通れば画面の path の READ と同じ手順で
 *   1 回だけ読む）で読む。ID がない・使えないときは行わない（実行しなかった印。`RECORD_ID_NOT_FOUND`・`RECORD_ID_UNSAFE`）。
 * - 文書は版 1.1 の API の形（送り方 `API`、成否の条件 null、API の要約は `actionApiSummaryOf` で 1 回、送った値は鍵ごとの生成した値、送信先の path は
 *   API の path）。ページが決める鍵の値は、照合まで進んだ（送った）回だけ残す。ヘッダの値・応答の本文は、記録・成果物・例外の文・IPC に出さない（I22）。
 * - 読み込み: 画面の確かめ（GET 1）、書き込みの画面（GET 1）、承認した API の要求（Guard の送り手が 1 回）、照合の READ の `{id}` の画面（GET 1）。
 *
 * T41d（Task 41 の設計書 3.4、3.6）: API の更新（`START` の API の書き込みの指定が `update: { targetRecordId }` を持つ）。
 * - 前の読み取り（`planApiUpdateStage`・`checkApiUpdatePage`）: 凍結した Context で対象の更新の画面を 1 回読み、画面の path を型にした識別の digest が承認の
 *   値と同じ候補がちょうど 1 つで、その path の最後の ID の区切りが対象の ID なら、その候補の識別を送信の要素の識別にし、変える欄・保つ欄・ページが決める
 *   鍵の欄の値を、落ち着くまで待って読む（`readApiWriteFieldValues`。メモリの中だけ）。保つ鍵とページが決める鍵の値は承認の JSON の型に変え（`jsonValueOf`）、
 *   Guard の期待（`keptKeys`・`pageKeyPriorValues`、ID は対象の ID）に入れる。読めない・変えられない・変える欄の前の値が長すぎるなら送らない。
 * - 書き込みの段: 開き直した画面の値が前の値と同じか確かめ（違えば送らない）、登録と同じ手順で入れて押す（画面の ID の基準は読まない）。
 * - 判定（`apiUpdateResultOf`）: 成功で応答の本文が空の一覧なら `NO_CONDITION_MATCHED`、要素 2 つ以上の一覧なら `MULTIPLE_CONDITIONS_MATCHED`
 *   （T41R-fix の I-2）、本文の ID が対象と違えばその ID（`RECORD_ID_MISMATCH`）、ほかは
 *   対象の ID。応答をページに返せなかった印では止めない。
 * - 後の照合（`apiUpdateEvidenceOf`）: ID が対象の ID のときだけ、前の読み取りと同じ確かめで更新の画面を 1 回読み、変えた欄は新しい値、保つ欄とページが
 *   決める鍵の欄は前の値かを照らす。一致しない欄があれば照合の READ は行わない（form の UPDATE と同じ）。記録は `update`（対象の ID と証拠）を持ち、
 *   ページが決める鍵の値は残さない（`{}`）。
 * - 読み込み: 前の読み取り（GET 1）、書き込みの画面（GET 1）、承認した API の要求（1 回）、後の照合（GET 1）、照合の READ（GET 1）。
 * - T41R-fix（設計書 8 章の「T41R の途中の報告」の C-1・I-1）: 欄の値は、画面を読み込む前に作った進行中の要求の数え方（`InFlightRequestCounter`）で、
 *   要求が止んだ後に落ち着いた値を読む（`readApiWriteFieldValues` の `settledFieldValuesWhenQuiet`。前の読み取り、書き込みの段、後の照合のどれも）。
 *   前の読み取りで目印を入れた欄（変える欄と保つ欄）がすべて空なら、値が入る前の画面とみなして送らない（`apiUpdatePriorFilled`）。押す直前の確かめ
 *   （`readyToPress`）の中で、送る直前の確かめ直しの前に欄を読み直し（T41R-fix-2。確かめ直しの後に待ちを入れない）、保つ欄とページが決める鍵の欄が前の
 *   値のまま、変える欄が入れた値のままでなければ押さない（`apiUpdateReadyToPress`）。読み直しの後の書き換えは、送る瞬間に Guard が止める。
 * - T41R2-fix（設計書 8 章の「T41R2」）: 要求が止むのを待つ上限（観察の窓の一式の `discoverySettle.busyTimeoutMs`）に届いたら、止めずに 2 回同じ値の落ち着きで進む
 *   （realtime の SPA）。応答の本文が空でなく読めない（上限を超える、JSON でない）なら、行の数が分からないので `NO_CONDITION_MATCHED`
 *   （`isUnreadableApiResponseBody`）。
 * - T41R3-fix（設計書 8 章の「T41R3」。ユーザーの判断「API の更新だけ台帳と比べる」）: 親が台帳から求める保つ鍵ごとの最後に分かっている値
 *   （`update.knownKeptValues`。T41R2-fix の「空でないはずの保つ鍵」を置き換えた）と、前の読み取りか押す直前の読み直しの値が同じ（`sameValue`）でなければ
 *   送らない（`apiUpdateKnownKeptMismatch`。仮の値・空・BeakSight の外での変更）。後の照合で違えば、その欄は照合できない（`UPDATE_POSTCHECK_UNDETERMINED`
 *   の側）。一覧にない保つ鍵は今のまま。M-1: 同じ Run で一度、要求が止む待ちの上限に届いた書き込みの画面は、残りの読み取りでその待ちを省く
 *   （`ApiUpdateQuietMemory`。候補の落ち着きの待ちの後も要求が止んでいない画面も同じ。欄の値は 2 回同じ値の落ち着きで読み、後の照合の候補の読み取りの
 *   落ち着きの待ちは欄の値の待ちの上限に縮める。候補の読み取りは画面を凍結するので、0 にはしない）。限界: ページのタイマーだけで長く遅れて値を入れる形は、止める側に倒れるが、すべての形を見分けられるとは限らない。
 *
 * LU-10（設計書 `2026-11-02-beaksight-list-row-update-design.md` 4.0 の D2〜D4、4.0.1 の K1・K3、5.3 の 2、5.5、5.7）: 一覧の行から開く API の更新（`START` の
 * `update.listRow` のある更新だけ。ないときは上の T41d のまま）。
 * - 送る前の確かめ（`planApiListRowUpdateStage`）: 凍結した Context の前の読み取りをしない（押すまで欄がない）。Guard の期待は前の値を後から入れる印
 *   （`deferredPriorValues`。保つ鍵の名前は承認した API の指定から）。照合へ回す送信先を作れない期待は、Context を作る前に止める（`TARGET_RECORD_UNUSABLE`）。
 * - 書き込みの段（`apiListRowWriteOnStage`）: 窓の前（N2）に、一覧の画面を 1 回読み、行を選ぶ値を含む行がちょうど 1 つ（`ROW_NOT_UNIQUE`）、その行の承認した
 *   開き手を 1 回押す（`pressListRowOpener`。押せなければ結果を理由に写す）→ 欄が出るのを待つ → 保つ鍵の値が台帳の最後の値と同じときだけ、Guard に前の値を
 *   1 回入れる（`supplyApiPriorValues`。受けなければ窓を開かずに `PRIOR_VALUES_NOT_ACCEPTED`）→ 今の流れで入れて押す。開き手を押した時にサイトが自動で送る
 *   要求は、今の N2 の決まりで扱い、Guard の記録（`passedRequests`。`action-evidence.json` の `guard`）に残る。
 * - 後の照合: 窓を開き直さず、一覧の画面の照合の READ を 1 回（`verifyRecordPageReadCheck` に行の選び方を渡す）。行を選ぶ値の行に変えた欄の新しい値があれば
 *   `VERIFIED`。証拠は変えた欄だけ（`apiListRowUpdateEvidenceOf`）。
 * - 読み込み: 一覧の画面（GET 1）、開き手の押下 1 回、承認した API の要求（1 回）、照合の READ の一覧の画面（GET 1）。ページ送り・検索・読み込み直しはしない。
 *
 * LU-12・LU-12b（設計書 4.0 の D5、5.5。ユーザーの判断 2026-11-03）: 行の下に広がるフォーム（形 B）の更新（`START` の form の `update.listRow` のある更新だけ。
 * ないときは上の T31g-2 のまま）。LU-10 の 9 つの条件をフォームの形に当てる。
 * - 送る前の確かめ（`planFormListRowUpdateStage`）: 凍結した Context の前の読み取りをしない。Guard の期待は前の値に頼らない基本の部分
 *   （`updateBasePayloadFieldsOf`）と、前の値を後から入れる印（`updateDeferredPriorValuesOf`。承認の時の欄の役割から）。
 * - 書き込みの段（`formListRowWriteOnStage`）: 窓の前（N2）に、一覧の画面を 1 回読み、行を選ぶ値の行がちょうど 1 つ（`ROW_NOT_UNIQUE`）、承認した開き手を 1 回押し
 *   （API の形と同じ部品）、送信先が台帳の番号の form を送信先で 1 つに決め（`rowFormLocationOf`。違えば `FORM_NOT_READY`）、前の値を読み、保つ見える欄が台帳の
 *   最後の値（`update.knownKeptValues`）と同じときだけ（`KNOWN_KEPT_VALUE_MISMATCH`）、Guard に 1 回入れる（`supplyFormPriorValues`。受けなければ
 *   `PRIOR_VALUES_NOT_ACCEPTED`）→ 今の流れ（`inspectUpdateForm` → 入れる → 窓 → 押す）。
 * - 後の照合: 更新の後の画面を読まず、照合の READ（候補の READ）を行の選び方つきで 1 回（`verifyReadCheck`）。一致したときだけ更新の後の照合を `UPDATED`。
 * - 読み込み: 一覧の画面（GET 1）、開き手の押下 1 回、POST（と redirect）、照合の READ（対象の画面と READ の URL の GET 2）。
 */
import { resolve } from 'node:path';
import type { BrowserContext, Page, Request, Response } from 'playwright';
import {
  fillApiWriteInput,
  inspectApiWriteInputWhenRendered,
  pressListRowOpener,
  pressTimeWordsMatchApproved,
  readApiWriteFieldValues,
  submitApiWriteInput,
  type ApiWriteInputSpec,
  type InspectedApiWriteInput,
  type ListRowOpenerPressResult,
} from '../browser/api-write-submitter.js';
import { FORM_POST_METHOD, waitForPageQuietAfterPress, type WriteInputFailureStage, type WriteInputFieldFacts, type WriteInputValueChange } from '../browser/form-submission-common.js';
import type { BrowserContextFactory } from '../browser/context-factory.js';
import {
  fillWriteForm,
  inspectUpdateForm,
  inspectWriteForm,
  readUpdateFormValues,
  readWritePassthroughValues,
  sameValue,
  locateRowWriteForms,
  submitWriteForm,
  updateBasePayloadFieldsOf,
  updateDeferredPriorValuesOf,
  updatePayloadFieldsOf,
  writePayloadFieldsOf,
  type InspectedWriteForm,
  type UpdateFormValues,
  type WriteFormSpec,
  type WriteUpdateFormSpec,
} from '../browser/write-form-submitter.js';
import { EXIT_CODES } from '../cli/exit-codes.js';
import type { AuditConfig } from '../config/types.js';
import { actionApiSummaryOf } from '../control/actions/action-api-summary.js';
import {
  ACTION_EVIDENCE_SCHEMA_VERSION,
  ACTION_RUN_SCHEMA_VERSION,
  APPROVAL_SUMMARY_SCHEMA_VERSION,
  MAX_HTTP_STATUS,
  MIN_HTTP_STATUS,
  type ActionBlockReason,
  type ActionEvidenceDocument,
  type ActionGuardSummary,
  PRECHECK_CANDIDATE_MISMATCH_REASONS,
  WRITE_INPUT_FAILURE_REASONS,
  type ActionEvidenceCandidateMismatch,
  type ActionEvidenceInputFailure,
  PRECHECK_FAILED_BLOCK_REASON as PRECHECK_FAILED,
  type WriteInputFailureReason,
  type ActionOutcome,
  type ActionResult,
  type ActionRunDocument,
  type ActionRunReadVerification,
  type ActionRunUpdate,
  type ApprovalSummaryDocument,
  type FormUpdatePostcheck,
  type PrecheckCandidateMismatchReason,
  type PrecheckFailureDetail,
  type ResponseJudgement,
  type SubmissionState,
  type WriteUpdateEvidence,
  type WriteUpdateFieldEvidence,
} from '../control/actions/action-contracts.js';
import {
  actionOutcomeOf,
  apiResponseJudgementOf,
  fieldsMatchedOf,
  formResultJudgementOf,
  isFormStructureStatus,
  isUsableRecordId,
  preSubmitReadStopOf,
  recordIdOfResultUrl,
  recordableRecordIdOf,
  reservationSettlementOf,
} from '../control/actions/action-outcome.js';
import { apiRecordIdOfResponseBody, apiResponseBodyShapeOf } from '../control/actions/api-record-id.js';
import {
  WORKER_API_WRITE_TRANSPORT,
  isWorkerStartApiWrite,
  type WorkerStartApiWrite,
  type WorkerStartApiWriteListRow,
  type WorkerStartReadCheck,
  type WorkerStartWrite,
  type WorkerStartWriteListRow,
  type WorkerStartWriteUpdate,
} from '../control/worker-protocol.js';
import type { ApiFieldIdentity } from '../core/api-field-identity.js';
import { lastRecordIdLikePathSegmentIndexOf, type ApiJsonValueType } from '../core/api-request-shape.js';
import type { RunId, RunStatus } from '../core/contracts.js';
import { jsonValueOf } from '../core/json-value.js';
import { wait } from '../core/deadline.js';
import { ERROR_HTTP_STATUS_RANGE, isHttpStatusInRange, type HttpStatusRange } from '../core/http-status.js';
import { CONTEXT_CLOSE_TIMEOUT_MS } from '../core/limits.js';
import { observationWindowsOrProduction, type ObservationWindows } from '../core/observation-windows.js';
import { watchProgress } from '../core/progress-watch.js';
import { attachPageProgressSignals } from '../browser/page-progress-signals.js';
import { deriveRunStatus } from '../core/status.js';
import { formatCompactUtcTimestamp } from '../core/utc-timestamp.js';
import { createNavigationPacer, type NavigationPacer } from '../crawl/navigation-pacer.js';
import {
  FORM_SCENARIO_TRANSPORT,
  SCENARIO_API_FIELD_TYPES,
  type ScenarioRecordIdSpec,
  type ScenarioTransport,
} from '../control/approval/scenario-contracts.js';
import {
  CANDIDATE_FIELD_TYPES,
  type CandidateFieldType,
  type CandidateJsBinding,
  type CandidateLocation,
  type DiscoveredCandidate,
} from '../discovery/candidate-contracts.js';
import { DISCOVERY_READ_TIMEOUT_MS } from '../discovery/discover-page.js';
import {
  formShapeKeyOf,
  listRowFormTemplatedIdentityDigestOf,
  pagePathTemplatedIdentityDigestOf,
  recordIdOfPathPattern,
  templatedIdentityDigestForRecordIdOf,
} from '../discovery/fingerprint.js';
import { locationOfUrl, probePageCandidates } from '../discovery/probe.js';
import type { ReadCheckExecutedEvidence } from '../discovery/read-check-evaluation.js';
import {
  findListRowsContainingValue,
  listRowOfFormPath,
  readCandidatePage,
  readListRowPaths,
  type ListRowReference,
  type ListRowSearchOutcome,
  type ReadCandidatePage,
} from '../discovery/read-executor.js';
import {
  InFlightRequestCounter,
  discoverySettlePolicyOf,
  settlePolicyOfWindows,
  waitForDiscoverySettled,
  type QuietSource,
} from '../discovery/settle.js';
import {
  jobContextFactoryOptions,
  recordRunStageCarry,
  sessionKeyLostDetailOf,
  type AuditStageRunState,
  type RunStageCarry,
} from '../orchestration/audit-stage-run.js';
import { auditSendOptionsOf } from '../orchestration/audit-send-options.js';
import { sessionLostUrlOf, type RunAuthentication } from '../orchestration/authenticated-run.js';
import { navigatePage } from '../orchestration/page-navigation.js';
import { closePassiveContextBeforeDeadline } from '../orchestration/passive-session-close.js';
import type { BrowserLauncher, BrowserLease } from '../orchestration/preflight.js';
import { createActionPresentation } from '../report/action-bundle.js';
import { ArtifactWriter } from '../report/artifact-writer.js';
import {
  apiWriteCheckPathOf,
  type ApiWritePageKeyValue,
  type ApiWritePayloadExpectation,
  type ApiWritePriorValue,
} from '../safety/api-write-payload-policy.js';
import {
  isPassiveRequestGuardClosed,
  WriteStageMonitor,
  type GuardWriteStage,
  type WriteStageMonitorSnapshot,
  type WriteSubmissionReport,
} from '../safety/passive-request-guard.js';
import { redactUrlSecrets } from '../safety/redact.js';
import { recordPathShapeOf } from '../safety/request-policy.js';
import { SafetyLedger } from '../safety/safety-ledger.js';
import type { WriteDeferredPriorValues, WritePayloadExpectation, WriteSuppliedPriorValues } from '../safety/write-payload-policy.js';
import { loginStageLocator } from './login-stage-checks.js';
import {
  isReadUrlAllowed,
  listRowTextPresenceOf,
  readCheckOperationsOf,
  verifyReadCheck,
  type ListRowPresence,
  type ReadCheckPageVisitOptions,
  type ReadCheckSession,
} from './read-check-run.js';
import { playwrightStagePortsOf, type StagePorts } from './stage-ports.js';
import {
  endWorkerRun,
  hasViolation,
  startWorkerRun,
  visitGuardedPage,
  type GuardedPageView,
  type GuardedPageVisitOptions,
} from './worker-run-session.js';
import type { WorkerWriteRecheckOutcome, WorkerWriteSubmissionReport } from './write-ipc.js';

/** 日時の名前（誤りの文に使う）。 */
const WRITE_CREATE_TIME_SUBJECT = 'write create run time';

/**
 * L12b（設計書 `2026-11-09-beaksight-remove-limits-design.md` 6.2。T27）: 押した後に結果（承認した送信の応答）を待つ期限は置かない（前は `WRITE_RESULT_WAIT_MS` の
 * 30 秒か設定の `crawl.navigationTimeoutMs`）。待ちは L0 の進みの見張り（`watchProgress`）で包み、全く反応がないまま反応なしの長さが過ぎたときだけ終える。反応なしの
 * 長さは、注入（`resultTimeoutMs`。テスト）がなければ観察の窓の一式の `watch.quietLimitMs`。設定の `navigationTimeoutMs` は使わない。
 */
const resultQuietLimitMsOf = (request: Pick<WriteCreateRunRequest, 'resultTimeoutMs' | 'observationWindows'>): number =>
  request.resultTimeoutMs ?? observationWindowsOrProduction(request.observationWindows).watch.quietLimitMs;

/**
 * L12b: 書き込みの段の、回数・時間の上限を撤廃した待ち（欄が描かれるのを待つ・入れ直し・探し直し）の L0 の見張りの指定。反応なしの長さは、結果の待ちと同じ。
 * RB-11: 見張りの中の待ち（確かめの間隔・落ち着き）は、観察の窓の一式（`observationWindows`。テストだけが差し込む。なければ本番の一式）から読む。
 */
interface WriteStageWatch {
  readonly quietLimitMs: number;
  readonly observationWindows: ObservationWindows;
}

const writeStageWatchOf = (request: Pick<WriteCreateRunRequest, 'resultTimeoutMs' | 'observationWindows'>): WriteStageWatch =>
  ({ quietLimitMs: resultQuietLimitMsOf(request), observationWindows: observationWindowsOrProduction(request.observationWindows) });

/** L12b: 承認した送信の応答の待ちの結果。 */
type WriteResponseWait = 'RESPONDED' | 'ENDED_WITHOUT_RESPONSE' | 'NOT_RESPONDED';

/**
 * L12b（T27）: 承認した送信の応答を待つ（期限なし。L0 の見張りで包む）。送らなかったと決まった・送り手が書いた後に応答がなかった（DEF-099 fix）なら
 * `ENDED_WITHOUT_RESPONSE`、応答を受けたら `RESPONDED`、ページが閉じた・見張りが終えた（全く反応がない）なら `NOT_RESPONDED`。送信の報告が変わったときを中身の
 * 進みにする（ページの通信と画面の変化は、ページの自発の変化の印）。
 */
async function waitForWriteResponse(input: WriteStageInput): Promise<WriteResponseWait> {
  const { monitor, page, watch } = input;
  const outcome = await watchProgress(async (signals) => {
    const detach = attachPageProgressSignals(page, signals);
    let previous = '';
    try {
      for (;;) {
        const report = monitor.submissionReport();
        const step = writeResponseStepOf({
          endedWithoutResponse: submissionEndedWithoutResponse(input), responseReceived: report.responseReceived,
          pageGone: page.isClosed() || signals.signal.aborted,
        });
        if (step !== 'WAIT') {
          return step;
        }
        const state = `${report.submission}:${report.sendOutcome ?? ''}`;
        if (state !== previous) {
          previous = state;
          signals.mark('BROWSER_RESPONSE');
        }
        await wait(watch.observationWindows.write.resultPollIntervalMs);
      }
    } finally {
      detach();
    }
  }, { quietLimitMs: watch.quietLimitMs });
  return outcome.status === 'FULFILLED' ? outcome.value : 'NOT_RESPONDED';
}

/**
 * L12b（L12a の限界 3・4）: 押した後のページの送信と画面の変化が静まるまで待つ（期限なし。結果を決める前と、Context を閉じる前）。部品は書き込みの段の唯一の
 * `waitForPageQuietAfterPress`。データの途中の数は、呼ぶ側の要求の数え方（`InFlightRequestCounter`）があれば使う。
 */
const settleAfterPress = (page: Page, request: Pick<WriteCreateRunRequest, 'observationWindows'>, counter?: InFlightRequestCounter): Promise<void> =>
  waitForPageQuietAfterPress(page, {
    observationWindows: request.observationWindows,
    ...(counter === undefined ? {} : { dataActivity: () => ({ inFlight: counter.inFlight, events: 0 }) }),
  });

/** 再 POST させる redirect（307・308。Guard が 2 回目の POST を止める）。 */
const REPOST_REDIRECT_STATUSES: ReadonlySet<number> = new Set([307, 308]);

// ---------------------------------------------------------------------------------------------------------------
// RB-11（再構築の設計書 3 章。plan の 2 章の 10）: 書き込みの窓と poll の、観察から次の一手を決める純粋な判定（ブラウザを読まない）。輪と読み取りは呼ぶ側に残す。
// ---------------------------------------------------------------------------------------------------------------

/** 応答の待ちの 1 歩（決まったら、その結果。まだなら `WAIT`）。 */
export type WriteResponseStep = WriteResponseWait | 'WAIT';

/**
 * 応答の待ちの 1 歩: 送らなかったと決まった・送り手が書いた後に応答がなかった → `ENDED_WITHOUT_RESPONSE`、応答を受けた → `RESPONDED`、ページが閉じた・見張りが
 * 終えた → `NOT_RESPONDED`、ほかは `WAIT`（この順で見る）。
 */
export const writeResponseStepOf = (facts: {
  readonly endedWithoutResponse: boolean;
  readonly responseReceived: boolean;
  readonly pageGone: boolean;
}): WriteResponseStep => {
  if (facts.endedWithoutResponse) {
    return 'ENDED_WITHOUT_RESPONSE';
  }
  if (facts.responseReceived) {
    return 'RESPONDED';
  }
  return facts.pageGone ? 'NOT_RESPONDED' : 'WAIT';
};

/**
 * 送らなかったと決まったか、送り手が書いた後に応答がなかったか: 送信が `NOT_SENT` で、送る中身の照合で止めた・Guard が Context を閉じた（違反。送っていない）・
 * 送り手が書く前に止まった（DEF-099 fix）か、送り手の結果が `NO_RESPONSE`（届いたかは分からない）。
 */
export const submissionEndedWithoutResponseOf = (
  report: Pick<WriteSubmissionReport, 'submission' | 'sendOutcome'>,
  facts: { readonly payloadBlocked: boolean; readonly guardClosed: boolean },
): boolean => (report.submission === 'NOT_SENT' && (facts.payloadBlocked || facts.guardClosed || report.sendOutcome !== null))
  || report.sendOutcome === 'NO_RESPONSE';

/** 値を入れた後の送信の窓の判定: 承認の送信のほかの要求を止めた → `UNEXPECTED_REQUEST`、止める印 → `STOPPED`、ほかは押してよい（null）。 */
export const submissionWindowVerdictOf = (facts: {
  readonly unexpectedRequestCount: number;
  readonly stopped: boolean;
}): 'UNEXPECTED_REQUEST' | 'STOPPED' | null => {
  if (facts.unexpectedRequestCount !== 0) {
    return 'UNEXPECTED_REQUEST';
  }
  return facts.stopped ? 'STOPPED' : null;
};

/** 行の位置の 1 回の読み取り（`rowFormLocationOf` の 1 歩）の後: 見つかった・2 つ以上・読めない・ページが閉じた・見張りが終えた → 終える。まだ描かれていないだけなら読み直す。 */
export const rowFormLocationStepOf = (located: RowFormLocation, facts: { readonly pageGone: boolean }): 'DONE' | 'READ_AGAIN' =>
  (located.ok || located.reason !== 'FORM_NOT_FOUND' || facts.pageGone ? 'DONE' : 'READ_AGAIN');

/** 一覧の行の中の、送信先で 1 つに決めた form の読み取り（DOM の読み取りの結果。位置と見えているか）。 */
interface RowWriteFormRead {
  readonly path: readonly number[];
  readonly visible: boolean;
}

/**
 * 行の位置の判定（`locateRowFormOnce` の、読んだ後の純粋な部分）: 一覧の行か form が読めない → `FORM_UNREADABLE`、送信先の form が 2 つ以上 → `FORM_AMBIGUOUS`、
 * ない・見えない・選んだ行（またはそのすぐ下の行）の中にない → `FORM_NOT_FOUND`、ほかは、その form の位置（識別の照合へ進む）。
 */
export const rowFormCandidateOf = (facts: {
  readonly rowsRead: boolean;
  readonly forms: readonly RowWriteFormRead[] | null;
  readonly inSelectedRow: (formPath: readonly number[]) => boolean;
}): { readonly ok: true; readonly formPath: readonly number[] } | { readonly ok: false; readonly reason: 'FORM_UNREADABLE' | 'FORM_AMBIGUOUS' | 'FORM_NOT_FOUND' } => {
  if (!facts.rowsRead || facts.forms === null) {
    return { ok: false, reason: 'FORM_UNREADABLE' };
  }
  const [only, ...others] = facts.forms;
  if (others.length > 0) {
    return { ok: false, reason: 'FORM_AMBIGUOUS' };
  }
  if (only === undefined || !only.visible || !facts.inSelectedRow(only.path)) {
    return { ok: false, reason: 'FORM_NOT_FOUND' };
  }
  return { ok: true, formPath: only.path };
};

/** 書き込みの流れの入力。秘密（認証の状態）はメモリの認証の指定の中だけ。 */
export interface WriteCreateRunRequest {
  readonly config: AuditConfig;
  readonly jobId: string;
  readonly authentication: RunAuthentication;
  /** `START` の書き込みの指定（契約で確かめたもの）。T40b-1: 送り方 API の登録の書き込みの指定も受ける。 */
  readonly write: WorkerStartWrite | WorkerStartApiWrite;
  readonly launchBrowser: BrowserLauncher;
  /** RB-5: ワーカーの Browser の lease（あれば `launchBrowser` を呼ばずに借りる。`runPreflight` の `browserLease`）。 */
  readonly browserLease?: BrowserLease | undefined;
  readonly clock: () => Date;
  readonly now: () => number;
  /** 止める印（押す前の各段の前で確かめる。押した後は止めない）。 */
  readonly stopSignal: AbortSignal;
  /** 送る直前の確かめ直し（IPC の往復。`createWorkerWriteIpc` の `requestRecheck`）。 */
  readonly recheck: () => Promise<WorkerWriteRecheckOutcome>;
  /** 送信の報告（1 回。`createWorkerWriteIpc` の `reportSubmission`）。 */
  readonly reportSubmission: (report: WorkerWriteSubmissionReport) => void;
  /** 読み込みの間隔を守る部品（省略すると、設定の `crawl.minNavigationIntervalMs` で作る）。 */
  readonly navigationPacer?: NavigationPacer | undefined;
  /**
   * OP-2（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1.2 の案 C）: まとめて実行の書き込みの段の持ち越し（前の段の 1 分の窓から始め、Browser を閉じた
   * 後に factory の最新のログインの状態・窓・読み込みの間隔を渡す。メモリの中だけ）。単独の書き込みのジョブは渡さない。
   */
  readonly stageCarry?: RunStageCarry | undefined;
  /** 押した後に結果を待つ上限（ms。省略すると、設定の `crawl.navigationTimeoutMs`）。 */
  readonly resultTimeoutMs?: number | undefined;
  /**
   * テストだけ（DEF-099 fix）: 書き込みの送信の送り手が TLS の確かめで信頼する証明書を足す（PEM。自前の証明書の https の fixture のため）。
   * 確かめは切らない。ワーカーの本番の流れは渡さない。
   */
  readonly writeSubmissionCertificates?: readonly string[] | undefined;
  /**
   * RB-2（TEST-TIME-B）: テストだけ。観察の窓の一式（押した後の静まりの窓・押す前の送信の窓・結果の確かめの間隔）。省略すると本番の値。ワーカーの本番の流れは
   * 渡さない（process の組み立てのテストだけの口 `observationWindows` からだけ渡る。IPC・設定・環境変数からは渡せない）。
   */
  readonly observationWindows?: ObservationWindows | undefined;
  /**
   * RB-11（再構築の設計書 2 章 1）: 書き込みの段の口（Run の前の確認・送る前の確かめ・書き込みの段・照合の READ）。省略すると本物（`PLAYWRIGHT_WRITE_PORTS`）。
   * ワーカーの流れは渡さない。テストが偽の口を渡し、書き込みの流れの輪（送ったかの決め方・止まり方・照合の選び方）をブラウザなしで確かめる
   * （Gate `discovery-crawl-ports-entry` の段の口の表）。
   */
  readonly writePorts?: WritePorts | undefined;
}

/** 観測の口（ワーカーの流れが IPC に写す）。 */
export interface WriteCreateRunObserver {
  readonly onRunStarted: (event: { readonly runId: RunId; readonly runDirectory: string }) => void;
  readonly onSessionLost: (url: string) => void;
}

/** 書き込みの流れの結果（Run のディレクトリは絶対パス）。 */
export type WriteCreateRunOutcome =
  | {
    readonly kind: 'RAN';
    readonly runId: RunId;
    readonly runDirectory: string;
    readonly runStatus: RunStatus;
    readonly exitCode: number;
    readonly result: ActionResult;
  }
  | { readonly kind: 'RUN_ACTIVE'; readonly exitCode: number }
  | {
    readonly kind: 'RUN_DIRECTORY_UNAVAILABLE';
    readonly runId: RunId;
    readonly runDirectory: string;
    readonly runStatus: RunStatus;
    readonly exitCode: number;
  };

/**
 * 書き込みの事実（成果物と送信の報告の元。`action-run.json` と、T32e から書き込みの報告の `action-evidence.json` を、この 1 つの事実から
 * `writeRunDocumentsOf` で 1 回だけ組み立てる）。
 */
export interface WriteFacts {
  readonly submission: SubmissionState;
  readonly blockReason: ActionBlockReason | null;
  readonly httpStatus: number | null;
  readonly responseJudgement: ResponseJudgement | null;
  readonly rawRecordId: string | null;
  /**
   * T32e: 照合の READ の証拠の全体（実行したときだけ。`action-run.json` の `readVerification` は、ここから id・版・結果を取る）。期待ごとの
   * `observedValue` は人の値でありうる。URL は ArtifactWriter が書くときに伏せ字を通す。
   */
  readonly readEvidence: ReadCheckExecutedEvidence | null;
  readonly submittedAt: Date | null;
  /** 安全の不変条件の違反があった（Run は `ABORTED_BY_SAFETY`）。 */
  readonly violation: boolean;
  /** Run の前の確認（PREFLIGHT）が失敗した。 */
  readonly preflightFailed?: boolean;
  /** T31g-2: UPDATE の更新の後の照合の証拠（照合まで進まなかったとき・CREATE は null）。 */
  readonly updateEvidence?: WriteUpdateEvidence | null;
  /** T32e: 送る前の画面の確かめで、承認に縛った候補の digest が一致したか（確かめまで進まなければ null）。 */
  readonly candidateDigestMatched: boolean | null;
  /** T32e: 送信の後の画面の結果を判定した時刻（判定しなければ null）。 */
  readonly judgedAt: Date | null;
  /** T32e: Guard の書き込みの段の数の要約（書き込みの段に入らなければ null）。 */
  readonly guard: ActionGuardSummary | null;
  /** T44e（Task 44 の設計書 P2-4）: `PRECHECK_FAILED` の具体的な理由（分かったときだけ。`action-run.json` の任意の項目 `precheckDetail`）。 */
  readonly precheckDetail?: PrecheckFailureDetail;
  /** OP-L（L1）: 候補が合わなかったときの、どこが違ったか（`action-evidence.json` の `precheck.candidateMismatch`。値を含まない）。 */
  readonly candidateMismatch?: ActionEvidenceCandidateMismatch;
  /** OP-O（O1）: 書き込みの段の、確かめ・入力・押す操作の失敗（`action-evidence.json` の `precheck.inputFailure`。値と、値の長さを含まない）。 */
  readonly inputFailure?: ActionEvidenceInputFailure;
  /**
   * T40b-1: API の書き込みで、Guard の照合が返したページが決める鍵の値（`monitor.apiWritePageKeyValues()`。form と、照合まで進まなかった回は
   * null か省略）。文書は、送った回だけ残す。
   */
  readonly apiPageKeyValues?: Readonly<Record<string, ApiWritePageKeyValue>> | null;
}

/** 送らずに止めた事実（T32e: 候補の確かめの結果と Guard の要約は、分かっていれば添える）。 */
const notSent = (
  blockReason: ActionBlockReason,
  details: {
    readonly violation?: boolean;
    readonly candidateDigestMatched?: boolean | null;
    readonly guard?: ActionGuardSummary | null;
    /** T44e（Task 44 の設計書 P2-4）: `PRECHECK_FAILED` の具体的な理由（ほかの理由では付けない）。 */
    readonly precheckDetail?: PrecheckFailureDetail | undefined;
    /** OP-L（L1）: 候補が合わなかったときの、どこが違ったか（合わなかったときだけ）。 */
    readonly candidateMismatch?: ActionEvidenceCandidateMismatch | null;
    /** OP-O（O1）: 書き込みの段の、確かめ・入力・押す操作の失敗（`PRECHECK_FAILED` のときだけ）。 */
    readonly inputFailure?: ActionEvidenceInputFailure | undefined;
  } = {},
): WriteFacts => Object.freeze({
  submission: 'NOT_SENT',
  blockReason,
  httpStatus: null,
  responseJudgement: null,
  rawRecordId: null,
  readEvidence: null,
  submittedAt: null,
  violation: details.violation ?? false,
  candidateDigestMatched: details.candidateDigestMatched ?? null,
  judgedAt: null,
  guard: details.guard ?? null,
  ...(blockReason === PRECHECK_FAILED && details.precheckDetail !== undefined ? { precheckDetail: details.precheckDetail } : {}),
  ...(details.candidateDigestMatched === false && details.candidateMismatch !== undefined && details.candidateMismatch !== null
    ? { candidateMismatch: details.candidateMismatch }
    : {}),
  ...(blockReason === PRECHECK_FAILED && details.inputFailure !== undefined ? { inputFailure: details.inputFailure } : {}),
});

/**
 * T44e（Task 44 の設計書 P2-4）: 送る前の画面の確かめ（`WritePageCheck`）で送らないときの、具体的な理由。止める印 → ログインの切れ → 候補が合わない →
 * 画面を読めない、の順に決める（送る・送らないの判定は呼ぶ側のまま）。
 */
const pageCheckDetailOf = (check: WritePageCheck<unknown>, aborted: boolean): PrecheckFailureDetail => {
  if (aborted) {
    return 'STOPPED';
  }
  if (check.sessionLostUrl !== null) {
    return 'SESSION_LOST';
  }
  return check.candidateMatched === false ? 'CANDIDATE_CHANGED' : 'PAGE_UNAVAILABLE';
};

/**
 * T32e: Guard の書き込みの段の記録の写しから、報告に書く数と印だけを写す（項目を名前で選ぶ。写しに項目が増えても、報告の形は変えない）。
 */
const guardSummaryOf = (snapshot: WriteStageMonitorSnapshot): ActionGuardSummary => Object.freeze({
  blockedByReason: Object.freeze({ ...snapshot.blockedByReason }),
  blockedByOtherRulesInWindow: snapshot.blockedByOtherRulesInWindow,
  submissionWindowOpen: snapshot.submissionWindowOpen,
  blockedByPayloadReason: Object.freeze({ ...snapshot.blockedByPayloadReason }),
  documentCharsetRead: snapshot.documentCharsetRead,
  responseDeliveryCanceled: snapshot.responseDeliveryCanceled,
  // OP-M: 承認した送信のほかに止めた要求の一覧（1 つの配列。値・Origin を含まない）と、一覧に入れなかった数。どちらも、あったときだけ（任意の項目）。
  ...(snapshot.unexpectedRequests.length > 0 ? { unexpectedRequests: snapshot.unexpectedRequests } : {}),
  ...(snapshot.unexpectedRequestsUnlisted > 0 ? { unexpectedRequestsUnlisted: snapshot.unexpectedRequestsUnlisted } : {}),
  // OP-N（設計書 4.1.7 の N2）: 送信の扱い `PASS_EXCEPT_DELETE` で通した、サイトが自動で送る通信の一覧（同じ形。書き込みには数えない）と、一覧に入れなかった数。
  // どちらも、あったときだけ（任意の項目）。
  ...(snapshot.passedRequests.length > 0 ? { passedRequests: snapshot.passedRequests } : {}),
  ...(snapshot.passedRequestsUnlisted > 0 ? { passedRequestsUnlisted: snapshot.passedRequestsUnlisted } : {}),
});

/** 監査の段の送信の扱いの factory の口の形（`auditSendOptionsOf` が作る）。 */
type WriteJobAuditSend = NonNullable<ReturnType<typeof auditSendOptionsOf>['auditSend']>;

/**
 * OP-Q（設計書 4.1.8 の Q1）: 書き込みの作業の承認した送信の送信先（書き込みの段の Guard と中継が数える送信先と同じ値。form は承認の要求の Origin と path、API は
 * 承認した API の Origin と path の型）。LU-SFIX3-B（LU-SREV3 の Important-2）: フォームの更新で、送信先の最後の区切りが対象の番号なら、書き込みの段と同じ型
 * （`recordPathShapeOf`。型と表の path を守る）。
 */
const writeJobEndpointOf = (write: WorkerStartWrite | WorkerStartApiWrite): { readonly origin: string; readonly path: string } =>
  (isWorkerStartApiWrite(write)
    ? { origin: write.api.request.origin, path: write.api.request.pathShape }
    : {
      origin: write.request.origin,
      path: (write.update === undefined ? null : recordPathShapeOf(write.request.path, write.update.targetRecordId)) ?? write.request.path,
    });

/**
 * OP-REV3（C-1）と OP-Q（Q1）: 書き込みのジョブの factory の、監査の段の送信の扱いの口（`PASS_EXCEPT_DELETE` のときだけ持つ。どの Context に当てるかを口で分ける）。
 * - `writeStageAuditSend`: 書き込みの段の Context（値を入れる前だけ。窓と押した後には当てない）。
 * - `writeJobPassiveAuditSend`: 送る前の確かめと照合の READ の Passive の Context（書き込みの作業の印 `writeJobEndpoint` つき。決まりは書き込みの段の値を入れる前と同じ）。
 * `READ_ONLY` なら、どちらも持たない（今のまま読み取りだけ）。
 */
const writeJobAuditSendOf = (
  config: Parameters<typeof auditSendOptionsOf>[0],
  approvedServiceOrigins: readonly string[],
  write: WorkerStartWrite | WorkerStartApiWrite,
): { readonly writeStageAuditSend?: WriteJobAuditSend; readonly writeJobPassiveAuditSend?: WriteJobAuditSend } => {
  const { auditSend } = auditSendOptionsOf(config, approvedServiceOrigins);
  return auditSend === undefined
    ? {}
    : { writeStageAuditSend: auditSend, writeJobPassiveAuditSend: Object.freeze({ ...auditSend, writeJobEndpoint: Object.freeze(writeJobEndpointOf(write)) }) };
};

const PAYLOAD_MISMATCH: ActionBlockReason = 'PAYLOAD_MISMATCH';

/** 画面の URL（Origin と path）。 */
const pageUrlOf = (location: { readonly origin: string; readonly path: string }): string => `${location.origin}${location.path}`;

/** 送るフォームの指定（承認の要求の形と、承認した候補の欄と、生成した値の欄の名前）。 */
const formSpecOf = (write: WorkerStartWrite): WriteFormSpec => ({
  endpoint: { origin: write.request.origin, path: write.request.path },
  enctype: write.request.enctype as WriteFormSpec['enctype'],
  candidateFields: write.candidateFields,
  submittedFieldNames: Object.keys(write.values),
  methodOverride: write.request.methodOverride as WriteFormSpec['methodOverride'],
});

/** T31g-2: 更新の form の指定（承認の要求の形と、承認した候補の欄と、欄の役割）。 */
const updateSpecOf = (write: WorkerStartWrite, update: WorkerStartWriteUpdate): WriteUpdateFormSpec => ({
  endpoint: { origin: write.request.origin, path: write.request.path },
  enctype: write.request.enctype as WriteUpdateFormSpec['enctype'],
  candidateFields: write.candidateFields,
  methodOverride: write.request.methodOverride as WriteUpdateFormSpec['methodOverride'],
  changedFieldNames: update.changedFieldNames,
  keptFieldNames: update.keptFieldNames,
});

/** T31g-2: UPDATE の、書き込みの段に渡す前の値と指定。 */
interface UpdateStage {
  readonly spec: WriteUpdateFormSpec;
  readonly prior: UpdateFormValues;
}

/**
 * Guard の照合の期待（承認の要求の形と、期待の作り手 `writePayloadFieldsOf` が作る欄の部分。DEF-098）。T31R-fix-1（C-1）: 値を照らす hidden・
 * readonly・見えない欄は、画面の確かめで読んだ値（作れなければ null）。
 */
const payloadExpectationOf = (
  write: WorkerStartWrite,
  spec: WriteFormSpec,
  passthroughValues: Readonly<Record<string, string | null>>,
): WritePayloadExpectation | null => {
  const fields = writePayloadFieldsOf(spec, write.values, passthroughValues);
  return fields.ok ? { request: { origin: write.request.origin, path: write.request.path, enctype: spec.enctype }, ...fields.fields } : null;
};

/** Guard が、送る中身の照合で承認の形の POST を止めたか。 */
const payloadBlocked = (monitor: WriteStageMonitor): boolean =>
  Object.values(monitor.snapshot().blockedByPayloadReason).some((count) => count > 0);

/** PL-6a: form の登録の ID の型（送った後の URL に、この順に当てる。設計書 8.1）。 */
// PL-5 の 9 の (4): ID の取り方が null（決められなかった）なら型なし（ID を取らない。結果は ID なしの `PARTIAL`）。
const formRecordIdPatternsOf = (write: WorkerStartWrite): readonly string[] => write.verification.recordId?.pathPatterns ?? [];

/**
 * PL-6a（設計書 8.1 の「判定の順」の 3）: 送った後の画面の、送ったフォームと同じ形のフォームが、送った値を保っているか。送った値のうち、BeakSight が値を
 * 作って入れる文字の欄（`SCENARIO_API_FIELD_TYPES` の型。text・email・textarea など）の値を、欄の名前で、落ち着くまで待って読み（書き込みの入力の部品
 * `readApiWriteFieldValues`。値はメモリの中だけ）、すべて送った値と同じ（`sameValue`）なら真。比べる欄がない・読めない・名前の欄が 2 つ以上あるなら偽
 * （入力の誤りと言わない側に倒す）。
 */
async function submittedValuesKept(page: Page, write: WorkerStartWrite, windows: ObservationWindows): Promise<boolean> {
  const textTypes: ReadonlySet<string> = new Set(SCENARIO_API_FIELD_TYPES);
  const entries = Object.entries(write.values).flatMap(([name, value]) => {
    const fields = write.candidateFields.filter((field) => field.name === name);
    return typeof value === 'string' && fields.length === 1 && fields.every(({ type }) => textTypes.has(type)) ? [{ name, value }] : [];
  });
  if (entries.length === 0) {
    return false;
  }
  const read = await readApiWriteFieldValues(page, entries.map(({ name }) => ({ kind: 'NAME' as const, name })), undefined, undefined, { observationWindows: windows });
  return read.ok && entries.every(({ value }, index) => sameValue(read.values[index] ?? null, value));
}

/**
 * PL-6a: form の更新の、更新の後の照合の分け方（`FormUpdatePostcheck`。判定 `formResultJudgementOf` の入力）。後の画面を読めない・照合できない欄があれば
 * `UNDETERMINED`、すべて一致なら `UPDATED`。一致しない欄があるとき、変えた欄がすべて前の値のままで、保つ欄・状態の欄がすべて一致なら `UNCHANGED`
 * （更新されていない）、ほかは `CHANGED_OTHERWISE`。
 */
const formUpdatePostcheckOf = (
  update: WorkerStartWriteUpdate,
  prior: UpdateFormValues,
  after: UpdateFormValues | null,
  evidence: WriteUpdateEvidence,
): FormUpdatePostcheck => {
  const matched = fieldsMatchedOf(evidence);
  if (after === null || matched === null) {
    return 'UNDETERMINED';
  }
  if (matched) {
    return 'UPDATED';
  }
  const unchanged = update.changedFieldNames.every((name) => sameValue(after.fields[name] ?? null, prior.fields[name] ?? null))
    && evidence.fields.every(({ role, matched: fieldMatched }) => role === CHANGED_FIELD_ROLE || fieldMatched === true);
  return unchanged ? 'UNCHANGED' : 'CHANGED_OTHERWISE';
};

/**
 * 登録の ID を取る（取れなければ null。成果物に書いてよい値だけ）。URL の path の型（`{id}` の区切り）は、T40R-fix-A から保存と IPC と同じ部品
 * `recordIdOfPathPattern`（`src/discovery/fingerprint.ts`。区切りの数と、ほかの区切りが同じときだけ、そのままの値）で取る。要素は、ちょうど 1 つのときだけ、
 * その文字の前後の空白を除いた値。
 */
async function recordIdOf(page: Page, spec: ScenarioRecordIdSpec, windows: ObservationWindows): Promise<string | null> {
  try {
    if (spec.source === 'URL_PATH_PATTERN') {
      return recordableRecordIdOf(recordIdOfPathPattern(new URL(page.url()).pathname, spec.pathPattern));
    }
    const locator = loginStageLocator(page, spec.selector);
    if ((await locator.count()) !== 1) {
      return null;
    }
    const text = await locator.textContent({ timeout: windows.write.resultPollIntervalMs });
    return recordableRecordIdOf(text === null ? null : text.trim());
  } catch {
    return null;
  }
}

/** T40b-1: 記録できる HTTP の状態の範囲（`action-run.json` の `httpStatus` の最小と最大）。 */
const RECORDABLE_HTTP_STATUS_RANGE: HttpStatusRange = Object.freeze({ min: MIN_HTTP_STATUS, max: MAX_HTTP_STATUS });

/** T40b-1: API の書き込みの応答の事実（記録する状態と、結果の判定。応答が分からなければどちらも null）。 */
export interface ApiResponseFacts {
  readonly httpStatus: number | null;
  readonly responseJudgement: ResponseJudgement | null;
}

const UNKNOWN_API_RESPONSE: ApiResponseFacts = Object.freeze({ httpStatus: null, responseJudgement: null });

/**
 * T40b-1: 送り手の応答の状態から、記録する状態と判定を決める（純粋。ファイルの先頭の T40b-1）。応答を受けていない、状態が 100〜599 の外（整数でない
 * 値を含む）なら、応答が分からないとして、どちらも null（T40c の発見事項 3 への判断。結果は `UNKNOWN`）。範囲の中なら、状態はそのまま、判定は
 * `apiResponseJudgementOf`（判定の唯一の口）。
 */
export const apiResponseFactsOf = (report: { readonly responseReceived: boolean; readonly responseStatus: number | null }): ApiResponseFacts => {
  const status = report.responseReceived ? report.responseStatus : null;
  if (status === null || !Number.isSafeInteger(status) || !isHttpStatusInRange(status, RECORDABLE_HTTP_STATUS_RANGE)) {
    return UNKNOWN_API_RESPONSE;
  }
  return Object.freeze({ httpStatus: status, responseJudgement: apiResponseJudgementOf(status) });
};

/** T40b-1: API の書き込みの登録の ID の取り方（応答の本文の鍵か、保存の後の画面の URL・要素）。 */
export type ApiRecordIdSource =
  | { readonly kind: 'RESPONSE_BODY'; readonly key: string }
  | { readonly kind: 'PAGE'; readonly spec: ScenarioRecordIdSpec };

/**
 * T40b-1: ID の取り方を選ぶ（純粋）。API の指定の `recordId`（応答の本文の鍵）があればそれ、なければ検証の指定の `recordId`（保存の後の画面）。
 * どちらもなければ null（契約で拒むので起きない。fail-closed: ID なしで判定する）。
 */
export const apiRecordIdSourceOf = (write: WorkerStartApiWrite): ApiRecordIdSource | null => {
  if (write.api.recordId !== null) {
    return { kind: 'RESPONSE_BODY', key: write.api.recordId.key };
  }
  return write.verification.recordId === null ? null : { kind: 'PAGE', spec: write.verification.recordId };
};

/** T40b-1: API の入力と押下の指定（欄は `api.keyFields` の欄の識別、値は鍵ごとの生成した値。null の値の鍵は入れない）。 */
const apiInputSpecOf = (write: WorkerStartApiWrite): ApiWriteInputSpec => ({
  submitterIdentityDigest: write.submitterIdentityDigest,
  fields: write.api.keyFields.flatMap(({ key, field }) => {
    const value = Object.hasOwn(write.values, key) ? write.values[key] : null;
    return typeof value === 'string' ? [{ field, value }] : [];
  }),
});

/** T40b-1: Guard の API の照合の期待（承認した API の指定と鍵ごとの生成した値。登録なので台帳の ID はない）。 */
const apiExpectationOf = (write: WorkerStartApiWrite): ApiWritePayloadExpectation => ({ spec: write.api, values: write.values, recordId: null });

/**
 * T41d・LU-10: API の更新の Guard の照合の期待（JSON の素の値だけ）。今の更新は、前の読み取りの保つ鍵とページが決める鍵の前の値を入れる。LU-10（一覧の行の更新の
 * 設計書 4.0.1 の K1、5.3 の 2。条件 3・7・9）: 一覧の行の更新は、前の値を持たず、前の値を後から入れる印（`deferredPriorValues`。保つ鍵の名前は承認した API の
 * 指定の保つ鍵。ページの値から作らない）を付ける。前の値は、書き込みの段で開き手を押した後に、Guard の口（`supplyApiPriorValues`）だけで入れる（照合の側の
 * 純粋な関数の結果を期待として使わない）。
 */
const apiUpdateExpectationOf = (write: WorkerStartApiWrite, update: ApiUpdateStage): ApiWritePayloadExpectation => (update.listRow === undefined
  ? {
    ...apiExpectationOf(write), recordId: update.targetRecordId, keptKeys: update.keptPriorValues, pageKeyPriorValues: update.pagePriorValues,
    // DEF-198（設計書 5.9 の 3）: ほかの filter の照らす値（親が入れた、同じ点検の登録のページが決めた値。メモリの中だけ）。
    ...(write.update?.otherFilterValues === undefined ? {} : { otherFilterValues: write.update.otherFilterValues.map(({ key, value }) => ({ key, value })) }),
    // DEF-203（設計書 5.10 の 1）: 台帳の登録の値と照らす鍵の値（親が入れた、同じ点検の登録のページが決めた値。JSON の型のまま。メモリの中だけ）。
    ...(write.update?.ledgerKeyValues === undefined
      ? {}
      : { ledgerKeyValues: write.update.ledgerKeyValues.map(({ key, value }) => ({ key, value })) }),
  }
  : { ...apiExpectationOf(write), recordId: update.targetRecordId, deferredPriorValues: { keptKeys: [...update.listRow.deferredKeptKeys] } });

/** T40b-1: API の書き込みの段の指定（ID を応答の本文から取るなら、Guard の `recordIdOf` に ID の鍵で包んだ口を渡す）。 */
/**
 * LU-SFIX3-B（LU-SREV3 の Important-2）: フォームの更新（形 B・形 C）の書き込みの段の指定。送信先の path の最後の区切りが対象の番号なら、窓の前（N2）に守る
 * 送信先の型（`recordPathShapeOf` の 1 か所で作る）を足す（型と表の path を守る。API の path の形と同じ強さ）。登録は使わない（今のまま）。
 */
const formUpdateWriteStageOf = (expectation: WritePayloadExpectation, monitor: WriteStageMonitor, targetRecordId: string): GuardWriteStage => {
  const guardedPathShape = recordPathShapeOf(expectation.request.path, targetRecordId);
  return guardedPathShape === null ? { expectation, monitor } : { expectation, monitor, guardedPathShape };
};

const apiWriteStageOf = (write: WorkerStartApiWrite, monitor: WriteStageMonitor, update?: ApiUpdateStage): GuardWriteStage => {
  if (update !== undefined) {
    // T41d（Task 41 の設計書 3.3・3.4）: 更新の照合の期待は、変える鍵の生成した値、対象の ID（filter の照合）、保つ鍵とページが決める鍵の前の値（メモリの
    // 中だけ）。応答の本文からは、ID の鍵（応答の本文の鍵がなければ filter の名前）の ID と、一覧の要素の数を読む（本文は持たない）。
    const key = write.api.recordId?.key ?? write.api.filterName;
    return {
      transport: WORKER_API_WRITE_TRANSPORT,
      expectation: apiUpdateExpectationOf(write, update),
      monitor,
      recordIdOf: (body: Buffer): string | null => {
        // CC-104: 本文の形を 1 回だけ求めて、一覧の要素の数と、読めない本文かを決める。
        const shape = apiResponseBodyShapeOf(body);
        update.response.rowCount = shape.kind === 'LIST' ? shape.length : null;
        update.response.bodyUnreadable = shape.kind === 'UNREADABLE';
        return key === null ? null : apiRecordIdOfResponseBody(body, key);
      },
    };
  }
  const source = apiRecordIdSourceOf(write);
  return {
    transport: WORKER_API_WRITE_TRANSPORT,
    expectation: apiExpectationOf(write),
    monitor,
    recordIdOf: source?.kind === 'RESPONSE_BODY' ? (body: Buffer): string | null => apiRecordIdOfResponseBody(body, source.key) : undefined,
  };
};

// ---------------------------------------------------------------------------------------------------------------
// T41d（Task 41 の設計書 3.4）: API の更新
// ---------------------------------------------------------------------------------------------------------------

/** T41d: API の書き込みの指定が UPDATE（T41b の `update: { targetRecordId }`）なら、対象の ID（登録は null）。 */
const apiUpdateTargetOf = (write: WorkerStartApiWrite): string | null => write.update?.targetRecordId ?? null;

/** T41R3-fix: 台帳が知る保つ鍵の最後の値（`START` の `update.knownKeptValues` の 1 つ。値は BeakSight が作ったテストの値。メモリの中だけ）。 */
export interface ApiUpdateKnownKeptValue {
  readonly key: string;
  readonly value: string;
}

/**
 * T41R3-fix（設計書 8 章の「T41R3」の (1)・(2)）: 親が台帳から求める保つ鍵ごとの最後に分かっている値（`START` の `update.knownKeptValues`。T41R3-fix-B の
 * 約束の形。T41R2-fix の `knownFilledKeptKeys` を置き換えた。IPC の確かめが、API の指定の保つ鍵だけで重ならないことを確かめる）。登録は空の一覧。
 */
const apiUpdateKnownKeptValuesOf = (write: WorkerStartApiWrite): readonly ApiUpdateKnownKeptValue[] => write.update?.knownKeptValues ?? [];

/**
 * T41R3-fix（M-1）: 同じ Run の書き込みの画面（`formPage`。前の読み取り・書き込みの段・後の照合で同じ Origin と path）で、要求が止む待ちの上限に一度
 * 届いたか。届いたら、残りの読み取りでその待ちを省く。
 */
interface ApiUpdateQuietMemory {
  quietTimedOut: boolean;
  /**
   * RB-11: この画面の落ち着きの待ちに使う観察の窓の一式（`writeStageWatchOf` の一式。テストだけが差し込む）。要求が止む待ちを省く画面の候補の読み取りは、上限を
   * 欄の値の待ちの上限（`discoverySettle.busyTimeoutMs`）に縮める（`settlePolicyOfWindows` の `busy`。ほかは発見と同じ）。
   */
  readonly windows: ObservationWindows;
}

/** RB-11: 画面の、要求が止んだかの確かめ（最後の終わりから、落ち着きの待ちの静かな時間が過ぎたか）。止んでいなければ、残りの読み取りで待ちを省く。 */
const rememberQuietTimedOut = (counter: QuietSource, quiet: ApiUpdateQuietMemory): void => {
  const quietSince = counter.quietSinceMs();
  if (quietSince === null || Date.now() - quietSince < quiet.windows.discoverySettle.networkQuietMs) {
    quiet.quietTimedOut = true;
  }
};
/**
 * T41R2-fix（M-1）: 応答の本文が空でなく、行の数を数えられない（UTF-8 や JSON として読めない。L10 で大きさの上限は撤廃した）か。空の本文
 * （204 など）は偽。本文は記録しない。例外を投げない。CC-104: 解読は本文の形の唯一の部品（`apiResponseBodyShapeOf`）。
 */
export const isUnreadableApiResponseBody = (body: Uint8Array): boolean => apiResponseBodyShapeOf(body).kind === 'UNREADABLE';

/** T41d: 更新の画面の欄の値（鍵 → 値。変える欄、保つ欄、ページが決める鍵の欄。メモリの中だけ。記録しない）。 */
export interface ApiUpdateFieldValues {
  readonly changed: Readonly<Record<string, string>>;
  readonly kept: Readonly<Record<string, string>>;
  readonly page: Readonly<Record<string, string>>;
}

/**
 * T41d: API の更新の、書き込みの段に渡す前の値と指定（前の読み取りの結果）。`response` は Guard の `recordIdOf` が書く、応答の本文の一覧の要素の数
 * （T41R-fix。一覧でなければ null）。
 */
interface ApiUpdateStage {
  readonly targetRecordId: string;
  readonly submitterIdentityDigest: string;
  readonly prior: ApiUpdateFieldValues;
  readonly keptPriorValues: readonly ApiWritePriorValue[];
  readonly pagePriorValues: readonly ApiWritePriorValue[];
  readonly response: { rowCount: number | null; bodyUnreadable: boolean };
  /** T41R3-fix: 台帳が知る保つ鍵の最後の値（`apiUpdateKnownKeptValuesOf`）。 */
  readonly knownKeptValues: readonly ApiUpdateKnownKeptValue[];
  /** T41R3-fix（M-1）: 書き込みの画面で、要求が止む待ちの上限に届いたか（同じ Run の残りの読み取りで待ちを省く）。 */
  readonly quiet: ApiUpdateQuietMemory;
  /**
   * LU-10: 一覧の行の更新の指定（`START` の `update.listRow` のある更新だけ）。このときの `prior`・`keptPriorValues`・`pagePriorValues` は、送る前の確かめの
   * 時点では空（前の読み取りをしない）。書き込みの段で開き手を押した後に読んだ値で、段の中の指定を作り直す（`listRow.observed` にも残す）。
   */
  readonly listRow?: ApiListRowStage;
}

/**
 * LU-10（一覧の行の更新の設計書 5.5）: 一覧の行の更新の、書き込みの段に渡す指定と、段の中で読んだ前の値の置き場所（メモリの中だけ。記録しない）。
 * - `rowKeyValue`: 行を選ぶ欄の、台帳で最後に分かっている値（`START` の `update.listRow.rowKeyValue`）。
 * - `openerIdentityDigest`: 承認した開き手の識別の digest（`api.ledger.listRow.openerIdentityDigest`）。
 * - `deferredKeptKeys`: 前の値を後から入れる保つ鍵の名前（承認した API の指定の保つ鍵の順。`START` の印と同じことを確かめた後）。
 * - `observed.prior`: 開き手を押した後に読み、Guard に入れた前の値（入れる前と、入れなかったときは null。後の照合の証拠に使う）。
 */
interface ApiListRowStage {
  readonly rowKeyValue: string;
  readonly openerIdentityDigest: string;
  readonly deferredKeptKeys: readonly string[];
  readonly observed: { prior: ApiUpdateFieldValues | null };
}

/**
 * T41d: API の更新の結果の判定（純粋。ファイルの先頭の T41d）。状態の判定が成功でなければそのまま（ID なし）。成功で応答の本文が空の一覧なら、更新した行が
 * ないとして `NO_CONDITION_MATCHED`（結果は `UNKNOWN`。今の閉じた一覧から選んだ）。T41R-fix（設計書 8 章の「T41R の完全版」の I-2）: 要素 2 つ以上の
 * 一覧なら、2 行以上を更新した（どの行が変わったか分からない）として `MULTIPLE_CONDITIONS_MATCHED`（結果は `UNKNOWN`。今の閉じた一覧から選んだ）。
 * 応答の本文の ID が対象の ID と違えば、その ID（`actionOutcomeOf` が `RECORD_ID_MISMATCH` にする）。ほかは対象の ID（Guard が filter で対象に結んでいる）。
 * `rowCount` は応答の本文の一覧の要素の数（`apiResponseListLength`。一覧でなければ null）。
 * T41R2-fix（M-1）: 本文が空でなく読めない（`bodyUnreadable`。上限を超える、JSON でない）なら、行の数が分からないので `NO_CONDITION_MATCHED`（結果は
 * `UNKNOWN`。今の閉じた一覧から選んだ）。空の本文（204）は今のまま成功の側。
 */
export const apiUpdateResultOf = (facts: {
  readonly responseJudgement: ResponseJudgement;
  readonly targetRecordId: string;
  readonly bodyRecordId: string | null;
  readonly rowCount: number | null;
  readonly bodyUnreadable?: boolean;
}): { readonly responseJudgement: ResponseJudgement; readonly rawRecordId: string | null } => {
  if (facts.responseJudgement !== 'SUCCESS') {
    return { responseJudgement: facts.responseJudgement, rawRecordId: null };
  }
  if (facts.rowCount === 0 || facts.bodyUnreadable === true) {
    return { responseJudgement: 'NO_CONDITION_MATCHED', rawRecordId: null };
  }
  if (facts.rowCount !== null && facts.rowCount >= 2) {
    return { responseJudgement: 'MULTIPLE_CONDITIONS_MATCHED', rawRecordId: null };
  }
  return { responseJudgement: 'SUCCESS', rawRecordId: facts.bodyRecordId !== null && facts.bodyRecordId !== facts.targetRecordId ? facts.bodyRecordId : facts.targetRecordId };
};

/** 更新の後の照合の、1 つの欄の後の画面の値と、値のほかの一致の条件（form の組の hidden。ほかは真）。 */
interface UpdateFieldAfter {
  readonly value: string | null;
  readonly alsoMatched: boolean;
}

/** 更新の後の照合の、1 つの欄の比べ（`expected` は後の画面で期待する値。変えた欄は送った新しい値、保つ欄は前の値。後の画面を読めなければ `after` は null）。 */
interface UpdateFieldCheck {
  readonly fieldName: string;
  readonly expected: string | null;
  readonly after: UpdateFieldAfter | null;
}

/** 欄の一致（後の画面を読めなければ null。比べ方は `sameValue`）。 */
const updateFieldMatchedOf = (check: UpdateFieldCheck): boolean | null =>
  (check.after === null ? null : sameValue(check.after.value, check.expected) && check.after.alsoMatched);

/**
 * T41R-fix（設計書 8 章の「T41R の完全版」の M-2）: 更新の後の照合の証拠（Task 31 の `WriteUpdateEvidence`）を組み立てる唯一の部品（form の UPDATE の
 * `updateEvidenceOf` と API の更新の `apiUpdateEvidenceOf` が使う）。変えた欄（`CHANGED`）は前の値と送った新しい値（なければ空）と一致の真偽、保つ欄
 * （`KEPT`）は一致の真偽だけ（値を残さない）。順は変えた欄、保つ欄の順（呼ぶ側の順のまま）。
 */
function updateEvidenceOfChecks(
  changed: readonly (UpdateFieldCheck & { readonly previousValue: string })[],
  kept: readonly UpdateFieldCheck[],
): WriteUpdateEvidence {
  return Object.freeze({
    fields: Object.freeze([
      ...changed.map((check): WriteUpdateFieldEvidence => Object.freeze({
        fieldName: check.fieldName, role: 'CHANGED', previousValue: check.previousValue, newValue: check.expected ?? '', matched: updateFieldMatchedOf(check),
      })),
      ...kept.map((check): WriteUpdateFieldEvidence => Object.freeze({
        fieldName: check.fieldName, role: 'KEPT', previousValue: null, newValue: null, matched: updateFieldMatchedOf(check),
      })),
    ]),
  });
}

/**
 * T41d: API の更新の後の照合の証拠（純粋。Task 31 の `WriteUpdateEvidence`）。変えた欄（`CHANGED`）は前の値と送った新しい値と一致の真偽、保つ欄とページが
 * 決める鍵（`KEPT`）は一致の真偽だけ（値を残さない）。後の画面を読めなければ（`after` が null）、一致は null。比べ方は form と同じ `sameValue`。
 * T41R3-fix（設計書 8 章の「T41R3」の (2)。T41R2-fix の空の確かめを置き換えた）: 台帳が知る保つ鍵（`knownKeptValues`）の後の値が台帳の値と違えば
 * （仮の値・空を含む）、値が入る前の画面を読んだとみなし、その欄は照合できない（一致は null。結果は `UPDATE_POSTCHECK_UNDETERMINED` の側）。一覧にない
 * 保つ鍵は、今のまま前の値と照らす。
 */
export const apiUpdateEvidenceOf = (
  prior: ApiUpdateFieldValues,
  after: ApiUpdateFieldValues | null,
  values: Readonly<Record<string, string | null>>,
  knownKeptValues: readonly ApiUpdateKnownKeptValue[] = [],
): WriteUpdateEvidence => {
  const afterOf = (group: keyof ApiUpdateFieldValues, fieldName: string): UpdateFieldAfter | null => {
    const value = after === null ? null : after[group][fieldName] ?? null;
    const known = group === 'kept' ? knownKeptValues.find(({ key }) => key === fieldName) : undefined;
    if (after === null || (known !== undefined && !sameValue(value, known.value))) {
      return null;
    }
    return { value, alsoMatched: true };
  };
  return updateEvidenceOfChecks(
    Object.keys(prior.changed).map((fieldName) => ({
      fieldName, previousValue: prior.changed[fieldName] ?? '', expected: values[fieldName] ?? null, after: afterOf('changed', fieldName),
    })),
    (['kept', 'page'] as const).flatMap((group) => Object.keys(prior[group]).map((fieldName) => ({
      fieldName, expected: prior[group][fieldName] ?? null, after: afterOf(group, fieldName),
    }))),
  );
};

/**
 * DEF-198（設計書 5.9 の 3・4）: ほかの filter のある更新の、番号の filter とほかの filter と同じ名前のページが決める鍵の照らす値の文字（名前 → 文字。番号の
 * filter の名前は台帳の ID、ほかの filter の名前は `update.otherFilterValues` の値）。画面から読まない。ほかの filter のない更新は空。
 */
const apiFilterBoundPageValuesOf = (write: WorkerStartApiWrite, targetRecordId: string): Readonly<Record<string, string>> => {
  const others = write.update?.otherFilterValues ?? [];
  const { filterName } = write.api;
  if (others.length === 0 || filterName === null) {
    return Object.freeze({});
  }
  return Object.freeze(Object.fromEntries([[filterName, targetRecordId], ...others.map(({ key, value }) => [key, String(value)])]));
};

/**
 * DEF-203（設計書 5.10 の 1）: 台帳の登録の値と照らす鍵の前の値（`update.ledgerKeyValues`。JSON の型のまま。画面から読まない）。照らす鍵のない更新は空。
 * 照らす鍵の名前の集合と値の名前の集合が違う、値の型がページが決める鍵の宣言の型と違うときは null（送らない）。
 */
const apiLedgerBoundPriorValuesOf = (write: WorkerStartApiWrite): readonly ApiWritePriorValue[] | null => {
  const names = write.api.ledgerPageKeys ?? [];
  const values = write.update?.ledgerKeyValues ?? [];
  const types = new Map(write.api.pageKeys.map(({ key, type }) => [key, type]));
  const typeOf = (value: ApiWritePriorValue['value']): ApiJsonValueType => (value === null ? 'null' : typeof value as ApiJsonValueType);
  if (values.length !== names.length || values.some(({ key, value }) => !names.includes(key) || types.get(key) !== typeOf(value))) {
    return null;
  }
  return Object.freeze(values.map(({ key, value }) => Object.freeze({ key, value })));
};

/** T41d: 更新の画面で読む欄（変える欄、保つ欄、ページが決める鍵の欄の順。ページが決める鍵に欄の識別がなければ null。fail-closed）。 */
const apiUpdateFieldsOf = (write: WorkerStartApiWrite): { readonly group: keyof ApiUpdateFieldValues; readonly key: string; readonly field: ApiFieldIdentity }[] | null => {
  // DEF-198（設計書 `2026-11-02-beaksight-list-row-update-design.md` 5.9 の 4）: 番号と所属の鍵（ほかの filter のある更新の、filter と同じ名前の鍵）は画面から
  // 読まない（照らす値は台帳の番号と、ほかの filter の照らす値。`apiFilterBoundPageValuesOf`）。
  // DEF-203（設計書 5.10 の 1）: 台帳の登録の値と照らす鍵も画面から読まない（照らす値は `update.ledgerKeyValues`。`apiLedgerBoundPriorValuesOf`）。
  const bound = apiFilterBoundPageValuesOf(write, '');
  const ledgerBound = new Set(write.api.ledgerPageKeys ?? []);
  const pageKeys = write.api.pageKeys.filter(({ key, field }) => field !== undefined || (!Object.hasOwn(bound, key) && !ledgerBound.has(key)))
    .map(({ key, field }) => (field === undefined ? null : { group: 'page' as const, key, field }));
  if (pageKeys.some((entry) => entry === null)) {
    return null;
  }
  return [
    ...write.api.keyFields.map(({ key, field }) => ({ group: 'changed' as const, key, field })),
    ...(write.api.keptKeys ?? []).map(({ key, field }) => ({ group: 'kept' as const, key, field })),
    ...(pageKeys as { readonly group: 'page'; readonly key: string; readonly field: ApiFieldIdentity }[]),
  ];
};

/**
 * T41d: 更新の画面の欄の値を、落ち着くまで待って読む（`readApiWriteFieldValues`。読めなければ null）。T41R-fix: 落ち着きは、画面を読み込む前に作った進行中の
 * 要求の数え方（`counter`）で、要求が止んだ後に 2 回続けて同じ値（READ と同じ部品）。T41R3-fix（M-1）: 同じ Run で一度、要求が止む待ちの上限に届いた
 * 画面（`quiet.quietTimedOut`）は、その待ちを省き、間隔を置いた 2 回の読み取りの落ち着きで読む。上限に届いたら `quiet` に書く。
 */
async function readApiUpdateFieldValues(
  page: Page,
  write: WorkerStartApiWrite,
  counter: QuietSource,
  quiet: ApiUpdateQuietMemory,
): Promise<ApiUpdateFieldValues | null> {
  const fields = apiUpdateFieldsOf(write);
  if (fields === null) {
    return null;
  }
  const read = await readApiWriteFieldValues(page, fields.map(({ field }) => field), quiet.quietTimedOut ? undefined : {
    source: counter,
    onQuietTimedOut: () => {
      quiet.quietTimedOut = true;
    },
  }, undefined, { observationWindows: quiet.windows });
  if (!read.ok) {
    return null;
  }
  const groups: Record<keyof ApiUpdateFieldValues, Record<string, string>> = { changed: {}, kept: {}, page: {} };
  fields.forEach(({ group, key }, index) => {
    groups[group][key] = read.values[index] ?? '';
  });
  return Object.freeze({ changed: Object.freeze(groups.changed), kept: Object.freeze(groups.kept), page: Object.freeze(groups.page) });
}

/** T41d: 2 つの読み取りの値が、どの欄も同じか（書き込みの段で開き直した画面の値と、前の値）。 */
const sameApiUpdateFieldValues = (left: ApiUpdateFieldValues, right: ApiUpdateFieldValues): boolean =>
  (['changed', 'kept', 'page'] as const).every((group) => {
    const keys = Object.keys(left[group]);
    return keys.length === Object.keys(right[group]).length && keys.every((key) => sameValue(left[group][key] ?? null, right[group][key] ?? null));
  });

/**
 * T41R-fix（設計書 8 章の「T41R の途中の報告」の (2)）: 前の読み取りが、値の入った画面のものか。目印を入れた欄（変える欄と保つ欄）の前の値がすべて空なら、
 * 値が入る前の画面とみなす（対象は BeakSight が登録した照合済みのレコードなので、生成した値の欄は空でないはず）。
 */
export const apiUpdatePriorFilled = (prior: ApiUpdateFieldValues): boolean =>
  [...Object.values(prior.changed), ...Object.values(prior.kept)].some((value) => value !== '');

/**
 * T41R3-fix（設計書 8 章の「T41R3」の (2)。T41R2-fix の「空でないはずの保つ鍵」の確かめを置き換えた）: 台帳が知る保つ鍵（`knownKeptValues`）のどれかの
 * 値が、台帳の値と違うか（比べ方は `sameValue`。空の値は空と比べる）。違えば、値が入る前の画面（仮の値・空）か、BeakSight の外で変わったレコードとみなす。
 * シナリオの保つ鍵として読んだ鍵だけを見る（一覧にあっても読んだ値にない鍵は比べない）。
 */
export const apiUpdateKnownKeptMismatch = (values: ApiUpdateFieldValues, knownKeptValues: readonly ApiUpdateKnownKeptValue[]): boolean =>
  knownKeptValues.some(({ key, value }) => Object.hasOwn(values.kept, key) && !sameValue(values.kept[key] ?? null, value));

/**
 * T41R-fix（同じ行の (3)）: 押す直前の読み直しの値で、押してよいか。保つ欄とページが決める鍵の欄は前の値のまま、変える欄は入れた生成した値のまま
 * （比べ方は `sameValue`）。読めなければ（null）押さない。
 */
export const apiUpdateReadyToPress = (
  prior: ApiUpdateFieldValues,
  current: ApiUpdateFieldValues | null,
  values: Readonly<Record<string, string | null>>,
): boolean => current !== null
  && (['kept', 'page'] as const).every((group) => Object.keys(prior[group]).every((key) =>
    Object.hasOwn(current[group], key) && sameValue(current[group][key] ?? null, prior[group][key] ?? null)))
  && Object.keys(prior.changed).every((key) => Object.hasOwn(current.changed, key) && sameValue(current.changed[key] ?? null, values[key] ?? null));

/** T41d: 前の値を、承認した鍵の JSON の型の値にする（Guard の照合の期待。変えられなければ null）。 */
const apiPriorValuesOf = (
  keys: readonly { readonly key: string; readonly type: ApiJsonValueType }[],
  values: Readonly<Record<string, string>>,
): readonly ApiWritePriorValue[] | null => {
  const converted: ApiWritePriorValue[] = [];
  for (const { key, type } of keys) {
    const conversion = jsonValueOf(values[key] ?? null, type);
    if (!conversion.ok) {
      return null;
    }
    converted.push(Object.freeze({ key, value: conversion.value }));
  }
  return Object.freeze(converted);
};

/**
 * T41d: API の更新の前の読み取りと後の照合（凍結した Context で対象の ID の更新の画面を 1 回読む）。画面の path を型にした識別の digest
 * （`pagePathTemplatedIdentityDigestOf`）が承認の値と同じ候補がちょうど 1 つで、その画面の path の最後の ID の区切り（`lastRecordIdLikePathSegmentIndexOf`）が
 * 対象の ID であれば、送信の要素の識別の digest（その候補の識別の digest）と、欄の値を返す。
 */
function checkApiUpdatePage(
  factory: BrowserContextFactory,
  pacer: NavigationPacer,
  write: WorkerStartApiWrite,
  targetRecordId: string,
  options: GuardedPageVisitOptions,
  quiet: ApiUpdateQuietMemory,
): Promise<WritePageCheck<{ readonly submitterIdentityDigest: string; readonly values: ApiUpdateFieldValues }>> {
  const classificationPolicy = { allowedOrigins: new Set(options.authentication.approvedTestOrigins) };
  return checkWritePage(factory, pacer, write.formPage, options, async ({ page, counter }) => {
    // T41R3-fix（M-1）: 同じ Run で一度、要求が止む待ちの上限に届いた画面は、候補の読み取りの落ち着きの待ちを、欄の値の待ちの上限
    // （観察の窓の一式の `discoverySettle.busyTimeoutMs`）に縮める。0 にはしない: 候補の読み取りは画面を凍結するので、待たずに凍結すると値が入る前の画面を読む（確かめた）。
    const read = await readCandidatePage(page, {
      classificationPolicy, requestCounter: counter, settlePolicy: settlePolicyOfWindows(quiet.windows, quiet.quietTimedOut),
    });
    // 候補の落ち着きの待ちの後も要求が止んでいなければ（開いたままの要求）、この画面の残りの読み取りで要求が止む待ちを省く。
    rememberQuietTimedOut(counter, quiet);
    const matching = read.candidates.filter((candidate) => write.api.templatedIdentityDigest !== undefined
      && pagePathTemplatedIdentityDigestOf(candidate) === write.api.templatedIdentityDigest);
    const [only, ...others] = matching;
    const segment = only === undefined ? null : lastRecordIdLikePathSegmentIndexOf(only.page.path);
    if (only === undefined || others.length > 0 || segment === null || only.page.path.split('/')[segment] !== targetRecordId) {
      // OP-L（L1）: 規則の digest は、この確かめでは照らさない（型にした識別と、path の ID の区切りだけ）。
      return candidateNotMatched(candidateMismatchOf(read.candidates.length, matching, null));
    }
    // T41R-fix（(1)・(4)）: 前の読み取りと後の照合は、画面を読み込む前に作った数え方で、要求が止んだ後に落ち着いた値を読む。
    const values = await readApiUpdateFieldValues(page, write, counter, quiet);
    return { matched: true, value: values === null ? null : { submitterIdentityDigest: only.identityDigest, values } };
  });
}

/** T41d: API の更新の送る前の確かめ（前の読み取り）と、書き込みの段の指定（照合の期待に前の値を入れる）。 */
async function planApiUpdateStage(input: PrecheckInput, write: WorkerStartApiWrite, targetRecordId: string): Promise<WriteStagePlan> {
  // T41R3-fix（M-1）: 書き込みの画面の、要求が止む待ちの上限に届いたかの覚え（この Run の読み取りで共有する）。
  const quiet: ApiUpdateQuietMemory = { quietTimedOut: false, windows: input.watch.observationWindows };
  const checked = await input.session.checkApiUpdatePage(write, targetRecordId, input.options, quiet);
  noticeSessionLost(input, checked.sessionLostUrl);
  const stop = (candidateDigestMatched: boolean | null, precheckDetail: PrecheckFailureDetail): WriteStagePlan =>
    ({ kind: 'STOP', facts: notSent(PRECHECK_FAILED, { violation: checked.violation, candidateDigestMatched, precheckDetail, candidateMismatch: checked.candidateMismatch }) });
  if (checked.value === null || input.stopSignal.aborted) {
    return stop(checked.candidateMatched, pageCheckDetailOf(checked, input.stopSignal.aborted));
  }
  const { submitterIdentityDigest, values } = checked.value;
  const keptPriorValues = apiPriorValuesOf(write.api.keptKeys ?? [], values.kept);
  // DEF-198（設計書 5.9 の 4）: 番号と所属の鍵の前の値は、画面から読まず、台帳の番号とほかの filter の照らす値にする（Guard が本文と完全一致を求める）。
  // DEF-203（設計書 5.10 の 1）: 台帳の登録の値と照らす鍵の前の値は、画面から読まず、親が入れた値（JSON の型のまま）にする（Guard が本文と完全一致を求める）。
  const ledgerPriorValues = apiLedgerBoundPriorValuesOf(write);
  const ledgerKeys = new Set(write.api.ledgerPageKeys ?? []);
  const screenPriorValues = apiPriorValuesOf(write.api.pageKeys.filter(({ key }) => !ledgerKeys.has(key)),
    { ...values.page, ...apiFilterBoundPageValuesOf(write, targetRecordId) });
  const pagePriorValues = screenPriorValues === null || ledgerPriorValues === null ? null : Object.freeze([...screenPriorValues, ...ledgerPriorValues]);
  // 変える欄の前の値は証拠に書くので、長さの上限（`action-run.json` と同じ）を超えれば送らない。T41R-fix（(2)）: 目印を入れた欄がすべて空なら、値が入る
  // 前の画面とみなして送らない。
  // T41R3-fix（(2)）: 台帳が知る保つ鍵の値と違えば（仮の値・空・BeakSight の外での変更）、送らない。
  const knownKeptValues = apiUpdateKnownKeptValuesOf(write);
  // T44e（Task 44 の設計書 P2-4）: 送らない条件は今のまま。具体的な理由は、型に変えられない → 値が入る前 → 台帳の値と違う → 長すぎる、の順に決める。
  if (keptPriorValues === null || pagePriorValues === null) {
    return stop(true, 'PRIOR_VALUE_UNUSABLE');
  }
  if (!apiUpdatePriorFilled(values)) {
    return stop(true, 'PRIOR_VALUES_EMPTY');
  }
  if (apiUpdateKnownKeptMismatch(values, knownKeptValues)) {
    return stop(true, 'KNOWN_KEPT_VALUE_MISMATCH');
  }
  // L12b（設計書 `2026-11-09-beaksight-remove-limits-design.md` 6.2。S18）: 変える鍵の前の値の長さの上限（前は `MAX_SUBMITTED_VALUE_LENGTH` を超えたら
  // `PRIOR_VALUE_UNUSABLE`。理由の値は成果物の schema の enum にあるので残す）は置かない。
  const apiUpdate: ApiUpdateStage = {
    targetRecordId, submitterIdentityDigest, prior: values, keptPriorValues, pagePriorValues, response: { rowCount: null, bodyUnreadable: false },
    knownKeptValues, quiet,
  };
  return { kind: 'STAGE', writeStageOf: (monitor) => apiWriteStageOf(write, monitor, apiUpdate), apiUpdate };
}

// ---------------------------------------------------------------------------------------------------------------
// LU-10（設計書 `2026-11-02-beaksight-list-row-update-design.md` 4.0 の D2〜D4、4.0.1 の K1・K3、5.3 の 2、5.5）: 一覧の行から開く API の更新
// ---------------------------------------------------------------------------------------------------------------

/** LU-10: 前の値を読む前の、空の前の値（一覧の行の更新の送る前の確かめの時点の置き場所。段の中で読んだ値で作り直す）。 */
const NO_PRIOR_VALUES: ApiUpdateFieldValues = Object.freeze({ changed: Object.freeze({}), kept: Object.freeze({}), page: Object.freeze({}) });

/** 2 つの名前の一覧が、同じ順で同じか。 */
const sameNames = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((name, index) => right[index] === name);

/**
 * LU-10: 一覧の行の更新の送る前の確かめ（ファイルの先頭の T41d の「前の読み取り」の代わり。サイトへは要求を出さない）。凍結した Context では前の値を読まない
 * （押すまで欄がない）。止める印、書き込みの画面（一覧の画面）の URL の事前の判定（送る前の確かめと同じ `isReadUrlAllowed`）、承認した開き手の有無を確かめ、
 * 前の値を後から入れる印の保つ鍵の名前を、承認した API の指定の保つ鍵から作る（条件 3。`START` の印と同じ順で同じでなければ止める）。保つ鍵は、どれも台帳が
 * 知る値を持つこと（条件 1 の比べの相手。なければ比べられないので止める）。Guard の期待の照合へ回す送信先（`apiWriteCheckPathOf`）を作れない期待は、Context を
 * 作る前に止める（条件 4。`TARGET_RECORD_UNUSABLE`）。
 */
async function planApiListRowUpdateStage(
  input: PrecheckInput,
  write: WorkerStartApiWrite,
  targetRecordId: string,
  listRow: WorkerStartApiWriteListRow,
): Promise<WriteStagePlan> {
  const stop = (precheckDetail: PrecheckFailureDetail): WriteStagePlan => ({ kind: 'STOP', facts: notSent(PRECHECK_FAILED, { precheckDetail }) });
  if (input.stopSignal.aborted) {
    return stop('STOPPED');
  }
  if (!isReadUrlAllowed(pageUrlOf(write.formPage), input.options.config, input.options.authentication)) {
    return stop('PAGE_UNAVAILABLE');
  }
  const opener = write.api.ledger?.listRow;
  if (opener === undefined) {
    return stop('CANDIDATE_CHANGED');
  }
  const deferredKeptKeys = Object.freeze((write.api.keptKeys ?? []).map(({ key }) => key));
  if (!sameNames(deferredKeptKeys, listRow.deferredPriorValues.keptKeys)) {
    return stop('PRIOR_VALUE_UNUSABLE');
  }
  const knownKeptValues = apiUpdateKnownKeptValuesOf(write);
  if (!deferredKeptKeys.every((key) => knownKeptValues.some((known) => known.key === key))) {
    return stop('KNOWN_KEPT_VALUE_MISMATCH');
  }
  const apiUpdate: ApiUpdateStage = {
    targetRecordId,
    submitterIdentityDigest: write.submitterIdentityDigest,
    prior: NO_PRIOR_VALUES,
    keptPriorValues: Object.freeze([]),
    pagePriorValues: Object.freeze([]),
    response: { rowCount: null, bodyUnreadable: false },
    knownKeptValues,
    quiet: { quietTimedOut: false, windows: input.watch.observationWindows },
    listRow: { rowKeyValue: listRow.rowKeyValue, openerIdentityDigest: opener.openerIdentityDigest, deferredKeptKeys, observed: { prior: null } },
  };
  if (apiWriteCheckPathOf(apiUpdateExpectationOf(write, apiUpdate)) === null) {
    return stop('TARGET_RECORD_UNUSABLE');
  }
  // LU-SFIX4（LU-REV の I-1。設計書 5.5 の 0）: 登録と同じ送る前の READ を、照合と同じ READ（一覧の画面の定義）と行の選び方で 1 回読む。
  const preRead = listRowPreSubmitReadStop(input, await input.session.visitAndReadRecordPage(write.readVerification, targetRecordId,
    { ...input.options, auditStage: input.auditStage }, { rowKeyValue: listRow.rowKeyValue }));
  if (preRead !== null) {
    return { kind: 'STOP', facts: preRead };
  }
  return { kind: 'STAGE', writeStageOf: (monitor) => apiWriteStageOf(write, monitor, apiUpdate), apiUpdate };
}

/** LU-10: 開き手を押した結果（押せなかったもの）ごとの、送らずに止める理由（押す部品の結果を写す。読めない・指定の誤りは画面を読めなかった扱い）。 */
const LIST_ROW_PRESS_STOP_DETAILS: Readonly<Record<Exclude<ListRowOpenerPressResult, 'PRESSED'>, PrecheckFailureDetail>> = Object.freeze({
  OPENER_NOT_FOUND: 'OPENER_NOT_FOUND',
  OPENER_UNNAMED: 'OPENER_UNNAMED',
  OPENER_DELETE_LIKE: 'OPENER_DELETE_LIKE',
  SPEC_INVALID: 'PAGE_UNAVAILABLE',
  PAGE_UNREADABLE: 'PAGE_UNAVAILABLE',
  // 押す操作が失敗した（押したかは分からない）。押した後の要求は、今どおり Guard が扱う（窓は開いていない）。
  PRESS_FAILED: 'FORM_NOT_READY',
});

/**
 * LU-10: 一覧の画面で、行を選ぶ値を含む行を、画面が落ち着くまで待って探す（行を探す唯一の部品 `findListRowsContainingValue`。読むだけで、読み込みは足さない）。
 * 落ち着きは、画面を読み込む前に作った進行中の要求の数え方（`counter`）で、要求が止んだ後に 2 回続けて同じ結果（発見と同じ部品 `waitForDiscoverySettled`）。
 * 同じ Run で要求が止む待ちの上限に届いた画面は、上限を縮める（`BUSY_PAGE_CANDIDATE_SETTLE_POLICY`）。落ち着かなければ、最後に 1 回読んだ結果。
 */
async function settledListRowOf(page: Page, rowKeyValue: string, counter: QuietSource, quiet: ApiUpdateQuietMemory): Promise<ListRowSearchOutcome> {
  let last: ListRowSearchOutcome | null = null;
  const settled = await waitForDiscoverySettled(counter, async (deadlineAtMs) => {
    const found = await findListRowsContainingValue(page, rowKeyValue, deadlineAtMs);
    last = found;
    return found.status === 'READ' ? [JSON.stringify([found.matchedRowCount, found.row])] : null;
  }, settlePolicyOfWindows(quiet.windows, quiet.quietTimedOut));
  const settledRow: ListRowSearchOutcome | null = last;
  if (settled.status === 'SETTLED' && settledRow !== null) {
    return settledRow;
  }
  // 要求が止んでいない画面は、この画面の残りの読み取りで要求が止む待ちを省く（今の更新の画面と同じ覚え）。
  rememberQuietTimedOut(counter, quiet);
  return findListRowsContainingValue(page, rowKeyValue);
}

/**
 * LU-SFIX4（LU-REV の I-1。設計書 5.5 の 2）: 書き込みの段で行を見つけた直後（押す前）に、その行が照合の READ の「本文が含む」の期待の文字（変える欄の新しい値）の
 * どれかをもう含めば `VALUE_ALREADY_PRESENT`、分からなければ `VERIFICATION_READ_UNAVAILABLE`（送る前の READ と書き込みの段の間にページが変わる形の守り。読むだけで、
 * 読み込みは足さない。比べ方は照合と同じ `listRowTextPresenceOf`）。含まなければ null。
 */
async function rowValuePresenceStopOf(page: Page, row: ListRowReference, readVerification: WorkerStartReadCheck): Promise<PrecheckFailureDetail | null> {
  const texts = readVerification.definition.expectations.flatMap((expectation) => (expectation.kind === 'TEXT_CONTAINS' ? [expectation.text] : []));
  const presence = await listRowTextPresenceOf(page, row, texts);
  return presence === 'ABSENT' ? null : presence === 'PRESENT' ? 'VALUE_ALREADY_PRESENT' : 'VERIFICATION_READ_UNAVAILABLE';
}

/**
 * LU-10（条件 1）: 開き手を押した後に読んだ保つ鍵の値が、どれも台帳が知る最後の値と同じか（比べ方は今の更新と同じ `sameValue`。保つ鍵のどれかが読んだ値か
 * 台帳にないときは偽）。
 */
const listRowKeptValuesMatchLedger = (prior: ApiUpdateFieldValues, keptKeys: readonly string[], knownKeptValues: readonly ApiUpdateKnownKeptValue[]): boolean =>
  keptValuesMatchLedger(prior.kept, keptKeys, knownKeptValues);

/**
 * LU-12b（ユーザーの判断 2026-11-03「台帳との比べをフォームの形にも広げる」）: 読んだ値（鍵 → 値）の、名前の鍵がどれも台帳が知る最後の値と同じか（API の形と
 * フォームの形の一覧の行の更新が共有する唯一の比べ方。比べ方は `sameValue`。鍵のどれかが読んだ値か台帳にないときは偽）。
 */
const keptValuesMatchLedger = (
  read: Readonly<Record<string, string | null>>,
  keys: readonly string[],
  knownKeptValues: readonly ApiUpdateKnownKeptValue[],
): boolean => keys.every((key) => {
  const known = knownKeptValues.find((entry) => entry.key === key);
  return known !== undefined && Object.hasOwn(read, key) && sameValue(read[key] ?? null, known.value);
});

/**
 * LU-10（設計書 5.5 の 1〜6。条件 1・2・6・8）: 一覧の行の更新の書き込みの段の本体（Context を開いた後、閉じる前）。窓を開く前（N2）に:
 * 1. 一覧の画面を 1 回読む（GET。`openWriteStagePage`）。
 * 2. 行を選ぶ値を含む行を探す（`settledListRowOf`）。ちょうど 1 つでなければ送らない（`ROW_NOT_UNIQUE`。読めなければ `PAGE_UNAVAILABLE`）。
 * 3. 行の中の開き手を 1 回押す（`pressListRowOpener`。押す直前に画面を読み直し、識別の digest・削除の語・名前・ちょうど 1 つを確かめ、行の要素が同じときだけ
 *    押す）。押せなければ送らない（結果を理由に写す）。押した時にサイトが自動で送る読み取りでない要求は、今の書き込みの段の決まり（N2）で扱い、記録に残る
 *    （Guard の `passedRequests`）。
 * 4. 欄が出るのを待つ（`inspectApiWriteInputWhenRendered`）。
 * 5. 欄の値を落ち着くまで待って読み（`readApiUpdateFieldValues`）、保つ鍵の値が台帳の最後の値と同じときだけ（条件 1）、BeakSight が作った素の一覧（保つ鍵は
 *    台帳の値、ページが決める鍵は読んだ値を承認した型に変えたもの）で、Guard に前の値を 1 回入れる（`supplyApiPriorValues`）。受けなければ窓を開かずに止める
 *    （条件 2。`PRIOR_VALUES_NOT_ACCEPTED`）。値が入る前の画面・長すぎる前の値は、今の更新と同じく送らない。
 * そのあとは今の流れ（入れる → 窓を開く → 窓の中を確かめる → 押す直前の確かめ → 押す）。窓を開いた後に読み取りでない要求が出たら、今の N1 のとおり押さない
 * （条件 8。`UNEXPECTED_REQUEST`）。
 */
async function apiListRowWriteOnStage(
  input: WriteStageInput,
  write: WorkerStartApiWrite,
  apiUpdate: ApiUpdateStage,
  listRow: ApiListRowStage,
  counter: QuietSource,
): Promise<WriteStageResult> {
  const { request, monitor, page } = input;
  const { stopSignal } = request;
  const opened = await openWriteStagePage(input, write.formPage);
  if (opened !== null) {
    return opened;
  }
  if (stopSignal.aborted) {
    return precheckStopped('STOPPED');
  }
  const found = await settledListRowOf(page, listRow.rowKeyValue, counter, apiUpdate.quiet);
  if (found.status !== 'READ') {
    return precheckStopped('PAGE_UNAVAILABLE');
  }
  if (found.row === null) {
    return precheckStopped('ROW_NOT_UNIQUE');
  }
  const present = await rowValuePresenceStopOf(page, found.row, write.readVerification);
  if (present !== null) {
    return precheckStopped(present);
  }
  if (stopSignal.aborted) {
    return precheckStopped('STOPPED');
  }
  const pressed = await pressListRowOpener(page, found.row, listRow.openerIdentityDigest);
  if (pressed !== 'PRESSED') {
    return precheckStopped(LIST_ROW_PRESS_STOP_DETAILS[pressed]);
  }
  const inspection = await inspectApiWriteInputWhenRendered(page, { ...apiInputSpecOf(write), submitterIdentityDigest: apiUpdate.submitterIdentityDigest },
    undefined, input.watch);
  if (!inspection.ok || stopSignal.aborted) {
    return inspection.ok || stopSignal.aborted ? precheckStopped('STOPPED') : precheckStopped('FORM_NOT_READY', inputFailureOf('INSPECT', inspection));
  }
  const prior = await readApiUpdateFieldValues(page, write, counter, apiUpdate.quiet);
  if (prior === null) {
    return precheckStopped('PAGE_UNAVAILABLE');
  }
  // 送らない条件と理由の順は、今の更新の前の読み取りと同じ（値が入る前 → 台帳の値と違う → 型に変えられない・長すぎる）。
  if (!apiUpdatePriorFilled(prior)) {
    return precheckStopped('PRIOR_VALUES_EMPTY');
  }
  if (!listRowKeptValuesMatchLedger(prior, listRow.deferredKeptKeys, apiUpdate.knownKeptValues)) {
    return precheckStopped('KNOWN_KEPT_VALUE_MISMATCH');
  }
  // 保つ鍵の値は、台帳の値（BeakSight が作った素の文字列。読んだ値と同じことを上で確かめた）から作る。ページが決める鍵は、読んだ値を承認した型に変える。
  const ledgerKept: Record<string, string> = {};
  for (const { key, value } of apiUpdate.knownKeptValues) {
    ledgerKept[key] = value;
  }
  const keptPriorValues = apiPriorValuesOf(write.api.keptKeys ?? [], ledgerKept);
  const pagePriorValues = apiPriorValuesOf(write.api.pageKeys, prior.page);
  // L12b（S18）: 変える鍵の前の値の長さの上限は置かない。
  if (keptPriorValues === null || pagePriorValues === null) {
    return precheckStopped('PRIOR_VALUE_UNUSABLE');
  }
  if (stopSignal.aborted) {
    return precheckStopped('STOPPED');
  }
  // 条件 2: Guard が受けなければ、窓を開かずに止める（照合が止めることだけに頼らない）。
  if (!monitor.supplyApiPriorValues({ keptKeys: keptPriorValues, pageKeyPriorValues: pagePriorValues })) {
    return precheckStopped('PRIOR_VALUES_NOT_ACCEPTED');
  }
  listRow.observed.prior = prior;
  const staged: ApiUpdateStage = { ...apiUpdate, prior, keptPriorValues, pagePriorValues };
  return apiWriteFillAndPress(input, write, inspection.input, { apiUpdate: staged, counter });
}

/**
 * LU-10（設計書 4.0.1 の K3、5.5 の 7）: 一覧の行の更新の後の照合の証拠（純粋）。変えた欄（`CHANGED`）は、開き手を押した後に読んだ前の値と送った新しい値で、
 * 一覧の画面の照合の READ（行の確かめつき）が一致したときだけ一致（ほかは照合できない null）。窓を開き直さないので、保つ欄とページが決める鍵は照合せず、証拠に
 * 入れない（送る時に Guard が前の値と照らしている）。前の値がなければ null。
 */
export const apiListRowUpdateEvidenceOf = (
  prior: ApiUpdateFieldValues | null,
  values: Readonly<Record<string, string | null>>,
  readResult: ActionRunReadVerification['result'] | null,
): WriteUpdateEvidence | null => {
  if (prior === null) {
    return null;
  }
  return updateEvidenceOfChecks(
    Object.keys(prior.changed).map((fieldName) => {
      const expected = values[fieldName] ?? null;
      return {
        fieldName, previousValue: prior.changed[fieldName] ?? '', expected, after: readResult === 'MATCHED' ? { value: expected, alsoMatched: true } : null,
      };
    }),
    [],
  );
};

// ---------------------------------------------------------------------------------------------------------------
// LU-12・LU-12b（設計書 `2026-11-02-beaksight-list-row-update-design.md` 4.0 の D2〜D5、4.0.1 の K1・K3、5.5）: フォームの一覧の行の更新（形 B）
// ---------------------------------------------------------------------------------------------------------------

/**
 * LU-12b: フォームの一覧の行の更新の、書き込みの段に渡す指定と、段の中で読んだ前の値の置き場所（メモリの中だけ。記録しない）。
 * - `spec`: 更新の form の指定（送る form の位置は、段の中で決めて足す）。
 * - `mark`: 前の値を後から入れる印（承認の時の欄の役割から作った名前の集合。`updateDeferredPriorValuesOf`。ページから作らない。LU-10 の条件 3）。
 * - `knownKeptValues`: 保つ欄ごとの台帳の最後の値（`START` の `update.knownKeptValues`）。
 * - `observed.prior`: 開き手を押した後に読み、Guard に入れた前の値（入れる前と、入れなかったときは null。後の照合の証拠に使う）。
 */
interface FormListRowStage {
  readonly spec: WriteUpdateFormSpec;
  readonly listRow: WorkerStartWriteListRow;
  readonly mark: WriteDeferredPriorValues;
  readonly knownKeptValues: readonly ApiUpdateKnownKeptValue[];
  readonly quiet: ApiUpdateQuietMemory;
  readonly observed: { prior: UpdateFormValues | null };
}

/**
 * LU-12b: フォームの一覧の行の更新の送る前の確かめ（サイトへは要求を出さない。凍結した Context の前の読み取りをしない。押すまで欄がない）。止める印、書き込みの
 * 画面（一覧の画面）の URL の事前の判定、Guard の期待の基本の部分（前の値に頼らない部分。`updateBasePayloadFieldsOf`）と前の値を後から入れる印
 * （`updateDeferredPriorValuesOf`。条件 3）を作る。保つ見える欄は、どれも台帳が知る値を持つこと（条件 1 の比べの相手。なければ比べられないので止める）。
 */
async function planFormListRowUpdateStage(
  input: PrecheckInput,
  write: WorkerStartWrite,
  update: WorkerStartWriteUpdate,
  listRow: WorkerStartWriteListRow,
): Promise<WriteStagePlan> {
  const stop = (precheckDetail: PrecheckFailureDetail): WriteStagePlan => ({ kind: 'STOP', facts: notSent(PRECHECK_FAILED, { precheckDetail }) });
  if (input.stopSignal.aborted) {
    return stop('STOPPED');
  }
  if (!isReadUrlAllowed(pageUrlOf(write.formPage), input.options.config, input.options.authentication)) {
    return stop('PAGE_UNAVAILABLE');
  }
  const spec = updateSpecOf(write, update);
  const base = updateBasePayloadFieldsOf(spec, write.values);
  const mark = updateDeferredPriorValuesOf(spec, write.values);
  if (!base.ok || !mark.ok) {
    return stop('PRIOR_VALUE_UNUSABLE');
  }
  const knownKeptValues = update.knownKeptValues ?? [];
  if (!mark.mark.keptFieldNames.every((name) => knownKeptValues.some(({ key }) => key === name))) {
    return stop('KNOWN_KEPT_VALUE_MISMATCH');
  }
  // 条件 7・9: 期待は JSON の素の値。前の値は Guard の口（`supplyFormPriorValues`）だけで入れる（照合の側の純粋な関数の結果を期待に使わない）。
  const expectation: WritePayloadExpectation = {
    request: { origin: write.request.origin, path: write.request.path, enctype: spec.enctype },
    ...base.fields,
    deferredPriorValues: mark.mark,
  };
  const formListRow: FormListRowStage = {
    spec, listRow, mark: mark.mark, knownKeptValues, quiet: { quietTimedOut: false, windows: input.watch.observationWindows }, observed: { prior: null },
  };
  // LU-SFIX4（LU-REV の I-1・I-1b。設計書 5.5 の 0）: 登録と同じ送る前の READ を、照合と同じ READ（候補の READ）と行の選び方で 1 回読む。
  const preRead = listRowPreSubmitReadStop(input, await verifyReadCheck(input.session, write.readVerification,
    { ...input.options, auditStage: input.auditStage }, { rowKeyValue: listRow.rowKeyValue }));
  if (preRead !== null) {
    return { kind: 'STOP', facts: preRead };
  }
  return { kind: 'STAGE', writeStageOf: (monitor) => formUpdateWriteStageOf(expectation, monitor, update.targetRecordId), formListRow };
}

/** LU-12b: 送る form を行で決めた位置か、決められなかった理由（入力の部品の失敗の理由の形。値を持たない）。 */
export type RowFormLocation =
  | { readonly ok: true; readonly formPath: readonly number[]; readonly submitterWords: readonly string[] }
  | { readonly ok: false; readonly reason: 'FORM_NOT_FOUND' | 'FORM_AMBIGUOUS' | 'FORM_UNREADABLE' | 'FORM_CHANGED' };

/** LU-SFIX4: 識別の digest に使わない、候補の JS の結び付き（空。識別の digest の入力は結び付きを含まない）。 */
const NO_BINDING: CandidateJsBinding = Object.freeze({ form: [], submitter: [], ancestor: [], document: [], window: [], inlineHandler: false });

/**
 * LU-SFIX4（LU-REV の I-2。設計書 5.5 の 6）: 見つけた form の、送信先を型にした識別の digest（発見と同じ部品 `listRowFormTemplatedIdentityDigestOf`）が、承認の候補の
 * digest（`START` の `update.templatedIdentityDigest`）と同じか。form の読み取りは、凍結しない probe（`probePageCandidates`。読むだけ）で、位置が `formPath` の form
 * の候補。同じなら、その候補の送信ボタンの語（承認の候補の語と同じ）を返す。違う・読めないときは理由。
 */
async function rowFormIdentityOf(page: Page, formPath: readonly number[], approvedDigest: string): Promise<RowFormLocation> {
  const probe = await probePageCandidates(page, Date.now() + DISCOVERY_READ_TIMEOUT_MS);
  // L13（N28〜N30）: probe は数と長さで切らなくなった（前は上限で読み切れなければ `FORM_UNREADABLE`）。識別の digest は全部の欄で比べる。
  if (probe.status !== 'READ') {
    return { ok: false, reason: 'FORM_UNREADABLE' };
  }
  const matching = probe.candidates.filter((candidate) => candidate.form !== null && samePathSteps(candidate.form.path, formPath));
  const [only] = matching;
  if (matching.length !== 1 || only === undefined) {
    return { ok: false, reason: 'FORM_NOT_FOUND' };
  }
  const discovered: DiscoveredCandidate = {
    page: locationOfUrl(page.url()).location, kind: only.kind, formMethod: only.formMethod, methodOverride: only.methodOverride, action: only.action,
    enctype: only.enctype, target: only.target, fields: only.fields, submitterWords: only.submitterWords, jsBinding: NO_BINDING, incompleteReasons: [],
  };
  return listRowFormTemplatedIdentityDigestOf(discovered) === approvedDigest
    ? { ok: true, formPath, submitterWords: only.submitterWords }
    : { ok: false, reason: 'FORM_CHANGED' };
}

/** 2 つの位置が同じか。 */
const samePathSteps = (left: readonly number[], right: readonly number[]): boolean =>
  left.length === right.length && left.every((step, index) => right[index] === step);

/**
 * LU-12b（LU-12-brief の 3.4）: 開き手を押した後に、送信先が台帳の番号の具体的な path（`write.request`）の form を、行の決まりを広げずに送信先で 1 つに決める。
 * ちょうど 1 つ、かつ見えていて、選んだ行（またはそのすぐ下の行。行の決まりの owner の `listRowOfFormPath`。開き手のある行は選んだ行だけとして当てる）の中に
 * あること。form が描かれるのを待つ（同じ画面を読み直すだけ。読み込みは足さない）。
 */
async function rowFormLocationOf(
  page: Page,
  write: WorkerStartWrite,
  row: ListRowReference,
  watch: WriteStageWatch,
): Promise<RowFormLocation> {
  // L12b（設計書 `2026-11-09-beaksight-remove-limits-design.md` 6.2。T26）: 待つ上限（前は 5 秒）は置かず、描かれるか、L0 の進みの見張りが
  // 終える（全く反応がない・静まらない）まで読み直す。見張りが終えたら、最後に読んだ結果を返す。
  let last: RowFormLocation = { ok: false, reason: 'FORM_NOT_FOUND' };
  const outcome = await watchProgress(async (signals) => {
    const detach = attachPageProgressSignals(page, signals);
    let previous: string | null = null;
    try {
      for (;;) {
        const located = await locateRowFormOnce(page, write, row);
        last = located;
        const key = located.ok ? 'OK' : located.reason;
        if (key !== previous) {
          previous = key;
          signals.mark('BROWSER_RESPONSE');
        }
        // 2 つ以上・読めないは、待っても 1 つにならないとみなして止める（待つのは、まだ描かれていない・見えていないときだけ）。
        if (rowFormLocationStepOf(located, { pageGone: page.isClosed() || signals.signal.aborted }) === 'DONE') {
          return located;
        }
        await wait(watch.observationWindows.write.resultPollIntervalMs);
      }
    } finally {
      detach();
    }
  }, { quietLimitMs: watch.quietLimitMs });
  return outcome.status === 'FULFILLED' ? outcome.value : last;
}

/** LU-12b: `rowFormLocationOf` の 1 回の読み取り。 */
async function locateRowFormOnce(page: Page, write: WorkerStartWrite, row: ListRowReference): Promise<RowFormLocation> {
  const rows = await readListRowPaths(page);
  const forms = await locateRowWriteForms(page, { endpoint: { origin: write.request.origin, path: write.request.path }, candidateFields: write.candidateFields });
  const candidate = rowFormCandidateOf({
    rowsRead: rows.status === 'READ',
    forms: forms.status === 'READ' ? forms.forms : null,
    inSelectedRow: (formPath) => rows.status === 'READ'
      && listRowOfFormPath(rows.rows, formPath, (listed) => samePathSteps(listed.path, row.path)) !== null,
  });
  if (!candidate.ok) {
    return candidate;
  }
  // LU-SFIX4（LU-REV の I-2）: 送信先で 1 つに決めた form が、承認の候補と同じ識別か（送信ボタンの語を含む）。
  return rowFormIdentityOf(page, candidate.formPath, write.update?.templatedIdentityDigest ?? '');
}

/**
 * LU-12b: 開き手を押した後に読んだ前の値から、Guard の口に入れる前の値（BeakSight が作った素の一覧と素の文字列だけ。条件 1）。保つ見える欄は台帳の値
 * （読んだ値と同じことを先に確かめる）、値を照らす hidden と組は読んだ値。名前は印のとおり（ページから足さない）。組の hidden の値がなければ null。
 */
const formSuppliedPriorValuesOf = (
  mark: WriteDeferredPriorValues,
  prior: UpdateFormValues,
  knownKeptValues: readonly ApiUpdateKnownKeptValue[],
): WriteSuppliedPriorValues | null => {
  const keptFields: { name: string; value: string | null }[] = [];
  for (const name of mark.keptFieldNames) {
    const known = knownKeptValues.find(({ key }) => key === name);
    if (known === undefined) {
      return null;
    }
    keptFields.push({ name, value: known.value });
  }
  const checkedPassthroughFields = mark.checkedPassthroughNames.map((name) => ({
    name,
    value: Object.hasOwn(prior.stateHiddenValues, name) ? prior.stateHiddenValues[name] ?? null : prior.passthroughValues[name] ?? null,
  }));
  const checkboxPairs: { name: string; offValue: string; checkedValue: string | null }[] = [];
  const pairs = [
    ...mark.keptCheckboxPairNames.map((name) => ({ name, checkedValue: prior.fields[name] ?? null })),
    ...mark.changedCheckboxPairs.map(({ name, checkedValue }) => ({ name, checkedValue })),
  ];
  for (const { name, checkedValue } of pairs) {
    const offValue = prior.pairOffValues[name];
    if (offValue === undefined) {
      return null;
    }
    checkboxPairs.push({ name, offValue, checkedValue });
  }
  return { keptFields, checkedPassthroughFields, checkboxPairs };
};

/**
 * LU-12b（設計書 5.5 の 1〜6。LU-10 の条件 1・2・6・8 をフォームの形に当てる）: フォームの一覧の行の更新の書き込みの段の本体（Context を開いた後、閉じる前）。
 * 窓を開く前（N2）に:
 * 1. 一覧の画面を 1 回読む（GET）。
 * 2. 行を選ぶ値を含む行を探す（API の形と同じ `settledListRowOf`）。ちょうど 1 つでなければ送らない（`ROW_NOT_UNIQUE`）。
 * 3. 行の中の開き手を 1 回押す（API の形と同じ `pressListRowOpener`。押せなければ同じ写し方で止める）。
 * 4. 送信先が台帳の番号の form を、送信先で 1 つに決める（`rowFormLocationOf`。違えば `FORM_NOT_READY`。入力の失敗の理由に `FORM_NOT_FOUND` などを残す）。
 * 5. その form の前の値を読み（`readUpdateFormValues`）、保つ見える欄が台帳の最後の値と同じときだけ（違えば `KNOWN_KEPT_VALUE_MISMATCH`）、Guard に 1 回入れる
 *    （`supplyFormPriorValues`。受けなければ窓を開かずに `PRIOR_VALUES_NOT_ACCEPTED`）。変える欄の前の値が長すぎれば `PRIOR_VALUE_UNUSABLE`。
 * そのあとは今のフォームの更新の流れ（`inspectUpdateForm` → 入れる → 窓を開く → 押す）。窓を開いた後に読み取りでない要求が出たら、今の N1 のとおり押さない。
 */
async function formListRowWriteOnStage(
  input: WriteStageInput,
  write: WorkerStartWrite,
  update: WorkerStartWriteUpdate,
  stage: FormListRowStage,
): Promise<WriteStageResult> {
  const { request, monitor, page } = input;
  const { stopSignal } = request;
  const counter = new InFlightRequestCounter(page);
  try {
    const opened = await openWriteStagePage(input, write.formPage);
    if (opened !== null) {
      return opened;
    }
    if (stopSignal.aborted) {
      return precheckStopped('STOPPED');
    }
    const found = await settledListRowOf(page, stage.listRow.rowKeyValue, counter, stage.quiet);
    if (found.status !== 'READ') {
      return precheckStopped('PAGE_UNAVAILABLE');
    }
    if (found.row === null) {
      return precheckStopped('ROW_NOT_UNIQUE');
    }
    const present = await rowValuePresenceStopOf(page, found.row, write.readVerification);
    if (present !== null) {
      return precheckStopped(present);
    }
    if (stopSignal.aborted) {
      return precheckStopped('STOPPED');
    }
    const pressed = await pressListRowOpener(page, found.row, stage.listRow.openerIdentityDigest);
    if (pressed !== 'PRESSED') {
      return precheckStopped(LIST_ROW_PRESS_STOP_DETAILS[pressed]);
    }
    const location = await rowFormLocationOf(page, write, found.row, input.watch);
    if (!location.ok) {
      return precheckStopped('FORM_NOT_READY', formInputFailureOf('INSPECT', { reason: location.reason }));
    }
    // LU-SFIX4: 押す時点の確かめに、承認の候補の送信ボタンの語を渡す（識別の digest で同じことを確かめた語）。
    const { submitterWords } = location;
    const spec: WriteUpdateFormSpec = {
      ...stage.spec, formPath: location.formPath, submitterFactsAccepted: (facts) => pressTimeWordsMatchApproved(facts, submitterWords),
    };
    const read = await readUpdateFormValues(page, spec);
    if (!read.ok) {
      return precheckStopped('FORM_NOT_READY', formInputFailureOf('INSPECT', read));
    }
    const prior = read.values;
    if (!keptValuesMatchLedger(prior.fields, stage.mark.keptFieldNames, stage.knownKeptValues)) {
      return precheckStopped('KNOWN_KEPT_VALUE_MISMATCH');
    }
    const supplied = formSuppliedPriorValuesOf(stage.mark, prior, stage.knownKeptValues);
    if (supplied === null || !priorValuesRecordable(update, prior)) {
      return precheckStopped('PRIOR_VALUE_UNUSABLE');
    }
    if (stopSignal.aborted) {
      return precheckStopped('STOPPED');
    }
    // 条件 2: Guard が受けなければ、窓を開かずに止める（照合が止めることだけに頼らない）。
    if (!monitor.supplyFormPriorValues(supplied)) {
      return precheckStopped('PRIOR_VALUES_NOT_ACCEPTED');
    }
    stage.observed.prior = prior;
    const inspection = await inspectUpdateForm(page, spec, prior);
    if (!inspection.ok || stopSignal.aborted) {
      return inspection.ok || stopSignal.aborted ? precheckStopped('STOPPED') : precheckStopped('PRIOR_VALUE_CHANGED', formInputFailureOf('INSPECT', inspection));
    }
    return await formWriteFillAndPress(input, write, inspection.form);
  } finally {
    counter.dispose();
  }
}

/**
 * LU-12b（設計書 4.0.1 の K3、5.5 の 7）: フォームの一覧の行の更新の後の照合の証拠（純粋）。変えた欄だけ（API の形と同じ `apiListRowUpdateEvidenceOf`。前の値の
 * ない checkbox などは空の値）。前の値がなければ null。
 */
const formListRowUpdateEvidenceOf = (
  prior: UpdateFormValues | null,
  update: WorkerStartWriteUpdate,
  values: Readonly<Record<string, string | null>>,
  readResult: ActionRunReadVerification['result'] | null,
): WriteUpdateEvidence | null => {
  if (prior === null) {
    return null;
  }
  const changed: Record<string, string> = {};
  for (const name of update.changedFieldNames) {
    changed[name] = prior.fields[name] ?? '';
  }
  return apiListRowUpdateEvidenceOf({ changed, kept: {}, page: {} }, values, readResult);
};

/** 書き込みの段の結果（Context を閉じる前に読んだもの）。 */
interface WriteStageResult {
  readonly clicked: boolean;
  readonly precheckFailed: boolean;
  readonly httpStatus: number | null;
  readonly responseJudgement: ResponseJudgement | null;
  readonly rawRecordId: string | null;
  readonly submittedAt: Date | null;
  /** T32e: 結果の判定を終えた時刻（判定まで進まなければ null）。 */
  readonly judgedAt: Date | null;
  readonly sessionLostUrl: string | null;
  /** T44e（Task 44 の設計書 P2-4）: 送らずに止めたときの具体的な理由（分かったときだけ）。 */
  readonly precheckDetail?: PrecheckFailureDetail;
  /** OP-O（O1）: 確かめ・入力・押す操作の失敗（値と、値の長さを含まない。分かったときだけ）。 */
  readonly inputFailure?: ActionEvidenceInputFailure;
  /**
   * PL-6a: form の、送った後の画面の観察（応答を受け、307・308、応答を返せなかった、セッションの切れのどれでもないときだけ）。このときの結果の判定は、
   * 書き込みの段を閉じた後に、照合（登録の答え合わせの READ、更新の後の照合）と合わせて `formResultJudgementOf` で決める（`responseJudgement` は null）。
   */
  readonly formFacts?: FormResultPageFacts | null;
}

/** PL-6a: form の、送った後の画面の観察（値は持たない）。 */
interface FormResultPageFacts {
  readonly httpStatus: number;
  readonly sameForm: boolean;
  readonly sameFormKeptValues: boolean;
  /** 送った後の URL から取った ID（記録してよい値だけ。`recordableRecordIdOf`）。 */
  readonly recordId: string | null;
}

/**
 * T44e: 送らずに止めた書き込みの段の結果に、具体的な理由を付ける（送る・送らないは `PRECHECK_STOPPED` のまま）。OP-O（O1）: 確かめ・入力・押す操作の失敗の
 * 記録（`inputFailure`）も、分かれば添える。
 */
const precheckStopped = (precheckDetail: PrecheckFailureDetail, inputFailure?: ActionEvidenceInputFailure): WriteStageResult =>
  Object.freeze({ ...PRECHECK_STOPPED, precheckDetail, ...(inputFailure === undefined ? {} : { inputFailure }) });

/** OP-O（O1）: 入力の部品が返した失敗（理由の語と、分かった細目。値と、値の長さは持たない）。 */
interface InputPartFailure {
  readonly reason: string;
  readonly fieldIndex?: number;
  readonly field?: WriteInputFieldFacts;
  readonly valueChange?: WriteInputValueChange;
}

/**
 * OP-O（O1）: 入力の部品の失敗を、`action-evidence.json` の `precheck.inputFailure` の形にする（理由と欄の種類は閉じた一覧の値だけ。外れれば記録しない・
 * 種類は null）。値と、値の長さは持たない。
 */
const inputFailureOf = (stage: WriteInputFailureStage, failure: InputPartFailure): ActionEvidenceInputFailure | undefined => {
  if (!(WRITE_INPUT_FAILURE_REASONS as readonly string[]).includes(failure.reason)) {
    return undefined;
  }
  const type = failure.field?.type ?? null;
  return Object.freeze({
    stage,
    reason: failure.reason as WriteInputFailureReason,
    fieldPosition: failure.fieldIndex ?? null,
    fieldType: type !== null && (CANDIDATE_FIELD_TYPES as readonly string[]).includes(type) ? type as CandidateFieldType : null,
    fieldAttributes: failure.field?.attributes ?? null,
    valueChange: failure.valueChange ?? null,
  });
};

/** OP-O（O1）: form の入力の部品の失敗を、記録の形にする（`VALUE_NOT_APPLIED` は欄の位置・型・変わり方の区分も。属性は読まないので null）。 */
const formInputFailureOf = (
  stage: WriteInputFailureStage,
  failure: { readonly reason: string; readonly valueDetail?: { readonly fieldIndex: number; readonly fieldType: string; readonly valueChange?: WriteInputValueChange } },
): ActionEvidenceInputFailure | undefined => inputFailureOf(stage, {
  reason: failure.reason,
  ...(failure.valueDetail === undefined
    ? {}
    : {
      fieldIndex: failure.valueDetail.fieldIndex,
      field: { type: failure.valueDetail.fieldType, attributes: null },
      ...(failure.valueDetail.valueChange === undefined ? {} : { valueChange: failure.valueDetail.valueChange }),
    }),
});

const PRECHECK_STOPPED: WriteStageResult = Object.freeze({
  clicked: false,
  precheckFailed: true,
  httpStatus: null,
  responseJudgement: null,
  rawRecordId: null,
  submittedAt: null,
  judgedAt: null,
  sessionLostUrl: null,
});

/** 書き込みの段で使うもの。 */
interface WriteStageInput {
  readonly request: WriteCreateRunRequest;
  /** REV-RB8911 M-3: 押した時刻を、段の外の入れ物に知らせる（`WriteStageRequest.onPressed`）。 */
  readonly onPressed: (at: Date) => void;
  /** REV-RB8911 M-6: 見張りの指定と観察の窓の一式（`writeStageWatchOf` で段を開くときに 1 回だけ求める）。 */
  readonly watch: WriteStageWatch;
  readonly factory: BrowserContextFactory;
  readonly pacer: NavigationPacer;
  readonly monitor: WriteStageMonitor;
  readonly context: BrowserContext;
  readonly page: Page;
  readonly ledger: SafetyLedger;
  /** T31g-2: UPDATE の指定と前の値（CREATE は undefined）。 */
  readonly update?: UpdateStage | undefined;
  /** T41d: API の更新の前の値と指定（API の登録と form は undefined）。 */
  readonly apiUpdate?: ApiUpdateStage | undefined;
  /** T37a fix round 1: ジョブの監査の段の状態（口がなければ `null`）。押す直前に、鍵の消失と上限を確かめる。 */
  readonly auditStage: AuditStageRunState | null;
  /** PL-6a: form の、送るフォームの形の鍵（送る前の画面の確かめで、承認した候補から求めた `formShapeKeyOf`。API は undefined）。 */
  readonly formShapeKey?: string | undefined;
  /** LU-12b: フォームの一覧の行の更新の指定（`START` の `update.listRow` のある form の更新だけ）。 */
  readonly formListRow?: FormListRowStage | undefined;
}

/**
 * T37a fix round 1（Task 37 の設計書 3.1 の「書き込みのジョブ」）: 送らずに止めるべき監査の段の事実があるか。ログインの状態の鍵がなくなった
 * （`sessionKeyLostDetailOf`。Run Coordinator・発見・READ の確かめと同じ共通の部品。LZ-3c: 承認したサービスの Origin への要求の上限の確かめは、
 * L11 から届かないので捨てた）。鍵の消失は、factory が Context を閉じるときに状態を読み直して知らせるので、今の書き込みの段の Context の中で消えた
 * 鍵は、押す前には見えない（前の Context までの分）。状態がなければ偽。
 */
const auditStageStopsWrite = (state: AuditStageRunState | null): boolean =>
  sessionKeyLostDetailOf(state) !== null;

/**
 * 書き込みの段の本体（ファイルの先頭の 4〜6。Context を開いた後、閉じる前）。例外は呼ぶ側が受ける（送ったかは Guard の送信の報告で決める）。
 */
async function writeOnStage(input: WriteStageInput, write: WorkerStartWrite): Promise<WriteStageResult> {
  const { request, page } = input;
  const { stopSignal } = request;
  // LU-12b: フォームの一覧の行の更新は、窓の前に行を探して開き手を押し、前の値を Guard に入れてから、今の流れで入れて押す（`formListRowWriteOnStage`）。
  if (input.formListRow !== undefined && write.update !== undefined) {
    return formListRowWriteOnStage(input, write, write.update, input.formListRow);
  }
  const spec = formSpecOf(write);
  const opened = await openWriteStagePage(input, write.formPage);
  if (opened !== null) {
    return opened;
  }
  // T31g-2: UPDATE は、書き込みの画面の値が前の値と同じかも確かめる（`inspectUpdateForm`）。
  const inspection = input.update === undefined ? await inspectWriteForm(page, spec) : await inspectUpdateForm(page, input.update.spec, input.update.prior);
  if (!inspection.ok || stopSignal.aborted) {
    // T44e: 更新の確かめの失敗は、書き込みの画面の値が前の値と違う（`inspectUpdateForm`）。登録は入力の前の確かめの失敗。
    // OP-O（O1）: 確かめの失敗の段と理由を残す（止める印のときは残さない）。
    return inspection.ok || stopSignal.aborted
      ? precheckStopped('STOPPED')
      : precheckStopped(input.update === undefined ? 'FORM_NOT_READY' : 'PRIOR_VALUE_CHANGED', formInputFailureOf('INSPECT', inspection));
  }
  return formWriteFillAndPress(input, write, inspection.form);
}

/**
 * form の書き込みの段の、確かめた form に値を入れて押し、結果を判定する（LU-12b で取り出した。今の登録・更新とフォームの一覧の行の更新が共有する）。値を入れて
 * 窓の中を確かめ、押す直前の確かめの後に押す。
 */
async function formWriteFillAndPress(input: WriteStageInput, write: WorkerStartWrite, form: InspectedWriteForm): Promise<WriteStageResult> {
  const { request, monitor, page } = input;
  const filled = await fillWriteForm(page, form, write.values, monitor);
  if (!filled.ok) {
    return precheckStopped('FORM_NOT_READY', formInputFailureOf('FILL', filled));
  }
  const quiet = await submissionWindowDetailOf(input);
  if (quiet !== null) {
    return precheckStopped(quiet);
  }
  // main frame の文書の応答（押した後の、POST と redirect の先の応答）を、押す前から記録する。
  const documentStatuses: number[] = [];
  const onResponse = (response: Response): void => {
    try {
      if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) {
        documentStatuses.push(response.status());
      }
    } catch {
      // 読めない応答は記録しない。
    }
  };
  page.on('response', onResponse);
  // T30R2-fix-1（M-b）: 押した後に、main frame の POST のナビゲーションの要求がブラウザで失敗したか（ファイルの先頭の 5）。
  let postNavigationFailed = false;
  const onRequestFailed = (failed: Request): void => {
    try {
      if (failed.method().toLowerCase() === FORM_POST_METHOD && failed.isNavigationRequest() && failed.frame() === page.mainFrame()) {
        postNavigationFailed = true;
      }
    } catch {
      // 読めない要求は数えない（Guard の `responseDeliveryCanceled` でも見る）。
    }
  };
  page.on('requestfailed', onRequestFailed);
  // PL-6a: 送った後の画面の落ち着きの待ちに使う、進行中の要求の数え方（押す前に作る。POST と redirect の先の読み込みを数える。ページに何もしない）。
  let counter: InFlightRequestCounter | null = null;
  try {
    const notReady = await readyToPress(input);
    if (notReady !== null) {
      return precheckStopped(notReady);
    }
    // PL-6a（設計書 8.1 の「判定の順」の 2）: 押す直前の URL（記録しない）。送った後の URL から取った ID が、この URL を同じ型に当てた値と同じか、URL が
    // 変わっていなければ、ID として使わない（T40R-fix-A2 の決まりを、URL の型の判定 `recordIdOfResultUrl` に移した）。
    const beforeUrl = page.url();
    counter = new InFlightRequestCounter(page);
    const submittedAt = request.clock();
    input.onPressed(submittedAt);
    const submitted = await submitWriteForm(page, form, write.values, undefined, request.observationWindows);
    if (!submitted.ok && !submitted.clickAttempted) {
      return precheckStopped('FORM_NOT_READY', formInputFailureOf('SUBMIT', submitted));
    }
    const judged = await judgeFormResult(input, write, documentStatuses, () => postNavigationFailed, { counter, beforeUrl });
    // T32e: 判定の時刻は、判定を終えた時点の時計（報告の `response.judgedAt`）。PL-6a: 構造の判定は、照合の後に時刻を決め直す。
    return { clicked: true, precheckFailed: false, submittedAt, judgedAt: request.clock(), ...judged };
  } finally {
    counter?.dispose();
    page.off('response', onResponse);
    page.off('requestfailed', onRequestFailed);
  }
}

/**
 * 書き込みの段の中で、書き込みの画面を 1 回読む（form と API で共通。T40b-1 で取り出した）。セッションが切れた、読み込みが失敗した・4xx・5xx なら、
 * 送らずに止める結果を返す。続けてよければ null。
 */
async function openWriteStagePage(input: WriteStageInput, formPage: CandidateLocation): Promise<WriteStageResult | null> {
  const { request, pacer, page, ledger } = input;
  const { config, authentication } = request;
  await pacer.beforeNavigation();
  const navigation = await navigatePage(page, pageUrlOf(formPage), {
    timeoutMs: config.crawl.navigationTimeoutMs,
    ledger,
    allowedQueryParameters: new Set(config.crawl.allowedQueryParameters),
  });
  const lostBeforeWrite = sessionLostUrlOf(page, ledger, authentication.sessionLostPathPrefix);
  if (lostBeforeWrite !== null) {
    return { ...precheckStopped('SESSION_LOST'), sessionLostUrl: lostBeforeWrite };
  }
  // 書き込みの画面の読み込みの 4xx・5xx は、送らない。
  if (navigation.navigationOutcome !== 'OK' || isHttpStatusInRange(navigation.httpStatus, ERROR_HTTP_STATUS_RANGE)) {
    return precheckStopped('PAGE_UNAVAILABLE');
  }
  return null;
}

/**
 * 値を入れた後、送信の窓の長さ（観察の窓の一式の `write.submissionWindowSettleMs`。自動ログインの送信の窓と同じ考え方）だけ待ち、送信の窓の中で承認の送信の
 * ほかの要求を止めていない（ページが入力の値を別の要求で送ろうとしていない）、止める印もないか（form と API で共通。T40b-1 で取り出した）。押してよければ null。
 * 待つのは、ページの JS が値の入力の事象で出そうとした要求を、Guard が送信の窓の中で止めて数えるのを待つため。
 * T44e（Task 44 の設計書 P2-4）: 押さないときは、具体的な理由（承認のほかの要求が出た、止める印）を返す（前は真偽だけ。確かめは同じ）。RB-11: 判定は
 * `submissionWindowVerdictOf`。
 */
async function submissionWindowDetailOf(input: WriteStageInput): Promise<PrecheckFailureDetail | null> {
  await wait(input.watch.observationWindows.write.submissionWindowSettleMs);
  return submissionWindowVerdictOf({ unexpectedRequestCount: input.monitor.unexpectedRequestCount(), stopped: input.request.stopSignal.aborted });
}

/**
 * 押す直前の確かめ（form と API で共通。T40b-1 で取り出した）。押す前の最後の読み込みの間隔を守り、止める印 → 監査の段 → 送る直前の確かめ直し（IPC の
 * 往復）→ 止める印と監査の段、の順に確かめる。押してよければ真。
 * T30R-fix-1（DEF-103）: 最後の待ちの後に止める印を確かめ、送る直前の確かめ直しをしてから押す（その間に待ちと読み込みを入れない）。
 * T37a fix round 1: 押す直前（確かめ直しの前と後）に、鍵の消失と上限を確かめる（書き込みの段の読み込みで上限に届いた回を含む）。
 * T41R-fix-2（Task 41 の設計書 8 章の「T41R-fix の報告（設計者の判断）」）: 確かめ直しの前に差し込む確かめ（`beforeRecheck`。API の更新の、押す直前の欄の
 * 読み直し。待ちを含んでよい）を受ける。順は、最後の待ち → 止める印と監査の段 → `beforeRecheck` → 止める印と監査の段 → 確かめ直し → 止める印と監査の段。
 * 確かめ直しの後には待ちを入れない（DEF-103 の決まり）。省略（form と API の登録）は今までどおりの順。
 */
async function readyToPress(
  input: WriteStageInput,
  beforeRecheck?: () => Promise<PrecheckFailureDetail | null>,
): Promise<PrecheckFailureDetail | null> {
  const { request, pacer } = input;
  const { stopSignal } = request;
  // T44e（Task 44 の設計書 P2-4）: 押さないときは、具体的な理由を返す（押してよければ null。確かめの順と、押す・押さないは今のまま）。
  const stopOrAuditStage = (): PrecheckFailureDetail | null => {
    if (stopSignal.aborted) {
      return 'STOPPED';
    }
    return auditStageStopsWrite(input.auditStage) ? 'AUDIT_STAGE_STOPPED' : null;
  };
  await pacer.beforeNavigation();
  const first = stopOrAuditStage();
  if (first !== null) {
    return first;
  }
  if (beforeRecheck !== undefined) {
    const reread = await beforeRecheck();
    if (reread !== null) {
      return reread;
    }
    const afterReread = stopOrAuditStage();
    if (afterReread !== null) {
      return afterReread;
    }
  }
  const recheck = await request.recheck();
  if (!recheck.allowed) {
    return 'RECHECK_REFUSED';
  }
  return stopOrAuditStage();
}

/**
 * T40b-1: API の書き込みの段の本体（ファイルの先頭の T40b-1。Context を開いた後、閉じる前）。書き込みの画面を 1 回読み、入力の前の確かめ、値を入れて
 * 窓の中を確かめ、押す直前の確かめの後に押して、結果を判定する。例外は呼ぶ側が受ける（送ったかは Guard の送信の報告で決める）。
 */
async function apiWriteOnStage(input: WriteStageInput, write: WorkerStartApiWrite): Promise<WriteStageResult> {
  const { apiUpdate } = input;
  if (apiUpdate === undefined) {
    return apiWriteOnOpenedStage(input, write, undefined);
  }
  // T41R-fix（(1)）: 更新は、画面を読み込む前に進行中の要求の数え方を作り、欄の値の読み取りの落ち着きに使う（ページに何もしない。事象を受けるだけ）。
  const counter = new InFlightRequestCounter(input.page);
  try {
    // LU-10: 一覧の行の更新は、窓の前に行を探して開き手を押し、前の値を Guard に入れてから、今の流れで入れて押す（`apiListRowWriteOnStage`）。
    return apiUpdate.listRow === undefined
      ? await apiWriteOnOpenedStage(input, write, { apiUpdate, counter })
      : await apiListRowWriteOnStage(input, write, apiUpdate, apiUpdate.listRow, counter);
  } finally {
    counter.dispose();
  }
}

/** T40b-1・T41d: API の書き込みの段の本体の続き（更新は前の値と、進行中の要求の数え方を受ける）。 */
async function apiWriteOnOpenedStage(
  input: WriteStageInput,
  write: WorkerStartApiWrite,
  update: { readonly apiUpdate: ApiUpdateStage; readonly counter: QuietSource } | undefined,
): Promise<WriteStageResult> {
  const { request, page } = input;
  const opened = await openWriteStagePage(input, write.formPage);
  if (opened !== null) {
    return opened;
  }
  const apiUpdate = update?.apiUpdate;
  // T41d（Task 41 の設計書 3.4 の 2）: 更新は、開き直した画面の欄の値が前の読み取りの値と同じか確かめ（違えば送らない）、送信の要素は前の読み取りで
  // 見た具体的な画面の候補の識別で探す。
  if (update !== undefined) {
    const current = await readApiUpdateFieldValues(page, write, update.counter, update.apiUpdate.quiet);
    if (current === null) {
      return precheckStopped('PAGE_UNAVAILABLE');
    }
    if (!sameApiUpdateFieldValues(current, update.apiUpdate.prior)) {
      return precheckStopped('PRIOR_VALUE_CHANGED');
    }
  }
  const spec = apiInputSpecOf(write);
  // OP-L（L1）: 書き込みの段で開き直した画面でも、SPA が欄を後から描くのを、上限の中で待ってから確かめる（入れる・押す前。読み込みは足さない）。
  const inspection = await inspectApiWriteInputWhenRendered(page, apiUpdate === undefined ? spec : { ...spec, submitterIdentityDigest: apiUpdate.submitterIdentityDigest },
    undefined, input.watch);
  if (!inspection.ok || request.stopSignal.aborted) {
    // OP-O（O1）: 確かめの失敗の段・理由・欄の事実を残す（止める印のときは残さない）。
    return inspection.ok || request.stopSignal.aborted ? precheckStopped('STOPPED') : precheckStopped('FORM_NOT_READY', inputFailureOf('INSPECT', inspection));
  }
  return apiWriteFillAndPress(input, write, inspection.input, update);
}

/**
 * T40b-1・T41d: API の書き込みの段の、確かめた入力に値を入れて押し、結果を判定する（LU-10 で取り出した。今の登録・更新と一覧の行の更新が共有する）。値を入れて
 * 窓の中を確かめ、押す直前の確かめ（更新は欄の読み直しつき）の後に押す。
 */
async function apiWriteFillAndPress(
  input: WriteStageInput,
  write: WorkerStartApiWrite,
  inspected: InspectedApiWriteInput,
  update: { readonly apiUpdate: ApiUpdateStage; readonly counter: QuietSource } | undefined,
): Promise<WriteStageResult> {
  const { request, monitor, page } = input;
  const apiUpdate = update?.apiUpdate;
  const filled = await fillApiWriteInput(page, inspected, monitor, undefined, input.watch);
  if (!filled.ok) {
    return precheckStopped('FORM_NOT_READY', inputFailureOf('FILL', filled));
  }
  const quiet = await submissionWindowDetailOf(input);
  if (quiet !== null) {
    return precheckStopped(quiet);
  }
  // T41R-fix（(3)）・T41R-fix-2: 更新は、押す直前の確かめの中で、送る直前の確かめ直しの前に欄を読み直し（落ち着きの待ちを含む）、保つ欄とページが決める鍵の
  // 欄が前の値のまま、変える欄が入れた生成した値のままでなければ押さない（確かめ直しの後には待ちを入れない。DEF-103）。読み直しの後にページが値を変えても、
  // 送る瞬間に Guard が前の値と照らして止める。
  // T41R3-fix（(2)）: 読み直しでも、台帳が知る保つ鍵の値と違えば押さない（前の値は台帳の値と同じと確かめてあるので、前の値との比べでも止まる。明示して
  // 確かめる）。
  const beforeRecheck = update === undefined
    ? undefined
    : async (): Promise<PrecheckFailureDetail | null> => {
      const current = await readApiUpdateFieldValues(page, write, update.counter, update.apiUpdate.quiet);
      // T44e: 押さない条件は今のまま（前の値・入れた値と違う、または台帳が知る保つ鍵の値と違う）。理由は、前の値と違う → 台帳の値と違う、の順。
      if (!apiUpdateReadyToPress(update.apiUpdate.prior, current, write.values) || current === null) {
        return 'PRIOR_VALUE_CHANGED';
      }
      return apiUpdateKnownKeptMismatch(current, update.apiUpdate.knownKeptValues) ? 'KNOWN_KEPT_VALUE_MISMATCH' : null;
    };
  const notReady = await readyToPress(input, beforeRecheck);
  if (notReady !== null) {
    return precheckStopped(notReady);
  }
  // T40R-fix-A（Task 40 の設計書 7 章の T40R の I-2）: ID を画面から取る形では、押す直前に、同じ取り方で今の画面から値を読む（記録しない。押した後に同じ値
  // なら ID として使わない）。T41d: 更新は対象の ID が決まっているので読まない。
  const source = apiUpdate === undefined ? apiRecordIdSourceOf(write) : null;
  const baseline = source?.kind === 'PAGE' ? await pageRecordIdBaselineOf(page, source.spec, input.watch.observationWindows) : null;
  const submittedAt = request.clock();
  input.onPressed(submittedAt);
  const submitted = await submitApiWriteInput(page, inspected, undefined, input.watch);
  if (!submitted.ok && !submitted.clickAttempted) {
    return precheckStopped('FORM_NOT_READY', inputFailureOf('SUBMIT', submitted));
  }
  const judged = await judgeApiResult(input, write, baseline);
  return { clicked: true, precheckFailed: false, submittedAt, judgedAt: request.clock(), ...judged };
}

/** T40R-fix-A: 押す直前の画面から、画面の ID の取り方で読んだ値と URL（メモリの中だけ。記録しない。T40R-fix-A2 から form の書き込みも使う）。 */
interface PageRecordIdBaseline {
  readonly recordId: string | null;
  readonly url: string;
}

/** T40R-fix-A: 押す直前の画面の、ID の取り方で読んだ値と URL（`recordIdOf` と同じ取り方。読めなければ値は null）。 */
async function pageRecordIdBaselineOf(page: Page, spec: ScenarioRecordIdSpec, windows: ObservationWindows): Promise<PageRecordIdBaseline> {
  return { recordId: await recordIdOf(page, spec, windows), url: page.url() };
}

/**
 * T40R-fix-A（T40R の I-2）: 押した後に画面から取れた値を、ID として使えるか。押す前の画面から同じ取り方で取れた値と同じなら使わない（例: 登録の画面の
 * path 自身が ID の型に当たる）。URL の型の取り方では、URL が押す前から変わっていないときも使わない。
 */
const isPageRecordIdNew = (recordId: string | null, baseline: PageRecordIdBaseline | null, spec: ScenarioRecordIdSpec, url: string): recordId is string =>
  recordId !== null && baseline !== null && recordId !== baseline.recordId && (spec.source !== 'URL_PATH_PATTERN' || url !== baseline.url);

/** 押した後の結果の判定の結果（form と API で共通）。 */
interface JudgedWriteResult {
  readonly httpStatus: number | null;
  readonly responseJudgement: ResponseJudgement | null;
  readonly rawRecordId: string | null;
  readonly sessionLostUrl: string | null;
}

/** 判定なし（送らなかった、応答がない、応答が分からない）。 */
const NOT_JUDGED: JudgedWriteResult = Object.freeze({ httpStatus: null, responseJudgement: null, rawRecordId: null, sessionLostUrl: null });

/**
 * Guard が送らなかったと決まった（送る中身の照合で止めた、Guard が Context を閉じた（違反。送っていない）、送り手が書く前に止まった（DEF-099 fix））か、
 * 送り手が書いた後に応答がなかった（届いたかは分からない。待たずに判定なしで終える）か（form と API で共通。T40b-1 で取り出した）。
 */
const submissionEndedWithoutResponse = (input: WriteStageInput): boolean => submissionEndedWithoutResponseOf(input.monitor.submissionReport(), {
  payloadBlocked: payloadBlocked(input.monitor), guardClosed: isPassiveRequestGuardClosed(input.context),
});

/**
 * T40b-1: API の書き込みの、押した後の結果の判定（ファイルの先頭の T40b-1）。L12b: 応答を期限なしで待ち（`waitForWriteResponse`）、ページが静まるまで待つ
 * （`settleAfterPress`）。以下の「期限まで待つ」は、静まった後の 1 回の読み取りに替えた。送り手が応答を受けたら、
 * 状態が範囲の外なら判定なし、ID を画面から取る形で応答をブラウザに返せなかった（Guard の `responseDeliveryCanceled`。form と同じ部品）なら
 * `RESPONSE_NOT_DELIVERED`、成功でなければその判定、成功ならセッションの切れを見てから ID を取る（画面から取るときは、押す前の画面の値（`baseline`）と
 * 違う値だけを、期限まで待つ。T40R-fix-A）。
 * ページの事象（`response`・`requestfailed`）では届いたかを決めない: Guard が送り手の応答で満たした要求には Playwright の `response` が出ず、空の本文の
 * 応答はページに届いた後にも `requestfailed`（`ERR_ABORTED`）が出る（T40b-1 の実験）。
 */
async function judgeApiResult(input: WriteStageInput, write: WorkerStartApiWrite, baseline: PageRecordIdBaseline | null): Promise<JudgedWriteResult> {
  const { monitor, page, ledger, request } = input;
  const { authentication } = request;
  const { apiUpdate } = input;
  // T41d: 更新は、ID を応答の本文から読む（画面からは取らない。応答をページに返せなかった印でも止めない）。
  const source = apiUpdate === undefined ? apiRecordIdSourceOf(write) : null;
  // L12b（T27）: 応答を期限なしで待つ（L0 の見張りで包む）。
  if (await waitForWriteResponse(input) !== 'RESPONDED') {
    return NOT_JUDGED;
  }
  // L12b（L12a の限界 3）: 応答の後にページが出す送信と画面の変化が静まるまで待ってから、結果を決める（Context を閉じるのは、この後）。
  await settleAfterPress(page, request);
  const { httpStatus, responseJudgement } = apiResponseFactsOf(monitor.submissionReport());
  if (httpStatus === null || responseJudgement === null) {
    return NOT_JUDGED;
  }
  const judged = (judgement: ResponseJudgement, rawRecordId: string | null = null, sessionLostUrl: string | null = null): JudgedWriteResult =>
    Object.freeze({ httpStatus, responseJudgement: judgement, rawRecordId, sessionLostUrl });
  // T40R-fix-A（T40R の I-2 の (c)）: ID を画面から取る形で、応答をページに返せなかった（Guard の `responseDeliveryCanceled`。form と同じ部品）なら、
  // 判定せず ID も取らない（`RESPONSE_NOT_DELIVERED`）。応答の本文から ID を取る形は、送り手が受けた応答で決まるので、この印では止めない。
  if (source?.kind === 'PAGE' && monitor.snapshot().responseDeliveryCanceled) {
    return judged('RESPONSE_NOT_DELIVERED');
  }
  if (responseJudgement !== 'SUCCESS') {
    return judged(responseJudgement);
  }
  const lost = sessionLostUrlOf(page, ledger, authentication.sessionLostPathPrefix);
  if (lost !== null) {
    return judged('SESSION_LOST', null, lost);
  }
  if (apiUpdate !== undefined) {
    // T41d（Task 41 の設計書 3.4 の 3）: 空の一覧は更新した行がない、2 行以上の一覧は 2 行以上を更新した（T41R-fix）、本文の ID が対象と違えばその ID、
    // ほかは対象の ID（`apiUpdateResultOf`）。
    const result = apiUpdateResultOf({
      responseJudgement, targetRecordId: apiUpdate.targetRecordId, bodyRecordId: monitor.apiWriteRecordId(), rowCount: apiUpdate.response.rowCount,
      bodyUnreadable: apiUpdate.response.bodyUnreadable,
    });
    return judged(result.responseJudgement, result.rawRecordId);
  }
  if (source?.kind !== 'PAGE') {
    return judged('SUCCESS', source === null ? null : monitor.apiWriteRecordId());
  }
  // T40R-fix-A（T40R の I-2）: 押す前の画面から同じ取り方で取れた値（URL の型では、押す前から変わっていない URL）は、ID として使わない。L12b: 期限まで
  // 読み直す代わりに、ページが静まった後の最後の画面で 1 回読む。新しい値が取れなければ ID なし（`RECORD_ID_NOT_FOUND`）。
  const fromPage = page.isClosed() ? null : await recordIdOf(page, source.spec, input.watch.observationWindows);
  const usable = !page.isClosed() && isPageRecordIdNew(fromPage, baseline, source.spec, page.url()) ? fromPage : null;
  return judged('SUCCESS', usable);
}

/** PL-6a: form の押した後の結果の判定の結果（構造の判定に回すときは、送った後の画面の観察 `formFacts` を持つ）。 */
type JudgedFormResult = JudgedWriteResult & { readonly formFacts: FormResultPageFacts | null };

/**
 * RB-11（plan の 2 章の 11）: form の押した後の結果の観察の記録（段ごとに足す。値と URL を持たない）。
 * - `response`: 応答の待ちの結果。`responseStatus`: 送り手が受けた応答の状態。
 * - `notDelivered`: 応答をブラウザに返せなかった印を、応答の後・静まりの後・読んだ後の段ごとに見た値（まだ見ていない段は持たない）。
 * - `afterRead`: 送った後の画面を読んだ後の、最後の文書の状態と、セッションが切れていたか。
 */
export interface FormResultObservation {
  readonly response: WriteResponseWait;
  readonly responseStatus: number | null;
  readonly notDelivered: readonly boolean[];
  readonly afterRead?: { readonly finalStatus: number | null; readonly sessionLost: boolean } | undefined;
}

/** form の押した後の結果の次の一手: 決まった（判定の名前。判定なしは null）、静まりを待つ、送った後の画面を読む、画面の観察を集めて構造の判定に回す。 */
export type FormResultStep =
  | { readonly kind: 'DECIDED'; readonly judgement: ResponseJudgement | null }
  | { readonly kind: 'SETTLE' }
  | { readonly kind: 'READ' }
  | { readonly kind: 'OBSERVE_PAGE'; readonly httpStatus: number };

const formResultDecided = (judgement: ResponseJudgement | null): FormResultStep => Object.freeze({ kind: 'DECIDED', judgement });

/**
 * RB-11: form の押した後の結果の次の一手（純粋。判定の順は前と同じ）。応答がない → 判定なし、307・308 → `REPOST_REDIRECT`、どこかの段で応答をブラウザに
 * 返せなかった → `RESPONSE_NOT_DELIVERED`、静まりをまだ待っていない → `SETTLE`、まだ読んでいない → `READ`、最後の文書の状態がない → `NO_CONDITION_MATCHED`、
 * 構造の判定の状態（2xx・3xx）でセッションが切れていた → `SESSION_LOST`、ほかは `OBSERVE_PAGE`。
 */
export const formResultStepOf = (observation: FormResultObservation): FormResultStep => {
  if (observation.response !== 'RESPONDED') {
    return formResultDecided(null);
  }
  if (observation.responseStatus !== null && REPOST_REDIRECT_STATUSES.has(observation.responseStatus)) {
    return formResultDecided('REPOST_REDIRECT');
  }
  if (observation.notDelivered.some((canceled) => canceled)) {
    return formResultDecided('RESPONSE_NOT_DELIVERED');
  }
  if (observation.notDelivered.length < 2) {
    return { kind: 'SETTLE' };
  }
  const { afterRead } = observation;
  if (observation.notDelivered.length < 3 || afterRead === undefined) {
    return { kind: 'READ' };
  }
  if (afterRead.finalStatus === null) {
    return formResultDecided('NO_CONDITION_MATCHED');
  }
  return isFormStructureStatus(afterRead.finalStatus) && afterRead.sessionLost
    ? formResultDecided('SESSION_LOST')
    : { kind: 'OBSERVE_PAGE', httpStatus: afterRead.finalStatus };
};

/**
 * 押した後の結果の判定（ファイルの先頭の 5・6。PL-6a で構造の判定に変えた。設計書 8.1）。期限（`resultTimeoutMs`）まで、間隔ごとに応答を待つ。応答を受けたら:
 * 307・308 → `REPOST_REDIRECT`、応答をブラウザに返せなかった → `RESPONSE_NOT_DELIVERED`（どちらも今のまま）。ほかは、送った後の画面を、発見の入口
 * （`readCandidatePage`。押す前に作った数え方で、POST と redirect の先の読み込みが落ち着くまで待ち、凍結して 1 回読む。以後、この Context では読み込まない）
 * で読み、最後の文書の状態が 2xx・3xx で、セッションが切れていれば `SESSION_LOST`。そうでなければ、観察（状態、送ったフォームと同じ形のフォームがあるか、
 * それが送った値を保っているか、URL の ID）を返し、判定は書き込みの段を閉じた後に照合と合わせて決める（`formResultJudgementOf`）。凍結の条件に合わず
 * 読めない画面は、同じフォームがないとして扱う（入力の誤りと言わない側）。
 */
async function judgeFormResult(
  input: WriteStageInput,
  write: WorkerStartWrite,
  documentStatuses: readonly number[],
  postNavigationFailed: () => boolean,
  observation: { readonly counter: InFlightRequestCounter; readonly beforeUrl: string },
): Promise<JudgedFormResult> {
  const { request, monitor, page, ledger } = input;
  const { authentication } = request;
  const finalStatus = (): number | null => documentStatuses.at(-1) ?? monitor.submissionReport().responseStatus;
  const decided = (responseJudgement: ResponseJudgement | null, sessionLostUrl: string | null = null): JudgedFormResult => {
    const report = monitor.submissionReport();
    return {
      httpStatus: report.responseReceived ? finalStatus() : null, responseJudgement: report.responseReceived ? responseJudgement : null, rawRecordId: null,
      sessionLostUrl, formFacts: null,
    };
  };
  // T30R2-fix-1（M-b）: 応答をブラウザに返せなかった。今の画面（ページが自分で移った先など）は POST の応答ではないので、判定しない。
  // HTTP の状態は、送り手が受けた応答のもの（今の画面の文書の状態ではない）。PL-6a: 送った後の画面を読む前と後に確かめる。
  const notDelivered = (): boolean => monitor.snapshot().responseDeliveryCanceled || postNavigationFailed();
  // 送らなかったと決まった、または送り手が書いた後に応答がなかった（DEF-099 fix）なら、判定なしで終える。L12b（T27）: 応答は期限なしで待つ（L0 の見張りで包む）。
  const response = await waitForWriteResponse(input);
  const report = monitor.submissionReport();
  // RB-11: 観察を記録に足し、次の一手は `formResultStepOf` が決める（判定の順は前と同じ）。
  let observed: FormResultObservation = { response, responseStatus: report.responseStatus, notDelivered: response === 'RESPONDED' ? [notDelivered()] : [] };
  let read: ReadCandidatePage | null = null;
  let lostUrl: string | null = null;
  let status: number;
  for (let step = formResultStepOf(observed); ; step = formResultStepOf(observed)) {
    if (step.kind === 'DECIDED') {
      if (step.judgement === 'RESPONSE_NOT_DELIVERED') {
        return { ...decided('RESPONSE_NOT_DELIVERED'), httpStatus: report.responseStatus };
      }
      return decided(step.judgement, step.judgement === 'SESSION_LOST' ? lostUrl : null);
    }
    if (step.kind === 'OBSERVE_PAGE') {
      status = step.httpStatus;
      break;
    }
    if (step.kind === 'SETTLE') {
      // L12b（L12a の限界 4）: 押した後のページの送信と画面の変化（ページが自分で画面を移すことを含む）が静まるまで待ってから、最後の画面を読む（読む部品は
      // 画面を凍結するので、凍結の前に静まりを待つ）。
      await settleAfterPress(page, request, observation.counter);
      observed = { ...observed, notDelivered: [...observed.notDelivered, notDelivered()] };
      continue;
    }
    const classificationPolicy = { allowedOrigins: new Set(authentication.approvedTestOrigins) };
    read = page.isClosed() ? null : await readCandidatePage(page, {
      classificationPolicy, requestCounter: observation.counter, settlePolicy: discoverySettlePolicyOf(request.observationWindows),
    });
    lostUrl = sessionLostUrlOf(page, ledger, authentication.sessionLostPathPrefix);
    observed = { ...observed, notDelivered: [...observed.notDelivered, notDelivered()], afterRead: { finalStatus: finalStatus(), sessionLost: lostUrl !== null } };
  }
  const sameForm = read !== null && input.formShapeKey !== undefined && read.candidates.some((candidate) => formShapeKeyOf(candidate) === input.formShapeKey);
  const sameFormKeptValues = sameForm && !page.isClosed() && await submittedValuesKept(page, write, input.watch.observationWindows);
  const recordId = page.isClosed() ? null : recordableRecordIdOf(recordIdOfResultUrl(formRecordIdPatternsOf(write), observation.beforeUrl, page.url()));
  return { httpStatus: status, responseJudgement: null, rawRecordId: null, sessionLostUrl: null, formFacts: { httpStatus: status, sameForm, sameFormKeptValues, recordId } };
}

/**
 * T32e: 画面の候補の確かめの結果（候補が一致しなかった、または一致して、その画面で読んだ値）。OP-L（L1）: 一致しなかったときは、どこが違ったか
 * （`mismatch`。値を含まない）を持つ。
 */
type CandidateCheck<TValue> =
  | { readonly matched: false; readonly mismatch: ActionEvidenceCandidateMismatch }
  | { readonly matched: true; readonly value: TValue };

/** OP-L（L1）: 候補が一致しなかった（どこが違ったかを添える）。 */
const candidateNotMatched = (mismatch: ActionEvidenceCandidateMismatch): { readonly matched: false; readonly mismatch: ActionEvidenceCandidateMismatch } =>
  Object.freeze({ matched: false, mismatch: Object.freeze({ ...mismatch }) });

/**
 * OP-L（L1）: 候補を読む確かめ（form の登録・更新、API の更新）の、どこが違ったか。同じ識別の候補がない → 2 つ以上 → 規則の digest が違う、の順。
 * `sameIdentity` は承認の識別と同じ候補、`ruleDigest` は承認の規則の digest。
 */
const candidateMismatchOf = (
  pageCandidateCount: number,
  sameIdentity: readonly { readonly ruleDigest: string }[],
  ruleDigest: string | null,
): ActionEvidenceCandidateMismatch => {
  const [only] = sameIdentity;
  const reason: PrecheckCandidateMismatchReason = only === undefined
    ? 'IDENTITY_NOT_FOUND'
    : sameIdentity.length > 1 ? 'IDENTITY_AMBIGUOUS' : ruleDigest !== null && only.ruleDigest !== ruleDigest ? 'RULE_DIGEST_CHANGED' : 'RECORD_ID_NOT_IN_PATH';
  return { reason, pageCandidateCount, sameIdentityCount: sameIdentity.length, fieldPosition: null };
};

/** OP-L（L1）: API の入力の前の確かめの理由を、候補が合わなかった理由にする（確かめの理由でなければ `PAGE_UNREADABLE`）。 */
const apiInspectionMismatchOf = (reason: string, fieldIndex: number | undefined): ActionEvidenceCandidateMismatch => ({
  reason: (PRECHECK_CANDIDATE_MISMATCH_REASONS as readonly string[]).includes(reason) ? reason as PrecheckCandidateMismatchReason : 'PAGE_UNREADABLE',
  pageCandidateCount: null,
  sameIdentityCount: null,
  fieldPosition: fieldIndex ?? null,
});

/** 送る前の画面の確かめの結果（form・UPDATE・API で共通。T40b-1 で 1 つにした）。 */
interface WritePageCheck<TValue> {
  /** 候補が一致し、違反がなく、その画面で読めた値（どれかが外れれば null。送らない）。 */
  readonly value: TValue | null;
  readonly violation: boolean;
  readonly sessionLostUrl: string | null;
  /** T32e: 承認に縛った候補が、ちょうど 1 つあったか（画面を読めず確かめまで進まなければ null）。 */
  readonly candidateMatched: boolean | null;
  /** OP-L（L1）: 候補が合わなかったときの、どこが違ったか（合った・確かめまで進まなかったときは null）。 */
  readonly candidateMismatch: ActionEvidenceCandidateMismatch | null;
}

/**
 * 送る前の画面の確かめの共通の部分（ファイルの先頭の 3 の a・b。T40b-1 で、form・UPDATE・API の 3 つの確かめから取り出した）。読む URL を事前の判定
 * （`isReadUrlAllowed`）に通し、凍結した Context で画面を 1 回読み（`visitGuardedPage`）、読み込みが成功して 4xx・5xx でなければ、呼ぶ側の確かめ
 * （`check`。候補の一致と、その画面で読む値）を行う。
 */
async function checkWritePage<TValue>(
  factory: BrowserContextFactory,
  pacer: NavigationPacer,
  formPage: CandidateLocation,
  options: GuardedPageVisitOptions,
  check: (view: GuardedPageView) => Promise<CandidateCheck<TValue | null>>,
): Promise<WritePageCheck<TValue>> {
  const formUrl = pageUrlOf(formPage);
  if (!isReadUrlAllowed(formUrl, options.config, options.authentication)) {
    return { value: null, violation: false, sessionLostUrl: null, candidateMatched: null, candidateMismatch: null };
  }
  const visit = await visitGuardedPage(factory, pacer, formUrl, options, async (view): Promise<CandidateCheck<TValue | null> | null> => {
    if (view.navigation.navigationOutcome !== 'OK' || isHttpStatusInRange(view.navigation.httpStatus, ERROR_HTTP_STATUS_RANGE)) {
      return null;
    }
    return check(view);
  });
  if (visit.kind === 'SESSION_LOST') {
    return { value: null, violation: visit.violation, sessionLostUrl: visit.url, candidateMatched: null, candidateMismatch: null };
  }
  const checked = visit.kind === 'VISITED' ? visit.value : null;
  return {
    value: checked !== null && checked.matched && !visit.violation ? checked.value : null,
    violation: visit.violation,
    sessionLostUrl: null,
    candidateMatched: checked === null ? null : checked.matched,
    candidateMismatch: checked !== null && !checked.matched ? checked.mismatch : null,
  };
}

/**
 * 送る前の確かめ（ファイルの先頭の 3 の a・b）。承認に縛った候補の識別と規則の 2 つの digest が同じ候補がちょうど 1 つなら、同じ画面で、値を照らす
 * hidden・readonly・見えない欄の値を読む（T31R-fix-1（C-1）。記録しない。T31R2-fix-1（C-1）: null の値は、チェック・選択のない見えない checkbox・
 * radio・select（送られない））。
 */
function checkFormPage(
  factory: BrowserContextFactory,
  pacer: NavigationPacer,
  write: WorkerStartWrite,
  options: ReadCheckPageVisitOptions,
): Promise<WritePageCheck<{ readonly passthrough: Readonly<Record<string, string | null>>; readonly shapeKey: string }>> {
  const classificationPolicy = { allowedOrigins: new Set(options.authentication.approvedTestOrigins) };
  return checkWritePage(factory, pacer, write.formPage, options, async ({ page, counter }) => {
    const read = await readCandidatePage(page, { classificationPolicy, requestCounter: counter, settlePolicy: options.settlePolicy });
    const matching = read.candidates.filter((candidate) => candidate.identityDigest === write.candidate.identityDigest);
    const [only, ...others] = matching;
    if (only === undefined || others.length > 0 || only.ruleDigest !== write.candidate.ruleDigest) {
      return candidateNotMatched(candidateMismatchOf(read.candidates.length, matching, write.candidate.ruleDigest));
    }
    const passthrough = await readWritePassthroughValues(page, formSpecOf(write));
    // PL-6a: 送るフォームの形の鍵（承認した候補の形。送った後の画面で同じ形のフォームを探す）。
    return { matched: true, value: passthrough.ok ? { passthrough: passthrough.values, shapeKey: formShapeKeyOf(only) } : null };
  });
}

/**
 * T31g-2: 更新の画面の確かめと読み取り（ファイルの先頭の T31g-2 の「更新の前の読み取り」「更新の後の照合」）。凍結した Context で具体的な更新の画面を
 * 1 回読み、型にした識別の digest と規則の digest が同じ候補がちょうど 1 つあれば、同じ画面で値を読む。どれかが外れれば `value` は null。
 */
function checkUpdateFormPage(
  factory: BrowserContextFactory,
  pacer: NavigationPacer,
  write: WorkerStartWrite,
  update: WorkerStartWriteUpdate,
  options: ReadCheckPageVisitOptions,
): Promise<WritePageCheck<{ readonly values: UpdateFormValues; readonly shapeKey: string }>> {
  const classificationPolicy = { allowedOrigins: new Set(options.authentication.approvedTestOrigins) };
  return checkWritePage(factory, pacer, write.formPage, options, async ({ page, counter }) => {
    const read = await readCandidatePage(page, { classificationPolicy, requestCounter: counter, settlePolicy: options.settlePolicy });
    const matching = read.candidates.filter((candidate) => candidate.ruleDigest === write.candidate.ruleDigest
      && templatedIdentityDigestForRecordIdOf(candidate, update.targetRecordId) === update.templatedIdentityDigest);
    const [only] = matching;
    if (matching.length !== 1 || only === undefined) {
      // OP-L（L1）: どこが違ったかは、型にした識別だけで同じ候補を数えて決める（照らしの決まりは上のまま）。
      const sameIdentity = read.candidates.filter((candidate) =>
        templatedIdentityDigestForRecordIdOf(candidate, update.targetRecordId) === update.templatedIdentityDigest);
      return candidateNotMatched(candidateMismatchOf(read.candidates.length, sameIdentity, write.candidate.ruleDigest));
    }
    const values = await readUpdateFormValues(page, updateSpecOf(write, update));
    // PL-6a: 送るフォームの形の鍵（対象の画面の候補の形。送った後の画面で同じ形のフォームを探す）。
    return { matched: true, value: values.ok ? { values: values.values, shapeKey: formShapeKeyOf(only) } : null };
  });
}

/**
 * T40b-1: API の送る前の画面の確かめ（ファイルの先頭の T40b-1）。凍結した Context で書き込みの画面を 1 回読み、`inspectApiWriteInput` で、送信の要素
 * （`submitterIdentityDigest`）がちょうど 1 つあり、鍵の欄がそろうことを、値を入れずに確かめる（外れたら候補が一致しなかったとする）。
 */
function checkApiFormPage(
  factory: BrowserContextFactory,
  pacer: NavigationPacer,
  write: WorkerStartApiWrite,
  options: GuardedPageVisitOptions,
  watch: WriteStageWatch,
): Promise<WritePageCheck<true>> {
  return checkWritePage(factory, pacer, write.formPage, options, async ({ page }) => {
    // OP-L（L1）: SPA が欄と送信の要素を後から描くので、出そろうのを待ってから確かめる（読み込みは足さない。確かめの決まりは変えない）。
    // L12b: 待つ上限は置かず、L0 の見張り（`watch`）が終えるまで。
    const inspection = await inspectApiWriteInputWhenRendered(page, apiInputSpecOf(write), undefined, watch);
    return inspection.ok ? { matched: true, value: true } : candidateNotMatched(apiInspectionMismatchOf(inspection.reason, inspection.fieldIndex));
  });
}

/**
 * T31g-2: 変える欄の前の値が、証拠に書ける長さか。L12b（S18）: 長さの上限（前は `MAX_SUBMITTED_VALUE_LENGTH`。`action-run.json` の上限も撤廃した）は置かない
 * （いつも書ける）。
 */
const priorValuesRecordable = (update: WorkerStartWriteUpdate, prior: UpdateFormValues): boolean =>
  update.changedFieldNames.every((name) => typeof (prior.fields[name] ?? '') === 'string');

/**
 * T31g-2: 更新の後の照合の証拠（欄ごとに 1 つ。変えた欄、保つ欄、状態の名前の欄の順）。`after` が null（読めなかった）なら、どの欄も照合できない
 * （`matched` は null）。組の名前の欄は、組の hidden の値も前の値と同じときだけ一致。
 */
function updateEvidenceOf(
  update: WorkerStartWriteUpdate,
  prior: UpdateFormValues,
  after: UpdateFormValues | null,
  values: Readonly<Record<string, string | null>>,
): WriteUpdateEvidence {
  const pairKept = (name: string, current: UpdateFormValues): boolean =>
    !Object.hasOwn(prior.pairOffValues, name) || sameValue(current.pairOffValues[name] ?? null, prior.pairOffValues[name] ?? null);
  /** 欄の後の値（組の名前の欄は、組の hidden の値も前の値と同じときだけ一致。状態の名前の欄は組を見ない）。 */
  const fieldAfterOf = (name: string): UpdateFieldAfter | null =>
    (after === null ? null : { value: after.fields[name] ?? null, alsoMatched: pairKept(name, after) });
  const stateAfterOf = (name: string): UpdateFieldAfter | null =>
    (after === null ? null : { value: after.stateHiddenValues[name] ?? null, alsoMatched: true });
  return updateEvidenceOfChecks(
    update.changedFieldNames.map((fieldName) => ({
      fieldName, previousValue: prior.fields[fieldName] ?? '', expected: values[fieldName] ?? null, after: fieldAfterOf(fieldName),
    })),
    [
      ...update.keptFieldNames.map((fieldName) => ({ fieldName, expected: prior.fields[fieldName] ?? null, after: fieldAfterOf(fieldName) })),
      ...Object.keys(prior.stateHiddenValues).map((fieldName) => ({
        fieldName, expected: prior.stateHiddenValues[fieldName] ?? null, after: stateAfterOf(fieldName),
      })),
    ],
  );
}

/** 送信の報告の状態（1 回だけ送る。書き込みの段に入ったか）。 */
interface SubmissionReporting {
  reported: boolean;
  stageEntered: boolean;
}

/** 送る前の確かめで使うもの（PREFLIGHT の後）。 */
interface PrecheckInput {
  /** RB-11: 書き込みの段の口（送る前の画面の確かめと答え合わせの READ を頼む）。 */
  readonly session: WriteSession;
  readonly options: ReadCheckPageVisitOptions;
  readonly observer: WriteCreateRunObserver;
  readonly stopSignal: AbortSignal;
  /** PL-6a: ジョブの監査の段の状態（送る前の答え合わせの READ に、送った後の READ と同じ判定できない決まりを当てる）。 */
  readonly auditStage: AuditStageRunState | null;
  /** L12b: 上限を撤廃した待ち（API の欄が描かれるのを待つ）の L0 の見張りの指定（`writeStageWatchOf`）。 */
  readonly watch: WriteStageWatch;
}

/**
 * 送る前の確かめの結果（T40b-1 で送り方ごとに分けた）: 書き込みの段の指定を作る口（Guard の照合の期待。部品は呼ぶ側が作る）と、UPDATE の前の値
 * （UPDATE だけ）か、送らずに止めた事実。
 */
type WriteStagePlan =
  | {
    readonly kind: 'STAGE';
    readonly writeStageOf: (monitor: WriteStageMonitor) => GuardWriteStage;
    readonly updateStage?: UpdateStage | undefined;
    /** T41d: API の更新の前の値と指定（API の更新だけ）。 */
    readonly apiUpdate?: ApiUpdateStage | undefined;
    /** PL-6a: form の送るフォームの形の鍵（API は持たない）。 */
    readonly formShapeKey?: string | undefined;
    /** LU-12b: フォームの一覧の行の更新の指定（`planFormListRowUpdateStage`）。 */
    readonly formListRow?: FormListRowStage | undefined;
  }
  | { readonly kind: 'STOP'; readonly facts: WriteFacts };

/** 確かめの途中で分かったセッションの切れを、観測の口に伝える（伏せ字を通す）。 */
const noticeSessionLost = (input: PrecheckInput, url: string | null): void => {
  if (url !== null) {
    input.observer.onSessionLost(redactUrlSecrets(url));
  }
};

/**
 * form の送る前の確かめ（ファイルの先頭の 3。CREATE は画面の確かめ、UPDATE は更新の前の読み取り）と、Guard の照合の期待（CREATE は `writePayloadFieldsOf`、
 * UPDATE は `updatePayloadFieldsOf`。保つ欄・状態の欄・組は前の値）。
 */
async function planFormWriteStage(input: PrecheckInput, write: WorkerStartWrite): Promise<WriteStagePlan> {
  const { session, options, stopSignal } = input;
  const spec = formSpecOf(write);
  // LU-12b: フォームの一覧の行の更新（`update.listRow`）は、前の読み取りをしない（`planFormListRowUpdateStage`）。ほかは今のまま。
  if (write.update?.listRow !== undefined) {
    return planFormListRowUpdateStage(input, write, write.update, write.update.listRow);
  }
  if (write.update === undefined) {
    const formPage = await session.checkFormPage(write, options);
    noticeSessionLost(input, formPage.sessionLostUrl);
    const created = formPage.value === null ? null : payloadExpectationOf(write, spec, formPage.value.passthrough);
    if (stopSignal.aborted || created === null || formPage.value === null) {
      // T44e: 画面を読めた後に照合の期待を作れなければ、入力の前の確かめの失敗。
      const precheckDetail = formPage.value !== null && !stopSignal.aborted ? 'FORM_NOT_READY' : pageCheckDetailOf(formPage, stopSignal.aborted);
      return {
        kind: 'STOP',
        facts: notSent(PRECHECK_FAILED, {
          violation: formPage.violation, candidateDigestMatched: formPage.candidateMatched, precheckDetail, candidateMismatch: formPage.candidateMismatch,
        }),
      };
    }
    const preRead = await preSubmitReadStop(input, write);
    if (preRead !== null) {
      return { kind: 'STOP', facts: preRead };
    }
    return { kind: 'STAGE', writeStageOf: (monitor) => ({ expectation: created, monitor }), formShapeKey: formPage.value.shapeKey };
  }
  // T31g-2: 更新の前の読み取り（ファイルの先頭の T31g-2）と、照合の期待（保つ欄・状態の欄・組は前の値）。
  const prior = await session.checkUpdateFormPage(write, write.update, options);
  noticeSessionLost(input, prior.sessionLostUrl);
  if (prior.value === null || stopSignal.aborted || !priorValuesRecordable(write.update, prior.value.values)) {
    // T44e: 前の値を読めた後に止めるのは、前の値が長すぎる（記録に使えない）とき。
    const precheckDetail = prior.value !== null && !stopSignal.aborted ? 'PRIOR_VALUE_UNUSABLE' : pageCheckDetailOf(prior, stopSignal.aborted);
    return {
      kind: 'STOP',
      facts: notSent(PRECHECK_FAILED, {
        violation: prior.violation, candidateDigestMatched: prior.candidateMatched, precheckDetail, candidateMismatch: prior.candidateMismatch,
      }),
    };
  }
  const { targetRecordId } = write.update;
  const updateStage: UpdateStage = { spec: updateSpecOf(write, write.update), prior: prior.value.values };
  const fields = updatePayloadFieldsOf(updateStage.spec, updateStage.prior, write.values);
  if (!fields.ok) {
    return { kind: 'STOP', facts: notSent(PRECHECK_FAILED, { candidateDigestMatched: true, precheckDetail: 'PRIOR_VALUE_UNUSABLE' }) };
  }
  const expectation: WritePayloadExpectation = { request: { origin: write.request.origin, path: write.request.path, enctype: spec.enctype }, ...fields.fields };
  return {
    kind: 'STAGE', writeStageOf: (monitor) => formUpdateWriteStageOf(expectation, monitor, targetRecordId), updateStage, formShapeKey: prior.value.shapeKey,
  };
}

/**
 * PL-6a（設計書 8.1 の「事前の確かめ」。設計者の判断）: form の登録を送る前に、同じ値で答え合わせの READ を 1 回読み（`verifyReadCheck`。送った後の照合と
 * 同じ部品と同じ判定できない決まり。読み込みは対象の画面と READ の URL の GET 1〜2 回。間隔を守り、読み込み直しはしない）、値がもう見えていれば
 * `VALUE_ALREADY_PRESENT`、判定できなければ `VERIFICATION_READ_UNAVAILABLE`（`preSubmitReadStopOf`）で送らずに止める。読み込みの間の違反は違反として、
 * セッションの切れは `SESSION_LOST` として止める。止める印が来ていれば `STOPPED`。送ってよければ null。
 */
async function preSubmitReadStop(input: PrecheckInput, write: WorkerStartWrite): Promise<WriteFacts | null> {
  const verified = await verifyReadCheck(input.session, write.readVerification, { ...input.options, auditStage: input.auditStage });
  return preSubmitReadStopOfChecked(input, verified, verified.evidence.state === 'EXECUTED' ? verified.evidence.result : 'UNDETERMINED');
}

/** 照合の READ の部品が返す結果（候補の READ と画面の path の READ で同じ形）。 */
type CheckedVerification = Awaited<ReturnType<typeof verifyReadCheck>>;

/**
 * LU-SFIX4（LU-REV の I-1・I-1b。設計書 5.5 の 0）: 一覧の行の更新の送る前の READ（登録と同じ部品と止める理由）。読んだ画面の、選んだ行が「本文が含む」の期待の
 * 文字のどれかをもう含むか（`listRowPresence`。照合の READ の部品が行の選び方で読む）で決める: 含む → `VALUE_ALREADY_PRESENT`、含まない → 送ってよい、分からない
 * （行がちょうど 1 つでない・読めない・含む行が 2 つ以上）→ `VERIFICATION_READ_UNAVAILABLE`。送ってよければ null。
 */
const listRowPreSubmitReadStop = (input: PrecheckInput, verified: CheckedVerification): WriteFacts | null => {
  const presence = verified.listRowPresence ?? 'UNDETERMINED';
  // 行を選べない（ちょうど 1 つでない）ときは、書き込みの段と同じ理由（D4。`ROW_NOT_UNIQUE`）で止める（読めなかった扱いにしない）。
  if (presence === 'ROW_NOT_UNIQUE' && !verified.violation && verified.sessionLostUrl === null) {
    return notSent(PRECHECK_FAILED, { violation: false, candidateDigestMatched: true, precheckDetail: 'ROW_NOT_UNIQUE' });
  }
  return preSubmitReadStopOfChecked(input, verified, LIST_ROW_PRE_SUBMIT_RESULTS[presence]);
};

/** LU-SFIX4: 選んだ行がもう含むかの、送る前の READ の結果への写し（判定 `preSubmitReadStopOf` の入力）。 */
const LIST_ROW_PRE_SUBMIT_RESULTS: Readonly<Record<ListRowPresence, 'MATCHED' | 'NOT_MATCHED' | 'UNDETERMINED'>> = Object.freeze({
  PRESENT: 'MATCHED', ABSENT: 'NOT_MATCHED', UNDETERMINED: 'UNDETERMINED', ROW_NOT_UNIQUE: 'UNDETERMINED',
});

/** 送る前の READ の結果から、送らずに止める事実（登録と一覧の行の更新が共有する。送ってよければ null）。 */
function preSubmitReadStopOfChecked(input: PrecheckInput, verified: CheckedVerification, result: Parameters<typeof preSubmitReadStopOf>[0]): WriteFacts | null {
  noticeSessionLost(input, verified.sessionLostUrl);
  const stopWith = (precheckDetail: PrecheckFailureDetail, violation = false): WriteFacts =>
    notSent(PRECHECK_FAILED, { violation, candidateDigestMatched: true, precheckDetail });
  if (verified.violation) {
    return stopWith('VERIFICATION_READ_UNAVAILABLE', true);
  }
  if (verified.sessionLostUrl !== null) {
    return stopWith('SESSION_LOST');
  }
  const stop = preSubmitReadStopOf(result);
  if (stop !== null) {
    return stopWith(stop);
  }
  return input.stopSignal.aborted ? stopWith('STOPPED') : null;
}

/** T40b-1: API の送る前の確かめ（`checkApiFormPage`）と、書き込みの段の指定（`apiWriteStageOf`）。T41d: 更新は前の読み取り（`planApiUpdateStage`）。 */
async function planApiWriteStage(input: PrecheckInput, write: WorkerStartApiWrite): Promise<WriteStagePlan> {
  const targetRecordId = apiUpdateTargetOf(write);
  // LU-10: 一覧の行の更新（`update.listRow`）は、前の読み取りをしない（`planApiListRowUpdateStage`）。ほかの更新は今のまま。
  const listRow = write.update?.listRow;
  if (targetRecordId !== null && listRow !== undefined) {
    return planApiListRowUpdateStage(input, write, targetRecordId, listRow);
  }
  if (targetRecordId !== null) {
    return planApiUpdateStage(input, write, targetRecordId);
  }
  const checked = await input.session.checkApiFormPage(write, input.options, input.watch);
  noticeSessionLost(input, checked.sessionLostUrl);
  if (checked.value === null || input.stopSignal.aborted) {
    return {
      kind: 'STOP',
      facts: notSent(PRECHECK_FAILED, {
        violation: checked.violation, candidateDigestMatched: checked.candidateMatched, precheckDetail: pageCheckDetailOf(checked, input.stopSignal.aborted),
        candidateMismatch: checked.candidateMismatch,
      }),
    };
  }
  return { kind: 'STAGE', writeStageOf: (monitor) => apiWriteStageOf(write, monitor) };
}

/** RB-11: 書き込みの段を開いて動かす依頼（段の口の `runWriteStage` が受ける）。 */
export interface WriteStageRequest {
  readonly request: WriteCreateRunRequest;
  readonly plan: Extract<WriteStagePlan, { readonly kind: 'STAGE' }>;
  readonly auditStage: AuditStageRunState | null;
  /** 書き込みの段の Context を開けた（ここから後の例外は、送信の報告を「分からない」にする）。 */
  readonly onEntered: () => void;
  /**
   * REV-RB8911 M-3（DEF-280）: 押した時刻（押す直前の時計）。段の外の入れ物に書くので、押した後に段の本体が例外で終わっても、押した時刻が記録に残る。
   */
  readonly onPressed: (at: Date) => void;
}

/** RB-11: 書き込みの段の結果（開けなかった、または閉じた後の Guard の送信の報告・要約・違反と、段の本体の結果）。 */
export type WriteStageRun =
  | { readonly kind: 'NOT_OPENED' }
  | {
    readonly kind: 'RAN';
    readonly stage: WriteStageResult;
    readonly report: WriteSubmissionReport;
    readonly guard: ActionGuardSummary;
    /** 送る中身の照合（`checkWritePayload`・`checkApiWritePayload`）で止めたか。 */
    readonly payloadBlocked: boolean;
    readonly violation: boolean;
    /** T40b-1: Guard の照合が返したページが決める鍵の値（form は null）。 */
    readonly apiPageKeyValues: ReturnType<WriteStageMonitor['apiWritePageKeyValues']>;
  };

/**
 * RB-11（再構築の設計書 2 章 1、INV-REBUILD の plan 2 章の 10・11）: 開いた書き込みの段の口。照合の READ は READ の確かめの段の口の操作（`ReadCheckSession`）を
 * そのまま持つ（写さない）。どの操作も例外を投げない。読み込みの間隔は、口を開くときに渡した pacer が守る。
 * - 送る前の画面の確かめ: `checkFormPage`（form の登録）、`checkUpdateFormPage`（form の更新の前と後）、`checkApiFormPage`（API の登録）、
 *   `checkApiUpdatePage`（API の更新の前と後）。
 * - `runWriteStage`: 書き込みの段（Guard の照合の期待を付けた Context で、入れる → 窓 → 押す → 結果の観察。閉じた後の Guard の送信の報告）。
 */
export interface WriteSession extends ReadCheckSession {
  readonly checkFormPage: (write: WorkerStartWrite, options: ReadCheckPageVisitOptions) => ReturnType<typeof checkFormPage>;
  readonly checkUpdateFormPage: (write: WorkerStartWrite, update: WorkerStartWriteUpdate, options: ReadCheckPageVisitOptions) => ReturnType<typeof checkUpdateFormPage>;
  readonly checkApiFormPage: (write: WorkerStartApiWrite, options: GuardedPageVisitOptions, watch: WriteStageWatch) => ReturnType<typeof checkApiFormPage>;
  readonly checkApiUpdatePage: (
    write: WorkerStartApiWrite,
    targetRecordId: string,
    options: GuardedPageVisitOptions,
    quiet: ApiUpdateQuietMemory,
  ) => ReturnType<typeof checkApiUpdatePage>;
  readonly runWriteStage: (input: WriteStageRequest) => Promise<WriteStageRun>;
}

/** RB-11: 書き込みの段の口。 */
export type WritePorts = StagePorts<WriteSession>;

/** RB-11: 本物の書き込みの段の口（今までの `runPreflight` と factory の上の確かめ・書き込みの段・照合の READ の部品）。 */
const PLAYWRIGHT_WRITE_PORTS: WritePorts = playwrightStagePortsOf<WriteSession>((factory, pacer) => ({
  ...readCheckOperationsOf(factory, pacer),
  checkFormPage: (write, options) => checkFormPage(factory, pacer, write, options),
  checkUpdateFormPage: (write, update, options) => checkUpdateFormPage(factory, pacer, write, update, options),
  checkApiFormPage: (write, options, watch) => checkApiFormPage(factory, pacer, write, options, watch),
  checkApiUpdatePage: (write, targetRecordId, options, quiet) => checkApiUpdatePage(factory, pacer, write, targetRecordId, options, quiet),
  runWriteStage: (input) => runWriteStageOn(factory, pacer, input),
}));

/** 書く（ファイルの先頭の 2〜8）。送信の報告は、ここで 1 回だけ送る。 */
async function performWrite(
  request: WriteCreateRunRequest,
  outputDirectory: string,
  observer: WriteCreateRunObserver,
  reporting: SubmissionReporting,
): Promise<WriteFacts> {
  const { config, authentication, write, stopSignal, now } = request;
  const report = (facts: WriteFacts): WriteFacts => {
    if (!reporting.reported) {
      reporting.reported = true;
      request.reportSubmission({ submission: facts.submission, blockReason: facts.blockReason });
    }
    return facts;
  };
  // DEF-100 fix: pacer は PREFLIGHT の前に作り、factory にも渡す（Guard が main frame の文書の要求を送った時刻を記録する）。
  const pacer = request.navigationPacer ?? createNavigationPacer({ minIntervalMs: config.crawl.minNavigationIntervalMs, now, sleep: wait });
  // T35R2-fix（T35R2 の C-1）: 監査の段の口があれば、Run と同じ部品で作った上限の部品も渡す。T37a（Task 37 の設計書 3.1）: 書き込みのジョブは、Task 39
  // まで登録した読み取りの手続きの呼び出しを通さない（`NONE`）。T37a fix round 1: 作った状態で、書き込みの段を開く前と押す直前に、鍵の消失と上限を
  // 確かめ、当たれば送らずに「送っていない」で終える。
  const { factoryOptions, state: auditStage } = jobContextFactoryOptions(authentication, now, 'NONE', request.stageCarry?.serviceRequestWindowMs ?? []);
  // OP-2: まとめて実行の書き込みの段の持ち越し（読み込みの間隔は、この段の pacer と設定の最小の間隔。書き込みの段は間隔を上げない）。
  const navigationCarry = (): Parameters<typeof recordRunStageCarry>[3] => ({ pacer, minIntervalMs: config.crawl.minNavigationIntervalMs, now });
  // RB-11: Run の前の確認・送る前の確かめ・書き込みの段・照合の READ は、段の口に頼む（省略は本物）。
  const ports = request.writePorts ?? PLAYWRIGHT_WRITE_PORTS;
  const session = await ports.open({
    config,
    launchBrowser: request.launchBrowser,
    browserLease: request.browserLease,
    createSafetyLedger: () => new SafetyLedger(),
    outputDirectory,
    contextFactoryOptions: {
      ...factoryOptions,
      // OP-N（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1.7 の N2）: 実効の設定の監査の段の送信の扱い（親が `START` で渡すプロファイルの設定）が
      // `PASS_EXCEPT_DELETE` なら、書き込みの段の Context だけに、監査の段と同じ口を渡す（組み立ては発見・READ の確かめのジョブと同じ `auditSendOptionsOf`）。
      // OP-Q（設計書 4.1.8 の Q1。OP-REV3 の C-1 を改めた）: 送る前の確かめと照合の READ の Passive の Context にも、書き込みの作業の印つきの口を渡す（決まりは
      // 書き込みの段の値を入れる前と同じで、要求の判定の owner が加える）。`READ_ONLY` なら口を渡さない（今のまま）。
      ...writeJobAuditSendOf(config, authentication.approvedTestOrigins, write),
      // LU-SFIX5（LU-SREV4 の Important-1）: 書き込みのジョブの factory の印（ジョブの中のどの Context の後も、ページが書ける状態をジョブの始まりの世代に固定する）。
      writeJob: true,
      navigationPacer: pacer,
      ...(request.writeSubmissionCertificates === undefined ? {} : { writeSubmissionCertificates: request.writeSubmissionCertificates }),
    },
  }, pacer);
  if (session === null) {
    // OP-2: factory がないので、状態は持ち越さない（次の段は始めない）。
    recordRunStageCarry(request.stageCarry, null, auditStage, navigationCarry());
    return report({ ...notSent(PRECHECK_FAILED, { precheckDetail: 'PREFLIGHT_FAILED' }), preflightFailed: true });
  }
  try {
    // RB-fix-456: 候補の画面と照合の READ を読む前の落ち着きの待ちは、差し込まれた観察の窓の一式（テストだけ）から。なければ本番の値。
    const options: ReadCheckPageVisitOptions = {
      config, allowedQueryParameters: new Set(config.crawl.allowedQueryParameters), authentication,
      settlePolicy: discoverySettlePolicyOf(request.observationWindows),
    };
    if (stopSignal.aborted) {
      return report(notSent(PRECHECK_FAILED, { precheckDetail: 'STOPPED' }));
    }
    const precheck: PrecheckInput = { session, options, observer, stopSignal, auditStage, watch: writeStageWatchOf(request) };
    // T40b-1: 送る前の確かめと書き込みの段の指定は、送り方で分ける（API は `checkApiFormPage`、form は画面の確かめか更新の前の読み取り）。
    const plan = isWorkerStartApiWrite(write) ? await planApiWriteStage(precheck, write) : await planFormWriteStage(precheck, write);
    if (plan.kind === 'STOP') {
      return report(plan.facts);
    }
    // T37a fix round 1: 画面の確かめ（と更新の前の読み取り）の後に、鍵の消失と上限を確かめる（当たれば、書き込みの段を開かずに送らない）。
    if (auditStageStopsWrite(auditStage)) {
      return report(notSent(PRECHECK_FAILED, { candidateDigestMatched: true, precheckDetail: 'AUDIT_STAGE_STOPPED' }));
    }
    // 書き込みの段（Guard の照合の期待を付けた Context。段の口が開いて閉じる）。閉じた後に、Guard の送信の報告で送ったかを決める。
    // REV-RB8911 M-3（DEF-280）: 押した時刻は段の外の入れ物に受ける（押した後に段の本体が例外で終わっても、記録に残す）。
    const pressed: { at: Date | null } = { at: null };
    const ran = await session.runWriteStage({
      request, plan, auditStage, onEntered: () => { reporting.stageEntered = true; }, onPressed: (at) => { pressed.at = at; },
    });
    if (ran.kind === 'NOT_OPENED') {
      return report(notSent(PRECHECK_FAILED, { candidateDigestMatched: true, precheckDetail: 'PAGE_UNAVAILABLE' }));
    }
    const { violation, guard } = ran;
    const stage: WriteStageResult = ran.stage.submittedAt === null && pressed.at !== null ? { ...ran.stage, submittedAt: pressed.at } : ran.stage;
    if (stage.sessionLostUrl !== null) {
      observer.onSessionLost(redactUrlSecrets(stage.sessionLostUrl));
    }
    const guardReport = ran.report;
    if (guardReport.submission === 'NOT_SENT') {
      // T44e: `PRECHECK_FAILED` なら、書き込みの段が返した具体的な理由（例外で終わったときはない）。`PAYLOAD_MISMATCH` には付けない（`notSent` が決める）。
      return report(notSent(ran.payloadBlocked ? PAYLOAD_MISMATCH : PRECHECK_FAILED, {
        violation, candidateDigestMatched: true, guard, precheckDetail: stage.precheckDetail, inputFailure: stage.inputFailure,
      }));
    }
    // Guard が承認の POST を通した（送った）。応答がなければ判定なし（予約は `UNKNOWN`）。T40b-1: API の段が判定まで進まなかった回の状態も、100〜599 の
    // 外なら記録しない（`apiResponseFactsOf`）。
    const unjudgedStatus = isWorkerStartApiWrite(write) ? apiResponseFactsOf(guardReport).httpStatus : guardReport.responseStatus;
    const httpStatus = guardReport.responseReceived ? stage.httpStatus ?? unjudgedStatus : null;
    const responseJudgement = httpStatus === null ? null : stage.responseJudgement ?? 'NO_CONDITION_MATCHED';
    /** 送った回の事実（照合の READ の証拠と UPDATE の証拠と違反は、段ごとに決める）。 */
    const sentFacts = (readEvidence: ReadCheckExecutedEvidence | null, updateEvidence: WriteUpdateEvidence | null, sentViolation: boolean): WriteFacts =>
      Object.freeze({
        submission: 'SENT', blockReason: null, httpStatus, responseJudgement, rawRecordId: stage.rawRecordId, readEvidence, submittedAt: stage.submittedAt,
        violation: sentViolation, updateEvidence, candidateDigestMatched: true, judgedAt: responseJudgement === null ? null : stage.judgedAt, guard,
        // T40b-1: Guard の照合が返したページが決める鍵の値（form は null）。
        apiPageKeyValues: ran.apiPageKeyValues,
      });
    // 送信の報告（送った。報告に使うのは送信の状態と止めた理由だけ）。
    report(sentFacts(null, null, violation));
    if (!isWorkerStartApiWrite(write)) {
      // PL-6a: form は、送った後の照合と構造の判定（`formSentFactsOf`）。
      return await formSentFactsOf({ request, session, options, observer, auditStage }, write, plan, stage, { httpStatus, violation, guard });
    }
    {
      // T40b-2: 照合の READ（form と同じ条件: 成功で違反がなく、ID が使える形のときだけ）。`{id}` に ID を入れた画面に、保存の時と同じ画面の path の確かめと
      // 事前の判定をかけ直してから 1 回だけ読む（`verifyRecordPageReadCheck`）。ID がない・使えないときは行わない（`RECORD_ID_NOT_FOUND`・`RECORD_ID_UNSAFE`）。
      const recordId = stage.rawRecordId;
      if (responseJudgement !== 'SUCCESS' || violation || !isUsableRecordId(recordId)) {
        return sentFacts(null, null, violation);
      }
      // T41d（Task 41 の設計書 3.4 の 4）: 更新の後の照合。応答の ID が対象の ID のときだけ、前の読み取りと同じ確かめで対象の更新の画面を 1 回読み、変えた欄は
      // 新しい値、保つ欄とページが決める鍵の欄は前の値かを照らす（form の UPDATE と同じく、一致しない欄があれば照合の READ は行わない）。
      const { apiUpdate } = plan;
      let apiUpdateEvidence: WriteUpdateEvidence | null = null;
      if (apiUpdate?.listRow !== undefined) {
        if (recordId !== apiUpdate.targetRecordId) {
          return sentFacts(null, null, violation);
        }
        // LU-10（設計書 4.0.1 の K3、5.5 の 7）: 一覧の行の更新の照合は、窓を開き直さず、新しい Context で一覧の画面を 1 回読み、行を選ぶ値で選んだ行に変えた欄の
        // 新しい値があるかを確かめる（照合の READ の唯一の部品 `verifyRecordPageReadCheck` に行の選び方を渡す）。行がちょうど 1 つでない・値がないときは、照合
        // できない（「送ったが確かめられませんでした」の側）。
        const listVerified = await session.visitAndReadRecordPage(write.readVerification, recordId, { ...options, auditStage, ...LAST_LOAD_OF_JOB }, {
          rowKeyValue: apiUpdate.listRow.rowKeyValue,
        });
        if (listVerified.sessionLostUrl !== null) {
          observer.onSessionLost(redactUrlSecrets(listVerified.sessionLostUrl));
        }
        const listEvidence = apiListRowUpdateEvidenceOf(apiUpdate.listRow.observed.prior, write.values, listVerified.evidence.result);
        return sentFacts(listVerified.evidence, listEvidence, listVerified.violation);
      }
      if (apiUpdate !== undefined) {
        if (recordId !== apiUpdate.targetRecordId) {
          return sentFacts(null, null, violation);
        }
        const after = await session.checkApiUpdatePage(write, apiUpdate.targetRecordId, options, apiUpdate.quiet);
        if (after.sessionLostUrl !== null) {
          observer.onSessionLost(redactUrlSecrets(after.sessionLostUrl));
        }
        apiUpdateEvidence = apiUpdateEvidenceOf(apiUpdate.prior, after.value?.values ?? null, write.values, apiUpdate.knownKeptValues);
        if (after.violation || fieldsMatchedOf(apiUpdateEvidence) === false) {
          return sentFacts(null, apiUpdateEvidence, violation || after.violation);
        }
      }
      const verified = await session.visitAndReadRecordPage(write.readVerification, recordId, { ...options, auditStage, ...LAST_LOAD_OF_JOB });
      if (verified.sessionLostUrl !== null) {
        observer.onSessionLost(redactUrlSecrets(verified.sessionLostUrl));
      }
      return sentFacts(verified.evidence, apiUpdateEvidence, verified.violation);
    }
  } finally {
    await session.close();
    // OP-2: Browser を閉じた（RB-5: lease に返した）後に、factory の最新の状態と窓と読み込みの間隔を持ち越しの口へ渡す（メモリの中だけ）。
    recordRunStageCarry(request.stageCarry, session.carry, auditStage, navigationCarry());
  }
}

/**
 * RB-11: 書き込みの段を開いて動かす（本物の段の口の `runWriteStage`）。Guard の照合の期待を付けた Context を開き（開けなければ `NOT_OPENED`）、form か API の
 * 段の本体を動かし、閉じた後の Guard の送信の報告・要約・違反を返す。段の本体の例外は受けて、送ったかは閉じた後の Guard の送信の報告で決める。
 */
async function runWriteStageOn(factory: BrowserContextFactory, pacer: NavigationPacer, input: WriteStageRequest): Promise<WriteStageRun> {
  const { request, plan, auditStage } = input;
  const { write } = request;
  const monitor = new WriteStageMonitor();
  let context: BrowserContext;
  try {
    context = await factory.createWriteStageContext(request.config.viewports.primaryDesktop, plan.writeStageOf(monitor));
  } catch {
    return { kind: 'NOT_OPENED' };
  }
  const ledger = factory.getSafetyLedger(context);
  input.onEntered();
  let stage: WriteStageResult = PRECHECK_STOPPED;
  try {
    const page = await factory.createPassivePage(context);
    const stageInput: WriteStageInput = {
      request, onPressed: input.onPressed, watch: writeStageWatchOf(request), factory, pacer, monitor, context, page, ledger, update: plan.updateStage, apiUpdate: plan.apiUpdate, auditStage,
      formShapeKey: plan.formShapeKey, formListRow: plan.formListRow,
    };
    stage = isWorkerStartApiWrite(write) ? await apiWriteOnStage(stageInput, write) : await writeOnStage(stageInput, write);
  } catch {
    // 送ったかは、閉じた後の Guard の送信の報告で決める。
  } finally {
    await closePassiveContextBeforeDeadline(factory, context, { timeoutMs: CONTEXT_CLOSE_TIMEOUT_MS });
  }
  return {
    kind: 'RAN', stage, report: monitor.submissionReport(),
    // T32e: Guard の書き込みの段の数の要約（Context を閉じた後の写し。送った回も送らなかった回も報告に書く）。
    guard: guardSummaryOf(monitor.snapshot()), payloadBlocked: payloadBlocked(monitor), violation: hasViolation(ledger),
    apiPageKeyValues: monitor.apiWritePageKeyValues(),
  };
}

/**
 * DEF-236（設計書 `2026-11-09-beaksight-visible-pacing-wait-design.md` 3.2）: 送った後の照合の READ は、書き込みのジョブの最後の読み込みなので、画面を見せたまま
 * 次の読み込みの間隔を待たずに閉じる（`pacingWaitBeforeClose`。`verifyReadCheck` は、候補の画面の後には今どおり待つ）。送る前の読み込みは、送る段が続くので待つ。
 */
const LAST_LOAD_OF_JOB = Object.freeze({ pacingWaitBeforeClose: false });

/** PL-6a: form の送った後の照合で使うもの（書き込みの段を閉じた後。凍結した Context と READ の URL の Context を、間隔を守って開く）。 */
interface FormSentInput {
  readonly request: WriteCreateRunRequest;
  readonly session: WriteSession;
  readonly options: ReadCheckPageVisitOptions;
  readonly observer: WriteCreateRunObserver;
  readonly auditStage: AuditStageRunState | null;
}

/**
 * PL-6a（設計書 8.1 の「判定の順」）: form の送った回の、送った後の照合と結果の判定（書き込みの段を閉じた後。もう送れない時点）。
 * - 段が判定を決めた（応答なし、307・308、応答を返せなかった、セッションの切れ）なら、その判定のまま（照合しない）。
 * - 送った後の画面の観察（`formFacts`）があり、状態が 2xx・3xx で違反がなければ、成否によらず照合する: 登録は答え合わせの READ（`verifyReadCheck`。
 *   GET 2 回）、更新は更新の後の照合（具体的な更新の画面を凍結した Context で 1 回読む）。更新は、更新の後の照合が一致し、判定が成功のときだけ、続けて
 *   答え合わせの READ を行う（今のまま）。4xx・5xx は照合しない。
 * - 判定は `formResultJudgementOf`（照合の結果、送った値を保った同じフォームの形、URL の ID）。結果（`ActionResult`）は呼ぶ側が `actionOutcomeOf` で決める。
 * 送り直しはしない。読み込み直しはしない。
 */
async function formSentFactsOf(
  input: FormSentInput,
  write: WorkerStartWrite,
  plan: Extract<WriteStagePlan, { readonly kind: 'STAGE' }>,
  stage: WriteStageResult,
  sent: { readonly httpStatus: number | null; readonly violation: boolean; readonly guard: ActionGuardSummary },
): Promise<WriteFacts> {
  const { session, options, observer, auditStage, request } = input;
  const { httpStatus, guard } = sent;
  let violation = sent.violation;
  const facts = (
    judged: { readonly responseJudgement: ResponseJudgement | null; readonly recordId: string | null },
    readEvidence: ReadCheckExecutedEvidence | null,
    updateEvidence: WriteUpdateEvidence | null,
    judgedAt: Date | null,
  ): WriteFacts => {
    const responseJudgement = httpStatus === null ? null : judged.responseJudgement ?? 'NO_CONDITION_MATCHED';
    return Object.freeze({
      submission: 'SENT', blockReason: null, httpStatus, responseJudgement, rawRecordId: judged.recordId, readEvidence, submittedAt: stage.submittedAt,
      violation, updateEvidence, candidateDigestMatched: true, judgedAt: responseJudgement === null ? null : judgedAt, guard, apiPageKeyValues: null,
    });
  };
  const formFacts = stage.formFacts ?? null;
  if (formFacts === null) {
    return facts({ responseJudgement: stage.responseJudgement, recordId: stage.rawRecordId }, null, null, stage.judgedAt);
  }
  const structural = isFormStructureStatus(formFacts.httpStatus) && !violation;
  /** 照合の READ（監査の段の判定できない決まりを当てる。鍵の消失はセッションの切れ）。証拠の全体を残す（実行しなかった定義は残さない）。 */
  const readVerification = async (): Promise<ReadCheckExecutedEvidence | null> => {
    const verified = await verifyReadCheck(session, write.readVerification, { ...options, auditStage, ...LAST_LOAD_OF_JOB });
    if (verified.sessionLostUrl !== null) {
      observer.onSessionLost(redactUrlSecrets(verified.sessionLostUrl));
    }
    violation ||= verified.violation;
    return verified.evidence.state === 'EXECUTED' ? verified.evidence : null;
  };
  const judgedOf = (readEvidence: ReadCheckExecutedEvidence | null, update?: { readonly postcheck: FormUpdatePostcheck; readonly targetRecordId: string }) =>
    formResultJudgementOf({
      httpStatus: formFacts.httpStatus, sameForm: formFacts.sameForm, sameFormKeptValues: formFacts.sameFormKeptValues, recordId: formFacts.recordId,
      readVerification: readEvidence?.result ?? null, update,
    });
  const { updateStage, formListRow } = plan;
  // LU-12b（設計書 4.0.1 の K3、5.5 の 7）: フォームの一覧の行の更新は、窓を開き直さず（更新の後の画面の読み取りをしない）、照合の READ を 1 回、行を選ぶ値で選んだ
  // 行に変えた欄の新しい値があるかで確かめる（照合の READ の部品に行の選び方を渡す。行がちょうど 1 つでない・値がないときは照合できない）。2xx・3xx で違反がない
  // ときだけ読む（今の更新と同じ）。READ が一致したときだけ、更新の後の照合を `UPDATED` とみなす（ほかは判定できない）。
  if (write.update !== undefined && formListRow !== undefined) {
    let readEvidence: ReadCheckExecutedEvidence | null = null;
    if (structural) {
      const verified = await verifyReadCheck(session, write.readVerification, { ...options, auditStage, ...LAST_LOAD_OF_JOB }, {
        rowKeyValue: formListRow.listRow.rowKeyValue,
      });
      if (verified.sessionLostUrl !== null) {
        observer.onSessionLost(redactUrlSecrets(verified.sessionLostUrl));
      }
      violation ||= verified.violation;
      readEvidence = verified.evidence.state === 'EXECUTED' ? verified.evidence : null;
    }
    const listEvidence = formListRowUpdateEvidenceOf(formListRow.observed.prior, write.update, write.values, readEvidence?.result ?? null);
    const listPostcheck: FormUpdatePostcheck = !violation && readEvidence?.result === 'MATCHED' ? 'UPDATED' : 'UNDETERMINED';
    return facts(judgedOf(null, { postcheck: listPostcheck, targetRecordId: write.update.targetRecordId }), readEvidence, listEvidence, request.clock());
  }
  if (write.update === undefined || updateStage === undefined) {
    const readEvidence = structural ? await readVerification() : null;
    return facts(judgedOf(readEvidence), readEvidence, null, request.clock());
  }
  // T31g-2: 更新の後の照合（PL-6a: 成否によらず、2xx・3xx なら読む）。一致しない欄があれば、照合の READ は行わない（結果は判定と照合で決まる）。
  let updateEvidence: WriteUpdateEvidence | null = null;
  let postcheck: FormUpdatePostcheck = 'UNDETERMINED';
  if (structural) {
    const after = await session.checkUpdateFormPage(write, write.update, options);
    if (after.sessionLostUrl !== null) {
      observer.onSessionLost(redactUrlSecrets(after.sessionLostUrl));
    }
    violation ||= after.violation;
    const afterValues = after.value?.values ?? null;
    updateEvidence = updateEvidenceOf(write.update, updateStage.prior, afterValues, write.values);
    postcheck = after.violation ? 'UNDETERMINED' : formUpdatePostcheckOf(write.update, updateStage.prior, afterValues, updateEvidence);
  }
  const judged = judgedOf(null, { postcheck, targetRecordId: write.update.targetRecordId });
  if (judged.responseJudgement === 'SUCCESS' && postcheck === 'UPDATED' && !violation) {
    return facts(judged, await readVerification(), updateEvidence, request.clock());
  }
  return facts(judged, null, updateEvidence, request.clock());
}

/**
 * Run の状態（書き込みの事実を、唯一の判定 `deriveRunStatus` の入力に写すだけ。判定はしない）。違反は `ABORTED_BY_SAFETY`、Run の前の確認の
 * 失敗は `FAILED`。照合まで済んだ（`VERIFIED`）ときだけ `COMPLETE` になりうる: 送らずに止めた・失敗は「失敗した仕事」、照合できない・分からないは
 * 「確かめていない仕事」として数える（どちらも `PARTIAL`）。
 */
const writeRunStatusOf = (result: ActionResult, facts: WriteFacts): RunStatus => deriveRunStatus({
  preflightFailed: facts.preflightFailed === true,
  safetyInvariantViolations: facts.violation ? 1 : 0,
  safetyLedgerTruncated: false,
  incompleteReasons: [],
  unhandledFailures: 0,
  crawlLimitReached: false,
  requiredArtifactsValid: true,
  executionComplete: true,
  skippedRequiredWork: 0,
  blockedRequiredWork: 0,
  timedOutRequiredWork: 0,
  notObservedRequiredWork: 0,
  notVerifiedRequiredWork: result === 'PARTIAL' || result === 'UNKNOWN' ? 1 : 0,
  failedRequiredWork: result === 'BLOCKED' || result === 'FAILED' ? 1 : 0,
  incompleteCollectorCount: 0,
});

/** 照合の READ の記録（`action-run.json` の `readVerification`。証拠の全体から id・版・結果だけを取る。実行しなければ null）。 */
const readVerificationOf = (facts: WriteFacts): ActionRunReadVerification | null => (facts.readEvidence === null
  ? null
  : { readCheckId: facts.readEvidence.readCheckId, readCheckRevision: facts.readEvidence.readCheckRevision, result: facts.readEvidence.result });

/** UPDATE の証拠の変えた欄の役割。 */
const CHANGED_FIELD_ROLE = 'CHANGED' satisfies WriteUpdateFieldEvidence['role'];

/** 更新の対象の ID（form の UPDATE と、T41d の API の更新。登録は null）。 */
const updateTargetRecordIdOf = (write: WorkerStartWrite | WorkerStartApiWrite): string | null =>
  (isWorkerStartApiWrite(write) ? apiUpdateTargetOf(write) : write.update?.targetRecordId ?? null);

/** 照合の READ を実行しなかった印の状態。 */
const READ_NOT_EXECUTED_STATE = 'NOT_EXECUTED' satisfies ActionEvidenceDocument['readVerification']['state'];

/** form の書き込みの送り方（T40c。記録と報告の版 1.1 の `transport`）。 */
const FORM_TRANSPORT = FORM_SCENARIO_TRANSPORT;

/** 人の値が入りうる項目（UPDATE の変えた欄の前の値、照合の READ の取れた値）があるか（T32e。報告の `containsHumanEnteredValues`）。 */
const containsHumanEnteredValuesOf = (facts: WriteFacts): boolean =>
  (facts.updateEvidence?.fields.some((field) => field.role === CHANGED_FIELD_ROLE) ?? false)
  || (facts.readEvidence?.expectations.some((expectation) => 'observedValue' in expectation && typeof expectation.observedValue === 'string') ?? false);

/** 書き込みの記録と報告の文書（T32e）。 */
interface WriteRunDocuments {
  readonly actionRun: ActionRunDocument;
  readonly evidence: ActionEvidenceDocument;
  readonly approvalSummary: ApprovalSummaryDocument;
}

/**
 * 書き込みの記録（`action-run.json`。T40c から版 1.1。form は送り方 `FORM`・API の要約なし、T40b-1 から API は送り方 `API`・API の要約・成否の条件なし）と、
 * 書き込みの報告の証拠（`action-evidence.json`。同じく 1.1）と承認の要約（`approval-summary.json`）を、
 * 同じ事実から 1 回だけ組み立てる（T32e。Task 32 の設計書 4.1 の「1 回だけ組み立てる」）。重なる値（ID、送った値と時刻、応答、登録の ID、UPDATE の
 * 証拠、照合の READ、結果と理由、時刻）は、ここで 1 回だけ求めて両方に入れる。
 * - 送らなかった回（`NOT_SENT`）の報告は、送った値を `{}`、送信先と送信の時刻と応答を null、照合の READ を実行しなかった印にする（報告の対象は
 *   終わりまで進んだ回すべて。ユーザーの判断 7）。`action-run.json` の送った値は、今までどおり生成した値（親の送る前の記録と同じ）。
 * - 人の値（UPDATE の変えた欄の前の値、照合の READ の `observedValue`）は入れ、`containsHumanEnteredValues` を真にする（ユーザーの判断 6）。
 * - 承認の要約は、`START` の承認の要約の事実に、版の印・ジョブ・Run を足すだけ（照らさない。承認の判断は親）。
 */
export function writeRunDocumentsOf(input: {
  readonly jobId: string;
  readonly write: WorkerStartWrite | WorkerStartApiWrite;
  readonly runId: RunId;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly facts: WriteFacts;
  readonly outcome: ActionOutcome;
}): WriteRunDocuments {
  const { jobId, write, runId, facts, outcome } = input;
  const timeOf = (date: Date): string => formatCompactUtcTimestamp(date, WRITE_CREATE_TIME_SUBJECT);
  const sent = facts.submission !== 'NOT_SENT';
  const identity = {
    jobId, runId, profileId: write.profileId, scenarioId: write.scenarioId, scenarioRevision: write.scenarioRevision,
  };
  const submittedValues = Object.fromEntries(Object.entries(write.values).flatMap(([name, value]) => (value === null ? [] : [[name, value]])));
  const blockReason = sent ? null : facts.blockReason;
  const submittedAt = facts.submittedAt === null ? null : timeOf(facts.submittedAt);
  const startedAt = timeOf(input.startedAt);
  const finishedAt = timeOf(input.finishedAt);
  const targetRecordId = updateTargetRecordIdOf(write);
  const update: ActionRunUpdate | undefined = targetRecordId === null
    ? undefined
    : { targetRecordId, updateEvidence: facts.updateEvidence ?? null };
  const readVerification = readVerificationOf(facts);
  // T40b-1: 版 1.1 の送り方ごとの項目（1 回だけ求めて両方の文書に入れる）。API は、成否の条件なし、API の要約（ページが決める鍵の値は、照合まで進んだ
  // 送った回だけ）、送信先は API の path。form は今どおり。PL-6a: 版 1.2 は、成否の条件の代わりに結果の判定のしかたの印（form は `FORM_STRUCTURE`、API は null）。
  const transport: ScenarioTransport = isWorkerStartApiWrite(write) ? WORKER_API_WRITE_TRANSPORT : FORM_TRANSPORT;
  const api = isWorkerStartApiWrite(write) ? actionApiSummaryOf(write.api, sent ? facts.apiPageKeyValues ?? null : null) : null;
  const resultJudgement = write.verification.resultJudgement;
  const actionPath = isWorkerStartApiWrite(write) ? write.api.request.pathShape : write.request.path;
  const actionRun: ActionRunDocument = {
    schemaVersion: ACTION_RUN_SCHEMA_VERSION,
    ...identity,
    grantId: write.grantId,
    seedRecord: write.seedRecord,
    submittedValues,
    resultJudgement,
    submission: facts.submission,
    blockReason,
    httpStatus: facts.httpStatus,
    responseJudgement: facts.responseJudgement,
    recordId: facts.rawRecordId,
    readVerification,
    reservationState: reservationSettlementOf(facts.submission, facts.httpStatus !== null),
    result: outcome.result,
    reason: outcome.reason,
    startedAt,
    submittedAt,
    finishedAt,
    ...(update === undefined ? {} : { update }),
    // T40c: 版 1.1 の送り方と API の要約（form の書き込みは `FORM` で要約なし）。T40b-1: API の書き込みは `API` と要約。
    transport,
    api,
    // T44e（Task 44 の設計書 P2-4）: 送らずに止めた具体的な理由（`PRECHECK_FAILED` のときで、分かったときだけ。任意の項目なので版は上げない）。
    ...(blockReason === PRECHECK_FAILED && facts.precheckDetail !== undefined ? { precheckDetail: facts.precheckDetail } : {}),
  };
  const evidence: ActionEvidenceDocument = {
    schemaVersion: ACTION_EVIDENCE_SCHEMA_VERSION,
    ...identity,
    kind: write.approvalFacts.scenario.kind,
    containsHumanEnteredValues: containsHumanEnteredValuesOf(facts),
    // OP-L（L1）: 候補が合わなかったときは、どこが違ったか（値を含まない）を添える。
    precheck: {
      candidateDigestMatched: facts.candidateDigestMatched,
      blockReason,
      ...(facts.candidateDigestMatched === false && facts.candidateMismatch !== undefined ? { candidateMismatch: facts.candidateMismatch } : {}),
      // OP-O（O1）: 書き込みの段の、確かめ・入力・押す操作の失敗（送らずに止めたときだけ。値と、値の長さを含まない。画面には出さない）。
      ...(blockReason === PRECHECK_FAILED && facts.inputFailure !== undefined ? { inputFailure: facts.inputFailure } : {}),
    },
    submission: sent
      ? { state: facts.submission, submittedValues, actionPath, submittedAt }
      : { state: facts.submission, submittedValues: {}, actionPath: null, submittedAt: null },
    response: sent
      ? { httpStatus: facts.httpStatus, judgement: facts.responseJudgement, judgedAt: facts.judgedAt === null ? null : timeOf(facts.judgedAt) }
      : null,
    recordId: facts.rawRecordId,
    update: update ?? null,
    readVerification: facts.readEvidence ?? {
      readCheckId: write.readVerification.readCheckId, readCheckRevision: write.readVerification.readCheckRevision, state: READ_NOT_EXECUTED_STATE,
    },
    guard: facts.guard,
    result: outcome.result,
    reason: outcome.reason,
    startedAt,
    finishedAt,
    transport,
    api,
  };
  const approvalSummary: ApprovalSummaryDocument = {
    ...write.approvalFacts,
    schemaVersion: APPROVAL_SUMMARY_SCHEMA_VERSION,
    jobId,
    runId,
  };
  return { actionRun, evidence, approvalSummary };
}

/**
 * 書き込みのジョブを実行する（流れはファイルの先頭）。Run の外の失敗（成果物を書けない `ArtifactWriteError`、予期しない例外）は、そのまま reject する
 * （ワーカーの流れが `classifyCliFailure` で `FAILED` にする）。送信の報告を送っていなければ、reject の前に送る（送ったかは分からないとは言わない:
 * 書き込みの段の前の失敗なので `NOT_SENT`）。
 */
export async function executeWriteCreateRun(request: WriteCreateRunRequest, observer: WriteCreateRunObserver): Promise<WriteCreateRunOutcome> {
  const outputDirectory = resolve(request.config.output.directory);
  const writer = new ArtifactWriter({ urlSecretRedaction: true });
  const run = await startWorkerRun(outputDirectory, request.clock);
  if (run.kind !== 'STARTED') {
    request.reportSubmission({ submission: 'NOT_SENT', blockReason: PRECHECK_FAILED });
    return run;
  }
  const { runId, runDirectory, startedAt } = run;
  const reporting: SubmissionReporting = { reported: false, stageEntered: false };
  try {
    // 知らせの口の例外でも、監査中の印を離す（finally の `endWorkerRun`）。
    observer.onRunStarted({ runId, runDirectory });
    let facts: WriteFacts;
    try {
      facts = await performWrite(request, outputDirectory, observer, reporting);
    } catch (error) {
      // 予期しない失敗: まだ報告していなければ、書き込みの段の前なら `NOT_SENT`、段に入った後なら `UNKNOWN`（送ったかは分からない）を送る。
      if (!reporting.reported) {
        reporting.reported = true;
        request.reportSubmission(reporting.stageEntered
          ? { submission: 'UNKNOWN', blockReason: null }
          : { submission: 'NOT_SENT', blockReason: PRECHECK_FAILED });
      }
      throw error;
    }
    const readVerification = readVerificationOf(facts);
    // T31g-2: UPDATE は、対象の ID と更新の後の照合の結果も渡す（締めの `scenario-store.ts` と同じ判定）。T41d: API の更新も同じ。
    const targetRecordId = updateTargetRecordIdOf(request.write);
    const outcome = actionOutcomeOf(facts.submission === 'NOT_SENT'
      ? { submission: 'NOT_SENT', blockReason: facts.blockReason ?? PRECHECK_FAILED }
      : facts.submission === 'UNKNOWN'
        ? { submission: 'UNKNOWN' }
        : { submission: 'SENT', responseJudgement: facts.responseJudgement, recordId: facts.rawRecordId,
          readVerification: readVerification?.result ?? null,
          ...(targetRecordId === null
            ? {}
            : { update: { targetRecordId, fieldsMatched: fieldsMatchedOf(facts.updateEvidence ?? null) } }) });
    const documents = writeRunDocumentsOf({ jobId: request.jobId, write: request.write, runId, startedAt, finishedAt: request.clock(), facts, outcome });
    // T32f: HTML の報告とバンドルは、書くのと同じ手順（伏せ字・スキーマ・書式）に通した 3 つの文書から 1 回だけ組み立てる（照合の READ の URL は伏せ字の
    // 後。バンドルの中の JSON は、書くファイルと同じバイト列）。
    const presentation = createActionPresentation(await writer.prepareActionReport(runDirectory, documents));
    // T32e・T32f: 書き込みの報告（2 つの JSON、HTML、バンドル）を先に、`action-run.json` を最後に書く（どれかが書けなければ、`action-run.json` が書けない
    // ときと同じく reject する。親は `action-run.json` を読めないジョブを、送信の報告から締める。`action-run.json` だけがあって報告がない Run を作らない）。
    await writer.writeApprovalSummary(runDirectory, documents.approvalSummary);
    await writer.writeActionEvidence(runDirectory, documents.evidence);
    await writer.writeActionPresentation(runDirectory, {
      reportHtml: presentation.reportHtml,
      bundle: { bytes: presentation.bundleBytes, finishedAt: documents.actionRun.finishedAt },
    });
    await writer.writeActionRun(runDirectory, documents.actionRun);
    const runStatus = writeRunStatusOf(outcome.result, facts);
    return { kind: 'RAN', runId, runDirectory, runStatus, exitCode: EXIT_CODES[runStatus], result: outcome.result };
  } finally {
    // 保存の状態は書かない（再開の対象にしない）。出力先のロックを離す。
    await endWorkerRun(run);
  }
}
