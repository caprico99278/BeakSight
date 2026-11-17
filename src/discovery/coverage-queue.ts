// COV-0（設計書 `2026-11-09-beaksight-coverage-by-state-design.md` 3.2）: 再帰的に広げる、辺つきの待ち行列（共通の部品。純粋）。
// 見るだけの点検（`crawl-frontier.ts`）と操作さがし（`discovery-run.ts`）の待ち行列を、COV-2・COV-4 でこれに寄せる。ここはまだどこにもつながない。
// - 辺は 2 つに分かれる。
//   - 移動の辺（`LINK`・`SPA_ROUTE`・`QUERY_CHANGE`・`FRAME`）: 場所の鍵（`state-keys.ts` の `stateLocationKeyOf`）だけで見分ける。同じ場所の鍵の
//     状態は 1 回だけ入る（読み終えた後も入らない）。状態の ID は場所の鍵。
//   - ページの中の辺（`PRESS_RESULT`・`OPENED_REGION`・`OPTION_SELECT`）: 呼び出し側が操作の後に観察した構造の鍵を持って来る。（場所の鍵・構造の鍵）の
//     組がまだ見ていないものなら入れる（URL が変わらず構造だけが変わった状態も、`openedRegion` の印を付け忘れた状態も取りこぼさない）。状態の ID は
//     組の digest。たどり方（もとの移動の状態と、押した候補の並び）を持ち、取り出したときに呼び出し側が同じ状態を作り直せるようにする。
//   - 見た組: 入れたページの中の状態の（場所・観察した構造）と、読み終えた状態の（場所・読んだ構造）。
// - 取り出しの順は、今の待ち行列（`src/crawl/crawl-queue.ts` の `CrawlQueue`）と同じ: 受け付けた順（幅優先の FIFO）。先に読む印（`preferred`）の
//   状態は、印のある状態の後、印のない状態の前に入れる。深さは記録するが、上限で打ち切らない。
// - 終わり: 取り出せる状態がない（`isFinished`）。
// - 押す辺の採否（`acceptPress`）: （構造の鍵・候補の識別・状態の中の順番）がまだ見ていないときだけ真（真のときに記録する）。共通の枠の候補も、
//   「前の画面で押した」ことでは飛ばさない（構造の鍵が違えば別の組）。
// - 終わりのない続き（設計書 3.2 の 4）: 読んだ状態の辺のうち、その状態に来た辺と同じ種類で、行き先の場所の形（Origin・path・query の名前の集合・
//   frame・開いた枠の印。query の値だけが違う）が同じ辺を「続き」とする。続きで来た状態（鎖の 2 つ目から）を読んで、新しい構造の鍵も、続きでない辺の
//   新しい状態も出なければ、その鎖を閉じる（続きの辺を入れない）。閉じた理由と、入れなかった続きの数を記録する。
// - 数の上限を持たない（読む数、押す数、深さ、鎖の長さ）。
// - 書き出し（`snapshot`）と読み戻し（`CoverageQueue.restore`）: JSON にできる値。秘密を残さない。
//   - URL は伏せた形（`redactedUrl`）だけを書く。伏せる前の URL はメモリの中だけに置く。伏せた値を持つ状態（ページの中の状態は、もとの移動の状態が
//     伏せた値を持つときも）には `redacted` の印を付ける。
//   - 読み戻した後、伏せた値を持つ待ちの状態は URL が分からないので取り出さない（待ちの順の位置は保つ）。見つけた元の状態（親）をたどり、伏せた値を
//     持たない最も近い祖先を「作り直し」（`rebuild` の印つき）として先に渡す。その祖先を読み直して出た辺が、URL の分からない状態に当たれば URL を
//     埋めて取り出せるようにする（途中の伏せた値を持つ読み終えた祖先は、URL が埋まったときに作り直しに入れる）。祖先がなければ、`awaitingStateIds`
//     に残る（同じ URL を `enqueue` すれば埋まる）。
//   - 取り出して読み終えていない状態（`READING`）は、読み戻した後に先頭からもう一度渡す。
//   - COV-2c（SREV-COV の I-4）: 秘密の名前のほかに値を伏せた query の名前（押下の目印）と、押下から生まれた状態の押下の並び（`pressTrail`）も書く。読み戻しは
//     伏せる名前も使って場所の鍵を求め直す。押下から生まれた状態は、元の状態の作り直しで押下を押し直して URL を埋める（`pressTrailsAwaitingFrom`）。
// 純粋な部品（`tests/architecture/discovery-boundary.test.ts`）。
import type { UrlRejectionReason } from '../core/evidence-types.js';
import { isNonNegativeSafeInteger } from '../core/guards.js';
import { createSha256Fingerprint, isSha256Fingerprint } from '../core/ids.js';
import { deepFreeze } from '../core/immutable.js';
import { compareCodeUnits } from '../core/text.js';
import { stateLocationKeyOf } from './state-keys.js';

/** 移動の辺の種類（リンク、SPA の経路、query の変化、frame）。 */
export const COVERAGE_NAVIGATION_EDGE_KINDS = Object.freeze(['LINK', 'SPA_ROUTE', 'QUERY_CHANGE', 'FRAME'] as const);
export type CoverageNavigationEdgeKind = (typeof COVERAGE_NAVIGATION_EDGE_KINDS)[number];

/** ページの中の辺の種類（押した後の画面、開いた欄や窓、select・radio の選択肢）。 */
export const COVERAGE_IN_PAGE_EDGE_KINDS = Object.freeze(['PRESS_RESULT', 'OPENED_REGION', 'OPTION_SELECT'] as const);
export type CoverageInPageEdgeKind = (typeof COVERAGE_IN_PAGE_EDGE_KINDS)[number];

/** 辺の種類の閉じた一覧。 */
export const COVERAGE_EDGE_KINDS = Object.freeze([
  'LINK',
  'SPA_ROUTE',
  'QUERY_CHANGE',
  'PRESS_RESULT',
  'OPENED_REGION',
  'FRAME',
  'OPTION_SELECT',
] as const satisfies readonly (CoverageNavigationEdgeKind | CoverageInPageEdgeKind)[]);
export type CoverageEdgeKind = (typeof COVERAGE_EDGE_KINDS)[number];

/** 鎖を閉じた理由の閉じた一覧。 */
export const COVERAGE_CHAIN_CLOSE_REASONS = Object.freeze(['NO_NEW_LOCATION_OR_STRUCTURE'] as const);
export type CoverageChainCloseReason = (typeof COVERAGE_CHAIN_CLOSE_REASONS)[number];

/** 状態の進み（待っている・取り出した・読み終えた）。 */
export const COVERAGE_STATE_STATUSES = Object.freeze(['QUEUED', 'READING', 'READ'] as const);
export type CoverageStateStatus = (typeof COVERAGE_STATE_STATUSES)[number];

/** 書き出しの形の印（版つき）。 */
export const COVERAGE_QUEUE_SNAPSHOT_FORMAT = 'beaksight-coverage-queue/2';

/** ページの中の状態の ID の入力の形の印（版つき）。 */
export const COVERAGE_IN_PAGE_STATE_ID_FORMAT = 'beaksight-coverage-in-page-state/1';

/** 押した（操作した）候補 1 つ（状態の中の順番は 0 から）。 */
export interface CoveragePressStep {
  readonly candidateIdentityDigest: string;
  readonly ordinal: number;
}

/** 移動の辺の入力（行き先）。 */
export interface CoverageNavigationEdgeInput {
  readonly kind: CoverageNavigationEdgeKind;
  readonly url: string;
  readonly baseUrl?: string;
  readonly frame: string | null;
  readonly openedRegion: string | null;
  /** COV-2b: 秘密に見える名前のほかに、場所の鍵と記録で値を伏せる query の名前（`stateLocationKeyOf` の `redactedQueryNames`）。 */
  readonly redactedQueryNames?: readonly string[] | undefined;
  /**
   * COV-2c（SREV-COV の I-4）: 押下から生まれた状態（押した後の移り先・同じ文書のまま変わった URL）の、見つけた元の状態で押す押下の並び（呼び出し側の印。
   * 値を持たない）。読み戻した後、伏せた値で URL の分からない状態は、元の状態を読み直してこの並びを押し直して作り直す（`pressTrailsAwaitingFrom`）。
   */
  readonly pressTrail?: readonly CoverageReplayStep[] | undefined;
  /**
   * COV-2c fix round 4（SREV-COV 3 回目の C-1）: 凍結の中でだけ読む状態か（押下から生まれた状態から出た辺が受け継ぐ印）。押下の並び（`pressTrail`）を持つ状態も、
   * 凍結の中でだけ読む。省略は偽。
   */
  readonly frozenRead?: boolean | undefined;
}

/**
 * COV-2c fix round 4: 状態を読むときに凍結の外で読み込む URL と、その状態の事実（`unfrozenLoadRefusalOf` の入力）。凍結の中でだけ読む状態では、押下を経ていない
 * 最も近い祖先（たどり始め）の URL と事実。
 */
export interface CoverageUnfrozenLoad {
  readonly url: string;
  readonly frozenRequired: boolean;
  readonly redactedQueryNames: readonly string[];
}

/**
 * COV-2c fix round 4: 凍結の中でだけ読む状態のたどり方（押下を経ていない最も近い祖先の URL と、そこから凍結の中で順に読み込む URL の並び。最後の要素の後に、
 * その状態自身の URL を読み込む）。
 */
export interface CoverageFrozenPath {
  readonly rootUrl: string;
  readonly hops: readonly string[];
}

/** COV-2c fix round 4: 凍結の外で読み込んではいけない理由（押下から生まれた状態・伏せた query を持つ URL・押下の目印の値を含む URL）。 */
export type CoverageUnfrozenLoadRefusal = 'PRESS_BORN_STATE' | 'REDACTED_QUERY' | 'MARKER_VALUE';

/** COV-2c fix round 5（M-2）: query の名前の比べる形（URL の符号化を解き、小文字にし、末尾の `[]` を外す）。 */
const comparableQueryNameOf = (name: string): string => {
  let decoded = name;
  try {
    decoded = decodeURIComponent(name);
  } catch {
    decoded = name;
  }
  return decoded.toLowerCase().replace(/\[\]$/u, '');
};

/** COV-2c fix round 5: 値を比べる形（URL の符号化を解く。解けなければそのまま）。 */
const decodedTextOf = (text: string): string => {
  try {
    return decodeURIComponent(text.replace(/\+/gu, ' '));
  } catch {
    return text;
  }
};

/**
 * COV-2c fix round 5（SREV-COV 4 回目の I-1。設計者の判断の 1。伏せる判定の唯一の場所）: URL の query のうち、伏せる名前（記録・checkpoint・場所の鍵で値を
 * 伏せる名前）。`markerValues` は、押下で入れた目印の値（メモリの中だけ）。名前を問わず、値にその目印の値を含む名前を返す。`'ALL'`（値が分からない。再開の後など）は、
 * すべての名前を返す。目印の値がなければ空。
 */
export const markerCarryingQueryNamesOf = (url: string, markerValues: readonly string[] | 'ALL'): readonly string[] => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return Object.freeze([]);
  }
  const names = new Set<string>();
  for (const [name, value] of parsed.searchParams) {
    if (markerValues === 'ALL' || markerValues.some((marker) => marker.length > 0 && value.includes(marker))) names.add(name);
  }
  return Object.freeze([...names]);
};

/**
 * COV-2c fix round 4（SREV-COV 3 回目の C-1。設計者の判断の 2）: 凍結の外で読み込む入口の守り（唯一の判定）。凍結の中でだけ読む状態か、伏せた query の名前
 * （押下の目印を含む名前）が URL にあれば、凍結の外で読み込まない理由を返す。読み込んでよければ `null`。
 * COV-2c fix round 5（4 回目の M-2）: 名前は、URL の符号化・大文字と小文字・末尾の `[]` をそろえて比べる。押下で入れた目印の値（`markerValues`。メモリの中だけ）が、
 * URL（符号化を解いた全体）のどこかにあれば、名前を問わず拒む。
 */
export const unfrozenLoadRefusalOf = (load: CoverageUnfrozenLoad, markerValues: readonly string[] = []): CoverageUnfrozenLoadRefusal | null => {
  if (load.frozenRequired) {
    return 'PRESS_BORN_STATE';
  }
  let parsed: URL;
  try {
    parsed = new URL(load.url);
  } catch {
    return 'REDACTED_QUERY';
  }
  const decoded = decodedTextOf(parsed.href);
  if (markerValues.some((marker) => marker.length > 0 && (parsed.href.includes(marker) || decoded.includes(marker)))) {
    return 'MARKER_VALUE';
  }
  if (load.redactedQueryNames.length === 0) {
    return null;
  }
  const names = new Set([...parsed.searchParams.keys()].map(comparableQueryNameOf));
  return load.redactedQueryNames.some((name) => names.has(comparableQueryNameOf(name))) ? 'REDACTED_QUERY' : null;
};

/**
 * COV-2: 押下の 1 つ（呼び出し側の押す部品の印。記録の候補の位置、見分けの鍵（識別の digest と構造の手がかり。値を持たない）、同じ鍵の中の順番）。
 * 待ち行列は中身を解釈せず、形だけを確かめて書き出す。
 */
export interface CoverageReplayStep {
  readonly index: number;
  readonly matchKey: string;
  readonly ordinal: number;
}

// LZ-2: 押下の見分けの鍵の長さの上限（前は `MAX_REPLAY_MATCH_KEY_LENGTH` 4,096）は撤廃した（書き出しのスキーマからも外した）。

/** COV-2c: 作り直しを待つ、押下から生まれた状態（`pressTrailsAwaitingFrom` の結果）。 */
export interface CoveragePressTrailAwaiting {
  readonly stateId: string;
  readonly kind: CoverageNavigationEdgeKind;
  readonly redactedQueryNames: readonly string[];
  readonly pressTrail: readonly CoverageReplayStep[];
  /** 状態の進み（読み終えた状態は、URL が埋まると作り直しに入る）。 */
  readonly status: CoverageStateStatus;
}

/** ページの中の辺の入力（操作の後に観察した状態）。 */
export interface CoverageInPageEdgeInput {
  readonly kind: CoverageInPageEdgeKind;
  readonly url: string;
  readonly baseUrl?: string;
  readonly frame: string | null;
  readonly openedRegion: string | null;
  /** 操作の後に観察した構造の鍵。 */
  readonly structureKey: string;
  /** 操作した候補。 */
  readonly press: CoveragePressStep;
}

export type CoverageEdgeInput = CoverageNavigationEdgeInput | CoverageInPageEdgeInput;

/** `enqueue` の指定。 */
export interface CoverageEnqueueOptions {
  readonly preferred?: boolean;
  /** 深さ（記録だけ。既定 0）。 */
  readonly depth?: number;
}

/** `enqueue` の結果。`RECOVERED` は、読み戻した後に URL の分からなかった状態の URL を埋めた。 */
export type CoverageEnqueueResult =
  | { readonly status: 'QUEUED' | 'KNOWN' | 'RECOVERED'; readonly stateId: string }
  | { readonly status: 'REJECTED'; readonly stateId: null; readonly reason: UrlRejectionReason };

/** ページの中の状態のたどり方（書き出しの形）。 */
export interface CoverageTrailRecord {
  /** もとの移動の状態の ID。 */
  readonly baseStateId: string;
  /** もとの状態から押した候補の並び。 */
  readonly presses: readonly CoveragePressStep[];
}

/** 1 つの状態の記録（書き出しの形）。 */
export interface CoverageStateRecord {
  readonly stateId: string;
  readonly locationKey: string;
  /** その状態に来た辺の種類。 */
  readonly kind: CoverageEdgeKind;
  /** 伏せた URL（`stateLocationKeyOf` の `redactedUrl`）。 */
  readonly url: string;
  /** 伏せた値を持つか（ページの中の状態は、もとの移動の状態が持つときも）。 */
  readonly redacted: boolean;
  readonly frame: string | null;
  readonly openedRegion: string | null;
  readonly depth: number;
  /** 続きの辺をたどった数（続きでない辺で来た状態は 0）。 */
  readonly chainLength: number;
  readonly preferred: boolean;
  readonly status: CoverageStateStatus;
  /** 読み終えた状態の構造の鍵（ほかは `null`）。 */
  readonly structureKey: string | null;
  /** ページの中の状態の、操作の後に観察した構造の鍵（移動の状態は `null`）。 */
  readonly observedStructureKey: string | null;
  /** 見つけた元の状態の ID（`enqueue` で入れた状態は `null`）。 */
  readonly parentStateId: string | null;
  /** ページの中の状態のたどり方（移動の状態は `null`）。 */
  readonly trail: CoverageTrailRecord | null;
  /** COV-2c: 秘密に見える名前のほかに値を伏せる query の名前（ないときは持たない）。読み戻しで場所の鍵を求め直すのに使う。 */
  readonly redactedQueryNames?: readonly string[];
  /** COV-2c: 押下から生まれた状態の、元の状態で押す押下の並び（ないときは持たない）。 */
  readonly pressTrail?: readonly CoverageReplayStep[];
  /** COV-2c fix round 4: 凍結の中でだけ読む印を受け継いだ状態か（真のときだけ持つ）。 */
  readonly frozenRead?: true;
}

/** 取り出した状態のたどり方（もとの状態の URL つき）。 */
export interface CoverageTrail extends CoverageTrailRecord {
  readonly baseUrl: string;
}

/** 取り出した状態。 */
export interface CoverageQueueItem extends Omit<CoverageStateRecord, 'trail'> {
  /** 移動に使う、伏せる前の URL（成果物に書かない）。 */
  readonly url: string;
  /** COV-2b: 伏せた URL（`stateLocationKeyOf` の `redactedUrl`。記録に書いてよい形）。 */
  readonly redactedUrl: string;
  readonly trail: CoverageTrail | null;
  /** 読み戻した後の作り直し（読み終えた状態を読み直し、辺を出し直す）か。 */
  readonly rebuild: boolean;
  /**
   * COV-2c（SREV-COV の C-1）・fix round 4（3 回目の C-1）: 凍結の中でだけ読む状態か（押下の並びを持つか、押下から生まれた状態から出た辺の印を受け継いだ）。
   */
  readonly frozenRequired: boolean;
  /**
   * COV-2c fix round 4: 凍結の中でだけ読む状態のたどり方（押下を経ていない最も近い祖先の URL と、そこから凍結の中で順に読み込む祖先の URL。伏せる前。成果物に
   * 書かない）。凍結の中でだけ読む状態でない・途中の URL が分からないときは `null`。
   */
  readonly frozenPath: CoverageFrozenPath | null;
  /** COV-2c fix round 4: この状態を読むときに凍結の外で読み込む URL と事実（入口の守り `unfrozenLoadRefusalOf` に渡す。分からなければ `null`）。 */
  readonly unfrozenLoad: CoverageUnfrozenLoad | null;
}

/** 押す辺の鍵。 */
export interface CoveragePressKey extends CoveragePressStep {
  readonly structureKey: string;
}

/** 閉じた鎖の記録。 */
export interface CoverageChainClosure {
  /** 閉じたところの状態の ID。 */
  readonly stateId: string;
  readonly kind: CoverageEdgeKind;
  readonly reason: CoverageChainCloseReason;
  /** 入れなかった続きの辺の数（まだ知らない状態の数）。 */
  readonly droppedEdgeCount: number;
}

/** 書き出しの形（JSON にできる値。秘密を含まない）。 */
export interface CoverageQueueSnapshot {
  readonly format: typeof COVERAGE_QUEUE_SNAPSHOT_FORMAT;
  /** すべての状態（受け付けた順）。 */
  readonly states: readonly CoverageStateRecord[];
  /** 待っている状態（`QUEUED`）の ID（取り出す順）。 */
  readonly pending: readonly string[];
  /** 押した辺（受け付けた順）。 */
  readonly pressed: readonly CoveragePressKey[];
  readonly closedChains: readonly CoverageChainClosure[];
}

/** 読み終えた状態の事実（`completeRead` の入力）。 */
export interface CoverageReadOutcome {
  readonly structureKey: string;
  readonly edges: readonly CoverageEdgeInput[];
  /** 先に読む印を付ける辺の行き先の URL（入力の `url` の値と比べる）。 */
  readonly preferredUrls?: ReadonlySet<string>;
}

/** `completeRead` の結果。 */
export interface CoverageReadResult {
  /** 新しく入れた状態と、URL を埋めた状態の ID（入れた順）。 */
  readonly queuedStateIds: readonly string[];
  readonly closedChain: CoverageChainClosure | null;
  /** 受け入れなかった URL の辺の理由（辺の順）。 */
  readonly rejectedReasons: readonly UrlRejectionReason[];
}

interface MutableTrail {
  readonly baseStateId: string;
  readonly presses: readonly CoveragePressStep[];
}

interface MutableState {
  readonly stateId: string;
  readonly locationKey: string;
  readonly kind: CoverageEdgeKind;
  /** 伏せる前の URL（メモリの中だけ）。読み戻した後の伏せた値を持つ状態は、埋まるまで `null`。 */
  url: string | null;
  readonly redactedUrl: string;
  readonly redacted: boolean;
  readonly frame: string | null;
  readonly openedRegion: string | null;
  readonly depth: number;
  readonly chainLength: number;
  readonly preferred: boolean;
  status: CoverageStateStatus;
  structureKey: string | null;
  readonly observedStructureKey: string | null;
  readonly parentStateId: string | null;
  readonly trail: MutableTrail | null;
  readonly redactedQueryNames: readonly string[];
  readonly pressTrail: readonly CoverageReplayStep[] | null;
  readonly frozenRead: boolean;
}

/** 解決した辺（場所の鍵と状態の ID）。 */
interface ResolvedEdge {
  readonly edge: CoverageEdgeInput;
  readonly locationKey: string;
  readonly url: string;
  readonly redactedUrl: string;
  readonly stateId: string;
  /** 見た状態か（移動は場所の鍵、ページの中は組で比べる）。 */
  readonly known: boolean;
}

const isOneOf = <T extends string>(list: readonly T[], value: unknown): value is T => typeof value === 'string' && (list as readonly string[]).includes(value);

const isInPageEdge = (edge: CoverageEdgeInput): edge is CoverageInPageEdgeInput => isOneOf(COVERAGE_IN_PAGE_EDGE_KINDS, edge.kind);

const isRecordValue = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const isNullableString = (value: unknown): value is string | null => value === null || typeof value === 'string';

/** 場所の形（query の値だけが違う場所を同じとみなす。続きの辺の見分けに使う）。 */
const locationShapeOf = (url: string, frame: string | null, openedRegion: string | null): string => {
  const parsed = new URL(url);
  const names = [...new Set(parsed.searchParams.keys())].sort(compareCodeUnits);
  return JSON.stringify([parsed.origin, parsed.pathname, names, frame, openedRegion]);
};

/** （場所の鍵・構造の鍵）の組の文字列。 */
const pairOf = (locationKey: string, structureKey: string): string => JSON.stringify([locationKey, structureKey]);

/** ページの中の状態の ID。 */
const inPageStateIdOf = (locationKey: string, structureKey: string): string =>
  createSha256Fingerprint(JSON.stringify([COVERAGE_IN_PAGE_STATE_ID_FORMAT, locationKey, structureKey]));

const pressKeyText = (key: CoveragePressKey): string => JSON.stringify([key.structureKey, key.candidateIdentityDigest, key.ordinal]);

const checkPressStep = (step: CoveragePressStep): void => {
  if (!isSha256Fingerprint(step.candidateIdentityDigest)) {
    throw new RangeError('coverage press candidate must be a fingerprint digest');
  }
  if (!isNonNegativeSafeInteger(step.ordinal)) {
    throw new RangeError('coverage press ordinal must be a non-negative safe integer');
  }
};

const checkStructureKey = (structureKey: unknown): void => {
  if (!isSha256Fingerprint(structureKey)) {
    throw new RangeError('coverage structure key must be a fingerprint digest');
  }
};

const freezeStep = (step: CoveragePressStep): CoveragePressStep =>
  Object.freeze({ candidateIdentityDigest: step.candidateIdentityDigest, ordinal: step.ordinal });

const recordOfState = (state: MutableState): CoverageStateRecord => ({
  stateId: state.stateId,
  locationKey: state.locationKey,
  kind: state.kind,
  url: state.redactedUrl,
  redacted: state.redacted,
  frame: state.frame,
  openedRegion: state.openedRegion,
  depth: state.depth,
  chainLength: state.chainLength,
  preferred: state.preferred,
  status: state.status,
  structureKey: state.structureKey,
  observedStructureKey: state.observedStructureKey,
  parentStateId: state.parentStateId,
  trail: state.trail === null ? null : { baseStateId: state.trail.baseStateId, presses: state.trail.presses.map((step) => ({ ...step })) },
  ...(state.redactedQueryNames.length === 0 ? {} : { redactedQueryNames: [...state.redactedQueryNames] }),
  ...(state.pressTrail === null ? {} : { pressTrail: state.pressTrail.map((step) => ({ ...step })) }),
  ...(state.frozenRead ? { frozenRead: true as const } : {}),
});

/** COV-2c fix round 4: 凍結の中でだけ読む状態か（押下の並びを持つか、凍結の中でだけ読む印を受け継いだ）。 */
const isFrozenRequired = (state: Pick<MutableState, 'pressTrail' | 'frozenRead'>): boolean => state.pressTrail !== null || state.frozenRead;

/** COV-2c: 押下の並びの形を確かめて凍結した写しにする（形が違えば `RangeError`。空の並びは `null`）。 */
const replayStepsOf = (value: unknown): readonly CoverageReplayStep[] | null => {
  if (value === undefined || value === null) {
    return null;
  }
  if (!Array.isArray(value)) {
    throw new RangeError('coverage press trail must be a list');
  }
  if (value.length === 0) {
    return null;
  }
  return Object.freeze(value.map((step: unknown) => {
    if (!isRecordValue(step) || !isNonNegativeSafeInteger(step['index']) || !isNonNegativeSafeInteger(step['ordinal'])
      || typeof step['matchKey'] !== 'string' || step['matchKey'].length === 0) {
      throw new RangeError('coverage press trail step has the wrong shape');
    }
    return Object.freeze({ index: step['index'] as number, matchKey: step['matchKey'], ordinal: step['ordinal'] as number });
  }));
};

/** COV-2c: 伏せる query の名前の形を確かめて、重なりなく並べた写しにする（形が違えば `RangeError`）。 */
const redactedQueryNamesOf = (value: unknown): readonly string[] => {
  if (value === undefined || value === null) {
    return Object.freeze([]);
  }
  if (!Array.isArray(value) || !value.every((name) => typeof name === 'string' && name.length > 0)) {
    throw new RangeError('coverage redacted query names must be a list of names');
  }
  return Object.freeze([...new Set(value as string[])].sort(compareCodeUnits));
};

/** 辺つきの待ち行列（ファイルの先頭の説明）。 */
export class CoverageQueue {
  /** すべての状態（受け付けた順。状態の ID で引く）。 */
  readonly #states = new Map<string, MutableState>();
  /** すべての状態の場所の鍵（移動の辺の見分け）。 */
  readonly #locationKeys = new Set<string>();
  /** 見た（場所の鍵・構造の鍵）の組（ページの中の辺の見分け）。 */
  readonly #seenPairs = new Set<string>();
  /** 取り出す順の状態の ID（読み戻した直後は、先頭に `READING` の状態を含む。URL の分からない状態は飛ばす）。 */
  readonly #pending: string[] = [];
  /** `#pending` の先頭の、印のある状態（と読み戻した `READING`）の数。 */
  #preferredCount = 0;
  readonly #seenStructureKeys = new Set<string>();
  readonly #pressed = new Map<string, CoveragePressKey>();
  readonly #closedChains: CoverageChainClosure[] = [];
  /** 作り直しを待つ読み終えた状態の ID（先に渡す）。 */
  readonly #rebuild: string[] = [];
  /** URL が埋まったら作り直しに入れる、伏せた値を持つ読み終えた状態の ID。 */
  readonly #rebuildWhenKnown = new Set<string>();
  /** 作り直しとして渡した状態の ID。 */
  readonly #rebuilding = new Set<string>();

  /** 取り出せる状態がないか（終わり）。 */
  get isFinished(): boolean {
    return this.#rebuild.length === 0 && this.#nextPendingIndex() < 0;
  }

  /** 読み戻した後、URL が分からないまま残っている待ちの状態の ID（受け付けた順）。 */
  awaitingStateIds(): readonly string[] {
    return Object.freeze([...this.#states.values()].filter((state) => state.url === null && state.status !== 'READ').map((state) => state.stateId));
  }

  /**
   * COV-2c（SREV-COV の I-4）: 読み戻した後、URL が分からないまま待っている、押下から生まれた状態のうち、`stateId` の状態で見つけたもの（受け付けた順）。
   * 呼び出し側は、`stateId` の状態を読み直し、押下の並びを押し直して移り先の URL を出し、`completeRead` の辺に入れる（URL が埋まる）。
   */
  pressTrailsAwaitingFrom(stateId: string): readonly CoveragePressTrailAwaiting[] {
    return Object.freeze([...this.#states.values()].flatMap((state) => {
      if (state.parentStateId !== stateId || state.url !== null || state.pressTrail === null || !isOneOf(COVERAGE_NAVIGATION_EDGE_KINDS, state.kind)) {
        return [];
      }
      return [Object.freeze({
        stateId: state.stateId, kind: state.kind, redactedQueryNames: state.redactedQueryNames, pressTrail: state.pressTrail, status: state.status,
      })];
    }));
  }

  /** 移動の辺で状態を入れる（ファイルの先頭の説明）。ページの中の辺は `completeRead` でだけ入る（`RangeError`）。 */
  enqueue(edge: CoverageNavigationEdgeInput, options: CoverageEnqueueOptions = {}): CoverageEnqueueResult {
    if (!isOneOf(COVERAGE_NAVIGATION_EDGE_KINDS, edge.kind)) {
      throw new RangeError('coverage enqueue takes a navigation edge kind only');
    }
    const depth = options.depth ?? 0;
    if (!isNonNegativeSafeInteger(depth)) {
      throw new RangeError('coverage depth must be a non-negative safe integer');
    }
    const resolved = this.#resolve(edge);
    if (!('stateId' in resolved)) {
      return Object.freeze({ status: 'REJECTED', stateId: null, reason: resolved.reason });
    }
    return this.#addState(resolved, depth, 0, options.preferred === true, null);
  }

  /** 次に読む状態（作り直しを先に渡す。取り出した待ちの状態は `READING` になる）。なければ `undefined`。 */
  next(): CoverageQueueItem | undefined {
    const rebuildId = this.#rebuild.shift();
    if (rebuildId !== undefined) {
      this.#rebuilding.add(rebuildId);
      return this.#item(this.#state(rebuildId), true);
    }
    const index = this.#nextPendingIndex();
    if (index < 0) {
      return undefined;
    }
    const [stateId] = this.#pending.splice(index, 1);
    if (index < this.#preferredCount) {
      this.#preferredCount -= 1;
    }
    const state = this.#state(stateId ?? '');
    state.status = 'READING';
    return this.#item(state, false);
  }

  /**
   * 取り出した状態を読み終えた（構造の鍵と出た辺）。辺を待ち行列に入れ、終わりのない続きを閉じる（ファイルの先頭の説明）。作り直しとして渡した状態は、
   * URL の分からない状態を埋めるだけにする（記録は変えない）。取り出していない状態、2 回目の呼び出し、digest でない値は呼び出し側の誤り。
   */
  completeRead(stateId: string, outcome: CoverageReadOutcome): CoverageReadResult {
    checkStructureKey(outcome.structureKey);
    const state = this.#state(stateId);
    const rejectedReasons: UrlRejectionReason[] = [];
    const resolved = outcome.edges.flatMap((edge) => {
      const result = this.#resolve(edge);
      if (!('stateId' in result)) {
        rejectedReasons.push(result.reason);
        return [];
      }
      return [result];
    });
    if (this.#rebuilding.delete(stateId)) {
      const recovered = resolved.flatMap((edge) => (this.#fill(edge) ? [edge.stateId] : []));
      return Object.freeze({ queuedStateIds: Object.freeze(recovered), closedChain: null, rejectedReasons: Object.freeze(rejectedReasons) });
    }
    if (state.status !== 'READING' || state.url === null) {
      throw new Error(`coverage state is not being read (status ${state.status})`);
    }
    const shape = locationShapeOf(state.url, state.frame, state.openedRegion);
    const newStructure = !this.#seenStructureKeys.has(outcome.structureKey);
    state.status = 'READ';
    state.structureKey = outcome.structureKey;
    this.#seenStructureKeys.add(outcome.structureKey);
    this.#seenPairs.add(pairOf(state.locationKey, outcome.structureKey));

    const edges = resolved.map((edge) => ({
      ...edge,
      known: isInPageEdge(edge.edge) ? this.#seenPairs.has(pairOf(edge.locationKey, edge.edge.structureKey)) : this.#locationKeys.has(edge.locationKey),
      continuation: edge.edge.kind === state.kind && locationShapeOf(edge.url, edge.edge.frame, edge.edge.openedRegion) === shape,
    }));
    const fresh = newStructure || edges.some(({ known, continuation }) => !continuation && !known);
    const closing = state.chainLength > 0 && !fresh;

    let closedChain: CoverageChainClosure | null = null;
    if (closing) {
      const dropped = new Set(edges.filter(({ known, continuation }) => continuation && !known).map((edge) => edge.stateId));
      closedChain = Object.freeze({ stateId, kind: state.kind, reason: 'NO_NEW_LOCATION_OR_STRUCTURE', droppedEdgeCount: dropped.size });
      this.#closedChains.push(closedChain);
    }
    const queuedStateIds: string[] = [];
    for (const edge of edges) {
      if (closing && edge.continuation) {
        continue;
      }
      const result = this.#addState(edge, state.depth + 1, edge.continuation ? state.chainLength + 1 : 0, outcome.preferredUrls?.has(edge.edge.url) === true, state);
      if (result.status === 'QUEUED' || result.status === 'RECOVERED') {
        queuedStateIds.push(result.stateId);
      }
    }
    return Object.freeze({ queuedStateIds: Object.freeze(queuedStateIds), closedChain, rejectedReasons: Object.freeze(rejectedReasons) });
  }

  /** 押す辺の採否。まだ見ていない組なら記録して真、見た組なら偽。digest でない値・負の順番は `RangeError`。 */
  acceptPress(key: CoveragePressKey): boolean {
    checkStructureKey(key.structureKey);
    checkPressStep(key);
    const text = pressKeyText(key);
    if (this.#pressed.has(text)) {
      return false;
    }
    this.#pressed.set(text, Object.freeze({ structureKey: key.structureKey, candidateIdentityDigest: key.candidateIdentityDigest, ordinal: key.ordinal }));
    return true;
  }

  /** その組をもう押したか（記録しない）。 */
  hasPressed(key: CoveragePressKey): boolean {
    checkStructureKey(key.structureKey);
    checkPressStep(key);
    return this.#pressed.has(pressKeyText(key));
  }

  /** 書き出し（深く凍結した、JSON にできる値。伏せる前の URL を含まない。待ち行列は変えない）。 */
  snapshot(): CoverageQueueSnapshot {
    return deepFreeze({
      format: COVERAGE_QUEUE_SNAPSHOT_FORMAT,
      states: [...this.#states.values()].map(recordOfState),
      pending: this.#pending.filter((id) => this.#state(id).status === 'QUEUED'),
      pressed: [...this.#pressed.values()].map((key) => ({ ...key })),
      closedChains: this.#closedChains.map((closure) => ({ ...closure })),
    });
  }

  /**
   * 書き出した値（JSON から読んだ値）から作り直す（ファイルの先頭の説明）。`READING` の状態は、受け付けた順に先頭へ戻す（`next` でもう一度渡す）。
   * 壊れた値（形、版の印、場所の鍵と URL の食い違い、ID の食い違い、待ちの一覧と状態の食い違い、重なり）は `Error`・`RangeError`。
   */
  static restore(stored: unknown): CoverageQueue {
    if (!isRecordValue(stored) || stored['format'] !== COVERAGE_QUEUE_SNAPSHOT_FORMAT) {
      throw new Error('coverage queue snapshot has an unsupported format');
    }
    const { states, pending, pressed, closedChains } = stored;
    if (!Array.isArray(states) || !Array.isArray(pending) || !Array.isArray(pressed) || !Array.isArray(closedChains)) {
      throw new Error('coverage queue snapshot lists are missing');
    }
    const queue = new CoverageQueue();
    states.forEach((value: unknown, index) => {
      const state = restoreState(value, index, queue.#states);
      queue.#states.set(state.stateId, state);
      queue.#locationKeys.add(state.locationKey);
      if (state.observedStructureKey !== null) {
        queue.#seenPairs.add(pairOf(state.locationKey, state.observedStructureKey));
      }
      if (state.structureKey !== null) {
        queue.#seenStructureKeys.add(state.structureKey);
        queue.#seenPairs.add(pairOf(state.locationKey, state.structureKey));
      }
    });
    const all = [...queue.#states.values()];
    // COV-2c fix round 5（SREV-COV 4 回目の M-2。設計者の判断の 4）: 押下から生まれた状態の印が消えた書き出しを受け入れない。目印の名前を伏せた状態と、凍結の中で
    // だけ読む状態の子（移動の状態）は、凍結の中でだけ読む印（押下の並びか、受け継いだ印）を持つはず。
    for (const state of all) {
      if (isOneOf(COVERAGE_IN_PAGE_EDGE_KINDS, state.kind)) continue;
      const parent = state.parentStateId === null ? undefined : queue.#states.get(state.parentStateId);
      const mustBeFrozen = state.redactedQueryNames.length > 0 || (parent !== undefined && isFrozenRequired(parent));
      if (mustBeFrozen && !isFrozenRequired(state)) {
        throw new Error('coverage queue snapshot has a state made by a press without its frozen read mark');
      }
    }
    const reading = all.filter((state) => state.status === 'READING').map((state) => state.stateId);
    const queued = new Set(all.filter((state) => state.status === 'QUEUED').map((state) => state.stateId));
    const pendingIds = pending.map((id: unknown) => {
      if (typeof id !== 'string' || !queued.delete(id)) {
        throw new Error('coverage queue snapshot pending list does not match the queued states');
      }
      return id;
    });
    if (queued.size > 0) {
      throw new Error('coverage queue snapshot has queued states missing from the pending list');
    }
    const leadingPreferred = pendingIds.findIndex((id) => !queue.#state(id).preferred);
    const preferredPending = leadingPreferred < 0 ? pendingIds.length : leadingPreferred;
    if (pendingIds.slice(preferredPending).some((id) => queue.#state(id).preferred)) {
      throw new Error('coverage queue snapshot has a preferred state after an unpreferred one');
    }
    queue.#pending.push(...reading, ...pendingIds);
    queue.#preferredCount = reading.length + preferredPending;
    for (const value of pressed) {
      if (!isRecordValue(value)) {
        throw new Error('coverage queue snapshot press entry is not an object');
      }
      const key = { structureKey: value['structureKey'], candidateIdentityDigest: value['candidateIdentityDigest'], ordinal: value['ordinal'] } as CoveragePressKey;
      if (!queue.acceptPress(key)) {
        throw new Error('coverage queue snapshot repeats a press entry');
      }
    }
    for (const value of closedChains) {
      queue.#closedChains.push(restoreClosure(value, queue.#states));
    }
    queue.#planRebuilds();
    return queue;
  }

  /** 読み戻した後、URL の分からない待ちの状態ごとに、伏せた値を持たない最も近い祖先を作り直しに入れる。 */
  #planRebuilds(): void {
    const rebuild = new Set<string>();
    for (const state of this.#states.values()) {
      // COV-2c fix round 5（SREV-COV 4 回目の I-2。設計者の判断の 2）: URL の分かる待ちの状態でも、凍結の中でだけ読む状態のたどり方に URL の分からない祖先が
      // あれば、その祖先を作り直す（作り直した祖先の URL で、たどり方を作る）。
      const awaiting = state.url === null || (isFrozenRequired(state) && this.#frozenPathOf(state) === null);
      if (!awaiting || state.status === 'READ') {
        continue;
      }
      let ancestor = state.parentStateId === null ? undefined : this.#states.get(state.parentStateId);
      while (ancestor !== undefined && ancestor.url === null) {
        if (ancestor.status === 'READ') {
          this.#rebuildWhenKnown.add(ancestor.stateId);
        }
        ancestor = ancestor.parentStateId === null ? undefined : this.#states.get(ancestor.parentStateId);
      }
      if (ancestor?.status === 'READ') {
        rebuild.add(ancestor.stateId);
      }
    }
    // 受け付けた順に渡す。
    this.#rebuild.push(...[...this.#states.keys()].filter((id) => rebuild.has(id)));
  }

  /** 辺の行き先の場所の鍵と状態の ID（受け入れない URL は理由）。 */
  #resolve(edge: CoverageEdgeInput): Omit<ResolvedEdge, 'known'> | { readonly reason: UrlRejectionReason } {
    if (!isOneOf(COVERAGE_EDGE_KINDS, edge.kind)) {
      throw new RangeError('coverage edge kind is not in COVERAGE_EDGE_KINDS');
    }
    if (isInPageEdge(edge)) {
      checkStructureKey(edge.structureKey);
      checkPressStep(edge.press);
    }
    const location = stateLocationKeyOf(edge);
    if (!location.ok) {
      return { reason: location.reason };
    }
    return {
      edge,
      locationKey: location.key,
      url: location.url,
      redactedUrl: location.redactedUrl,
      stateId: isInPageEdge(edge) ? inPageStateIdOf(location.key, edge.structureKey) : location.key,
    };
  }

  /** URL の分からない状態に当たる辺なら、URL を埋めて真（待ちの状態は取り出せるように、読み終えた状態は作り直しに入れる）。 */
  #fill(edge: Omit<ResolvedEdge, 'known'>): boolean {
    const state = this.#states.get(edge.stateId);
    if (state === undefined || state.url !== null) {
      return false;
    }
    state.url = edge.url;
    if (state.status === 'READ' && this.#rebuildWhenKnown.delete(state.stateId)) {
      this.#rebuild.push(state.stateId);
    }
    return true;
  }

  /** 状態を入れる（見た状態は `KNOWN`、URL の分からない状態に当たれば `RECOVERED`）。 */
  #addState(edge: Omit<ResolvedEdge, 'known'>, depth: number, chainLength: number, preferred: boolean, parent: MutableState | null): CoverageEnqueueResult {
    const inPage = isInPageEdge(edge.edge) ? edge.edge : null;
    const known = inPage === null ? this.#locationKeys.has(edge.locationKey) : this.#seenPairs.has(pairOf(edge.locationKey, inPage.structureKey));
    if (known) {
      return Object.freeze({ status: this.#fill(edge) ? 'RECOVERED' : 'KNOWN', stateId: edge.stateId });
    }
    let trail: MutableTrail | null = null;
    let redacted = edge.redactedUrl !== edge.url;
    if (inPage !== null) {
      if (parent === null) {
        throw new Error('coverage in-page state needs the state it was found from');
      }
      trail = parent.trail === null
        ? { baseStateId: parent.stateId, presses: Object.freeze([freezeStep(inPage.press)]) }
        : { baseStateId: parent.trail.baseStateId, presses: Object.freeze([...parent.trail.presses, freezeStep(inPage.press)]) };
      redacted ||= this.#state(trail.baseStateId).redacted;
      this.#seenPairs.add(pairOf(edge.locationKey, inPage.structureKey));
    }
    this.#locationKeys.add(edge.locationKey);
    this.#states.set(edge.stateId, {
      stateId: edge.stateId,
      locationKey: edge.locationKey,
      kind: edge.edge.kind,
      url: edge.url,
      redactedUrl: edge.redactedUrl,
      redacted,
      frame: edge.edge.frame,
      openedRegion: edge.edge.openedRegion,
      depth,
      chainLength,
      preferred,
      status: 'QUEUED',
      structureKey: null,
      observedStructureKey: inPage?.structureKey ?? null,
      parentStateId: parent?.stateId ?? null,
      trail,
      // COV-2c: 読み戻しで場所の鍵を求め直す、伏せる名前と、押下から生まれた状態の押下の並び。
      redactedQueryNames: isInPageEdge(edge.edge) ? Object.freeze([]) : redactedQueryNamesOf(edge.edge.redactedQueryNames),
      pressTrail: isInPageEdge(edge.edge) ? null : replayStepsOf(edge.edge.pressTrail),
      // COV-2c fix round 4: 凍結の中でだけ読む印（移動の辺の印。ページの中の状態は持たない）。
      frozenRead: !isInPageEdge(edge.edge) && edge.edge.frozenRead === true,
    });
    if (preferred) {
      this.#pending.splice(this.#preferredCount, 0, edge.stateId);
      this.#preferredCount += 1;
    } else {
      this.#pending.push(edge.stateId);
    }
    return Object.freeze({ status: 'QUEUED', stateId: edge.stateId });
  }

  /** 取り出せる最初の待ちの状態の位置（URL の分からない状態は飛ばす）。なければ -1。 */
  #nextPendingIndex(): number {
    return this.#pending.findIndex((id) => this.#state(id).url !== null);
  }

  #item(state: MutableState, rebuild: boolean): CoverageQueueItem {
    const record = recordOfState(state);
    let trail: CoverageTrail | null = null;
    if (record.trail !== null) {
      const baseUrl = this.#state(record.trail.baseStateId).url;
      if (baseUrl === null) {
        throw new Error('coverage in-page state has a base state whose URL is not known');
      }
      trail = { ...record.trail, baseUrl };
    }
    const frozenRequired = isFrozenRequired(state);
    const frozenPath = frozenRequired ? this.#frozenPathOf(state) : null;
    // COV-2c fix round 4: 凍結の外で読み込む URL と事実（凍結の中でだけ読む状態は、たどり始めの祖先。分からなければ `null`）。
    const loadedState = frozenRequired ? (frozenPath === null ? null : this.#frozenRootOf(state)) : state;
    const unfrozenLoad: CoverageUnfrozenLoad | null = loadedState === null || loadedState.url === null
      ? null
      : { url: loadedState.url, frozenRequired: isFrozenRequired(loadedState), redactedQueryNames: loadedState.redactedQueryNames };
    return deepFreeze({ ...record, url: state.url ?? '', redactedUrl: state.redactedUrl, trail, rebuild, frozenRequired, frozenPath, unfrozenLoad });
  }

  /** COV-2c fix round 4: 凍結の中でだけ読む状態の、押下を経ていない最も近い祖先（たどり始め）。なければ `null`。 */
  #frozenRootOf(state: MutableState): MutableState | null {
    let ancestor = state.parentStateId === null ? undefined : this.#states.get(state.parentStateId);
    while (ancestor !== undefined && isFrozenRequired(ancestor)) {
      ancestor = ancestor.parentStateId === null ? undefined : this.#states.get(ancestor.parentStateId);
    }
    return ancestor ?? null;
  }

  /**
   * COV-2c fix round 4（SREV-COV 3 回目の C-1。設計者の判断の 1）: 凍結の中でだけ読む状態のたどり方。たどり始め（押下を経ていない最も近い祖先）の URL と、その子から
   * 親までの、凍結の中でだけ読む祖先の URL の並び。たどり始めがない・途中の URL が分からないときは `null`。
   */
  #frozenPathOf(state: MutableState): CoverageFrozenPath | null {
    const hops: string[] = [];
    let ancestor = state.parentStateId === null ? undefined : this.#states.get(state.parentStateId);
    while (ancestor !== undefined && isFrozenRequired(ancestor)) {
      if (ancestor.url === null) return null;
      hops.unshift(ancestor.url);
      ancestor = ancestor.parentStateId === null ? undefined : this.#states.get(ancestor.parentStateId);
    }
    if (ancestor === undefined || ancestor.url === null) {
      return null;
    }
    return { rootUrl: ancestor.url, hops };
  }

  #state(stateId: string): MutableState {
    const state = this.#states.get(stateId);
    if (state === undefined) {
      throw new Error('coverage state was not queued');
    }
    return state;
  }
}

/** 書き出しのたどり方を確かめる（もとの状態は、先に受け付けた移動の状態）。 */
const restoreTrail = (value: unknown, states: ReadonlyMap<string, MutableState>): MutableTrail | null => {
  if (value === null) {
    return null;
  }
  if (!isRecordValue(value) || typeof value['baseStateId'] !== 'string' || !Array.isArray(value['presses']) || value['presses'].length === 0) {
    throw new RangeError('trail has the wrong shape');
  }
  const base = states.get(value['baseStateId']);
  if (base === undefined || base.trail !== null) {
    throw new RangeError('trail base is not an earlier navigation state');
  }
  const presses = value['presses'].map((step: unknown) => {
    if (!isRecordValue(step)) {
      throw new RangeError('trail step is not an object');
    }
    const restored = { candidateIdentityDigest: step['candidateIdentityDigest'], ordinal: step['ordinal'] } as CoveragePressStep;
    checkPressStep(restored);
    return freezeStep(restored);
  });
  return { baseStateId: base.stateId, presses: Object.freeze(presses) };
};

/** 書き出しの 1 つの状態を確かめて作り直す（場所の鍵と状態の ID は、伏せた URL と印から求め直して比べる）。 */
const restoreState = (value: unknown, index: number, earlier: ReadonlyMap<string, MutableState>): MutableState => {
  const invalid = (problem: string): RangeError => new RangeError(`coverage queue snapshot state ${index}: ${problem}`);
  if (!isRecordValue(value)) {
    throw invalid('not an object');
  }
  const { stateId, locationKey, kind, url, redacted, frame, openedRegion, depth, chainLength, preferred, status, structureKey, observedStructureKey, parentStateId } = value;
  if (!isOneOf(COVERAGE_EDGE_KINDS, kind) || !isOneOf(COVERAGE_STATE_STATUSES, status)) {
    throw invalid('unsupported kind or status');
  }
  if (typeof stateId !== 'string' || typeof locationKey !== 'string') {
    throw invalid('state ID or location key has the wrong type');
  }
  if (typeof url !== 'string' || typeof redacted !== 'boolean' || !isNullableString(frame) || !isNullableString(openedRegion)) {
    throw invalid('URL or markers have the wrong type');
  }
  // COV-2c（SREV-COV の I-4）: 押下の目印の値を伏せた状態は、伏せる名前も使って場所の鍵を求め直す。
  let redactedQueryNames: readonly string[];
  let pressTrail: readonly CoverageReplayStep[] | null;
  try {
    redactedQueryNames = redactedQueryNamesOf(value['redactedQueryNames']);
    pressTrail = replayStepsOf(value['pressTrail']);
  } catch (error) {
    throw invalid(error instanceof Error ? error.message : 'redacted query names or press trail are broken');
  }
  const location = stateLocationKeyOf({ url, frame, openedRegion, redactedQueryNames });
  if (!location.ok || location.redactedUrl !== url || location.key !== locationKey || (!redacted && location.url !== url)) {
    throw invalid('location key does not match the redacted URL and markers');
  }
  if (!isNonNegativeSafeInteger(depth) || !isNonNegativeSafeInteger(chainLength) || typeof preferred !== 'boolean') {
    throw invalid('depth, chain length or preferred mark has the wrong type');
  }
  const read = status === 'READ';
  if (read ? !isSha256Fingerprint(structureKey) : structureKey !== null) {
    throw invalid('only a read state has a structure key');
  }
  if (!isNullableString(parentStateId) || (parentStateId !== null && !earlier.has(parentStateId))) {
    throw invalid('parent is not an earlier state');
  }
  let trail: MutableTrail | null;
  try {
    trail = restoreTrail(value['trail'], earlier);
  } catch (error) {
    throw invalid(error instanceof Error ? error.message : 'trail is broken');
  }
  const inPage = isOneOf(COVERAGE_IN_PAGE_EDGE_KINDS, kind);
  if (inPage) {
    if (!isSha256Fingerprint(observedStructureKey) || trail === null || parentStateId === null || stateId !== inPageStateIdOf(locationKey, observedStructureKey)) {
      throw invalid('in-page state does not match its ID, trail or parent');
    }
  } else if (observedStructureKey !== null || trail !== null || stateId !== locationKey) {
    throw invalid('navigation state does not match its ID');
  }
  if (earlier.has(stateId)) {
    throw invalid('repeats a state ID');
  }
  return {
    stateId,
    locationKey,
    kind,
    url: redacted ? null : url,
    redactedUrl: url,
    redacted,
    frame,
    openedRegion,
    depth,
    chainLength,
    preferred,
    status,
    structureKey: read ? structureKey as string : null,
    observedStructureKey: inPage ? observedStructureKey as string : null,
    parentStateId,
    trail,
    redactedQueryNames,
    pressTrail: inPage ? null : pressTrail,
    // COV-2c fix round 4: 凍結の中でだけ読む印（書き出しにないときは偽。真のほかの値は壊れた書き出し）。
    frozenRead: frozenReadOf(value['frozenRead'], invalid),
  };
};

/** COV-2c fix round 4: 書き出しの凍結の中でだけ読む印（ないときは偽。`true` のほかは壊れた値）。 */
const frozenReadOf = (value: unknown, invalid: (problem: string) => RangeError): boolean => {
  if (value === undefined) return false;
  if (value !== true) throw invalid('frozen read mark has the wrong value');
  return true;
};

/** 書き出しの 1 つの閉じた鎖を確かめる（閉じたところは読み終えた状態）。 */
const restoreClosure = (value: unknown, states: ReadonlyMap<string, MutableState>): CoverageChainClosure => {
  if (!isRecordValue(value)) {
    throw new Error('coverage queue snapshot chain closure is not an object');
  }
  const { stateId, kind, reason, droppedEdgeCount } = value;
  if (typeof stateId !== 'string' || states.get(stateId)?.status !== 'READ') {
    throw new Error('coverage queue snapshot chain closure does not point at a read state');
  }
  if (!isOneOf(COVERAGE_EDGE_KINDS, kind) || !isOneOf(COVERAGE_CHAIN_CLOSE_REASONS, reason) || !isNonNegativeSafeInteger(droppedEdgeCount)) {
    throw new Error('coverage queue snapshot chain closure has unsupported values');
  }
  return Object.freeze({ stateId, kind, reason, droppedEdgeCount });
};
