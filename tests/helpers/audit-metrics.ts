/**
 * T44a（設計書 `doc/design/2026-10-21-beaksight-task-44-efficiency-precision-usability-design.md` 2 章）: 監査の効率・精度の測りの部品（テストの補助）。
 * 製品のコードは変えない。測るのは、製品が今書く記録（`run.json`・`audit.json`・`entry-check.json`・`discovery.json`・`read-evidence.json`）と、テストの側の
 * 包み（Browser の Proxy と、Context・page の自身のプロパティの差し替え）で外から測れる時間だけ。表は `doc/spec/real-test-environment.md` の
 * 「記録の取り方」の表と同じ項目にし、実テスト環境でも同じ項目を手で記録できるようにする。
 * - 精度: 段ごとの「判定できない」の数と割合と理由の内訳（`StageAccuracy`）。発見の画面と API の候補の、fixture の正解との差（`AnswerComparison`）。
 * - 効率: 段ごとの所要時間の内訳（`StageTimings`）と、成果物の大きさ（`ArtifactSizes`）。
 * - 落ち着きの待ち（ページの settle）だけを分ける記録の口は、製品にない。時間の内訳では「残り」（落ち着きの待ち・読み取り・Evidence の収集・判定を含む）に入る。
 */
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';
import type { EntryCheckDocument } from '../../src/control/entry-check.js';
import type { Finding, PageAuditResult, RunAuthenticationSummary, RunSummary } from '../../src/core/contracts.js';
import type { LayoutEvidence, LayoutEvidencePayload } from '../../src/core/evidence-types.js';
import type { DiscoveryDocument } from '../../src/discovery/discovery-result.js';
import type { ReadEvidenceDocument } from '../../src/discovery/read-check-evaluation.js';
import { SUBMISSION_PROBE_QUIET_WAIT_MS, hasSubmissionProbePriorityWord } from '../../src/discovery/submission-probe-contracts.js';
import type { BrowserLauncher } from '../../src/orchestration/preflight.js';
import { stressWidthFindingMessageText } from '../../src/presentation/messages.js';
import { overrideBrowser } from './browser-proxies.js';

// ---------------------------------------------------------------------------------------------------------------
// 時間（外から測る）
// ---------------------------------------------------------------------------------------------------------------

/** Browser・Context・page の操作にかかった時間（ms）と回数。 */
export interface BrowserTimings {
  readonly browserLaunches: number;
  readonly browserLaunchMs: number;
  readonly browserCloseMs: number;
  /** `browser.newContext` の回数と時間。 */
  readonly contextsCreated: number;
  readonly contextCreateMs: number;
  /** Context の準備（`newContext` の始めから、その Context の最初の page ができるまで。factory の初期化のスクリプト・route の登録を含む）。 */
  readonly contextSetupMs: number;
  /** `context.close` の回数と時間（Browser を閉じて一緒に閉じた Context は数えない）。 */
  readonly contextsClosed: number;
  readonly contextCloseMs: number;
  readonly pagesOpened: number;
  /** `page.goto`（BeakSight 自身の読み込み）の回数と時間。 */
  readonly pageLoads: number;
  readonly pageLoadMs: number;
}

/** 測る launcher（`createTimedLauncher`）。 */
export interface TimedLauncher {
  readonly launcher: BrowserLauncher;
  /** 今までの値（写し）。 */
  snapshot(): BrowserTimings;
}

const ZERO_TIMINGS: BrowserTimings = Object.freeze({
  browserLaunches: 0, browserLaunchMs: 0, browserCloseMs: 0, contextsCreated: 0, contextCreateMs: 0, contextSetupMs: 0,
  contextsClosed: 0, contextCloseMs: 0, pagesOpened: 0, pageLoads: 0, pageLoadMs: 0,
});

/** 自身のプロパティで、関数を時間を測る包みに差し替える（同じ物を返すので、`page.context()` と Guard の対応は保たれる）。 */
const replaceOwn = <T extends object>(target: T, name: string, value: unknown): void => {
  Object.defineProperty(target, name, { configurable: true, writable: true, value });
};

/**
 * `launch` を包み、Browser・Context・page の時間を数える launcher を作る（テストの側だけの包み。production は Browser を Proxy にしない）。
 * Browser は `overrideBrowser` の Proxy、Context と page は本物の物の自身のプロパティを差し替える（`browserWithoutInitScript` と同じ形）。
 */
export function createTimedLauncher(launch: () => Promise<Browser>): TimedLauncher {
  const t = { ...ZERO_TIMINGS } as { -readonly [Key in keyof BrowserTimings]: BrowserTimings[Key] };
  const timePage = (page: Page): void => {
    t.pagesOpened += 1;
    const goto = page.goto.bind(page);
    replaceOwn(page, 'goto', async (...args: Parameters<Page['goto']>) => {
      const started = performance.now();
      try {
        return await goto(...args);
      } finally {
        t.pageLoads += 1;
        t.pageLoadMs += performance.now() - started;
      }
    });
  };
  const timeContext = (context: BrowserContext, createdAt: number): void => {
    let first = true;
    const newPage = context.newPage.bind(context);
    replaceOwn(context, 'newPage', async () => {
      const page = await newPage();
      if (first) {
        first = false;
        t.contextSetupMs += performance.now() - createdAt;
      }
      timePage(page);
      return page;
    });
    const close = context.close.bind(context);
    replaceOwn(context, 'close', async (...args: Parameters<BrowserContext['close']>) => {
      const started = performance.now();
      try {
        await close(...args);
      } finally {
        t.contextsClosed += 1;
        t.contextCloseMs += performance.now() - started;
      }
    });
  };
  const launcher: BrowserLauncher = async () => {
    const started = performance.now();
    const real = await launch();
    t.browserLaunches += 1;
    t.browserLaunchMs += performance.now() - started;
    return overrideBrowser(real, {
      newContext: async (...args: Parameters<Browser['newContext']>) => {
        const createdAt = performance.now();
        const context = await real.newContext(...args);
        t.contextsCreated += 1;
        t.contextCreateMs += performance.now() - createdAt;
        timeContext(context, createdAt);
        return context;
      },
      close: async (...args: Parameters<Browser['close']>) => {
        const closing = performance.now();
        try {
          await real.close(...args);
        } finally {
          t.browserCloseMs += performance.now() - closing;
        }
      },
    });
  };
  return { launcher, snapshot: () => ({ ...t }) };
}

/** 2 つの時間の記録の差（`after - before`。同じ launcher を続けて使う段の分け方）。 */
export const timingsBetween = (before: BrowserTimings, after: BrowserTimings): BrowserTimings =>
  Object.fromEntries(Object.keys(ZERO_TIMINGS).map((key) => {
    const name = key as keyof BrowserTimings;
    return [name, after[name] - before[name]];
  })) as unknown as BrowserTimings;

/** 1 つの段の時間の内訳（ms。測れない項目は `null`）。 */
export interface StageTimings {
  readonly stage: string;
  readonly totalMs: number;
  /** 読み込みの間隔の待ち（`run.json` の `load.pacingWaitMs`、または注入した pacer の `totalWaitMs`）。 */
  readonly pacingWaitMs: number | null;
  /** 読み込みの開始の回数（同じ記録の `navigationCount`）。 */
  readonly navigationCount: number | null;
  /** 承認したサービスの Origin への要求の 1 分あたりの上限の待ち（`authentication.serviceRequestPacingWaitMs`）。 */
  readonly servicePacingWaitMs: number | null;
  /** probe の押下の待ち（押した数 × `SUBMISSION_PROBE_QUIET_WAIT_MS`。推定。発見だけ）。 */
  readonly probeWaitMs: number | null;
  readonly probePresses: number | null;
  /** 仕上げ（`onFinalizing` から終わりまで。Browser を閉じる処理を含む段がある）。 */
  readonly finalizeMs: number | null;
  readonly browser: BrowserTimings;
}

/** 発見の成果物から、押した数を数える（押さなかった理由の結果は数えない）。 */
const NOT_PRESSED_REASONS: ReadonlySet<string> = new Set(['TARGET_NOT_FOUND', 'PRESS_LIMIT_REACHED', 'EXTERNAL_SCHEME', 'CONTEXT_CLOSED_BY_GUARD']);

export const probePressesOf = (document: DiscoveryDocument): number => document.pages.reduce((sum, page) => sum + (page.state === 'READ'
  ? page.record.candidates.filter((candidate) => candidate.submissionProbe !== undefined
    && !NOT_PRESSED_REASONS.has(String(candidate.submissionProbe.reason))).length
  : 0), 0);

/** probe の押下の待ちの推定（押した数 × 製品の既定の静まりの待ち）。 */
export const probeWaitEstimateMs = (presses: number, quietWaitMs: number = SUBMISSION_PROBE_QUIET_WAIT_MS): number => presses * quietWaitMs;

/** 段の時間の内訳の「残り」（合計から、測れた項目を引いた時間。落ち着きの待ち・読み取り・Evidence の収集・判定・IPC を含む）。 */
export const remainderMsOf = (timings: StageTimings): number => timings.totalMs
  - (timings.pacingWaitMs ?? 0) - (timings.servicePacingWaitMs ?? 0) - (timings.probeWaitMs ?? 0) - (timings.finalizeMs ?? 0)
  - timings.browser.browserLaunchMs - timings.browser.contextSetupMs - timings.browser.contextCloseMs - timings.browser.pageLoadMs;

// ---------------------------------------------------------------------------------------------------------------
// 精度（判定できない数と理由）
// ---------------------------------------------------------------------------------------------------------------

/** 1 つの段の「判定できない」の数と理由ごとの内訳。 */
export interface StageAccuracy {
  readonly stage: string;
  /** 数えるもの（ジョブ・ページ・画面・候補・定義など）。 */
  readonly unit: string;
  readonly total: number;
  readonly undetermined: number;
  /** 理由（コード）ごとの数（1 つのものが複数の理由を持つと、それぞれに数える）。 */
  readonly reasons: Readonly<Record<string, number>>;
  /** 判定できたものの内訳（結果ごとの数。参考）。 */
  readonly outcomes: Readonly<Record<string, number>>;
}

const countBy = (values: readonly string[]): Readonly<Record<string, number>> => {
  const counts: Record<string, number> = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
};

/** 入口の確かめ（ジョブ 1 件）。`READ` 以外の終わり方を判定できないと数える。 */
export const entryCheckAccuracyOf = (document: EntryCheckDocument | null): StageAccuracy => ({
  stage: '入口の確かめ',
  unit: 'ジョブ',
  total: 1,
  undetermined: document?.endReason === 'READ' ? 0 : 1,
  reasons: document === null ? { NO_ARTIFACT: 1 } : (document.endReason === 'READ' ? {} : { [document.endReason]: 1 }),
  outcomes: document === null ? {} : countBy([
    `endReason=${document.endReason}`, `runStatus=${document.runStatus}`, `loginPage=${String(document.facts?.loginPage ?? null)}`,
    `proposal=${document.proposal === null ? 'なし' : 'あり'}`,
  ]),
});

const UNDETERMINED_PAGE_STATUSES: ReadonlySet<string> = new Set(['PARTIAL', 'FAILED', 'SKIPPED']);
const UNDETERMINED_INTERACTION_STATUSES: ReadonlySet<string> = new Set(['NOT_VERIFIABLE', 'EXECUTION_FAILED']);

/** 読み取りの監査のページ（`PARTIAL`・`FAILED`・`SKIPPED` を判定できないと数える。理由はページの未完了の理由のコード）。 */
export const auditPageAccuracyOf = (pages: readonly PageAuditResult[]): StageAccuracy => {
  const undetermined = pages.filter((page) => UNDETERMINED_PAGE_STATUSES.has(page.status));
  return {
    stage: '読み取りの監査（ページ）',
    unit: 'ページ',
    total: pages.length,
    undetermined: undetermined.length,
    reasons: countBy(undetermined.flatMap((page) => {
      const codes = [...new Set(page.incompleteReasons.map(({ code }) => code))];
      return codes.length === 0 ? [`(${page.status}・理由なし)`] : codes;
    })),
    outcomes: countBy(pages.map((page) => page.status)),
  };
};

/** 読み取りの監査の、ビューポート（Desktop・Mobile）ごとの状態（参考。ページの状態の内訳）。 */
export const auditViewportAccuracyOf = (pages: readonly PageAuditResult[]): StageAccuracy => {
  const viewports = pages.flatMap((page) => Object.entries(page.viewports).map(([profile, result]) => ({ profile, result })));
  const undetermined = viewports.filter(({ result }) => result.status !== 'AUDITED');
  return {
    stage: '読み取りの監査（ビューポート）',
    unit: 'ページ × ビューポート',
    total: viewports.length,
    undetermined: undetermined.length,
    reasons: countBy(undetermined.flatMap(({ result }) => {
      const codes = [...new Set(result.incompleteReasons.map(({ code }) => code))];
      return codes.length === 0 ? [`(${result.status}・理由なし)`] : codes;
    })),
    outcomes: countBy(viewports.map(({ profile, result }) => `${profile}=${result.status}`)),
  };
};

/** 読み取りの監査の Interaction（`NOT_VERIFIABLE`・`EXECUTION_FAILED` を判定できないと数える。理由は Interaction の理由のコード）。 */
export const auditInteractionAccuracyOf = (pages: readonly PageAuditResult[]): StageAccuracy => {
  const interactions = pages.flatMap((page) => page.evidence.flatMap((evidence) => (evidence.type === 'interaction'
    ? [evidence.payload as { readonly status: string; readonly reason: string }]
    : [])));
  const undetermined = interactions.filter(({ status }) => UNDETERMINED_INTERACTION_STATUSES.has(status));
  return {
    stage: '読み取りの監査（Interaction）',
    unit: 'Interaction の候補',
    total: interactions.length,
    undetermined: undetermined.length,
    reasons: countBy(undetermined.map(({ status, reason }) => `${status}/${reason}`)),
    outcomes: countBy(interactions.map(({ status }) => status)),
  };
};

/** 発見の画面（読まなかった画面と、不完全の理由のある読んだ画面を判定できないと数える。読まないパスの除外 `EXCLUDED` は数えるが判定できないにしない）。 */
export const discoveryScreenAccuracyOf = (document: DiscoveryDocument): StageAccuracy => {
  const reasons: string[] = [];
  let undetermined = 0;
  for (const page of document.pages) {
    if (page.state === 'NOT_READ') {
      if (page.reason !== 'EXCLUDED') {
        undetermined += 1;
        reasons.push(`NOT_READ/${page.reason}`);
      }
    } else if (page.record.incompleteReasons.length > 0) {
      undetermined += 1;
      reasons.push(...new Set(page.record.incompleteReasons.map((code) => `READ/${code}`)));
    }
  }
  return {
    stage: '発見（画面）',
    unit: '画面',
    total: document.pages.length,
    undetermined,
    reasons: countBy(reasons),
    outcomes: countBy(document.pages.map((page) => (page.state === 'READ' ? 'READ' : `NOT_READ/${page.reason}`))),
  };
};

/** 発見の probe（`NOT_OBSERVED`・`NO_REQUEST` を判定できないと数える。`doc/spec/real-test-environment.md` の表の定義）。 */
export const discoveryProbeAccuracyOf = (document: DiscoveryDocument): StageAccuracy => {
  const probes = document.pages.flatMap((page) => (page.state === 'READ'
    ? page.record.candidates.flatMap((candidate) => (candidate.submissionProbe === undefined ? [] : [candidate.submissionProbe]))
    : []));
  const undetermined = probes.filter(({ result }) => result === 'NOT_OBSERVED' || result === 'NO_REQUEST');
  return {
    stage: '発見の probe',
    unit: 'probe の結果のある候補',
    total: probes.length,
    undetermined: undetermined.length,
    reasons: countBy(undetermined.map(({ result, reason }) => `${result}/${String(reason)}`)),
    outcomes: countBy(probes.map(({ result, reason }) => (reason === null ? result : `${result}/${reason}`))),
  };
};

/** T44c: 押す数の上限で押せなかった候補のうち、送信ボタンの語に登録・更新の語があるものの印（`probeOutcomesOf`）。 */
export const PRIORITY_WORD_SUFFIX = '（登録・更新の語）';

/**
 * T44c: 発見の probe の結果（`<結果>/<理由>`。`PRESS_LIMIT_REACHED` は、送信ボタンの語に登録・更新の語があれば `PRIORITY_WORD_SUFFIX` を足して分ける）。
 * `pathFilter` に当たる画面だけ（省略はすべて）。
 */
export const probeOutcomesOf = (document: DiscoveryDocument, pathFilter: (path: string) => boolean = () => true): readonly string[] =>
  document.pages.flatMap((page) => (page.state === 'READ' && pathFilter(pathOf(page.url))
    ? page.record.candidates.flatMap((candidate) => {
      const probe = candidate.submissionProbe;
      if (probe === undefined) return [];
      const outcome = probe.reason === null ? probe.result : `${probe.result}/${probe.reason}`;
      return [probe.reason === 'PRESS_LIMIT_REACHED' && hasSubmissionProbePriorityWord(candidate.submitterWords) ? `${outcome}${PRIORITY_WORD_SUFFIX}` : outcome];
    })
    : []));

/** T44c: 読み取りの監査の、ページかビューポートに未完了の理由 `code` のあるページの path。 */
export const auditPagesWithReasonOf = (pages: readonly PageAuditResult[], code: string): readonly string[] => pages.filter((page) =>
  page.incompleteReasons.some((reason) => reason.code === code)
  || Object.values(page.viewports).some((result) => result.incompleteReasons.some((reason) => reason.code === code))).map((page) => pathOf(page.pageUrl));

/** T44c: 読み取りの監査の safety の Evidence の、止めた要求の理由ごとの数（ページの記録に残った分だけ）。 */
export const blockedRequestReasonsOf = (pages: readonly PageAuditResult[]): Readonly<Record<string, number>> => countBy(pages.flatMap((page) =>
  page.evidence.flatMap((evidence) => (evidence.type === 'safety'
    ? (evidence.payload as { readonly blockedRequests: readonly { readonly reason: string }[] }).blockedRequests.map(({ reason }) => reason)
    : []))));

/** 発見の候補の分類（参考。分類と理由のコードごと）。 */
export const discoveryCandidateClassesOf = (document: DiscoveryDocument): Readonly<Record<string, number>> => countBy(document.pages.flatMap((page) =>
  (page.state === 'READ' ? page.record.candidates.map((candidate) => `${candidate.kind}/${candidate.classification}/${candidate.reasonCode}`) : [])));

/** READ の確かめ（`UNDETERMINED` と、確かめなかった定義を判定できないと数える）。 */
export const readCheckAccuracyOf = (document: ReadEvidenceDocument): StageAccuracy => {
  const results = document.checks.map((check) => (check.state === 'EXECUTED' ? `${check.result}/${check.detail}` : `NOT_EXECUTED/${check.reason}`));
  const undetermined = results.filter((result) => result.startsWith('UNDETERMINED/') || result.startsWith('NOT_EXECUTED/'));
  return {
    stage: 'READ の確かめ',
    unit: '定義',
    total: document.checks.length,
    undetermined: undetermined.length,
    reasons: countBy(undetermined),
    outcomes: countBy(results),
  };
};

// ---------------------------------------------------------------------------------------------------------------
// 正解との差
// ---------------------------------------------------------------------------------------------------------------

/** 見つけたものと正解の差。 */
export interface AnswerComparison {
  readonly subject: string;
  readonly expected: number;
  readonly found: number;
  readonly matched: number;
  readonly missing: readonly string[];
  readonly extra: readonly string[];
}

/** 2 つの一覧（重なりを許す）の差。 */
export const compareWithAnswers = (subject: string, expected: readonly string[], found: readonly string[]): AnswerComparison => {
  const remaining = [...found];
  const missing: string[] = [];
  for (const item of expected) {
    const index = remaining.indexOf(item);
    if (index === -1) {
      missing.push(item);
    } else {
      remaining.splice(index, 1);
    }
  }
  return { subject, expected: expected.length, found: found.length, matched: expected.length - missing.length, missing, extra: remaining };
};

/** URL の path（読めなければそのまま）。 */
export const pathOf = (url: string): string => {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
};

/** 発見で読んだ画面の path。 */
export const discoveryReadScreensOf = (document: DiscoveryDocument): readonly string[] =>
  document.pages.flatMap((page) => (page.state === 'READ' ? [pathOf(page.url)] : []));

/** 発見の API の候補（`<path> <結果>`。`API_CREATE`・`API_UPDATE` だけ）。 */
export const discoveryApiCandidatesOf = (document: DiscoveryDocument): readonly string[] => document.pages.flatMap((page) => (page.state === 'READ'
  ? page.record.candidates.flatMap((candidate) => {
    const result = candidate.submissionProbe?.result;
    return result === 'API_CREATE' || result === 'API_UPDATE' ? [`${pathOf(page.url)} ${result}`] : [];
  })
  : []));

/** 監査したページの path（`SKIPPED` を除く）。 */
export const auditedPagePathsOf = (pages: readonly PageAuditResult[]): readonly string[] =>
  pages.filter((page) => page.status !== 'SKIPPED').map((page) => pathOf(page.pageUrl));

/** Finding の `<path> <ruleId>`（同じ組は 1 つにまとめる）。 */
export const findingRulesOf = (findings: readonly Finding[], pages: readonly PageAuditResult[]): readonly string[] => {
  const pathById = new Map(pages.map((page) => [page.pageId, pathOf(page.pageUrl)]));
  return [...new Set(findings.map((finding) => `${(finding.pageId === null ? undefined : pathById.get(finding.pageId)) ?? '-'} ${finding.ruleId}`))];
};

// ---------------------------------------------------------------------------------------------------------------
// 成果物の大きさ
// ---------------------------------------------------------------------------------------------------------------

/** 成果物の大きさ。 */
export interface ArtifactSizes {
  readonly totalBytes: number;
  readonly fileCount: number;
  /** 大きい順のファイル（相対のパスとバイト数）。 */
  readonly largest: readonly { readonly path: string; readonly bytes: number }[];
}

/** ディレクトリの下のファイルの大きさ（リンクはたどらない）。 */
export const artifactSizesOf = (directory: string, largestCount = 5): ArtifactSizes => {
  const files: { path: string; bytes: number }[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile()) {
        files.push({ path: relative(directory, path).split('\\').join('/'), bytes: statSync(path).size });
      }
    }
  };
  visit(directory);
  const sorted = [...files].sort((left, right) => right.bytes - left.bytes);
  return { totalBytes: files.reduce((sum, file) => sum + file.bytes, 0), fileCount: files.length, largest: sorted.slice(0, largestCount) };
};

// ---------------------------------------------------------------------------------------------------------------
// 記録の写し（サイトへの負荷）
// ---------------------------------------------------------------------------------------------------------------

/** `run.json` の負荷と監査の段の数のうち、表に写すもの。 */
export const runLoadRowsOf = (run: RunSummary): readonly (readonly [string, string])[] => [
  ['読み込みの開始の回数（`load.navigationCount`）', String(run.load.navigationCount)],
  ['読み込みの間隔の待ち（`load.pacingWaitMs`）', formatMs(run.load.pacingWaitMs)],
  ['許可 Origin への要求（数・1 分あたりの最大）', `${run.load.requests.allowedOrigins.count}・${run.load.requests.allowedOrigins.peakPerMinute}`],
  ['許可 Origin の外への要求（数・送らなかった数）', `${run.load.requests.otherOrigins.count}・${run.load.requests.withheldOtherOrigins}`],
  ['承認したサービスの Origin への要求（数・1 分あたりの最大）', run.load.approvedServiceOrigins === undefined
    ? '—' : `${run.load.approvedServiceOrigins.count}・${run.load.approvedServiceOrigins.peakPerMinute}`],
  ['安全: 遮断した要求・不変条件の違反', `${run.safety.blockedActions.requests}・${run.safety.invariantViolationCount}`],
  ['送信の扱い・通した読み取りでない要求', run.safety.auditSend === undefined
    ? '—' : `${run.safety.auditSend.policy}・${run.safety.auditSend.passedRequests}`],
  ...authenticationRowsOf(run.authentication),
];

/** 監査の段の数（`authentication`）のうち、表に写すもの。 */
export const authenticationRowsOf = (summary: Partial<RunAuthenticationSummary> | undefined): readonly (readonly [string, string])[] =>
  summary === undefined || summary.registeredReadRequestsAllowed === undefined ? [] : [
    ['監査の段: 通した登録の読み取り・止めた token の送信・止めたほかの読み取りでない要求',
      `${summary.registeredReadRequestsAllowed}・${String(summary.tokenRefreshBlocked)}・${String(summary.otherNonReadBlocked)}`],
    ['監査の段: サービスの 401・上限に届いた', `${String(summary.serviceUnauthorizedResponses)}・${String(summary.serviceRequestLimitReached)}`],
    ['監査の段: サービスの上限の待ち（回・時間）', `${String(summary.serviceRequestPacingWaits ?? 0)}・${formatMs(summary.serviceRequestPacingWaitMs ?? 0)}`],
  ];

// ---------------------------------------------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------------------------------------------

/** 表の 1 つの枠の文字（`|` と改行を逃がす）。 */
const cell = (value: string | number): string => String(value).split('|').join('\\|').split('\n').join(' ');

/** Markdown の表。 */
export const markdownTable = (headers: readonly string[], rows: readonly (readonly (string | number)[])[]): string => [
  `| ${headers.map(cell).join(' | ')} |`,
  `| ${headers.map(() => '---').join(' | ')} |`,
  ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`),
].join('\n');

/** ms を秒の表示に（小数 1 桁）。 */
export const formatMs = (ms: number): string => `${(ms / 1_000).toFixed(1)} 秒`;

/** バイトを KiB・MiB の表示に。 */
export const formatBytes = (bytes: number): string => (bytes >= 1024 * 1024
  ? `${(bytes / (1024 * 1024)).toFixed(2)} MiB`
  : `${(bytes / 1024).toFixed(1)} KiB`);

const formatRate = (part: number, total: number): string => (total === 0 ? '—' : `${((part / total) * 100).toFixed(1)}%`);
/** 数の内訳の表示（`名前 数` を `、` でつなぐ。空は `—`）。 */
export const formatCounts = (counts: Readonly<Record<string, number>>): string => {
  const entries = Object.entries(counts);
  return entries.length === 0 ? '—' : entries.map(([name, count]) => `${name} ${count}`).join('、');
};

/** 精度の表（`doc/spec/real-test-environment.md` の「段ごとの『判定できない』の数と理由」と同じ列）。 */
export const accuracyTable = (rows: readonly StageAccuracy[]): string => markdownTable(
  ['段', '数えるもの', '全体の数', '判定できない数', '割合', '理由ごとの内訳', '判定の内訳（参考）'],
  rows.map((row) => [row.stage, row.unit, row.total, row.undetermined, formatRate(row.undetermined, row.total), formatCounts(row.reasons), formatCounts(row.outcomes)]),
);

/** 正解との差の表。 */
export const answerTable = (rows: readonly AnswerComparison[]): string => markdownTable(
  ['対象', '正解の数', '見つけた数', '一致', '見逃し', '正解にないもの'],
  rows.map((row) => [row.subject, row.expected, row.found, row.matched, row.missing.join('、') || '—', row.extra.join('、') || '—']),
);

/** 時間の表（段ごとの 1 行）。 */
export const timingTable = (rows: readonly StageTimings[]): string => markdownTable(
  ['段', '合計', '読み込みの間隔の待ち（回数）', 'サービスの上限の待ち', 'probe の待ち（押した数。推定）', 'Context（作成の数・準備・閉じる）',
    'BeakSight の読み込み（goto の数・時間）', 'Browser の起動', '仕上げ', '残り（落ち着きの待ち・読み取り・収集・判定）'],
  rows.map((row) => [
    row.stage,
    formatMs(row.totalMs),
    row.pacingWaitMs === null ? '—' : `${formatMs(row.pacingWaitMs)}（${String(row.navigationCount ?? '—')}）`,
    row.servicePacingWaitMs === null ? '—' : formatMs(row.servicePacingWaitMs),
    row.probeWaitMs === null ? '—' : `${formatMs(row.probeWaitMs)}（${String(row.probePresses ?? '—')}）`,
    `${row.browser.contextsCreated}・${formatMs(row.browser.contextSetupMs)}・${formatMs(row.browser.contextCloseMs)}（${row.browser.contextsClosed}）`,
    `${row.browser.pageLoads}・${formatMs(row.browser.pageLoadMs)}`,
    formatMs(row.browser.browserLaunchMs),
    row.finalizeMs === null ? '—' : formatMs(row.finalizeMs),
    formatMs(remainderMsOf(row)),
  ]),
);

/** 成果物の大きさの表。 */
export const sizeTable = (rows: readonly (readonly [string, ArtifactSizes])[]): string => markdownTable(
  ['段', '合計', 'ファイルの数', '大きいファイル'],
  rows.map(([stage, sizes]) => [stage, formatBytes(sizes.totalBytes), sizes.fileCount,
    sizes.largest.map(({ path, bytes }) => `${path} ${formatBytes(bytes)}`).join('、') || '—']),
);

// ---------------------------------------------------------------------------------------------------------------
// T44h: 幅の走査のレイアウトの事実（P1-5。幅の走査が SPA の読み取りを待たないことの影響を測る）
// ---------------------------------------------------------------------------------------------------------------

/** レイアウトの事実の要約（Rule の判定の入力の数。値は持たない）。 */
export interface LayoutFactSummary {
  readonly documentScrollHeight: number;
  readonly horizontalOverflowPx: number;
  readonly boxesOutsideViewport: number;
  readonly clippedText: number;
  readonly elementOverlaps: number;
  readonly fixedHeadingOverlaps: number;
  readonly zeroSizeInteractive: number;
}

/** レイアウトの事実を要約する（`LayoutEvidence`）。 */
export const layoutFactSummaryOf = (layout: LayoutEvidence): LayoutFactSummary => ({
  documentScrollHeight: layout.document.documentElementScrollHeight,
  horizontalOverflowPx: layout.document.horizontalOverflowPx,
  boxesOutsideViewport: layout.boxesOutsideViewport.length,
  clippedText: layout.clippedText.length,
  elementOverlaps: layout.elementOverlaps.length,
  fixedHeadingOverlaps: layout.fixedHeadingOverlaps.length,
  zeroSizeInteractive: layout.zeroSizeInteractive.length,
});

/** 要約の表示（高さ・横のはみ出し・はみ出した箱・見切れ・重なり・固定の見出しの重なり・大きさ 0 の操作要素）。 */
export const formatLayoutFacts = (facts: LayoutFactSummary | null): string => (facts === null
  ? '—'
  : `高さ ${facts.documentScrollHeight}・はみ出し ${facts.horizontalOverflowPx}px・外の箱 ${facts.boxesOutsideViewport}・見切れ ${facts.clippedText}`
    + `・重なり ${facts.elementOverlaps}・固定の重なり ${facts.fixedHeadingOverlaps}・大きさ 0 ${facts.zeroSizeInteractive}`);

/** 監査のページの、ビューポートごとの最初の読み込みと幅の走査のレイアウトの事実（`path` を渡すと、そのページだけ）。 */
export const stressLayoutRowsOf = (pages: readonly PageAuditResult[], path?: string): readonly (readonly string[])[] =>
  pages.filter((page) => path === undefined || pathOf(page.pageUrl) === path).flatMap((page) =>
    page.evidence.flatMap((evidence) => {
      if (evidence.type !== 'layout') {
        return [];
      }
      const payload = evidence.payload as LayoutEvidencePayload;
      const primary = payload.primary.layout;
      const rows: string[][] = [[pathOf(page.pageUrl), `最初の読み込み（幅 ${String(primary?.document.viewportWidth ?? '—')}）`, payload.primary.status,
        formatLayoutFacts(primary === null ? null : layoutFactSummaryOf(primary))]];
      for (const result of payload.stressSweep ?? []) {
        rows.push([pathOf(page.pageUrl), `幅の走査（幅 ${String(result.width)}）`, result.status,
          formatLayoutFacts(result.layout === null ? null : layoutFactSummaryOf(result.layout))]);
      }
      return rows;
    }));

/**
 * 幅の走査の結果から作った Finding の文言の頭の、幅の表示の前と後（BN-c の fix の発見事項 5: 文の形は `stressWidthFindingMessageText` の 1 か所から作る。
 * 幅の表示の置き場所を、文に現れない字で印にして分ける）。
 */
const STRESS_WIDTH_PLACEHOLDER = '\u0000';
const [STRESS_FINDING_PREFIX = '', STRESS_FINDING_SUFFIX = ''] = stressWidthFindingMessageText(STRESS_WIDTH_PLACEHOLDER, '').split(STRESS_WIDTH_PLACEHOLDER);

/** 幅の走査の結果から作った Finding の文言なら、その幅の表示（例: `320 px`）。そうでなければ `undefined`。 */
const stressWidthTextOf = (message: string): string | undefined => {
  if (!message.startsWith(STRESS_FINDING_PREFIX)) {
    return undefined;
  }
  const end = message.indexOf(STRESS_FINDING_SUFFIX, STRESS_FINDING_PREFIX.length);
  return end < 0 ? undefined : message.slice(STRESS_FINDING_PREFIX.length, end);
};

/** Finding の `<path> <ruleId> <幅（幅の走査の結果から作ったものだけ。最初の読み込みは「最初の読み込み」）>`。 */
export const layoutFindingSourcesOf = (findings: readonly Finding[], pages: readonly PageAuditResult[], ruleIds: readonly string[]): readonly string[] => {
  const pathById = new Map(pages.map((page) => [page.pageId, pathOf(page.pageUrl)]));
  return findings.filter((finding) => ruleIds.includes(finding.ruleId)).map((finding) => {
    const width = stressWidthTextOf(finding.message);
    return `${(finding.pageId === null ? undefined : pathById.get(finding.pageId)) ?? '-'} ${finding.ruleId} ${width === undefined ? `最初の読み込み（${String(finding.viewport)}）` : `幅 ${width}`}`;
  });
};
