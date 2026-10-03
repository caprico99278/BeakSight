# Task 11 Architecture Recovery Final Code-quality Review

Verdict: `NEEDS FIXES` — Critical: 0; Important: 4; Minor: 3.

Package SHA-256 `41D51A34EE7D93D5373309D68169C20D25C5947136245ED24E278D022FFC1C44`; manifest 48/48 matched before and after tests.

Important findings reported:

1. querySelectorAll/static-match creation and ancestor visibility traversal are not total hostile-DOM bounded;
2. public owner close rejects an invalidating phase instead of joining the published invalidation owner, allowing a pre-existing invalidation to outlive the final audit snapshot;
3. flat listener cleanup closures grow without a cap and retain closed pages/sessions until Context close;
4. guard error normalization can itself throw for hostile rejection values.

Controller adjudication: findings 2–4 are accepted. Finding 1 is not a Task 11 blocker because the user-approved recovery design §6 explicitly retains the existing `querySelectorAll` NodeList and requires bounded indexed access rather than iterator/Array materialization; replacing it with a new bounded DOM selection architecture and bounding ancestor visibility would materially expand the approved design. Record it as a future architecture candidate, not a failure of this checkpoint.

The three carried Minors remain deferred. Fresh focused 199/199, full 414/414, typecheck PASS, forbidden scan clean. No Git/dependency/live-target/write/delegation occurred.
