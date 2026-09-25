# Task 10 fix round 3/5 — Git-free SDD

Round 2 re-review found 0 Critical, 2 Important, 0 Minor. Git operations are prohibited.

## Binding corrections

1. Projection deadline gates must surround every caller-owned read boundary. Cache and check request/response arrays and their lengths once. After every indexed getter, stop before scalar reads if the deadline was reached. Cache and check HeaderEvidence `status`, `errorText` or `values` once. During OBSERVED header enumeration, check after enumeration/own-property descriptor work and after each value getter. Never reread `headers.values`.
2. Display scalars and correlation identity are separate. A raw resource type participates in exact/duplicate correlation only when its normalized raw value is within the retention bound. Overlong raw types are correlation-ineligible and must never become equal through truncation. Unknown-initiator duplicates may be consumed only when their exact bounded normalized raw types are identical.

## TDD

Before production edits add focused accessor-driven RED cases for cached array lengths, request and response indexed getters, FAILED status/errorText, OBSERVED status/values, own-property descriptor/value getters, and overlong raw resource types differing only beyond the bound. Preserve all earlier tests.

Run Task 10 component, Task 10+6 focused browser, Task 5-10 adjacent, typecheck, build, and fresh full. No dependency, live target, Git, or unrelated change.
