# BeakSight ログインのないテスト用のサイトで、操作さがし・登録・更新まで試す 設計書

- 日付: 2026-11-06
- 状態: ユーザー承認済み（2026-11-06「仕様を広げる方向で設計書を書いて進めて」）。loopback に限る判断は設計者（下の 2）。
- 関係する文書: `doc/spec/profiles.md`（受ける組み合わせ、モードごとに使える操作）、`2026-09-23-beaksight-ui-ssot-design.md`、`2026-10-26-beaksight-plain-ui-design.md`、`doc/spec/safety.md`
- 調査: 調査担当の報告（2026-11-06。場所ごとの前提と `auth: NONE` での扱いの表）。

## 1. 目的

利用者が手元（localhost）で動かす、ログイン機能のない、登録・更新のある管理画面を、ログインのあるテスト用のサイトと同じく、点検 → 操作さがし → READ の確かめ → チェックした画面の登録・更新まで試せるようにする。

今は、環境 `TEST` の `TEST_AUTH_PASSIVE`・`TEST_APPROVED_WRITE` は、認証の方式 `MANUAL_SESSION`・`AUTOMATED_LOGIN` だけを受ける。ログインのないテスト用のサイトは `PUBLIC_PASSIVE`（見るだけ）しか選べない。

## 2. ユーザーの判断と設計者の判断

- ユーザー（2026-11-06、言葉どおり）: 「仕様を広げる方向で設計書を書いて進めて」。
- 設計者: ログインしない書き込み（`TEST` × `TEST_APPROVED_WRITE` × `NONE`）と、ログインしない操作さがし・READ（`TEST_AUTH_PASSIVE` × `NONE`）は、`approvedTestOrigins` がすべて loopback（`localhost`・`127.0.0.1`・`[::1]`）のときだけ受ける。理由: ログインのあるサイトでは「テスト用の資格情報がある」ことが、テスト環境らしさの手がかりになっていた。ログインがないと、テスト環境かどうかは利用者の申告（`environmentEvidenceRef`）だけになる。手元のサイトに限れば、本番のサイトへ書き込む取り違えが起きない。広げるかは、後でユーザーに諮る。

## 3. 採用する設計（調査の案 A）

新しい認証の方式は足さない。今の `NONE` を、環境 `TEST` の 2 つのモードにも許し、ログインの段を飛ばす。

### 3.1 プロファイルの規則（control の層）

1. 受ける組み合わせ（`src/control/profile-combinations.ts`）の `TEST` の 2 モードに `NONE` を足す。作成の欄の初めの値（表の先頭）は変えない。
2. `src/control/profile-policy.ts` に規則を 1 つ足す: `TEST` で `auth: NONE` の `TEST_AUTH_PASSIVE`・`TEST_APPROVED_WRITE` は、`approvedTestOrigins` がすべて loopback でなければ拒否する（新しい理由のコード。例 `PROFILE_NO_LOGIN_REQUIRES_LOOPBACK`）。理由のコードは、表示のカタログと説明の文に登録する。
3. `PROFILE_OPERATION_POLICY`（`src/control/execution-policy.ts`）の `TEST` の行に `NONE` を足す。対象は AUDIT・DISCOVERY・READ_CHECK・SCENARIO・WRITE_CREATE・WRITE_UPDATE・ENTRY_CHECK。AUTH_SETUP・CREDENTIAL・LOGIN_CHECK には足さない。
4. `requiresAuthSetup`・`operationRequiresAuthSetup` に認証の方式を引数で足し、`NONE` なら認証の設定を求めない。呼ぶ所（`audit-job-manager.ts`、`audit-start-check.ts`、`start-check-inputs.ts`、`ProfileForm.tsx` など）をすべて直す。
5. 承認の外の事実（`src/control/approval-external-facts.ts`）は、`auth: NONE` のとき、残っている認証の設定があっても、認証の設定の digest を null にする（`MANUAL_SESSION` から `NONE` に変えた後の残りを、承認に混ぜない）。

### 3.2 ワーカーの契約と実行（ログインの段を飛ばす）

1. ワーカーの START の `authentication` に「ログインなし」の形を足す: `setup` を null にでき、`approvedTestOrigins` と、その他の必要な値（digest など）は持つ。schema（`schemas/control/worker-message.schema.json`）と型と検証（`src/control/worker-protocol.ts`）を合わせる。`setup` が null のときの規則（`loginStartUrl` の確かめなど）は当てない。
2. ジョブの管理（`src/control/job/audit-job-manager.ts`）は、`auth: NONE` のとき、認証の設定がなくても、ログインなしの `authentication` を作ってワーカーへ渡す（`approvedTestOrigins` が届くようにする）。
3. ワーカー（`src/worker/audit-worker-session.ts`）は、`setup` が null のとき、ログインの段を呼ばず、空の状態（`PRE_LOGIN_STATE` に相当）の RunAuthentication を作る。`AWAITING_LOGIN` は送らない（「ログインを終えた」は出ない）。再ログインは行わない。
4. RunAuthentication（`src/orchestration/authenticated-run.ts`）の `sessionLostPathPrefix` を `string | null` にし、null ならセッションの切れを判定しない。型の波及（`page-auditor.ts`、`write-create-run.ts`、`discovery-run.ts`、`read-check-run.ts`、`worker-run-session.ts`）を直す。今ある先例（`src/control/read-check-page-path.ts` の null の扱い）に合わせる。
5. 安全の守り（Guard・中継・送信の扱い・Origin の境界）は変えない。Origin の境界は今のとおり `approvedTestOrigins` で決まる。

### 3.3 画面（選ぶもの・押すものを増やさない）

1. 使い方の 2 択はそのままにする。文言は「テスト用のサイト（自分たちで用意したサイト）」の意味が伝わる形に見直す（ログインの有無は利用者に聞かない）。
2. 入口の確かめ（ENTRY_CHECK）の判定が `NOT_LOGIN_PAGE` で、プロファイルが `MANUAL_SESSION` で、認証の設定がないとき、BeakSight がプロファイルの次の改訂を `auth: NONE` で保存し、続けてまとめて実行を始める（今は「ログインの設定を作る」へ進めている）。`approvedTestOrigins` が loopback でないときは、今のとおり「ログインの設定を作る」へ進める（3.1 の 2 の規則で NONE を保存できないため）。
3. 書き込みへの切り替え（`apps/local-ui/src/server/write-mode-switch.ts`）と一覧のチェックの保存は、`auth: NONE` のとき、認証の設定を求めず、プロファイルだけを保存する。
4. 次にすることの段は、`TEST` × `NONE` で、ログインの語を出さない文言にする（例「ログインせずに点検します」の類）。文言は `src/presentation/messages.ts`。
5. 戻り道: 判定が誤った（ログインの要るサイトが NONE になった）ときのために、詳しい内容の側に、今の認証の設定の画面へ行く道を 1 つ残す。主のボタンは増やさない。
6. 報告（run.json の表示）の「ログインして点検した」類の表示は、`NONE` では出さない。

## 4. 変えないもの

- 安全の守り（DELETE・危険な語・読まないパス・資格情報の守り、送信の扱いの既定 PASS_EXCEPT_DELETE、書き込みの承認と送り先の境界）。
- `PUBLIC` 環境の扱い（`PUBLIC_PASSIVE` × `NONE` だけ）。
- ログインのあるテスト用のサイトの流れ。

## 5. サイトへの負荷

- loopback だけの監査は、今のとおり読み込みの間隔の下限が 0（`src/config/validate-config.ts:178`）。利用者の手元のサイトなので、過負荷の心配は小さい。ページの上限・時間の上限・押す数の上限は変えない。
- 書き込みの回数は、今の承認された登録・更新と同じ上限。

## 6. 既知の限界

- テスト環境かどうかは、loopback であることと、利用者の申告だけで決まる。
- 入口の確かめの判定は、着いた画面にパスワード欄があるかだけ。開始の URL がログインのない入口の画面だと、ログインの要るサイトでも NONE になり得る（監査は読み取りだけ、操作さがしは見つからないだけで、害は小さい。戻り道は 3.3 の 5）。
- ログインのないサイトでは、セッションの切れを判定しない。
- ログインのないサイトでは、認証の設定の「読まないパス」を持てない。効くのは既定の危険な語だけで、手元の管理画面にある危ない path を利用者が除く手段はない（SREV-NL の M-2）。

### 6.1 SREV-NL を受けた改訂（2026-11-07）

1. loopback の規則（3.1 の 2）は、`approvedTestOrigins` に加えて、`approvedServiceOrigins` と、ターゲットの設定の `site.allowedOrigins` も、すべて loopback であることを求める（同じ理由のコード）。理由: 設定の許可 Origin に外のサイトがあると、ログインなしでその画面を読み込み、その画面の自動の通信を通してしまう（SREV-NL の I-1）。
2. 多重の守り: ワーカーの契約で、setup が null の START は、`approvedTestOrigins` と `approvedServiceOrigins` がすべて loopback でなければ拒む（SREV-NL の M-1）。

## 7. テスト

- 単体: 受ける組み合わせ（TEST × NONE の 2 モードを受ける、loopback でなければ拒否）、`PROFILE_OPERATION_POLICY`、`requiresAuthSetup` の引数、承認の外の事実の digest、ワーカーの契約（setup が null の START を受ける・規則）。
- 結合: 仮のサイト（127.0.0.1、ログインなし、登録・更新のある一般の管理画面）で、点検 → 操作さがし → READ → チェックした画面の登録・更新が、ログインの段なしで通る。セッションの切れの判定が働かない（`/login` のような path でも止まらない）。書き込みの送り先の境界と安全の守りが今のとおり。
- 画面: 入口の確かめの `NOT_LOGIN_PAGE` で NONE が自動で保存され、続けて点検が始まる。loopback でない Origin では今のとおり。
- 既存のテストのうち、TEST × NONE を拒否すると期待するもの（`tests/unit/control-profile-policy.test.ts`、`tests/unit/execution-policy.test.ts`、worker-protocol の認証のテスト、`tests/integration/auth-mode-contrast.test.ts`）は、新しい決まりに合わせて直す（弱めず、loopback でない場合の拒否を残す）。
- 安全のレビュー: 実装の後、書き込みの守りと Origin の境界について、2 つの Chromium で実機のレビューを受ける。

## 8. 実装の分け方

1. **NL-1（control の層）:** 3.1 の 1〜5 と、その単体のテスト。
2. **NL-2（ワーカーの契約と実行）:** 3.2 の 1〜5 と、結合のテスト（点検 → 操作さがし → READ → 登録・更新）。
3. **NL-3（画面）:** 3.3 の 1〜6 と、画面のテスト。`doc/spec/profiles.md` の受ける組み合わせとモードの表、`doc/spec/safety.md` の該当の所の更新。
4. **安全のレビュー（SREV-NL）。**

## 9. 設計変更履歴

| 日付 | 理由 | 内容 | 影響 |
| --- | --- | --- | --- |
| 2026-11-06 | ユーザーの要望（ログインのない localhost の管理画面を書き込みまで試したい） | 新規作成 | プロファイルの規則・ワーカーの契約・まとめて実行・画面 |
| 2026-11-07 | SREV-NL（Critical 0・Important 1・Minor 3） | 6.1 を追加（loopback の規則をサービスの Origin と許可 Origin にも広げる、契約の多重の守り）。M-2 を既知の限界に追記 | プロファイルの規則・ワーカーの契約 |
