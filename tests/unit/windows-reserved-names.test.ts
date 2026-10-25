/**
 * CC-101（T43R-fix-D2）: Windows の予約されたデバイス名の一覧の owner を、`node:` の部品を読まない純粋な core のファイル
 * （`src/core/windows-reserved-names.ts`）に分けた。成果物のパスの決まり（`artifact-layout.ts`）と、開始の URL から作る対象の設定のファイルの名前の
 * 決まり（`target-config-draft.ts`。画面のブラウザ側も読む）が、同じ一覧を読む（写さない）。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { WINDOWS_RESERVED_DEVICE_NAMES as LAYOUT_NAMES } from '../../src/core/artifact-layout.js';
import { WINDOWS_RESERVED_DEVICE_NAMES, isWindowsReservedDeviceName } from '../../src/core/windows-reserved-names.js';

describe('CC-101: the Windows reserved device names', () => {
  it('is the one list that artifact-layout.ts also gives (the same frozen array, not a copy)', () => {
    expect(LAYOUT_NAMES).toBe(WINDOWS_RESERVED_DEVICE_NAMES);
    expect(Object.isFrozen(WINDOWS_RESERVED_DEVICE_NAMES)).toBe(true);
    expect(WINDOWS_RESERVED_DEVICE_NAMES).toEqual(expect.arrayContaining(['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'COM9', 'LPT1', 'LPT9', 'CONIN$', 'CONOUT$']));
  });

  it('finds a reserved name whatever the letter case', () => {
    for (const name of ['con', 'NUL', 'Aux', 'prn', 'com1', 'lpt9', 'conin$']) {
      expect(isWindowsReservedDeviceName(name), name).toBe(true);
    }
    for (const name of ['console', 'con1', 'com10', 'nul-site', '', 'a']) {
      expect(isWindowsReservedDeviceName(name), name).toBe(false);
    }
  });

  it('does not load node: modules (the browser side reads it)', () => {
    const source = readFileSync('src/core/windows-reserved-names.ts', 'utf8');
    expect(source).not.toMatch(/from\s+['"]node:/u);
    expect(source).not.toMatch(/^import\s/mu);
  });
});
