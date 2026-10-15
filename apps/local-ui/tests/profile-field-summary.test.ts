/**
 * CCX-29（CC-080 の (b)）: 操作の候補の画面・READ の確かめの画面・シナリオの画面が共用する、プロファイルの要点の欄と、入力の欄の属性・制約の
 * 文字の組み立ての出力を固定する。共通の部品にまとめる前と後で、描く HTML（文言、順序、エスケープ）が同じであること。
 * - 部品を `react-dom/server` の `renderToStaticMarkup` で HTML にして、文字のまま比べる（ビルドとブラウザは使わない）。
 * - 期待の HTML と文字は、まとめる前の画面の部品（シナリオの画面の `ScenarioProfilePanel`）の出力と、まとめる前の各画面の式
 *   （属性は 必須・読み取り専用・無効・見えない の順に `、` で並べ、なければ「なし」。制約は `名前="値"` を `、` で並べ、なければ「なし」）。
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ProfileSummary } from '../src/components/ProfileSummary';
import { ScenarioProfilePanel } from '../src/components/ScenarioProfilePanel';
import { candidateFieldConstraintsText, candidateFieldFlagsText } from '../src/display/candidate-fields';
import type { DiscoveryProfileView } from '../src/server/discovery-documents';

/** プロファイルの要点の例（取り消していない、書き込みのモード。ID はエスケープを確かめる文字を含む）。 */
const PROFILE: DiscoveryProfileView = Object.freeze({
  profileId: 'example-<write>&"',
  revision: 3,
  mode: 'TEST_APPROVED_WRITE',
  auth: 'MANUAL_SESSION',
  status: 'ACTIVE',
  approvedTestOrigins: ['http://127.0.0.1:4173'],
});

/** プロファイルの要点の欄の HTML（まとめる前のシナリオの画面の部品の出力。`data-testid` だけが画面ごとに違う）。 */
const profileSummaryHtml = (testId: string): string =>
  '<section class="panel"><h2 class="panel-heading">example-&lt;write&gt;&amp;&quot;</h2>'
  + `<dl class="facts" data-testid="${testId}">`
  + '<dt>改訂</dt><dd>改訂 3</dd>'
  + '<dt>監査モード</dt><dd>テスト環境の監査（承認した書き込みあり）</dd>'
  + '<dt>認証の方式</dt><dd>手でログインする</dd>'
  + '<dt>状態</dt><dd><span class="badge badge--positive">有効</span></dd>'
  + '</dl></section>';

const NO_FLAGS = { required: false, readonly: false, disabled: false, hidden: false } as const;

describe('CCX-29: the profile summary shared by the candidate, the READ check and the scenario screens', () => {
  it('renders the profile summary of the scenario screens as before', () => {
    expect(renderToStaticMarkup(createElement(ScenarioProfilePanel, { profile: PROFILE, eligible: true, editable: true })))
      .toBe(profileSummaryHtml('scenario-profile'));
  });

  it('renders the same profile summary on the candidate and the READ check screens, with their own test ids', () => {
    for (const testId of ['discovery-profile', 'read-check-profile', 'scenario-profile']) {
      expect(renderToStaticMarkup(createElement(ProfileSummary, { profile: PROFILE, testId })), testId).toBe(profileSummaryHtml(testId));
    }
  });
});

describe('CCX-29: the flags and the constraints text of an input field', () => {
  it('lists the flags in the order required, readonly, disabled, hidden, with the list separator, and "なし" without a flag', () => {
    expect(candidateFieldFlagsText(NO_FLAGS)).toBe('なし');
    expect(candidateFieldFlagsText({ ...NO_FLAGS, hidden: true })).toBe('見えない');
    expect(candidateFieldFlagsText({ required: true, readonly: true, disabled: true, hidden: true })).toBe('必須、読み取り専用、無効、見えない');
    expect(candidateFieldFlagsText({ ...NO_FLAGS, required: true, disabled: true })).toBe('必須、無効');
  });

  it('lists the constraints as name="value" in their order, with the list separator, and "なし" without a constraint', () => {
    expect(candidateFieldConstraintsText({ constraints: [] })).toBe('なし');
    expect(candidateFieldConstraintsText({ constraints: [{ name: 'maxlength', value: '20' }, { name: 'pattern', value: '[0-9]+"\\' }] }))
      .toBe('maxlength="20"、pattern="[0-9]+\\"\\\\"');
  });
});
