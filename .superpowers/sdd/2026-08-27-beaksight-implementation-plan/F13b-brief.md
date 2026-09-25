# F13b 指示書: timezone の検証を、正式な名前を拒否しない形に直す

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## サブタスク

- ID: F13b
- 目的:
  - F13 で、timezone の検証に「`Intl` が解決した名前と、大文字・小文字まで一致すること」という条件を入れた。
  - その結果、Node の ICU が別の表記に解決する正式な名前（例: `Asia/Kolkata`、`Etc/UTC`、`GMT`、`US/Pacific`）を、拒否するようになった。
  - これを直す。
- 背景: 作業記録置き場の `F13-report.md` の発見事項1

同時に、ほかの実装者（F14）が interaction のファイルを変更しています。担当範囲の外は変更しないでください。

## 変更してよいファイル

- `src/config/validate-config.ts`
- テスト: `tests/unit/config.test.ts`、`tests/component/browser-settings.test.ts`

## 修正する内容

- timezone は、次の2つを満たす場合に受け付ける。
  - IANA の名前の書き方であること。区切り（`/`）ごとの各部分が、大文字の英字か数字で始まる。`_`、`-`、`+`、数字を含んでよい。`UTC` と `GMT` のような1語の名前も含む。
  - `new Intl.DateTimeFormat('en-US', { timeZone })` が例外を投げないこと。
- 解決した名前との一致は求めない。
- 次の値は、引き続き拒否する。
  - `asia/tokyo`（小文字で始まる）
  - `+09:00`、`-0530`（オフセットの形）
  - `Not/AZone`（`Intl` が受け付けない）
- locale の判定（F13 のもの）は変えない。

## 受け入れ条件

- `Asia/Kolkata`、`Etc/UTC`、`GMT`、`US/Pacific`、`Asia/Tokyo`、`UTC`、`Pacific/Auckland` を受け付ける。
  - 修正前は拒否されること（RED）を確かめる。
  - 修正後は受け付けること（GREEN）を確かめる。
- 上の拒否する値が、引き続き拒否される。
- `tests/component/browser-settings.test.ts` で、`Asia/Kolkata` と `Etc/UTC` を使って、実際の Chromium で Context と page を作れることを確かめる。
- `npm run typecheck` と、変更したテストが PASS する。

## 報告

共通ルールの形式で報告してください。
