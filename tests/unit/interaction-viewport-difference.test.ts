// L5 の N5（設計者の判断 2026-11-10）: Mobile のビューポートでは、Desktop の同じページに同じ候補（識別 `candidateId` と、同じ識別の中の順番 `ordinal`）が
// なかったものだけを、操作で確かめる（見えた違いを残らず確かめ、同じものを 2 回確かめない）。ブラウザを使わない。
import { describe, expect, it } from 'vitest';
import type { InteractionCandidateEvidence } from '../../src/core/evidence-types.js';
import { mobileOnlyInteractionCandidates } from '../../src/orchestration/interaction-viewport-difference.js';

const candidate = (candidateId: string, ordinal: number): InteractionCandidateEvidence => ({
  candidateId, ordinal, tagName: 'button', role: null, accessibleName: candidateId, textFingerprint: 'sha256:x', ariaExpanded: null, ariaControls: null,
  ariaSelected: null, controlledVisible: null, controlledHidden: null, formAssociated: false, formMethod: null, formAction: null, href: null,
  hrefKind: 'NONE' as InteractionCandidateEvidence['hrefKind'], download: false, type: null, disabled: false, visible: true, destructiveAction: false,
  boundingBox: { x: 0, y: 0, width: 10, height: 10 } as InteractionCandidateEvidence['boundingBox'],
});

describe('L5 N5: the interaction candidates that only the mobile viewport shows', () => {
  it('keeps only the mobile candidates whose identity and ordinal the desktop viewport did not show, in the mobile order', () => {
    const desktop = [candidate('IC-menu', 0), candidate('IC-tab', 0), candidate('IC-tab', 1)];
    const mobile = [candidate('IC-hamburger', 0), candidate('IC-tab', 0), candidate('IC-tab', 1), candidate('IC-tab', 2), candidate('IC-menu', 0)];
    expect(mobileOnlyInteractionCandidates(desktop, mobile).map(({ candidateId, ordinal }) => [candidateId, ordinal])).toEqual([
      ['IC-hamburger', 0],
      ['IC-tab', 2],
    ]);
  });

  it('checks on mobile a control that desktop hid (a narrow-screen menu), and not one hidden on both', () => {
    const hidden = (candidateId: string): InteractionCandidateEvidence => ({ ...candidate(candidateId, 0), visible: false });
    const desktop = [hidden('IC-narrow-menu'), hidden('IC-hidden-both')];
    const mobile = [candidate('IC-narrow-menu', 0), hidden('IC-hidden-both')];
    expect(mobileOnlyInteractionCandidates(desktop, mobile).map(({ candidateId }) => candidateId)).toEqual(['IC-narrow-menu']);
  });

  it('keeps every mobile candidate when the desktop candidates are not known', () => {
    const mobile = [candidate('IC-a', 0), candidate('IC-b', 0)];
    expect(mobileOnlyInteractionCandidates(null, mobile)).toEqual(mobile);
  });
});
