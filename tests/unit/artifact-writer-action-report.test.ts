// T32e（Task 32 の設計書 4.1 の「書く人と時点」）: 書き込みの報告の 2 つの JSON（`action-evidence.json`・`approval-summary.json`）を、成果物を書く
// 唯一の owner の ArtifactWriter（`writeActionEvidence`・`writeApprovalSummary`）で書くことの単体テスト（`writeActionRun` と同じ書き方）。
// - ファイルの名前は配置の owner（`src/core/artifact-layout.ts`）のもの。Run のディレクトリの直下に書く。
// - 書く前にスキーマ（`action-evidence`・`approval-summary`）で確かめ、合わなければ何も書かずに `ArtifactWriteError`。
// - 認証つきの書き手（`urlSecretRedaction`）は、照合の READ の URL の秘密に見える query の値を、伏せ字の 1 か所（`#outgoing`）で伏せる。
// 一時のフォルダだけを使い、終わったら消す。
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ACTION_EVIDENCE_SCHEMA_VERSION,
  APPROVAL_SUMMARY_SCHEMA_VERSION,
  type ActionEvidenceDocument,
  type ApprovalSummaryDocument,
} from '../../src/control/actions/action-contracts.js';
import {
  ACTION_EVIDENCE_ARTIFACT_FILE_NAME,
  ACTION_REPORT_ARTIFACT_FILE_NAME,
  ACTION_RUN_ARTIFACT_FILE_NAME,
  APPROVAL_SUMMARY_ARTIFACT_FILE_NAME,
  actionBundleFileName,
  artifactFilePath,
} from '../../src/core/artifact-layout.js';
import { ArtifactWriteError, ArtifactWriter } from '../../src/report/artifact-writer.js';
import { verifiedCreateDocuments } from '../helpers/action-report-samples.js';
import { sampleApprovalFacts } from '../helpers/approval-facts-sample.js';

const ORIGIN = 'http://127.0.0.1:4173';
const SECRET = 'tokenvalue0123456789';

const evidenceOf = (): ActionEvidenceDocument => ({
  schemaVersion: ACTION_EVIDENCE_SCHEMA_VERSION,
  jobId: 'job-1',
  runId: 'RUN-20261015010000',
  profileId: 'example-write',
  scenarioId: 'scenario-w',
  scenarioRevision: 1,
  kind: 'CREATE',
  containsHumanEnteredValues: false,
  precheck: { candidateDigestMatched: true, blockReason: null },
  submission: { state: 'SENT', submittedValues: { name: 'サンプル 太郎' }, actionPath: '/members', submittedAt: '20261015010010' },
  response: { httpStatus: 200, judgement: 'SUCCESS', judgedAt: '20261015010011' },
  recordId: '42',
  update: null,
  readVerification: {
    readCheckId: 'rc-verify',
    readCheckRevision: 1,
    targetKind: 'CANDIDATE',
    targetIdentityDigest: `sha256:${'a'.repeat(64)}`,
    state: 'EXECUTED',
    result: 'MATCHED',
    detail: 'EXPECTATIONS_EVALUATED',
    // 契約は秘密に見える名前を送らないが、書き手は、どの URL も伏せ字の 1 か所に通す。
    url: `${ORIGIN}/members?q=x&token=${SECRET}`,
    httpStatus: 200,
    blockedRequests: 0,
    structure: null,
    expectations: [{ expectation: { kind: 'ROW_COUNT_EQUALS', count: 1 }, result: 'MATCHED', undeterminedReason: null, rowSource: 'TABLE', observedRowCount: 1 }],
  },
  guard: null,
  result: 'VERIFIED',
  reason: 'READ_VERIFICATION_MATCHED',
  startedAt: '20261015010000',
  finishedAt: '20261015010030',
  // T40c: 版 1.1 の送り方と API の要約（FORM）。
  transport: 'FORM',
  api: null,
});

const summaryOf = (): ApprovalSummaryDocument => ({
  ...sampleApprovalFacts({ kind: 'CREATE', profileId: 'example-write', scenarioId: 'scenario-w', scenarioRevision: 1, grantId: 'grant-w' }),
  schemaVersion: APPROVAL_SUMMARY_SCHEMA_VERSION,
  jobId: 'job-1',
  runId: 'RUN-20261015010000',
});

let runDirectory = '';

beforeEach(() => {
  runDirectory = mkdtempSync(join(tmpdir(), 'beaksight-action-report-writer-'));
});

afterEach(() => {
  rmSync(runDirectory, { recursive: true, force: true });
});

describe('T32e: writing the two JSON files of the write report through the ArtifactWriter', () => {
  it('writes the documents checked by the schemas and returns their relative paths (no temporary file left)', async () => {
    // T44g: 既定の書き手は名前で伏せる段を通すので、書いた値をそのまま比べるために、その段を外した書き手で書く。
    const writer = new ArtifactWriter({ urlSecretRedaction: false });
    expect(await writer.writeActionEvidence(runDirectory, evidenceOf())).toBe(ACTION_EVIDENCE_ARTIFACT_FILE_NAME);
    expect(await writer.writeApprovalSummary(runDirectory, summaryOf())).toBe(APPROVAL_SUMMARY_ARTIFACT_FILE_NAME);
    expect(JSON.parse(readFileSync(artifactFilePath(runDirectory, ACTION_EVIDENCE_ARTIFACT_FILE_NAME), 'utf8'))).toEqual(evidenceOf());
    expect(JSON.parse(readFileSync(artifactFilePath(runDirectory, APPROVAL_SUMMARY_ARTIFACT_FILE_NAME), 'utf8'))).toEqual(summaryOf());
    expect([...readdirSync(runDirectory)].sort()).toEqual([ACTION_EVIDENCE_ARTIFACT_FILE_NAME, APPROVAL_SUMMARY_ARTIFACT_FILE_NAME].sort());
  });

  it('redacts the URL secrets of the READ evidence with the authenticated writer', async () => {
    await new ArtifactWriter({ urlSecretRedaction: true }).writeActionEvidence(runDirectory, evidenceOf());
    const redacted = readFileSync(artifactFilePath(runDirectory, ACTION_EVIDENCE_ARTIFACT_FILE_NAME), 'utf8');
    expect(redacted).not.toContain(SECRET);
    expect(redacted).toContain('/members?q=x&token=');
  });

  it('writes nothing and throws ArtifactWriteError when a document does not match its schema', async () => {
    const writer = new ArtifactWriter();
    const cookie = { ...evidenceOf(), cookies: [] } as unknown as ActionEvidenceDocument;
    await expect(writer.writeActionEvidence(runDirectory, cookie)).rejects.toBeInstanceOf(ArtifactWriteError);
    const settled = { ...summaryOf(), reservationState: 'COMMITTED' } as unknown as ApprovalSummaryDocument;
    await expect(writer.writeApprovalSummary(runDirectory, settled)).rejects.toBeInstanceOf(ArtifactWriteError);
    expect(readdirSync(runDirectory)).toEqual([]);
    expect(existsSync(artifactFilePath(runDirectory, ACTION_EVIDENCE_ARTIFACT_FILE_NAME))).toBe(false);
    await expect(writer.writeActionEvidence('', evidenceOf())).rejects.toThrow(TypeError);
    await expect(writer.writeApprovalSummary('', summaryOf())).rejects.toThrow(TypeError);
  });
});

// T32f（Task 32 の設計書 4.1 の HTML と ZIP の行）: HTML と ZIP を組み立てる前に、3 つの文書を伏せ字とスキーマに通した文字列（ファイルに書くのと
// 同じバイト列）を用意する口（`prepareActionReport`。書かない）と、HTML とバンドルを書く口（`writeActionPresentation`）。
describe('T32f: preparing the write report documents and writing the HTML report and the bundle', () => {
  it('prepares the redacted and checked texts of the three documents, the same bytes as the written files, without writing', async () => {
    const writer = new ArtifactWriter({ urlSecretRedaction: true });
    const documents = { actionRun: verifiedCreateDocuments().actionRun, evidence: evidenceOf(), approvalSummary: summaryOf() };
    const prepared = await writer.prepareActionReport(runDirectory, documents);
    expect(readdirSync(runDirectory)).toEqual([]);
    expect(prepared.evidence.text).not.toContain(SECRET);
    expect(JSON.parse(prepared.evidence.text)).toEqual(prepared.evidence.value);
    await writer.writeActionEvidence(runDirectory, documents.evidence);
    await writer.writeApprovalSummary(runDirectory, documents.approvalSummary);
    await writer.writeActionRun(runDirectory, documents.actionRun);
    expect(readFileSync(artifactFilePath(runDirectory, ACTION_EVIDENCE_ARTIFACT_FILE_NAME), 'utf8')).toBe(prepared.evidence.text);
    expect(readFileSync(artifactFilePath(runDirectory, APPROVAL_SUMMARY_ARTIFACT_FILE_NAME), 'utf8')).toBe(prepared.approvalSummary.text);
    expect(readFileSync(artifactFilePath(runDirectory, ACTION_RUN_ARTIFACT_FILE_NAME), 'utf8')).toBe(prepared.actionRun.text);
  });

  it('writes nothing and throws ArtifactWriteError when a document does not match its schema', async () => {
    const documents = { actionRun: verifiedCreateDocuments().actionRun, evidence: { ...evidenceOf(), cookies: [] }, approvalSummary: summaryOf() };
    await expect(new ArtifactWriter().prepareActionReport(runDirectory, documents)).rejects.toBeInstanceOf(ArtifactWriteError);
    expect(readdirSync(runDirectory)).toEqual([]);
    await expect(new ArtifactWriter().prepareActionReport('', documents)).rejects.toThrow(TypeError);
  });

  it('writes the HTML report and the bundle named by the finish time of action-run.json', async () => {
    const bytes = Uint8Array.from([1, 2, 3]);
    const written = await new ArtifactWriter().writeActionPresentation(runDirectory, {
      reportHtml: '<!DOCTYPE html>\n<p>x</p>\n', bundle: { bytes, finishedAt: '20261015010030' },
    });
    expect(written).toEqual([ACTION_REPORT_ARTIFACT_FILE_NAME, actionBundleFileName('20261015010030')]);
    expect(readFileSync(artifactFilePath(runDirectory, ACTION_REPORT_ARTIFACT_FILE_NAME), 'utf8')).toBe('<!DOCTYPE html>\n<p>x</p>\n');
    expect(Uint8Array.from(readFileSync(artifactFilePath(runDirectory, actionBundleFileName('20261015010030'))))).toEqual(bytes);
  });

  it('writes nothing when the finish time cannot name the bundle', async () => {
    await expect(new ArtifactWriter().writeActionPresentation(runDirectory, {
      reportHtml: '<!DOCTYPE html>\n', bundle: { bytes: Uint8Array.from([1]), finishedAt: '2026-10-15' },
    })).rejects.toThrow(RangeError);
    expect(readdirSync(runDirectory)).toEqual([]);
  });
});
