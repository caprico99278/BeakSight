# 設計書 — ChatGPT 用バンドルで、BeakSight の遮断と指摘を結び付けて分ける

状態: ユーザーの指摘と判断（2026-10-23）による。BN-0・BN-a〜BN-d と BN-R0・BN-R1 の直しを終えて閉じた（2026-10-24）。
作成: 2026-10-23（設計者）

## 1. 経緯

ユーザーの指摘（2026-10-23）は、次の 2 点です。

- ChatGPT がバンドルを読むと、「表示の失敗は確認できますが、検査ブラウザ側でスクリプトが遮断された記録もあり、システム固有の障害とは断定できません」と答えることがある。BeakSight の遮断の記録がノイズになっている。
- 遮断の事実だけを消すと、真のバグか分からなくなる。真のバグと思われる内容だけを渡したい。

ユーザーの判断は「3 つに分ける」です。

- 遮断が原因
- 遮断の影響の可能性
- 遮断と結び付かない

前の 2 つは、別のファイルに理由つきで残します。本体は、結び付かない指摘だけにします。SAFETY の指摘も、本体から外します。

## 2. 事実

設計者の確かめ（2026-10-20 の 140 ページの Run。送信の扱いは `PASS_EXCEPT_DELETE`。サイトの名前と URL は伏せる）と、調べ（`.superpowers/sdd/2026-08-27-beaksight-implementation-plan/BN-research-brief.md` の報告）によります。

- ページの監査の読み込み（desktop・mobile）の network の失敗に、`ERR_BLOCKED_BY_CLIENT` が残っています。
  - 同じ Origin のデータの GET（fetch）409 件
  - 種類 other の GET 280 件（ほぼ 1 ページの 1 つの読み込みに 1 件）
  - script 6 件
- この 3 つは、Guard の Ledger（止めた要求の記録）に載っていません。止めた時点は、Context を閉じる途中と推測しています（Ledger の snapshot は閉じる前に取る）。
- そのため、`SCRIPT_LOAD_FAILED` の指摘のうち少なくとも一部は、BeakSight が閉じる途中で止めたことによる、偽の指摘の見込みが高いです。
- Ledger に載る止めた要求は、次のとおりです。
  - 計測のビーコンの POST 417 件（desktop の Passive。T44b の前の版）
  - サービスの要求の上限で止めた GET 26 件・POST 1 件
  - DELETE 1 件
- Ledger の止めた要求は `{method, url, reason}` だけを持ちます。時刻・要求の種類・frame・読み込みの種類はありません（`src/core/evidence-types.ts:1774-1778`）。
- Rule が読む network・console の Evidence は、ページの監査の読み込みだけから取ります（幅の走査の layout を除く）。
- 起動の引数 `--disable-shared-workers` のため、`new SharedWorker` は `ReferenceError` を投げ、PAGE_ERROR になります。守りの例外の判定（`isGuardBlockedPageError`）には入っていません。
- ブラウザ側には、止めた要求が決まった形で残ります。
  - `requestfailed` の `errorText` が `net::ERR_BLOCKED_BY_CLIENT(.Inspector)`。
  - console の「Failed to load resource: net::ERR_BLOCKED_BY_CLIENT…」。
  - 捕まえない fetch の `TypeError: Failed to fetch`。

## 3. 設計

### 3.0 止め方の変更（BN-0。ユーザーの判断 2026-10-23）

**分かったこと**

設計者が、2026-10-20 の Run の記録の別の欄（`blockedAuditExclusions`）を確かめました。2 章で出どころが分からなかった `ERR_BLOCKED_BY_CLIENT` は、すべて理由 `AUDIT_EXCLUDED_URL` で止めた GET でした。

| 止めた GET | 件数 | 当たった決まり |
| --- | --- | --- |
| ページ自身の script（`/assets/…`） | 6 | path に危険な語 `delete` |
| データの GET（`/api/…`） | 410 | 危険な語ではない（読まないパス・読む範囲の決まり） |
| 1 段の path の GET（`/…`） | 697 | 同上 |

- 危険な語と読まないパスは、もともと BeakSight 自身の移動と操作（ログアウトのリンクを踏む、など）を防ぐための決まりです。それが、ページが自分で読み込む GET にも当たっていました。
- その結果、偽の `SCRIPT_LOAD_FAILED` が出ていました。止めた script に頼る画面の部品は、監査の間は動かなかった見込みです。
- ユーザーの方針（「ページが読み込みで自分で出す送信は通す。不自然な遮断で検知が働く方が問題」）に反する、不自然な遮断です。

**ユーザーの判断**

- ページが自分で読み込む script・stylesheet・image・font（と media）の GET は、危険な語や読まないパスに当たっても通す。
- ページが自分で出すデータの GET（fetch・xhr）も、危険な語に当たっても全部通す。

**設計**

- 監査の段の Passive の Context（ページの監査・幅の走査・読み直し）では、ページが出す文書でない GET・HEAD に、危険な語と読まないパス（`AUDIT_EXCLUDED_URL`）の決まりを当てません。
  - 当てる決まりは、要求の種類によらず、今の読み取りの決まりだけです（Origin、上限など）。
  - 監査のモード（`READ_ONLY`・`PASS_EXCEPT_DELETE`、公開・認証つき）によらず、同じにします。
- 危険な語と読まないパスは、今どおり次のものに当てます。
  - BeakSight 自身の移動（巡回の行き先）
  - 文書の読み込み（main frame と子の frame のナビゲーション）
  - 読み取りでない送信（送信の扱いの決まりのとおり）
  - Interaction の Context（BeakSight が押した後の要求）
  - ログインの段・書き込みの段
- 「文書でない」の見分けは、1 か所の判定で行います（`request-policy.ts` の `isPageSubresourceRead`。BN-R0 の後）。
  - 判定に使うのは、Guard が見た要求の事実です（method、ナビゲーションか、要求の種類、先読みの印のヘッダ）。
  - Guard は知らない種類を `other` に直すので、`other` は文書でない読み取りとして扱います（アイコンや計測の GET を通す）。
  - 文書の先回りには、文書の読み込みと同じく除外を当てます。対象は、種類 `prefetch`・`signedexchange` と、`Sec-Purpose`・`Purpose` に `prefetch` を含む要求です。
  - 出口の中継は、Guard が通した（知らせた）ページの読み取りだけを、除外の URL でも通します。
- speculation rules の prerender の代わりの prefetch（`Prerender2FallbackPrefetchSpecRules`）は、起動の引数で止めます（BN-R0 の C-1）。止めないと、文書の GET が Guard を通らずに届き、main frame がそこへ移ります。
- 文書でない GET でも、サービスの Origin への要求の上限、1 ページの要求の上限、Origin の決まりは今どおりです。
- ページ自身のデータの GET が、ログアウトなどでセッションを切る場合は、今のセッションの切れの検出（`SESSION_LOSS`）で記録し、止まった理由と次にできることを出します。
- `doc/spec/safety.md` と `doc/spec/authenticated-audit.md` の読まないパスの説明を直します。

### 3.1 記録（BN-a）

1. **止めた事象の時点と種類**
   - Guard の Ledger の止めた要求の記録に、2 つを足します。
     - `resourceType`: 3 か所の記録の口で、値は手元にある。
     - `phase`: `LOAD`（ページの監査の測りの前と最中）、`CLOSING`（閉じる途中・ページを離れた後）。
   - page.json の Schema の版を上げ、前の版の記録は今どおり読めるようにします（読み替えは 1 か所）。
2. **閉じる途中の遮断も記録に残す**
   - 今は、閉じる途中に止めた要求が Ledger の snapshot に入りません。network の失敗としてだけ残ります。
   - 閉じる途中の止めた要求も、Ledger に `phase: CLOSING` で数えて残します。page.json に入れる時点を、閉じた後にします。
   - それが既存の安全の決まり（記録の時点、閉じる順）を変える場合は、止めて相談します（Blocker）。
3. **network の失敗の印**
   - network の Evidence の失敗に、2 つの印を付けます。
     - BeakSight の遮断か（`errorText` の判定。今の部品 `src/browser/playwright-errors.ts` の遮断の一覧を使う）。
     - 測りの後に起きたか（`phase`）。
4. **読み込みの印**
   - safety の Evidence に、読み込みの種類を足します。
     - 種類: ページの監査・幅の走査（幅）・Interaction（候補の番号）。
   - 今は Evidence の並びに頼っています。

### 3.2 守りの例外（BN-b）

- SharedWorker の `ReferenceError`（BeakSight の起動の引数による）を、守りの例外の判定（`src/core/guard-page-exceptions.ts`）に足します。
- PAGE_ERROR の Finding にせず、page.json の Evidence には残します。
- desktop・mobile のどちらでも、BeakSight の引数が原因なので除きます。

### 3.3 指摘の区分（BN-c）

- 区分は、表示用モデルの 1 か所で決めます（SSOT。`src/report/view-model.ts`）。
- 各 Finding に `beaksightBlockRelation` を持たせます。
  - 値: `CAUSED`・`POSSIBLE`・`NONE`
  - 理由のコード（閉じた一覧）
  - 結び付いた遮断の参照（ページ・ビューポート・読み込み・要求の種類。URL は伏せた後の値）
- **CAUSED**（遮断が原因。確実なものだけ）:
  - 指摘の対象の要求の失敗が、BeakSight の遮断（`errorText`）であるもの。
    - 対象の Rule: `SCRIPT_LOAD_FAILED`・`STYLESHEET_LOAD_FAILED`・`IMAGE_LOAD_FAILED` の failure の側など。
  - 画像の DOM の側（naturalWidth 0）で、同じ URL を止めたもの。
  - 行き先の移動の失敗の detail が `ERR_BLOCKED_BY_CLIENT` のもの（`TARGET_NAVIGATION_FAILED`）。
  - PAGE_ERROR の `Failed to fetch` のうち、同じ読み込みで止めた fetch・xhr があるもの。
    - initiator の記録はないので、この場合は POSSIBLE にとどめる。
- **POSSIBLE**（影響の可能性）:
  - 同じビューポートのページの監査の読み込みで、`phase: LOAD` の、見える種類の遮断があるもの。
    - 見える種類: script・stylesheet・font・image・fetch・xhr・document・websocket。
  - かつ、その種類の遮断で結果が変わりうる Rule の指摘であるもの。
  - Rule が「遮断で変わりうる種類」を持ちます（下の 3.4）。
  - `ping`（sendBeacon・`<a ping>`）と、`phase: CLOSING` の遮断は、POSSIBLE の元にしません（ページの JS と測りから見えないため）。
  - 上限（サービスの要求の上限・1 Context 60 件・1000 件）で止めた LOAD の遮断も、種類で同じく扱います。
- **NONE**: 上のどちらでもない指摘。
- 幅の走査の layout の指摘は、その幅の読み込みの safety の Evidence（3.1 の読み込みの印）と結び付けます。
- Interaction の Ledger の遮断は、ページの指摘の結び付けに使いません（Interaction の遮断は page の Rule に効かない）。
- SAFETY の指摘は、区分の外にします。区分の値は `NONE` とせず、バンドルの本体から外します。

### 3.4 Rule の性質（BN-c）

- 各 Rule の定義（Rule Catalog の owner）に、「結果が変わりうる遮断の種類の集まり」を持たせます。
  - 例: 色のコントラスト・見出しの順・title の重なりは、script・stylesheet・font・データの遮断で変わりうるかを、Rule ごとに決める。
  - 変わりようのない Rule は、空の集まりにします（例: main frame の HTTP の status）。
- 決めの表は、実装のサブタスクで作り、設計者が確かめます。迷う Rule は「変わりうる」の側にします（真のバグを本体に残す向きではなく、ノイズを減らす向き）。ただし、迷った Rule の一覧は報告します。

### 3.5 バンドル（BN-d）

- `findings.json` は、`NONE` の SITE_QUALITY の指摘だけにします。
- 新しいファイル `beaksight-related-findings.json` を作ります。
  - 中身は、`CAUSED` と `POSSIBLE` の指摘と、SAFETY の指摘です。
  - 指摘ごとに、区分・理由・結び付いた遮断を持たせます。
- `findings-by-rule.json` と `summary.json` の件数は、本体の分と、外した分（区分の別）を分けて出します。
- README に、次の 4 つを書きます。
  - 本体の指摘は、BeakSight が止めた要求と結び付かないもの（真のバグの候補）であること。
  - 外した件数と、区分の意味。
  - page.json の中の `ERR_BLOCKED_BY_CLIENT` の失敗と console の文は、BeakSight の遮断であること。
  - 閉じる途中に止めたものは、測りの後のもので、指摘の判断に使わないこと。
- `pages.json` の `findingIds` も、本体の分と外した分を分けます。
- page.json は、今どおり一次の証拠として、そのまま入れます。
- 版は `chatgpt-bundle/1.2` にします。
- HTML レポートにも、同じ区分の印と件数を出します。表示はカタログの 1 か所です。

## 4. 実装の分け方

| サブタスク | 中身 |
| --- | --- |
| BN-a | 記録（3.1）: Ledger の `resourceType`・`phase`、閉じる途中の遮断の記録、network の失敗の印、読み込みの印、page.json の Schema の版。安全の回帰（両方の Chromium） |
| BN-b | 守りの例外（3.2）: SharedWorker |
| BN-c | 区分と Rule の性質（3.3・3.4）: 表示用モデルの `beaksightBlockRelation`、Rule ごとの遮断の種類 |
| BN-d | バンドルと HTML（3.5） |
| BN-R | 独立レビュー |

BN-a と BN-b は並行で進め、BN-c は BN-a の後、BN-d は BN-c の後に進めます。

## 5. 受け入れ条件

1. fixture のサイトで、次の 3 つが区分のとおりに分かれること。
   - 閉じる途中にページが script を読み込む画面: 閉じる途中の遮断の SCRIPT_LOAD_FAILED は `CAUSED`。
   - 読み込みの最中に script の遮断がある画面: 敏感な Rule の指摘が `POSSIBLE`、敏感でない Rule の指摘が `NONE`。
   - 遮断のない画面: すべて `NONE`。
2. バンドルの `findings.json` に、`CAUSED`・`POSSIBLE`・SAFETY の指摘が入らないこと。外した指摘は、別のファイルに理由つきで残ること。
3. README と summary の件数が、区分と合うこと。
4. 安全の回帰（両方の Chromium）が通ること。記録の追加で、止める決まりと記録の時点が変わらないこと（閉じる途中の記録の追加を除く）。

## 6. 設計の変更の履歴

| 日付 | 理由 | 変更 |
| --- | --- | --- |
| 2026-10-23 | 作成 | ユーザーの指摘と判断「3 つに分ける（推奨）」による。 |
| 2026-10-23 | BN-a の報告と、出どころの確かめ（設計者） | 2 章の出どころの分からない `ERR_BLOCKED_BY_CLIENT` は、`blockedAuditExclusions` の `AUDIT_EXCLUDED_URL`（危険な語・読まないパス）で止めた GET だった（script 6 件は path の `delete`）。ユーザーの判断: ページが自分で読み込む静的な資源の GET は通す、ページ自身のデータの GET（fetch・xhr）も全部通す。3.0 の BN-0 を足し、BN-c・BN-d より先に行う。BN-a の発見事項: 今の版では閉じる途中の遮断は network の失敗に入らない（受け入れ条件 1 の閉じる途中の場面は、BN-0 の後に見直す）。Guard の記録は fetch を `xhr` とする（BN-c で fetch と xhr を同じに扱う）。safety の Evidence を閉じた後に作るので、離れるときに止めた DELETE が SAFETY の Finding に数わる（止めた事実なので受け入れる）。 |
| 2026-10-23 | BN-R1 の判断（設計者） | I-1: LOAD の main frame の移動を止めた読み込みの指摘は、すべて `CAUSED`（BeakSight が止めた後のエラーの画面を測るため）。M-3: Rule の性質の表を改める。欠けの指摘（題・中身・lang・canonical の欠け、ページ間の title・canonical）と例外（PAGE_ERROR・RESOURCE の 4xx・5xx）は、データ（fetch・xhr。読み取りでも読み取りでない送信でも）の遮断で `POSSIBLE`。表示された要素の欠陥（レイアウト・コントラスト・A11Y・重なった id・ラベルのない必須の欄・action のない form）は、データの遮断では `POSSIBLE` にせず、script・stylesheet・font・document（iframe）の遮断だけで `POSSIBLE`。理由: 表示された部分の欠陥は、遮断があっても本当の欠陥で、欠けと例外だけが遮断で起きうる（安全と使える度合いの釣り合い）。M-2: 先読みのうち文書の先回り（`Sec-Fetch-Dest: document`）だけに除外を当て、部品の先読みはページ自身の読み取りとして通す。Ledger に先読みの印を残し、区分では見えない種類として扱う。M-1: BeakSight でない失敗か DOM の失敗がある URL には、`CLOSING` の遮断を照らさない。 |
| 2026-10-23 | BN-R1 の M-2 の Blocker（設計者の判断） | 実機の Chromium では、`<link rel=prefetch>` は `as` によらず同じ形（CDP の種類 `Fetch`、`Sec-Purpose: prefetch`、`Sec-Fetch-Dest: empty`）で、文書の先回りと部品の先読みを見分けられない。判断: 先読みの印のある要求には、今どおり読まないパスと危険な語を当てる（止める）。先読みは今の画面の描画に使われないので止めても画面は壊れず、通すと除外の URL（logout など）への GET が届くため。止めた記録には `speculative: true` を付け、区分では「影響の可能性」の元にしない。前の行の「文書の先回り（`Sec-Fetch-Dest: document`）だけに除外を当てる」は、この判断で改める。 |
| 2026-10-24 | 閉じる | BN-R1 の確かめ直しの後の最後の直し（N-1〜N-4）で区切った。エラーの画面を測った DOM・axe の指摘を `CAUSED` と示すための「測った文書の URL」の記録は、後の候補として残す。 |
