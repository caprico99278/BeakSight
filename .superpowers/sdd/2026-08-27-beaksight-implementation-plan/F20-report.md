# F20 実装報告（要約。設計者が保存）

## 結論

実装は完了したが、Blocker で止まった。

- `isolated-interaction` を2回続けて実行し、2回とも395件が PASS した。
- `npm run verify` は、テストの段階で2件が失敗した。typecheck は PASS した。

## 主な変更

- `INTERACTION_NON_EVIDENCE_ATTRIBUTES` に、`data-headlessui-state` を加えた。
- `INTERACTION_NON_EVIDENCE_NAME_PATTERN`（`/focus|hover/iu`）を加え、`data-*` 属性の名前と class の名前に当てはめた。
- `role="tab"` を明示した要素には、下準備の focus をしない。判定には `hasExplicitTabRole` を使う。
- それ以外の要素では、focus の前後で ARIA の状態と `aria-controls` の先の表示を比べる。変わった場合と、比べられない場合は、それぞれ区別できる理由の NOT_VERIFIABLE にする。
- 新しい fixture: `focus-activated-tabs.html`。`non-evidence-attribute-buttons.html` にも追記した。

## Blocker

`passive-request-guard.test.ts` の偽の handle が、属性の記録を返さない。そのため、focus の前後の比較で fail-closed になり、2件のテストが失敗する。

- **設計者の判断**: 選択肢1（偽の handle に、空の属性の記録を加える）を採る。F20b で行う。本物のブラウザの動きに合わせるための修正で、テストが確かめる内容は変わらない。

## 発見事項

class の値が512文字以上で、切り詰められた可能性がある場合は、名前の決まりを当てはめられない。そのため、focus の class の増減だけで、偽の VERIFIED になる可能性が残る。

- **設計者の判断**: Tailwind のボタンでは、class が512文字を超えることがあるので、直す。
  - class だけは、別の上限（4096文字。名前を付けた定数）で記録する。
  - それでも切り詰められた可能性がある場合は、class を根拠にしない（fail-closed）。
  - 設計書 4.4.1 を更新する。F20b で行う。
