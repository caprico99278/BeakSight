// COV-6: page の schema の任意の欄 `collectedInParts`（リンク・DOM・色の Evidence。分けて集めた回数）。新しい記録が通り、古い記録（欄なし）も読め、
// 0 以下は拒む。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSchemaValidatorRegistry } from '../../src/core/schema-validator.js';

const SCHEMA_ROOT = join(process.cwd(), 'schemas');

const schemaFilesUnder = (directory: string): string[] => readdirSync(directory).flatMap((name) => {
  const path = join(directory, name);
  return statSync(path).isDirectory() ? schemaFilesUnder(path) : name.endsWith('.json') ? [path] : [];
});

const PAGE_SCHEMA_ID = 'urn:beaksight:schema:page:1.0';

const validatorOf = (definition: string) => {
  const schemas = schemaFilesUnder(SCHEMA_ROOT).map((path) => JSON.parse(readFileSync(path, 'utf8')) as object);
  const id = `urn:beaksight:test:cov-6:${definition}`;
  const registry = createSchemaValidatorRegistry([...schemas, { $id: id, $ref: `${PAGE_SCHEMA_ID}#/$defs/${definition}` }]);
  return registry.validatorFor(id);
};

const OLD_LINKS = { links: [], omittedLinkCount: 3 };
const OLD_COLOR = {
  scrollPosition: { scrollX: 0, scrollY: 0 },
  textSamples: [],
  textSamplesTruncated: true,
  foregroundDistribution: [],
  omittedDistributionEntryCount: 2,
  observedArea: 0,
};

describe('page schema: collectedInParts（COV-6）', () => {
  it('リンクの Evidence: 古い記録（欄なし）も、新しい記録も通り、0 は拒む', () => {
    const validate = validatorOf('linkDiscoveryEvidence');
    expect(validate(OLD_LINKS).ok).toBe(true);
    expect(validate({ links: [], omittedLinkCount: 0, collectedInParts: 2 }).ok).toBe(true);
    expect(validate({ links: [], omittedLinkCount: 0, collectedInParts: 0 }).ok).toBe(false);
  });

  it('色の Evidence: 古い記録（欄なし）も、新しい記録も通る', () => {
    const validate = validatorOf('colorEvidence');
    expect(validate(OLD_COLOR).ok).toBe(true);
    expect(validate({ ...OLD_COLOR, textSamplesTruncated: false, omittedDistributionEntryCount: 0, collectedInParts: 3 }).ok).toBe(true);
    expect(validate({ ...OLD_COLOR, collectedInParts: -1 }).ok).toBe(false);
  });

  it('DOM の Evidence に任意の欄がある（必須ではない）', () => {
    const page = JSON.parse(readFileSync(join(SCHEMA_ROOT, 'page.schema.json'), 'utf8')) as {
      readonly $defs: Record<string, { readonly required: readonly string[]; readonly properties: Record<string, unknown> }>;
    };
    for (const definition of ['domEvidence', 'linkDiscoveryEvidence', 'colorEvidence']) {
      expect(page.$defs[definition]?.properties['collectedInParts']).toEqual({ type: 'integer', minimum: 1 });
      expect(page.$defs[definition]?.required).not.toContain('collectedInParts');
    }
  });
});
