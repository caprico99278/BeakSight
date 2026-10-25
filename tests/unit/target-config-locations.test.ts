/**
 * T43b fix round 1（共通化）: 対象の設定のファイルの置き場所の owner（`src/control/target-config-locations.ts`）と、URL の fragment の判定の
 * owner（`src/core/url-fragment.ts`）。
 * - 置き場所: プロファイルが参照してよいフォルダは `config/targets/` と `local/targets/`、拡張子は `.json`。`isAcceptedTargetConfigPath` は
 *   この定数で判定する（振る舞いは前と同じ）。
 * - fragment: `#` を含む値は fragment を持つ（空の fragment を含む）。開始の URL の決まり（`target-config-draft.ts`）と、認証の設定の URL の
 *   決まり（`auth-setup-policy.ts`）が、同じ関数を使う。
 */
import { describe, expect, it } from 'vitest';
import { startUrlProblemOf } from '../../src/config/target-config-draft.js';
import { hasUrlFragment } from '../../src/core/url-fragment.js';
import { isAcceptedTargetConfigPath } from '../../src/control/profile-policy.js';
import {
  CANONICAL_TARGET_CONFIG_DIRECTORY,
  LOCAL_TARGET_CONFIG_DIRECTORY,
  TARGET_CONFIG_DIRECTORIES,
  TARGET_CONFIG_EXTENSION,
} from '../../src/control/target-config-locations.js';

describe('T43b fix round 1: the target configuration places', () => {
  it('keeps the two folders and the extension', () => {
    expect(CANONICAL_TARGET_CONFIG_DIRECTORY).toBe('config/targets/');
    expect(LOCAL_TARGET_CONFIG_DIRECTORY).toBe('local/targets/');
    expect(TARGET_CONFIG_DIRECTORIES).toEqual([CANONICAL_TARGET_CONFIG_DIRECTORY, LOCAL_TARGET_CONFIG_DIRECTORY]);
    expect(TARGET_CONFIG_EXTENSION).toBe('.json');
    expect(Object.isFrozen(TARGET_CONFIG_DIRECTORIES)).toBe(true);
  });

  it('is what isAcceptedTargetConfigPath accepts (the same behavior as before)', () => {
    for (const directory of TARGET_CONFIG_DIRECTORIES) {
      expect(isAcceptedTargetConfigPath(`${directory}example${TARGET_CONFIG_EXTENSION}`)).toBe(true);
      expect(isAcceptedTargetConfigPath(`${directory}nested/example${TARGET_CONFIG_EXTENSION}`)).toBe(true);
      expect(isAcceptedTargetConfigPath(`${directory}${TARGET_CONFIG_EXTENSION}`)).toBe(false);
      expect(isAcceptedTargetConfigPath(`${directory}example.txt`)).toBe(false);
    }
    expect(isAcceptedTargetConfigPath('other/targets/example.json')).toBe(false);
    expect(isAcceptedTargetConfigPath('local/targets/../escape.json')).toBe(false);
  });
});

describe('T43b fix round 1: the URL fragment', () => {
  it('finds a fragment, including an empty one', () => {
    expect(hasUrlFragment('https://example.test/#top')).toBe(true);
    expect(hasUrlFragment('https://example.test/#')).toBe(true);
    expect(hasUrlFragment('https://example.test/a?b=1')).toBe(false);
    expect(hasUrlFragment('')).toBe(false);
  });

  it('is the rule of the start URL', () => {
    expect(startUrlProblemOf('https://example.test/#')).toBe('START_URL_HAS_FRAGMENT');
    expect(startUrlProblemOf('https://example.test/')).toBeNull();
  });
});
