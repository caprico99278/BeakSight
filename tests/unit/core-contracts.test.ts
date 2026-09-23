import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { EvidenceRecord } from '../../src/core/contracts.js';
import {
  createEvidenceId,
  createFindingFingerprint,
  createFindingId,
  createPageId,
  createRunId,
} from '../../src/core/ids.js';

describe('stable identifiers', () => {
  it('uses explicit prefixes and six-digit sequences', () => {
    expect(createRunId(7)).toBe('RUN-000007');
    expect(createPageId(8)).toBe('PAGE-000008');
    expect(createEvidenceId('network', 12)).toBe('EV-NET-000012');
    expect(createFindingId(42)).toBe('FIND-000042');
  });

  it('rejects evidence types outside the closed canonical set instead of aliasing prefixes', () => {
    expect(() => createEvidenceId('net' as never, 12)).toThrow('unsupported evidence type');
    expect(() => createEvidenceId('a11y' as never, 12)).toThrow('unsupported evidence type');
    expect(() => createEvidenceId('perf' as never, 12)).toThrow('unsupported evidence type');
    expect(() => createEvidenceId('shot' as never, 12)).toThrow('unsupported evidence type');
  });

  it('keeps each evidence payload selected by its canonical type', () => {
    const evidence: EvidenceRecord = {
      evidenceId: createEvidenceId('network', 12),
      type: 'network',
      pageId: createPageId(1),
      viewport: 'desktop',
      observedAt: '2026-08-27T00:00:00.000Z',
      payload: { requestUrl: 'https://example.test/missing.png', status: 404 },
    };

    if (evidence.type === 'network') {
      expect(evidence.payload.status).toBe(404);
      expect(evidence.payload.requestUrl).toBe('https://example.test/missing.png');
    }
  });

  it('sorts identity fields with explicit code-unit order before hashing', () => {
    const first = createFindingFingerprint({
      targetId: 'example-target',
      ruleId: 'IMAGE_LOAD_FAILED',
      ruleVersion: 1,
      normalizedUrl: 'https://example.test/catalog',
      identityFields: [{ name: 'a', value: 'second-by-code-unit' }, { name: 'Z', value: 'first-by-code-unit' }],
    });
    const second = createFindingFingerprint({
      targetId: 'example-target',
      ruleId: 'IMAGE_LOAD_FAILED',
      ruleVersion: 1,
      normalizedUrl: 'https://example.test/catalog',
      identityFields: [{ name: 'Z', value: 'first-by-code-unit' }, { name: 'a', value: 'second-by-code-unit' }],
    });

    const expectedInput = JSON.stringify({
      targetId: 'example-target',
      ruleId: 'IMAGE_LOAD_FAILED',
      ruleVersion: 1,
      normalizedUrl: 'https://example.test/catalog',
      identityFields: [{ name: 'Z', value: 'first-by-code-unit' }, { name: 'a', value: 'second-by-code-unit' }],
    });
    const expected = `sha256:${createHash('sha256').update(expectedInput).digest('hex')}`;

    expect(first).toBe(second);
    expect(first).toBe(expected);
  });

  it('does not mutate caller-owned fingerprint identity fields while sorting', () => {
    const identityFields = [
      { name: 'zeta', value: 'last' },
      { name: 'alpha', value: 'first' },
    ];
    const originalIdentityFields = identityFields.map((field) => ({ ...field }));

    createFindingFingerprint({
      targetId: 'example-target',
      ruleId: 'IMAGE_LOAD_FAILED',
      ruleVersion: 1,
      normalizedUrl: 'https://example.test/catalog',
      identityFields,
    });

    expect(identityFields).toEqual(originalIdentityFields);
  });

  it.each([
    ['targetId', { targetId: 'other-target' }],
    ['ruleId', { ruleId: 'OTHER_RULE' }],
    ['ruleVersion', { ruleVersion: 2 }],
    ['normalizedUrl', { normalizedUrl: 'https://example.test/other' }],
    ['identityFields', { identityFields: [{ name: 'src', value: 'https://example.test/other.png' }] }],
  ] as const)('includes %s in the finding fingerprint', (_name, change) => {
    const input = {
      targetId: 'example-target',
      ruleId: 'IMAGE_LOAD_FAILED',
      ruleVersion: 1,
      normalizedUrl: 'https://example.test/catalog',
      identityFields: [{ name: 'src', value: 'https://example.test/missing.png' }],
    };

    expect(createFindingFingerprint({ ...input, ...change })).not.toBe(createFindingFingerprint(input));
  });
});
