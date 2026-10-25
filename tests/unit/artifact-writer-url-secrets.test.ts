// T25f（Task 25 の設計書 `2026-10-10-beaksight-task-25-manual-login-session-design.md` 4.6）: 認証つきの Run の成果物の URL の伏せ字を、
// Run のディレクトリの書き出しの唯一の owner（`ArtifactWriter`。ARCH08）の 1 か所で通す。
// - `urlSecretRedaction: true` の書き手は、書く値（run.json、audit.json、page.json、visible-text.txt、保存のページと状態、診断の記録）の
//   すべての文字列の URL に、伏せ字の部品（`redactUrlSecretsInValue`）を通す。`writeRun` が返す最終の Run（表示用モデル、HTML、バンドルの
//   もと）も伏せ字の後の値。スキーマに合う。
// - T44g（Task 44 の設計書 P4-1。案 2）: 既定（公開監査）の書き手も、同じく伏せる。名前で伏せる段を外した書き手（`urlSecretRedaction: false`）だけが値を通さない。
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  RUN_ARTIFACT_FILE_NAMES,
  artifactFilePath,
  checkpointArtifactRelativePath,
  checkpointPageArtifactRelativePath,
  pageArtifactRelativePath,
  runArtifactDirectory,
} from '../../src/core/artifact-layout.js';
import type { AuditRunResult, PageAuditResult } from '../../src/core/contracts.js';
import { REDACTED } from '../../src/core/redaction.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import { createRunCheckpointPage, type RunCheckpoint } from '../../src/orchestration/run-checkpoint.js';
import {
  SITE_UNAVAILABLE_DIAGNOSTIC_SCHEMA_VERSION,
  type SiteUnavailableDiagnosticRecord,
} from '../../src/orchestration/run-coordinator.js';
import { serializeArtifactJson } from '../../src/core/artifact-json.js';
import { ArtifactWriter } from '../../src/report/artifact-writer.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import {
  FIXTURE_OBSERVED_AT,
  FIXTURE_ORIGIN,
  FIXTURE_RUN_ID as RUN_ID,
  PAGE_1,
  auditRun,
  dom,
  page,
  retry,
} from '../helpers/audit-run-fixture.js';
import { sampleRunCheckpoint } from '../helpers/run-checkpoint-samples.js';

/** 仮の秘密の値（目印）。 */
const SECRETS = Object.freeze({ token: 'tok-7f3a91', code: 'code-2b8c44', sid: 'sid-90d1e7' });
/** ページの URL（query に秘密を持つ）。 */
const SECRET_PATH = `/?token=${SECRETS.token}&page=2`;
const REDACTED_PATH = `/?token=${REDACTED}&page=2`;

const workDirectories: string[] = [];

afterEach(async () => {
  for (const directory of workDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function outputDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'beaksight-artifact-writer-secrets-'));
  workDirectories.push(directory);
  return directory;
}

/** 秘密を、ページの URL、可視テキスト（文の中の URL）、canonical、再試行の記録に持つページ。 */
function secretPage(): PageAuditResult {
  return page(PAGE_1, SECRET_PATH, 'AUDITED', [
    dom(1, PAGE_1, 'desktop', `次へ ${FIXTURE_ORIGIN}/next?code=${SECRETS.code} を開く`, {
      canonicalUrl: `${FIXTURE_ORIGIN}/?sid=${SECRETS.sid}`,
    }),
  ]);
}

function secretRun(): AuditRunResult {
  const value = secretPage();
  return auditRun({ pages: [value], run: { retries: [retry(value.pageUrl, 1, [])] } });
}

const leakedSecrets = (text: string): readonly string[] => Object.values(SECRETS).filter((secret) => text.includes(secret));

/** 診断の記録（そのページの最終の試行の結果と、Desktop の文書の要求の URL）。 */
function secretDiagnostic(): SiteUnavailableDiagnosticRecord {
  const result = secretPage();
  const observedAtMs = Date.parse(FIXTURE_OBSERVED_AT);
  return {
    schemaVersion: SITE_UNAVAILABLE_DIAGNOSTIC_SCHEMA_VERSION,
    runId: RUN_ID,
    executionNumber: 1,
    writtenAt: FIXTURE_OBSERVED_AT,
    pageId: PAGE_1,
    url: result.pageUrl,
    siteUnavailableDetail: 'desktop:passive:TIMEOUT',
    page: result,
    navigationDiagnostics: {
      desktop: {
        passive: {
          status: 'OBSERVED',
          observationStartedAtMs: observedAtMs,
          observationEndedAtMs: observedAtMs + 1,
          documentRequests: [{
            hops: [{
              url: result.pageUrl,
              method: 'GET',
              truncated: false,
              issuedAtMs: observedAtMs,
              requestHeadersSentAtMs: null,
              responseHeadersReceivedAtMs: null,
              httpStatus: null,
              remoteIpAddress: null,
              remotePort: null,
            }],
            loadingFinishedAtMs: null,
            loadingFailure: null,
          }],
          omittedDocumentRequestCount: 0,
          omittedEventCount: 0,
        },
        stressWidths: [],
        interactionCandidates: [],
      },
      mobile: null,
    },
  };
}

/** 再試行の記録に秘密の URL を持つ保存の状態。 */
function secretCheckpoint(): RunCheckpoint {
  const checkpoint = sampleRunCheckpoint();
  return { ...checkpoint, progress: { ...checkpoint.progress, retries: [retry(secretPage().pageUrl, 1, [])] } };
}

describe('ArtifactWriter: the URL secrets of an authenticated Run (Task 25 design 4.6, T25f)', () => {
  it('rejects a urlSecretRedaction option that is not a boolean', () => {
    expect(() => new ArtifactWriter({ urlSecretRedaction: 'yes' as unknown as boolean })).toThrow(TypeError);
  });

  it('writes run.json, audit.json, page.json and visible-text.txt with the secret query values redacted, and returns the redacted Run', async () => {
    const root = await outputDirectory();
    const written = await new ArtifactWriter({ urlSecretRedaction: true }).writeRun(secretRun(), { outputDirectory: root });

    expect(written.schemaValid).toBe(true);
    expect(written.result.pages[0]?.pageUrl).toBe(`${FIXTURE_ORIGIN}${REDACTED_PATH}`);
    expect(written.result.run.retries[0]?.url).toBe(`${FIXTURE_ORIGIN}${REDACTED_PATH}`);
    expect(leakedSecrets(JSON.stringify(written.result))).toEqual([]);
    const runDirectory = runArtifactDirectory(root, RUN_ID);
    const texts = await Promise.all([
      RUN_ARTIFACT_FILE_NAMES.run,
      RUN_ARTIFACT_FILE_NAMES.audit,
      pageArtifactRelativePath(PAGE_1, 'page'),
      pageArtifactRelativePath(PAGE_1, 'visibleText'),
    ].map(async (path) => readFile(artifactFilePath(runDirectory, path), 'utf8')));
    expect(texts.flatMap(leakedSecrets)).toEqual([]);
    const pageJson = texts[2] ?? '';
    expect(pageJson).toContain(`token=${REDACTED}&page=2`);
    expect(pageJson).toContain(`next?code=${REDACTED}`);
    expect(pageJson).toContain(`sid=${REDACTED}`);
    expect(texts[3]).toBe(`次へ ${FIXTURE_ORIGIN}/next?code=${REDACTED} を開く`);
    await expect(validateArtifact('page', JSON.parse(pageJson))).resolves.toEqual({ ok: true });
  });

  it('writes the checkpoint page, the checkpoint state and the site-unavailable diagnostic with the secret query values redacted', async () => {
    const runDirectory = runArtifactDirectory(await outputDirectory(), RUN_ID);
    const writer = new ArtifactWriter({ urlSecretRedaction: true });
    await writer.writeCheckpointPage(runDirectory, createRunCheckpointPage({
      result: secretPage(),
      retryEvidence: [],
      safetyLedgerSnapshots: [new SafetyLedger().snapshot()],
    }));
    await writer.writeCheckpointState(runDirectory, secretCheckpoint());
    const diagnosticPath = await writer.writeSiteUnavailableDiagnostic(runDirectory, secretDiagnostic(), 1);

    const texts = await Promise.all([
      checkpointPageArtifactRelativePath(PAGE_1),
      checkpointArtifactRelativePath('state'),
      diagnosticPath,
    ].map(async (path) => readFile(artifactFilePath(runDirectory, path), 'utf8')));
    expect(texts.flatMap(leakedSecrets)).toEqual([]);
    for (const text of texts) {
      expect(text).toContain(`token=${REDACTED}`);
    }
  });

  // T44g（Task 44 の設計書 P4-1。案 2）: 既定の書き手（公開の監査）も、認証つきの書き手と同じく伏せる（同じ 1 か所 `#outgoing`）。名前で伏せる段を外した
  // 書き手（`urlSecretRedaction: false`。製品では使わない）だけが、値をそのまま書く。
  it('redacts the same secrets with the default writer (the public audit), and keeps them only without the redaction', async () => {
    const root = await outputDirectory();
    const result = secretRun();
    const written = await new ArtifactWriter().writeRun(result, { outputDirectory: root });

    expect(written.result.pages[0]?.pageUrl).toBe(`${FIXTURE_ORIGIN}${REDACTED_PATH}`);
    expect(leakedSecrets(JSON.stringify(written.result))).toEqual([]);
    const runDirectory = runArtifactDirectory(root, RUN_ID);
    expect(leakedSecrets(await readFile(artifactFilePath(runDirectory, pageArtifactRelativePath(PAGE_1, 'page')), 'utf8'))).toEqual([]);
    const path = await new ArtifactWriter().writeSiteUnavailableDiagnostic(runDirectory, secretDiagnostic(), 1);
    expect(leakedSecrets(await readFile(artifactFilePath(runDirectory, path), 'utf8'))).toEqual([]);

    const plainRoot = await outputDirectory();
    const plain = await new ArtifactWriter({ urlSecretRedaction: false }).writeRun(result, { outputDirectory: plainRoot });
    expect(plain.result).toEqual(result);
    expect(await readFile(artifactFilePath(runArtifactDirectory(plainRoot, RUN_ID), RUN_ARTIFACT_FILE_NAMES.run), 'utf8'))
      .toBe(serializeArtifactJson(result.run));
    expect(leakedSecrets(serializeArtifactJson(result.pages[0]))).toEqual(Object.values(SECRETS));
  });
});
