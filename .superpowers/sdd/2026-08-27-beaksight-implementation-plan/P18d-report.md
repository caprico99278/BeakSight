# P18d 実装報告（要約。設計者が保存）

## 結論

完了した。担当の13ファイル（939件）、unit と architecture の全体（1793件）、関連する統合テスト（26件）、typecheck が PASS した。並行作業のため、verify は実行していない。

1. DEF-009
   - `createRunArtifactDirectory` を、`src/core/artifact-layout.ts` に置いた。
     - 出力先は `recursive` で作り、Run のディレクトリは `recursive` なしで作る。
     - 作れなかった場合は、例外ではなく結果で返す。Run のディレクトリそのものが `EEXIST` だった場合は、`alreadyExists` を真にする。
   - Run Coordinator は、PREFLIGHT の前に、これを呼ぶ。作れなかった場合は、次のとおりにする。
     - Browser を起動せず、対象のサイトにもアクセスしない。
     - `preflightFailed` と、理由 `RUN_DIRECTORY_UNAVAILABLE` で Run を確定する。Run Status は、`deriveRunStatus` が `FAILED` と導く。
     - そのうえで、専用の例外 `RunDirectoryUnavailableError`（確定した Run、パス、`alreadyExists`）で reject する。
   - CLI は、この例外を受けると、`ArtifactWriter` を呼ばない。
     - 標準エラーに、日本語の文言、Run Status、パス、1行の詳細を示す。
     - 終了コードは、Run Status から決まり、1 になる。
   - 理由のコード `RUN_DIRECTORY_UNAVAILABLE` を、次の3か所に加えた。
     - contracts
     - run のスキーマ
     - `messages.ts`
2. R15r-3: `#crawl` の `catch` でも、`maxRuntimeExceeded` を記録する。理由と Run Status の決め方は、変わらない。
3. R17r の Minor-1: `src/cli/index.ts` のコメントを、設計書 第7章に合わせた。
4. 期限の注入
   - `RunCoordinatorDependencies.browserCloseTimeoutMs?` を加えた。
   - Browser の終了のテストは、10,294ms から 108ms になった。条件は弱めていない。
5. R17r の Minor-2
   - Run Coordinator を差し替える口（`createRunCoordinator`）を、加えた。
   - テストでは、スキーマに合わない COMPLETE の Run を返させる。`runAuditCommand` の終了コードが、導き直した後の PARTIAL（2）になることを確かめる。

## 実装者の判断と、設計者の判断

1. 失敗の形を、返り値ではなく専用の例外にした。→ 承認する。
   - 返り値にすると、呼び出し側がそのまま `ArtifactWriter` に渡し、別の Run のディレクトリに書くおそれがある。
   - 例外にすれば、この誤りが起きにくくなる。
2. 出力先そのものを作れない場合も、同じ経路で `FAILED` にした。文言は分けた。→ 承認する。
   - 既存の CLI のテスト「書き出しの失敗」の起こし方は、変えた。期待値は変えていない。
   - 前の起こし方は、新しいテストとして残した。
3. 失敗は、標準エラーに示す。→ 承認する。
4. 期限の値の検証に、`passiveTimeoutMs` を使った。→ 承認する。P18e で名前を直すときに、この呼び出し元も対象にする。
5. 共通部品台帳。→ 設計者が行った。

## 発見事項と、設計者の判断

1. 例外の経路でも、`now()` を呼ぶようになった。→ 承認する。注入した `now` が例外を投げるのは、不正な依存の約束の範囲である。
2. `ArtifactWriter` を使わずに Run Coordinator だけを動かすと、空の Run のディレクトリが残る。→ 受け入れる。害はない。
3. 並行作業中に、P18c の作業中のファイルの型のエラーで、一時ビルドが1回失敗した。→ 後で実行し直して PASS した。設計者の verify で確かめる。
4. 設計書 5.6.1・5.6.7 の更新。→ 設計者が、Task 18 の前の整理の設計書 第6章を参照する形で直した。
