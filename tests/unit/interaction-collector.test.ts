// SPEC-5（設計書 2026-11-14 5.1）: 押した後の確かめを、押す前と押した後の 1 回ずつの観察の差で決める。何を「効いた」の根拠にするかの表
// （判定の単体の代表）。ブラウザを使わない。
// - 根拠にする: ARIA の状態・`aria-controls` の先の見え方・文字・無効・見え方・親の details の開閉・対象の属性のうち ARIA の状態と `open`・
//   class の名前の増減（名前に focus か hover を含む名前は除く）。
// - 根拠にしない: 位置と大きさ・style・ほかの属性（data-*・tabindex・focus で付く属性など）・記録を比べられない属性。
import { describe, expect, it } from 'vitest';
import { collectInteractionChangeEvidence } from '../../src/evidence/interaction-collector.js';
import {
  changedInteractionAttributeNames,
  changedInteractionClassNames,
  type InteractionAttributeRecord,
} from '../../src/interaction/discover-candidates.js';
import type { InteractionCandidate } from '../../src/safety/interaction-policy.js';

const before: InteractionCandidate = Object.freeze({
  candidateId: 'interaction-candidate:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  ordinal: 0,
  tagName: 'button',
  role: null,
  accessibleName: 'Toggle details',
  textFingerprint: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  ariaExpanded: 'false',
  ariaControls: 'details',
  ariaSelected: null,
  controlledVisible: false,
  controlledHidden: true,
  formAssociated: false,
  formMethod: null,
  formAction: null,
  href: null,
  hrefKind: 'NONE',
  download: false,
  type: 'button',
  disabled: false,
  visible: true,
  destructiveAction: false,
  boundingBox: Object.freeze({ x: 10, y: 20, width: 100, height: 30, top: 20, right: 110, bottom: 50, left: 10 }),
});

const recorded = (...entries: string[]): InteractionAttributeRecord => ({ status: 'RECORDED', entries });

/** 押す前と後の、候補の事実と属性の記録と details の開閉から、変化の Evidence を作る（auditor と同じ組み立て）。 */
function evidenceOf(
  change: {
    readonly after?: Partial<InteractionCandidate>;
    readonly attributes?: readonly [InteractionAttributeRecord, InteractionAttributeRecord];
    readonly detailsOpen?: { readonly before: boolean | null; readonly after: boolean | null };
  },
) {
  const [attributesBefore, attributesAfter] = change.attributes ?? [recorded(), recorded()];
  return collectInteractionChangeEvidence(before, { ...before, ...change.after }, {
    difference: {
      changedAttributeNames: changedInteractionAttributeNames(attributesBefore, attributesAfter),
      changedClassNames: changedInteractionClassNames(attributesBefore, attributesAfter),
      detailsOpen: change.detailsOpen ?? { before: null, after: null },
    },
  });
}

describe('SPEC-5: what counts as evidence of a press', () => {
  it.each([
    ['the ARIA expanded state', { after: { ariaExpanded: 'true' } }, ['ariaExpanded']],
    ['the ARIA selected state', { after: { ariaSelected: 'true' } }, ['ariaSelected']],
    ['the display of the aria-controls target', { after: { controlledVisible: true, controlledHidden: false } }, ['controlledVisible', 'controlledHidden']],
    ['the own text', { after: { textFingerprint: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc' } }, ['textFingerprint']],
    ['the disabled state', { after: { disabled: true } }, ['disabled']],
    ['the open state of the parent details', { detailsOpen: { before: false, after: true } }, ['detailsOpen']],
  ] as const)('counts a change of %s', (_label, change, fields) => {
    const evidence = evidenceOf(change);

    expect(evidence.changedFields).toEqual(fields);
    expect(evidence.changedAttributes).toEqual([]);
    expect(evidence.changedAttributesTruncated).toBe(false);
  });

  it.each([
    ['aria-pressed', recorded('aria-pressed', 'false'), recorded('aria-pressed', 'true'), ['aria-pressed']],
    ['aria-checked', recorded('aria-checked', 'false'), recorded('aria-checked', 'true'), ['aria-checked']],
    ['open', recorded(), recorded('open', ''), ['open']],
    ['a class name', recorded('class', 'btn'), recorded('class', 'btn active'), ['class']],
    ['a class name next to a focus name', recorded('class', 'btn'), recorded('class', 'btn is-focused is-open'), ['class']],
  ] as const)('counts a change of the attribute %s', (_label, attributesBefore, attributesAfter, names) => {
    const evidence = evidenceOf({ attributes: [attributesBefore, attributesAfter] });

    expect(evidence.changedFields).toEqual(['attributes']);
    expect(evidence.changedAttributes).toEqual(names);
  });

  it.each([
    ['the position and the size', { after: { boundingBox: { ...before.boundingBox, y: 220, top: 220, bottom: 250, height: 30 } } }],
    ['the inline style', { attributes: [recorded('style', 'width: 1px'), recorded('style', 'width: 2px')] }],
    ['tabindex', { attributes: [recorded('tabindex', '-1'), recorded('tabindex', '0')] }],
    ['a data attribute', { attributes: [recorded('data-state', 'closed'), recorded('data-state', 'open')] }],
    ['an attribute set on focus', { attributes: [recorded(), recorded('focused', '')] }],
    ['a tooltip attribute', { attributes: [recorded(), recorded('aria-describedby', 'tip')] }],
    ['only focus and hover class names', { attributes: [recorded('class', 'btn'), recorded('class', 'btn Mui-focusVisible is-hovered')] }],
    ['only the order of the class names', { attributes: [recorded('class', 'a b'), recorded('class', 'b a')] }],
    ['an attribute record that cannot be compared', {
      attributes: [{ status: 'INCOMPLETE' }, recorded('aria-pressed', 'true')] as const,
    }],
  ] as const)('does not count a change of %s', (_label, change) => {
    const evidence = evidenceOf(change);

    expect(evidence.changedFields).toEqual([]);
    expect(evidence.changedAttributes).toEqual([]);
  });

  it('keeps only the evidence attributes when they change together with other attributes', () => {
    const evidence = evidenceOf({
      attributes: [
        recorded('aria-expanded', 'false', 'data-state', 'closed', 'style', 'a: 1', 'tabindex', '-1'),
        recorded('aria-expanded', 'true', 'data-state', 'open', 'style', 'a: 2', 'tabindex', '0'),
      ],
    });

    expect(evidence.changedFields).toEqual(['attributes']);
    expect(evidence.changedAttributes).toEqual(['aria-expanded']);
  });
});
