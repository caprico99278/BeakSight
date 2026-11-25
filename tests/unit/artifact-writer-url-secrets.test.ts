// T25f（Task 25 の設計書 `2026-10-10-beaksight-task-25-manual-login-session-design.md` 4.6）: 認証つきの Run の成果物の URL の伏せ字を、
// Run のディレクトリの書き出しの唯一の owner（`ArtifactWriter`。ARCH08）の 1 か所で通す。
// - `urlSecretRedaction: true` の書き手は、書く値（run.json、audit.json、page.json、visible-text.txt、保存のページと状態）の
//   すべての文字列の URL に、伏せ字の部品（`redactUrlSecretsInValue`）を通す。`writeRun` が返す最終の Run（表示用モデル、HTML、バンドルの
//   もと）も伏せ字の後の値。スキーマに合う。
// - T44g（Task 44 の設計書 P4-1。案 2）: 既定（公開監査）の書き手も、同じく伏せる。名前で伏せる段を外した書き手（`urlSecretRedaction: false`）だけが値を通さない。
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import { writeAuditRunOutputs } from '../../src/cli/audit-run.js';
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
import { serializeArtifactJson } from '../../src/core/artifact-json.js';
import { ArtifactWriter } from '../../src/report/artifact-writer.js';
import { redactRecordedRequestUrlsInValue, redactUrlSecretsInValue } from '../../src/safety/redact.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import {
  FIXTURE_ORIGIN,
  FIXTURE_RUN_ID as RUN_ID,
  PAGE_1,
  PAGE_2,
  auditRun,
  dom,
  finding,
  network,
  networkFailure,
  page,
  record,
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

  it('writes the checkpoint page and the checkpoint state with the secret query values redacted', async () => {
    const runDirectory = runArtifactDirectory(await outputDirectory(), RUN_ID);
    const writer = new ArtifactWriter({ urlSecretRedaction: true });
    await writer.writeCheckpointPage(runDirectory, createRunCheckpointPage({
      result: secretPage(),
      retryEvidence: [],
      safetyLedgerSnapshots: [new SafetyLedger().snapshot()],
    }));
    await writer.writeCheckpointState(runDirectory, secretCheckpoint());

    const texts = await Promise.all([
      checkpointPageArtifactRelativePath(PAGE_1),
      checkpointArtifactRelativePath('state'),
    ].map(async (path) => readFile(artifactFilePath(runDirectory, path), 'utf8')));
    expect(texts.flatMap(leakedSecrets)).toEqual([]);
    for (const text of texts) {
      expect(text).toContain(`token=${REDACTED}`);
    }
  });

  // REC-3: 保存のページは、伏せた後の値をディスクの形（同じ欄を 1 回だけ書く形）にして書く。1 回にまとめた欄にも、伏せ字の後の値だけが入る。
  it('writes the checkpoint page in the form on the disk from the redacted values only', async () => {
    const runDirectory = runArtifactDirectory(await outputDirectory(), RUN_ID);
    const summary = `Fix the link ${FIXTURE_ORIGIN}/next?code=${SECRETS.code}`;
    const axe = record('accessibility', 2, PAGE_1, 'desktop', {
      status: 'COMPLETE', frameScope: 'SAME_ORIGIN_ONLY', scrollPosition: { scrollX: 0, scrollY: 0 }, incomplete: [],
      violations: [{
        ruleId: 'link-name', impact: 'serious', help: 'Links must have discernible text', helpUrl: 'https://example.invalid/link-name', tags: [], omittedNodeCount: 0,
        nodes: ['#a1', '#a2'].map((selector) => ({ impact: 'serious' as const, targetSelectors: [selector], failureSummary: summary, htmlSnippet: '<a>', truncated: false })),
      }],
    });
    await new ArtifactWriter({ urlSecretRedaction: true }).writeCheckpointPage(runDirectory, createRunCheckpointPage({
      result: { ...secretPage(), evidence: [...secretPage().evidence, axe] },
      retryEvidence: [axe],
      safetyLedgerSnapshots: [],
    }));

    const text = await readFile(artifactFilePath(runDirectory, checkpointPageArtifactRelativePath(PAGE_1)), 'utf8');
    const written = JSON.parse(text) as { schemaVersion: string; result: { schemaVersion: string; evidence: { payload: { violations?: { nodes: unknown }[] } }[] } };
    expect(leakedSecrets(text)).toEqual([]);
    expect(written.schemaVersion).toBe('checkpoint-page-schema/1.1');
    expect(written.result.schemaVersion).toBe('page-schema/2.0');
    expect(written.result.evidence.at(-1)?.payload.violations?.[0]?.nodes).toMatchObject({ common: { failureSummary: `Fix the link ${FIXTURE_ORIGIN}/next?code=${REDACTED}` } });
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

    const plainRoot = await outputDirectory();
    const plain = await new ArtifactWriter({ urlSecretRedaction: false }).writeRun(result, { outputDirectory: plainRoot });
    expect(plain.result).toEqual(result);
    expect(await readFile(artifactFilePath(runArtifactDirectory(plainRoot, RUN_ID), RUN_ARTIFACT_FILE_NAMES.run), 'utf8'))
      .toBe(serializeArtifactJson(result.run));
    expect(leakedSecrets(serializeArtifactJson(result.pages[0]))).toEqual(Object.values(SECRETS));
  });

  // MEM-1（DEF-266）: 伏せ字をページごとに行っても、Run 全体を 1 回で伏せた結果と同じ（ページ 1 の要求の URL が、ページ 2 の文と Run の Finding でも伏せられる）。
  it('redacts page by page with the table of the whole Run, the same as redacting the whole Run at once (MEM-1)', async () => {
    const requestUrl = `${FIXTURE_ORIGIN}/api/items?k=${SECRETS.code}`;
    const first = page(PAGE_1, '/', 'AUDITED', [network(1, PAGE_1, 'desktop', [networkFailure(requestUrl, 'fetch', 'net::ERR_FAILED', { requestId: 'R1' })])]);
    const secondDom = dom(2, PAGE_2, 'desktop', `前のページの要求 ${requestUrl} を見た`);
    const second = page(PAGE_2, '/second.html', 'AUDITED', [secondDom]);
    const runFinding = finding(3, 'WARN', 'HTTP', null, [secondDom.evidenceId], { message: `要求 ${requestUrl}` });
    const result = auditRun({ pages: [first, second], findings: [runFinding] });
    const written = await new ArtifactWriter({ urlSecretRedaction: true }).writeRun(result, { outputDirectory: await outputDirectory() });

    expect(written.schemaValid).toBe(true);
    expect(written.result).toEqual(redactUrlSecretsInValue(redactRecordedRequestUrlsInValue(result)));
    expect(leakedSecrets(JSON.stringify(written.result))).toEqual([]);
  });

  // DEF-298: くり返しをまとめた記録（`repeatedReads`）の `first`・`slowest` の URL も、記録した要求の URL と同じく伏せる（page.json・保存のページ・束）。
  // BS-1 の M-5: 伏せた後の Run から作った計測のタグの一覧に、識別子だけは残る。値は作り物。
  it('redacts the URLs of the repeated reads in every written file, and keeps the measurement tag identifier in the list (DEF-298)', async () => {
    const tagUrl = 'https://www.googletagmanager.com/gtm.js?id=GTM-TEST001';
    const firstUrl = `${FIXTURE_ORIGIN}/api/poll?userId=${SECRETS.sid}&t=1`;
    const slowestUrl = `${FIXTURE_ORIGIN}/api/poll?userId=${SECRETS.code}&t=2`;
    const { timing, method, resourceType, isMainFrame, isNavigationRequest } = networkFailure(firstUrl, 'fetch', '');
    const request = (requestId: string, url: string) => ({ requestId, url, method, resourceType, headers: { status: 'OBSERVED' as const, values: {} }, timing,
      redirectFromRequestId: null, redirectToRequestId: null, redirectChainRequestIds: [], truncated: false, isMainFrame, isNavigationRequest });
    const evidence = record('network', 1, PAGE_1, 'desktop', {
      requests: [request('R0', tagUrl), request('R1', firstUrl)], responses: [], failures: [],
      repeatedReads: [{
        method, origin: FIXTURE_ORIGIN, path: '/api/poll', resourceType, status: 200, isMainFrame, count: 3, firstRequestId: 'R1',
        first: { url: firstUrl, timing }, slowest: { url: slowestUrl, timing }, firstStartTime: 0, lastStartTime: 1,
        transfer: { observedCount: 0, totalBytes: 0 }, distinctQueryCount: 2,
      }],
      omittedRequestCount: 0, omittedResponseCount: 0, omittedFailureCount: 0,
    });
    const result = auditRun({ pages: [page(PAGE_1, '/', 'AUDITED', [evidence])] });
    const root = await outputDirectory();
    const writer = new ArtifactWriter({ urlSecretRedaction: true });
    const outputs = await writeAuditRunOutputs(result, root, writer);
    const runDirectory = runArtifactDirectory(root, RUN_ID);
    await writer.writeCheckpointPage(runDirectory, createRunCheckpointPage({ result: result.pages[0] as PageAuditResult, retryEvidence: [], safetyLedgerSnapshots: [] }));

    const texts = await Promise.all([pageArtifactRelativePath(PAGE_1, 'page'), checkpointPageArtifactRelativePath(PAGE_1)]
      .map(async (path) => readFile(artifactFilePath(runDirectory, path), 'utf8')));
    const bundles = (await readdir(runDirectory)).filter((name) => name.endsWith('.zip'));
    expect(bundles.length).toBeGreaterThan(0);
    for (const name of bundles) {
      const entries = unzipSync(new Uint8Array(await readFile(join(runDirectory, name))));
      texts.push(...Object.values(entries).map((bytes) => new TextDecoder().decode(bytes)));
    }
    expect(texts.flatMap(leakedSecrets)).toEqual([]);
    expect(texts[0]).toContain(`userId=${REDACTED}&t=${REDACTED}`);
    expect(outputs.summary.measurementTags.tags.map(({ tagId }) => tagId)).toEqual(['GTM-TEST001']);
  });
});
