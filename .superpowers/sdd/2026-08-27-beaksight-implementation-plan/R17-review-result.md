# R17 レビュー結果（要約。設計者が保存）

## 総合判定

修正が必要。Critical は0件、Important は2件、Minor は2件だった。

## R16 の指摘の判定

指摘1・2・3・5・6 は、すべて解消した。

- 指摘1: 危険な値を入れた Run（事象29件）を、実際に描いて確かめた。Safety の節の http(s)・ws・mailto・tel・javascript へのリンクは、0件だった。

## 指摘と、設計者の判断

1. **Important**: 出力先のパイプが閉じると、スタックトレースが出て、終了コードが 1 になる。
   - 場所: `src/cli/output-stream.ts:22-30`、`src/cli/index.ts`
   - `process.stdout` と `process.stderr` の `'error'` に、処理を付けていない。
   - 再現: `--help` を起動し、読み口を閉じると、`Unhandled 'error' event ... EPIPE` が出る。
   - → **直す**（R17f）。
     - 出力先の `'error'` を受けて、無視する。終了コードは変えない。
     - あわせて、扱われない reject と例外を、日本語の短い文言と終了コード 1 で終える形にする。スタックトレースは出さない（レビュー担当が推測で挙げた点）。
2. **Important**: スキーマの検証で導き直した Run Status で終了コードが決まることを、どのテストも確かめていない。
   - 場所: `src/cli/run-command.ts:95`
   - `result.run.runStatus`（導き直しの前）を使う形に後退しても、テストが PASS する。
   - → **直す**（R17f）。
     - 確定した `AuditRunResult` から、書き出しと終了コードまでを行う関数を、切り出す。
     - スキーマに合わない Run で、導き直した後の Run Status（`PARTIAL`）から終了コードが決まることを、テストで固定する。
3. **Minor**: 同じオプションを2回指定すると、後の値が黙って使われる（`arguments.ts:57-58`）。→ 直す（R17f）。CONFIG_ERROR（`INVALID_ARGUMENTS`）にする。
4. **Minor**: BOM 付きの UTF-8 の設定ファイルが、「JSON として読めません」になる（`load-config.ts:64-73`）。→ 直す（R17f）。
   - 先頭の BOM を1つだけ取り除いてから、JSON として読む。
   - Windows PowerShell 5.1 は、既定で BOM を付けるためである。

## 問題がないと確かめられたもの

- 終了コードの表が1か所であること。
- 書き出しの順序と owner。
- CLI が件数を数え直さないこと。
- ARCH02。
- 途中の例外での Browser の後始末。
- CC-016 の後の Rule の文言の同一性。
- UI Gate（334ms）。

## 確認できなかった点

- ABORTED_BY_SAFETY の Run を、CLI で最後まで通すこと
- `run` の途中でパイプが閉じた場合（推測）
- 扱われない reject の出方（推測）
- PowerShell の実際のコンソールでの表示
