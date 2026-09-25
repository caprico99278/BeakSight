# Task 6 cross-task stability — Git-free review package

Git operations are prohibited. Verify hashes, then review read-only. Do not edit or spawn subagents.

The sole change must be the formerly flaky deadline test. Production behavior permits `PARTIAL / DEADLINE_EXCEEDED` before any geometry observation, in which case `observations` is empty and `finalSnapshot` is undefined. If a snapshot exists, it must be a strictly pre-deadline observation and not at bottom. Confirm the revised assertion expresses exactly that contract, does not make the test vacuous, and no production file changed.

Implementer reports exact 4/4 concurrent characterization before/after, Task 6 focused 24/24, typecheck PASS, standard full 265/265.

```text
8E4778202AC122AC5F701BF624A4D21F4B2F0154268BD475DA129DB4C5A6C1B1  tests/integration/controlled-scroll.test.ts
12C271A5E75954BD43636D4193BC3842C8BF825E872CBA74D797C1CEC9667BB6  src/browser/controlled-scroll.ts
```

Return PASS/NEEDS FIXES with exact lines and list any new Critical/Important test-contract issue.
