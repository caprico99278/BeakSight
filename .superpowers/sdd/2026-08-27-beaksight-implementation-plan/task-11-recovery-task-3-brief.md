### Task 3: Bound total browser traversal work in both candidate paths

**Files:**
- Modify: `src/interaction/discover-candidates.ts:177-312,327-483`
- Modify: `fixtures/site/hostile-candidates.html`
- Test: `tests/integration/isolated-interaction.test.ts:84-231`

**Interfaces:**
- Consumes: unchanged `INTERACTION_CANDIDATE_LIMITS.maxTextNodes === 512` as the total visited-node budget and `maxTextLength * 4 === 1_024` as the character budget.
- Produces: unchanged `discoverInteractionCandidates(page)` and `inspectInteractionCandidateHandle(handle, ordinalHint)`.

- [ ] **Step 1: Change the hostile fixture to place text after 100,000 non-text descendants**

Replace the fixture script with deterministic fragment construction:

```html
<script>
  const label = document.getElementById('hostile-label');
  const fragment = document.createDocumentFragment();
  for (let index = 0; index < 100000; index += 1) {
    fragment.append(document.createElement('span'));
  }
  fragment.append(document.createTextNode('must-not-require-unbounded-traversal'));
  label.append(fragment);
</script>
```

- [ ] **Step 2: Add failing total-node tests for discovery and retained inspection**

Add `INTERACTION_CANDIDATE_LIMITS` to the existing interaction-policy import. In both browser paths, instrument `document.createTreeWalker` so any `whatToShow !== NodeFilter.SHOW_ALL` throws `all-node traversal is required`, and its returned `nextNode()` throws after 512 calls. This makes the current `SHOW_TEXT` implementation genuinely RED and makes the call bound meaningful after `SHOW_ALL` returns every descendant. Keep existing assertions that `textContent`, `nodeValue`, and NodeList iteration throw if used.

```ts
async function installTraversalProbe(page: Page): Promise<() => Promise<number>> {
  await page.evaluate((maxNodes) => {
    const original = document.createTreeWalker.bind(document);
    let nextNodeCalls = 0;
    Object.defineProperty(document, 'createTreeWalker', {
      configurable: true,
      value(root: Node, whatToShow: number, filter?: NodeFilter | null) {
        if (whatToShow !== NodeFilter.SHOW_ALL) throw new Error('all-node traversal is required');
        const walker = original(root, whatToShow, filter);
        return new Proxy(walker, {
          get(target, property) {
            if (property !== 'nextNode') return Reflect.get(target, property, target);
            return () => {
              nextNodeCalls += 1;
              if (nextNodeCalls > maxNodes) throw new Error('total node traversal exceeded its bound');
              return target.nextNode();
            };
          },
        });
      },
    });
    Object.defineProperty(globalThis, '__beakSightTraversalCount', {
      configurable: true,
      get: () => nextNodeCalls,
    });
  }, INTERACTION_CANDIDATE_LIMITS.maxTextNodes);
  return async () => page.evaluate(() => (
    globalThis as typeof globalThis & { readonly __beakSightTraversalCount: number }
  ).__beakSightTraversalCount);
}

const readNextNodeCalls = await installTraversalProbe(page);
const candidates = await discoverInteractionCandidates(page);
const nextNodeCalls = await readNextNodeCalls();
expect(nextNodeCalls).toBeLessThanOrEqual(INTERACTION_CANDIDATE_LIMITS.maxTextNodes);
expect(candidates).toHaveLength(1);
```

The retained path must obtain the first candidate handle, reset the counter, call `inspectInteractionCandidateHandle(handle, 0)`, and assert the same limit.

- [ ] **Step 3: Run both tests and verify genuine RED**

Run:

```powershell
npm test -- --run tests/integration/isolated-interaction.test.ts -t "total descendant nodes during discovery|total descendant nodes during retained inspection"
```

Expected: current `SHOW_TEXT` implementation performs native traversal across the non-text descendants and cannot prove the all-node bound; the instrumentation/fixture assertion fails.

- [ ] **Step 4: Replace text-only walking in both serialized callbacks**

Use the same self-contained implementation in discovery and retained inspection:

```ts
const boundedDescendantText = (roots: readonly Element[], maxCharacters: number): string => {
  let result = '';
  let visitedNodes = 0;
  for (const root of roots) {
    if (result.length >= maxCharacters || visitedNodes >= limits.maxTextNodes) break;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ALL);
    while (result.length < maxCharacters && visitedNodes < limits.maxTextNodes) {
      const node = walker.nextNode();
      if (node === null) break;
      visitedNodes += 1;
      if (node.nodeType !== Node.TEXT_NODE) continue;
      const textNode = node as Text;
      const remaining = maxCharacters - result.length;
      result += textNode.substringData(0, Math.min(textNode.length, remaining));
    }
    if (result.length > 0 && result.length < maxCharacters) result += ' ';
  }
  return result.slice(0, maxCharacters);
};
```

Do not extract this into a page-visible global or string source. Keep both callbacks self-contained and identical, with shared numeric limits from `INTERACTION_CANDIDATE_LIMITS`.

- [ ] **Step 5: Run all candidate discovery/interaction tests and typecheck**

Run:

```powershell
npm test -- --run tests/integration/isolated-interaction.test.ts
npm test -- --run tests/unit/interaction-policy.test.ts
npm run typecheck
```

Expected: hostile total-node tests and all prior NodeList/text/identity tests PASS.

- [ ] **Step 6: Record the no-Git checkpoint and request fresh specification review**

Record hashes for `discover-candidates.ts`, `hostile-candidates.html`, and `isolated-interaction.test.ts`. The reviewer must inspect both serialized callbacks and confirm that each `nextNode()` return increments the shared all-node budget before Task 4.

---

