// C16c（Task 14〜17 の設計書 6.1.1、6.1.9。CC-026）: artifact の JSON の書式の唯一の owner。
// `ArtifactWriter`（run.json、audit.json、page.json）と ChatGPT 用バンドル（ZIP の中の JSON）が、どちらもここを使う。
// 書式は、字下げ2文字、末尾に LF を1つ、CR なし、UTF-8（BOM なし）である。
import { describe, expect, it } from 'vitest';
import { artifactJsonBytes, serializeArtifactJson } from '../../src/report/artifact-json.js';

const SAMPLE = Object.freeze({
  runId: 'RUN-000001',
  label: '日本語のラベル',
  lines: 'first\r\nsecond\rthird\n',
  nested: { values: [1, 'two', null, true] },
  empty: {},
});

const EXPECTED = [
  '{',
  '  "runId": "RUN-000001",',
  '  "label": "日本語のラベル",',
  '  "lines": "first\\r\\nsecond\\rthird\\n",',
  '  "nested": {',
  '    "values": [',
  '      1,',
  '      "two",',
  '      null,',
  '      true',
  '    ]',
  '  },',
  '  "empty": {}',
  '}',
  '',
].join('\n');

describe('artifact JSON format (CC-026)', () => {
  it('indents by two spaces and ends with exactly one LF', () => {
    const text = serializeArtifactJson(SAMPLE);

    expect(text).toBe(EXPECTED);
    expect(text.endsWith('}\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
  });

  it('writes no CR, even when a string value contains CR or CRLF (they are escaped)', () => {
    const text = serializeArtifactJson(SAMPLE);

    expect(text.includes('\r')).toBe(false);
    expect(JSON.parse(text)).toEqual(SAMPLE);
  });

  it('keeps Japanese text as it is (not escaped), and encodes it as UTF-8 without a BOM', () => {
    const bytes = artifactJsonBytes(SAMPLE);

    expect(serializeArtifactJson(SAMPLE)).toContain('日本語のラベル');
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect([...bytes.slice(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes[0]).toBe(0x7b);
    expect(bytes[bytes.length - 1]).toBe(0x0a);
    expect(bytes.includes(0x0d)).toBe(false);
    expect([...bytes]).toEqual([...Buffer.from(EXPECTED, 'utf8')]);
    expect(new TextDecoder('utf-8', { fatal: true }).decode(bytes)).toBe(EXPECTED);
  });

  it('makes the bytes and the string from the same format', () => {
    for (const value of [SAMPLE, [], 'text', 0, null, { a: '改行\n' }]) {
      expect(new TextDecoder('utf-8').decode(artifactJsonBytes(value)), JSON.stringify(value)).toBe(serializeArtifactJson(value));
    }
  });
});
