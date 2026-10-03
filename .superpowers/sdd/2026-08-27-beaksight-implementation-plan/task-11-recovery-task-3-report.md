# Task 11 recovery — Task 3 report

## Implementation

- Replaced both serialized `boundedDescendantText` callbacks in `src/interaction/discover-candidates.ts` with identical `NodeFilter.SHOW_ALL` walkers.
- Each non-null `nextNode()` now increments the shared callback `visitedNodes` counter before the `Node.TEXT_NODE` filter. The callback stops at 512 visited descendant nodes (`limits.maxTextNodes`) or its supplied 1,024-character budget (`limits.maxTextLength * 4`) across all roots.
- Retained `substringData`; did not introduce `textContent`, `nodeValue`, NodeList iteration/materialization, page-visible helpers, production DOM markers, selectors, or identity changes.
- The hostile fixture now appends 100,000 empty spans followed by text onto the candidate itself. Its direct ARIA label keeps the test focused on one bounded descendant traversal per candidate snapshot.
- Added a test-only `installTraversalProbe`, scoped to the browser page, that rejects non-`SHOW_ALL` walkers and throws on the 513th global `nextNode()` call. It is used by discovery and retained-handle tests.

## TDD mutations covered

1. **Discovery SHOW_TEXT regression:** changing discovery back to `NodeFilter.SHOW_TEXT` fails `bounds total descendant nodes during discovery with all-node traversal` with `all-node traversal is required`.
2. **Retained SHOW_TEXT regression:** changing retained inspection back to `NodeFilter.SHOW_TEXT` fails `bounds total descendant nodes during retained inspection with all-node traversal` with `all-node traversal is required`.
3. **Visit-after-filter regression:** moving `visitedNodes += 1` below the text-node filter makes the hostile all-node traversal exceed 512 `nextNode()` calls in either probe.

## Exact RED / GREEN focused command output

The first non-escalated local-browser attempt stopped at browser launch (`spawn EPERM`) and was not treated as RED. The identical command with permission to launch the already-installed Chromium produced this genuine RED before production edits:

```text
> beaksight@0.1.0 test
> vitest run --run tests/integration/isolated-interaction.test.ts -t total descendant nodes during discovery|total descendant nodes during retained inspection

 RUN  v4.1.10 C:/Develop/github-repo/BeakSight

 ❯ tests/integration/isolated-interaction.test.ts (45 tests | 2 failed | 43 skipped) 1349ms
     × bounds total descendant nodes during discovery with all-node traversal 466ms
     × bounds total descendant nodes during retained inspection with all-node traversal 647ms

 FAIL  ... discovery ...
Error: page.evaluate: Error: all-node traversal is required
    at boundedDescendantText ...
    at accessibleName ...

 FAIL  ... retained inspection ...
Error: elementHandle.evaluate: Error: all-node traversal is required
    at boundedDescendantText ...
    at accessibleName ...

 Test Files  1 failed (1)
      Tests  2 failed | 43 skipped (45)
```

After production edits and fixture probe scoping, the exact focused command was GREEN:

```text
> beaksight@0.1.0 test
> vitest run --run tests/integration/isolated-interaction.test.ts -t total descendant nodes during discovery|total descendant nodes during retained inspection

 RUN  v4.1.10 C:/Develop/github-repo/BeakSight

 Test Files  1 passed (1)
      Tests  2 passed | 43 skipped (45)
   Start at  12:50:15
   Duration  1.92s (transform 128ms, setup 0ms, import 410ms, tests 1.34s, environment 0ms)
```

## Required suite results

```text
npm test -- --run tests/integration/isolated-interaction.test.ts

Test Files  1 failed (1)
     Tests  1 failed | 44 passed (45)

Failure (outside discovery/retained traversal paths):
tests/integration/isolated-interaction.test.ts > isolated fail-closed interaction audit > invalidates the guarded context when freeze is activated twice
Expected: /invalid from INTERACTION_FROZEN/u
Received: Interaction freeze transition is invalid from FROZEN_ACTIVE
```

```text
npm test -- --run tests/unit/interaction-policy.test.ts

Test Files  1 passed (1)
     Tests  22 passed (22)
```

```text
npm run typecheck

> beaksight@0.1.0 typecheck
> tsc -p tsconfig.json --noEmit
```

## Changed files and SHA-256

| File | Before | After |
| --- | --- | --- |
| `src/interaction/discover-candidates.ts` | `cfe7ee273c383fadd7ef0c35ee41e18e5569f621a91521dccb97467fac9caff1` | `e1056a659152770e0cd86036c55c6f5d47ced9572e11512420d0f18769efc9f1` |
| `fixtures/site/hostile-candidates.html` | `99b23bdd38f620e964e4706f96cee62ffc46e77ad3e38a27f923273a40add9e5` | `755a6f10b14968ef7ff637110625f327d689f98e1a8ec54bec25873b49b1b79f` |
| `tests/integration/isolated-interaction.test.ts` | `ccfb773e4f5140b12cababeadb402ee04cd637283c9b922f2c245cd61d1261c6` | `9ff64490311bdbafce1175b0c33224fb6dea5bf1d63f85ba75f86544fdf46605` |

The before hashes are reconstructed from the immediately preceding file contents by reversing only this task's patches; no Git command was run.

Package files were not changed:

| File | SHA-256 |
| --- | --- |
| `package.json` | `75e99161e042e79624e81ce5273c5d5c7a1f9a38814e6279d72e8f111911d233` |
| `package-lock.json` | `a9396ca36ae11922a508edef54b290930ab711d77d893e7ab132cc1d944e365a` |

## Line-by-line serialized-callback self-review

Both callbacks are byte-identical (`discover-candidates.ts:187-213` and `:351-377`):

1. Both initialize one `result` and one `visitedNodes` shared across all roots.
2. Both guard each root and each walker loop on character and `limits.maxTextNodes` bounds.
3. Both call `document.createTreeWalker(root, NodeFilter.SHOW_ALL)`.
4. Both break on a null `nextNode()` result.
5. Both increment `visitedNodes` immediately after each non-null result and before `nodeType` filtering.
6. Both skip non-text nodes, use only `Text.substringData`, preserve root separators, and slice to `maxCharacters`.
7. Both retain indexed/bounded candidate NodeList scans elsewhere; neither callback uses iteration/materialization APIs.

## Concerns

- The initial full isolated-interaction failure was the stale Task 1 expectation corrected in the maintenance section below; after the one-line test-only correction, the full suite passes 45/45.
- npm emitted a routine notice about a newer npm major version; no packages were installed, updated, or downloaded.

## Cross-task Task 1 expectation maintenance

### Root cause and minimal correction

Recovery Task 1 made `GuardState.phase` the sole guard authority and removed the retired `GuardMode` state. After the first `activateInteractionFreeze()`, the approved phase is `FROZEN_ACTIVE`; therefore a second activation correctly rejects with `Interaction freeze transition is invalid from FROZEN_ACTIVE`. The unchanged Task 3-baseline assertion still expected `INTERACTION_FROZEN` and was stale. The only maintenance edit changes that one assertion to `/invalid from FROZEN_ACTIVE/u`; no production code or any other assertion changed.

### Exact RED / GREEN double-freeze output

Before the edit:

```text
npm test -- --run tests/integration/isolated-interaction.test.ts -t "invalidates the guarded context when freeze is activated twice"

Test Files  1 failed (1)
     Tests  1 failed | 44 skipped (45)

Expected: /invalid from INTERACTION_FROZEN/u
Received: Interaction freeze transition is invalid from FROZEN_ACTIVE
```

After the edit:

```text
npm test -- --run tests/integration/isolated-interaction.test.ts -t "invalidates the guarded context when freeze is activated twice"

Test Files  1 passed (1)
     Tests  1 passed | 44 skipped (45)
```

### Verification after maintenance

```text
Task 3 focused traversal: 2 passed | 43 skipped (45)
Full isolated interaction: 45 passed (45)
Interaction policy unit: 22 passed (22)
npm run typecheck: passed (tsc -p tsconfig.json --noEmit)
```

### Hashes and unchanged-scope confirmation

| File | Before maintenance | After maintenance |
| --- | --- | --- |
| `tests/integration/isolated-interaction.test.ts` | `9ff64490311bdbafce1175b0c33224fb6dea5bf1d63f85ba75f86544fdf46605` | `ce9ad48dc99ff63d170a7fd2dd84f830755e77dd8563cef23e4cffe76efd5c7e` |
| `src/interaction/discover-candidates.ts` | `e1056a659152770e0cd86036c55c6f5d47ced9572e11512420d0f18769efc9f1` | `e1056a659152770e0cd86036c55c6f5d47ced9572e11512420d0f18769efc9f1` |
| `fixtures/site/hostile-candidates.html` | `755a6f10b14968ef7ff637110625f327d689f98e1a8ec54bec25873b49b1b79f` | `755a6f10b14968ef7ff637110625f327d689f98e1a8ec54bec25873b49b1b79f` |

The retained/discovery production file and hostile fixture were confirmed byte-unchanged by this maintenance. No package, policy, route, or production file changed.

## Review fix round 1 — aggregate multi-root traversal budget

### Finding addressed

The original hostile fixture supplied a one-element root array in both candidate paths, so resetting `visitedNodes` inside the per-root loop did not alter behavior. This round retains those original global 512-call tests unchanged and adds a separate multi-root fixture plus two browser-path tests. The fixture has two `aria-labelledby` label roots, each with 300 empty span descendants. The direct title fallback prevents another text walk; the new test-only probe aggregates **non-null** walker returns across label roots. Correct production consumes exactly the shared 512-node budget; resetting per root consumes 600 and fails on return 513.

### Genuine reset-per-root mutation RED

Temporary production mutation in both serialized callbacks (applied only with `apply_patch`, then removed):

```ts
for (const root of roots) {
  let visitedNodes = 0;
  // existing bounded walk
}
```

Exact focused command and output while mutated:

```text
> beaksight@0.1.0 test
> vitest run --run tests/integration/isolated-interaction.test.ts -t aggregate descendant-node budget across label roots during discovery|aggregate descendant-node budget across label roots during retained inspection

 RUN  v4.1.10 C:/Develop/github-repo/BeakSight

 ❯ tests/integration/isolated-interaction.test.ts (47 tests | 2 failed | 45 skipped) 1338ms
     × shares the aggregate descendant-node budget across label roots during discovery 125ms
     × shares the aggregate descendant-node budget across label roots during retained inspection 121ms

 FAIL  ... discovery ...
Error: page.evaluate: Error: aggregate descendant traversal exceeded its bound
    at boundedDescendantText ...
    at accessibleName ...

 FAIL  ... retained inspection ...
Error: elementHandle.evaluate: Error: aggregate descendant traversal exceeded its bound
    at boundedDescendantText ...
    at accessibleName ...

 Test Files  1 failed (1)
      Tests  2 failed | 45 skipped (47)
```

### Restored GREEN and verification

The source was restored with `apply_patch`; its SHA-256 was checked against the required value before final verification:

```text
E1056A659152770E0CD86036C55C6F5D47CED9572E11512420D0F18769EFC9F1
```

```text
New aggregate focused tests: 2 passed | 45 skipped (47)
Original Task 3 hostile focused tests: 2 passed | 45 skipped (47)
Full tests/integration/isolated-interaction.test.ts: 47 passed (47)
tests/unit/interaction-policy.test.ts: 22 passed (22)
npm run typecheck: passed (tsc -p tsconfig.json --noEmit)
```

### Changed and unchanged hashes

| File | Before round | After round |
| --- | --- | --- |
| `tests/integration/isolated-interaction.test.ts` | `ce9ad48dc99ff63d170a7fd2dd84f830755e77dd8563cef23e4cffe76efd5c7e` | `9b2605e13ceeb4b7026ed19b4ae88592213d3d4c7f3fe19ad31e58caa40fb87e` |
| `fixtures/site/multi-root-candidates.html` | absent | `9870aeccc9b4830c2c89e778fc7b929a7888f64bcf17238ccb07c430d9fb9919` |
| `src/interaction/discover-candidates.ts` | `e1056a659152770e0cd86036c55c6f5d47ced9572e11512420d0f18769efc9f1` | `e1056a659152770e0cd86036c55c6f5d47ced9572e11512420d0f18769efc9f1` |
| `package.json` | `75e99161e042e79624e81ce5273c5d5c7a1f9a38814e6279d72e8f111911d233` | `75e99161e042e79624e81ce5273c5d5c7a1f9a38814e6279d72e8f111911d233` |
| `package-lock.json` | `a9396ca36ae11922a508edef54b290930ab711d77d893e7ab132cc1d944e365a` | `a9396ca36ae11922a508edef54b290930ab711d77d893e7ab132cc1d944e365a` |

The pre-existing `fixtures/site/hostile-candidates.html` and the restored discovery source remained unchanged during this review fix. No package files, dependencies, production semantics, routes, or policy files changed. Concern: routine npm new-major notices were emitted; no package action was taken.
