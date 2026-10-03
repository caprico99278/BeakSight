# Task 11 correction Task 2 implementation report

Authority: approved Task 2 plan and design, as recorded in the fixed Task 2 brief. Task 2 only; independent review is controller-owned.

## Baseline (before any production/test edit)

`Get-FileHash src/safety/interaction-policy.ts,src/interaction/discover-candidates.ts,src/interaction/isolated-auditor.ts,tests/integration/isolated-interaction.test.ts,package.json,package-lock.json -Algorithm SHA256` exited 0. All six hashes matched the fixed brief:

| Path | SHA-256 |
| --- | --- |
| src/safety/interaction-policy.ts | D63A211007C97368FA46EAD8D65CDFCC750AFDCA4B144175404495C6DCC8A9DF |
| src/interaction/discover-candidates.ts | E1056A659152770E0CD86036C55C6F5D47CED9572E11512420D0F18769EFC9F1 |
| src/interaction/isolated-auditor.ts | DE9C73B1A1B9601C62C3A59B7B8C111620AFE678B383DAA8433D80C684DC8814 |
| tests/integration/isolated-interaction.test.ts | FD255686AD0DDBB09D696EDC64BE0C0465657FEC583C376E62C3FE7A4AE5FD20 |
| package.json | 75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233 |
| package-lock.json | A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A |

Fixture missing at baseline. The controlled ID stays on the innermost node, which is the node with 20,000 ancestors; moving the ID outward would defeat the approved test intent.

## Staged API RED

- `npm test -- --run tests/integration/isolated-interaction.test.ts -t "exports bounded exact-handle resolution API"`: sandbox run exit 1, 62 skipped, Chromium `spawn EPERM`; environment failure excluded from RED.
- Same command outside the process-launch restriction: exit 1, 1 failed / 61 skipped, assertion `expected module to have property resolveInteractionCandidateHandle`. Only then was the exact-signature temporary throwing stub added.
- Controller authorized the additional `tests/integration/passive-request-guard.test.ts` structured discovery consumer migration under Step 13 (`all discovery consumers`), preserving all existing assertions. Baseline hash: `F51487F71FED96760EA8FA36FC923D8648AE90CAE3EE54EDBE635138514D6BDF`.

## Initial behavioral RED and fixture environment gap

`npm test -- --run tests/integration/isolated-interaction.test.ts -t "total DOM work|whole-DOM|budget exhaustion|bounded exact-handle|shared ancestor|shared text"` outside the launch restriction exited 1: 10 failed / 1 passed / 57 skipped (77.61 seconds).

- Genuine behavior RED: `bounded exact-handle resolution preserves the child after envelope disposal without whole-DOM queries` and `bounded exact-handle resolution and retained inspection distinguish true absence` both failed with the exact temporary stub error, `Bounded interaction handle resolution is not implemented`.
- NOT accepted as RED: seven cases navigating the approved 20,000-ancestor fixture failed `page.goto: Page crashed`; the separate 9,000-ancestor plus 8,000-enumeration combined test failed `locator.elementHandle: Target crashed`. No discovery/inspection behavior was reached by these eight tests. Fixture construction needs a controller ruling; production implementation remains paused after the temporary stub.
- Controller additionally authorized migration of the same single Guard test's Page double to structured discovery, evaluateHandle envelope, and CONNECTED inspection, preserving all original behavioral/disposal assertions; no production compatibility shims.
- Controller authorized a fixture-only `display: contents` style on each deep-chain wrapper, preserving 20,000 connected ancestors and all other sections, with a runtime ancestor-count/connected/positive-width precondition. The single diagnostic `npm test -- --run tests/integration/isolated-interaction.test.ts -t "avoids whole-DOM selector enumeration during discovery"` exited 1, 1 failed / 67 skipped (12.69 seconds): `page.goto: Page crashed` before the new precondition could execute. This mitigation did not resolve the environment gap. Work stopped before further fixture changes as instructed; no discovery/inspection GREEN or implementation claim is made.

## Controller resume and final Task 2 evidence

The controller ruled that the deep chain must remain real and retain `#deep-controlled`, but be nested below one scoped `display:none` host; `#early` remains outside and connected. The combined characterization retained exactly 8,000 preceding nodes and 9,000 controlled ancestors, with only the controlled chain hidden. Both lightweight ancestor preconditions passed and no renderer crash occurred after this ruling. The legacy retained-text probes were migrated to proxy/enforce only `SHOW_ALL` descendant-text walkers; `SHOW_ELEMENT` live-ordinal walkers use the ordinary browser walker. Existing 512-node assertions remain unchanged.

The preserved staged API RED remains recorded above: export-presence RED preceded the exact-signature throwing resolver stub, and behavioral RED reported the exact stub error. No module-load/type error was used as behavioral RED. The authorized Guard consumer Page double now returns structured discovery envelopes and a bounded `evaluateHandle` envelope with CONNECTED inspection; all existing assertions remain.

Production changes now provide one `maxDomWork: 16_384` constant and one browser-local mutable budget per discovery, exact-handle resolution, and retained inspection callback. Discovery charges accepted `SHOW_ELEMENT` nodes, selector membership, candidate facts, text nodes, visibility ancestors, and label/control lookups; partial candidates are discarded. Resolution charges accepted nodes and candidate membership, disposes envelope/status/count/unused property handles, and returns a retained FOUND child handle. Inspection charges accepted candidate nodes, identity comparisons, text, visibility, and lookups in one budget; budget exhaustion is distinct from DISCONNECTED.

| Serialized callback | Shared-budget charges | Exhaustion result |
| --- | --- | --- |
| discovery | element traversal, selector membership, text, visibility ancestors, label/control lookup | `DOM_WORK_BUDGET_REACHED`, partial candidate discarded |
| exact-handle resolution | element traversal and candidate membership | `DOM_WORK_BUDGET_REACHED` / `MISSING` / `FOUND` |
| retained inspection | element traversal, identity comparison, text, visibility ancestors, label/control lookup | `DOM_WORK_BUDGET_REACHED` / `DISCONNECTED` / `CONNECTED` |

Verification evidence: `npm test -- --run tests/integration/isolated-interaction.test.ts -t "total DOM work|whole-DOM|budget exhaustion|bounded exact-handle|shared ancestor|shared text"` exit 0, 11 passed / 57 skipped; individual retained text tests exit 0, 1/1 and 1/1; combined 8,000/9,000 test exit 0, 1/1; full isolated interaction exit 0, 68/68; authorized `tests/integration/passive-request-guard.test.ts` exit 0, 114/114; repository `npm test -- --run` exit 0, 26 files / 465 tests; `npm run typecheck` exit 0; `npm run build` exit 0. Forbidden production scan found no `querySelectorAll` or `.locator(` in discovery/auditor paths. No Git, dependency, live-target, Task 3+, or subagent operation occurred. Independent review remains controller-owned.

Final hashes: `interaction-policy.ts` `8C4A6A4C39B1D1D4D89E548E566D9CDB9789166E1E0A1D61E342B891ACA5BC9F`; `discover-candidates.ts` `4350AD955A4E8528D65FBEAACFCC52DDE30F0DBD8DADECAA9E6C4C165C68B5BE`; `isolated-auditor.ts` `14F35D47269506973BAB889A419643200ED42479C3833E93434625996494670B`; isolated test `E32E31412EBBD6DE8B589641D3F8151E3ED0F8E197426FD0D0F51FE66BF1DFD4`; Guard test `3074ED672099A3353694C44273E99423D8784218C841E00CB5DCA27568E4ABE6`; fixture `651718C2D963AF4B2BE8021EC1BB605A1FD8BDF50269CA0DAC7768543AD9326F`; package/lock unchanged at `75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233` / `A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A`.
