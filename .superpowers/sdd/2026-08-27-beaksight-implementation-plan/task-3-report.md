# Task 3 report — URL policy, queue, and link discovery

## Status

DONE

Commits created: NOT APPLICABLE (Git prohibited).

## Implementation summary

- Added the canonical `normalizeUrl()` owner. It resolves relative HTTP(S) URLs, removes fragments, excludes `utm_*`, `gclid`, and `fbclid`, retains only caller-allowed query keys in code-unit key order, keeps repeated allowed values stable, and preserves duplicate path slashes and URL-standard default-port normalization.
- Added the canonical `classifyUrl()` owner and immutable `AdmissionPolicy` input. It admits only allowed-origin HTTP(S) URLs; out-of-scope HTTP(S), special-scheme, and invalid results remain evidence-only classifications.
- Added `CrawlQueue`, a single-consumer deterministic FIFO that accepts each URL only once for the lifetime of the crawl. Dequeue order and the depth attached to the first discovery are retained.
- Added the sole production anchor extractor, `discoverLinks()`. It uses Playwright to capture anchor text, aria label, title, raw href, document base URL, canonical normalization result, admission result, and the source `PageId`. It emits evidence only; downstream callers may make crawl candidates solely from `INTERNAL_NAVIGABLE` admissions. The required two-argument call remains supported; an optional per-call policy supplies allowed origins and query keys without global target state.

## Files changed

- `src/crawl/normalize-url.ts`
- `src/crawl/admission-policy.ts`
- `src/crawl/crawl-queue.ts`
- `src/crawl/discover-links.ts`
- `tests/unit/normalize-url.test.ts`
- `tests/unit/admission-policy.test.ts`
- `tests/unit/crawl-queue.test.ts`
- `tests/component/discover-links.test.ts`

`npm run build` also emitted the standard generated `dist/crawl/*.js` files; these were not manually edited.

## TDD evidence

All four focused suites were written before any Task 3 production file existed. The initial command was:

```text
npx vitest run tests/unit/normalize-url.test.ts tests/unit/admission-policy.test.ts tests/unit/crawl-queue.test.ts tests/component/discover-links.test.ts
```

Expected RED output (the production modules did not yet exist):

```text
FAIL  tests/unit/admission-policy.test.ts
Error: Cannot find module '../../src/crawl/admission-policy.js'

FAIL  tests/unit/crawl-queue.test.ts
Error: Cannot find module '../../src/crawl/crawl-queue.js'

FAIL  tests/unit/normalize-url.test.ts
Error: Cannot find module '../../src/crawl/normalize-url.js'

FAIL  tests/component/discover-links.test.ts
Error: Cannot find module '../../src/crawl/discover-links.js'

Test Files  4 failed (4)
Tests  no tests
```

This was the expected failure reason: all tests exercised the desired public APIs, and the named production owners had not been created.

Final GREEN command and exact result:

```text
npx vitest run tests/unit/normalize-url.test.ts tests/unit/admission-policy.test.ts tests/unit/crawl-queue.test.ts tests/component/discover-links.test.ts

Test Files  4 passed (4)
Tests  12 passed (12)
Duration  1.49s
```

Additional required verification:

```text
npm run typecheck
> tsc -p tsconfig.json --noEmit
PASS

npm run build
> tsc -p tsconfig.build.json && node --input-type=module -e "import { cpSync } from 'node:fs'; cpSync('schemas', 'dist/schemas', { recursive: true });"
PASS
```

## Browser setup

The real Playwright component test initially reported a missing Chromium executable. Per the Task 3 authorization, the only browser installed was Chromium:

```text
npx playwright install chromium
```

The sandbox then blocked browser launch with `spawn EPERM`; the exact focused test command was rerun with execution approval and passed with the real Chromium binary. No other browser was installed.

## Self-review

- Semantic ownership: URL cleanup exists only in `normalize-url.ts`; scope/scheme classification exists only in `admission-policy.ts`; anchor extraction and the `LinkEvidence` model exist only in `discover-links.ts`; queue lifetime de-duplication/FIFO state exists only in `crawl-queue.ts`.
- Determinism: query key ordering uses explicit code-unit comparison; same-key values retain source order; queue insertion/dequeue order is FIFO; a URL is marked seen before it can be dequeued, so it cannot return later with a different depth.
- Edge cases: tests cover tracking and fragment removal, query allowlisting/order/repetition, URL-default port behavior, duplicate path slashes, `mailto:`, `tel:`, external HTTP(S), special-scheme evidence, malformed href evidence, depth preservation, and post-dequeue de-duplication.
- Test quality: tests use literal expected values and a real Playwright Chromium page with `page.setContent()`; there are no mock assertions. The component test proves raw DOM metadata and canonical resulting evidence together.
- Target isolation: policy is passed to `normalizeUrl`, `classifyUrl`, and optional discovery policy parameters. No target URL, origin, or query-key policy is hard-coded in `src/**`.
- Canonical-model reuse readiness: each `LinkEvidence` preserves source identity, raw metadata, `NormalizedUrlResult`, and `UrlAdmission`; downstream DOM/audit/coordinator layers can reuse this single evidence record and make candidates only from the internal-admitted branch.

## SSOT scan evidence

The following final scans were run against `src/**`:

```text
rg -n --glob '*.ts' 'a\[href\]|querySelector(All)?\s*\([^\r\n]*href|locator\s*\([^\r\n]*href' src
src\crawl\discover-links.ts:69:  const anchors = await page.locator('a[href]').evaluateAll(...)

rg -n --glob '*.ts' 'normalizeUrl\s*\(|classifyUrl\s*\(' src
src\crawl\discover-links.ts:49:    const admission = classifyUrl(parsedUrl, policy);
src\crawl\discover-links.ts:82:    const normalized = normalizeUrl(...)
src\crawl\discover-links.ts:84:      ? classifyUrl(new URL(normalized.url), resolvedPolicy)
```

There is exactly one production `a[href]` query. `discover-links.ts` constructs `URL` objects only to pass them to the canonical admission owner; it does not clean, compare origins, or locally classify schemes. The `URLSearchParams` and `searchParams` occurrences are confined to the canonical normalization owner. The separate existing `config/validate-config.ts` origin comparison validates configuration input and is not crawl URL admission.

## Concerns

None. The optional discovery-policy third argument is intentionally backward-compatible with the specified two-argument interface and is required to keep per-target URL policy dependency-injected for later layers.

## Fix Round 1 — admission hardening and queue integrity

### Status

DONE

Commits created: NOT APPLICABLE (Git prohibited).

### Files changed in this round

- `src/crawl/normalize-url.ts`
- `src/crawl/admission-policy.ts`
- `src/crawl/crawl-queue.ts`
- `src/crawl/discover-links.ts`
- `tests/unit/normalize-url.test.ts`
- `tests/unit/admission-policy.test.ts`
- `tests/unit/crawl-queue.test.ts`
- `tests/component/discover-links.test.ts`

The standard build also regenerated `dist/crawl/*.js`; no generated file was manually edited.

### Reproducing tests and RED evidence

New tests were added before changing production code for: external `<base>` with two-argument discovery, non-HTTP current-page default policy, credential-bearing targets, canonicalized/invalid allowed-origin entries, unreserved and reserved percent encodings, queue alias mutation, and negative/fractional/non-finite depths.

Command:

```text
npx vitest run tests/unit/normalize-url.test.ts tests/unit/admission-policy.test.ts tests/unit/crawl-queue.test.ts tests/component/discover-links.test.ts
```

Expected RED result:

```text
Test Files  4 failed (4)
Tests  9 failed | 13 passed (22)

normalize-url: /%7eprofile stayed https://example.test/%7eprofile instead of https://example.test/~profile;
reserved %2f stayed lowercase.

admission-policy: https://user:secret@example.test/private was INTERNAL_NAVIGABLE;
HTTPS://EXAMPLE.TEST:443/a/path/ did not admit https://example.test/catalog.

crawl-queue: enqueue stored the caller candidate by reference (mutated depth became 9),
and -1, 1.5, and Infinity were accepted.

discover-links: an external document base produced INTERNAL_NAVIGABLE in the default two-argument path.
```

These failures precisely reproduced each reported semantic bug. Chromium was already installed in the original Task 3 round; the command was run with the same approved browser-launch permission.

### Implementation

- The default discovery policy now derives authority only from `page.url()` (the main-frame current URL). A non-HTTP(S) current page receives an empty allowed-origin policy, while `document.baseURI` continues to resolve raw relative hrefs only.
- `classifyUrl()` now rejects HTTP(S) targets containing credentials, and canonicalizes/validates all policy origin entries using `URL.origin`; malformed, non-HTTP(S), and credential-bearing policy entries grant no authority.
- `normalizeUrl()` now canonicalizes percent escapes in paths: it decodes only unreserved octets and uppercases all remaining valid escape hex pairs, preserving reserved delimiters such as `%2F`.
- `NormalizedHttpUrl` and `AdmittedUrl` branded contracts now flow from canonical normalization/admission owners. `CrawlCandidate` requires `AdmittedUrl`; the queue does not normalize/classify URLs. On enqueue it validates a safe non-negative integer depth, then clones and freezes the accepted candidate before adding its URL to the seen set.

### GREEN verification

```text
npx vitest run tests/unit/normalize-url.test.ts tests/unit/admission-policy.test.ts tests/unit/crawl-queue.test.ts tests/component/discover-links.test.ts

Test Files  4 passed (4)
Tests  22 passed (22)
Duration  2.04s

npm run typecheck
> tsc -p tsconfig.json --noEmit
PASS

npm run build
> tsc -p tsconfig.build.json && node --input-type=module -e "import { cpSync } from 'node:fs'; cpSync('schemas', 'dist/schemas', { recursive: true });"
PASS
```

### Fresh semantic-ownership scans

```text
rg -n --glob '*.ts' 'a\[href\]|querySelector(All)?\s*\([^\r\n]*href|locator\s*\([^\r\n]*href' src
src\crawl\discover-links.ts:74:  const anchors = await page.locator('a[href]').evaluateAll(...)

rg -n --glob '*.ts' 'normalizeUrl\s*\(|classifyUrl\s*\(' src
src\crawl\discover-links.ts:53:    const admission = classifyUrl(parsedUrl, policy);
src\crawl\discover-links.ts:86:    const normalized = normalizeUrl(...)
src\crawl\discover-links.ts:88:      ? classifyUrl(new URL(normalized.url), resolvedPolicy)

rg -n --glob '*.ts' 'interface LinkEvidence|type LinkEvidence|interface CrawlCandidate|type CrawlCandidate' src
src\crawl\discover-links.ts:6:export interface LinkEvidence {
src\crawl\crawl-queue.ts:3:export interface CrawlCandidate {
```

There is exactly one production `a[href]` extractor and one `LinkEvidence` model. Discovery delegates normalizing and admitting to their canonical owners; it creates `URL` values only to supply `classifyUrl()` its required input. Query filtering/percent canonicalization are solely in `normalize-url.ts`; origin canonicalization, credential rejection, and scope classification are solely in `admission-policy.ts`; queue code has no URL parsing or classification.

### Concerns

None.

## Fix Round 2 — normalized queue URL soundness

### Status

DONE

Commits created: NOT APPLICABLE (Git prohibited).

### Files changed in this round

- `src/crawl/admission-policy.ts`
- `src/crawl/crawl-queue.ts`
- `tests/unit/crawl-queue.test.ts`
- `tests/component/discover-links.test.ts`

The standard build regenerated `dist/crawl/*.js`; no generated file was manually edited.

### TDD and RED evidence

The new regression moves queue fixtures to `normalizeUrl()` and adds both parts of the boundary contract:

- direct `classifyUrl()` retains its original plain serialized URL interface and cannot type-check as a `CrawlCandidate` URL;
- `discoverLinks()` retains its internal admission together with the separate normalized URL that can type-check as the queue candidate URL.

The first focused Vitest execution identified and corrected an initially over-constrained component expectation: discovery deliberately calls admission with the normalized URL, so its admission URL is already canonical. After correcting that test expectation (still before production changes), the intended type-level RED was captured with:

```text
npm run typecheck
> tsc -p tsconfig.json --noEmit

tests/component/discover-links.test.ts(117,43): error TS2322: Type 'NormalizedHttpUrl' is not assignable to type 'AdmittedUrl'.
tests/unit/crawl-queue.test.ts(17,21): error TS2322: Type 'NormalizedHttpUrl' is not assignable to type 'AdmittedUrl'.
tests/unit/crawl-queue.test.ts(79,7): error TS2578: Unused '@ts-expect-error' directive.
```

This is the expected pre-fix failure: the queue incorrectly required the admission-created `AdmittedUrl`, blocking the sole normalization owner’s type, while direct classification incorrectly satisfied the `@ts-expect-error` candidate assignment. The latter test is intentionally compile-time because TypeScript string brands are erased by Vitest’s runtime transform.

The required focused command was also run before implementation:

```text
npx vitest run tests/unit/normalize-url.test.ts tests/unit/admission-policy.test.ts tests/unit/crawl-queue.test.ts tests/component/discover-links.test.ts
```

Its original runtime test exposed the over-constrained discovery assertion described above. Once corrected to the documented normalize-then-classify behavior, the unsoundness remained exclusively type-level and was caught by the RED `typecheck` evidence above.

### Implementation

- Removed the unsound `AdmittedUrl` brand. `classifyUrl(url, policy)` retains the planned API and its original plain-string `INTERNAL_NAVIGABLE.url` result, so it makes no claim that arbitrary input was normalized.
- Kept `NormalizedHttpUrl` private to the canonical normalization result: only the successful `normalizeUrl()` branch mints that brand.
- Changed `CrawlCandidate.url` to require `NormalizedHttpUrl`. The queue remains only a FIFO/deduplication owner; it neither parses nor normalizes/classifies URLs. Consumers separately verify `INTERNAL_NAVIGABLE` and pass the already normalized `LinkEvidence.normalized.url` to enqueue.
- Updated queue tests to mint candidate URLs only from `normalizeUrl()` and added a static regression that direct admission cannot enter the queue type. The component regression verifies discovery still carries its internal admission and normalized candidate URL together.

### GREEN verification

```text
npx vitest run tests/unit/normalize-url.test.ts tests/unit/admission-policy.test.ts tests/unit/crawl-queue.test.ts tests/component/discover-links.test.ts

Test Files  4 passed (4)
Tests  24 passed (24)
Duration  2.26s

npm run typecheck
> tsc -p tsconfig.json --noEmit
PASS

npm run build
> tsc -p tsconfig.build.json && node --input-type=module -e "import { cpSync } from 'node:fs'; cpSync('schemas', 'dist/schemas', { recursive: true });"
PASS
```

### Fresh SSOT scans

```text
rg -n --glob '*.ts' 'a\[href\]|querySelector(All)?\s*\([^\r\n]*href|locator\s*\([^\r\n]*href' src
src\crawl\discover-links.ts:74:  const anchors = await page.locator('a[href]').evaluateAll(...)

rg -n --glob '*.ts' 'normalizeUrl\s*\(|classifyUrl\s*\(' src
src\crawl\discover-links.ts:53:    const admission = classifyUrl(parsedUrl, policy);
src\crawl\discover-links.ts:86:    const normalized = normalizeUrl(...)
src\crawl\discover-links.ts:88:      ? classifyUrl(new URL(normalized.url), resolvedPolicy)

rg -n --glob '*.ts' 'NormalizedHttpUrl|AdmittedUrl|interface LinkEvidence|type LinkEvidence|interface CrawlCandidate|type CrawlCandidate' src
src\crawl\normalize-url.ts:1:export type NormalizedHttpUrl = string & { readonly __brand: 'NormalizedHttpUrl' };
src\crawl\normalize-url.ts:4:  | { readonly ok: true; readonly url: NormalizedHttpUrl }
src\crawl\crawl-queue.ts:1:import type { NormalizedHttpUrl } from './normalize-url.js';
src\crawl\crawl-queue.ts:3:export interface CrawlCandidate {
src\crawl\crawl-queue.ts:4:  readonly url: NormalizedHttpUrl;
```

There is no `AdmittedUrl` type left. There remains exactly one production anchor extractor and one LinkEvidence model. URL query/path normalization is only in `normalize-url.ts`; URL scope classification is only in `admission-policy.ts`; `crawl-queue.ts` only consumes the branded result and owns FIFO/deduplication/depth invariants.

### Concerns

None.
