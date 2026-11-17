# BeakSight テスト用のサイト自身の API への書き込みと、SPA の移った先の画面（DEF-220・DEF-221）設計書

- 日付: 2026-11-08
- 状態: ユーザー承認済み（2026-11-08。範囲と上限の判断は下の 2）
- 関係する文書: `2026-11-06-beaksight-no-login-test-site-design.md`、`2026-10-16-beaksight-task-37-spa-discovery-read-design.md`、`2026-11-05-beaksight-discovery-coverage-design.md`、`2026-11-02-beaksight-list-row-update-design.md`、`2026-10-01-beaksight-site-load-control-design.md`
- 調査: 調査担当の報告（2026-11-08。原因の `パス:行` と、仮のサイトでの再現）。

## 1. 目的

ユーザーの localhost の管理画面（ログインなし、SPA）の操作さがしで、登録・更新を試せる画面が 0 件だった。原因は 2 つ。

1. **DEF-220:** テスト用のサイト自身の Origin の API（同じ Origin の `/api/...` への xhr・fetch の POST）を、承認の対象にしない作り。「承認した API の Origin」は `approvedServiceOrigins`（サイトとは別のサービス）の番号だけを指し、テストの Origin をその一覧に入れることは、プロファイルの検証（`PROFILE_SERVICE_ORIGIN_INSIDE_TARGET`）とワーカーの契約で禁止されている。そのため、ログインの有無によらず `UNAPPROVED_ORIGIN` になる（`src/discovery/api-shape-classification.ts:135`）。
2. **DEF-221:** 押した後の「画面が移ったか」を、main frame の URL の文字列だけで比べる（`src/interaction/submission-probe.ts:851-856`）。SPA の `pushState`・`replaceState`・ハッシュの変化でも「移った」になり、その画面の残りの対象を押さない。移った先の URL は、開き手の語と 1 つ下の番号の path の狭い条件（DEF-190）のときしか覚えない。

## 2. ユーザーの判断（言葉どおり）

- 同じサイトの API への書き込みの範囲: 「ログインのあるサイトも含める」。
- SPA で移った先を、あとで開いて調べる上限: 「上限は設けない」。
- 設計者の補い（負荷の決まりとの釣り合い）: 移った先の画面に専用の上限は設けないが、移った先の画面は「見つけたページ」として数え、操作さがしの今のページの上限（`maxPages`）と、読み込みの間隔（`minNavigationIntervalMs`）の中で読む。サイトへの負荷の決まり（速さの上限と読み込みの回数を明記する）は、この 2 つで満たす。

## 3. 採用する設計

### 3.1 DEF-220: テスト用のサイト自身の API（区分 `APPROVED_TEST`）

1. 送信の型の Origin の区分に `{ kind: 'APPROVED_TEST', index }` を足す。`index` は `approvedTestOrigins` の番号。今の `APPROVED_API`（`approvedServiceOrigins` の番号）は変えない。
2. 区分を決める所（`src/safety/submission-observation.ts` の `originShapeOf`）は、観察の口に明示して渡された `approvedTestOrigins` に当たれば `APPROVED_TEST` にする（許可 Origin の全体ではなく、承認したテストの Origin だけ）。
3. 区分の番号を Origin に解く部品を 1 か所（SSOT）に置き、次の所すべてで使う: 分類（`api-shape-classification.ts`）、シナリオの方針（`scenario-policy.ts`）、承認の有効性（`approval-validity.ts`）、事実の索引（`scenario-facts.ts`）、ワーカーの契約（`worker-protocol.ts` の書き込みの START の API の Origin の確かめ）、書き込みの実行（`api-write-submitter` など）。番号の意味を混ぜない。
4. 書き込みの守りは今のまま当てる: 承認した 1 つの endpoint・POST（登録）か PATCH（更新）・1 回、DELETE・PUT・upsert・論理削除・`/rpc/`・`/functions/` の手続きの呼び出しを拒む規則、本文の形の規則、送る前の照合。送り先の境界は、もともとフォームの書き込みが送れる承認したテストの Origin の中に留まる。
5. 型・schema・digest の版を上げる（型の digest を `beaksight:api-shape/4`）。承認の digest（`beaksight-approval/6`）は上げない（2026-11-08 設計者の判断）。前の版の API の承認は、次の操作さがしで型の digest が変わった時点で `CANDIDATE_SHAPE_CHANGED` になり、承認し直しになる。新しい発見をするまでは前の版の承認が有効のまま残るが、前の版には `APPROVED_TEST` がなく、`APPROVED_API` の意味も変わっていないので、安全の問題はない（SREV-API-SPA の Minor 1）。
6. 範囲: ログインのあるサイトとログインのないサイトの両方（ユーザーの判断）。
7. 既知の限界: 同じ Origin の `/api/` には、資源の登録でない操作の endpoint（例: メールを送る POST）も混じりうる。今の規則で見分けられないものは、登録の候補に見えることがある。承認は利用者が画面の一覧でチェックした画面だけに行う（今のまま）。

### 3.2 DEF-221: SPA の移った先の画面

1. 押した後に、同じ文書のまま main frame の URL が変わった（`pushState`・`replaceState`・ハッシュ）ときは、その URL を「読む画面」として覚える。条件: 同じ Origin（承認したテストの Origin の中）、読まないパス・危険な語・資格情報の除外に当たらない、正規化できる。DEF-190 の `openedEditPageOf` の狭い条件（開き手の語、1 つ下の番号の path）は、この場合には当てない（DEF-190 の部品を広げて共用する）。
2. 覚えた画面は、操作さがしの「見つけたページ」として、今のページの上限と読み込みの間隔の中で、直に読み込んで（GET）、普通に発見して押す。専用の上限は設けない（2 の判断）。同じ型の画面は 1 回だけ読む（F。`SAME_TEMPLATE_PAGE_READ`）の決まりは今のまま当てる。
3. 移った後の残りの対象は、今のとおり押さない（`PAGE_CHANGED`）。ただし、押下で新しく現れた、開いた窓の外の確定の語のボタン（同じ文書の中に現れたもの）は、DEF-145 の読み直しで足す対象に入れる（調査の案 2d）。押す数の上限（1 画面 3 回）は今のまま。
4. ハッシュの経路は、正規化で fragment が落ちる場合は読めない（限界）。サーバに履歴の fallback がない SPA では、深い URL を直に開くと 404 になることがある（限界。その画面は読めなかった画面として理由つきで記録する）。
5. 書き込みの段は、覚えた URL を直に開けるので、承認から書き込みまで続く。

## 4. 変えないもの

- 安全の守り（DELETE・危険な語・読まないパス・資格情報の守り、送信の扱いの既定 PASS_EXCEPT_DELETE、凍結、Guard）。
- 書き込みの承認の流れ（画面の一覧でチェックした画面だけ）。
- 押す数の上限、読み込みの間隔、操作さがしのページの上限。

## 5. サイトへの負荷

- DEF-221 で、移った先の画面の読み込みが増える。数は操作さがしのページの上限（`maxPages`）を超えない。間隔は `minNavigationIntervalMs` のまま。読み込み直しは増やさない。
- DEF-220 で、書き込みの数は今の承認された登録・更新と同じ上限。

## 6. テスト

- DEF-220: 仮のサイト（一般の文言）の同じ Origin の `/api/<名詞>` への fetch・xhr の POST（登録）と PATCH（更新）が、操作さがしで `API_CREATE`・`API_UPDATE` になり、承認・書き込みまで通る（ログインのある形とない形）。PUT・DELETE・`/rpc/`・JSON でない本文・承認の外の endpoint は今のとおり止まる。前の版の承認が無効になる。2 つの Chromium で、届いた数をサーバの記録で数える。
- DEF-221: `pushState`・`replaceState`・ハッシュで編集のフォームを出す SPA で、移った先の画面が読む画面に入り、そこで保存が押されて型が取れる。ページの上限を超えない。除外のパスへは移らない。同じ型の画面は 1 回。
- 既存の操作さがし・承認・書き込みのテストが通る。
- 安全のレビュー（実装の後）。

## 7. 実装の分け方

1. **API-1（DEF-220）:** 3.1。
2. **SPA-1（DEF-221）:** 3.2。
3. **安全のレビュー（SREV-API-SPA）。**
4. ユーザーが localhost の管理画面で確かめる。

## 8. 設計変更履歴

| 日付 | 理由 | 内容 | 影響 |
| --- | --- | --- | --- |
| 2026-11-08 | DEF-220・DEF-221（ユーザーの localhost の管理画面の結果）とユーザーの判断 | 新規作成 | 操作さがし・承認・書き込み・ワーカーの契約 |
