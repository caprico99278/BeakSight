# T12a2 指示書: 下書きから Finding への変換の共通化と、ruleId の決まり

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## サブタスク

- ID: T12a2
- 目的: T12a の報告を受けて、後続の T12c（axe の Rule）と T13（Cross-page rule）の土台を整える。
- 設計書: `doc/design/2026-09-23-beaksight-task-12-13-rules-design.md` 第6章のうち、2026-09-24 に追加した次の2項目
  - 下書きから Finding への変換の共通化
  - ruleId の決まり
- 前の報告: 作業記録置き場の `T12a-report.md`

T12a の変更は、作業ツリーにそのまま残っています。HEAD に戻す操作は禁止です。

このサブタスクは単独で実行します。

## 変更してよいファイル

- `src/audit/rule.ts`
- `src/audit/rule-catalog.ts`
- `src/audit/rule-engine.ts`
- `tests/component/rule-engine.test.ts`

## 作るもの

1. **`materializeFindingDrafts`**（`src/audit/rule-engine.ts` から export する）
   - 入力:
     - 下書き。各下書きに、次の文脈を付ける。
       - `pageId`（`PageId` か null）
       - `pageUrl`（正規化したURLか null）
       - `viewport`（`ViewportProfile` か null）
     - `targetId`
     - `firstFindingSequence`
     - 参照してよい Evidence の ID の集合
   - 処理: いま `RuleEngine` の中にある次の処理を、この関数に移す。
     - 下書きの検査
     - `evidenceRefs` の正規化
     - fingerprint の付与
     - 並べ替え
     - Finding ID の採番
     - 凍結
   - ビューポートの扱い:
     - `viewport` が null でない場合は、予約名 `viewport` の同一性の要素として、fingerprint に含める。
     - null の場合は、含めない。
   - 下書きが `viewport` の名前の同一性の要素を持つ場合は、検査の失敗とする。
   - 出力: Finding の配列、検査に失敗した下書き（ruleId と理由）、次の連番。
   - 名前と入出力の型の細部は、実装者が決めて報告する。
2. **`RuleEngine` をこの関数で書き直す**
   - `RuleEngine` は、各 Rule の評価と例外の封じ込めだけを行い、下書きの変換は `materializeFindingDrafts` に任せる。
   - 同じ処理を2か所に書かないこと。
   - T12a の既存のテストは、すべて PASS のままであること。
3. **ruleId の決まり**
   - `AuditRule` に、任意の `ruleIdPrefix?: string` を加える。
   - `ruleIdPrefix` を持たない Rule の下書きは、ruleId が Rule の ruleId と一致しなければならない。
   - `ruleIdPrefix` を持つ Rule の下書きは、ruleId がその接頭辞で始まり、かつ接頭辞より長くなければならない。
   - 決まりに反した下書きがあれば、その Rule の失敗とする。その場合の、同じ Rule のほかの正しい下書きの扱いは、T12a の決まり（失敗した Rule の下書きは捨てる）に合わせる。
   - `freezeCatalog` は、次の2つを検査する。反していれば、例外を投げる。
     - ほかの Rule の ruleId が、ある Rule の `ruleIdPrefix` で始まらないこと。
     - 2つの Rule の `ruleIdPrefix` が、互いに接頭辞の関係にないこと。

## 受け入れ条件

- 次のことを確かめるテストがある。どれも、修正前に RED、修正後に GREEN になること。
  - `materializeFindingDrafts` の単体テスト
    - viewport が null の場合と、null でない場合の fingerprint の違い
    - 予約名 `viewport` を拒否すること
    - pageId と pageUrl が null の Finding
  - ruleId の不一致を、Rule の失敗にすること
  - 接頭辞を持つ Rule の、正しい下書きと誤った下書き
  - Catalog の接頭辞の衝突を、例外にすること
- `npm run typecheck` が PASS する。
- `npm run verify` が PASS する。このサブタスクでは build を実行してよい。

## 報告

共通ルールの形式で、日本語で報告してください。変更後の型のシグネチャを一覧にしてください。後続の T12b〜T12d と T13 の実装者が、それを使います。
