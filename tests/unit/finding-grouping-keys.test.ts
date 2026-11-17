import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GROUPING_KEY_FIELD_NAMES,
  NON_GROUPING_IDENTITY_FIELD_NAMES,
  groupingKeysOf,
} from '../../src/audit/finding-grouping-keys.js';
import { materializeFindingDrafts } from '../../src/audit/rule-engine.js';
import type { EvidenceId } from '../../src/core/contracts.js';
import type { NormalizedHttpUrlEvidence } from '../../src/core/evidence-types.js';
import { createEvidenceId, createPageId, type FindingFingerprintIdentityField } from '../../src/core/ids.js';

const AUDIT_DIR = join(import.meta.dirname, '..', '..', 'src', 'audit');

/**
 * src/audit の Rule が使う同一性の欄の名前（`name: '…'` の文字の値と、`…_IDENTITY_FIELD_NAME = '…'` の定数）。
 * 予約名 `viewport`（Rule Engine が足す）は除く。
 */
const identityFieldNamesInAudit = (): ReadonlySet<string> => {
  const names = new Set<string>();
  for (const file of readdirSync(AUDIT_DIR).filter((name) => name.endsWith('.ts'))) {
    const source = readFileSync(join(AUDIT_DIR, file), 'utf8');
    for (const match of source.matchAll(/\{\s*name:\s*'([A-Za-z]+)',\s*value:/gu)) {
      names.add(match[1] ?? '');
    }
    for (const match of source.matchAll(/_IDENTITY_FIELD_NAME = '([A-Za-z]+)'/gu)) {
      names.add(match[1] ?? '');
    }
  }
  names.delete('viewport');
  return names;
};

describe('AUD-9a: まとめの鍵の許可の一覧', () => {
  it('Rule が使う同一性の欄の名前は、すべて許可の一覧か、残さない一覧のどちらか 1 つにある（新しい名前が出たら、ここで気づく）', () => {
    const used = [...identityFieldNamesInAudit()].sort();
    const classified = [...GROUPING_KEY_FIELD_NAMES, ...NON_GROUPING_IDENTITY_FIELD_NAMES];
    expect(new Set(classified).size).toBe(classified.length);
    expect(used.filter((name) => !classified.includes(name as never))).toEqual([]);
    // 一覧に、もう使われない名前を残さない。
    expect(classified.filter((name) => !used.includes(name)).sort()).toEqual([]);
  });

  it('stack・url・href・title・field などは残さず、selector の類と Rule の識別だけを、同じ値で残す', () => {
    const fields: FindingFingerprintIdentityField[] = [
      { name: 'selector', value: 'main:nth-of-type(1) > p:nth-of-type(2)' },
      { name: 'url', value: 'http://127.0.0.1:4173/a' },
      { name: 'href', value: '/b' },
      { name: 'title', value: 'ページ' },
      { name: 'field', value: '["form",0,"text","q"]' },
      { name: 'errorName', value: 'TypeError' },
      { name: 'errorMessage', value: 'boom' },
      { name: 'stack', value: 'at http://127.0.0.1:4173/app.js:1:1' },
      { name: 'target', value: JSON.stringify(['#main', ['iframe', '#inner']]) },
      { name: 'stressWidth', value: '320' },
    ];
    expect(groupingKeysOf(fields)).toEqual([
      { name: 'selector', value: 'main:nth-of-type(1) > p:nth-of-type(2)' },
      { name: 'target', value: JSON.stringify(['#main', ['iframe', '#inner']]) },
      { name: 'stressWidth', value: '320' },
    ]);
  });

  it('許可した欄でも、属性の値を書いた selector と、秘密に見える文字を含む値は残さない', () => {
    expect(groupingKeysOf([
      { name: 'target', value: JSON.stringify(['input[name="email"]']) },
      { name: 'target', value: JSON.stringify(['a[href^="/x"]']) },
      { name: 'selector', value: '#x[value=secret]' },
      { name: 'selector', value: '#token=abc' },
      { name: 'elementId', value: 'access_token=abcdef' },
      { name: 'target', value: JSON.stringify(['button:nth-child(2)']) },
      { name: 'target', value: JSON.stringify(['input[type]']) },
    ])).toEqual([
      { name: 'target', value: JSON.stringify(['button:nth-child(2)']) },
      { name: 'target', value: JSON.stringify(['input[type]']) },
    ]);
  });

  it('layout の collector の selector の作り方は、id か tag:nth-of-type の連なりだけで、属性や入力の中身を含まない', () => {
    const source = readFileSync(join(import.meta.dirname, '..', '..', 'src', 'evidence', 'layout-collector.ts'), 'utf8');
    const start = source.indexOf('const selectorFor = (element: Element)');
    const end = source.indexOf('const rectFor = ', start);
    expect(start).toBeGreaterThan(0);
    const body = source.slice(start, end);
    expect(body).toContain('`#${CSS.escape(id)}`');
    expect(body).toContain(':nth-of-type(');
    expect(body).not.toMatch(/getAttribute|\.value\b|textContent|innerText|\[\$\{/u);
  });
});

describe('AUD-9a: Finding の groupingKeys と fingerprint', () => {
  const pageId = createPageId(1);
  const evidenceId: EvidenceId = createEvidenceId('layout', 1);
  const materialize = (identityFields: readonly FindingFingerprintIdentityField[], viewport: 'desktop' | null = 'desktop') =>
    materializeFindingDrafts({
      targetId: 'grouping-keys-target',
      firstFindingSequence: 1,
      evidenceIds: new Set([evidenceId]),
      drafts: [{
        owner: { ruleId: 'GROUPING_RULE', version: 1, category: 'LAYOUT' },
        context: { pageId, pageUrl: 'http://127.0.0.1:4173/grouping' as NormalizedHttpUrlEvidence, viewport },
        draft: {
          ruleId: 'GROUPING_RULE',
          ruleVersion: 1,
          category: 'LAYOUT',
          severity: 'WARN',
          message: '仮の指摘です。',
          evidenceRefs: [evidenceId],
          identityFields,
        },
      }],
    }).findings[0];

  it('新しい Finding は finding-schema/1.1 で、許可した欄だけを groupingKeys に残す', () => {
    const finding = materialize([
      { name: 'overlaySelector', value: '#site-header' },
      { name: 'url', value: 'http://127.0.0.1:4173/a' },
    ]);
    expect(finding?.schemaVersion).toBe('finding-schema/1.1');
    expect(finding?.groupingKeys).toEqual([{ name: 'overlaySelector', value: '#site-header' }]);
  });

  it('fingerprint の値は、欄を足す前と変わらない（固定の値。欄を足す前の Rule Engine で求めた値）', () => {
    expect(materialize([{ name: 'overlaySelector', value: '#site-header' }])?.fingerprint)
      .toBe('sha256:c20af41126d6919c31a7e65ded71194ac8fe8ba3a4b769c3c91dfce072401a19');
    expect(materialize([{ name: 'url', value: 'http://127.0.0.1:4173/a' }], null)?.fingerprint)
      .toBe('sha256:df2b5458bb17c0e5361e5ccd7134bab30fc23ce7896dfbbf66680a6953fd8b0f');
    expect(materialize([])?.fingerprint).toBe('sha256:2e7fb2dd0ea02ea0fc3e65f7849d8a84ebd90e65f510a328cc27e32e8a47817d');
  });
});
