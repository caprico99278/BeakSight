/**
 * PL-5: 書き込みの手順の画面の知らせの部品が、プロファイルの要点（改訂・点検のしかた・ログインのしかた・状態）を出さないことを確かめる。
 * - 部品を `react-dom/server` の `renderToStaticMarkup` で HTML にして、文字のまま比べる（ビルドとブラウザは使わない）。
 * - SPEC-4: 入力の欄の属性・制約の文字（CCX-29。`candidate-fields.ts`）は、作成と規則の画面を外したので、部品ごと捨てた。
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ScenarioProfilePanel } from '../src/components/ScenarioProfilePanel';

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
