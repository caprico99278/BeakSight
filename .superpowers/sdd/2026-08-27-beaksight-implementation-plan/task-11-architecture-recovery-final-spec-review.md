# Task 11 Architecture Recovery Final Specification Review

Verdict: `NEEDS FIXES` — Critical: 0; Important: 1; Minor: 4.

Package SHA-256 `41D51A34EE7D93D5373309D68169C20D25C5947136245ED24E278D022FFC1C44`; manifest 48/48 matched before and after tests.

Important: `drainGuardTasks()` records timeout and returns, after which owner close/invalidation transitions to `CLOSED` and returns ordinary success with pending tasks. This violates approved design §§4.2/4.4: `CLOSED` only after successful drain and no ordinary success after the 1,000 ms deadline. The existing timeout test proves the wrong success behavior.

Minors: recovery plan samples remain stale for freeze/close precedence and undefined sentinel; lifecycle abort correlation, async failed-request helper return, and page-task indentation remain deferred.

Fresh full 414/414, focused inverted timeout 1/1, typecheck PASS, forbidden scan clean. No Git/dependency/live-target/write/delegation occurred.
