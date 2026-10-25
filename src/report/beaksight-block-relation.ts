/**
 * BN-c（設計書 `doc/design/2026-10-23-beaksight-bundle-beaksight-block-noise-design.md` 3.3）: 指摘と BeakSight の遮断の関係の区分の、唯一の判定（純粋な関数）。
 * - 呼ぶのは表示用モデルの組み立て（`src/report/view-model.ts`）だけ。HTML・CLI・バンドルは、表示用モデルの値を描くだけにする。
 * - SAFETY の指摘は区分の外（表示用モデルが severity で外し、ここには渡さない）。
 * - 入力は確定した Run（伏せ字の後の値）。URL は伏せた後の値のまま比べ、参照にも伏せた後の値を入れる。
 * - 読む記録の印（時点・BeakSight の遮断か・読み込みの種類）は、記録の項目をそのまま読む（LG-4: 印のない前の版の記録と、その読み替えの口は捨てた）。
 * - Rule ごとの「結果が変わりうる遮断の種類」と、原因の対象の見つけ方は、Rule の定義の owner の表（`src/audit/rule-block-sensitivity.ts`）から取る。
 *
 * 結び付ける読み込み:
 * - 指摘が参照する Evidence の（ページ、ビューポート）の、ページの監査の読み込み（safety の Evidence の `load` が `PAGE_AUDIT`）と、そのビューポートの
 *   network の Evidence の失敗のうち BeakSight の遮断のもの。
 * - 幅の走査の layout の指摘（文の頭が `stressWidthFindingMessageText` の形）は、その幅の読み込み（`STRESS_WIDTH`）。
 * - Interaction の読み込みと、再試行の前の試行の記録は使わない。
 * - `POSSIBLE` の元にするのは、見える種類（`BEAKSIGHT_BLOCK_KINDS`）の、時点 `LOAD` の遮断だけ（`ping` と閉じる途中の遮断は使わない）。
 * - 同じ要求の Guard の記録と network の Evidence は、読み込み・時点・method・URL で 1 つにする（BN-R0 の M-1）。種類は補助で、定まらないか合わないときは
 *   `UNCERTAIN` とし、変わりうる種類を持つ Rule では「変わりうる」の側に倒す。
 */
import {
  BEAKSIGHT_BLOCK_RELATION_OF_REASON,
  BEAKSIGHT_UNCERTAIN_BLOCK_KIND,
  beaksightBlockKindOf,
  isSpeculativeBlockRecord,
  reconcileBeakSightBlockKinds,
  type SpeculativeMarkFact,
  type BeakSightBlockKind,
  type BeakSightBlockRefKind,
  type BeakSightBlockRelation,
  type BeakSightBlockRelationReason,
} from '../core/beaksight-block-relation.js';
import {
  VIEWPORT_PROFILES,
  type AuditRunResult,
  type EvidenceId,
  type EvidenceRecord,
  type EvidenceRecordFor,
  type Finding,
  type PageAuditResult,
  type PageId,
  type ViewportProfile,
} from '../core/contracts.js';
import { BLOCKED_EVENT_PHASES, type BlockedEventPhase, type SafetyEventsEvidence, type SafetyEvidenceLoad } from '../core/evidence-types.js';
import { isBeakSightDisabledFeaturePageError, isFetchFailurePageError, isGuardBlockedPageError } from '../core/guard-page-exceptions.js';
import { REPORT_BEAKSIGHT_BLOCK_REFERENCE_COUNT } from '../core/limits.js';
import { ruleBlockSensitivityOf, type RuleBlockTarget, type SafetyPhaseEvents } from '../audit/rule-block-sensitivity.js';
import { isBlockedByClientFailure } from '../core/blocked-by-client-failures.js';
import { isReadMethod } from '../safety/request-policy.js';
import { formatPixels } from '../presentation/format.js';
import { stressWidthFindingMessageText } from '../presentation/messages.js';
import { earlierAttemptEvidenceIds } from './artifact-writer.js';

// ---------------------------------------------------------------------------------------------------------------
// 型
// ---------------------------------------------------------------------------------------------------------------

/** 結び付いた BeakSight の遮断の参照（ページ・ビューポート・読み込み・要求の種類・時点。URL は伏せた後の値）。 */
export interface BeakSightBlockRefView {
  readonly pageId: PageId;
  readonly viewport: ViewportProfile | null;
  /** 読み込みの種類（safety の Evidence の印。network の Evidence だけの参照は `null`）。 */
  readonly load: SafetyEvidenceLoad | null;
  /**
   * 遮断の種類（fetch と xhr は、どちらも `DATA`）。同じ要求の Guard の記録と network の Evidence を、読み込み・時点・method・URL で 1 つにし、種類が定まらない
   * か合わないときは `UNCERTAIN`（BN-R0 の M-1。`reconcileBeakSightBlockKinds`）。
   */
  readonly requestKind: BeakSightBlockRefKind;
  readonly phase: BlockedEventPhase;
  /** 記録にない種類（WebSocket・行き先の移動）は `null`。 */
  readonly method: string | null;
  readonly url: string | null;
  /** BN-R1 の I-1: main frame の移動を止めた遮断か（止めた後に測ったのは、Chromium のエラーの画面）。 */
  readonly mainFrameNavigation: boolean;
}

/** 指摘と BeakSight の遮断の関係（SAFETY の指摘は持たない）。 */
export interface BeakSightBlockRelationView {
  readonly relation: BeakSightBlockRelation;
  readonly reason: BeakSightBlockRelationReason;
  /** 結び付いた遮断の参照（`REPORT_BEAKSIGHT_BLOCK_REFERENCE_COUNT` 件まで。重なりなし）。 */
  readonly blocks: readonly BeakSightBlockRefView[];
  /** 結び付いた遮断の数（重なりを除いた全部。`blocks` に入れなかった分も数える）。 */
  readonly blockCount: number;
}

/** Evidence の ID から引く、最終の試行の Evidence と、それがあるページ。 */
interface IndexedEvidence {
  readonly record: EvidenceRecord;
  readonly pageId: PageId;
}

/** 判定のための、Run の索引（`indexBeakSightBlocks` で 1 回だけ作る）。 */
export interface BeakSightBlockIndex {
  readonly evidence: ReadonlyMap<EvidenceId, IndexedEvidence>;
  /** 読み込みの鍵（`loadKeyOf`）ごとの遮断（記録の順。重なりを含む）。 */
  readonly blocksByLoad: ReadonlyMap<string, readonly BeakSightBlockRefView[]>;
  /**
   * BN-R1 の N-1: ページの監査の読み込みの鍵ごとの、エラーの画面を測ったと記録から分かる最初の時刻（パフォーマンスの Evidence の navigation timing の URL が、
   * その読み込みで止めた main frame の移動の行き先と等しいときの、その Evidence の `observedAt`）。分からない読み込みは持たない。
   */
  readonly errorPageSinceByLoad: ReadonlyMap<string, string>;
  readonly pages: readonly PageAuditResult[];
}

// ---------------------------------------------------------------------------------------------------------------
// 索引
// ---------------------------------------------------------------------------------------------------------------

/** ページの監査の読み込みの印（network の Evidence から取った遮断に付ける）。 */
const PAGE_AUDIT_LOAD: SafetyEvidenceLoad = Object.freeze({ kind: 'PAGE_AUDIT' });

/** ページの監査の読み込みの鍵（ページ・ビューポート）。 */
const pageAuditLoadKey = (pageId: PageId, viewport: ViewportProfile | null): string => JSON.stringify(['PAGE_AUDIT', pageId, viewport]);
/** 幅の走査の読み込みの鍵（ページ・幅）。 */
const stressLoadKey = (pageId: PageId, width: number): string => JSON.stringify(['STRESS_WIDTH', pageId, width]);

/** safety の Evidence の読み込みの鍵（Interaction の読み込みは `null`）。 */
const loadKeyOfSafety = (record: EvidenceRecordFor<'safety'>): string | null => {
  const { load } = record.payload;
  if (record.payload.scope !== 'PASSIVE' || load.kind === 'INTERACTION') {
    return null;
  }
  return load.kind === 'STRESS_WIDTH' ? stressLoadKey(record.pageId, load.width) : pageAuditLoadKey(record.pageId, record.viewport);
};

/** 1 つの記録の、止めた要求（種類は記録の出どころの対応で読んだもの。`null` は見えない種類）。 */
interface RecordedBlock {
  readonly pageId: PageId;
  readonly viewport: ViewportProfile | null;
  /** safety の Evidence の印（network の Evidence の記録は `null`）。 */
  readonly load: SafetyEvidenceLoad | null;
  readonly kind: BeakSightBlockRefKind | null;
  readonly phase: BlockedEventPhase;
  readonly method: string | null;
  readonly url: string | null;
  /** BN-R1 の M-2: 先読みの遮断か（`isSpeculativeBlockRecord`）。先読みの記録を含む要求は、見えない種類として扱う。 */
  readonly speculative: boolean;
  /** BN-R1 の I-1: main frame の移動を止めた記録か。 */
  readonly mainFrameNavigation: boolean;
}

/** 止めた事象の記録の、種類と先読みの印（Guard の記録の対応で読む）。 */
const guardBlockOf = (event: SpeculativeMarkFact & { readonly resourceType: string }): Pick<RecordedBlock, 'kind' | 'speculative'> => ({
  kind: beaksightBlockKindOf(event.resourceType, 'GUARD'),
  speculative: isSpeculativeBlockRecord(event, event.resourceType),
});

/** safety の Evidence の、Passive の読み込みで止めた要求（記録の順。種類は Guard の記録の対応で読む）。 */
function blocksOfSafety(record: EvidenceRecordFor<'safety'>): readonly RecordedBlock[] {
  const payload: SafetyEventsEvidence = record.payload;
  const { load } = payload;
  const of = (
    { kind, speculative }: Pick<RecordedBlock, 'kind' | 'speculative'>,
    phase: BlockedEventPhase,
    method: string | null,
    url: string | null,
    mainFrameNavigation = false,
  ): RecordedBlock => ({ pageId: record.pageId, viewport: record.viewport, load, kind, phase, method, url, speculative, mainFrameNavigation });
  const fixed = (kind: BeakSightBlockKind): Pick<RecordedBlock, 'kind' | 'speculative'> => ({ kind, speculative: false });
  return [
    ...payload.blockedRequests.map((event) => of(guardBlockOf(event), event.phase, event.method, event.url)),
    // 許可 Origin の外への main frame の移動（`EXTERNAL_MAIN_FRAME_NAVIGATION`）。
    ...payload.blockedNavigations.map((event) => of(fixed('DOCUMENT'), event.phase, event.method, event.url, true)),
    ...payload.blockedWebSockets.map((event) => of(fixed('WEBSOCKET'), event.phase, null, event.url)),
    ...(payload.blockedAuditExclusions?.events ?? []).map((event) =>
      (event.mainFrameNavigation
        ? of(fixed('DOCUMENT'), event.phase, event.method, event.url, true)
        : of(guardBlockOf(event), event.phase, event.method, event.url))),
    ...(payload.blockedClosingRequests?.events ?? []).map((event) => of(guardBlockOf(event), event.phase, event.method, event.url)),
  ];
}

/** network の Evidence の、BeakSight の遮断の失敗（ページの監査の読み込み。種類はページから見た種類の対応で読む）。 */
const blocksOfNetwork = (record: EvidenceRecordFor<'network'>): readonly RecordedBlock[] =>
  record.payload.failures.flatMap((failure): RecordedBlock[] => (failure.blockedByBeakSight
      ? [{
        pageId: record.pageId,
        viewport: record.viewport,
        load: null,
        kind: beaksightBlockKindOf(failure.resourceType, 'PAGE'),
        phase: failure.phase,
        method: failure.method,
        url: failure.url,
        speculative: isSpeculativeBlockRecord({}, failure.resourceType),
        mainFrameNavigation: failure.isNavigationRequest && failure.isMainFrame === true,
      }]
      : []));

/**
 * 1 つの読み込みの記録を、同じ要求（時点・method・URL）ごとに 1 つの参照にする（BN-R0 の M-1。結び付けは URL と method で行い、種類は補助）。種類は
 * `reconcileBeakSightBlockKinds` で 1 つにし、見えない種類だけの要求は除く。読み込みの印は safety の Evidence のもの（なければページの監査の読み込み）。
 */
function reconcileBlocks(blocks: readonly RecordedBlock[]): readonly BeakSightBlockRefView[] {
  const groups = new Map<string, RecordedBlock[]>();
  for (const block of blocks) {
    const key = JSON.stringify([block.phase, block.method, block.url]);
    groups.set(key, [...(groups.get(key) ?? []), block]);
  }
  return [...groups.values()].flatMap((group): BeakSightBlockRefView[] => {
    const [first] = group;
    // BN-R1 の M-2: 先読みの記録を含む要求は、今の画面の描画に効かないので、見えない種類として除く。
    const requestKind = group.some((block) => block.speculative) ? null : reconcileBeakSightBlockKinds(group.map((block) => block.kind));
    if (first === undefined || requestKind === null) {
      return [];
    }
    const load = group.find((block) => block.load !== null)?.load ?? PAGE_AUDIT_LOAD;
    return [{
      pageId: first.pageId,
      viewport: first.viewport,
      load,
      requestKind,
      phase: first.phase,
      method: first.method,
      url: first.url,
      mainFrameNavigation: group.some((block) => block.mainFrameNavigation),
    }];
  });
}

/** 確定した Run から、判定のための索引を作る（最終の試行の Evidence だけ）。 */
export function indexBeakSightBlocks(result: Pick<AuditRunResult, 'run' | 'pages'>): BeakSightBlockIndex {
  const evidence = new Map<EvidenceId, IndexedEvidence>();
  const recorded = new Map<string, RecordedBlock[]>();
  const add = (key: string, blocks: readonly RecordedBlock[]): void => {
    recorded.set(key, [...(recorded.get(key) ?? []), ...blocks]);
  };
  for (const page of result.pages) {
    const earlier = earlierAttemptEvidenceIds(result.run, page);
    for (const record of page.evidence) {
      if (earlier.has(record.evidenceId) || evidence.has(record.evidenceId)) {
        continue;
      }
      evidence.set(record.evidenceId, { record, pageId: page.pageId });
      if (record.type === 'safety') {
        const key = loadKeyOfSafety(record);
        if (key !== null) {
          add(key, blocksOfSafety(record));
        }
      } else if (record.type === 'network') {
        add(pageAuditLoadKey(record.pageId, record.viewport), blocksOfNetwork(record));
      }
    }
  }
  const blocksByLoad = new Map([...recorded].map(([key, blocks]) => [key, reconcileBlocks(blocks)] as const));
  return { evidence, blocksByLoad, errorPageSinceByLoad: errorPageSinceOf(evidence, blocksByLoad), pages: result.pages };
}

/**
 * BN-R1 の N-1: 読み込みごとの、エラーの画面を測ったと記録から分かる最初の時刻。パフォーマンスの Evidence の navigation timing の URL（測った時点の文書の
 * 読み込みの URL。止めた移動のエラーの画面では、止めた移動の行き先になる）が、その読み込みで時点 `LOAD` に止めた main frame の移動の URL と等しければ、その
 * Evidence の `observedAt` から後は、エラーの画面を測った（エラーの画面からは、元の画面に戻らない）。URL は、どちらも伏せた後の値で比べる。
 */
function errorPageSinceOf(
  evidence: ReadonlyMap<EvidenceId, IndexedEvidence>,
  blocksByLoad: ReadonlyMap<string, readonly BeakSightBlockRefView[]>,
): ReadonlyMap<string, string> {
  const since = new Map<string, string>();
  for (const { record, pageId } of evidence.values()) {
    if (record.type !== 'performance' || record.viewport === null) {
      continue;
    }
    const key = pageAuditLoadKey(pageId, record.viewport);
    const measuredUrl = record.payload.navigationTiming?.url ?? null;
    const blockedUrls = (blocksByLoad.get(key) ?? []).filter((ref) => ref.mainFrameNavigation && ref.phase === 'LOAD').map((ref) => ref.url);
    if (measuredUrl === null || !blockedUrls.includes(measuredUrl)) {
      continue;
    }
    const known = since.get(key);
    if (known === undefined || record.observedAt < known) {
      since.set(key, record.observedAt);
    }
  }
  return since;
}

/** BN-R1 の N-1: その時点の文書を測る Evidence の種類（読み込みの全体の記録（network・console・safety など）は除く）。 */
const POINT_MEASUREMENT_EVIDENCE_TYPES: ReadonlySet<EvidenceRecord['type']> = new Set<EvidenceRecord['type']>([
  'scroll',
  'dom',
  'layout',
  'color',
  'accessibility',
  'performance',
  'screenshot',
  'link',
]);

/** 遮断の種類が、Rule の結果を変えうる種類か（定まらない種類は、変わりうる種類を持つ Rule では「変わりうる」の側に倒す。BN-R0 の M-1）。 */
const isSensitiveKind = (kinds: readonly BeakSightBlockKind[], requestKind: BeakSightBlockRefKind): boolean =>
  requestKind === BEAKSIGHT_UNCERTAIN_BLOCK_KIND ? kinds.length > 0 : kinds.includes(requestKind);

// ---------------------------------------------------------------------------------------------------------------
// 判定の部品
// ---------------------------------------------------------------------------------------------------------------

/** URL の字として続きうる字（字句の区切りを見分けるため）。 */
const URL_CHARACTER = /[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]/u;

/** `text` の中に、`token` が、前後を URL の字でない字（か端）で区切られた字句として現れるか。 */
export function containsUrlToken(text: string, token: string): boolean {
  if (token.length === 0) {
    return false;
  }
  for (let index = text.indexOf(token); index >= 0; index = text.indexOf(token, index + 1)) {
    const before = index === 0 ? '' : (text[index - 1] ?? '');
    const after = text[index + token.length] ?? '';
    if (!URL_CHARACTER.test(before) && !URL_CHARACTER.test(after)) {
      return true;
    }
  }
  return false;
}

/** 参照の重なりを除く鍵。 */
const refKey = (ref: BeakSightBlockRefView): string =>
  JSON.stringify([ref.pageId, ref.viewport, ref.load, ref.requestKind, ref.phase, ref.method, ref.url]);

/** 参照の重なりを除いた一覧（先にあるものを残す）。 */
const distinctRefs = (refs: readonly BeakSightBlockRefView[]): readonly BeakSightBlockRefView[] => {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = refKey(ref);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
};

/** 判定の結果を作る（区分は理由から引く。参照は重なりを除き、上限まで）。 */
const relationOf = (reason: BeakSightBlockRelationReason, refs: readonly BeakSightBlockRefView[] = []): BeakSightBlockRelationView => {
  const distinct = distinctRefs(refs);
  return {
    relation: BEAKSIGHT_BLOCK_RELATION_OF_REASON[reason],
    reason,
    blocks: distinct.slice(0, REPORT_BEAKSIGHT_BLOCK_REFERENCE_COUNT),
    blockCount: distinct.length,
  };
};

/** 指摘が参照する、最終の試行の Evidence（参照の順。どのページにもないものは除く）。 */
const referencedEvidence = (index: BeakSightBlockIndex, finding: Finding): readonly IndexedEvidence[] =>
  finding.evidenceRefs.flatMap((evidenceId) => {
    const found = index.evidence.get(evidenceId);
    return found === undefined ? [] : [found];
  });

/** 幅の走査の layout の指摘なら、その幅（文の頭が、その幅の `stressWidthFindingMessageText` の形）。そうでなければ `null`。 */
const stressWidthOf = (record: EvidenceRecord, message: string): number | null => {
  if (record.type !== 'layout') {
    return null;
  }
  const width = (record.payload.stressSweep ?? []).find((result) => message.startsWith(stressWidthFindingMessageText(formatPixels(result.width), '')));
  return width === undefined ? null : width.width;
};

/** 指摘に結び付く読み込みの鍵（重なりなし。参照の順）。 */
function linkedLoadKeys(index: BeakSightBlockIndex, finding: Finding): readonly string[] {
  const keys = new Set<string>();
  for (const { record, pageId } of referencedEvidence(index, finding)) {
    const width = stressWidthOf(record, finding.message);
    if (width !== null) {
      keys.add(stressLoadKey(pageId, width));
    } else if (record.viewport === null) {
      // ビューポートによらない Evidence は、そのページのどちらのビューポートの読み込みにも結び付ける。
      for (const viewport of VIEWPORT_PROFILES) {
        keys.add(pageAuditLoadKey(pageId, viewport));
      }
    } else {
      keys.add(pageAuditLoadKey(pageId, record.viewport));
    }
  }
  return [...keys];
}

/**
 * BN-R1 の N-1: 指摘が参照する、その時点の文書を測る Evidence のどれかが、エラーの画面を測ったと記録から分かるか（ページの監査の読み込みで、エラーの画面を測った
 * と分かる時刻（`errorPageSinceByLoad`）と同じか後に記録した Evidence）。幅の走査の指摘は、ページの監査の読み込みの記録では分からないので、偽。
 */
const measuredErrorPage = (index: BeakSightBlockIndex, finding: Finding): boolean =>
  referencedEvidence(index, finding).some(({ record, pageId }) => {
    if (!POINT_MEASUREMENT_EVIDENCE_TYPES.has(record.type) || record.viewport === null || stressWidthOf(record, finding.message) !== null) {
      return false;
    }
    const since = index.errorPageSinceByLoad.get(pageAuditLoadKey(pageId, record.viewport));
    return since !== undefined && record.observedAt >= since;
  });

/** 結び付く読み込みの、時点 `LOAD` の遮断（見える種類だけ。記録の順）。 */
const loadPhaseBlocks = (index: BeakSightBlockIndex, loadKeys: readonly string[]): readonly BeakSightBlockRefView[] =>
  loadKeys.flatMap((key) => (index.blocksByLoad.get(key) ?? []).filter((ref) => ref.phase === 'LOAD'));

/** 結び付く読み込みの、時点を問わない遮断（原因の対象の URL を照らすため）。 */
const allPhaseBlocks = (index: BeakSightBlockIndex, loadKeys: readonly string[]): readonly BeakSightBlockRefView[] =>
  loadKeys.flatMap((key) => index.blocksByLoad.get(key) ?? []);

// ---------------------------------------------------------------------------------------------------------------
// 原因の対象
// ---------------------------------------------------------------------------------------------------------------

/**
 * 読み込みの失敗の指摘（`LOAD_FAILURE`）。対象の URL は、参照する Evidence の失敗（要求の種類が Rule のもの）と、DOM の画像（`domImages`）のうち、指摘の文に字句と
 * して現れるもの。その URL を BeakSight が止め、BeakSight でない失敗がなければ `CAUSED`、一部なら `POSSIBLE`。対象の URL が見つからなければ `null`（ほかの判定へ）。
 */
function loadFailureRelation(
  index: BeakSightBlockIndex,
  finding: Finding,
  target: Extract<RuleBlockTarget, { readonly kind: 'LOAD_FAILURE' }>,
): BeakSightBlockRelationView | null {
  // 対象の URL ごとの method（BN-R0 の M-1: 結び付けは URL と method で行い、種類は補助。DOM の画像は GET）。
  const targetMethods = new Map<string, Set<string>>();
  const addTarget = (url: string, method: string): void => {
    targetMethods.set(url, (targetMethods.get(url) ?? new Set<string>()).add(method));
  };
  const unblockedUrls = new Set<string>();
  const domFailureUrls = new Set<string>();
  for (const { record } of referencedEvidence(index, finding)) {
    if (record.type === 'network') {
      for (const failure of record.payload.failures) {
        if (failure.resourceType === target.resourceType && containsUrlToken(finding.message, failure.url)) {
          addTarget(failure.url, failure.method);
          if (!failure.blockedByBeakSight) {
            unblockedUrls.add(failure.url);
          }
        }
      }
    } else if (record.type === 'dom' && target.domImages) {
      for (const image of record.payload.images) {
        if (image.resolvedUrl !== null && containsUrlToken(finding.message, image.resolvedUrl)) {
          addTarget(image.resolvedUrl, IMAGE_REQUEST_METHOD);
          if (image.complete && image.naturalWidth === FAILED_IMAGE_NATURAL_WIDTH) {
            domFailureUrls.add(image.resolvedUrl);
          }
        }
      }
    }
  }
  if (targetMethods.size === 0) {
    return null;
  }
  const targetUrls = new Set(targetMethods.keys());
  // BN-R1 の M-1: 対象の URL に BeakSight でない失敗か DOM の失敗（読み込みの最中の本当の失敗）があるときは、閉じる途中の遮断を照らさない（測りの後に同じ URL を
  // 止めても、指摘の原因ではない）。読み込みの間の遮断は、いつも照らす。
  const realFailureUrls = new Set([...unblockedUrls, ...domFailureUrls]);
  const blocks = allPhaseBlocks(index, linkedLoadKeys(index, finding)).filter((ref) =>
    ref.url !== null
    && (ref.method === null || targetMethods.get(ref.url)?.has(ref.method) === true)
    && (ref.phase === 'LOAD' || !realFailureUrls.has(ref.url)));
  const blockedUrls = new Set(blocks.map((ref) => ref.url));
  if (blockedUrls.size === 0) {
    return null;
  }
  const allBlocked = [...targetUrls].every((url) => blockedUrls.has(url) && !unblockedUrls.has(url));
  return relationOf(allBlocked ? 'TARGET_REQUEST_BLOCKED' : 'TARGET_REQUEST_PARTLY_BLOCKED', blocks);
}

/** DOM の画像の読み込みの method。 */
const IMAGE_REQUEST_METHOD = 'GET';
/** DOM の画像の読み込みの失敗（`complete` で `naturalWidth` が 0。`IMAGE_LOAD_FAILED` の DOM の側と同じ事実）。 */
const FAILED_IMAGE_NATURAL_WIDTH = 0;

/** 行き先の移動の失敗の詳細（`FAILED:<Chromium のエラーのコード>`）が、BeakSight の遮断か。 */
const isBlockedNavigationDetail = (detail: string | null): boolean => {
  if (detail === null) {
    return false;
  }
  const codeStart = detail.indexOf('net::');
  return codeStart >= 0 && isBlockedByClientFailure(detail.slice(codeStart));
};

/** 行き先の移動の失敗の指摘（`TARGET_NAVIGATION`）。指摘の文にある、ほかのページの移動が BeakSight の遮断で失敗していれば `CAUSED`。 */
function targetNavigationRelation(index: BeakSightBlockIndex, finding: Finding): BeakSightBlockRelationView | null {
  const refs: BeakSightBlockRefView[] = [];
  for (const target of index.pages) {
    if (target.pageId === finding.pageId || !containsUrlToken(finding.message, target.pageUrl)) {
      continue;
    }
    for (const [viewport, state] of Object.entries(target.viewports) as [ViewportProfile, PageAuditResult['viewports'][ViewportProfile]][]) {
      if (state.incompleteReasons.some(({ code, detail }) => code === 'NAVIGATION_FAILED' && isBlockedNavigationDetail(detail))) {
        refs.push({
          pageId: target.pageId,
          viewport,
          load: PAGE_AUDIT_LOAD,
          requestKind: 'DOCUMENT',
          phase: 'LOAD',
          method: null,
          url: target.pageUrl,
          mainFrameNavigation: true,
        });
      }
    }
  }
  return refs.length === 0 ? null : relationOf('TARGET_NAVIGATION_BLOCKED', refs);
}

/** 捕まえない例外の指摘（`PAGE_ERROR`）。指摘の文に名前と文言が現れる例外（参照する console の Evidence の）で判定する。 */
function pageErrorRelation(index: BeakSightBlockIndex, finding: Finding): BeakSightBlockRelationView | null {
  const errors = referencedEvidence(index, finding).flatMap(({ record }) =>
    record.type === 'console'
      ? record.payload.pageErrors.filter((error) => !isGuardBlockedPageError(error) && finding.message.includes(error.name.length > 0 ? `${error.name}: ${error.message}` : error.message))
      : []);
  if (errors.some(isBeakSightDisabledFeaturePageError)) {
    return relationOf('DISABLED_FEATURE');
  }
  if (errors.some(isFetchFailurePageError)) {
    const dataBlocks = loadPhaseBlocks(index, linkedLoadKeys(index, finding)).filter((ref) => isSensitiveKind(['DATA'], ref.requestKind));
    if (dataBlocks.length > 0) {
      return relationOf('FETCH_FAILED_WITH_DATA_BLOCK', dataBlocks);
    }
  }
  return null;
}

/** Rule の原因の対象の見つけ方ごとの判定（見つからなければ `null`）。 */
const targetRelation = (index: BeakSightBlockIndex, finding: Finding, target: RuleBlockTarget): BeakSightBlockRelationView | null => {
  switch (target.kind) {
    case 'LOAD_FAILURE':
      return loadFailureRelation(index, finding, target);
    case 'TARGET_NAVIGATION':
      return targetNavigationRelation(index, finding);
    case 'PAGE_ERROR':
      return pageErrorRelation(index, finding);
  }
};

// ---------------------------------------------------------------------------------------------------------------
// SAFETY の指摘の時点（BN-R0 の M-3）
// ---------------------------------------------------------------------------------------------------------------

/** 時点を持つ止めた事象の一覧ごとの、safety の Evidence から事象の時点を読む関数（Rule が数える事象だけ）。 */
const SAFETY_PHASE_EVENT_READERS: Readonly<Record<SafetyPhaseEvents, (payload: SafetyEventsEvidence) => readonly BlockedEventPhase[]>> = Object.freeze({
  NON_READ_REQUESTS: (payload) => payload.blockedRequests.filter((event) => !isReadMethod(event.method)).map(({ phase }) => phase),
  NAVIGATIONS: (payload) => payload.blockedNavigations.map(({ phase }) => phase),
  WEBSOCKETS: (payload) => payload.blockedWebSockets.map(({ phase }) => phase),
});

/**
 * SAFETY の指摘が数える止めた事象の、時点の別の件数（キーは `BLOCKED_EVENT_PHASES` の順。`CLOSING` は、閉じる途中とページを離れた後に止めたもの。BN-R0 の M-3）。
 * 参照する safety の Evidence（最終の試行）の事象を数える。時点を持つ事象を数えない Rule は `null`。
 */
export function safetyBlockPhaseCountsOf(index: BeakSightBlockIndex, finding: Finding): Readonly<Record<BlockedEventPhase, number>> | null {
  const events = ruleBlockSensitivityOf(finding.ruleId).safetyPhaseEvents;
  if (events === null) {
    return null;
  }
  const counts = Object.fromEntries(BLOCKED_EVENT_PHASES.map((phase) => [phase, 0])) as Record<BlockedEventPhase, number>;
  for (const { record } of referencedEvidence(index, finding)) {
    if (record.type === 'safety') {
      for (const phase of SAFETY_PHASE_EVENT_READERS[events](record.payload)) {
        counts[phase] += 1;
      }
    }
  }
  return counts;
}

// ---------------------------------------------------------------------------------------------------------------
// 判定
// ---------------------------------------------------------------------------------------------------------------

/**
 * サイト品質の指摘の、BeakSight の遮断との関係（設計書 3.3）。
 * 1. Rule が原因の対象の見つけ方を持ち、対象の遮断が原因（`CAUSED`）なら、それ。
 * 2. 結び付く読み込みの時点 `LOAD` に main frame の移動を止めた記録があり、Rule の変わりうる種類が空でなければ、指摘の Evidence がエラーの画面を測ったと記録から
 *    分かるときは `CAUSED`（`MAIN_FRAME_NAVIGATION_BLOCKED`）、分からないときは `POSSIBLE`（`MAIN_FRAME_NAVIGATION_BLOCKED_UNCONFIRMED`）。BN-R1 の I-1・N-1。
 * 3. 1 の判定が `POSSIBLE`（対象の一部の遮断・無効にした機能・`Failed to fetch`）なら、それ。
 * 4. 結び付く読み込みの、時点 `LOAD` の見える種類の遮断のうち、Rule の結果を変えうる種類があれば `POSSIBLE`。
 * 5. 遮断はあるが変えうる種類でなければ `NONE`（`RULE_NOT_SENSITIVE`）、遮断がなければ `NONE`（`NO_BLOCK_IN_LOAD`）。
 */
export function beaksightBlockRelationOf(index: BeakSightBlockIndex, finding: Finding): BeakSightBlockRelationView {
  const sensitivity = ruleBlockSensitivityOf(finding.ruleId);
  const byTarget = sensitivity.target === null ? null : targetRelation(index, finding, sensitivity.target);
  if (byTarget?.relation === 'CAUSED') {
    return byTarget;
  }
  const blocks = loadPhaseBlocks(index, linkedLoadKeys(index, finding));
  // BN-R1 の I-1（案 a）: 結び付く読み込みで（閉じ始める前に。時点 `LOAD` は測りの後も含む）main frame の移動を止めたなら、測った画面で結果が変わりうる Rule
  // （変わりうる種類が空でない Rule）の指摘を対象にする（main frame の文書の応答・移動の期限などの、測った画面によらない Rule は除く）。
  // BN-R1 の N-1: 遮断が原因にするのは、指摘の Evidence がエラーの画面を測ったと記録から分かるときだけ。分からないときは、影響の可能性にとどめる。
  const mainFrameBlocks = blocks.filter((ref) => ref.mainFrameNavigation);
  if (mainFrameBlocks.length > 0 && sensitivity.kinds.length > 0) {
    return relationOf(measuredErrorPage(index, finding) ? 'MAIN_FRAME_NAVIGATION_BLOCKED' : 'MAIN_FRAME_NAVIGATION_BLOCKED_UNCONFIRMED', mainFrameBlocks);
  }
  if (byTarget !== null) {
    return byTarget;
  }
  const sensitive = blocks.filter((ref) => isSensitiveKind(sensitivity.kinds, ref.requestKind));
  if (sensitive.length > 0) {
    return relationOf('SENSITIVE_KIND_BLOCKED', sensitive);
  }
  return relationOf(blocks.length > 0 ? 'RULE_NOT_SENSITIVE' : 'NO_BLOCK_IN_LOAD');
}
