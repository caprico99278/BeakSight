# T18d 実装報告（要約。設計者が保存）

## 結論

Blocker で停止した（ARCH04 だけ）。ARCH01・02・03・05・06・07・08 の7つは、PASS した。

- 作ったファイル（どれも新規）:
  - `tests/architecture/source-scan.ts`
    - `src/**` を1回だけ読み、1文字ずつ走査する。
    - コメント、文字列、正規表現のリテラルを分ける。
  - `tests/architecture/target-isolation.test.ts`（ARCH01）
  - `tests/architecture/semantic-ownership.test.ts`（ARCH02〜08。除外の一覧 `EXCLUSIONS` は、このファイルの1か所だけにある）
- 所要時間:
  - target-isolation: 309ms
  - semantic-ownership: 408ms
  - `src/` の91ファイルの読み込みと走査: 約90ms
- 除外は、式の単位（使われなければ FAIL にし、一覧が古くなるのを防ぐ）と、ファイルの単位の2つの形で書く。
- `src/` と `ui-ssot.test.ts` は、変えていない。

## Blocker（ARCH04）と、設計者の判断

- 事実: `src/audit/cross-page-rules.ts:213、397、590` が、`originOf()`（`new URL` の `origin`）と `allowedOrigins.has(origin)` で、URL が許可 Origin の中かを判定している。これは、`classifyUrl` の `INTERNAL_NAVIGABLE` と同じ意味の、別の実装である。
- → **案(a)とする。T18e で、`src/audit/cross-page-rules.ts` を直す。**
  - URL が許可 Origin の中かの判定は、URL の owner（`src/crawl/normalize-url.ts`）の `classifyUrl`、または URL の owner が提供する判定の関数で行う。
  - Rule のファイルの中に、Origin の比較を書かない。
  - 振る舞いが変わらないことを、既存の Cross-page のテストと、新しいテストで確かめる。
  - ARCH04 の除外の一覧には、加えない。

## 実装者の判断と、設計者の判断

1. ARCH04 の除外のうち、境界に近い2つ。→ 承認する。
   - `technical-rules.ts` の `isRejectedLinkInternal`: 正規化できなかったリンクを、ページと同じ Origin かで分ける。
     - 正規化できないリンクには、`classifyUrl` を使えない。
     - Rule の入力には、許可 Origin がない。
   - `validate-config.ts`: 開始の URL の Origin が、許可 Origin に含まれるかを検証する。
     - これは、設定の値どうしの整合の検証であり、URL の受け入れの判定ではない。
2. ARCH05 と ARCH06 の確認は、名前への代入と、型での読み替えに限った近似である。→ 承認する。近似の限界を、設計書 4.4 に書いた。

## 発見事項と、設計者の判断

1. `tests/architecture/ui-ssot.test.ts:81-82` の `stripComments` は、正規表現だけでコメントを除く。そのため、文字列の中の `/*` をコメントの始まりとみなす。
   - 例: `src/safety/passive-request-guard.ts:1385` の `'**/*'` から1481行までが、検査から抜け落ちる。
   - → **既存不具合 DEF-011 として登録した。T18e で直す。**
     - UI Gate も、`source-scan.ts` の走査を使う形にする。
     - ファイルの一覧の取得と読み込みの重複も、これで解消する。
2. `src/audit/safety-rules.ts` で、設定の `target.id`（`example`）と同じ語を、変数の名前（「例」の意味の一般の語）として25行で使っている。
   - → **違反ではない。**
     - 対象のサイトを識別する情報ではない。
     - ARCH01 の規則（文字列のリテラルとして一致するものだけを違反とする）は、設計どおりである。
   - 一般の語の `target.id` が識別子に現れても違反にしないことを、設計書 4.4 に明記した。
