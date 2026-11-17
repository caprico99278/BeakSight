/**
 * 段の口（RB-8 の発見の巡回の口 `DiscoveryRunRequest.crawlPorts`、RB-11 の READ の確かめの口 `ReadCheckRunRequest.readCheckPorts` と書き込みの口
 * `WriteCreateRunRequest.writePorts`）の本番の入口の Architecture Gate（TEST-TIME-B の 3 つの条件の (2)・(3) の形）。段の口はテストだけが偽を差し込む口で、
 * 本番の入口（ワーカーの組み立て・IPC）は渡さない。判定は `fs`、正規表現、文字列の走査だけ（`source-scan.ts`）。近似の検査である。
 * - (a) `src/` で口の名前を書くのは、その段の流れのファイルだけ。
 * - (b) 段の流れでは、依頼の項目の宣言 1 つと、省略なら本物の口を使う読み 1 つ（`request.<口> ?? PLAYWRIGHT_…`。RB-10 の Page Auditor は
 *   `dependencies.auditLoadPorts ?? playwrightAuditLoadPortsOf(…)`）だけ。
 */
import { describe, expect, it } from 'vitest';
import { loadSourceFiles, scanSource, sourceFileAt, type SourceFile } from './source-scan.js';

const SOURCE_FILES = loadSourceFiles();

/** 段の口の一覧（口の名前、段の流れのファイル、口の型、本物の口）。 */
const STAGE_PORTS: readonly { readonly name: string; readonly owner: string; readonly type: string; readonly real: string }[] = [
  { name: 'crawlPorts', owner: 'src/worker/discovery-run.ts', type: 'DiscoveryCrawlPorts', real: 'PLAYWRIGHT_DISCOVERY_CRAWL_PORTS' },
  { name: 'readCheckPorts', owner: 'src/worker/read-check-run.ts', type: 'ReadCheckPorts', real: 'PLAYWRIGHT_READ_CHECK_PORTS' },
  { name: 'writePorts', owner: 'src/worker/write-create-run.ts', type: 'WritePorts', real: 'PLAYWRIGHT_WRITE_PORTS' },
  // RB-10: 監査の読み込みの口（Page Auditor の依存。本物は factory と collector から作る）。
  { name: 'auditLoadPorts', owner: 'src/orchestration/page-auditor.ts', type: 'AuditLoadPorts', real: 'playwrightAuditLoadPortsOf' },
];

const nameOf = (name: string): RegExp => new RegExp(`\\b${name}\\b`, 'gu');
/** (b) 許す 2 つの形。 */
const allowedFormsOf = ({ name, type, real }: (typeof STAGE_PORTS)[number]): readonly RegExp[] => [
  new RegExp(`\\breadonly\\s+${name}\\?\\s*:\\s*${type}\\s*\\|\\s*undefined\\s*;`, 'gu'),
  new RegExp(`\\b(?:request|dependencies)\\.${name}\\s*\\?\\?\\s*${real}\\b`, 'gu'),
];

/** (a) 段の流れの外で口の名前を書くファイル。 */
const outsideFiles = (files: readonly Pick<SourceFile, 'path' | 'bare'>[], port: (typeof STAGE_PORTS)[number]): readonly string[] =>
  files.filter((file) => file.path !== port.owner && new RegExp(`\\b${port.name}\\b`, 'u').test(file.bare)).map((file) => file.path);

/** (b) 段の流れの、許す形の外の口の名前の数（名前の数 − 許す形の数）と、許す形がそれぞれ 1 つずつか。 */
const ownerFacts = (bare: string, port: (typeof STAGE_PORTS)[number]): { readonly extra: number; readonly forms: readonly number[] } => {
  const forms = allowedFormsOf(port).map((form) => [...bare.matchAll(form)].length);
  return { extra: [...bare.matchAll(nameOf(port.name))].length - forms.reduce((sum, count) => sum + count, 0), forms };
};

const asFile = (path: string, source: string): Pick<SourceFile, 'path' | 'bare'> => ({ path, bare: scanSource(source).bare });
const [CRAWL_PORTS] = STAGE_PORTS as readonly [(typeof STAGE_PORTS)[number], ...(typeof STAGE_PORTS)[number][]];

describe('stage ports entry detectors (RB-8, RB-11)', () => {
  it('detects the ports given by the worker or another value, and ignores comments and strings', () => {
    expect(outsideFiles([asFile('src/worker/audit-worker-session.ts', 'executeDiscoveryRun({ config, crawlPorts: message.ports }, observer);')], CRAWL_PORTS))
      .toEqual(['src/worker/audit-worker-session.ts']);
    expect(outsideFiles([asFile('src/worker/audit-worker-session.ts', "// crawlPorts\nconst text = 'crawlPorts';")], CRAWL_PORTS)).toEqual([]);
    expect(ownerFacts(scanSource('const ports = request.crawlPorts ?? makePorts();').bare, CRAWL_PORTS)).toEqual({ extra: 1, forms: [0, 0] });
  });
});

describe.each(STAGE_PORTS)('stage ports entry ($name)', (port) => {
  it('(a) names the ports in src/ only in the stage flow', () => {
    expect(outsideFiles(SOURCE_FILES, port)).toEqual([]);
  });

  it('(b) declares it once and reads it only with the real ports as the default', () => {
    expect(ownerFacts(sourceFileAt(SOURCE_FILES, port.owner).bare, port)).toEqual({ extra: 0, forms: [1, 1] });
  });
});
