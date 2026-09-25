import { describe, expect, it } from 'vitest';
import type { Finding } from '../../src/core/contracts.js';
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
