// BN-c の fix（発見事項 5）: 測りの補助の `layoutFindingSourcesOf` は、幅の走査の Finding の文の形を `stressWidthFindingMessageText` の 1 か所から読む（写しを持たない）。
import { describe, expect, it } from 'vitest';
import { formatPixels } from '../../src/presentation/format.js';
import { stressWidthFindingMessageText } from '../../src/presentation/messages.js';
import { layoutFindingSourcesOf } from '../helpers/audit-metrics.js';
import { PAGE_1, finding, page } from '../helpers/audit-run-fixture.js';

describe('layoutFindingSourcesOf (BN-c fix)', () => {
  it('reads the width of a Finding of the stress sweep by the shared message shape, and names the others as the first load', () => {
    const findings = [
      finding(1, 'WARN', 'LAYOUT', PAGE_1, [], { ruleId: 'TEXT_CLIPPING', message: stressWidthFindingMessageText(formatPixels(320), '文字がはみ出しています。') }),
      finding(2, 'WARN', 'LAYOUT', PAGE_1, [], { ruleId: 'TEXT_CLIPPING', message: '文字がはみ出しています。' }),
    ];
    expect(layoutFindingSourcesOf(findings, [page(PAGE_1, '/')], ['TEXT_CLIPPING'])).toEqual([
      `/ TEXT_CLIPPING 幅 ${formatPixels(320)}`,
      '/ TEXT_CLIPPING 最初の読み込み（desktop）',
    ]);
  });
});
