/**
 * AUD-6b（整理の文書 `doc/design/2026-11-09-beaksight-audit-precision-triage.md` の AUD-6b）: リンクごとの確かめの状態の、唯一の作り方（純粋な関数）。
 * 呼ぶのは表示用モデル（`view-model.ts`）だけ。ChatGPT 用バンドルの `links.json` は、表示用モデルの値を写すだけ。
 * - 状態（設計者の判断 2026-11-10。「表示で確認」は使わない）:
 *   - `NAVIGATED`（移って確認）: 行き先のページを読んだ（どれかのビューポートで移動した）。状態の番号・最後の URL は行き先のページの記録、リダイレクトの鎖は
 *     行き先のページの main frame の移動の要求（network の Evidence）から作る。
 *   - `STATIC_CANDIDATE`（静的な候補）: 外部のリンク・http 以外の scheme・受け入れない href（開いて確かめない）。
 *   - `UNVERIFIED`（未検証）: サイトの中のリンクで、行き先を読んでいない。理由は今ある事実（行き先のページの記録・巡回の上限の印）から決め、次に要る手順を
 *     やさしい文で付ける。
 * - 今ある事実だけで作る（新しく移らない。リンクをたどる網羅は COV-4）。単位は、リンク元のページと href の組（同じ組は 1 つ。最初のもの）。
 * - 内部リンクの行き先の照らし方は、ページをまたぐ Rule と同じ（行き先の URL と、ページの `pageUrl` が等しい）。
 */
import {
  VIEWPORT_PROFILES,
  type CrawlLimitState,
  type PageAuditResult,
  type PageId,
  type RunSummary,
  type ViewportProfile,
} from '../core/contracts.js';
import type { LinkAdmissionEvidence, NavigationOutcomeKind, NetworkEvidence, NetworkRequestEvidence } from '../core/evidence-types.js';
import { isHttpErrorOrNonStandardStatus } from '../core/http-status.js';
import { LINK_CHECK_NEXT_STEP_TEXT } from '../presentation/messages.js';
import { earlierAttemptEvidenceIds } from './artifact-writer.js';

/** 確かめの状態の閉じた一覧（移って確認・静的な候補・未検証）。 */
export const LINK_CHECK_STATUSES = Object.freeze(['NAVIGATED', 'STATIC_CANDIDATE', 'UNVERIFIED'] as const);
export type LinkCheckStatus = (typeof LINK_CHECK_STATUSES)[number];

/** 未検証の理由の閉じた一覧（行き先のページを読んでいない・行き先のページの記録はあるが、どのビューポートでも移動していない）。 */
export const LINK_UNVERIFIED_REASONS = Object.freeze(['TARGET_NOT_AUDITED', 'TARGET_NOT_NAVIGATED'] as const);
export type LinkUnverifiedReason = (typeof LINK_UNVERIFIED_REASONS)[number];

/** 行き先の遮断・権限の状態の閉じた一覧（開けた・BeakSight が止めた・権限がないという応答）。 */
export const LINK_ACCESS_STATES = Object.freeze(['OPEN', 'BLOCKED', 'NO_PERMISSION'] as const);
export type LinkAccessState = (typeof LINK_ACCESS_STATES)[number];

/** 巡回の上限の印の名前（`CrawlLimitState` の欄から）。 */
const CRAWL_LIMIT_NAMES: Readonly<Record<keyof CrawlLimitState, string>> = Object.freeze({
  maxPagesReached: 'maxPages',
  maxDepthReached: 'maxDepth',
  maxRuntimeReached: 'maxRuntime',
});

/** 権限がないという応答の状態の番号。 */
const NO_PERMISSION_STATUSES: ReadonlySet<number> = new Set([401, 403]);
/** BeakSight が止めた移動の結果。 */
const BLOCKED_OUTCOMES: ReadonlySet<NavigationOutcomeKind> = new Set(['BLOCKED_EXTERNAL_REDIRECT']);

/** リダイレクトの鎖の 1 つ（応答の記録がなければ状態の番号は `null`）。 */
export interface LinkRedirectStepView {
  readonly url: string;
  readonly status: number | null;
}

/** 行き先のページの、ビューポートごとの移動の結果。 */
export interface LinkNavigationView {
  readonly viewport: ViewportProfile;
  readonly navigationOutcome: NavigationOutcomeKind;
  readonly httpStatus: number | null;
  readonly finalUrl: string | null;
  /** 行き先のページの main frame の移動の要求の鎖（記録がなければ空）。 */
  readonly redirectChain: readonly LinkRedirectStepView[];
}

/** 未検証の理由と、次に要る手順。 */
export interface LinkUnverifiedView {
  readonly reason: LinkUnverifiedReason;
  /** Run が届いた巡回の上限（`maxPages`・`maxDepth`・`maxRuntime`）。 */
  readonly crawlLimitsReached: readonly string[];
  /** 行き先のページの記録の理由のコード（行き先のページの記録がなければ空）。 */
  readonly targetIncompleteReasons: readonly string[];
  readonly nextStep: string;
}

/** リンク 1 つの確かめの状態。 */
export interface LinkCheckView {
  readonly sourcePageId: PageId;
  readonly href: string;
  /** 正規化した URL（正規化できない href は `null`）。 */
  readonly resolvedUrl: string | null;
  readonly admission: LinkAdmissionEvidence['kind'];
  readonly status: LinkCheckStatus;
  readonly unverified: LinkUnverifiedView | null;
  /** 移って確認したリンクの、ビューポートごとの結果（移動したビューポートだけ。ほかの状態は空）。 */
  readonly navigation: readonly LinkNavigationView[];
  /** 移って確認したリンクの遮断・権限の状態（ほかの状態は `null`）。 */
  readonly access: LinkAccessState | null;
}

/** リンクの確かめの数（未検証は、リンク切れ・検証済みと別の欄）と、リンクごとの状態。 */
export interface LinkChecksView {
  readonly counts: {
    readonly total: number;
    readonly navigated: number;
    /** 移って確認したリンクのうち、行き先が誤りの応答か、移動に失敗したもの。 */
    readonly navigatedBroken: number;
    readonly staticCandidate: number;
    readonly unverified: number;
  };
  readonly links: readonly LinkCheckView[];
}

const isMainFrameNavigation = (request: NetworkRequestEvidence): boolean => request.isNavigationRequest && request.isMainFrame === true;

/** 行き先のページの main frame の移動の鎖（ページの URL から始まる鎖を優先し、なければ最初の鎖。いちばん長く観測したもの）。 */
function redirectChainOf(network: NetworkEvidence | null, pageUrl: string): readonly LinkRedirectStepView[] {
  if (network === null) {
    return [];
  }
  const requestsById = new Map(network.requests.map((request) => [request.requestId, request]));
  const statusById = new Map<string, number>();
  for (const response of network.responses) {
    if (!statusById.has(response.requestId)) {
      statusById.set(response.requestId, response.status);
    }
  }
  const chains = new Map<string, readonly NetworkRequestEvidence[]>();
  for (const request of network.requests) {
    if (!isMainFrameNavigation(request)) {
      continue;
    }
    const ids = [...request.redirectChainRequestIds, request.requestId];
    const chain = ids.map((id) => requestsById.get(id)).filter((entry): entry is NetworkRequestEvidence => entry !== undefined);
    const root = ids[0] ?? request.requestId;
    const known = chains.get(root);
    if (known === undefined || chain.length > known.length) {
      chains.set(root, chain);
    }
  }
  const all = [...chains.values()];
  const chosen = all.find((chain) => chain[0]?.url === pageUrl) ?? all[0] ?? [];
  return chosen.map((request) => ({ url: request.url, status: statusById.get(request.requestId) ?? null }));
}

/** 行き先のページの、移動したビューポートごとの結果。 */
function navigationOf(run: Pick<RunSummary, 'retries'>, target: PageAuditResult): readonly LinkNavigationView[] {
  const earlier = earlierAttemptEvidenceIds(run, target);
  return VIEWPORT_PROFILES.flatMap((viewport): LinkNavigationView[] => {
    const state = target.viewports[viewport];
    if (state.navigationOutcome === null) {
      return [];
    }
    const network = target.evidence.find((record) => record.type === 'network' && record.viewport === viewport && !earlier.has(record.evidenceId));
    return [{
      viewport,
      navigationOutcome: state.navigationOutcome,
      httpStatus: state.httpStatus,
      finalUrl: state.finalUrl,
      redirectChain: redirectChainOf(network?.type === 'network' ? network.payload : null, target.pageUrl),
    }];
  });
}

const accessOf = (navigation: readonly LinkNavigationView[]): LinkAccessState => {
  if (navigation.some(({ navigationOutcome }) => BLOCKED_OUTCOMES.has(navigationOutcome))) {
    return 'BLOCKED';
  }
  return navigation.some(({ httpStatus }) => httpStatus !== null && NO_PERMISSION_STATUSES.has(httpStatus)) ? 'NO_PERMISSION' : 'OPEN';
};

const isBroken = (navigation: readonly LinkNavigationView[]): boolean =>
  navigation.some(({ navigationOutcome, httpStatus }) => navigationOutcome !== 'OK' || isHttpErrorOrNonStandardStatus(httpStatus));

/** 行き先のページの、リンクの確かめに使う事実（MEM-4。ページそのものは持たない）。 */
interface LinkTargetFacts {
  readonly navigation: readonly LinkNavigationView[];
  readonly incompleteReasonCodes: readonly string[];
}

/** 行き先を照らす前のリンク（内部のリンクは、行き先の URL を持つ）。 */
interface LinkDraft {
  readonly base: Pick<LinkCheckView, 'sourcePageId' | 'href' | 'resolvedUrl' | 'admission'>;
  readonly targetUrl: string | null;
}

/**
 * MEM-4（DEF-266）: リンクごとの確かめの状態を、ページを 1 つずつ足して作るもの（ページを持たない）。持つのは、リンクと、URL ごとの行き先のページの事実
 * （同じ URL のページが 2 つある不正な Run では、先にあるもの）だけ。行き先は、全部のページを足した後に照らす（後のページへのリンクがあるため）。
 */
export function createLinkChecksCollector(run: Pick<RunSummary, 'retries' | 'crawlLimits'>): {
  /** ページを足す（URL の発見の順に）。 */
  readonly addPage: (page: PageAuditResult) => void;
  /** リンクごとの確かめの状態（作るのは、ここだけ。最終の試行の link の Evidence の、ページの順・リンクの順）。 */
  readonly result: () => LinkChecksView;
} {
  const targets = new Map<string, LinkTargetFacts>();
  const seen = new Set<string>();
  const drafts: LinkDraft[] = [];
  return {
    addPage: (page) => {
      if (!targets.has(page.pageUrl)) {
        targets.set(page.pageUrl, { navigation: navigationOf(run, page), incompleteReasonCodes: page.incompleteReasons.map(({ code }) => code) });
      }
      const earlier = earlierAttemptEvidenceIds(run, page);
      for (const record of page.evidence) {
        if (record.type !== 'link' || earlier.has(record.evidenceId)) {
          continue;
        }
        for (const link of record.payload.links) {
          const key = JSON.stringify([page.pageId, link.rawHref]);
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          drafts.push({
            base: {
              sourcePageId: page.pageId,
              href: link.rawHref,
              resolvedUrl: link.normalized.ok ? link.normalized.url : null,
              admission: link.admission.kind,
            },
            targetUrl: link.admission.kind === 'INTERNAL_NAVIGABLE' ? link.admission.url : null,
          });
        }
      }
    },
    result: () => linkChecksOf(run, drafts, targets),
  };
}

/** 足したリンクの行き先を照らして、リンクごとの確かめの状態にする。 */
function linkChecksOf(
  run: Pick<RunSummary, 'crawlLimits'>,
  drafts: readonly LinkDraft[],
  targets: ReadonlyMap<string, LinkTargetFacts>,
): LinkChecksView {
  const crawlLimitsReached = (Object.keys(CRAWL_LIMIT_NAMES) as (keyof CrawlLimitState)[])
    .filter((name) => run.crawlLimits[name])
    .map((name) => CRAWL_LIMIT_NAMES[name]);
  const links: LinkCheckView[] = [];
  let navigatedBroken = 0;
  for (const { base, targetUrl } of drafts) {
    if (targetUrl === null) {
      links.push({ ...base, status: 'STATIC_CANDIDATE', unverified: null, navigation: [], access: null });
      continue;
    }
    const target = targets.get(targetUrl);
    const navigation = target === undefined ? [] : target.navigation;
    if (target !== undefined && navigation.length > 0) {
      navigatedBroken += isBroken(navigation) ? 1 : 0;
      links.push({ ...base, status: 'NAVIGATED', unverified: null, navigation, access: accessOf(navigation) });
      continue;
    }
    const reason: LinkUnverifiedReason = target === undefined ? 'TARGET_NOT_AUDITED' : 'TARGET_NOT_NAVIGATED';
    links.push({
      ...base,
      status: 'UNVERIFIED',
      unverified: {
        reason,
        crawlLimitsReached,
        targetIncompleteReasons: target === undefined ? [] : [...target.incompleteReasonCodes],
        nextStep: LINK_CHECK_NEXT_STEP_TEXT[reason],
      },
      navigation: [],
      access: null,
    });
  }
  const countOf = (status: LinkCheckStatus): number => links.filter((link) => link.status === status).length;
  return {
    counts: {
      total: links.length,
      navigated: countOf('NAVIGATED'),
      navigatedBroken,
      staticCandidate: countOf('STATIC_CANDIDATE'),
      unverified: countOf('UNVERIFIED'),
    },
    links,
  };
}
