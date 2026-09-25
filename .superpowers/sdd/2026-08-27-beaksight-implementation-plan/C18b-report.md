# C18b 実装報告（要約。設計者が保存）

## 結論

完了した。GATE-S03 を、7経路 × 3スキームで、4つの段階（Passive、Interaction、headed の注入、Run）を確かめる形に広げた。今のコードで、すべて PASS した。

- `safety-gates.test.ts` は63件で、既存が35件、新規が28件である。所要時間は約47秒で、前は約30秒だった。
- GATE-S08 には、click が行われたことと、登録の試みが起きたことの確認を加えた。
- `src/` は、変えていない。headed のブラウザは、一度も起動していない。
- 新しい fixture:
  - `fixtures/site/external-scheme-navigation.html`（`?via=` で経路を、`&to=` でスキームを選ぶ）
  - `fixtures/site/external-scheme-button.html`（`href` のない button の click で移動する）
- 対照の確認を、`gate-fixtures.test.ts` に21件加えた。Guard のない Context で、`request` の事象に外部スキームの URL が来ることを確かめる。

## 段階ごとの確認

- Passive: 記録があり、違反がなく、URL が変わらず、サーバにはそのページの GET だけが届く。
- Interaction:
  - click は1回行われた。
  - `phase: 'INTERACTION'` の記録があり、結果は `BLOCKED_BY_SAFETY` だった。
  - GET だけが届いた。
- headed の注入: 違反 `EXTERNAL_SCHEME_NAVIGATION_IN_HEADED_MODE` が1件だけ記録され、Context が閉じた。
- Run（`runCli`、headless）:
  - page.json に記録が残り、Finding `SAFETY_EXTERNAL_SCHEME_NAVIGATION_ATTEMPTED` が出た。
  - Run Status は、`ABORTED_BY_SAFETY` ではなかった。
- S08:
  - Passive: `register` の呼び出しは1回あったが、登録は0件、Worker の取得も0件だった。
  - Interaction: status は `REJECTED_UNSAFE` ではなく、呼び出しは2回あった。

## 実装者の判断と、設計者の判断

1. Passive の段階の button-click は、Playwright が click する形で確かめた。→ 承認する。C18a の本物の click と同じ形である。
2. headed の Gate は、location-href の経路だけにした（3スキーム）。→ 承認する。ほかの経路は、C18a のテストが確かめている。
3. Run の確認は1件だけにした。設定に `crawl.allowedQueryParameters` を入れた。→ 承認する。
4. `window.open` の経路は、この Gate に入れなかった。→ 承認する。別の違反になる経路で、C18a のテストが確かめている。

## 発見事項と、設計者の判断

1. 宛先、経路、経路ごとの移動の処理が、3か所にある（`external-scheme-navigation.test.ts`、`gate-harness.ts`、fixture）。経路の名前の書き方もそろっていない。→ CC-029 に加えた。C18d で1つにまとめる。
2. 全体を最初に実行したとき、GATE-S09 が1回だけ失敗した。
   - そのとき、並行で作業していた C18c のファイルに、型のエラーがあった。
   - その後の3回は、再発していない。
   - → 設計者の verify で確かめる。
3. S08 の登録を止めているのは、Context の設定 `serviceWorkers: 'block'` である。Guard ではない。→ 了解した。
   - 設計書どおりの多重の守りである。
   - Gate は、サーバの境界でも確かめている。
4. fixture を書き込んだときに、ホストの Browser pane が、そのファイルを自動で表示した。→ クエリがないときの fixture は、何もしない。影響はない。
