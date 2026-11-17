/**
 * AUD-4b（整理の文書 `doc/design/2026-11-09-beaksight-audit-precision-triage.md` の AUD-4b）: axe の対象の要素の、AX（ブラウザのアクセシビリティの木）の事実を、CDP の
 * Accessibility から読む唯一の所。
 * - ページの main world で JS を動かさない（`Runtime.evaluate` を使わない。設計者の判断 2026-11-10）。要素は CDP の `DOM.getDocument` と `DOM.querySelector` で引き、
 *   `Accessibility.getPartialAXTree({ nodeId })` と `Accessibility.getChildAXNodes` で読む。サイトへの要求と読み込みは足さない。
 * - session は、ここで開け閉めする（Guard の session とは別）。開いた domain（`DOM`・`Accessibility`）は、閉じる前に disable し、finally で session を切る。
 * - 読むもの: 算出した名前・役割・無効の状態・命名元（使われた命名元。上書きされたものは除く）・見えるラベルの文字のかたまり（要素の下の、無視されない
 *   `StaticText` の名前。木の順。数で切らない）。
 * - 読めないもの: iframe の中（`IN_FRAME`）、shadow root の中（`IN_SHADOW`）、見つからない（`NOT_FOUND`）、命令の失敗（`NOT_READ`）。
 */
import type { CDPSession, Page } from 'playwright';
import type { AccessibilityNameContextEvidence, AccessibilityTargetSelector } from '../core/evidence-types.js';
import { isRecord } from '../core/guards.js';

/** 読み取りの失敗（命令の失敗・形の違い）。 */
class AxReadFailure extends Error {}

const send = async (session: CDPSession, method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
  const result: unknown = await session.send(method as never, params as never);
  if (!isRecord(result)) {
    throw new AxReadFailure(method);
  }
  return result;
};

/** CDP の `AXValue` の値（文字か真偽か。なければ `null`）。 */
const axValueOf = (value: unknown): unknown => (isRecord(value) ? value['value'] ?? null : null);

/** 使われた命名元（上書きされていない、値のある最初のもの）。 */
const nameSourceOf = (name: unknown): { readonly type: string; readonly attribute: string | null } | null => {
  const sources = isRecord(name) && Array.isArray(name['sources']) ? name['sources'] : [];
  for (const source of sources) {
    if (!isRecord(source) || source['superseded'] === true || !isRecord(source['value']) || typeof source['type'] !== 'string') {
      continue;
    }
    return Object.freeze({ type: source['type'], attribute: typeof source['attribute'] === 'string' ? source['attribute'] : null });
  }
  return null;
};

/** AX の節の `disabled` の性質が真か。 */
const disabledOf = (node: Record<string, unknown>): boolean => {
  const properties = Array.isArray(node['properties']) ? node['properties'] : [];
  return properties.some((property) => isRecord(property) && property['name'] === 'disabled' && axValueOf(property['value']) === true);
};

/** 要素の下の、無視されない `StaticText` の名前（木の順）。 */
async function labelSegmentsOf(session: CDPSession, axNodeId: string): Promise<readonly string[]> {
  const segments: string[] = [];
  const visit = async (id: string): Promise<void> => {
    const result = await send(session, 'Accessibility.getChildAXNodes', { id });
    const children = Array.isArray(result['nodes']) ? result['nodes'] : [];
    for (const child of children) {
      if (!isRecord(child) || typeof child['nodeId'] !== 'string') {
        continue;
      }
      const text = axValueOf(child['name']);
      if (axValueOf(child['role']) === 'StaticText' && child['ignored'] !== true && typeof text === 'string') {
        segments.push(text);
      }
      await visit(child['nodeId']);
    }
  };
  await visit(axNodeId);
  return Object.freeze(segments);
}

/** 1 つの要素の AX の事実。 */
async function readOne(session: CDPSession, rootNodeId: number, target: readonly AccessibilityTargetSelector[]): Promise<AccessibilityNameContextEvidence> {
  const [step] = target;
  if (target.length !== 1 || step === undefined) {
    return Object.freeze({ status: 'UNREADABLE', reason: 'IN_FRAME' });
  }
  if (typeof step !== 'string') {
    return Object.freeze({ status: 'UNREADABLE', reason: 'IN_SHADOW' });
  }
  let nodeId: unknown;
  try {
    nodeId = (await send(session, 'DOM.querySelector', { nodeId: rootNodeId, selector: step }))['nodeId'];
  } catch {
    return Object.freeze({ status: 'UNREADABLE', reason: 'NOT_FOUND' });
  }
  if (typeof nodeId !== 'number' || nodeId === 0) {
    return Object.freeze({ status: 'UNREADABLE', reason: 'NOT_FOUND' });
  }
  const tree = await send(session, 'Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false });
  const node = Array.isArray(tree['nodes']) ? tree['nodes'][0] : undefined;
  if (!isRecord(node) || typeof node['nodeId'] !== 'string') {
    throw new AxReadFailure('getPartialAXTree');
  }
  const name = axValueOf(node['name']);
  const role = axValueOf(node['role']);
  return Object.freeze({
    status: 'READ',
    axName: typeof name === 'string' ? name : null,
    axRole: typeof role === 'string' ? role : null,
    axDisabled: disabledOf(node),
    nameSource: nameSourceOf(node['name']),
    labelSegments: await labelSegmentsOf(session, node['nodeId']),
  });
}

/**
 * axe の対象（target の並び）ごとに、AX の事実を読む（例外を投げない。読めなければ理由）。`track` は、進みの見張りの口（命令が返るたびに印を付ける）。
 */
export async function readAccessibilityAxFacts(
  page: Page,
  targets: readonly (readonly AccessibilityTargetSelector[])[],
  track: <T>(work: Promise<T>) => Promise<T> = (work) => work,
): Promise<readonly AccessibilityNameContextEvidence[]> {
  const notRead: AccessibilityNameContextEvidence = Object.freeze({ status: 'UNREADABLE', reason: 'NOT_READ' });
  if (targets.length === 0) {
    return [];
  }
  let session: CDPSession;
  try {
    session = await track(page.context().newCDPSession(page));
  } catch {
    return targets.map(() => notRead);
  }
  const enabled: string[] = [];
  try {
    for (const domain of ['DOM', 'Accessibility']) {
      await track(send(session, `${domain}.enable`));
      enabled.push(domain);
    }
    const document = await track(send(session, 'DOM.getDocument', { depth: 0 }));
    const root = isRecord(document['root']) ? document['root']['nodeId'] : undefined;
    if (typeof root !== 'number') {
      return targets.map(() => notRead);
    }
    const facts: AccessibilityNameContextEvidence[] = [];
    for (const target of targets) {
      try {
        facts.push(await track(readOne(session, root, target)));
      } catch {
        facts.push(notRead);
      }
    }
    return Object.freeze(facts);
  } catch {
    return targets.map(() => notRead);
  } finally {
    // 開いた domain を、開いた逆の順に disable してから、session を切る（失敗しても続ける）。
    for (const domain of [...enabled].reverse()) {
      await send(session, `${domain}.disable`).catch(() => undefined);
    }
    await session.detach().catch(() => undefined);
  }
}
