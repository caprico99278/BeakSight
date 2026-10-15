# BeakSight Task 25 手動ログイン済みセッションの引き継ぎ 設計書

作成日: 2026-10-10
状態: ユーザー承認済み（2026-10-10）
対象範囲: テスト環境（`TEST_AUTH_PASSIVE`）で、BeakSight が開く Chromium で人がログインし、その認証済みの状態をメモリの中だけで、新しい Guard つきの監査の Context へ渡して、管理画面を読み取りだけで監査する

## 1. 目的

- ロードマップ（`2026-10-09-beaksight-task-22-32-roadmap.md`）の Task 25（6.1 Stage 1、RF2）を実現する。G25: fixture の正規のログインの成功・失敗、移した後の監査、秘密を出さない、無関係な POST を止める、が PASS。実テスト環境のログインは、ユーザーの明示の承認の後の小さな確かめだけ。
- 根拠の事実: 作業記録の「T25 調査」の行（`progress.md`）。

## 2. 根拠となる文書と、ロードマップからの読み替え

- 従う: ロードマップ 3 章（I03〜I05、I09、I11、I14、I16）、5.1、6.1、9 章、11 章（RF2）、13 章、Task 22〜24 の設計書。
- **置き場所の読み替え**（Task 22 の Gate `control-boundary.test.ts` のため。`src/control/` は Playwright と `src/safety/` に届けない。監査の本体は `src/control/` を読めない）:
  - 認証の設定の契約と検証 → `src/control/auth/`（Playwright を使わない純粋な部品）
  - ログインの段の要求の判定 → `src/safety/request-policy.ts`（要求の判定の唯一の owner に口を足す。ロードマップの `src/control/policy/auth-transport.ts` は作らない）
  - ログインの実行（headed の Chromium、成功の判定、状態の取り出し）→ `src/worker/`（と `src/browser/` の起動の部品）
  - 状態の注入 → `src/browser/context-factory.ts` の安全な入口（ロードマップのとおり）

## 3. 採用する設計

```text
[画面] 監査を始める（TEST_AUTH_PASSIVE）
   └ ジョブの管理（開始の直前に、プロファイルと認証の設定を検証し直す）
        └ ワーカー（1 つの process の中で、ログインから監査まで）
             1. ログイン用の Browser（headed）＋ ログインの段の Guard（許した POST だけ）
                  人がログイン → 成功の条件で判定 → storageState をメモリに取り出す → この Browser を閉じる
             2. 状態を絞る（許した Origin の Cookie と localStorage だけ）
             3. 監査の Browser（headless）＋ 今の Guard（GET と HEAD だけ）＋ 状態の注入
                  巡回から外すパス（ログアウトなど）を止める。セッションが切れたら止める
        IPC には、秘密を含まない状態の知らせだけ（AUTH_STATE）
```

- 認証済みの状態（Cookie、localStorage）は、ワーカーの変数の中だけに置く。ファイル、管理データ、IPC、ログ、成果物に出さない。Run を再開するときは、もう一度ログインする（状態を保存しない）。
- 監査の段の Guard と判定は、今の公開監査と同じ（GET と HEAD だけ）。ログインの段の許可は持ち越さない（調査で確かめた）。

## 4. 詳細設計

### 4.1 認証の設定（`beaksight-auth-setup/1`。`src/control/auth/`、`schemas/control/auth-setup.schema.json`）

プロファイル（`beaksight-profile/1`）は変えず、別の文書を `profileId` と `profileRevision` に結びつける。

| 項目 | 内容 |
| --- | --- |
| `profileId`、`profileRevision` | 結びつくプロファイル。改訂が変わったら、設定を検証し直す（古い改訂の設定では監査を始めない） |
| `loginStartUrl` | ログインの画面の URL |
| `loginPostEndpoints` | `[{ origin, path }]`。ログインの段で、main frame のナビゲーションの POST を許す送信先（完全一致） |
| `successCondition` | ログインが済んだと判定する条件（URL の path の前方一致と、任意で、その画面にある要素の CSS セレクタ） |
| `sessionLostCondition` | セッションが切れたと判定する条件（ログインの画面の path への移動。既定は `loginStartUrl` の path） |
| `excludedPaths` | 監査で読まないパス（前方一致）。ログアウトを含める。既定で、path と query に `logout`、`signout`、`sign-out`、`log-out`、`delete`、`remove`、`destroy`、`cancel` を含む URL も読まない（名前つきの閉じた一覧。設計者の判断。GET でも状態を変える管理画面のリンクに備える。I09） |
| `auditPathPrefixes` | 監査で読むパスの前方一致（空なら制限なし。管理画面の範囲に絞るため） |
| `maxLoginAttempts` | ログインの段で許す POST の回数の上限（1〜3。総当たりをしない。I05） |
| `allowedIdpOrigins` | Stage 1 では空だけを受ける（別の Origin の IdP は `UNSUPPORTED_AUTH_STATE`。Task 26 以降） |

- 検証（`validateAuthSetup`。`validateSiteProfile` を通ったプロファイルだけを受ける）: プロファイルが `TEST_AUTH_PASSIVE` で `auth` が `MANUAL_SESSION`。すべての Origin が `approvedTestOrigins` に含まれ、`approvedTestOrigins` がターゲット設定の `allowedOrigins` に含まれる。URL の形、上限、秘密に見える値（パスワードなど）を持たない。fail-closed。
- 保存: 管理データの版 3（`auth_setups` の表。版 2 は Task 24 で公開済みなので変えない）。

### 4.2 ログインの段の要求の判定（`src/safety/request-policy.ts`、Guard の取り付けの指定）

- `classifyPassiveRequest` に、ログインの段だけの口（例 `authSetup: { loginPostEndpoints, remainingPosts }`。平らなデータ）を足す。口があるときだけ、許した Origin と path への **main frame のナビゲーションの POST** を ALLOW する（回数の上限まで）。ほかの決まり（GET と HEAD 以外の拒否、WebSocket、Service Worker、別の Origin への main frame の移動、外部のスキーム、popup の扱い）は今のまま。
- Guard の取り付けの指定（`PassiveRequestGuardOptions`）に、この口を渡す指定を足す。指定がなければ今と完全に同じ（PUBLIC_PASSIVE の golden で固定）。
- 監査の段では、`excludedPaths`・`auditPathPrefixes`・既定の危険な語に当たる URL を、Guard でも止める（巡回から外すだけでなく、ページの中の画像や iframe の GET でも送らない）。この判定も `request-policy.ts` に、平らなデータで渡す口として足す（指定がなければ今のまま）。

### 4.3 状態の注入と絞り込み（`src/browser/context-factory.ts`）

- `BrowserContextFactoryOptions` に、省略できる `authenticatedState`（凍結した `{ cookies, origins }`）を足し、`#createGuardedContext` の `newContext` に `storageState` として渡す。省略なら今と完全に同じ。
- 渡す前に絞る（`src/control/auth/` の純粋な部品）: Cookie は、ドメインが `approvedTestOrigins` の host と一致するものだけ。localStorage は、`approvedTestOrigins` の Origin のものだけ。
- **セッションの回転への備え**: Context を閉じる前に、その Context の `storageState` を取り直し（絞ってから）、次の Context へ渡す（ページの中の Context は順に作られるので、順に受け継ぐ）。受け継ぎができない形（並行の Context など）があれば、実装で止まって報告する。
- **セッションが切れたとき**: 監査の段で main frame が `sessionLostCondition` に当たったら、その Run を、新しい理由の値（例 `AUTH_SESSION_LOST`）で止める（ログインの画面を管理画面として監査しない）。Run の状態は PARTIAL。

### 4.4 ワーカーの流れと IPC（`src/worker/`、`src/control/worker-protocol.ts`）

- `START` に、認証つきかどうか（`TEST_AUTH_PASSIVE`）と、認証の設定の内容の SHA-256 を足す（親が検証した設定とワーカーが読む設定が同じかを確かめる。Task 24 の M3 と同じ考え）。認証の設定そのものは、ワーカーが管理データから読まずに、親が渡す（秘密を含まないので IPC に流してよい）。
- ログイン用の Browser は headed（人が操作する）。テストでは headless の Browser で、人の操作を自動の操作で代える。ログイン用の Browser の Context には、ログインの段の Guard を付ける。
- 子 → 親の知らせ `AUTH_STATE`（`AWAITING_LOGIN`、`AUTHENTICATED`、`AUTH_SETUP_REQUIRED`、`UNSUPPORTED_AUTH_STATE`、`SESSION_LOST`、`LOGIN_TIMEOUT`、`LOGIN_ATTEMPTS_EXCEEDED`）。値と秘密は含まない。
- ログインを待つ時間の上限（名前つきの定数。例 10 分）。過ぎたら `LOGIN_TIMEOUT` で止める。
- headed の Browser は、ワーカーが閉じる（監査の前に）。人が別のタブや window を開いても、同じ Context の中の要求は Guard を通る。Guard の準備の前の移動で Context が閉じられた場合は、`AUTH_SETUP_REQUIRED` で止める。

### 4.5 画面（`apps/local-ui/`）

- 認証の設定の画面（プロファイルの詳細から。項目の編集、検証の結果、`TEST_AUTH_PASSIVE` で `MANUAL_SESSION` のプロファイルだけ）。
- 監査の開始の画面で、認証つきの場合は「BeakSight が開くブラウザでログインしてください」の案内と、`AUTH_STATE` の表示（ログイン待ち、済んだ、止まった理由）。
- 今実行できるモード（`execution-policy.ts`）に、`TEST_AUTH_PASSIVE`（認証の設定が有効なときだけ）を足す。`TEST_APPROVED_WRITE` は引き続き実行できない。

### 4.6 秘密を出さないこと（I11）

- 目印の検査（テスト）: fixture の Cookie と localStorage の値を、ランダムで目印になる文字列にする。Run のディレクトリのすべてのファイル（ZIP を展開した中身を含む）、CLI とワーカーの標準出力と標準エラー、管理データのファイルと WAL、IPC の記録を、バイトで検索して 0 件であることを確かめる。
- URL の query の伏せ字: 認証つきの Run では、成果物に記録する URL の query のうち、名前つきの閉じた一覧（`token`、`session`、`sid`、`auth`、`key`、`password`、`code`、`state` など）の値を伏せる（`src/safety/redact.ts` の owner に足す。公開監査の出力は変えない）。
- 見えている文とスクリーンショットには、テスト環境の管理画面のデータが写る。テスト環境のデータを使うことを、手順書に書く（本番の個人データを扱わない）。

### 4.7 監査の範囲（認証つきの Run だけ）

- Interaction（クリックによる操作の確かめ）は、認証つきの Run では行わない（管理画面のボタンやリンクの操作は、GET でも状態を変えうるため。I09。ロードマップの Task 27 の READ の検証で、改めて扱う）。Passive（表示）、幅の走査、スクリーンショット、アクセシビリティは今のまま。
- 速さの上限（`crawl.minNavigationIntervalMs` など）は今のまま。画面から変えられない。

## 5. SSOT と安全性への影響

| 項目 | owner | 扱い |
| --- | --- | --- |
| 要求の判定 | `src/safety/request-policy.ts` | 拡張（ログインの段の口、監査の段の除外の口。指定がなければ今のまま） |
| Guard | `passive-request-guard.ts` | 取り付けの指定を足す（指定がなければ今のまま） |
| Context の作り方 | `context-factory.ts` | 拡張（状態の注入の入口） |
| 認証の設定 | `src/control/auth/`（新設） | 唯一の owner |
| 伏せ字 | `src/safety/redact.ts` | 拡張（認証つきの Run の URL の query） |
| 今実行できるモード | `src/control/execution-policy.ts` | 拡張 |

- 公開監査（PUBLIC_PASSIVE）は、Task 22 の golden（Guard の判定の表）と、Task 24 の CLI と画面の比べで、変わらないことを確かめる。

## 6. テスト設計（fixture。127.0.0.1 だけ）

- fixture のサイト: ログインのフォーム（POST、CSRF の hidden）、HttpOnly の Cookie、管理画面、ログアウト（GET）、期限切れ、セッションの回転、別の Origin（IdP の代わり）への 303、sessionStorage に頼るページ、危険な語の GET のリンク、外部のスキーム、popup、Service Worker、WebSocket、pagehide の beacon。
- ログインの段: 許した POST だけが届く（回数の上限まで）、ほかはすべて止まる（サーバに届かない）、別の Origin への 303 は止まる、上限を超えると `LOGIN_ATTEMPTS_EXCEEDED`、時間切れ。
- 移した後: 管理画面を監査でき、GET と HEAD 以外は 0、ログアウトと危険な語の URL は読まない（巡回でもページの中の要求でも）、回転するサーバでもすべての Context で認証が保たれる、期限切れで `AUTH_SESSION_LOST`、別の Origin の Cookie は送られない。
- 目印の検査（4.6）。
- 公開監査の不変: golden、CLI と画面の比べ、既存の Safety Gate。
- 安全のテストは、テストの既定の Chromium と CLI の起動の設定の両方で確かめる。

## 7. 対象外

- 自動ログイン（Task 26）、別の Origin の IdP、MFA、SPA の fetch によるログイン、IndexedDB に頼る認証、Interaction の認証つきの実行、書き込みの検証。
- 実テスト環境への接続（ユーザーの明示の承認の後に、小さな確かめだけ）。
- CLI からの認証つきの監査（画面からだけ）。

## 8. 完了条件（G25）

- [ ] fixture で、正規のログインの成功・失敗（時間切れ、回数の上限）、移した後の管理画面の監査、秘密の出力 0、無関係な POST の到達 0、ログアウトと危険な語の URL を読まない、セッションの回転と期限切れの扱いが PASS。
- [ ] 公開監査が変わらない（golden、CLI と画面の比べ、Safety Gate）。
- [ ] `npm run verify:all` が通しで PASS。独立レビューで Critical 0、Important 0。

## 9. 実装計画の分け方（概要。承認の後に実装計画を書く）

T25a 認証の設定の契約と検証と保存（版 3）→ T25b 要求の判定の口と Guard の指定（golden を変えない）→ T25c 状態の注入・絞り込み・順の受け継ぎ・セッションの切れの検出 → T25d ワーカーの流れと IPC → T25e 画面 → T25f 目印の検査と URL の query の伏せ字 → T25R 独立レビュー。

## 10. 設計変更履歴

| 日付 | 契機 | 変更内容 | 影響範囲 |
| --- | --- | --- | --- |
| 2026-10-10 | 初版（Task 25。T25 調査） | 置き場所の読み替え、別の文書の認証の設定、ログインの段の口、状態の絞り込みと順の受け継ぎ、既定の危険な語の除外、認証つきの Run では Interaction を行わない | Task 25 |
| 2026-10-10 | Blocker: T25c（1 つのページの中で、Desktop の Passive の Context が幅の走査の間も開いたまま＝Context が入れ子。「閉じたときに受け継ぐ」では幅の走査が古い状態を受け取り、回転するサーバでログインの画面へ飛ばされた（両方の Chromium で毎回）） | 4.3 の順の受け継ぎを「世代つき」に改める: factory が Context を作った順に世代を振り、作るときは保存した状態と生きている認証つきの Context のうち最も新しい世代のものから状態を取る（生きているものは `storageState()` で読む。読む間にサーバへの要求 0 を実験で確かめた）。閉じるときは、その世代が保存した状態の世代以上のときだけ置き換える。4.7 の Interaction を行わないことは、有効な設定（`effectiveConfig.audit.interactions` を false）で記録する（ページの結果を PARTIAL にしない）。`AUTH_SESSION_LOST` で止めた Run は、サイトの不調と同じく再開できる（実行の終わり方 `STOPPED_BY_AUTH_SESSION_LOST`、保存は `STOPPED`、SKIPPED の理由は再開で待ち行列に戻す。再開のときは再ログイン（T25d））。セッションの切れは、Passive の Desktop・Mobile と、幅の走査の各幅の main frame の最後の URL で確かめる | T25c、T25d |
| 2026-10-10 | Blocker: T25d（`executeAuditRun` が認証の指定を受け取れない、セッションが切れたページの URL を受け取る口がない、ログイン用の Context を作る owner） | (1) 監査の中核（`src/cli/audit-run.ts`）の依存に、省略できる `authentication` を足して Run Coordinator に渡す（テスト用の差し替えの口を本番で使わない）。認証つきのときは、再開の比べに認証つきの Run の設定（`audit.interactions` が false）を使う。(2) `RunNotice` に `AUTH_SESSION_LOST`（止まったページの URL つき。URL は今の Ledger と同じ伏せ字）を足し、観測の口で知らせる。(3) ログイン用の Context は `context-factory.ts` に入口を足して作る（Context の作り方の owner を 1 つに保ち、Worker の自己検査をかける）。(4) 管理データ: 版 2 は公開済みなので、ジョブの表の CHECK の一覧を版 2 の時点の写しで固定し、版 3 でジョブの表を作り直す（認証の状態と止まったページの URL の列を足す）。(5) `START` の SHA-256 は、認証の設定の文書と `approvedTestOrigins` の両方を含めて求める | T25d |
| 2026-10-10 | T25R（独立レビュー。Critical 1、Important 2、Minor 4） | (1) 監査の段の除外の判定は、path の途中の連続した `/` をまとめた形と、segment の `;` から後を外した形でも比べる（どれか 1 つの形が除外に当たれば止める。fail-closed）。(2) 再開してよいかの比べに、Run の種類（認証つきかどうか）を入れる（違えば新しい Run）。(3) 4.4 の `START` の SHA-256 の意味を正す: ワーカーは管理データを読まないので、確かめられるのは「同じメッセージの中の設定と SHA-256 が食い違わないこと」まで（親が検証した設定そのものとの一致は、親が検証した写しを `START` に入れることで保つ）。(4) 状態の絞り込みでは、Cookie を host だけの Cookie にして渡す（サブドメインに送らない）。同じ host の別の port に送られることは Cookie の決まりで防げないので、手順書に書く。(5) 回数の上限の説明に、扱えない形のログイン（fetch で送るもの）の可能性を書く | T25g-1〜3 |
| 2026-10-10 | T25g-1 round 1、T25g-4、T25R2（再レビュー。Critical 0、Important 0、Minor 2） | (1) 除外の比べの形に、Unicode の畳み込み（NFKC → 大文字 → 小文字）を足す。読まないパスと既定の危険な語の比べだけに使い、読む範囲の判定には使わない（読む範囲を広げる向きに働かせない）。(2) 比べる形の数は `MAX_AUDIT_PATH_FORMS`（64）までとし、超える長いパスと decode できない形（`%` の後に 16 進でない文字が続くものなど）は読まない（fail-closed。`blockedAuditExclusions` に残る。文字の `%` を含む正当なパスも読まなくなることは受け入れる）。(3) `LOGIN_ATTEMPTS_EXCEEDED` の画面の 2 つの文言（状態の説明と失敗の理由）は役割が違うので参照にせず、内容だけそろえる | T25g-1、T25g-4、T25g-5 |
