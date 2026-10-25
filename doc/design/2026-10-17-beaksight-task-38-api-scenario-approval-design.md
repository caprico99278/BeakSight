# Task 38 設計書 — API の候補のシナリオと承認

状態: ユーザー承認済み（2026-10-17「承認する（推奨）」。3.4 の判断は 7 章の履歴）
作成: 2026-10-17（設計者）
ロードマップ: `2026-10-16-beaksight-task-33-42-roadmap.md` の Program E の Task 38。12 章の最後の行（ユーザーの判断「Program Eは設計・実装に関しては先んじて進めておきたい」。実テスト環境での確かめはロードマップの最後）。

## 1. 目的

Task 37 の probe が見つけた API の登録・更新の候補（`submissionProbe.result` が `API_CREATE`・`API_UPDATE`）を、シナリオにして承認できるようにする。承認は、ページが送る要求の型（method、Origin、path の型、query、ヘッダの名前、本文の鍵と JSON の型、鍵と欄の対応）を結ぶ。承認だけでは書き込まない（書き込みは Task 39〜41）。

## 2. 前提（読み取り専用の調査で確かめた事実）

- シナリオは `CREATE`・`UPDATE` の 2 種類、状態は `DRAFT`・`APPROVED`・`REVOKED`。承認の後に、実行の許可（`issueExecutionGrant`）を別に出す。承認だけでは許可を出さない。
- 下書きの確かめは、分類が CREATE・UPDATE の form の POST の候補だけを受ける（`scenario-policy.ts` の `scenarioKindOf`・`requestShapeOf`）。`NEEDS_BINDING` の候補（probe の対象）は、今はシナリオにできない。有効性の確かめも分類と kind の一致を見るので、必ず落ちる。
- 承認の digest は v3（`beaksight-approval/3`、25 項目）。承認した API の Origin はプロファイルの項目なので、変えればプロファイルの改訂で再承認になる。
- **probe の記録の不足 1**: 型の `markerKeys` は目印の番号しか持たず、どの欄の目印かを成果物に残していない。番号は 1 画面の中で押すたびに足していくので、2 回目以降の押下の型の digest は、前に押した欄の数で変わる。
- **probe の記録の不足 2**: `BUTTON` の候補は欄（`fields`）を持たない。実テスト環境の登録と更新の画面は form がない（Task 33 の観察）ので、`BUTTON` を扱えないと実環境で使えない。欄に `name` がない SPA もありうる。
- 入力の規則と値の作り方は、form の欄の名前を鍵にしている。
- 書き込みの照合の READ に、画面の path の READ は今は使えない（T37d で拒んだ）。
- 管理データの最新は版 12（G37・G43 の承認の後なので、Task 38 は版 13 にする）。

## 3. 設計

### 3.1 probe の記録を足す（T38a）

- probe は、目印ごとに、目印を入れた欄の識別を記録する: 欄の `name`（あれば）と、その画面で一意な CSS（T43c の組み立ての部品）、欄の種類（text・email・number・select など）。値は記録しない。
- 目印の番号は押下ごとに 0 から振り直す（型の digest が、前に押した欄に左右されない）。
- `BUTTON` の候補も、押す前に入れた欄（form の外の欄）を、上と同じ形で候補の欄の範囲として記録する。
- 発見の索引に型の digest の一覧を足し、シナリオが型で候補の行を選べるようにする（同じ識別で型が違う行が別に残るため）。
- 前の発見の結果は、型の digest が変わるので、発見をやり直す必要がある（文書に書く）。

### 3.2 シナリオの契約（T38b）

- シナリオに「送り方」を足す: `FORM`（今のまま）か `API`。
- API のシナリオは、次を持つ:
  - 要求の型: method（`POST`・`PATCH`）、Origin の文字列（承認した API の Origin の一覧の番号でなく文字列）、path の型、query の名前（`select` だけを許す。UPDATE は filter の名前 1 つ）、`Content-Type` の媒体の型、`Prefer` の閉じた一覧の値、型の digest。
  - 鍵と欄の対応: 本文の鍵ごとに `{鍵, JSON の型, 欄の識別}`。
  - 許すヘッダの名前（3.4 の判断）。
  - UPDATE: filter の名前（例 `id`）と、その値が台帳の ID であること。
- 下書きの確かめで拒むもの: 型が `API_CREATE`・`API_UPDATE` でない、`stateKeyPresent`（論理削除の鍵）、method の上書き、送る欄が鍵にちょうど 1 つ対応しない、欄の型と JSON の型が合わない、欄に対応しない鍵（3.4 の判断）。I21 の項目を、probe の分類とは別に、もう一度ここで照らす。

### 3.3 承認の digest v4 と有効性（T38c）

- 印を `beaksight-approval/4` にし、API のシナリオでは送り方、要求の型、鍵と欄の対応、許すヘッダの名前、UPDATE の filter の名前を項目に足す。FORM のシナリオの項目は今のまま（v4 の印で求め直す）。
- 有効性: API のシナリオは、分類と kind の一致の代わりに、索引の型の digest とシナリオの `shapeDigest` の一致を見る。型が変われば再承認。
- 承認の画面に、型の要約（method、Origin、path の型、鍵、filter の名前、ヘッダの名前）を出す。filter の列の名前は目立たせる（Task 37 の限界: 列の名前は見ない）。

### 3.4 ユーザーの判断が要ること（下の 5 章で諮る）

- 欄に対応しない本文の鍵（ページが決める値。例: テナントの ID）を許すか。
- 許すヘッダの名前を承認に結ぶか。
- API のシナリオの照合の READ に、`{id}` つきの画面の path の READ を許すか。
- 承認の後、Task 40 まで API のシナリオの実行の許可を出さないこと（設計者の既定。重ねの守り）。

### 3.5 管理データ（T38d）

- 版 13: 索引の型の digest の一覧、シナリオの送り方（版 12 の値は写しで固定してから）。

### 3.6 入力の規則（T38e）

- 値は今どおり DOM の欄に入れ、ページの JS が JSON を組み立てる。欄の識別は、`name` があれば名前、なければ CSS。
- 値を JSON の型に変える部品を 1 か所に置く（Task 39 の照合が使う）。

### 3.7 画面（T38f）

- 発見の結果の画面から、API の候補のシナリオを作れるようにする。シナリオの画面に、送り方と型の要約、鍵と欄の対応を出す。

## 4. 安全

- 承認だけでは書き込まない。Task 40 まで API のシナリオに実行の許可を出さない（理由を出す）。
- 型・鍵・欄の対応は、値を持たない（I22）。
- I21 の項目は、probe の分類、シナリオの下書き、Task 39 の Guard の 3 か所で照らす。

## 5. 受け入れ条件（G38）

1. fixture の form のない登録と更新の画面（`memberScreenLayout: 'formless'`）で、発見 → シナリオ → 承認ができる。承認の後も、許可は出ない。
2. 再承認の条件: 型、Origin、path、鍵、欄、許すヘッダの名前、filter の名前、プロファイルの改訂のどれかが変われば再承認。
3. I21 の形（論理削除の鍵、method の上書き、array、filter なし など）は、下書きで拒む。
4. 値が管理データ・成果物・画面に残らない。
5. 回帰: FORM のシナリオ（Task 28〜32）のテスト。独立レビュー。

## 6. 実装計画

| サブタスク | 内容 | 主なファイル |
| --- | --- | --- |
| T38a | probe の目印と欄の対応、番号の振り直し、BUTTON の欄の範囲、型で行を引く口 | `src/interaction/submission-probe.ts`、`src/discovery/submission-probe-contracts.ts`、`src/core/api-request-shape.ts`、`schemas/control/candidate.schema.json`、`src/control/discovery-candidate-lookup.ts` |
| T38b | シナリオの契約と下書きの確かめ | `src/control/approval/scenario-contracts.ts`・`scenario-policy.ts`、`schemas/control/scenario.schema.json` |
| T38c | digest v4 と有効性 | `approval-digest.ts`・`approval-validity.ts`・画面の差分 |
| T38d | 管理データ v13 | `migrations.ts`、`discovery-index-store.ts`、`scenario-store.ts`・`scenario-facts.ts` |
| T38e | 入力の規則の JSON の型と値の変換 | `src/control/data-rules/` |
| T38f | 画面と G38 の確かめ | `apps/local-ui/` |

順: T38a → T38b・T38d → T38c・T38e → T38f。DEF-125・DEF-130 の修正（Guard と中継）とは変えるファイルが重ならない。

## 7. 設計の変更の履歴

| 日付 | 理由 | 変更 |
| --- | --- | --- |
| 2026-10-17 | 作成 | 読み取り専用の調査（シナリオと承認の作り）に基づいて書いた。BUTTON の候補を扱うこと（実環境の画面に form がないため）を設計に入れた。 |
| 2026-10-17 | ユーザーの判断 | 設計を承認（「承認する（推奨）」）。(1) 欄に対応しない本文の鍵は「承認で名前を示した鍵だけ許す」: 鍵の名前と JSON の型を承認に結び、値は照らさず、実行したときの値を記録に残す。秘密に見える名前の鍵は拒む。(2) ヘッダの名前は「結ぶ。ブラウザが付ける名前は除く」: ページが付ける名前を承認に結び、Chromium が付ける名前（`accept`・`sec-fetch-*` など）は閉じた一覧で除く。(3) 照合の READ は「API のシナリオだけ許す」: `{id}` つきの画面の path の READ を API のシナリオの照合に使える（`{id}` には台帳の ID だけ）。FORM のシナリオは今のまま。(4) Task 40 まで API のシナリオに実行の許可を出さない（設計者の既定のまま）。 |
| 2026-10-17 | T38b の報告 | (1) API のシナリオの `fieldNames` は送る本文の鍵（欄は `api.keyFields[].field` の `NAME` か `SELECTOR`）。(2) 型の Origin は probe の時の承認したサービスの Origin の一覧の番号なので、下書きの確かめで、発見のジョブのプロファイルの改訂が今の改訂と同じであることを求める（違えば発見をやり直す）。T38c で入れる。(3) select の欄は目印で鍵と対応しないので、その鍵はページが決める鍵として承認する。 |
| 2026-10-17 | T38e の Blocker（規則の確かめの理由の契約） | 規則の確かめの理由の閉じた一覧 `RULE_CONFLICT_DETAILS`（文書にも Schema にも入らない）に、API の鍵の細分 `PAGE_KEY_RULE_NOT_ALLOWED`・`JSON_VALUE_TYPE_MISMATCH` を足す。限界: API の BUTTON の候補の欄は probe の `inputFields`（名前・CSS・種類・目印）だけで、制約（maxlength・pattern・min・max・required・選択肢）を持たないので、欄の制約に基づく確かめが効かない。Task 39 の照合は値の型と正規の形に頼る。 |
| 2026-10-17 | T38c の Blocker（照合の READ の `{id}`） | (1) READ の定義の `targetPagePath` に、区切り 1 つだけを `{id}` にした型を許す（ID は台帳の ID の安全な形だけ、保存の確かめは代わりの値で今の画面の READ の確かめを通す）。(2) シナリオの照合の READ の `bindings` の Schema を `minItems: 0` にし、方針で FORM と候補の READ は 1 件以上、API で `{id}` の型の画面の READ のときだけ 0 件を求める。(3) 保存と開始は API の型の READ だけ通し、IPC は Task 40 で開く。(4) 承認の digest v4 に `apiLedger`（台帳の参照）も入れる。(5) 限界: API の UPDATE は型にした識別の digest を持たないので、記録の画面を次の発見で読み直さないと `CANDIDATE_MISSING` になる（Task 41 で扱う）。 |
| 2026-10-17 | T38f の報告（ヘッダの名前と再承認） | 型の digest にページが付けるヘッダの名前（`isPageSuppliedHeaderName` を通した名前）を入れ、版の印を `beaksight:api-shape/2` に上げる（Task 37 の 8 章で外したのは Chromium が付ける名前を含む一覧だったため。ブラウザが付ける名前を除けば Chromium の更新で変わらない）。これでページが付けるヘッダが変われば型が変わり、有効性で `CANDIDATE_SHAPE_CHANGED` になる。下書きの確かめで敵対的な送り方の理由は、probe の分類が先に `NOT_EXECUTABLE` にするので `SCENARIO_API_CANDIDATE_NOT_API` にまとまる（具体的な I21 の理由は偽った probe のときの重ねの守り）。 |
| 2026-10-17 | T38R（Critical 2、Important 2、Minor 3。承認だけで書き込みが始まる経路と値が残る経路はなし） | (C-1) 索引の型の digest は、結果が `API_CREATE`・`API_UPDATE` の probe の型だけにする。下書きでは probe の要求の数で分類し直し、記録できなかった型がある probe を拒む。(C-2) 承認の口と有効性の API の分岐で、シナリオの Origin が今のプロファイルの承認したサービスの Origin の一覧の同じ番号にあること、索引を書いた最新の発見のジョブの改訂が今の改訂と同じことを求める。(I-1) 鍵と欄の対応（欄の識別）が変われば再承認になるよう、索引と有効性で照らす。(I-2) ページが決める鍵と登録の ID の鍵の秘密に見える名前は部分一致の fail-closed の方針で拒み、ページが決める鍵の JSON の型は scalar に限る。(M-1) `{id}` の型は前に固定の区切りを 1 つ以上求め、Task 40 で実際の ID を入れた path に保存の時と同じ確かめをかけ直す。(M-2) probe の結果と kind の対応、ページが付けるヘッダの名前の正規化を 1 か所に。 |
| 2026-10-17 | T38R2（Critical 0、Important 1、Minor 4。前の指摘はすべて直った） | (R2-I-1) 索引の型の一覧は、まとめる前の全部の行から作り、同じ識別で書き込みでない probe に出た型の digest は、書き込みの probe にあっても除く（押した順で結果が変わらないよう、止める側に倒す）。(R2-M-1) 方針 6 に NFKC、語の後の数字を落とした比べ、頭字語の境目、`csrf`・`xsrf`・`passcode`・`passphrase`・`pincode`・`cvv`・`cvc` などの語を足す。(R2-M-2) 欄の種類を鍵と欄の digest に入れる。(R2-M-3) 版 13 をその場で変えたので、開発中の版 13 の DB は作り直す（開くときに列の有無を確かめ、ない場合は整合性の誤りにする）。限界: 偽った成果物は下書きを通る（守りは索引で効く）、`{id}` の前の固定の区切りは意味のない区切りでも受ける、名前のある欄は CSS が変わっても再承認にならない。 |
| 2026-10-17 | T38R2-fix の報告 | (R2-I-1) は、索引を別に作る代わりに、まとめの部品 `firstOfEachShape` で同じ型の鍵に書き込みでない行があればそれを残す形で実装した（索引・候補の引き当て・画面が同じまとめた後の行を使うので、同じ効果になる。下書きは `SCENARIO_API_CANDIDATE_NOT_API` で拒む）。(R2-M-1) 判定を `src/discovery/classify.ts` へ移した（NFKC と語の分け方の owner に合わせる）。語の一覧に日本語の語を足したため、GATE-UI06 の除外に `src/core/secret-query-names.ts` を足した。限界: キリル文字などの形の似た文字（例: キリルの о を混ぜた token）と、数字で書き換えた語は当たらない。`encryption_key`・`license_key`・`hmac`・`salt`・`security_code`・`card_number`・`ssn`・`refresh` はまだ当たらない（足すかは Task 41 の設計で決める）。(R2-M-2) 欄の型を鍵と欄の digest と承認の digest に入れ、形の印を `beaksight:api-key-fields/2` にした。(R2-M-3) `assertControlSchemaColumns` を開くときに呼ぶ。 |
