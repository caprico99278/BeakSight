# Task 10 fix round 4/5 — Git-free SDD

Round 3 re-review found 0 Critical, 2 Important, 0 Minor. Git operations are prohibited.

## Binding corrections

1. Replace `for...in` HeaderEvidence enumeration with explicit `Reflect.ownKeys` snapshot, deadline check, then separately gated own-property descriptor and selected-value reads. This prevents the engine from performing `ownKeys -> getOwnPropertyDescriptor` internally before the loop-body gate. Cache values once and do not read unselected header values.
2. Separate exact initiator/request compatibility from aggregate resource categories. Known `fetch` matches only Task 7 `fetch`; known `xmlhttprequest`/`xhr` matches only Task 7 `xhr`; script/stylesheet/image likewise require their exact normalized raw request type. If exact type is absent, keep the initiator-derived summary category but leave request identity/type null. Unknown initiators keep the round 3 identical-raw-type rule.

Add genuine focused RED for the ownKeys/descriptor boundary and known fetch with xhr-first/only candidates before production edits. Preserve all earlier coverage and verify focused, adjacent, typecheck, build, and fresh full without Git/dependencies/live target.
