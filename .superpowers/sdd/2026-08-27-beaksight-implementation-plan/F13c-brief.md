# F13c 指示書: 大文字・小文字だけが違う timezone の名前を拒否する

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## サブタスク

- ID: F13c
- 目的: F13b の判定では、`ASIA/TOKYO` のように全部が大文字の名前も受け付けてしまう。Chromium はこの名前を拒否するので、これを拒否する。
- 背景: F13b の実装報告の発見事項1。実装者が、実際の Chromium で `Invalid timezone ID: ASIA/TOKYO` になることを確かめている。

同時に、ほかの実装者（F14）が interaction のファイルを変更しています。担当範囲の外は変更しないでください。

## 変更してよいファイル

- `src/config/validate-config.ts`
- テスト: `tests/unit/config.test.ts`

## 修正する内容

- timezone の判定に、次の条件を加える。F13b の条件（IANA の名前の書き方であること、`Intl.DateTimeFormat` が例外を投げないこと）は、そのまま残す。
- 条件: `new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone` が返す名前を「解決した名前」とする。解決した名前と入力が、大文字・小文字を区別しないと一致し、区別すると一致しない場合は、拒否する。
  - 大文字・小文字だけが違うのは、書き方の誤りだからである。
  - 解決した名前の綴りが入力と違う場合（例: `Asia/Kolkata` が `Asia/Calcutta` になる）は、同じ時間帯の別名なので、受け付ける。

## 受け入れ条件

- `ASIA/TOKYO` と `Asia/TOKYO` は、修正前は受け付けられる（RED）。修正後は拒否される（GREEN）。
- `Asia/Kolkata`、`Etc/UTC`、`GMT`、`US/Pacific`、`Asia/Tokyo`、`UTC`、`Pacific/Auckland` は、引き続き受け付ける。
- `npm run typecheck` と、`tests/unit/config.test.ts` が PASS する。

## 報告

共通ルールの形式で報告してください。
