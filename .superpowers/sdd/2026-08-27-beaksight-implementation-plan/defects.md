# 不具合台帳

## DEF-001: axe の実行で、Guard の付いた Passive Context が安全違反として閉じられる

- 状態: 修正済み（DEF-001b で、Evidence に検査の範囲の制約 `frameScope: 'SAME_ORIGIN_ONLY'` を記録した）
- 発見日: 2026-09-23
- 発見した経緯: C8（型とスキーマの整備）の実装者が、ローカルの fixture で実際の Evidence をスキーマで検証するテストを書いていたときに見つけた。
- 現象: `fixtures/site/index.html` で `collectAccessibilityEvidence` を実行すると、Safety Ledger に `CDP_SESSION_DETACHED`（「Document interception session detached while its page remained active」）が1件記録され、page が閉じられる。
- 再現手順: Guard の付いた Passive Context で fixture のページを開く。`collectAccessibilityEvidence` を実行し、Safety Ledger の `invariantViolations` を確かめる。
- 影響範囲: Task 14 のページの監査の流れで axe を実行すると、不変条件の違反が記録され、Run が `ABORTED_BY_SAFETY` になる。既存のテストで見つからなかったのは、axe の実行後に Ledger を確かめるテストがなかったためと考えられる（未確認）。
- 発生時期の推測: Task 9（accessibility collector）と、Task 5・11（Guard）の組み合わせで起きる。いつから起きていたかは確かめていない（HEAD に戻す確認は禁止されている）。
- 原因の推測（未確認）: `@axe-core/playwright` の `AxeBuilder` は、既定の方式では、結果をまとめるために同じ BrowserContext に別の page を開く。それが Guard の監視（page ごとの CDP のセッション）と衝突している可能性がある。
- 対応する設計: `doc/design/2026-09-23-beaksight-foundation-corrections-design.md` 第8.1節
- 対応するサブタスク: DEF-001
- 原因（確かめた事実）: `@axe-core/playwright` 4.13.0 は、既定の方式では `context.newPage()` で `about:blank` の page を開き、それを直接閉じる。Guard はその page の CDP のセッションの切り離しを `CDP_SESSION_DETACHED` として記録し、Context を無効化していた。Guard の判定は仕様どおりである。
- 修正: axe をレガシーの方式（`setLegacyMode(true)`）で実行するようにした。
- 検証結果: 新しい統合テスト `tests/integration/accessibility-guard-safety.test.ts` で確かめた。修正前は RED で、修正後は GREEN になった。3回続けて実行し、3回とも PASS した。accessibility に関係する4ファイル・33件も PASS した。

## DEF-002 Evidence の ID の接頭辞の表が、Object の既定のプロパティ名を受け付ける

- 発見: 2026-09-24、P14b の実装者の報告（推測。実行では未確認）
- 現象:
  - `src/core/ids.ts` の `formatEvidencePrefix` は、普通のオブジェクト `evidencePrefixes` を `evidencePrefixes[type]` で引く。
  - この値が undefined かどうかで、種類の正しさを判定している。
  - そのため、`'constructor'` や `'toString'` を渡すと、関数の値が接頭辞として使われる。`RangeError` にならない。
- 影響:
  - `createEvidenceId` と `IdAllocator.allocateEvidenceId` が、不正な種類から ID を作るおそれがある。
  - 型の検査では防げるが、実行時の入力（テストや、将来の外部の入力）では防げない。
- 発生時期: 不明（HEAD との比較はしない）。
- 修正方針:
  - 表を `Object.hasOwn` で確かめる。または、`EVIDENCE_TYPES` に含まれるかで確かめる。
  - 同じ形の表がほかにもあれば、あわせて直す。
- 状態: 修正済み（2026-09-24）。`Object.hasOwn` で判定する。同じ形の不具合が `validateArtifact` にもあったので、あわせて直した。

## DEF-003 Interaction の除外理由の記録先の表が、Object の既定のプロパティ名を受け付ける

- 発見: 2026-09-24。DEF-002 の実装者が、同じ形の箇所を探した結果として報告した。
- 現象: `src/safety/interaction-policy.ts` の `interactionRejectionLedgerRecord` は、普通のオブジェクトの表を、存在を確かめずに引いている。
- 影響: いまは、実害のある経路がない。
  - 呼び出し元は1か所で、閉じた集合から作った理由だけを渡している。
  - 継承したプロパティ名が渡った場合は、Ledger に記録しない扱いになる（推測）。
  - それでも、安全の判定の部品なので、fail-closed の形にそろえる。
- 修正方針:
  - `Object.hasOwn` で確かめる。
  - 表にない理由は、例外にする。
- 実施の時期: Task 14 のチェックポイントの後に、CC-017 と同じサブタスクで行う。どちらも Interaction の周辺の変更なので、1回のサブタスクで扱う。
- 状態: 修正済み（2026-09-24、C14x）。表にない理由は、`TypeError` にする。

## DEF-004 ネットワークの層の失敗で、Guard が安全の不変条件の違反を記録する

- 発見: 2026-09-24。R15a の実装者の報告による。
- 現象:
  - 許可した GET のメインフレームのナビゲーションが、ネットワークの層で失敗することがある。確かめた例は、`net::ERR_CONNECTION_REFUSED` である。
  - このとき、`src/safety/passive-request-guard.ts` の `requestfailed` の処理（1296行目付近）が、`HTTP_MAIN_FRAME_DELIVERY_FAILED` を違反として記録し、Context を無効にする。
- 影響:
  - Run Status の入力の違反の件数に数えられるので、一時的なネットワークの失敗でも、Run が `ABORTED_BY_SAFETY` になる。
  - 設計書 5.2 の再試行（`ERR_CONNECTION_RESET` など）と矛盾する。
  - Page Auditor の理由に、閉じる処理の失敗（`UNHANDLED_FAILURE`）が加わる。
- 原因の分析:
  - この違反は、Guard 自身の不具合を、fail-closed で検出するためのものである。例えば、配送の取りこぼしや、予期しない中断である。
  - 許可した GET と HEAD は、ネットワークの層で失敗しても、安全の問題にならない。サーバに届いても、読み取りだけだからである。
  - しかし、いまの書き方は、これを区別していない。
- 発生時期: Task 5 の時点からの振る舞い（progress.md に「connection refusal remains immediate」の記録がある）。HEAD との比較はしていない。
- 修正方針（設計者）:
  - 違反から外すのは、次の3つの条件をすべて満たす場合だけにする。
    - 許可した（ALLOW）GET か HEAD の、メインフレームのナビゲーションである。
    - 失敗の理由が、ネットワークの層の失敗である。
    - その理由が、閉じた一覧に載っている。
  - 閉じた一覧は、`src/safety/` の1か所に置く。
  - `net::ERR_ABORTED`、`net::ERR_FAILED`、`net::ERR_BLOCKED_BY_CLIENT`、`net::ERR_BLOCKED_BY_RESPONSE` などは、一覧に入れない。これらは、Guard の不具合を示しうるので、これまでどおり違反とする。
  - 修正の後に、Guard の安全の性質の独立レビューを行う。
- 状態: 修正済み（2026-09-24）。閉じた一覧は `src/safety/network-layer-failure.ts` にある。Guard の独立レビュー（RDEF4）は承認。
- 追加の修正（DEF-004b）: 違反から外すのは、凍結中でない場合に限る（RDEF4 の Minor-1）。修正済み（2026-09-24）。
- 観察の対象（RDEF4 の Minor-2）: 一覧にないネットワークの層の失敗がある。
  - 該当するのは、`ERR_HTTP2_PROTOCOL_ERROR`、`ERR_QUIC_PROTOCOL_ERROR`、`ERR_PROXY_CONNECTION_FAILED`、`ERR_TUNNEL_CONNECTION_FAILED`、`ERR_SOCKET_NOT_CONNECTED`、`ERR_NETWORK_IO_SUSPENDED`、`ERR_CONTENT_LENGTH_MISMATCH`、`ERR_INCOMPLETE_CHUNKED_ENCODING`、`ERR_RESPONSE_HEADERS_TRUNCATED`、`ERR_BAD_SSL_CLIENT_AUTH_CERT`、`ERR_CERTIFICATE_TRANSPARENCY_REQUIRED` である。
  - fail-closed の扱いのまま、違反とする。
  - 実際のサイト（Task 20・21）で起き、Run が `ABORTED_BY_SAFETY` になった場合は、そのコードを一覧に入れるかを、Guard の独立レビューとともに判断する。

## DEF-005 外部へのリダイレクトの遮断と、接続拒否を続けた後に、Context を閉じる処理が止まる（疑い）

- 発見: 2026-09-24。R15d の実装者の報告による。設計者も再現した。
- 現象:
  - `tests/integration/page-navigation.test.ts` の191行目のテスト（`judges BLOCKED_EXTERNAL_REDIRECT by the increase ...`）が、`afterEach` の後片付けで、30秒の期限を過ぎて失敗する。
  - このテストは、1つの Guard の付いた page で、2回ナビゲーションする。
    1. 外部へのリダイレクトの遮断
    2. 接続拒否
  - 後片付けでは、`closePassiveResources` を使う。
  - このテストを単独で実行すると PASS する。直前の「接続拒否」のテストと続けて実行すると、失敗する（実装者の報告）。
- 経緯:
  - DEF-004 の後の設計者の verify（68ファイル）では、PASS していた。
  - その後に入った変更は、DEF-004b（Guard の条件1つ）と R15d である。R15d は、このテストが使うファイルを変えていない。
- 影響（推測）:
  - 製品のコードで、Context を閉じる処理が止まるのであれば、実際の Run でも、接続拒否の後にページを閉じる処理が、最大30秒止まるおそれがある。
  - DEF-004 で、接続拒否で Context を無効にしなくなったことが、関係している可能性がある。以前は、無効化によって、Context がすぐに閉じられていた。
- 発生時期: HEAD との比較はしない。
- 原因（2026-09-24、DEF-005 の調査）: 製品のコードではない。
  - エラーページを表示している page で、次のナビゲーションも失敗し、その直後に `page.close()` を呼ぶと、Chromium は page を閉じない。これは、Guard の有無に関係しない。
  - DEF-004 より前は、Context の無効化によって、この経路が隠れていた。
- 状態: 修正済み。テストの後片付けを、Context を閉じる形に直した。潜在的な問題は、DEF-006 とした。

## DEF-006 page を閉じる処理に期限がなく、Chromium の条件によっては永久に止まる（潜在的な不具合）

- 発見: 2026-09-24。DEF-005 の調査による。
- 現象:
  - エラーページを表示している page で、次のナビゲーションも失敗し、その直後に `page.close()` を呼ぶと、Chromium は page を閉じない。この場合、`page.close()` は永久に終わらない。
  - 期限のない `page.close()` は、次の箇所にある。
    - `src/safety/passive-request-guard.ts` の `closePassiveGuardedPage`
    - `src/orchestration/passive-session-close.ts`
    - `tests/helpers/passive-cleanup.ts`
- 影響:
  - いまの製品のコードは、ナビゲーションごとに新しい page を開くので、この条件には当たらない（推論）。
  - ただし、当たった場合は、Run 全体が永久に止まる。Task 14 の方針（止まり続ける経路を残さない）に反する。
- 修正方針:
  - page を閉じる処理に、期限を付ける。期限は、名前を付けた定数にする。
  - 期限を過ぎた場合は、Context を閉じる処理に切り替える。Context を閉じれば、止まった page も閉じる。
  - 期限を過ぎたことは、閉じる処理の失敗として記録する。
  - Guard の `closePassiveGuardedPage` を変える必要があるかは、実装者が調べて報告する。Guard を変える場合は、独立レビューを行う。
- 実施の時期: Task 16 の前の整理のサブタスク（CC-021 と同じサブタスク）。
- 状態: 修正済み（2026-09-24、C15x）。page は `PAGE_CLOSE_TIMEOUT_MS`、Browser は `BROWSER_CLOSE_TIMEOUT_MS` の期限で閉じる。

## DEF-007 再試行すると、最初の試行のスクリーンショットが上書きされる

- 発見: 2026-09-24。R15e の実装者の報告による。
- 現象:
  - Page Auditor のスクリーンショットのパス（`screenshotCapturePaths(root, pageId, profile)`）は、試行を区別しない。
  - 再試行は、同じ `pageId` で行う。そのため、2回目の試行が、最初の試行のファイルを上書きする。
  - R15e で、最初の試行の Evidence を残すようにした。その結果、最初の試行の `screenshot` の Evidence が、別の試行の画像を指すことになる。
- 影響: Evidence と、それが指すファイルが食い違う。証拠として正しくない。
- 修正方針:
  - 再試行の前の試行のスクリーンショットは、`pages/<pageId>/retry-<n>/<ビューポート>/` に置く。
  - 最終の試行のものは、これまでの場所に置く。
  - Coordinator から Page Auditor に、試行を区別する情報を渡す。例えば、スクリーンショットの置き場所の副ディレクトリである。
- 実施の時期: C15x（Task 15 の後の整理）で行う。
- 状態: 修正済み（2026-09-24、C15x）。再試行の前の試行のスクリーンショットは、`retry-<n>` に置く。

## DEF-008 Context を閉じる処理と、Context・page を作る処理に、期限がない（潜在的な不具合）

- 発見: 2026-09-24。R15r の Minor-1 による。
- 現象: 次の処理に、期限がない。
  - `src/safety/passive-request-guard.ts` の `context.close()`（429行目付近）
  - Context と page を作る処理
- 影響（推測）:
  - DEF-005 の観察では、Context を閉じる処理は、止まった page も閉じた。そのため、現実の危険は低い。
  - それでも、止まった場合は、Run が止まり続ける。
- 修正方針: 期限を付ける。期限を過ぎた場合の扱いは、Guard の設計に関わる。そのため、設計者が決め、Guard の独立レビューを行う。
- 実施の時期: Task 18 の前の整理で行う。
- 進み具合: P18a で、PREFLIGHT、環境の読み取り、サイトの metadata、幅の走査に、期限を付けた（2026-09-25）。P18c で、Page Auditor と Interaction に、期限を付けた（2026-09-25）。
- 状態: 修正済み（2026-09-25、P18a・P18c）。Guard の独立レビュー（RP18）で確かめる。

## DEF-009 同じ秒に始めた2つの Run が、同じディレクトリに書く

- 発見: 2026-09-25。R16 のレビューの指摘の4による。
- 現象:
  - `runId` は、開始の時刻の秒の単位で作る（`src/orchestration/run-id.ts`）。
  - 同じ UTC の秒に始めた2つの Run は、同じ `runId` になり、同じ Run のディレクトリに書く。
  - Page Auditor のスクリーンショットと、`ArtifactWriter` の書き出しは、どちらも既存のディレクトリを検出しない。
- 影響:
  - 2つの Run の artifact が混ざるか、上書きされる。証拠として正しくない。
  - 起きるのは、同じ出力先に、ほぼ同時に2つの CLI を起動した場合に限られる。
- 修正方針（案。Task 18 の前の整理で、設計を書いてから行う）:
  - Run Coordinator が、Run の開始の時点で、Run のディレクトリを排他的に作る。親のディレクトリは作ってよいが、Run のディレクトリそのものは、すでにあれば失敗させる。
  - 失敗した場合は、対象のサイトにアクセスする前に止める。
  - 扱いは、PREFLIGHT の失敗と同じく `FAILED` とし、理由を付ける。
- 実施の時期: Task 18 の前の整理（DEF-008 と同じ時期）。
- 状態: 修正済み（2026-09-25、P18d）。Run のディレクトリを、PREFLIGHT の前に排他的に作る。作れなかった場合は、理由 `RUN_DIRECTORY_UNAVAILABLE` で `FAILED` とし、artifact を書かない。

## DEF-010 ポップアップと移動の先の確認が、常に真になる（既存のテストの欠陥）

- 発見: 2026-09-25。Task 18 の着手前の、読み取り専用の調査による。
- 現象:
  - `tests/integration/isolated-interaction.test.ts:1846-1847、1864` は、ポップアップと移動の先のページへのリクエストが届かないことを確かめている。
  - しかし、確かめるパスが `'popup-target.html'` と `'navigation-target.html'` で、先頭の `/` がない。
  - fixture のサーバが記録するパスは、必ず `/` で始まる。そのため、この確認は常に真になり、何も確かめていない。
  - 確認の対象のファイルも、`fixtures/site/` にない。
- 影響:
  - Interaction 中のポップアップと移動の遮断（Safety Invariants の S04・S06）を、サーバの境界で確かめていないことになる。
  - Ledger の記録の確認は、別にある。そのため、遮断そのものが働いていないとは限らない（推測）。
- 修正方針: Task 18 の T18a で、次の2つを行う。
  - 移動の先のページを `fixtures/site/` に置き、確認のパスを直す。
  - Safety の Gate（S04・S06）でも、サーバの境界で確かめる。
- 実施の時期: Task 18（T18a）
- 状態: 修正済み（2026-09-25、T18a）。パスを直した後も、遮断のテストは PASS した。対照の確認で、Guard がなければ GET が届くことも示した。

## DEF-011 UI Gate のコメントの除去が、文字列の中の `/*` を誤って扱う

- 発見: 2026-09-25。T18d の報告の発見事項1による。
- 現象:
  - `tests/architecture/ui-ssot.test.ts:81-82` の `stripComments` は、正規表現だけでコメントを除く。
  - そのため、文字列の中の `/*` を、コメントの始まりとみなす。
  - 例: `src/safety/passive-request-guard.ts:1385` の `'**/*'` から1481行までが、コメントとして消える。
- 影響:
  - 消えた範囲は、GATE-UI04・UI06 と、CC-016 の検査（`join('、')`）から抜け落ちる。そこに違反があっても、検出できない。
  - 今は、その範囲に対象の式がないので、結果に違いはない（T18d の確認）。
- 修正方針: UI Gate も、T18d で作った `tests/architecture/source-scan.ts` の走査を使う形にする。この走査は、コメント、文字列、正規表現のリテラルを分ける。
  - あわせて、ファイルの一覧の取得と読み込みの重複もなくす。
  - 修正の前に、文字列の中に `/*` がある例で、今の関数が誤ることを RED で確かめる。
- 実施の時期: Task 18（T18e）
- 事実の訂正（2026-09-25、T18e の報告による）:
  - 上の「1385行から1481行までが消える」は、今のソースでは起きていなかった。その `'**/*'` の後ろには、閉じる `*/` がない。
  - 実際に消えていたのは、`src/crawl/normalize-url.ts:161` の1行だった。テンプレートの中の `//` を、行コメントとみなしていた。
  - 不具合そのもの（文字列の中の `/*` や `//` の誤った扱い）は、RED のテストで実際に起きることを確かめた。
- 状態: 修正済み（2026-09-25、T18e）。UI Gate も、`tests/architecture/source-scan.ts` の走査を使う形にした。修正の後、どちらの範囲も検査され、違反はない。

## DEF-012 ページのスクリプトによる外部スキームへの移動を、Guard が検出も記録もしない

- 発見: 2026-09-25。R18 の M3 を受けた、読み取り専用の調査による。調査は headless だけで行った。
- 現象:
  - ページのスクリプトが、外部スキーム（`tel:`、`mailto:`、独自のスキーム）へ移動しようとしても、Guard は止めない。Ledger にも、何も記録しない。
  - 経路は、`location.href`、`location.assign`、meta refresh、iframe の src、スクリプトによる anchor の click、form の action、本物の click による移動である。
  - 外部スキームはネットワークを通らないので、`context.route('**/*')` と CDP の `Fetch` が働かない。
  - `requestfailed` は届くが、分類が BLOCK なので、Guard は何もしない（`passive-request-guard.ts:1242-1300`）。
- 影響:
  - headless: 外部のアプリは起動しない。このバイナリ（`chrome-headless-shell`）には、外部のアプリへ URL を渡す仕組みがない（観測と推定）。ただし、試みが証拠に残らない。
  - headed: 外部のアプリが起動しうる（推定。確度は高い）。
    - `mailto:` は、確認なしに OS の既定のアプリへ渡る。
    - Interaction の click は、ユーザーの操作として扱われる。
  - 安全の不変条件 S03（`mailto:`、`tel:`、外部のアプリを起動しない）を、headed では守れない。
- 修正方針: `doc/design/2026-09-25-beaksight-pre-task-19-cleanup-design.md` の第4章。
  - 検出して、Ledger の新しい事象の一覧 `externalSchemeNavigations` に記録する。
  - headed では、不変条件の違反として、Context を閉じる。
  - headless では、記録だけにする。
  - GATE-S03 を広げる。
  - Guard の独立レビューを行う。
- Task 20 への影響: 実装計画の Task 20 は、headed で実サイトの smoke を行う予定である。headed では起動そのものを防げないので、Task 20 の前にユーザーの判断を求める。
- 実施の時期: Task 19 の前の整理（C18a、C18b）
- 進み具合: C18a で、検出、記録、headed での違反、`BLOCKED_BY_SAFETY` への反映を行った（2026-09-25）。GATE-S03 の拡張は C18b、Guard のレビューは RC18a で行う。
- 進み具合: C18b で、GATE-S03 を、7経路 × 3スキームで、4つの段階（Passive、Interaction、headed の注入、Run）を確かめる形に広げた（2026-09-25）。Guard のレビューは RC18a で行う。
- 追加の事実（2026-09-25、RC18b の N1）:
  - 別のプロセスの iframe（OOPIF）の中の移動によるサーバのリダイレクトは、止めることも記録することもできない。
  - 原因: CDP の横取りを、page の target にだけ付けている。
  - 完全版の Chromium（headed）は、別のサイトの iframe を別のプロセスにする。テストで使う headless の Chromium は、別のプロセスの iframe を作らないので、Gate で検出できなかった。
  - → C18i で直す（設計書 4.2.1 の制約）。
- 進み具合: C18i で、OOPIF にも横取りを付けた（2026-09-25）。Guard の確認のレビューは RC18c で行う。
- 状態: 修正済み（2026-09-25、C18a〜C18i。RC18c で承認）。
  - スクリプトによる移動: 検出して記録する。headed では違反にし、Context を閉じる。違反の後は、監査を続けない（C18f）。
  - サーバのリダイレクト（main、sub、OOPIF、入れ子の OOPIF）: たどる前に止めて、記録する。headed でも違反にしない。
  - 残る制約（設計書 4.2.1）:
    - headed でのスクリプトによる移動は、最初の1回は、外部のアプリの起動を防げない。
    - fenced frame と、先読みの page は、確かめていない。
    - OOPIF の上限など（DEF-014）

## DEF-013 遅いリダイレクトで、`REDIRECT_PREDECESSOR_MISSING` の違反が出るおそれ（推定）

- 発見: 2026-09-25。C18g の報告の発見事項6（コードを読んだうえでの推定。実験はしていない）。
- 現象（推定）:
  - `passive-request-guard.ts` の `RedirectPredecessorRegistry` は、リクエストの段階から 1,000ms で、リダイレクトの対応付けの登録を期限切れにする。
  - サーバが、リクエストを受けてから1秒を超えてリダイレクトを返した場合を考える。このとき、リダイレクトの後のリクエストの対応付けが見つからず、`REDIRECT_PREDECESSOR_MISSING` の違反になる可能性がある。
- 影響（推定）:
  - 応答の遅い実サイトで、普通のリダイレクトが違反になり、Run が `ABORTED_BY_SAFETY` になる。
  - 安全の面では fail-closed の側だが、偽の違反になる。
- 修正方針: まず、fixture で再現を確かめる（C18g の続き）。再現したら、設計者が直し方を決める。
- 実施の時期: Task 19 の前の整理
- 再現した（2026-09-25、C18g）。1.5秒待ってから同じ Origin へ返す普通の 302 で、main frame と iframe の両方に `REDIRECT_PREDECESSOR_MISSING` の違反が出た。C18g の前からある不具合である。設計書 4.6 のとおり、C18h で直す。
- 状態: 修正済み（2026-09-25、C18h）。リダイレクトの応答（3xx）を受けた時点で、対応付けを登録し直し、そこから期限を数える。1.5秒の普通の 302 で、偽の違反が出ないことを、実際の Chromium で確かめた。Guard のレビューは RC18b で行う。

## DEF-014 実サイトで偽の違反になりうる、Guard の上限と競合（監視の項目）

- 発見: 2026-09-25。C18i の報告による。
- 内容: 次の場合に、Guard が fail-closed で違反を記録し、Context を閉じる。安全は保たれるが、Run が不要に `ABORTED_BY_SAFETY` になるおそれがある。
  1. 1つのページで、64件を超える iframe を同時に読み込む場合: `REDIRECT_PREDECESSOR_LIMIT_REACHED`（`MAX_REDIRECT_PREDECESSORS`）。C18i で、実際に65件で確かめた。今回の変更の前からある。
  2. 広告の多いページで、OOPIF の数が `MAX_GUARD_OOPIF_SESSIONS`（64）を超える場合: `OOPIF_GUARD_ATTACH_FAILED`
  3. 横取りの処理中に frame が消える場合（広告の iframe の入れ替えなど）: `CDP_CONTINUE_REQUEST_FAILED` など。同じプロセスの iframe でも、前から同じ扱いである。
- 扱い:
  - 今は直さない。どれも fail-closed の側で、fixture では、通常のページでは起きない。
  - 実サイトの smoke（Task 20）で起きた場合は、その事実をもとに、設計者が直し方を決める。
  - 例: 上限の見直し、消えた frame の失敗を予期した失敗にする。
- 実施の時期: Task 20 の結果を見て決める。
- 手がかり（RC18c の参考）: OOPIF の処理中に frame が消えた場合は、`channel.closed` で、frame が消えたことが明確に分かる。実サイトで起きた場合は、これを手がかりに、予期した失敗として扱えるかもしれない（推測）。

## DEF-015 vitest のワーカーのプロセスが、全テストの途中で1回だけ異常終了した（監視の項目）

- 発見: 2026-09-26。C18p の後の設計者の `npm run verify` で。
- 現象: `Error: [vitest-pool]: Worker forks emitted error.` と `Worker exited unexpectedly` が出て、終了コード 1 になった。100ファイルのうち99ファイル、3,616件が PASS。期待値の不一致で失敗したテストはない。残りの1ファイル（16件）の結果が出なかった。
- 再現: すぐに全テストを実行し直した（`--reporter=json`）。100ファイル、3,632件がすべて PASS。再現しなかった。直前の実装者の verify も PASS している。
- 候補のファイル（16件のもの）: `tests/unit/redact.test.ts` と `tests/integration/auditor-gates.test.ts`。ブラウザと CLI の Run を多く動かす `auditor-gates` の可能性が高い（推測。確かめていない）。
- 原因: 未確認。ワーカーのプロセスの異常終了（メモリの不足、子のプロセスの異常、`process.exit` の呼び出しなど）が考えられる。
- 扱い:
  - 今は直さない。設計者の verify のたびに、起きたかどうかを記録する。verify は `--reporter=json` の結果も残す形で実行し、起きた場合にファイルを特定できるようにする。
  - もう一度起きた場合は、ファイルを特定し、調査のサブタスクを出す。
- 実施の時期: 再び起きたとき。

## DEF-016 HTML でない 404 の応答のページに、文書の構造の Finding が出る（雑音のおそれ。監視の項目）

- 発見: 2026-09-26。T19a の報告による。
- 現象: 本文が text/plain の 404 のページ（fixture のサーバの 404）に、`HTTP_4XX` のほか、`MISSING_TITLE`、`MISSING_HTML_LANG`、`A11Y_DOCUMENT_TITLE`、`A11Y_HTML_HAS_LANG`、`A11Y_LANDMARK_ONE_MAIN`、`A11Y_PAGE_HAS_HEADING_ONE`、`A11Y_REGION` が出る。
- 再現: `tests/integration/fixture-full-crawl.test.ts` の `missing.html`。
- 影響: Rule の判定は事実のとおり（Chromium がテキストを表示する文書には、title も lang もない）。ただし、利用者には雑音になるおそれがある。安全や Run Status への影響はない。
- 扱い: 今は直さない。実サイトの 404 のページは、たいてい HTML である。Task 20 の smoke で実際の出方を見てから、直し方を決める（例: HTML でない応答やエラーの応答では、文書の構造の Rule を評価しない）。
- 実施の時期: Task 20 の結果を見て決める。
