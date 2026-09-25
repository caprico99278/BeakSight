### Task 3: Implement URL normalization, admission policy, deterministic queue, and link discovery

**Files:**
- Create: `src/crawl/normalize-url.ts`
- Create: `src/crawl/admission-policy.ts`
- Create: `src/crawl/crawl-queue.ts`
- Create: `src/crawl/discover-links.ts`
- Test: `tests/unit/normalize-url.test.ts`
- Test: `tests/unit/admission-policy.test.ts`
- Test: `tests/unit/crawl-queue.test.ts`
- Test: `tests/component/discover-links.test.ts`

**Interfaces:**
- `normalizeUrl(rawUrl: string, baseUrl: string, allowedQueryParameters: ReadonlySet<string>): NormalizedUrlResult`.
- `classifyUrl(url: URL, policy: AdmissionPolicy): UrlAdmission`.
- `CrawlQueue.enqueue(candidate: CrawlCandidate): boolean`, `dequeue(): CrawlCandidate | undefined`.
- `discoverLinks(page: Page, sourcePageId: PageId): Promise<readonly LinkEvidence[]>`.

- [ ] **Step 1: Write failing normalization tests**

Cover fragment removal, `utm_*`, `gclid`, `fbclid`, sorted allowed query keys, default-port normalization, duplicate slash preservation rules, and rejection of `mailto:` / `tel:` as navigable URLs.

```ts
it('drops tracking parameters and fragments', () => {
  const result = normalizeUrl(
    '/pricing?utm_source=x&page=2#top',
    'https://example.test/',
    new Set(['page']),
  );
  expect(result).toEqual({ ok: true, url: 'https://example.test/pricing?page=2' });
});
```

- [ ] **Step 2: Implement normalization and admission**

Admission categories are:

```ts
export type UrlAdmission =
  | { readonly kind: 'INTERNAL_NAVIGABLE'; readonly url: string }
  | { readonly kind: 'EXTERNAL_RECORD_ONLY'; readonly url: string }
  | { readonly kind: 'SPECIAL_SCHEME_RECORD_ONLY'; readonly rawUrl: string; readonly scheme: string }
  | { readonly kind: 'REJECTED_INVALID'; readonly rawUrl: string; readonly reason: string };
```

Only HTTP(S) same-origin URLs can become `INTERNAL_NAVIGABLE`.

- [ ] **Step 3: Write failing BFS queue tests**

Verify insertion order, visited de-duplication, depth preservation, and no re-enqueue after dequeue.

- [ ] **Step 4: Implement `CrawlQueue` as a deterministic FIFO**

Do not use concurrency inside the queue. The coordinator is the only owner of dequeue sequencing.

- [ ] **Step 5: Write and implement DOM link discovery tests**

Use a tiny Playwright page with `page.setContent()` and assert extraction of `anchorText`, `ariaLabel`, `title`, `rawHref`, and source page ID. Discovery records special/external links but queues none of them.

- [ ] **Step 6: Verify and commit**

```bash
npx vitest run tests/unit/normalize-url.test.ts tests/unit/admission-policy.test.ts tests/unit/crawl-queue.test.ts tests/component/discover-links.test.ts
```

Commit:

```bash
git add src/crawl tests/unit/normalize-url.test.ts tests/unit/admission-policy.test.ts tests/unit/crawl-queue.test.ts tests/component/discover-links.test.ts
git commit -m "feat: add deterministic crawl policy"
```

---

## Authoritative addendum from the approved execution instructions

- URL canonicalization has one production owner: `src/crawl/normalize-url.ts` and canonical `normalizeUrl()`.
- URL admission/scope classification has one production owner: `src/crawl/admission-policy.ts` and canonical `classifyUrl()`.
- Link extraction has one production owner: `src/crawl/discover-links.ts` and canonical `discoverLinks()`.
- Crawl queue authority has one production owner: `src/crawl/crawl-queue.ts`.
- No production file other than `discover-links.ts` may query/parse `a[href]` or independently construct a Link model. Later DOM/Page/Coordinator/Rule/Report flows reuse the single `LinkEvidence[]` produced here.
- `LinkEvidence` must preserve source page identity, anchor text, aria label, title, raw href, and enough normalized/admission data for later consumers without re-reading the DOM. Special and external links are Evidence only and never queue authority.
- All normalization/admission consumers must call `normalizeUrl()` / `classifyUrl()`; no alternate local URL cleaner, query stripper, origin comparison, or scheme classifier is allowed.
- Only same-origin HTTP(S) links can become queue candidates. Form actions are never part of this discovery path.
- Keep all `src/**` code target-agnostic and dependency-inject policy/config values.
- The Task 3 mandatory review checkpoint must explicitly verify URL/Link semantic SSOT, deterministic BFS behavior, and canonical-model reuse readiness before Task 4.
- If Playwright Chromium is absent and the real component test requires it, installing only the Chromium binary is authorized. Do not install unused browsers.
- Git operations and commits are prohibited. Report `Commits created: NOT APPLICABLE (Git prohibited)`.

---

