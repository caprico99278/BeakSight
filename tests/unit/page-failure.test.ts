import { describe, expect, it } from 'vitest';
import { pageFailureReason } from '../../src/browser/page-failure.js';

describe('pageFailureReason', () => {
  it('reports PAGE_CLOSED when the page is closed', () => {
    expect(pageFailureReason({ isClosed: () => true })).toBe('PAGE_CLOSED');
  });

  it('reports EVALUATION_FAILED when the page is still open', () => {
    expect(pageFailureReason({ isClosed: () => false })).toBe('EVALUATION_FAILED');
  });

  it('reports EVALUATION_FAILED instead of throwing when isClosed throws', () => {
    const page = {
      isClosed: (): boolean => {
        throw new Error('page state unavailable');
      },
    };

    expect(pageFailureReason(page)).toBe('EVALUATION_FAILED');
  });
});
