# BeakSight Task 18 受け入れの Gate 設計書

作成日: 2026-09-25
対象範囲: Task 18（fixture の網羅と、Safety・Auditor・Architecture の受け入れの Gate）

## 1. 目的

実際の監査対象のサイトにアクセスする前に、次の Gate をすべて PASS させる（実装タスク指示 第11章）。

- Safety の Gate: S01〜S10
- Auditor の Gate: A01〜A10
- Architecture の Gate: ARCH01〜ARCH08

1件でも FAIL している状態では、Task 20 以降の実サイトの smoke に進まない。

## 2. 根拠となる文書と優先順位

- 実装タスク指示 `doc/design/2026-08-27-beaksight-implementation-tasks.md` の第10章（Architecture Gates）、第11章（Acceptance Gates）、第12章（チェックポイント）
- 上位の実装計画 `doc/design/2026-08-27-beaksight-implementation-plan.md` の Task 18
- 上位の設計書 `doc/design/2026-08-27-beaksight-web-audit-design.md` の第30・31章
- UI 追補設計書 `doc/design/2026-09-23-beaksight-ui-ssot-design.md` の第6章（UI Gate）と完了条件
- Task 18 の前の整理の設計書 `doc/design/2026-09-25-beaksight-pre-task-18-cleanup-design.md`

この設計書は、上の文書の Task 18 の部分を具体化する。食い違う場合は、この設計書が優先する。

## 3. 現状の調査の結果（2026-09-25。読み取り専用の調査による）

- 名前付きの Gate のテストは、UI Gate（GATE-UI01〜06）だけである。
- S01〜S10 と A01〜A10 の多くは、個別のテストで、すでに確かめられている。ただし、Gate の名前がない。足りない確認もある。
- ARCH01〜08 は、8つとも静的な検査がない。
- fixture のサーバは、メソッド別の数（`getCounters()`）と、リクエストの記録（`getRequestObservations()`）を持つ。
- 足りない fixture:
  - PATCH を送るページ
  - Worker 自身がリクエストを試みる Service Worker
- 既存のテストの欠陥（DEF-010）がある。
  - `tests/integration/isolated-interaction.test.ts:1846-1847、1864` のポップアップと移動の先の確認で、パスの先頭の `/` が抜けている。そのため、確認が常に真になる。
  - 確認の対象の `popup-target.html` と `navigation-target.html` も、`fixtures/site/` にない。
- 終了コード 3（ABORTED_BY_SAFETY）を、CLI で最後まで通すテストがない。

## 4. 方針

### 4.1 Gate のテストの置き場所と名前

| 種類 | ファイル | テストの名前 |
| --- | --- | --- |
| Safety | `tests/integration/safety-gates.test.ts` | `GATE-S01` 〜 `GATE-S10` を、テストの名前の先頭にそのまま含める |
| Auditor | `tests/integration/auditor-gates.test.ts` | `GATE-A01` 〜 `GATE-A10` |
| Architecture | `tests/architecture/target-isolation.test.ts`（ARCH01）、`tests/architecture/semantic-ownership.test.ts`（ARCH02〜08） | `GATE-ARCH01` 〜 `GATE-ARCH08` |

- ファイルの名前は、実装タスク指示 第14章に合わせる。
- 各 Gate は、既存の個別のテストを呼び直すのではなく、Gate のファイルの中で、Gate の定義をそのまま確かめるテストにする。
  - 既存の個別のテストは、残す。
  - ただし、同じ準備の処理を、Gate のファイルに複製しない。準備の処理は、`tests/helpers/` の補助を使う。
  - 足りない補助は、新しく `tests/helpers/` に置く。
- 1つの Gate に、複数の確認があってよい（例: Passive の段階と Interaction の段階）。

### 4.2 Safety の Gate（サーバの境界で確かめる）

- S01〜S10 は、fixture のサーバの側で、「届かなかった」ことを数えて確かめる（実装計画 Step 2）。
  - 数えるのは、`getCounters()` と `getRequestObservations()` の差分である。
  - Ledger の記録だけで確かめてはいけない。Ledger の記録は、補助の確認として加えてよい。
- 各 Gate で確かめること:

| Gate | 確かめること |
| --- | --- |
| S01 | Passive の段階と Interaction の段階の両方で、POST がサーバに届かない |
| S02 | PUT、PATCH、DELETE の3つとも、Passive と Interaction の両方で届かない。PATCH の fixture を加える |
| S03 | `mailto:`、`tel:`、外部のアプリの起動が、行われない。ページが開かず、Ledger に遮断が記録される。サーバの側では、そのページへのリクエストだけが届く |
| S04 | Interaction 中のポップアップが遮断される。ポップアップの先のページへの GET が、サーバに届かない |
| S05 | Interaction 中のダウンロードが遮断される。`/__download` への GET がない |
| S06 | Interaction 中の移動が遮断される。移動の先のページへの GET が、サーバに届かない |
| S07 | Interaction 中の WebSocket が遮断される。`webSocketUpgrade` が 0 である |
| S08 | Service Worker が、遮断を迂回できない。Worker 自身が POST を試みる fixture で、POST がサーバに届かない |
| S09 | 機密のヘッダが、書き出した artifact（run.json、audit.json、page.json、バンドルの中身）に含まれない。fixture が付ける秘密の値の文字列が、書き出したファイルのどこにもないことを確かめる |
| S10 | Guard の初期化が失敗した場合に、対象のサイトに触れない。Run Coordinator と CLI（同じプロセスの中の `runCli`）の段階で、fixture への GET が 0 件、Run Status が `ABORTED_BY_SAFETY` か `FAILED`（設計書 5.6.7 の区別のとおり）、終了コードがその Run Status のとおりであること |

- S04 と S06 の移動の先のページ（`popup-target.html`、`navigation-target.html`）を、`fixtures/site/` に置く。
  - これらのページへの GET が、0件であることを確かめる。
- DEF-010（既存のテストのパスの誤り）は、Task 18 で直す。
  - 既存の `isolated-interaction.test.ts` の確認を、正しいパスにする。
- 凍結の失敗の後の無効化を、待つのをやめた場合も、凍結が解けないことを、本物の Guard で確かめる（RP18 の指摘4）。
  - 既存のテストは、偽の session の `close()` がすぐに成功するので、実際の合流（止まっている無効化の処理への合流）を再現していない。
  - Gate では、本物の Guard の付いた Context で、無効化が終わらない状態を作る。そのうえで、その後の POST や移動が、サーバに届かないことを確かめる。
  - 置き場所は、S04 か S06 の中か、Interaction の凍結の補助の確認とする。
- 終了コード 3 を、同じプロセスの中の `runCli` で、最後まで通す。
  - 例: Guard の取り付けに違反が出るように、Browser を差し替える。
  - S10 の中か、別の Gate の補助の確認として置く。

### 4.3 Auditor の Gate（実際のブラウザで Finding を確かめる）

- A01〜A10 は、実際の Chromium で、fixture のページを監査する。そのうえで、Finding、Interaction の結果、Run Status を確かめる。
  - A10 だけは、例外とする。スキーマに合わない artifact は、実際の Run では作れない。そのため、`finishAuditRun` に、スキーマに合わない Run を渡して確かめる。
- Rule の ID は、今の実装の ID を使う（下の表）。

| Gate | 確かめること | Rule の ID など |
| --- | --- | --- |
| A01 | 404 のページで、HTTP_4XX の Finding が出る | `HTTP_4XX` |
| A02 | 壊れた内部リンクで、BROKEN_INTERNAL_LINK の Finding が出る | `BROKEN_INTERNAL_LINK` |
| A03 | 捕まえられない JS の例外で、ページのエラーの Finding が出る | `PAGE_ERROR` |
| A04 | 壊れた画像で、IMAGE_LOAD_FAILED の Finding が出る | `IMAGE_LOAD_FAILED` |
| A05 | 横のはみ出しで、DOCUMENT_HORIZONTAL_OVERFLOW の Finding が出る | `DOCUMENT_HORIZONTAL_OVERFLOW` |
| A06 | 低いコントラストで、アクセシビリティの Finding が出る | `COLOR_CONTRAST_VIOLATION` |
| A07 | 安全なアコーディオンが、VERIFIED になる | Interaction の status |
| A08 | 安全でない Interaction が、遮断されるか検証されない。サーバの側で、POST などが届かないことも確かめる | `BLOCKED_BY_SAFETY`、`REJECTED_UNSAFE` など |
| A09 | クロールの上限で、Run が PARTIAL になる | `MAX_PAGES_REACHED` か `MAX_DEPTH_REACHED` |
| A10 | スキーマに合わない artifact がある場合に、COMPLETE にならない | `REQUIRED_ARTIFACT_INVALID` |

- A01〜A09 は、Run Coordinator か CLI を通して確かめるのを基本とする。
  - 1回の Run で、複数の Gate を確かめてよい。
  - 実行時間を抑えるためである。
- Finding があっても、Run Status の決め方が変わらないことも、確かめる（完了の意味）。

### 4.4 Architecture の Gate（静的な検査）

- UI Gate と同じく、`fs`、正規表現、文字列の検索だけで判定する（`references/ui-ux-ssot.md` 第6章。2026-09-23 ユーザー指示）。
  - 各ファイルが、1秒以内に終わること。
  - `src/**` の読み込みは、ファイルごとに1回だけにする。
  - TypeScript のコンパイラ API、AST 解析、外部のツールは、使わない。
- 各 Gate で確かめること:

| Gate | 確かめること |
| --- | --- |
| ARCH01 | `config/targets/*.json` から、対象の識別の文字列を取り出す。取り出すのは、`target.id`、各 URL のホスト名と origin、開始の URL である。それらが、`src/**/*.ts` にない。`target.id` の一意性も確かめる |
| ARCH02 | `loadConfig` を呼ぶのが、CLI（`src/cli/**`）だけである |
| ARCH03 | anchor と href の抽出の owner が、`discover-links.ts` だけである。Run Coordinator が、Page Auditor の `LinkEvidence` を再利用している |
| ARCH04 | URL の正規化と受け入れの判定が、`normalizeUrl` と `classifyUrl` を使っている。別の正規化の実装がない |
| ARCH05 | 最終の Run Status を決めるのが、`deriveRunStatus()` だけである |
| ARCH06 | Finding の fingerprint を作るのが、`createFindingFingerprint()` だけである |
| ARCH07 | Page Rule が `RULE_CATALOG` に1回だけ登録され、Rule Engine がそれだけを使う。Cross-page が `evaluateCrossPageRules()` だけを通る。Reporter（`src/report/**`、`src/cli/**`）で Rule を評価しない |
| ARCH08 | JSON の検証が `validateArtifact()` に委ねられている。最終の書き出しの owner が `ArtifactWriter` だけである |

- 近似の検査なので、誤検知と見逃しが起きうる。次のように扱う。
  - 誤検知が出た場合は、理由を付けて、除外の一覧に加える。
  - 除外の一覧は、Gate のファイルの中に1か所だけ置く。
  - 除外の例:
    - スクリーンショットの PNG は、collector が直接書く。これは Evidence の取得であり、最終の JSON の書き出しではない（ARCH08）。
    - `discover-candidates.ts` と `dom-collector.ts` は、href を Evidence として読むが、Link の抽出ではない（ARCH03）。
- ARCH01 の注意
  - `target.id`（例: `example`）は、一般の語として、コードの識別子やコメントに現れることがある。そのため、次のように照らす。
    - `target.id` は、文字列のリテラルの値として、そのまま一致するものだけを違反とする。
    - ホスト名と origin は、`src/**/*.ts` のどこに現れても違反とする。コメントも含む。
  - Gate のテストは、`config/targets/*.json` を読むだけである。対象のサイトには、アクセスしない。
  - `target.id` が一般の語の場合（例: `example`）は、同じ語が識別子（変数の名前など）に現れても、違反にしない。対象のサイトを識別する情報ではないためである（T18d の報告を受けて、2026-09-25 に明記した）。
- ARCH04 の注意（T18d の報告を受けて、2026-09-25 に決定）
  - URL が許可 Origin の中かの判定は、URL の owner（`src/crawl/normalize-url.ts`）の `classifyUrl`、または URL の owner が提供する判定の関数で行う。Rule のファイルなどに、Origin の比較を書かない。
  - 例外として、除外の一覧に理由付きで入れるもの:
    - Passive HTTP authority の owner（`request-policy.ts`）
    - 設定の値どうしの整合の検証（`validate-config.ts`）
    - 正規化できなかったリンクを、ページと同じ Origin かで分ける処理（`technical-rules.ts`。正規化できないので `classifyUrl` を使えず、Rule の入力に許可 Origin がない）
    - そのほか、意味が別のもの（Timing の same-origin など）
- ARCH05・ARCH06 の「別の場所で決めていない」の確認は、名前への代入と、型での読み替えに限った近似である。別の名前を経由して値を決める場合は、検出できない。
- UI Gate と Architecture の Gate は、`tests/architecture/source-scan.ts` の走査（コメント、文字列、正規表現のリテラルを分けるもの）を共通に使う（DEF-011 を受けて、2026-09-25 に決定）。
- 各 Gate には、検出の関数の単体テストを付ける。違反の例と、違反でない例を与えて、誤りを検出できることを確かめる。UI Gate と同じ形である。

### 4.5 実行時間

- Safety と Auditor の Gate は、実際の Chromium を使う。ファイルごとに、1分程度までを目安とする（T18c の報告を受けて、2026-09-25 に「合わせて」から直した。Run を分けないと、Gate ごとの対照を置けないためである）。
- `npm test` で、毎回実行される場所に置く。

## 5. 対象外

- 実サイトへのアクセス（Task 20 以降。ユーザーの許可が必要）
- CC-008 の残りと、CC-010 の残り（Task 18 の後、Task 19 の前に行う）
- `tests/unit/text.test.ts:12` の、見えない BOM の文字の表記（P18e の報告の発見事項1。Task 18 の後の整理で行う）
- RP18r の Minor-1・2（Task 18 の後の整理で行う）
  - PREFLIGHT の失敗のメッセージに、閉じる処理の失敗を含める。
  - 幅の走査の、閉じる処理の期限切れが分かる理由にする。

## 6. 完了条件

- [ ] `GATE-S01`〜`GATE-S10`、`GATE-A01`〜`GATE-A10`、`GATE-ARCH01`〜`GATE-ARCH08` の名前のテストが、すべてあり、PASS する。
- [ ] UI Gate（GATE-UI01〜06）が、PASS する。
- [ ] Architecture と UI の Gate の各ファイルが、1秒以内に終わる。
- [ ] DEF-010 が直っている。
- [ ] `npm run verify` が PASS する。
- [ ] Task 18 のチェックポイントの独立レビューで、Critical 0・Important 0 である。
- [ ] ユーザーの承認を得る（実装タスク指示 第12章）。

## 6.1 Task 18 の完了（2026-09-25）

- T18a〜T18e を行い、Gate の34個（S01〜S10、A01〜A10、ARCH01〜08、UI01〜06）が、すべてそろって PASS した。
- 最後の verify は、94ファイル・3234件で PASS した。
- Task 18 のチェックポイントの独立レビュー R18 で、Critical 0・Important 0 になった。
- チェックポイントの承認は、ユーザーの正式な指示（「記載の範囲においては全て、私の承認済として扱ってよい」）に基づき、承認済みとして扱う。Task 11・14・15 と同じ扱いである。
- R18 の Minor と、これまでに Task 18 の後に回した項目は、Task 19 の前の整理（C18）で行う。

## 7. 設計変更履歴

| 日付 | 契機 | 変更内容 | 影響範囲 |
| --- | --- | --- | --- |
| 2026-09-25 | 初版。Task 18 の着手前の調査 | - | Task 18 |
| 2026-09-25 | T18c の報告 | 4.5 の実行時間の目安を、ファイルごとに1分程度に直した | なし |
| 2026-09-25 | T18d の報告 | 4.4 に、ARCH01 の一般の語、ARCH04 の owner と除外、ARCH05・06 の近似の限界、共通の走査を加えた。T18e を加えた | T18e |
| 2026-09-25 | RP18 の指摘4 | 4.2 に、凍結の失敗の後の無効化を本物の Guard で確かめることを加えた | T18b |
