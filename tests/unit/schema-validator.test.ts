import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { validateArtifact } from '../../src/core/schema-validator.js';

const validFinding = {
  schemaVersion: 'finding-schema/1.0',
  findingId: 'FIND-000042',
  fingerprint: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  ruleId: 'IMAGE_LOAD_FAILED',
  ruleVersion: 1,
  category: 'media',
  severity: 'ERROR',
  pageId: 'PAGE-000001',
  pageUrl: 'https://example.test/catalog',
  viewport: 'desktop',
  message: 'An image did not load.',
  evidenceRefs: ['EV-NET-000012'],
};

const validEvidence = {
  evidenceId: 'EV-NET-000012',
  type: 'network',
  pageId: 'PAGE-000001',
  viewport: 'desktop',
  observedAt: '2026-08-27T00:00:00.000Z',
  payload: { requestUrl: 'https://example.test/missing.png', status: 404 },
};

const validPage = {
  schemaVersion: 'page-schema/1.0',
  pageId: 'PAGE-000001',
  pageUrl: 'https://example.test/catalog',
  status: 'AUDITED',
  evidence: [validEvidence],
  findings: [validFinding],
  incompleteReasons: [],
};

const validRun = {
  schemaVersion: 'run-schema/1.0',
  runId: 'RUN-000001',
  runStatus: 'COMPLETE',
  startedAt: '2026-08-27T00:00:00.000Z',
  finishedAt: '2026-08-27T00:01:00.000Z',
  discoveredPageCount: 1,
  auditedPageCount: 1,
  failedPageCount: 0,
  skippedPageCount: 0,
  incompleteReasons: [],
};

const validAudit = {
  schemaVersion: 'audit-schema/1.0',
  run: validRun,
  pages: [validPage],
  findings: [validFinding],
};

describe('validateArtifact', () => {
  it('accepts a valid Finding through the canonical validator API', async () => {
    await expect(validateArtifact('finding', validFinding)).resolves.toEqual({ ok: true });
  });

  it('returns typed errors instead of throwing when a Finding lacks evidenceRefs', async () => {
    const { evidenceRefs: _evidenceRefs, ...missingEvidenceRefs } = validFinding;

    await expect(validateArtifact('finding', missingEvidenceRefs)).resolves.toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.stringContaining('evidenceRefs')]),
    });
  });

  it('rejects run statuses outside the four approved values', async () => {
    await expect(validateArtifact('run', { ...validRun, runStatus: 'IN_PROGRESS' })).resolves.toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.stringContaining('runStatus')]),
    });
  });

  it('accepts aligned versioned Finding, Page, Run, and Audit artifacts', async () => {
    await expect(validateArtifact('finding', validFinding)).resolves.toEqual({ ok: true });
    await expect(validateArtifact('page', validPage)).resolves.toEqual({ ok: true });
    await expect(validateArtifact('run', validRun)).resolves.toEqual({ ok: true });
    await expect(validateArtifact('audit', validAudit)).resolves.toEqual({ ok: true });
  });

  it('rejects malformed nested Evidence and Findings in Page and Audit artifacts', async () => {
    await expect(validateArtifact('page', {
      ...validPage,
      evidence: [{ ...validEvidence, payload: { requestUrl: 'https://example.test/missing.png', status: '404' } }],
    })).resolves.toMatchObject({ ok: false });
    await expect(validateArtifact('audit', {
      ...validAudit,
      pages: [{ ...validPage, findings: [{ ...validFinding, evidenceRefs: undefined }] }],
    })).resolves.toMatchObject({ ok: false });
  });

  it('rejects an audit with a malformed nested Run summary', async () => {
    await expect(validateArtifact('audit', { ...validAudit, run: {} })).resolves.toMatchObject({ ok: false });
  });

  it('validates through the canonical distribution module after the schemas are copied', async () => {
    const rootDirectory = process.cwd();
    const compilerPath = resolve(rootDirectory, 'node_modules/typescript/bin/tsc');
    const compile = spawnSync(process.execPath, [compilerPath, '-p', 'tsconfig.build.json'], { cwd: rootDirectory, encoding: 'utf8' });
    expect(compile.status, compile.stderr).toBe(0);
    const copySchemas = spawnSync(process.execPath, [
      '--input-type=module',
      '-e',
      "import { cpSync } from 'node:fs'; cpSync('schemas', 'dist/schemas', { recursive: true });",
    ], { cwd: rootDirectory, encoding: 'utf8' });
    expect(copySchemas.status, copySchemas.stderr).toBe(0);

    const moduleUrl = pathToFileURL(resolve(rootDirectory, 'dist/core/schema-validator.js')).href;
    const compiledValidator = await import(`${moduleUrl}?task2-fix-round-1`);
    await expect(compiledValidator.validateArtifact('audit', validAudit)).resolves.toEqual({ ok: true });
  });
});
