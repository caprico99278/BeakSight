/**
 * COV-4（網羅の設計書 `doc/design/2026-11-09-beaksight-coverage-by-state-design.md` 3.1 の 2・3.2）: 見るだけの点検で読んだページの、構造の鍵と辺（巡回の待ち行列
 * `CrawlFrontier.completePage` の入力）。
 * - 設計者の判断（2026-11-10）: 構造の鍵は、監査の段がもう集めた記録から `stateStructureKeyOf` の入力を組む（要求とページの中の読み取りは増やさない）。発見の側の
 *   構造の鍵と同じ値でなくてよい。欄の名前の型と path の型は、`stateStructureKeyOf` の中の共通の部品が作る。
 *   - 使う記録: Desktop の最終の試行の DOM の Evidence（確かめ直しの段のものは除く）。見出しの段、区分（landmark）、form の欄、見える文字の状態の語。
 *   - 持たない事実（`null`。欠けとして鍵に入る）: 候補の識別（見るだけの点検の操作の候補は、区切り 3 で入れる）、開いた窓・区画。欄の無効（記録にないので偽）・
 *     選択肢（記録にないので `null`）。
 *   - DOM の記録のないページ（読めなかった）は `UNREAD_PAGE_STRUCTURE_KEY`。
 * - 辺: 各ビューポートの Link の Evidence の、巡回で移るリンク（`crawlableLinkUrlsOf`）と、同じ Origin の子の frame の文書（`frames`）。
 */
import type { PageAuditResult } from '../core/contracts.js';
import type { DomEvidence, SemanticRegionKind } from '../core/evidence-types.js';
import { createSha256Fingerprint } from '../core/ids.js';
import { foldNfkcCase } from '../core/text.js';
import { crawlableLinkUrlsOf } from '../crawl/internal-navigable-links.js';
import { normalizeUrl } from '../crawl/normalize-url.js';
import { STATE_WORDS, stateStructureKeyOf, type StateLandmarkRole } from '../discovery/state-keys.js';
import { UNREAD_PAGE_STRUCTURE_KEY, type CrawlPageEdge, type CrawlPageOutcome } from './crawl-frontier.js';

/** 区分の種類から landmark の role（`other` は landmark でない）。 */
const LANDMARK_ROLE_OF_REGION: Readonly<Record<SemanticRegionKind, StateLandmarkRole | null>> = Object.freeze({
  header: 'banner',
  navigation: 'navigation',
  main: 'main',
  aside: 'complementary',
  footer: 'contentinfo',
  form: 'form',
  other: null,
});

/** ページの結果の、Desktop の最終の DOM の記録（確かめ直しの段のものは除く。なければ `null`）。 */
const desktopDomOf = (result: PageAuditResult): DomEvidence | null => {
  // 再試行の前の試行の記録は前に並ぶので、最後のものを使う。
  let found: DomEvidence | null = null;
  for (const record of result.evidence) {
    if (record.type === 'dom' && record.viewport === 'desktop' && record.capture?.phase !== 'recheck') {
      found = record.payload;
    }
  }
  return found;
};

/** URL の path と query の名前（解析できなければ `null`）。 */
const pathAndQueryNamesOf = (url: string): { readonly path: string; readonly queryNames: readonly string[] } | null => {
  try {
    const parsed = new URL(url);
    return { path: parsed.pathname, queryNames: [...new Set(parsed.searchParams.keys())] };
  } catch {
    return null;
  }
};

/**
 * DOM の記録と URL から、構造の鍵を作る（ページと開いた状態の共通の組み立て）。候補の識別は、操作の候補の ID（`candidateId`）の集合を digest にして入れる
 * （設計者の判断 2026-11-10。分からなければ `null`）。`visibleFieldsOnly` が真なら、見えている入力欄だけを入れる（開いた状態は、隠れていた入力欄が見えるように
 * なったら別の構造にする。入れ子の区画を見落とさない）。
 */
function structureKeyOfDom(
  dom: DomEvidence,
  url: string,
  facts: {
    readonly openedDialogOrRegion: boolean | null;
    readonly candidateIds: readonly string[] | null;
    readonly visibleFieldsOnly?: boolean;
  },
): string {
  const location = pathAndQueryNamesOf(url);
  const text = foldNfkcCase(dom.visibleText.text);
  const fields = [...dom.forms.flatMap((form) => form.fields), ...dom.unassociatedFields]
    .filter((field) => facts.visibleFieldsOnly !== true || field.visible);
  return stateStructureKeyOf({
    path: location?.path ?? null,
    queryNames: location?.queryNames ?? null,
    candidateIdentityDigests: facts.candidateIds === null ? null : [...new Set(facts.candidateIds)].map((id) => createSha256Fingerprint(id)),
    fields: fields.map((field) => ({ name: field.name, type: field.type, required: field.required, disabled: false, optionValues: null })),
    openedDialogOrRegion: facts.openedDialogOrRegion,
    headingLevels: dom.headings.map(({ level }) => level),
    landmarkRoles: dom.visibleText.regions.flatMap(({ kind }) => {
      const role = LANDMARK_ROLE_OF_REGION[kind];
      return role === null ? [] : [role];
    }),
    stateWords: STATE_WORDS.filter((word) => text.includes(foldNfkcCase(word))),
  });
}

/** 読んだページの構造の鍵（ファイルの先頭の説明。候補の識別は、Desktop の操作の記録の候補の ID。操作の記録がなければ `null`）。 */
export function auditPageStructureKeyOf(result: PageAuditResult): string {
  const dom = desktopDomOf(result);
  if (dom === null) {
    return UNREAD_PAGE_STRUCTURE_KEY;
  }
  const candidateIds = result.evidence.flatMap((record) =>
    (record.type === 'interaction' && record.viewport === 'desktop' ? [record.payload.candidateId] : []));
  return structureKeyOfDom(dom, result.pageUrl, { openedDialogOrRegion: null, candidateIds: candidateIds.length === 0 ? null : candidateIds });
}

/**
 * COV-4 の区切り 3: 操作で開いた状態の構造の鍵（ページの構造の鍵の入力に、開いた窓・区画があることと、押した候補の識別を足したもの）。同じ鍵の状態は、Run の
 * 全体で 1 回だけ監査する（見た鍵の集合は `CrawlFrontier.acceptOpenedStructure`）。
 */
export function openedStateStructureKeyOf(dom: DomEvidence, url: string, pressedCandidateIds: readonly string[]): string {
  return structureKeyOfDom(dom, url, { openedDialogOrRegion: true, candidateIds: pressedCandidateIds, visibleFieldsOnly: true });
}

/** COV-4 の区切り 3: 操作の後の URL が、ページの URL と比べて path が違えば SPA の経路、query だけが違えば query の変化（同じなら辺にしない）。 */
const interactionEdgeOf = (pageUrl: string, postInteractionUrl: string): CrawlPageEdge | null => {
  const normalized = normalizeUrl(postInteractionUrl, pageUrl, NO_SELECTED_QUERY_NAMES);
  if (!normalized.ok || normalized.url === pageUrl) {
    return null;
  }
  // 受け入れ（許可 Origin の中か）は、巡回の待ち行列に渡す前に、受け入れの判定の唯一の入口（`classifyUrl`）で行う（Run Coordinator）。
  try {
    return { kind: new URL(pageUrl).pathname === new URL(normalized.url).pathname ? 'QUERY_CHANGE' : 'SPA_ROUTE', url: normalized.url };
  } catch {
    return null;
  }
};

/** 残す query の名前を選ばない正規化（L14: 追跡と秘密に見える名前のほかは全部残す）。 */
const NO_SELECTED_QUERY_NAMES: ReadonlySet<string> = new Set();

/**
 * 読んだページの事実（構造の鍵と辺。辺は、記録の順に、各ビューポートのリンクの記録のリンクと frame、操作の記録の操作の後の URL。重なりは待ち行列が除く）。
 * L5 の N5: Mobile のビューポートのリンクの記録も辺にする（Mobile にだけある導線を見落とさない）。COV-4 の区切り 3: 操作で文書が替わらずに URL が変わったら、
 * SPA の経路か query の変化の辺にする。
 */
export function auditPageOutcomeOf(result: PageAuditResult): CrawlPageOutcome {
  const edges: CrawlPageEdge[] = [];
  for (const record of result.evidence) {
    if (record.type === 'link') {
      // SD-1（設計書 2026-11-16 2.3）: 削除の語のリンク（文字か URL）へは移らない（`crawlableLinkUrlsOf`）。
      edges.push(...crawlableLinkUrlsOf(record.payload.links).map((url): CrawlPageEdge => ({ kind: 'LINK', url })));
      edges.push(...(record.payload.frames ?? []).map((url): CrawlPageEdge => ({ kind: 'FRAME', url })));
    } else if (record.type === 'interaction' && record.payload.postInteractionUrl !== undefined) {
      const edge = interactionEdgeOf(result.pageUrl, record.payload.postInteractionUrl);
      if (edge !== null) {
        edges.push(edge);
      }
    }
  }
  return { structureKey: auditPageStructureKeyOf(result), edges };
}
