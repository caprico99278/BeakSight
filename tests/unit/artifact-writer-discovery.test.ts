// T27d（Task 27 の設計書の変更履歴「Blocker: T27d」の行の (1)）: 発見の成果物 `discovery.json` を、成果物を書く唯一の owner の ArtifactWriter
// （`writeDiscovery`）で書くことの単体テスト。
// - ファイルの名前は配置の owner（`src/core/artifact-layout.ts` の `DISCOVERY_ARTIFACT_FILE_NAME`）のもの。Run のディレクトリの直下に書く。
// - 書く前にスキーマ（`discovery`）で確かめ、合わなければ何も書かずに `ArtifactWriteError`。
// - 認証つきの書き手（`urlSecretRedaction`）は、URL の秘密（query の値）を、今の伏せ字の 1 か所（`#outgoing`）で伏せる。
// 一時のフォルダだけを使い、終わったら消す。
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DISCOVERY_ARTIFACT_FILE_NAME, RUN_ARTIFACT_FILE_NAMES, artifactFilePath } from '../../src/core/artifact-layout.js';
import {
  DISCOVERY_ARTIFACT_SCHEMA_VERSION,
  type DiscoveryDocument,
} from '../../src/discovery/discovery-result.js';
import { ArtifactWriteError, ArtifactWriter } from '../../src/report/artifact-writer.js';

const ORIGIN = 'http://127.0.0.1:4173';
const SECRET = 'tokenvalue0123456789';

const documentOf = (overrides: Partial<DiscoveryDocument> = {}): DiscoveryDocument => ({
  schemaVersion: DISCOVERY_ARTIFACT_SCHEMA_VERSION,
  jobId: 'job-1',
  runId: 'RUN-20261011010000',
  startedAt: '20261011010000',
  finishedAt: '20261011010100',
  runStatus: 'PARTIAL',
  endReason: 'MAX_PAGES_REACHED',
  maxPages: 1,
  pages: [
    { url: `${ORIGIN}/admin?page=2`, state: 'READ', record: { location: { origin: ORIGIN, path: '/admin' }, incompleteReasons: [], candidates: [] }, blockedRequests: 1 },
    { url: `${ORIGIN}/admin/report?token=${SECRET}&page=2`, state: 'NOT_READ', reason: 'MAX_PAGES_REACHED' },
  ],
  omittedUnreadPages: 0,
  ...overrides,
});

let runDirectory = '';

beforeEach(() => {
  runDirectory = mkdtempSync(join(tmpdir(), 'beaksight-discovery-writer-'));
});

afterEach(() => {
  rmSync(runDirectory, { recursive: true, force: true });
});

describe('T27d: writing discovery.json through the ArtifactWriter', () => {
  it('names the file in the artifact layout, apart from the files of an audit Run', () => {
    expect(DISCOVERY_ARTIFACT_FILE_NAME).toBe('discovery.json');
    expect(Object.values(RUN_ARTIFACT_FILE_NAMES)).not.toContain(DISCOVERY_ARTIFACT_FILE_NAME);
  });

  it('writes the document checked by the schema and returns its relative path (no temporary file left)', async () => {
    const written = await new ArtifactWriter().writeDiscovery(runDirectory, documentOf());
    expect(written).toBe(DISCOVERY_ARTIFACT_FILE_NAME);
    const path = artifactFilePath(runDirectory, DISCOVERY_ARTIFACT_FILE_NAME);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(documentOf());
    expect(readdirSync(runDirectory)).toEqual([DISCOVERY_ARTIFACT_FILE_NAME]);
  });

  it('redacts the URL secrets with the authenticated writer, and keeps them with the default writer', async () => {
    await new ArtifactWriter({ urlSecretRedaction: true }).writeDiscovery(runDirectory, documentOf());
    const redacted = readFileSync(artifactFilePath(runDirectory, DISCOVERY_ARTIFACT_FILE_NAME), 'utf8');
    expect(redacted).not.toContain(SECRET);
    expect(redacted).toContain('/admin/report?token=');
    expect(redacted).toContain('page=2');

    await new ArtifactWriter().writeDiscovery(runDirectory, documentOf());
    expect(readFileSync(artifactFilePath(runDirectory, DISCOVERY_ARTIFACT_FILE_NAME), 'utf8')).toContain(SECRET);
  });

  it('writes nothing and throws ArtifactWriteError when the document does not match the schema', async () => {
    const invalid = { ...documentOf(), cookies: [{ name: 'sid', value: SECRET }] } as unknown as DiscoveryDocument;
    await expect(new ArtifactWriter().writeDiscovery(runDirectory, invalid)).rejects.toBeInstanceOf(ArtifactWriteError);
    expect(existsSync(artifactFilePath(runDirectory, DISCOVERY_ARTIFACT_FILE_NAME))).toBe(false);
    await expect(new ArtifactWriter().writeDiscovery('', documentOf())).rejects.toThrow(TypeError);
  });
});
