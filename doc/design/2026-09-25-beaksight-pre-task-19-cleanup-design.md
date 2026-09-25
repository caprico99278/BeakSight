# BeakSight Task 19 の前の整理 設計書

作成日: 2026-09-25
対象範囲: Task 18 の後、Task 19（fixture の全体の監査と README）に進む前に行う整理

## 1. 目的

Task 19 は、実際の CLI で fixture を最後まで監査し、README を書く Task である。その前に、次のことを済ませる。

- 安全の不変条件 S03 の穴（DEF-012）を直す。
- Task 14〜18 のレビューで「Task 18 の後」に回した項目を片付ける。

## 2. 根拠となる文書と優先順位

- 実装タスク指示 `doc/design/2026-08-27-beaksight-implementation-tasks.md`（Safety Invariants、完了の意味、禁止事項）
- 上位の設計書 `doc/design/2026-08-27-beaksight-web-audit-design.md`
- Task 18 の設計書 `doc/design/2026-09-25-beaksight-task-18-acceptance-gates-design.md`
- 作業記録置き場の次の文書
  - 不具合台帳 `defects.md` の DEF-012
  - 共通化候補台帳 `commonization-candidates.md` の CC-008、CC-010、CC-029、CC-030
  - レビューの結果 `R18-review-result.md`、`RP18r-review-result.md`

この設計書は、上の文書の該当する部分を拡張する。食い違う場合は、この設計書が優先する。

## 3. 対象の一覧

| ID | 内容 | 出どころ |
| --- | --- | --- |
| DEF-012 | ページのスクリプトによる外部スキームへの移動を、Guard が検出も記録もしない。headed では、外部のアプリが起動しうる | R18 の M3 と、その調査 |
| R18-M1 | GATE-ARCH04 の検出が、`allowedOrigins.has(new URL(url).origin)` などの書き方を見逃す | R18 |
| R18-M2 | GATE-S08 の Interaction の確認が、click が行われたことを確かめていない | R18 |
| R18-参考 | `src/audit/safety-rules.ts` の変数名 `example`（実装タスク指示 第6章の文言に反する） | R18 |
| RP18r-M1 | PREFLIGHT が失敗した場合に、閉じる処理の失敗をメッセージに残さない | RP18r |
| RP18r-M2 | 幅の走査の、閉じる処理の期限切れが、理由から読み取れない | RP18r |
| BOM | `tests/unit/text.test.ts:12` の、見えない BOM の文字 | P18e |
| CC-029 | Gate と統合テストの補助の重複。共通のハブのページの fixture | T18b、T18c |
| CC-030 | UI Gate の文字列リテラルの取り出しの近似（R18 の M4 と同じ） | T18e、R18 |
| CC-008 の残り | `discover-candidates.ts` の中の複製 | 基盤修正の設計書 |
| CC-010 の残り | Interaction の理由の欄で、コードと英文が混ざっている | 基盤修正の設計書 |

## 4. DEF-012: 外部スキームへの移動

### 4.1 調査の結果（2026-09-25。headless だけで実験した）

- ページのスクリプトが外部スキーム（`tel:`、`mailto:`、独自のスキーム）へ移動しようとしても、Guard は止めない。Ledger にも記録しない。
  - 試した経路: `location.href`、`location.assign`、meta refresh、iframe の src、スクリプトによる anchor の click、form の action、本物の click による移動
  - 外部スキームはネットワークを通らないので、`context.route('**/*')` と CDP の `Fetch` が働かない。
  - Playwright の `request` の事象は、どの経路でも来る。続いて `requestfailed(net::ERR_ABORTED)` が来る。
    - Guard の `onRequestFailed` は、分類が BLOCK なので、何もしない（`passive-request-guard.ts:1242-1300`）。
  - `window.open` の場合は、別の理由（`FRAME_CLASSIFICATION_FAILED`）で違反になり、Context が閉じる。
- headless（`chrome-headless-shell`）では、外部のアプリは起動しなかった。このバイナリには、外部のアプリへ URL を渡す仕組みがない（観測と推定）。
- headed（完全版の Chrome for Testing）では、外部のアプリが起動しうる（推定。確度は高い）。
  - `mailto:` は、確認なしに OS の既定のアプリへ渡る。
  - `tel:` と独自のスキームでは、確認のダイアログが出る。
  - OS への引き渡しと、Playwright の事象は並行して起きる。そのため、Guard の側で確実に止める方法はない。

### 4.1.1 RC18a の結果による訂正（2026-09-25）

- 4.1 の「Playwright の `request` の事象は、どの経路でも来る」は、Guard を付けた状態では成り立たない。
  - サーバのリダイレクト（3xx の `Location` が外部スキーム）の場合、外部スキームへの `request` の事象が来ない。
    - 例: iframe が許可 Origin の URL を読み、`302 Location: <外部スキーム>` が返る場合
    - この場合、リダイレクトの元のリクエストが、`net::ERR_ABORTED` で失敗するだけである。
  - main frame のリダイレクトでは、既存の `HTTP_MAIN_FRAME_DELIVERY_FAILED` の違反になる。ただし、外部スキームが原因であることは、読み取れない。
- 広告の iframe などで、実際のサイトでも起こりうる。

### 4.2 方針

- **検出して記録する。**
  - Guard は、navigation のリクエストのうち、URL のスキームが次の一覧にないものを、外部スキームへの移動の試みとして検出する。
    - 一覧: `http:`、`https:`、`about:`、`data:`、`blob:`
  - 検出の手がかりは、Playwright の `request` の事象（`request.isNavigationRequest()`）とする。
  - 対象: main frame、subframe、Passive の段階、Interaction の段階（凍結の前後）のすべて
  - 検出した試みは、Safety Ledger の新しい事象の一覧 `externalSchemeNavigations` に記録する。
    - 持つもの: URL（伏せ字の規則に従う）、スキーム、frame の種類（main か sub）、段階（Passive か Interaction）
  - この新しい事象の一覧は、次のものにも合わせて加える。
    - `SafetyEventsEvidence`
    - `SAFETY_EVENT_KINDS`
    - スキーマ
    - `SAFETY_EVENT_KIND_CATALOG`
    - `messages.ts`
    - 記録の上限
- **headed では、違反として扱う。**
  - headed で動いている場合に外部スキームへの移動を検出したら、次のようにする。
    - 不変条件の違反（例: `EXTERNAL_SCHEME_NAVIGATION_IN_HEADED_MODE`）として記録する。
    - Context を閉じる（invalidation）。
    - Run は `ABORTED_BY_SAFETY` になる。
  - 理由: headed では、外部のアプリが起動したかもしれない。止められなかった可能性を隠さず、正直に報告するためである。
  - Guard が headed かどうかを知るために、factory から Guard の取り付けに、headed かどうかを渡す。
    - 値の出どころは、設定（`config.browser.headed`）の1つだけとする。
- **headless では、違反にしない。**
  - 記録だけにする。
  - 理由: headless のバイナリには、外部のアプリへ渡す仕組みがない。そのことを、実験で確かめた。
  - 記録した事象の Finding の扱いは、既存の `blockedExternalActions` と同じ考え方にする（`safety-rules.ts`）。
- **サーバのリダイレクトは、たどる前に止める**（RC18a の指摘1を受けて、2026-09-25 に追加）
  - Guard は、Document のリクエスト（main frame と subframe）の応答の段階で、3xx の `Location` を調べる。
  - `Location` が外部スキーム（許可するスキームの一覧にないもの）なら、リダイレクトをたどる前に、リクエストを失敗させる。
  - 失敗させたことは、`externalSchemeNavigations` に記録する。止めたことが分かる形にする（例: 理由のコードを分ける）。
  - この経路は、止めて防げる。そのため、headed でも違反にしない。
  - main frame のリダイレクトを止めた場合も、同じく記録する。
    - そのときに、既存の `HTTP_MAIN_FRAME_DELIVERY_FAILED` の違反が出るかどうかを、実装者が確かめて報告する。
    - 緩めるかどうかは、その報告を見て、設計者が決める。
  - 応答の段階での横取りの方法は、実装者が決めて報告する。
    - 例: CDP の `Fetch` の Response の段階。
    - Guard の既存の fail-closed の扱いに合わせる。
- **既存の違反の扱いは、緩めない。**
  - `window.open` による外部スキームは、今は `FRAME_CLASSIFICATION_FAILED` の違反になる。これは、そのまま残す。
  - あわせて `externalSchemeNavigations` にも記録できる場合は、記録する。
- **Gate を広げる**（GATE-S03）
  - 4.1 の経路と3つのスキームで、次のことを確かめる。
    - Passive の段階と Interaction の段階の両方で、`externalSchemeNavigations` に記録される。
    - page の URL が変わらない。
    - サーバには、そのページの GET だけが届く。
  - headed の扱いは、headless のブラウザの中で、Guard に「headed である」と注入して確かめる。
    - 違反が記録され、Context が閉じることを確かめる。
    - 実際の headed のブラウザは、テストで起動しない。外部のアプリが起動するおそれがあるためである。
  - 独自のスキームの fixture を加える。
- **Guard のレビュー**
  - Guard のファイルを変えるので、修正の後に、Guard の独立レビューを行う。

### 4.2.1 止められる経路と、止められない経路の整理

| 経路 | 止められるか | headless | headed |
| --- | --- | --- | --- |
| サーバのリダイレクト（main と sub。OOPIF を含む） | 止められる（Guard がリダイレクトの前に失敗させる） | 記録 | 記録（違反にしない） |
| ページのスクリプトによる移動（4.1 の7経路など） | 止められない | 記録 | 記録と違反、Context を閉じる |
| `window.open`、`<a target=_blank>` | 既存の違反で Context を閉じる | 既存の違反 | 既存の違反と、headed の違反 |

- **OOPIF（別のプロセスの iframe）の扱い（RC18b の N1 を C18i で直した。RC18c で確かめた。2026-09-25）**
  - 上の表の「サーバのリダイレクト」には、OOPIF と入れ子の OOPIF の中のリダイレクトも含む。
  - Guard は、page の CDP の session で `Target.setAutoAttach`（`waitForDebuggerOnStart`）を使い、OOPIF にも同じ横取りを付ける。横取りを付けるまで、OOPIF は進まないので、時間の窓はない。
  - Gate（GATE-S03）は、`--site-per-process` の headless で、OOPIF ができていることを確かめてから試す。レビューでは、`channel: 'chromium'` の headless でも確かめた。
  - 残る制約:
    - 1つの page の OOPIF の数が、上限（64件）を超えると、fail-closed の違反（`OOPIF_GUARD_ATTACH_FAILED`）になる（DEF-014）。
    - 付与に失敗すると、fail-closed の違反になる。
    - 付与の途中で OOPIF が消えた場合は、違反にしない。横取りする frame がないためである。
    - fenced frame と、先読み（speculation rules）の page は、別の種類の target である。これらが横取りの対象になるかは、確かめていない。
    - スクリプトによる外部スキームへの移動は、今までどおり止められない（表の2行目）。

### 4.3 Task 20 への影響（ユーザーの判断が必要）

- 実装計画の Task 20 は、実サイトの smoke を headed で行う予定である。
- 4.1 のとおり、headed では、外部のアプリの起動を確実には防げない。4.2 の対策は、起きたことを正直に記録して、Run を止めるものである。起動そのものは防げない。
- そのため、Task 20 の前に止まったときに、次のどれにするかを、ユーザーに尋ねる。
  1. smoke を headless で行う（推奨）
  2. headed で行う場合は、`mailto:` や `tel:` の既定のアプリがない、隔離した環境（Windows Sandbox、VM、別のユーザーなど）で行う
  3. そのほかの方法
- README（Task 19）には、headed の実行で外部のアプリが起動しうることと、その対策を書く。
- **ユーザーの判断（2026-09-25）: Task 20 の smoke は、headed で行う。**
  - これにより、次のことを受け入れた扱いとする。
    - headed の smoke で、ページのスクリプトが外部スキームへ移動した場合は、外部のアプリ（例: `mailto:` の既定のアプリ）が起動しうる。
    - その場合、4.2 の対策で違反として記録され、Run は `ABORTED_BY_SAFETY` になる。
  - 4.2 の対策（検出、記録、headed での違反）は、この判断の後も、予定どおり実装する。
  - Task 20 の実行の前に、この扱いを改めてユーザーに示す。
- **ユーザーの判断（2026-09-25）: smoke テストの対象は、https://demo.playwright.dev/todomvc/ とする。本来の監査対象のサイトへは、機能の完成までアクセスしない。**
  - 上位の実装計画の Task 20 は、`config/targets/example.json`（本来の監査対象）で smoke を行うことになっている。この部分を、次のように読み替える。
    - smoke の対象: https://demo.playwright.dev/todomvc/
    - 設定: smoke の専用の target の設定を、別に置く。置き場所と形は、Task 20 の着手の前に設計する。
    - 実行の条件（上位の計画のとおり）: `maxPages=5`、headed、並行は1
    - 実行の前に、すべての Gate が PASS していること（上位の計画の Step 1）
  - Task 21（本来の監査対象の full audit）は、機能の完成と、ユーザーの明示の承認を得てから行う。

### 4.5 違反の後は、監査を続けない（RC18a の指摘2を受けて、2026-09-25 に追加）

- どんな種類の違反でも、Run は最後に `ABORTED_BY_SAFETY` になる。違反の後も監査を続けると、危険（headed での外部のアプリの起動など）を繰り返すだけである。
- そのため、違反を検出した後は、新しい監査を始めない。
  - 新しいページを始めない。残りのページは、理由付きの `SKIPPED` にする。
  - 同じページの、次のビューポートも始めない。
  - Interaction の、次の候補も始めない。
- 理由のコードは、既存のもので表せなければ、新しいもの（例: `SAFETY_VIOLATION_ABORT`）を加える。
  - その場合は、スキーマ、`messages.ts`、UI05 も合わせて直す。
- 違反の検出の時点は、次のどちらかにする。どちらにするかは、実装者が決めて報告する。
  - Run Coordinator が、各ページの後に、Ledger の登録を調べる。
  - 違反の通知を受ける。
- すでに始めた処理の後始末（Context と Browser を閉じること）は、今までどおり行う。
- 書き出し（artifact、HTML、バンドル）は、今までどおり行う。違反の記録と、止めたことを、正直に残す。
- **制約（RC18b の N3）**: 違反を確かめるのは、新しいページ、ビューポート、幅、候補、再試行、metadata を始める前だけである。
  - Context を閉じない種類の違反（例: `EXPECTED_CDP_FAILURE_LIMIT_REACHED`）の後は、同じ Passive の page の収集（scroll、スクリーンショットなど）が続き、GET が届きうる。
  - headed での外部スキームへの移動の違反は、Context を閉じる。そのため、この制約は、主な危険には当たらない。

### 4.6 DEF-013: 遅いリダイレクトの偽の違反（2026-09-25 に追加）

- 事実（C18g で再現した）:
  - サーバが、リクエストを受けてから1秒を超えてリダイレクトを返すと、`REDIRECT_PREDECESSOR_MISSING` の違反になる。
  - 普通の、同じ Origin への 302 でも起きる。main frame と iframe の両方で起きる。
  - 原因: `RedirectPredecessorRegistry` は、リクエストの段階で登録してから 1,000ms（`EXPECTED_CDP_FAILURE_RETENTION_MS`）で、登録を期限切れにする。
- 影響: 応答の遅い実サイトで、偽の違反になり、Run が `ABORTED_BY_SAFETY` になる。Task 20 の前に、必ず直す。
- 方針:
  - 登録の期限を、リクエストの開始から数えるのをやめる。**リダイレクトの応答を受けた時点から数える。**
    - Guard は、C18g で、Document の応答の段階（3xx）を見られるようになった。そこで登録する（または登録を更新する）。
    - 応答の段階を見られないリクエスト（Document 以外など）がある場合は、その扱いを、実装者が確かめて報告する。
  - 登録は、次のときに消す。
    - リダイレクトの後のリクエストで使われたとき（今と同じ）
    - 元のリクエストが終わったとき（完了か失敗）
    - Context が閉じたとき
  - 登録が無制限に増えないように、件数の上限を設ける。上限を超えた場合は、既存の fail-closed の扱いに合わせる。
  - 対応付けが見つからない場合に違反にする（fail-closed）扱いは、変えない。
  - `expectedCdpFailures` の期限（1秒）は、Guard 自身が失敗させた直後に使うものなので、変えなくてよい。そのことを、実装者が確かめて報告する。
- テスト:
  - `/__slow-redirect`（1.5秒）で、main frame と iframe の両方について確かめる。
    - 違反が0件であること
    - リダイレクト先まで読み込めること
  - 修正の前に RED になること。
  - あわせて、次の対照を置く。
    - 対応付けの本当の欠落は、今までどおり違反になること
    - 件数の上限を超えた場合の扱い

## 5. そのほかの項目

- **R18-M1**: GATE-ARCH04 の検出を広げる。
  - `.has(` と `.includes(` の引数に `origin` を含む場合（式や呼び出しを含む）を、検出する。
  - または、許可 Origin の集合を、owner の外で参照することを検出する。
  - 今の `src/` に違反がないことを、確かめる。
- **R18-M2**: GATE-S08 の Interaction の確認に、click が行われたこと（status が `REJECTED_UNSAFE` でないこと）を加える。Passive の側で、登録の試みが起きたことも確かめる。
- **R18-参考**: `src/audit/safety-rules.ts` の変数名 `example` を、意味の同じ別の名前（例: `sample`）に変える。Finding の文言は、変えない。
- **RP18r-M1**: PREFLIGHT が失敗した場合も、閉じる処理の失敗を、PREFLIGHT のメッセージに含める。
- **RP18r-M2**: 幅の走査の閉じる処理の期限切れが、理由から読み取れるようにする。
  - 例: 段階の理由の detail に、`CLOSE_DEADLINE_EXCEEDED` のような語を含める。
  - 新しい理由のコードは、加えない。既存のコードの detail で表す。
- **BOM**: `tests/unit/text.test.ts:12` の見えない BOM の文字を、表記（バックスラッシュと `uFEFF`）に直す。
- **CC-029**: Run の起動、Finding の取り出し、スキーマの確認、リクエストの確認、出力の取り込み、Guard のない対照の page、Browser の Proxy の補助を、`tests/helpers/` にまとめる。
  - 検証の内容は、各テストに残す。
  - 共通のハブのページ（404、壊れた画像、JS の例外、はみ出し、低いコントラストへのリンクを持つもの）を、fixture に加える。そのうえで、Auditor の Gate の Run の数を減らせるかを検討し、減らせる場合は減らす。
  - Gate の確認と対照の確認は、弱めない。
- **CC-030**: UI Gate の文字列リテラルの取り出しを、走査の `literals` に移す。規則を変えずに移せる方法を、実装者が報告する。
- **CC-008 の残り**: `discover-candidates.ts` の中の、`discoverInteractionCandidates` と `inspectInteractionCandidateHandle` の複製（走査、テキストの切り詰め、可視判定、アクセシブルネーム、候補の組み立て）を、1つにまとめる。
  - ブラウザの中で動く処理である。振る舞いを変えない。
  - 既存の Interaction のテストと Gate が、変更なしで PASS すること。
- **CC-010 の残り**: Interaction の `reason` の欄で、理由のコードと英文が混ざっている点を整理する。
  - 理由のコード（英数字）と、技術的な詳細（英文）を、分ける。
  - 表示の文言は、`messages.ts` に置く（UI 追補設計書）。
  - JSON の形を変える場合は、スキーマと表示用モデルも合わせて直す。変える前に、影響の範囲を報告する。

### 5.1 CC-010 の残り: Interaction の理由をコードと詳細に分ける（C18e の調べた結果を受けて、2026-09-25 に追加）

#### 5.1.1 今の状態（C18e の報告）

- Interaction の Evidence の `reason`、`work.reason`、`lifecycle.reason` は、どれも `string` である。値の出どころは、すべて `src/interaction/isolated-auditor.ts` である。
- 入る値は、次の4種類が混ざっている。
  - 理由のコード（`REJECTED_UNSAFE` の9種。`INTERACTION_REJECTION_REASONS`）
  - 英文（`NOT_VERIFIABLE` の55個のコードに対応する文。コードそのものは保存していない。ほかに `VERIFIED`、`BLOCKED_BY_SAFETY` の固定の文）
  - 英文と値の連結（`'<英文>: <completeness>'`、`'<英文> <identityStatus>'`、`'<英文>: <エラーの文言>'`）
  - 整えたエラーの文言（`EXECUTION_FAILED`）
- `CLICK_TIMED_OUT` の英文と、`EXECUTION_FAILED` の代わりの文言が同じで、英文だけでは見分けられない。
- 使う場所: Evidence の型（`evidence-types.ts`）、スキーマ（`page.schema.json` の `interactionEvidence`。どれも `type: string`）、表示用モデル（そのまま移す）、HTML（技術的な詳細として `renderCode` で示す。Task 14〜17 の設計書 6.1.5）。バンドルは `page.json` をそのまま入れる。Rule は `reason` を読まない。

#### 5.1.2 方針（案A を採る）

ページの未完了の理由（`IncompleteReason` の `code` と `detail`。説明は `messages.ts` の `INCOMPLETE_REASON_DESCRIPTIONS`、表示は `view-model.ts` の `reasonView`）と同じ考え方にそろえる。UI 追補設計書の「JSON の理由は英数字のコードにし、表示するときに日本語のラベルに変える」に従う。表示の言語は、UI 追補設計書で承認済みである。

- **Evidence の形**
  - `reason` を、閉じた一覧の理由のコード（`InteractionReasonCode`）にする。
  - `reasonDetail: string | null` を、必須の項目として加える。技術的な詳細（completeness の値、identityStatus の値、整えたエラーの文言）を入れる。詳細がないときは `null` にする。詳細に、コードの説明の英文を重ねて入れない。
  - `work` の `reason` も、同じ形（`reason` と `reasonDetail`）にする。
  - `lifecycle.reason` も、同じ形にする（理由がないときは `reason` と `reasonDetail` がどちらも `null`）。コードの一覧は、`InteractionLifecycleReasonCode` として別に持つ（`SESSION_NOT_OPENED`、`OWNER_CLOSE_TIMED_OUT`、`OWNER_CLOSE_FAILED`、`OWNER_CLOSE_NON_TERMINAL`。最後のものは C18n の洗い出しで加えた。Ledger の既存のコード `INTERACTION_OWNER_CLOSE_NON_TERMINAL` と名前をそろえる）。
  - `InteractionOwnerCleanupError` が持つ `lifecycle`（`InteractionNonTerminalLifecycle`）も、同じ形にする。
  - Safety Ledger の違反の文言（close の失敗、期限切れ、handle の破棄）は、変えない。安全の記録の形を、この整理で変えないためである。
- **コードの一覧**（`src/core/evidence-types.ts` に置く。意味の owner）
  - `REJECTED_UNSAFE`: 今の `INTERACTION_REJECTION_REASONS` の9種をそのまま使う。
  - `NOT_VERIFIABLE`: 今の `INTERACTION_NOT_VERIFIABLE_REASONS` のキー（55個。C18n の洗い出しで訂正）をそのまま使う。コードの一覧は `evidence-types.ts` に移す。コードから区分（`notVerifiableKind`）への対応は、`isolated-auditor.ts` の今の場所に残す（型で、一覧のすべてのコードに区分があることを保証する）。対応表の英文は、Evidence に書かなくなるので消す。
  - そのほか: `OBSERVABLE_STATE_CHANGED`（VERIFIED）、`SAFETY_FREEZE_BLOCKED`、`OWNER_CLOSE_SAFETY_FAILURE`（BLOCKED_BY_SAFETY）、`EXECUTION_FAILED`、`CLICK_FAILED`（EXECUTION_FAILED）。
  - 実装者は、コードの中の値をすべて洗い出し、一覧に漏れがないことを確かめる。既存のコードと同じ意味の、新しい名前を作らない。一覧の最終の形は、報告で示す。
- **status とコードの組み合わせ**: どの status にどのコードが入りうるかを、型かスキーマで表せる範囲で表す。表せない組み合わせは、テストで確かめる。
  - 決定（RC18 の M2 を受けて、2026-09-25）: 制限は、結果を組み立てる関数の型（`outcome<S>`。status に合うコードだけを受け取る）と、スキーマ（`interactionStatusReason` の if/then）で行う。Evidence の型（`InteractionEvidence`、`InteractionWorkOutcome`）は、status とコードを独立した項目のまま持つ。status で見分ける union 型にすると、Evidence を読むすべての場所に影響するためである。結果は、組み立てる関数を通してだけ作る。
- **スキーマ**
  - `reason` を enum にし、`reasonDetail` を必須（`string` か `null`）で加える。`work`、`lifecycle` も同じ。
  - `reasonDetail` には、スキーマで新しい長さの上限を加えない（`IncompleteReason` の `detail` にも上限はない）。エラーの文言は、今と同じ整え方（上限付きの `safeErrorMessage` など）を通してから入れる。
  - スキーマの版（`AUDIT_ARTIFACT_SCHEMA_VERSION = 'audit-schema/1.0'`）は上げない。理由: まだ公開していない。この整理の中のほかのスキーマの変更（C18a、C18f）でも上げていない。版を上げる方針は、公開のときに決める。
- **表示**
  - 日本語の説明は、`src/presentation/messages.ts` に `INTERACTION_REASON_DESCRIPTIONS`（と lifecycle の分）として置く。型で、すべてのコードに説明があることを保証する。
  - 表示用モデルは、Interaction の理由を、ページの未完了の理由と同じ形（コード、説明、詳細）で渡す。できれば `ReasonView` を使う。
  - HTML は、ページの未完了の理由と同じ部品で、説明、コード、詳細を示す。新しい表示の部品を作らない。
  - CLI の出力とバンドルの要約には、Interaction の理由は出ない。変えない。
- **変えないもの**: Interaction の status、`notVerifiableKind`、Run Status の決め方、Rule、安全の判定。

#### 5.1.3 分け方

- C18n: Evidence の型、コードの一覧、スキーマ、`isolated-auditor.ts`、Interaction とスキーマのテスト、見本の組み立て（`tests/helpers/audit-run-fixture.ts`）。表示用モデルは、型が通るだけの最小の変更にとどめる（コードをそのまま渡す）。
  - あわせて、`discover-candidates.ts` の、書き込むだけで読まれない `domWork.exhausted` を消す（C18e の発見事項）。
- C18o: `messages.ts` の説明、表示用モデル、HTML、表示のテスト。C18n の後に行う。
- C18n の Blocker（2026-09-25）への対応: Evidence の形を変えると、見本や期待値として英文や自由な文字列を入れている次のテストも直す必要がある。確かめる内容を弱めずに、新しい形（コードの一致と `reasonDetail` の一致）に移す。
  - `tests/unit/run-coordinator.test.ts`（Interaction の Evidence の見本）
  - `tests/integration/page-auditor.test.ts`（セッションを開く期限の理由の確かめ）
  - `tests/unit/audit-run-fixture.test.ts`（見本の既定値と上書きの確かめ。危険な文字列は `reasonDetail` で確かめる）
  - `tests/unit/schema-enum-consistency.test.ts`（新しい enum の対応を加える）

#### 5.1.4 受け入れ条件

- Evidence の `reason` に、英文が入らない（すべての経路で、閉じた一覧のコードになる）。テストで、すべての status の経路を確かめる。
- `CLICK_TIMED_OUT` と `EXECUTION_FAILED` の代わりの経路が、コードで見分けられる。
- スキーマが、一覧にない値と、`reasonDetail` の欠けを拒む。
- HTML で、Interaction の理由が日本語の説明とコードと詳細で示される。
- 既存のテストの期待値は、新しい形に合わせて直す。確かめる内容を弱めない（英文の一致で確かめていたものは、コードの一致と詳細の一致で確かめる）。
- すべての Gate と `npm run verify` が PASS する。

## 6. サブタスクの順序

実装計画 `doc/design/2026-09-25-beaksight-pre-task-19-cleanup-implementation-plan.md` に書く。

## 7. 対象外

- 実サイトへのアクセス（Task 20 以降。ユーザーの許可が必要）
- Chrome のポリシー（レジストリ）による外部スキームの禁止。システムの設定の変更なので、利用者の判断が要る。Task 20 の前に、選択肢として示す。

## 8. 完了条件

- [x] DEF-012 が直り、GATE-S03 が広がり、Guard の独立レビューで Critical 0・Important 0 である（RC18c、2026-09-25）。
- [x] 第5章の各項目が直っている（C18c〜C18o。RC18 で確かめた。RC18 の Minor は C18p で直す）。
- [x] すべての Gate（S、A、ARCH、UI）が PASS する（RC18、2026-09-25）。
- [x] `npm run verify` が PASS する（2026-09-25、98ファイル、3,629件。C18p の後にもう一度確かめる）。
- [x] 台帳（共通部品、不具合、共通化候補）が更新されている（RC18 の M6〜M8 を 2026-09-25 に反映した）。

## 9. 設計変更履歴

| 日付 | 契機 | 変更内容 | 影響範囲 |
| --- | --- | --- | --- |
| 2026-09-25 | 初版。R18 と、外部スキームへの移動の調査 | - | Task 19 の前の整理、Task 20 |
| 2026-09-25 | RC18 | 5.1.2 に、status とコードの組み合わせの制限の方法（M2）を明記した。第8章の完了条件を更新した | C18p |
| 2026-09-25 | C18n の Blocker | 5.1 の NOT_VERIFIABLE のコードの数を55個に訂正した。lifecycle のコードに `OWNER_CLOSE_NON_TERMINAL` を加えた。`InteractionOwnerCleanupError` の `lifecycle` も同じ形にし、Ledger の文言は変えないことを書いた。5.1.3 に、直すテストの4ファイルを加えた | C18n |
| 2026-09-25 | C18e の第2段階の報告 | 5.1（CC-010 の残り。Interaction の理由をコードと詳細に分ける。案A）を加えた | C18n、C18o |
| 2026-09-25 | ユーザーの判断 | 4.3 に、smoke の対象を https://demo.playwright.dev/todomvc/ にすることと、本来の監査対象のサイトへは完成までアクセスしないことを記録した | Task 20、Task 21 |
| 2026-09-25 | RC18c | 4.2.1 の OOPIF の制約の記述を、解消したことと残る制約に書き直した。表に OOPIF を含むことを加えた | なし |
| 2026-09-25 | RC18b | 4.2.1 に OOPIF の制約（C18i で直す）、4.5 に違反を確かめる時点の制約を加えた | C18i |
| 2026-09-25 | C18g の報告 | 4.6（DEF-013。遅いリダイレクトの偽の違反）を加えた | C18h |
| 2026-09-25 | RC18a | 4.1.1（訂正）、4.2 のリダイレクトの扱い、4.2.1（止められる経路の整理）、4.5（違反の後は監査を続けない）を加えた | C18f、C18g |
| 2026-09-25 | ユーザーの判断 | 4.3 に、Task 20 の smoke を headed で行うことを記録した | Task 20 |
