// AUD-8（4-3）: 無効の手がかりの祖先は、shadow root の境を越えて host から外へたどる（`aria-disabled`・`inert` は host を経て外の祖先からも効く）。
// ページの中の関数（`readDisabledFactsReader`）を、偽の DOM（グローバルの置き換え）で動かして確かめる。ブラウザを使わない。
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StandardReaders } from '../../src/browser/in-page-readers.js';
import { readDisabledFactsReader } from '../../src/evidence/accessibility-collector.js';

class FakeNode {
  parentNode: FakeNode | null = null;

  get parentElement(): FakeElement | null {
    return this.parentNode instanceof FakeElement ? this.parentNode : null;
  }
}

class FakeElement extends FakeNode {
  readonly #attributes: Record<string, string>;

  constructor(attributes: Record<string, string> = {}) {
    super();
    this.#attributes = attributes;
  }

  getAttribute(name: string): string | null {
    return this.#attributes[name] ?? null;
  }

  matches(selector: string): boolean {
    return selector === ':disabled' && this.getAttribute('disabled') !== null;
  }
}

class FakeFragment extends FakeNode {
  readonly selectors = new Map<string, FakeElement>();

  querySelector(selector: string): FakeElement | null {
    return this.selectors.get(selector) ?? null;
  }
}

class FakeShadowRoot extends FakeFragment {
  constructor(readonly host: FakeElement) {
    super();
  }
}

class FakeDocument extends FakeFragment {}

/** `parent` の子にする。 */
const append = <T extends FakeNode>(parent: FakeNode, child: T): T => {
  child.parentNode = parent;
  return child;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('readDisabledFactsReader: shadow root の境を越える祖先', () => {
  it('shadow root の中の要素の、host とその外の祖先の aria-disabled・inert を ANCESTOR にする', () => {
    const document = new FakeDocument();
    const outer = append(document, new FakeElement({ 'aria-disabled': 'true' }));
    const host = append(outer, new FakeElement({ inert: '' }));
    const shadowRoot = new FakeShadowRoot(host);
    const inner = append(shadowRoot, new FakeElement());
    document.selectors.set('#host', host);
    shadowRoot.selectors.set('#inner', inner);
    // 境を越えないと届かない、ふつうの子（比べる相手）。
    const plain = append(document, new FakeElement());
    document.selectors.set('#plain', plain);

    vi.stubGlobal('document', document);
    vi.stubGlobal('Document', FakeDocument);
    vi.stubGlobal('DocumentFragment', FakeFragment);
    vi.stubGlobal('ShadowRoot', FakeShadowRoot);
    vi.stubGlobal('Element', FakeElement);
    vi.stubGlobal('Node', FakeNode);
    vi.stubGlobal('HTMLIFrameElement', class {});
    vi.stubGlobal('window', { getComputedStyle: () => ({ pointerEvents: 'auto', cursor: 'auto' }) });

    const readers = {
      standardGetter: (_prototype: object, name: string) => (target: unknown) => (target as Record<string, unknown>)[name],
      openRoots: () => [document, shadowRoot],
    } as unknown as StandardReaders;

    const facts = readDisabledFactsReader(readers, { targets: [[['#host', '#inner']], ['#plain'], ['#missing']] });

    expect(facts[0]).toEqual({
      matchesDisabled: false,
      disabledAttribute: null,
      ariaDisabled: 'ANCESTOR',
      inert: 'ANCESTOR',
      pointerEvents: 'auto',
      cursor: 'auto',
      tabIndexNegative: false,
    });
    expect(facts[1]).toMatchObject({ ariaDisabled: null, inert: null });
    expect(facts[2]).toBeNull();
  });
});
