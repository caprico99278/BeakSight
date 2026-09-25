/**
 * Interaction の候補の、ブラウザの中の処理に渡す入力の型（RC18 の M3。C18p）。
 * - `page.evaluate`・`page.evaluateHandle` に渡す形（`PageInteractionProbeInput`）は、`DISCOVER` と `RESOLVE` だけを受け取る。
 * - `ElementHandle.evaluate` に渡す形（`HandleInteractionProbeInput`）は、`INSPECT` だけを受け取る。
 * 誤った組み合わせで呼ぶと、例外にならずに誤った結果（`DISCONNECTED` など）を返すので、型のエラーにする。
 * 型の確かめは、`npm run typecheck`（`expectTypeOf` と `@ts-expect-error`）で行う。
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import { VISIBILITY_CHECK_OPTIONS } from '../../src/core/visibility.js';
import { CLASS_ATTRIBUTE_NAME } from '../../src/evidence/interaction-collector.js';
import {
  INTERACTION_CANDIDATE_SELECTOR,
  type HandleInteractionProbeInput,
  type PageInteractionProbeInput,
} from '../../src/interaction/discover-candidates.js';
import { INTERACTION_CANDIDATE_LIMITS } from '../../src/safety/interaction-policy.js';

const limits = { ...INTERACTION_CANDIDATE_LIMITS };

describe('interaction probe input types', () => {
  it('accepts only DISCOVER and RESOLVE for the page probe, and only INSPECT for the handle probe', () => {
    expectTypeOf<PageInteractionProbeInput['mode']>().toEqualTypeOf<'DISCOVER' | 'RESOLVE'>();
    expectTypeOf<HandleInteractionProbeInput['mode']>().toEqualTypeOf<'INSPECT'>();
  });

  it('rejects the handle input for the page probe, and the page inputs for the handle probe', () => {
    const inspect = {
      mode: 'INSPECT',
      selector: INTERACTION_CANDIDATE_SELECTOR,
      limits,
      visibilityOptions: VISIBILITY_CHECK_OPTIONS,
      classAttributeName: CLASS_ATTRIBUTE_NAME,
    } as const;
    const discover = {
      mode: 'DISCOVER',
      selector: INTERACTION_CANDIDATE_SELECTOR,
      limits,
      visibilityOptions: VISIBILITY_CHECK_OPTIONS,
    } as const;
    const resolve = {
      mode: 'RESOLVE',
      selector: INTERACTION_CANDIDATE_SELECTOR,
      limits,
      targetOrdinal: 0,
    } as const;

    const pageDiscover: PageInteractionProbeInput = discover;
    const pageResolve: PageInteractionProbeInput = resolve;
    const handleInspect: HandleInteractionProbeInput = inspect;
    // @ts-expect-error page の処理は、INSPECT の入力を受け取らない。
    const pageInspect: PageInteractionProbeInput = inspect;
    // @ts-expect-error handle の処理は、DISCOVER の入力を受け取らない。
    const handleDiscover: HandleInteractionProbeInput = discover;
    // @ts-expect-error handle の処理は、RESOLVE の入力を受け取らない。
    const handleResolve: HandleInteractionProbeInput = resolve;

    // 実行時の値は、型の確かめのために作ったものである（ブラウザの中の処理は呼ばない）。
    expect([pageDiscover, pageResolve, pageInspect].map(({ mode }) => mode)).toEqual(['DISCOVER', 'RESOLVE', 'INSPECT']);
    expect([handleInspect, handleDiscover, handleResolve].map(({ mode }) => mode)).toEqual(['INSPECT', 'DISCOVER', 'RESOLVE']);
  });
});
