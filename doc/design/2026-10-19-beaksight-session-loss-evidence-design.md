# 設計書 — セッションの切れを判定したページの記録を残す（DEF-138）

状態: ユーザー承認済み（2026-10-19「進めて」）
作成: 2026-10-19（設計者）

## 1. 経緯

実テスト環境の監査（2026-10-19 午後）で、2 ページ目の読み込みがログインの画面（セッションの切れの path）に行き着き、Run が `AUTH_SESSION_LOST` で止まり、残りのページを飛ばした。午前の Run では、同じページがログインした表示のまま監査できていた。ユーザーの指示「原因をログから特定して」に対し、記録からは特定できなかった。セッションの切れを判定したページは、記録を捨てる（ビューポートを `SKIPPED` にし、証拠を残さない）。ジョブに残る URL も、頼んだページの URL で、行き着いた先ではない。ユーザーの判断: 「新しい情報を得られないならもう一度やっても意味がない」→ 記録を残す直しを先に行う。

## 2. 設計

### 2.1 記録する中身（セッションの切れの証拠 `SessionLossEvidence`）

セッションの切れを判定した読み込み 1 回について、次を記録する。値（token、Cookie の値、query の値、本文、ヘッダの値）は記録しない。

- `stage`: 判定した段階（今の `detail` と同じ値。例 `desktop:passive`）。
- `requestedPath`: 頼んだ URL の path（query は名前だけ。今の URL の伏せ字の部品 `redactUrlSecrets` と同じ決まり）。
- `landedPath`: main frame の最後の URL の path（同じ決まり）。Guard が止めたリダイレクトの先で判定した場合は、その URL の path と、止めたことの印 `landedBy: 'PAGE_URL' | 'BLOCKED_REDIRECT'`。
- `redirectPaths`: main frame の文書の要求の経路（リダイレクトの各段）の Origin の区別（許可 Origin か、そのほか）と path。上限は名前つきの定数（例 10）。
- `blockedRequests`: この読み込みの間に Guard が止めた要求の形（method、Origin の区別（許可 Origin、承認したサービスの Origin、そのほか）、path、理由、回数）。今の安全の記録と同じ形・同じ上限の部品を使う。
- `storageKeyChange`: 読み込みの前（Context に入れた状態）と後（読み込みの後の Context の状態）の、許可 Origin と承認したサービスの Origin の、ローカル ストレージの鍵と Cookie の名前の違い（消えた名前、増えた名前）。名前の扱いは、ログインの段の観察の部品（`src/worker/login-stage-observation.ts` の鍵の名前の形、`login-observation-draft.ts`）と同じ決まり（秘密に見える名前の扱いを含む）にし、複製しない。上限は名前つきの定数。
- 作るのは 1 つの部品（`authenticated-run.ts` の `sessionLostUrlOf` の隣。判定と同じ owner）。Page Auditor（監査）と、ワーカーの 1 画面の読み込み（`worker-run-session.ts`。発見・READ の確かめ）が共用する。書き込みの流れは今回の範囲の外。

### 2.2 残す場所

- 監査の Run: `run.json` の `authentication` に任意の項目 `sessionLoss`（Run は最初の切れで止まるので 1 件）。`run.schema.json` に足す（任意の項目なので版は `run-schema/1.0` のまま。既存の `authentication` の説明「Counts only; never a URL」は、path を持つ項目を足す形に直す）。ページの記録（`page.json`）の `incompleteReasons` は今のまま。
- ジョブ: ワーカーの `AUTH_STATE`（`SESSION_LOST`）に任意の `sessionLoss` を足し、親は管理データに残す（今の JSON の列に入れられるならそこに、要るなら列を足す。版 16 が要るなら版 15 の写しを固定してから）。ジョブの画面の「止まったページの URL」の近くに、行き着いた先・リダイレクトの経路・止めた要求・鍵の名前の違いを出す。文言はカタログ。
- 発見・READ の確かめ: 今の結果の記録（セッションの切れの記録がある場所）に同じ証拠を足す。

### 2.3 安全と負荷

- 要求は増えない（読み込みの後の状態の読み取りは、Node 側の Context の状態の読み取りで、サイトへの要求ではない）。
- 値は記録・IPC・成果物・画面に出さない（受け入れ条件で確かめる）。

## 3. 受け入れ条件

1. fixture（認証つきの SPA。2 ページ目でクライアントの側からログインの画面へ移る、およびサーバの側でリダイレクトする、の 2 つ）で、監査の Run の `run.json` の `authentication.sessionLoss` に、`requestedPath`・`landedPath`・`redirectPaths`・`blockedRequests`・`storageKeyChange` が残る。
2. ジョブの画面に同じ中身が出る。
3. 発見・READ の確かめのセッションの切れにも同じ証拠が残る。
4. token・Cookie の値・query の値・パスワードが、`run.json`・管理データ（WAL を含む）・IPC・画面に出ない（目印の値で確かめる）。
5. 今のセッションの切れのテスト（止める・飛ばす・知らせ）が変わらず通る。

## 4. 設計の変更の履歴

| 日付 | 理由 | 変更 |
| --- | --- | --- |
| 2026-10-19 | 作成 | 実テスト環境の監査で、セッションの切れの原因を記録から特定できなかったため（DEF-138）。 |
| 2026-10-19 | DEF-138 の報告（設計者の判断） | 読み込みの前の名前は factory の `authenticatedStateNamesOf`（渡した状態と読んだ状態の名前だけ。要求も storageState の呼び出しも増えない）。管理データは版 16（`jobs.session_loss`）。限界として受け入れる: 監査の Run の鍵の消失（`session-key`）では証拠を作らない。証拠は checkpoint に入れないので、再開して終えた Run の `run.json` には残らない。 |
