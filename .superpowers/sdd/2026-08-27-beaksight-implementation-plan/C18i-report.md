# C18i 実装報告（要約。設計者が保存）

## 結論

完了した。実装者の報告では、`npm run verify` は PASS した（97ファイル、3,516件）。

- 別のプロセスの iframe（OOPIF）にも、page と同じ Document の横取り（Request と Response の段階）を付けた。入れ子の OOPIF も同じである。
- 付け方:
  - page の CDP の session で、`Target.setAutoAttach` を送る（`autoAttach: true`、`waitForDebuggerOnStart: true`、`flatten: false`、`filter: iframe`）。
  - 子の session には、`Target.sendMessageToTarget` で次の順に送る。
    1. `Fetch.enable`
    2. 入れ子のための `Target.setAutoAttach`
    3. `Runtime.runIfWaitingForDebugger`
- 時間の窓: ない。`waitForDebuggerOnStart` で、OOPIF の Document が確定する前に止め、横取りを付けてから進める。
- 共通の判定は、`createDocumentInterception(channel)`（`passive-request-guard.ts:1179`）の1つにした。page と OOPIF で、同じ処理を使う。
- fail-closed の違反:
  - `OOPIF_GUARD_ATTACH_FAILED`: 付与の失敗、上限（`MAX_GUARD_OOPIF_SESSIONS` = 64）の超過、不正な target
  - `OOPIF_GUARD_PROTOCOL_FAILED`: 子の session のメッセージを解析できない場合
  - どちらも、Context を閉じ、OOPIF は進めない。
- OOPIF ができていることの確かめ方:
  - `--site-per-process` の headless で起動する。
  - `Target.getTargets` に、`type === 'iframe'` の target があることを見る。
  - `context.newCDPSession(frame)` が成功することを見る。
- 確かめたこと:
  - OOPIF の中の外部スキームへのリダイレクトが、`EXTERNAL_SCHEME_REDIRECT_BLOCKED/SUB/PASSIVE` として記録され、違反は0件であること（headless と、headed の注入）
  - 遅いリダイレクトで、偽の違反が出ないこと
  - 既存の判定（POST、PUT、DELETE、form の送信、一番上の frame の外への移動、凍結の後）が、そのまま働くこと
- GATE-S03 に、OOPIF の経路を7件加えた。gate-fixtures に、対照の確認を6件加えた。
- N2: 幅の走査の中で違反が起きたときの理由を、`stress-layout:SAFETY_VIOLATION_ABORT` にした（`page-auditor.ts`）。

## 実装者の判断と、設計者の判断

1. 付与の途中で OOPIF が消えた場合は、違反にしない。→ 承認する。横取りする frame がもうない。付与が済んだ後の失敗は、page と同じく違反にする。
2. 上限の64件を、Guard のファイルの中の定数にした。→ 承認する。実サイトで超える場合は、監視の項目（DEF-014）で扱う。
3. N2 の確かめは、注入された `safetyViolationRecorded` を使う。→ 承認する。違反の検出の owner を増やさない。
4. `--site-per-process` のブラウザの起動が、3つのテストファイルにある。→ CC-029 に加えた。
5. OOPIF を含むページでは、読み込みの準備の往復が増える。→ 承認する。

## 発見事項と、設計者の判断

1. 1つのページで、64件を超える iframe を同時に読み込むと、`REDIRECT_PREDECESSOR_LIMIT_REACHED` の違反になる（今回の変更の前からある）。
2. 横取りの処理中に frame が消えると、`CDP_CONTINUE_REQUEST_FAILED` などの違反になる（前からあり、OOPIF もそろえた）。
3. Guard が止めた main frame の移動の後は、page が `chrome-error://chromewebdata/` になる（既存の扱い）。

→ 1・2 と判断2 は、実サイトで偽の違反になりうる。
- どれも fail-closed の側なので、安全は保たれる。ただし、Run が不要に `ABORTED_BY_SAFETY` になるおそれがある。
- 監視の項目 DEF-014 として登録した。
- 実サイトの smoke（Task 20）で起きた場合に、直し方を決める。
