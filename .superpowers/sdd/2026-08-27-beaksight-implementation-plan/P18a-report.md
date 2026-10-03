# P18a 実装報告（要約。設計者が保存）

## 結論

完了した。担当の7ファイル（117件）と typecheck は PASS した。範囲外の関連テスト（125件）と architecture（18件）も PASS した。並行作業のため、verify は実行していない。

- 定数: `CONTEXT_CLOSE_TIMEOUT_MS = 5_000`、`SESSION_OPEN_TIMEOUT_MS = 10_000`
- `passive-session-close.ts`
  - `closePassiveContextBeforeDeadline(factory, context, { timeoutMs? })` を加えた。
    - 失敗は `{ step: 'context', error }` で返す。
    - 期限切れは `PassiveContextCloseDeadlineError` で返す。
    - Guard がすでに閉じた Context は、閉じ直さない。
  - `closePassivePageBeforeDeadline` と `closePassivePageAndContext` の期限を、注入できるようにした。
  - `passiveTimeoutMs(value, defaultMs)` を加えた。
- 新規 `passive-session-open.ts`
  - `openPassiveSessionBeforeDeadline(factory, viewport, deadlineAtMs, { contextCloseTimeoutMs?, onLateContextRelease? })` を加えた。結果は、`OPENED`、`FAILED`、`DEADLINE_EXCEEDED` の3つである。
    - `FAILED` の場合は、部品は Context を閉じない。今までどおり、呼び出し側が閉じる。
    - `DEADLINE_EXCEEDED` の場合は、部品が Context を閉じる。遅れて届いた Context も閉じる。
  - 手順ごとの `openPassiveContextBeforeDeadline` と `openPassivePageBeforeDeadline` も加えた。
  - `passiveSessionOpenDeadlineAtMs({ timeoutMs?, notAfterMs? })` と `resolvePassiveSessionDeadlines(options?)` も加えた。
- 呼び出し元（設計書 4.4 のとおり）
  - PREFLIGHT は、`PASSIVE_GUARD` の失敗になる。
  - 環境の読み取りは、User-Agent を `null` にする。
  - サイトの metadata は、取得を `FAILED` にし、`closeFailures` に記録する。
  - 幅の走査は、失敗の例外を投げる。`notAfterMs` で、ページの期限を上限にできる。
- 期限のテストの実行時間:
  - PREFLIGHT の Browser の終了: 10,110ms から 421ms へ
  - 幅の走査の page の終了: 5,015ms から 212ms へ
  - site-metadata の page の終了: 5,119ms から 393ms へ
  - passive-session-close の2件: 約7.4秒から約2.9秒へ
- Guard と factory は、変えていない。

## 実装者の判断と、設計者の判断

1. 遅れて届いた Context の結果は、口（`onLateContextRelease`）で受け取れる。渡されなければ、捨てる。今は、どの呼び出し元も渡していない。→ **捨てる形で承認する。**
   - 期限を過ぎたこと自体は、呼び出し元がすでに、失敗か未完了として記録している。
   - 閉じる処理が終わらない間も、Guard はリクエストを止め続ける。最後は、Browser の終了で片付く。
   - 設計書 4.2 の「記録の口に渡す」という記述を、この判断に合わせて直した。
2. 作成が失敗した場合（`FAILED`）は、部品が Context を閉じない。→ 承認する。今の失敗の扱いを変えないためである。
3. site-metadata の、作成の期限切れの `timedOut` を、真にした。→ 承認する。
4. PREFLIGHT の作成の期限切れで、部品が Context を閉じるときの失敗は、メッセージに含めない。→ 承認する。ほかの失敗の経路と同じである。
5. 幅の走査の期限の上限に、`notAfterMs` を加えた。→ 承認する。P18c で、page-auditor からページの期限を渡す。
6. `passiveTimeoutMs` を `passive-session-close.ts` に置き、Browser の終了の期限の検証にも使った。→ **P18e で名前と置き場所を直す。**
   - 期限の値の検証は、Passive に限らない。
   - `src/core/deadline.ts` に、汎用の名前（例: `resolveTimeoutMs`）で置く。

## 発見事項と、設計者の判断

1. 実時間を待つ期限のテストが、まだ3件ある。
   - `page-auditor.test.ts:623` の DEF-006 のテスト → P18c で直す。
   - `run-coordinator.test.ts:1020` 付近の Browser の終了のテスト（10秒） → P18d で直す。
   - `tests/helpers/passive-cleanup.ts` の `closePassiveResources`（5秒）→ P18e で直す。
2. `stress-session.ts` で、Context を作った直後に `getSafetyLedger` が投げた場合に、Context を閉じない。→ 今は直さない。
   - 現実の factory では起きない経路で、前からの振る舞いである。
   - RP18 で、確かめてもらう。
3. 共通部品台帳の更新。→ 設計者が行った。
