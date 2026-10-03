# Task 3 review package (Git-free)

Git operations are prohibited. All eight listed files are new and are the complete Task 3 implementation/test surface.

| File | SHA-256 | Bytes | Lines |
|---|---|---:|---:|
| `src/crawl/normalize-url.ts` | `A1E246DC9DC59D96652363A1C0BD787A6A6F2F3FA651E5A8B89215B9BBDF0406` | 1429 | 47 |
| `src/crawl/admission-policy.ts` | `A48C5079B7484A242EE0705C7FE0C7DFACF3A35B5F7A093529A7BBE023229B22` | 1105 | 30 |
| `src/crawl/crawl-queue.ts` | `68D07B922B0722729FB0862F478C9A1F06AC2E3DFECA8B8ED405352F508A0262` | 585 | 24 |
| `src/crawl/discover-links.ts` | `5A690337BEED15F86AF2A4B7C78E3901E46834581199A103ABA8CDD789FA81CA` | 3292 | 97 |
| `tests/unit/normalize-url.test.ts` | `D516B97D7B1BAA326C337C610FF9A995ECD4FDEB08493FDF3A3DFDF9B8C1C432` | 1338 | 36 |
| `tests/unit/admission-policy.test.ts` | `0B9CCA7037906530E9172136C261C0CA4D7919E1FAE51DE5CB9AEBCEB396863E` | 1004 | 28 |
| `tests/unit/crawl-queue.test.ts` | `35E0234298767B958D92D95CD3E39063B33D43083B6427CAB3EB23D4B03D62D4` | 1333 | 31 |
| `tests/component/discover-links.test.ts` | `73880C3B41BE4621CAC82514068BD85568B7D2776E3D630599B38DEB4D560787` | 2855 | 76 |

No prior task file changed. Generated `dist/**`, installed Chromium cache, and `node_modules/**` are excluded from review. The report records the only production `a[href]` occurrence at `src/crawl/discover-links.ts`.
