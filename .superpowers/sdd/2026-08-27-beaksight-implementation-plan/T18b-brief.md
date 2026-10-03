# T18b 指示書: Safety の Gate（GATE-S01〜S10）

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。末尾の「一時ディレクトリの扱い」も守ってください。

## サブタスク

- ID: T18b
- 目的: Safety の Gate（S01〜S10）を、fixture のサーバの境界で確かめる、名前付きの統合テストにする。
- 設計書: `doc/design/2026-09-25-beaksight-task-18-acceptance-gates-design.md`（とくに 4.1 と 4.2）
- 実装計画: `doc/design/2026-09-25-beaksight-task-18-acceptance-gates-implementation-plan.md` の T18b
- 上位の文書:
  - `doc/design/2026-08-27-beaksight-implementation-plan.md` の Task 18 の Step 2
  - `doc/design/2026-08-27-beaksight-implementation-tasks.md` の Safety Invariants
  - `doc/design/2026-08-27-beaksight-web-audit-design.md` の第30章
- 前の報告: 作業記録置き場の次のもの
  - `T18a-report.md`（加えた fixture と、試みるリクエストの一覧）
  - `RP18-review-result.md`（指摘4）
- 共通部品台帳: `doc/design/beaksight-shared-components.md`（テスト補助の行）

これまでの変更は、作業ツリーにそのまま残っています。HEAD に戻す操作は禁止です。

**このサブタスクは、T18c（`tests/integration/auditor-gates.test.ts`）と T18d（`tests/architecture/` の新しいファイル）と並行で実行します。**

- 下の「変更してよいファイル」の外は、変更しないでください。
- `npm run verify` と `npm run build` は、実行しないでください。全体の verify は、設計者が行います。
- 担当のテストと `npm run typecheck` は、実行してかまいません。
  - ほかの実装者の作業中のファイルから、型のエラーやテストの失敗が出た場合は、自分のファイルのものでないことを確かめて、報告に書いてください。

## 変更してよいファイル

- 新規: `tests/integration/safety-gates.test.ts`
- 新規: `tests/helpers/gate-harness.ts`（サーバの境界で数える補助など。T18c は、このファイルを使わない）
- `src/` と `fixtures/` は、変更しません。
  - Gate のテストが、今のコードで FAIL した場合は、安全の不変条件が破られている可能性があります。止まって、事実を報告してください。
  - fixture が足りない場合も、止まって報告してください。

## 作るもの

1. **テストの名前**: `GATE-S01` 〜 `GATE-S10` を、テストの名前の先頭にそのまま含める。1つの Gate に、複数のテストがあってよい。
2. **確かめ方**（設計書 4.2）
   - どの Gate も、fixture のサーバの側で、「届かなかった」ことを数えて確かめる。
     - 使うのは、`getCounters()` と `getRequestObservations()` の差分である。
     - Ledger の記録は、補助の確認として加えてよい。Ledger だけで確かめてはいけない。
   - 各 Gate で確かめることは、設計書 4.2 の表のとおりにする。要点は次のとおり。
     - S01・S02: POST、PUT、PATCH、DELETE の4つとも、Passive の段階と Interaction の段階の両方で、サーバに届かない。
       - PATCH には、T18a の `passive-patch-request.html` と `patch-request.html` を使う。
     - S03: `mailto:`、`tel:`、外部のアプリの起動が、行われない。
     - S04: Interaction 中のポップアップが遮断される。`GET /popup-target.html` が0件である。
     - S05: Interaction 中のダウンロードが遮断される。`/__download` への GET が0件である。
     - S06: Interaction 中の移動が遮断される。`GET /navigation-target.html` が0件である。
     - S07: Interaction 中の WebSocket が遮断される。`webSocketUpgrade` が0である。
     - S08: Service Worker が、遮断を迂回できない。T18a の `service-worker-post.html` で、Worker の POST がサーバに届かない。Passive と Interaction の両方で確かめる。
     - S09: 機密のヘッダが、書き出した artifact に含まれない。
       - 実際の Run を、`ArtifactWriter` で書き出す。例えば、`finishAuditRun` か `runCli` を使う。
       - fixture が付ける秘密の値の文字列（例: `fixture-*-secret`）が、書き出したファイル（run.json、audit.json、各 page.json、report.html、バンドルの ZIP の展開後の中身）のどこにもないことを確かめる。
       - そのうえで、その秘密の値のヘッダが、実際にリクエストかレスポンスにあったことも、対照として示す。
     - S10: Guard の初期化が失敗した場合に、対象のサイトに触れない。
       - Run Coordinator と CLI（同じプロセスの中の `runCli`）の段階で確かめる。
       - fixture への GET が0件であること。
       - Run Status が、設計書 5.6.7 の区別のとおりであること（Guard の取り付けの失敗で違反があれば `ABORTED_BY_SAFETY`、なければ `FAILED`）。
       - 終了コードが、その Run Status のとおりであること。
       - 差し込み口は、既存の Browser の差し替え（例: `tests/helpers/browser-opening-page.ts`）を使う。
3. **終了コード 3 を最後まで通す**（設計書 4.2）
   - 同じプロセスの中の `runCli` で、Run Status が `ABORTED_BY_SAFETY` になり、終了コードが 3 になる経路を、1件以上確かめる。
   - fixture への GET 以外のリクエストが、0件であることも確かめる。
   - S10 の中か、別の補助の確認として置く。
4. **凍結の失敗の後の無効化**（RP18 の指摘4。設計書 4.2）
   - 本物の Guard の付いた Context で、凍結の失敗の後の無効化が終わらない状態を作る。
   - そのうえで、その後の POST や移動が、サーバに届かないことを確かめる。
   - 無効化が終わらない状態の作り方は、実装者が決めて報告する。
     - 例: Browser の Proxy で、`context.close()` を止める。
     - Guard と factory のコードは、変えない。
   - S04 か S06 の中か、補助の確認として置く。
5. **補助**
   - サーバの境界で数える補助（差分の取り方、パスでの絞り込み）は、`tests/helpers/gate-harness.ts` に置く。
   - 既存の補助（`tests/helpers/` の `chromium.ts`、`test-config.ts`、`passive-cleanup.ts`、`audit-run-fixture.ts` など）を使う。同じ準備の処理を、新しく書かない。
6. **実行時間**
   - ファイル全体で、1分程度までを目安とする。所要時間を報告に書く。
   - 期限のテストは、実際の時間を待たない。短い期限を注入する。

## 受け入れ条件

- `GATE-S01`〜`GATE-S10` の名前のテストが、すべてあり、PASS する。
- 各 Gate の確認が、実装の誤りを検出できる形である。
  - Gate のテストは、実装を壊して RED を作ることができない（`src/` を変えないため）。代わりに、各 Gate に、対照の確認を置く。
    - 対照の確認の例: Guard のない Context では、同じ操作で、リクエストがサーバに届くこと。
  - 対照の確認が置けない Gate は、その理由を報告に書く。
- `npm run typecheck` が PASS する。
- `npm run verify` は実行しない（並行作業のため）。

## 報告

共通ルールの形式で、日本語で報告してください。報告には、次の2つを入れてください。

- Gate ごとに、何を、どの fixture で、どう数えて確かめたか
- 対照の確認の有無
