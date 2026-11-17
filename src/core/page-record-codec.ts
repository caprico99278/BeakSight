/**
 * REC-3（設計書 `2026-11-14-beaksight-slim-and-simplify-design.md` 5.3）: page.json と保存のページの、ディスクの形の唯一の owner（純粋な関数だけ）。
 * - メモリの形（`PageAuditResult`。`page-schema/1.1`）は変えない。書くとき（`ArtifactWriter` の page.json と保存のページ）に符号化し、ディスクから読むとき
 *   （保存のページ）に戻す。符号化は伏せ字の後に行い、値を消すか番号で指すだけで、新しい文字列を作らない。
 * - 形は種類ごとに決まっている（`schemas/page.schema.json` の `layoutEvidenceRecord`・`accessibilityRuleRecord`・`factoredList`・`sameAsRef`）。
 *   - 同じ欄の繰り返し（案 1）: layout の一覧（`LAYOUT_FACTORED_LISTS`）と、axe のルールの要素（`nodes`）は、全部の項目で同じ値の欄を `common` に 1 回だけ
 *     書き、項目は違う欄だけにする（`{ keys, common, items }`。`keys` は欄の並び。項目が 2 つ未満・欄の並びが違う・同じ欄がないときは配列のまま）。
 *   - 重なりの要素の表（案 2）: `elementOverlaps` の `first`・`second` は、layout の `overlapElements`（同じ要素は 1 回）の番号にする。
 *   - 確かめ直しの違い（案 3）: 確かめ直し（`capture.phase` が `recheck`）の layout・axe は、同じ状態・同じビューポートの 1 回目の記録（`recheckBase` に
 *     ID）と比べ、同じ項目は 1 回目の一覧の番号（`{ sameAs }`）にする。比べるのは項目の JSON の全体。
 * - findings は符号化しない。Evidence の並び（`/evidence/<i>`）は変えない。
 */
import type { EvidenceRecord, PageAuditResult } from './contracts.js';
import { PAGE_RECORD_SCHEMA_VERSION, PAGE_SCHEMA_VERSION } from './evidence-types.js';
import { isRecord } from './guards.js';

type JsonRecord = Record<string, unknown>;

/** ディスクの形の page（`page-schema/2.0`）。Evidence の layout と axe の payload が、符号化した形。 */
export type PageRecord = Omit<PageAuditResult, 'schemaVersion' | 'evidence'> & {
  readonly schemaVersion: typeof PAGE_RECORD_SCHEMA_VERSION;
  readonly evidence: readonly unknown[];
};

/** 同じ欄を 1 回だけ書く layout の一覧。 */
const LAYOUT_FACTORED_LISTS = Object.freeze(['boxesOutsideViewport', 'zeroSizeInteractive', 'clippedText', 'fixedHeadingOverlaps', 'fixedElements'] as const);
/** axe のルールの一覧。 */
const ACCESSIBILITY_RULE_LISTS = Object.freeze(['violations', 'incomplete'] as const);
/** 確かめ直しの記録の、1 回目の記録の ID の欄。 */
const RECHECK_BASE = 'recheckBase';
/** 重なりの要素の表の欄。 */
const OVERLAP_ELEMENTS = 'overlapElements';

const jsonOf = (value: unknown): string | undefined => JSON.stringify(value);

const sameKeys = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((key, index) => key === right[index]);

/** 案 1: 全部の項目で同じ値の欄を `common` に 1 回だけ書く（書けなければ配列のまま）。 */
function factorList(items: readonly unknown[]): unknown {
  const records = items.filter(isRecord);
  const [first] = records;
  if (first === undefined || records.length < 2 || records.length !== items.length) {
    return items;
  }
  const keys = Object.keys(first);
  if (!records.every((item) => sameKeys(Object.keys(item), keys))) {
    return items;
  }
  const common: JsonRecord = {};
  for (const key of keys) {
    const value = jsonOf(first[key]);
    if (value !== undefined && records.every((item) => jsonOf(item[key]) === value)) {
      common[key] = first[key];
    }
  }
  if (Object.keys(common).length === 0) {
    return items;
  }
  return {
    keys,
    common,
    items: records.map((item) => Object.fromEntries(Object.entries(item).filter(([key]) => !(key in common)))),
  };
}

/** `factorList` を戻す（配列はそのまま）。欄の並びは `keys` のまま。 */
function unfactorList(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (!isRecord(value) || !Array.isArray(value['keys']) || !isRecord(value['common']) || !Array.isArray(value['items'])) {
    throw new TypeError('the factored list of the page record is broken');
  }
  const keys = value['keys'] as readonly string[];
  const common = value['common'];
  return (value['items'] as unknown[]).map((item) => {
    const own = isRecord(item) ? item : {};
    const restored: JsonRecord = {};
    for (const key of keys) {
      if (key in own) {
        restored[key] = own[key];
      } else if (key in common) {
        restored[key] = common[key];
      }
    }
    return restored;
  });
}

const isSameAsRef = (value: unknown): value is { readonly sameAs: number } =>
  isRecord(value) && Object.keys(value).length === 1 && typeof value['sameAs'] === 'number';

/** 案 3: 1 回目の一覧（`base`）と JSON の全体が同じ項目は、1 回目の番号にする。 */
function diffList(items: readonly unknown[], base: readonly unknown[], encodeOther: (item: unknown) => unknown = (item) => item): unknown[] {
  const indexes = new Map<string | undefined, number>();
  base.forEach((item, index) => {
    const key = jsonOf(item);
    if (!indexes.has(key)) {
      indexes.set(key, index);
    }
  });
  return items.map((item) => {
    const index = indexes.get(jsonOf(item));
    return index === undefined ? encodeOther(item) : { sameAs: index };
  });
}

/** `diffList` を戻す。 */
function undiffList(items: unknown, base: readonly unknown[], decodeOther: (item: unknown) => unknown = (item) => item): unknown[] {
  if (!Array.isArray(items)) {
    throw new TypeError('the rechecked list of the page record is broken');
  }
  return items.map((item) => {
    if (!isSameAsRef(item)) {
      return decodeOther(item);
    }
    if (!(item.sameAs in base)) {
      throw new RangeError('the rechecked list of the page record refers to a missing item');
    }
    return base[item.sameAs];
  });
}

const listOf = (record: JsonRecord, name: string): readonly unknown[] => {
  const value = record[name];
  return Array.isArray(value) ? value : [];
};

/** 1 つの layout（`LayoutEvidence`）を符号化する（`base` は、確かめ直しの 1 回目の layout）。 */
function encodeLayout(layout: JsonRecord, base: JsonRecord | null): JsonRecord {
  const encoded: JsonRecord = { ...layout };
  for (const name of LAYOUT_FACTORED_LISTS) {
    encoded[name] = base === null ? factorList(listOf(layout, name)) : diffList(listOf(layout, name), listOf(base, name));
  }
  // 案 2: 重なりの要素の表。
  const table: unknown[] = [];
  const tableIndexes = new Map<string | undefined, number>();
  const indexOf = (element: unknown): number => {
    const key = jsonOf(element);
    const known = tableIndexes.get(key);
    if (known !== undefined) {
      return known;
    }
    tableIndexes.set(key, table.length);
    table.push(element);
    return table.length - 1;
  };
  const indexed = (overlap: unknown): unknown =>
    (isRecord(overlap) ? { ...overlap, first: indexOf(overlap['first']), second: indexOf(overlap['second']) } : overlap);
  const overlaps = listOf(layout, 'elementOverlaps');
  encoded['elementOverlaps'] = base === null ? overlaps.map(indexed) : diffList(overlaps, listOf(base, 'elementOverlaps'), indexed);
  if (table.length > 0) {
    encoded[OVERLAP_ELEMENTS] = table;
  }
  return encoded;
}

/** `encodeLayout` を戻す。 */
function decodeLayout(encoded: JsonRecord, base: JsonRecord | null): JsonRecord {
  const { [OVERLAP_ELEMENTS]: tableValue, ...layout } = encoded;
  const table = Array.isArray(tableValue) ? tableValue : [];
  const element = (index: unknown): unknown => {
    if (typeof index !== 'number' || !(index in table)) {
      throw new RangeError('the overlap of the page record refers to a missing element');
    }
    return table[index];
  };
  for (const name of LAYOUT_FACTORED_LISTS) {
    layout[name] = base === null ? unfactorList(layout[name]) : undiffList(layout[name], listOf(base, name));
  }
  const restored = (overlap: unknown): unknown =>
    (isRecord(overlap) ? { ...overlap, first: element(overlap['first']), second: element(overlap['second']) } : overlap);
  const overlaps = layout['elementOverlaps'];
  layout['elementOverlaps'] = base === null
    ? (Array.isArray(overlaps) ? overlaps.map(restored) : [])
    : undiffList(overlaps, listOf(base, 'elementOverlaps'), restored);
  return layout;
}

/** layout の収集の結果（`LayoutCollectionResult` か幅の結果）の `layout` を、`transform` で変える（`layout` がなければそのまま）。 */
const withLayout = (result: unknown, transform: (layout: JsonRecord) => JsonRecord): unknown =>
  (isRecord(result) && isRecord(result['layout']) ? { ...result, layout: transform(result['layout']) } : result);

/** 主の layout（`primary.layout`。なければ null）。 */
const primaryLayoutOf = (payload: JsonRecord | null): JsonRecord | null => {
  const primary = payload?.['primary'];
  return isRecord(primary) && isRecord(primary['layout']) ? primary['layout'] : null;
};

/** layout の Evidence の payload（`LayoutEvidencePayload`）を符号化・復号する（`base` は、確かめ直しの 1 回目の payload）。 */
function codeLayoutPayload(payload: JsonRecord, base: JsonRecord | null, code: (layout: JsonRecord, base: JsonRecord | null) => JsonRecord): JsonRecord {
  const baseLayout = primaryLayoutOf(base);
  const coded: JsonRecord = { ...payload, primary: withLayout(payload['primary'], (layout) => code(layout, baseLayout)) };
  if (Array.isArray(payload['stressSweep'])) {
    coded['stressSweep'] = payload['stressSweep'].map((result) => withLayout(result, (layout) => code(layout, null)));
  }
  if ('beforeNotificationDismissal' in payload) {
    coded['beforeNotificationDismissal'] = withLayout(payload['beforeNotificationDismissal'], (layout) => code(layout, null));
  }
  return coded;
}

/** axe のルール 1 つの要素を符号化・復号する。 */
const encodeRule = (rule: unknown): unknown => (isRecord(rule) ? { ...rule, nodes: factorList(listOf(rule, 'nodes')) } : rule);
const decodeRule = (rule: unknown): unknown => (isRecord(rule) ? { ...rule, nodes: unfactorList(rule['nodes']) } : rule);

/** axe の Evidence の payload を符号化する（`base` は、確かめ直しの 1 回目の payload）。 */
function encodeAccessibility(payload: JsonRecord, base: JsonRecord | null): JsonRecord {
  const encoded: JsonRecord = { ...payload };
  for (const name of ACCESSIBILITY_RULE_LISTS) {
    const rules = listOf(payload, name);
    encoded[name] = base === null ? rules.map(encodeRule) : diffList(rules, listOf(base, name), encodeRule);
  }
  return encoded;
}

/** `encodeAccessibility` を戻す。 */
function decodeAccessibility(encoded: JsonRecord, base: JsonRecord | null): JsonRecord {
  const payload: JsonRecord = { ...encoded };
  for (const name of ACCESSIBILITY_RULE_LISTS) {
    payload[name] = base === null ? listOf(encoded, name).map(decodeRule) : undiffList(encoded[name], listOf(base, name), decodeRule);
  }
  return payload;
}

const isCodedType = (type: unknown): boolean => type === 'layout' || type === 'accessibility';

/** 確かめ直しの記録の、1 回目の記録（同じ種類・同じビューポート・同じ状態の、前にある確かめ直しでない記録。なければ null）。 */
function recheckBaseOf(evidence: readonly EvidenceRecord[], index: number): EvidenceRecord | null {
  const record = evidence[index];
  const stateId = record?.capture?.stateId;
  if (record === undefined || record.capture?.phase !== 'recheck' || stateId === undefined) {
    return null;
  }
  for (let candidate = index - 1; candidate >= 0; candidate -= 1) {
    const earlier = evidence[candidate];
    if (
      earlier !== undefined && earlier.type === record.type && earlier.viewport === record.viewport
      && earlier.capture?.phase !== 'recheck' && earlier.capture?.stateId === stateId
    ) {
      return earlier;
    }
  }
  return null;
}

/** Evidence の並びを符号化する（並びと、layout・axe 以外の記録は変えない）。 */
export function encodeEvidenceList(evidence: readonly EvidenceRecord[]): unknown[] {
  return evidence.map((record, index) => {
    if (!isCodedType(record.type)) {
      return record;
    }
    const base = recheckBaseOf(evidence, index);
    const payload = record.payload as unknown as JsonRecord;
    const basePayload = base === null ? null : base.payload as unknown as JsonRecord;
    const encoded = record.type === 'layout'
      ? codeLayoutPayload(payload, basePayload, encodeLayout)
      : encodeAccessibility(payload, basePayload);
    return base === null ? { ...record, payload: encoded } : { ...record, payload: encoded, [RECHECK_BASE]: base.evidenceId };
  });
}

/** `encodeEvidenceList` を戻す（1 回目の記録は、確かめ直しの記録より前にある）。 */
export function decodeEvidenceList(encoded: readonly unknown[]): EvidenceRecord[] {
  const decoded: EvidenceRecord[] = [];
  const byId = new Map<unknown, JsonRecord>();
  for (const item of encoded) {
    if (!isRecord(item) || !isCodedType(item['type'])) {
      decoded.push(item as EvidenceRecord);
      if (isRecord(item)) byId.set(item['evidenceId'], item);
      continue;
    }
    const { [RECHECK_BASE]: baseId, ...record } = item;
    const base = baseId === undefined ? null : byId.get(baseId);
    if (base === undefined) {
      throw new RangeError('the rechecked Evidence of the page record refers to a missing Evidence');
    }
    const payload = record['payload'] as JsonRecord;
    const basePayload = base === null ? null : base['payload'] as JsonRecord;
    record['payload'] = item['type'] === 'layout'
      ? codeLayoutPayload(payload, basePayload, decodeLayout)
      : decodeAccessibility(payload, basePayload);
    decoded.push(record as unknown as EvidenceRecord);
    byId.set(record['evidenceId'], record);
  }
  return decoded;
}

/** page（メモリの形）を、ディスクの形（`page-schema/2.0`）にする。 */
export const encodePageRecord = (page: PageAuditResult): PageRecord => ({
  ...page,
  schemaVersion: PAGE_RECORD_SCHEMA_VERSION,
  evidence: encodeEvidenceList(page.evidence),
});

/** ディスクの形の page を、メモリの形（`page-schema/1.1`）に戻す。 */
export const decodePageRecord = (record: PageRecord): PageAuditResult => ({
  ...record,
  schemaVersion: PAGE_SCHEMA_VERSION,
  evidence: decodeEvidenceList(record.evidence),
});

/** 保存のページ（`result` と `retryEvidence` を持つ値）の、`result` と `retryEvidence` を符号化する（ほかの欄は変えない）。 */
export function encodeCheckpointPageRecord<T>(page: T): T {
  if (!isRecord(page)) {
    return page;
  }
  const encoded: JsonRecord = { ...page };
  if (isRecord(page['result'])) {
    encoded['result'] = encodePageRecord(page['result'] as unknown as PageAuditResult);
  }
  if (Array.isArray(page['retryEvidence'])) {
    encoded['retryEvidence'] = encodeEvidenceList(page['retryEvidence'] as EvidenceRecord[]);
  }
  return encoded as T;
}

/** `encodeCheckpointPageRecord` を戻す。 */
export function decodeCheckpointPageRecord<T>(page: T): T {
  if (!isRecord(page)) {
    return page;
  }
  const decoded: JsonRecord = { ...page };
  if (isRecord(page['result'])) {
    decoded['result'] = decodePageRecord(page['result'] as unknown as PageRecord);
  }
  if (Array.isArray(page['retryEvidence'])) {
    decoded['retryEvidence'] = decodeEvidenceList(page['retryEvidence']);
  }
  return decoded as T;
}
