import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { INTERACTION_HREF_KINDS, INTERACTION_REJECTION_REASONS } from '../../src/core/evidence-types.js';
import {
  classifyInteractionCandidate,
  freezeInteractionCandidate,
  INTERACTION_CANDIDATE_LIMITS,
  interactionRejectionLedgerRecord,
  type InteractionCandidate,
  type InteractionRejectionReason,
} from '../../src/safety/interaction-policy.js';

// F20b（設計書 2026-09-23 4.4.1「長い class」）: class の値だけは、ほかの属性より長い、class 専用の上限まで記録する。
describe('INTERACTION_CANDIDATE_LIMITS (F20b)', () => {
  it('keeps a dedicated class limit of 4096 that is longer than the limit of the other attributes', () => {
    expect(INTERACTION_CANDIDATE_LIMITS.maxClassAttributeLength).toBe(4_096);
    expect(INTERACTION_CANDIDATE_LIMITS.maxAttributeLength).toBe(512);
    expect(INTERACTION_CANDIDATE_LIMITS.maxClassAttributeLength).toBeGreaterThan(INTERACTION_CANDIDATE_LIMITS.maxAttributeLength);
    expect(Object.isFrozen(INTERACTION_CANDIDATE_LIMITS)).toBe(true);
  });
});

function candidate(overrides: Partial<InteractionCandidate> = {}): InteractionCandidate {
  return {
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
    boundingBox: {
      x: 10,
      y: 20,
      width: 100,
      height: 30,
      top: 20,
      right: 110,
      bottom: 50,
      left: 10,
    },
    ...overrides,
  };
}

describe('classifyInteractionCandidate', () => {
  it('admits a visible non-form toggle using mechanical facts only', () => {
    expect(classifyInteractionCandidate(candidate())).toEqual({
      action: 'ALLOW',
      reason: 'MECHANICALLY_SAFE',
    });
  });

  it.each([
    ['submit controls', { type: 'submit' }, 'SUBMISSION_CONTROL'],
    ['reset controls', { type: 'reset' }, 'RESET_CONTROL'],
    ['implicit submitters associated with a form', {
      formAssociated: true,
      formMethod: 'post',
      formAction: 'https://example.test/__mutation',
      type: 'submit',
    }, 'SUBMISSION_CONTROL'],
    ['otherwise form-associated controls', {
      formAssociated: true,
      formMethod: 'get',
      formAction: 'https://example.test/search',
    }, 'FORM_ASSOCIATED'],
    ['same-origin navigation hrefs', {
      tagName: 'a',
      role: 'button',
      href: 'https://example.test/next',
      hrefKind: 'SAME_ORIGIN_HTTP',
    }, 'NAVIGATION_HREF'],
    ['external navigation hrefs', {
      tagName: 'a',
      role: 'button',
      href: 'https://external.example/next',
      hrefKind: 'EXTERNAL_ORIGIN_HTTP',
    }, 'EXTERNAL_ACTION'],
    ['special schemes', {
      tagName: 'a',
      role: 'button',
      href: 'mailto:fixture@example.test',
      hrefKind: 'SPECIAL_SCHEME',
    }, 'EXTERNAL_ACTION'],
    ['malformed hrefs', {
      tagName: 'a',
      role: 'button',
      href: 'http://[invalid',
      hrefKind: 'MALFORMED',
    }, 'MALFORMED_CANDIDATE'],
    ['download controls', {
      tagName: 'a',
      role: 'button',
      href: 'https://example.test/file',
      hrefKind: 'SAME_ORIGIN_HTTP',
      download: true,
    }, 'DOWNLOAD'],
    ['disabled controls', { disabled: true }, 'DISABLED'],
    ['non-visible controls', { visible: false }, 'NOT_VISIBLE'],
  ] as const)('rejects %s', (_label, overrides, reason) => {
    expect(classifyInteractionCandidate(candidate(overrides))).toEqual({
      action: 'REJECT',
      reason,
    });
  });

  it('fails closed on unbounded or internally inconsistent candidate data', () => {
    expect(classifyInteractionCandidate(candidate({ accessibleName: 'x'.repeat(300) }))).toEqual({
      action: 'REJECT',
      reason: 'MALFORMED_CANDIDATE',
    });
    expect(classifyInteractionCandidate(candidate({ visible: true, boundingBox: { ...candidate().boundingBox, width: 0 } })))
      .toEqual({ action: 'REJECT', reason: 'MALFORMED_CANDIDATE' });
  });

  it.each([
    { x: 11 },
    { y: 21 },
  ])('rejects a rectangle whose origin disagrees with its edges: %o', (boundingBox) => {
    expect(classifyInteractionCandidate(candidate({
      boundingBox: { ...candidate().boundingBox, ...boundingBox },
    }))).toEqual({ action: 'REJECT', reason: 'MALFORMED_CANDIDATE' });
  });

  it('rejects malformed runtime values without throwing', () => {
    const throwingCandidate = new Proxy(candidate(), {
      get(): never {
        throw new Error('hostile candidate getter');
      },
    });

    expect(classifyInteractionCandidate(undefined as unknown as InteractionCandidate))
      .toEqual({ action: 'REJECT', reason: 'MALFORMED_CANDIDATE' });
    expect(classifyInteractionCandidate(throwingCandidate))
      .toEqual({ action: 'REJECT', reason: 'MALFORMED_CANDIDATE' });
  });

  it.each(INTERACTION_HREF_KINDS)('accepts the closed href kind %s as a well-formed candidate', (hrefKind) => {
    const href = hrefKind === 'NONE' ? null : 'https://example.test/next';

    expect(() => freezeInteractionCandidate(candidate({ tagName: 'a', href, hrefKind }))).not.toThrow();
  });

  it('rejects an href kind outside the closed list as malformed', () => {
    const unknownKind = candidate({ tagName: 'a', href: 'https://example.test/next', hrefKind: 'UNKNOWN' as never });

    expect(classifyInteractionCandidate(unknownKind)).toEqual({ action: 'REJECT', reason: 'MALFORMED_CANDIDATE' });
    expect(() => freezeInteractionCandidate(unknownKind)).toThrow('Interaction candidate is malformed');
  });

  it('rejects unsupported ARIA state values as malformed', () => {
    expect(classifyInteractionCandidate(candidate({ ariaExpanded: 'banana' })))
      .toEqual({ action: 'REJECT', reason: 'MALFORMED_CANDIDATE' });
    expect(classifyInteractionCandidate(candidate({ ariaSelected: 'sometimes' })))
      .toEqual({ action: 'REJECT', reason: 'MALFORMED_CANDIDATE' });
  });

  it('accepts null/null controlled state when a bounded aria-controls target is unresolved', () => {
    expect(classifyInteractionCandidate(candidate({
      ariaControls: 'missing-panel',
      controlledVisible: null,
      controlledHidden: null,
    }))).toEqual({ action: 'ALLOW', reason: 'MECHANICALLY_SAFE' });
  });

  it.each([
    ['visible null but hidden observed', null, false],
    ['visible observed but hidden null', true, null],
    ['both observed true', true, true],
    ['both observed false', false, false],
  ] as const)('rejects inconsistent controlled state: %s', (_label, controlledVisible, controlledHidden) => {
    expect(classifyInteractionCandidate(candidate({ controlledVisible, controlledHidden })))
      .toEqual({ action: 'REJECT', reason: 'MALFORMED_CANDIDATE' });
  });
});

describe('interactionRejectionLedgerRecord (M2)', () => {
  it.each([
    ['EXTERNAL_ACTION', 'BLOCKED_EXTERNAL_ACTION'],
    ['DOWNLOAD', 'BLOCKED_EXTERNAL_ACTION'],
    ['SUBMISSION_CONTROL', 'EXCLUDED_CANDIDATE'],
    ['RESET_CONTROL', 'EXCLUDED_CANDIDATE'],
    ['FORM_ASSOCIATED', 'EXCLUDED_CANDIDATE'],
    ['NAVIGATION_HREF', 'EXCLUDED_CANDIDATE'],
    ['DISABLED', 'NONE'],
    ['NOT_VISIBLE', 'NONE'],
    ['MALFORMED_CANDIDATE', 'NONE'],
  ] as const)('ledgers %s as %s', (reason, record) => {
    expect(interactionRejectionLedgerRecord(reason)).toBe(record);
  });

  // T12d0: 除外理由の閉じた一覧は core の `INTERACTION_REJECTION_REASONS` に1回だけ書き、ここでは値を並べ直さない。
  it('assigns a ledger record to every reason of the core closed list (T12d0)', () => {
    expect(INTERACTION_REJECTION_REASONS.length).toBeGreaterThan(0);
    for (const reason of INTERACTION_REJECTION_REASONS) {
      expect(['BLOCKED_EXTERNAL_ACTION', 'EXCLUDED_CANDIDATE', 'NONE'], reason)
        .toContain(interactionRejectionLedgerRecord(reason));
    }
  });

  // DEF-003: 表にない理由（Object の既定のプロパティ名を含む）は、記録先を決めずに例外にする（fail-closed）。
  it.each([
    'constructor',
    'toString',
    'hasOwnProperty',
    '__proto__',
    'valueOf',
    'UNKNOWN_REASON',
  ])('throws instead of choosing a ledger record for the reason %s that is not in the table (DEF-003)', (reason) => {
    expect(() => interactionRejectionLedgerRecord(reason as InteractionRejectionReason)).toThrow(TypeError);
  });

  it('defines InteractionRejectionReason only as an alias of the core type (T12d0)', async () => {
    const source = await readFile(resolve(process.cwd(), 'src/safety/interaction-policy.ts'), 'utf8');

    expect([...source.matchAll(/^export (?:interface|type) InteractionRejectionReason\b.*$/gmu)].map((match) => match[0]))
      .toEqual(['export type InteractionRejectionReason = InteractionRejectionReasonEvidence;']);
    expect(source).not.toMatch(/\|\s*'SUBMISSION_CONTROL'/u);
  });
});

describe('freezeInteractionCandidate (Q6)', () => {
  it('rejects a null bounding box with the bounded contract message instead of a TypeError', () => {
    const malformed = { ...candidate(), boundingBox: null } as unknown as InteractionCandidate;
    let rejection: unknown;
    try {
      freezeInteractionCandidate(malformed);
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(Error);
    expect(rejection).not.toBeInstanceOf(TypeError);
    expect((rejection as Error).message).toBe('Interaction candidate is malformed or exceeds bounded contract');
  });
});
