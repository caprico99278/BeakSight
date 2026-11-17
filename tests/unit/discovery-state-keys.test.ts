// COV-0（設計書 `2026-11-09-beaksight-coverage-by-state-design.md` 3.1）: 状態の鍵（場所の鍵・構造の鍵）の単体テスト。ブラウザを使わない。
import { describe, expect, it } from 'vitest';
import { createSha256Fingerprint, isSha256Fingerprint } from '../../src/core/ids.js';
import { REDACTED } from '../../src/core/redaction.js';
import {
  STATE_LANDMARK_ROLES,
  stateLocationKeyOf,
  stateStructureKeyOf,
  type StateStructureFacts,
} from '../../src/discovery/state-keys.js';

const BASE = 'https://app.example.test';

const locationOf = (url: string, frame: string | null = null, openedRegion: string | null = null) => {
  const result = stateLocationKeyOf({ url, frame, openedRegion });
  if (!result.ok) {
    throw new Error(`rejected: ${result.reason}`);
  }
  return result;
};

describe('stateLocationKeyOf（場所の鍵）', () => {
  it('query の並びの違いは同じ鍵、値の違いは違う鍵', () => {
    const a = locationOf(`${BASE}/list?page=2&sort=name`);
    const b = locationOf(`${BASE}/list?sort=name&page=2`);
    const c = locationOf(`${BASE}/list?page=3&sort=name`);
    expect(a.key).toBe(b.key);
    expect(a.key).not.toBe(c.key);
    expect(isSha256Fingerprint(a.key)).toBe(true);
  });

  it('並びは normalizeUrl の決まり（名前の順。同じ名前の値は書かれた順のまま）', () => {
    expect(locationOf(`${BASE}/f?b=1&a=2&a=1`).url).toBe(`${BASE}/f?a=2&a=1&b=1`);
    expect(locationOf(`${BASE}/f?a=2&a=1`).key).not.toBe(locationOf(`${BASE}/f?a=1&a=2`).key);
  });

  it('path の全体を持つ（番号だけ違う path も違う鍵）。fragment は捨てる', () => {
    expect(locationOf(`${BASE}/items/1`).key).not.toBe(locationOf(`${BASE}/items/2`).key);
    expect(locationOf(`${BASE}/items/1#top`).key).toBe(locationOf(`${BASE}/items/1`).key);
  });

  it('秘密に見える名前の query の値を伏せる（伏せた値どうしは同じ鍵）。伏せない値は残す', () => {
    const a = locationOf(`${BASE}/reset?token=abc123&step=2`);
    const b = locationOf(`${BASE}/reset?step=2&token=zzz999`);
    expect(a.redactedUrl).toContain(`token=${REDACTED}`);
    expect(a.redactedUrl).not.toContain('abc123');
    expect(a.redactedUrl).toContain('step=2');
    expect(a.key).toBe(b.key);
    // 移動に使う URL（伏せる前）は値を持つ。
    expect(a.url).toContain('token=abc123');
  });

  it('frame・開いた枠の印で鍵が変わる', () => {
    const top = locationOf(`${BASE}/a`);
    const framed = locationOf(`${BASE}/a`, 'frame:1');
    const opened = locationOf(`${BASE}/a`, null, 'dialog:1');
    expect(new Set([top.key, framed.key, opened.key]).size).toBe(3);
    expect(locationOf(`${BASE}/a`, 'frame:1').key).toBe(framed.key);
  });

  it('受け入れない URL は理由のコードで返す', () => {
    const result = stateLocationKeyOf({ url: 'mailto:a@example.test', frame: null, openedRegion: null });
    expect(result).toMatchObject({ ok: false, reason: 'UNSUPPORTED_SCHEME' });
    const withCredentials = stateLocationKeyOf({ url: 'https://user:pw@app.example.test/', frame: null, openedRegion: null });
    expect(withCredentials).toMatchObject({ ok: false, reason: 'CREDENTIALS_NOT_ALLOWED' });
  });
});

const BASE_FACTS: StateStructureFacts = {
  path: '/items/12/edit',
  queryNames: ['tab'],
  candidateIdentityDigests: [createSha256Fingerprint('c1'), createSha256Fingerprint('c2')],
  fields: [
    { name: 'title', type: 'text', required: true, disabled: false, optionValues: null },
    { name: 'kind', type: 'select-one', required: false, disabled: false, optionValues: ['a', 'b'] },
  ],
  openedDialogOrRegion: false,
  headingLevels: [1, 2, 2],
  landmarkRoles: ['main', 'navigation'],
  stateWords: ['empty'],
};

const keyOf = (overrides: Partial<StateStructureFacts> = {}): string => stateStructureKeyOf({ ...BASE_FACTS, ...overrides });

describe('stateStructureKeyOf（構造の鍵）', () => {
  it('digest で、文字の値を入れない', () => {
    const key = keyOf();
    expect(isSha256Fingerprint(key)).toBe(true);
    expect(key).not.toContain('title');
    expect(key).not.toContain('items');
  });

  it('番号だけ違う path は同じ型（同じ鍵）。違う path は違う鍵', () => {
    expect(keyOf({ path: '/items/99/edit' })).toBe(keyOf());
    expect(keyOf({ path: '/users/12/edit' })).not.toBe(keyOf());
  });

  it('並びに依らない（集合）', () => {
    expect(keyOf({
      candidateIdentityDigests: [...BASE_FACTS.candidateIdentityDigests!].reverse(),
      fields: [...BASE_FACTS.fields!].reverse().map((field) => (field.optionValues === null ? field : { ...field, optionValues: ['b', 'a'] })),
      headingLevels: [2, 1, 2],
      landmarkRoles: ['navigation', 'main'],
      queryNames: ['tab', 'tab'],
    })).toBe(keyOf());
  });

  it('番号だけ違う名前の欄が増えただけ（行を足す画面）では、同じ鍵（同じ作りの部品）。番号でない名前の違いは違う鍵', () => {
    const row = (name: string): { name: string; type: string; required: boolean; disabled: boolean; optionValues: null } =>
      ({ name, type: 'text', required: false, disabled: false, optionValues: null });
    const oneAdded = keyOf({ fields: [row('cn-0'), row('cy-0'), row('cn-a1'), row('cy-a1')] });
    // 行をもう 1 つ足した（番号だけ違う名前の欄が増えた）状態は、1 つ足した状態と同じ鍵。
    expect(keyOf({ fields: [row('cn-0'), row('cy-0'), row('cn-a1'), row('cy-a1'), row('cn-a2'), row('cy-a2')] })).toBe(oneAdded);
    expect(keyOf({ fields: [row('cn-0'), row('cy-0')] })).toBe(keyOf({ fields: [row('cn-0'), row('cy-0'), row('cn-1'), row('cy-1')] }));
    // 番号でない部分の違う名前は、違う作り。
    expect(keyOf({ fields: [row('cn-0'), row('cy-0')] })).not.toBe(oneAdded);
    expect(keyOf({ fields: [row('company')] })).not.toBe(keyOf({ fields: [row('name')] }));
  });

  it('欄・候補・状態の語・開いた枠・見出し・landmark・query の名前の違いで鍵が変わる', () => {
    const base = keyOf();
    const variants = [
      keyOf({ fields: [{ ...BASE_FACTS.fields![0]!, required: false }, BASE_FACTS.fields![1]!] }),
      keyOf({ fields: [BASE_FACTS.fields![0]!, { ...BASE_FACTS.fields![1]!, optionValues: ['a', 'b', 'c'] }] }),
      keyOf({ fields: [{ ...BASE_FACTS.fields![0]!, disabled: true }, BASE_FACTS.fields![1]!] }),
      keyOf({ fields: [{ ...BASE_FACTS.fields![0]!, type: 'email' }, BASE_FACTS.fields![1]!] }),
      keyOf({ candidateIdentityDigests: [createSha256Fingerprint('c1')] }),
      keyOf({ stateWords: ['error'] }),
      keyOf({ openedDialogOrRegion: true }),
      keyOf({ headingLevels: [1] }),
      keyOf({ landmarkRoles: ['main'] }),
      keyOf({ queryNames: ['tab', 'page'] }),
    ];
    expect(new Set([base, ...variants]).size).toBe(variants.length + 1);
  });

  it('COV-2c（SREV-COV の I-1）: 同じ作りの見出し・landmark・欄・候補が増えただけでは、同じ鍵（数でなく作りの集合）', () => {
    expect(keyOf({ headingLevels: [1, 2, 2, 2, 2, 2] })).toBe(keyOf());
    expect(keyOf({ headingLevels: [1, 2] })).toBe(keyOf());
    expect(keyOf({ landmarkRoles: ['main', 'navigation', 'navigation'] })).toBe(keyOf());
    expect(keyOf({ fields: [...BASE_FACTS.fields!, BASE_FACTS.fields![0]!, BASE_FACTS.fields![0]!] })).toBe(keyOf());
    expect(keyOf({ candidateIdentityDigests: [...BASE_FACTS.candidateIdentityDigests!, createSha256Fingerprint('c1')] })).toBe(keyOf());
    // 新しい作り（新しい段の見出し）は違う鍵。
    expect(keyOf({ headingLevels: [1, 2, 3] })).not.toBe(keyOf());
  });

  it('欠けた入力は空と違う鍵になる（欠けた項目ごとに違う）', () => {
    expect(keyOf({ fields: null })).not.toBe(keyOf({ fields: [] }));
    expect(keyOf({ candidateIdentityDigests: null })).not.toBe(keyOf({ candidateIdentityDigests: [] }));
    expect(keyOf({ stateWords: null })).not.toBe(keyOf({ stateWords: [] }));
    expect(keyOf({ headingLevels: null })).not.toBe(keyOf({ headingLevels: [] }));
    expect(keyOf({ openedDialogOrRegion: null })).not.toBe(keyOf({ openedDialogOrRegion: false }));
    expect(keyOf({ path: null })).not.toBe(keyOf({ path: '' }));
    expect(keyOf({ fields: null })).not.toBe(keyOf({ stateWords: null }));
  });

  it('文字の値が入り込む入力を拒む（候補は digest、見出しは段 1〜6、landmark は閉じた一覧）', () => {
    expect(() => keyOf({ candidateIdentityDigests: ['保存する'] })).toThrow(RangeError);
    expect(() => keyOf({ headingLevels: [7] })).toThrow(RangeError);
    expect(() => keyOf({ landmarkRoles: ['お知らせ'] })).toThrow(RangeError);
    expect(STATE_LANDMARK_ROLES).toContain('main');
  });
});

describe('COV-2: 状態の語の閉じた一覧', () => {
  it('凍結した、重なりのない、空でない一覧', async () => {
    const { STATE_WORDS } = await import('../../src/discovery/state-keys.js');
    expect(Object.isFrozen(STATE_WORDS)).toBe(true);
    expect(STATE_WORDS.length).toBeGreaterThan(0);
    expect(new Set(STATE_WORDS).size).toBe(STATE_WORDS.length);
    expect(STATE_WORDS).toEqual(expect.arrayContaining(['取り消し済み', '確定']));
    for (const word of STATE_WORDS) expect(word).toBe(word.trim().toLowerCase());
  });
});
