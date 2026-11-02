/**
 * CCX-29（CC-080 の (b)）: 入力の欄の属性・制約の文字の組み立ての出力を固定する。PL-5: 書き込みの手順の画面の知らせの部品が、プロファイルの要点
 * （改訂・点検のしかた・ログインのしかた・状態）を出さないことも確かめる。共通の部品にまとめる前と後で、描く HTML（文言、順序、エスケープ）が同じであること。
 * - 部品を `react-dom/server` の `renderToStaticMarkup` で HTML にして、文字のまま比べる（ビルドとブラウザは使わない）。
 * - 期待の HTML と文字は、まとめる前の画面の部品（シナリオの画面の `ScenarioProfilePanel`）の出力と、まとめる前の各画面の式
 *   （属性は 必須・読み取り専用・無効・見えない の順に `、` で並べ、なければ「なし」。制約は `名前="値"` を `、` で並べ、なければ「なし」）。
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ScenarioProfilePanel } from '../src/components/ScenarioProfilePanel';
import { candidateFieldConstraintsText, candidateFieldFlagsText } from '../src/display/candidate-fields';

const NO_FLAGS = { required: false, readonly: false, disabled: false, hidden: false } as const;

// PL-5 の修正の 1 回目: 共用のプロファイルの要点の欄（`ProfileSummary`）は、どの画面も出さなくなったので捨てた（設計書 3 章の 1・2）。
describe('PL-5: the scenario screens show no profile summary', () => {
  // PL-5（設計書 `2026-10-26-beaksight-plain-ui-design.md` 3 章の 1・2）: 書き込みの手順の画面は、プロファイルの要点の欄を出さない（使えないときの知らせだけ）。
  it('renders only the notices on the scenario screens (no profile summary)', () => {
    expect(renderToStaticMarkup(createElement(ScenarioProfilePanel, { eligible: true, editable: true }))).toBe('');
    expect(renderToStaticMarkup(createElement(ScenarioProfilePanel, { eligible: false, editable: false }))).toContain('data-testid="scenario-not-eligible"');
    expect(renderToStaticMarkup(createElement(ScenarioProfilePanel, { eligible: true, editable: false }))).toContain('data-testid="scenario-retired"');
    // 何回目の変更か・点検のしかた・ログインのしかたの欄は出さない。
    for (const label of ['何回目の変更か', '点検のしかた', 'ログインのしかた']) {
      expect(renderToStaticMarkup(createElement(ScenarioProfilePanel, { eligible: false, editable: false })), label).not.toContain(label);
    }
  });
});

describe('CCX-29: the flags and the constraints text of an input field', () => {
  it('lists the flags in the order required, readonly, disabled, hidden, with the list separator, and "なし" without a flag', () => {
    expect(candidateFieldFlagsText(NO_FLAGS)).toBe('なし');
    expect(candidateFieldFlagsText({ ...NO_FLAGS, hidden: true })).toBe('見えない');
    expect(candidateFieldFlagsText({ required: true, readonly: true, disabled: true, hidden: true })).toBe('必須、変えられない、使えない、見えない');
    expect(candidateFieldFlagsText({ ...NO_FLAGS, required: true, disabled: true })).toBe('必須、使えない');
  });

  it('lists the constraints as name="value" in their order, with the list separator, and "なし" without a constraint', () => {
    expect(candidateFieldConstraintsText({ constraints: [] })).toBe('なし');
    expect(candidateFieldConstraintsText({ constraints: [{ name: 'maxlength', value: '20' }, { name: 'pattern', value: '[0-9]+"\\' }] }))
      .toBe('maxlength="20"、pattern="[0-9]+\\"\\\\"');
  });
});
