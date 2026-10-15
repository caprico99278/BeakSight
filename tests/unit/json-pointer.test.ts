// CCX-25（CC-087 の前半）: JSON Pointer（RFC 6901）の区切りの書き方と戻し方の部品（`src/core/json-pointer.ts`）。
import { describe, expect, it } from 'vitest';
import {
  JSON_POINTER_SEPARATOR,
  escapeJsonPointerSegment,
  jsonPointerOf,
  jsonPointerSegmentsOf,
  unescapeJsonPointerSegment,
} from '../../src/core/json-pointer.js';

describe('CCX-25: the JSON Pointer segments (RFC 6901)', () => {
  it('escapes "~" before "/" and unescapes "~1" before "~0"', () => {
    expect(JSON_POINTER_SEPARATOR).toBe('/');
    expect(escapeJsonPointerSegment('a/b~c')).toBe('a~1b~0c');
    expect(escapeJsonPointerSegment('~/~1')).toBe('~0~1~01');
    expect(escapeJsonPointerSegment('plain')).toBe('plain');
    // RFC 6901 の 4 章の例: `~01` は `~1` に戻す（`/` にしない）。
    expect(unescapeJsonPointerSegment('~01')).toBe('~1');
    expect(unescapeJsonPointerSegment('a~1b~0c')).toBe('a/b~c');
  });

  it('builds a pointer from segments and reads the segments back', () => {
    const segments = ['loginPostEndpoints', '0', 'a/b~c', '', '~1'];
    const pointer = jsonPointerOf(segments);

    expect(pointer).toBe('/loginPostEndpoints/0/a~1b~0c//~01');
    expect(jsonPointerSegmentsOf(pointer)).toEqual(segments);
    expect(jsonPointerOf([])).toBe('');
    expect(jsonPointerSegmentsOf('')).toEqual([]);
    expect(jsonPointerSegmentsOf('/')).toEqual(['']);
  });
});
