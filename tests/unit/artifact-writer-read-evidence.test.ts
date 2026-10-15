// T27e（Task 27 の設計書 4.5、4.8）: READ の確かめの成果物 `read-evidence.json` を、成果物を書く唯一の owner の ArtifactWriter
// （`writeReadEvidence`）で書くことの単体テスト（発見の `writeDiscovery` と同じ書き方）。
// - ファイルの名前は配置の owner（`src/core/artifact-layout.ts` の `READ_EVIDENCE_ARTIFACT_FILE_NAME`）のもの。Run のディレクトリの直下に書く。
// - 書く前にスキーマ（`read-evidence`）で確かめ、合わなければ何も書かずに `ArtifactWriteError`。
// - 認証つきの書き手（`urlSecretRedaction`）は、READ の URL の秘密に見える query の値を、今の伏せ字の 1 か所（`#outgoing`）で伏せる。
// 一時のフォルダだけを使い、終わったら消す。
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DISCOVERY_ARTIFACT_FILE_NAME,
  READ_EVIDENCE_ARTIFACT_FILE_NAME,
  RUN_ARTIFACT_FILE_NAMES,
  artifactFilePath,
} from '../../src/core/artifact-layout.js';
import { READ_EVIDENCE_ARTIFACT_SCHEMA_VERSION, type ReadEvidenceDocument } from '../../src/discovery/read-check-evaluation.js';
import { ArtifactWriteError, ArtifactWriter } from '../../src/report/artifact-writer.js';

const ORIGIN = 'http://127.0.0.1:4173';
const SECRET = 'tokenvalue0123456789';

const documentOf = (): ReadEvidenceDocument => ({
  schemaVersion: READ_EVIDENCE_ARTIFACT_SCHEMA_VERSION,
  jobId: 'job-1',
  runId: 'RUN-20261011010000',
  startedAt: '20261011010000',
  finishedAt: '20261011010100',
  runStatus: 'COMPLETE',
  endReason: 'COMPLETED',
  checks: [{
    readCheckId: 'read-1',
    readCheckRevision: 1,
    targetIdentityDigest: `sha256:${'a'.repeat(64)}`,
    state: 'EXECUTED',
    result: 'MATCHED',
    detail: 'EXPECTATIONS_EVALUATED',
    // 契約は秘密に見える名前を送らないが、書き手は、どの URL も伏せ字の 1 か所に通す。
    url: `${ORIGIN}/admin/list?q=x&token=${SECRET}`,
    httpStatus: 200,
    blockedRequests: 0,
    structure: null,
    expectations: [{ expectation: { kind: 'TEXT_CONTAINS', text: 'x' }, result: 'MATCHED', undeterminedReason: null, found: true }],
  }],
});

let runDirectory = '';

beforeEach(() => {
  runDirectory = mkdtempSync(join(tmpdir(), 'beaksight-read-evidence-writer-'));
});

afterEach(() => {
  rmSync(runDirectory, { recursive: true, force: true });
});

describe('T27e: writing read-evidence.json through the ArtifactWriter', () => {
  it('names the file in the artifact layout, apart from the files of an audit Run and of a discovery Run', () => {
    expect(READ_EVIDENCE_ARTIFACT_FILE_NAME).toBe('read-evidence.json');
    expect(Object.values(RUN_ARTIFACT_FILE_NAMES)).not.toContain(READ_EVIDENCE_ARTIFACT_FILE_NAME);
    expect(READ_EVIDENCE_ARTIFACT_FILE_NAME).not.toBe(DISCOVERY_ARTIFACT_FILE_NAME);
  });

  it('writes the document checked by the schema and returns its relative path (no temporary file left)', async () => {
    expect(await new ArtifactWriter().writeReadEvidence(runDirectory, documentOf())).toBe(READ_EVIDENCE_ARTIFACT_FILE_NAME);
    expect(JSON.parse(readFileSync(artifactFilePath(runDirectory, READ_EVIDENCE_ARTIFACT_FILE_NAME), 'utf8'))).toEqual(documentOf());
    expect(readdirSync(runDirectory)).toEqual([READ_EVIDENCE_ARTIFACT_FILE_NAME]);
  });

  it('redacts the URL secrets with the authenticated writer', async () => {
    await new ArtifactWriter({ urlSecretRedaction: true }).writeReadEvidence(runDirectory, documentOf());
    const redacted = readFileSync(artifactFilePath(runDirectory, READ_EVIDENCE_ARTIFACT_FILE_NAME), 'utf8');
    expect(redacted).not.toContain(SECRET);
    expect(redacted).toContain('/admin/list?q=x&token=');
  });

  it('writes nothing and throws ArtifactWriteError when the document does not match the schema (a copied table, for example)', async () => {
    const [check] = documentOf().checks;
    const invalid = { ...documentOf(), checks: [{ ...check, rows: [['A-1', 'りんご']] }] } as unknown as ReadEvidenceDocument;
    await expect(new ArtifactWriter().writeReadEvidence(runDirectory, invalid)).rejects.toBeInstanceOf(ArtifactWriteError);
    expect(existsSync(artifactFilePath(runDirectory, READ_EVIDENCE_ARTIFACT_FILE_NAME))).toBe(false);
    await expect(new ArtifactWriter().writeReadEvidence('', documentOf())).rejects.toThrow(TypeError);
  });
});
