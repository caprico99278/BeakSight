# RC18c 指示書: OOPIF への Guard の横取りの付与（C18i）の、Guard の確認のレビュー

最初に、作業記録置き場（`.superpowers/sdd/2026-08-27-beaksight-implementation-plan/`）の `RC18a-review-brief.md` を読んでください。厳守事項、重大度の基準、報告の形式は、その指示書に従ってください。

`R-review-common.md` の末尾の「一時ディレクトリの扱い」も、必ず守ってください。一時ディレクトリに、リポジトリへのリンク（ジャンクション、シンボリックリンク）を作ってはいけません。

**Chromium は headless だけで起動してください。headed（`headless: false`）で起動してはいけません。** `--site-per-process` などの起動の引数を付けることは、かまいません。外部スキームの URL には、実在する宛先を使わないでください。本来の監査対象のサイトへの接続は、ユーザーの明示の承認があるまで禁止です。別のサイトの iframe は、`127.0.0.1` と `localhost` のような、ローカルのサーバの別のホスト名で作ってください。

## 担当

1. Guard の確認のレビュー RC18b（`RC18b-review-result.md`）の指摘が、C18i（`C18i-report.md`）で解消したかを確かめてください。
   - 対象の指摘: N1（Important）と N2（Minor）
   - N3 は、設計者が制約として設計書に書きました。対象外です。
   - 指摘ごとに、次のどれかと、その根拠を書いてください。
     - 解消
     - 一部解消
     - 未解消
2. C18i の変更に、新しい問題がないこと、安全の境界が緩んでいないことを、確かめてください。
3. Task 19 の前の整理のうち、DEF-012 と DEF-013 に関わる範囲に、Important 以上の問題が残っていないことを確かめてください。

設計書: `doc/design/2026-09-25-beaksight-pre-task-19-cleanup-design.md` の 4.2、4.2.1、4.5、4.6

## とくに確かめること

1. **OOPIF への付与**
   - 別のプロセスの iframe と、入れ子の OOPIF に、page と同じ横取り（Document の Request と Response の段階）が付くこと。
   - 付けるまでの時間の窓がないこと。
     - 読み込みの直後の移動、OOPIF の最初の Document、OOPIF の中の iframe の最初の Document、Service Worker などの別の種類の target の扱いを、確かめてください。
   - 付与の失敗、上限の超過、不正な target で、fail-closed になること。
   - 付与の途中で OOPIF が消えた場合の扱いが、見逃しにつながらないこと。
   - OOPIF が閉じたときに、session と登録が消えること。
2. **既存の判定の不変**
   - 共通の判定（`createDocumentInterception`）に移したことで、page の session の判定が、変わっていないこと。
     - 許可 Origin、メソッド、リダイレクトの対応付け、`expectedCdpFailures`、外部スキーム、閉じる途中、凍結の後
   - OOPIF の中でも、既存の `context.route` の判定（変更系のメソッド、外への移動）が働くこと。
3. **headed で使う完全版の Chromium に近い条件での確認**
   - `--site-per-process` の headless で、広告のような別のサイトの iframe が、自分でリダイレクトする場合を確かめてください。
   - `channel: 'chromium'` の headless（完全版の Chromium を headless で起動する形）が使えれば、その条件でも確かめてください。
4. **N2**: 幅の走査の中で違反が起きたときの理由が、`stress-layout:SAFETY_VIOLATION_ABORT` になること。
5. **全体**
   - すべての Gate（S、A、ARCH、UI）が PASS すること。
   - 設計書 4.2.1 の表と、OOPIF の制約の記述が、実装と合っていること。直った今は、制約の記述を直す必要があるかも含めて、指摘してください。

## 報告

`RC18a-review-brief.md` の形式で、日本語で返してください。RC18b の指摘の ID ごとの判定を含めてください。
