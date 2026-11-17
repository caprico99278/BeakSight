import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { FINDING_SCHEMA_VERSIONS, type Finding } from '../../src/core/contracts.js';
import { createEvidenceId, createFindingId, createPageId } from '../../src/core/ids.js';
import { validateArtifact } from '../../src/core/schema-validator.js';

const validFinding = {
  schemaVersion: 'finding-schema/1.0',
  findingId: createFindingId(7),
  fingerprint: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  ruleId: 'HTTP_4XX',
  ruleVersion: 1,
  category: 'HTTP',
  severity: 'ERROR',
  pageId: createPageId(1),
  pageUrl: 'http://127.0.0.1:4173/finding-schema',
  viewport: 'desktop',
  message: 'ページのナビゲーションの応答が HTTP ステータス 404 でした。',
  evidenceRefs: [createEvidenceId('network', 1)],
} satisfies Finding;

describe('finding.schema.json の evidenceRefs', () => {
  it('Evidence を1件以上参照する Finding を受け入れる', async () => {
    await expect(validateArtifact('finding', validFinding)).resolves.toEqual({ ok: true });
    await expect(
      validateArtifact('finding', { ...validFinding, evidenceRefs: [createEvidenceId('network', 1), createEvidenceId('dom', 2)] }),
    ).resolves.toEqual({ ok: true });
  });

  it('evidenceRefs が空の配列の Finding を拒否する（Finding は1件以上の Evidence を参照する）', async () => {
    const result = await validateArtifact('finding', { ...validFinding, evidenceRefs: [] });

    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.errors.join('\n')).toContain('/evidenceRefs');
  });
});

describe('AUD-9a: finding.schema.json の版と groupingKeys', () => {
  const current = {
    ...validFinding,
    schemaVersion: 'finding-schema/1.1',
    groupingKeys: [{ name: 'selector', value: '#site-header' }],
  } satisfies Finding;

  it('schema の版の一覧は、型の版の一覧（FINDING_SCHEMA_VERSIONS）と同じ', () => {
    const schema = JSON.parse(readFileSync(new URL('../../schemas/finding.schema.json', import.meta.url), 'utf8')) as {
      readonly properties: { readonly schemaVersion: { readonly enum: readonly string[] } };
    };
    expect(schema.properties.schemaVersion.enum).toEqual([...FINDING_SCHEMA_VERSIONS]);
  });

  it('新しい版（1.1）の groupingKeys のある Finding と、古い版（1.0）の欄のない Finding の両方を受け入れる', async () => {
    await expect(validateArtifact('finding', current)).resolves.toEqual({ ok: true });
    await expect(validateArtifact('finding', { ...current, groupingKeys: [] })).resolves.toEqual({ ok: true });
    await expect(validateArtifact('finding', validFinding)).resolves.toEqual({ ok: true });
  });

  it('1.1 で groupingKeys がない、1.0 で groupingKeys がある、鍵の形が違う Finding を拒否する', async () => {
    const { groupingKeys: _omitted, ...withoutKeys } = current;
    for (const invalid of [
      withoutKeys,
      { ...validFinding, groupingKeys: [] },
      { ...current, groupingKeys: [{ name: 'selector' }] },
      { ...current, groupingKeys: [{ name: '', value: 'x' }] },
      { ...current, groupingKeys: [{ name: 'selector', value: 'x', extra: 1 }] },
      { ...current, schemaVersion: 'finding-schema/1.2' },
    ]) {
      const result = await validateArtifact('finding', invalid);
      expect(result.ok, JSON.stringify(invalid)).toBe(false);
    }
  });
});
