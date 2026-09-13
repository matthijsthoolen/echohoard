# Plane publication record

## Placement

- Workspace: `mijnplane`
- Project: `AI and Experiments` (`AIEX`) / `acbcbf14-0e9e-4e78-8b5e-f9c43788e3cc`
- Module: `EchoHoard` / `1ac9f7c8-55db-49b3-85ba-055fa919d7df`
- V1 overview: `AIEX-24` / `60264f84-4d5f-4475-a410-7358fac2765a`
- Canonical external mapping for the added records: source `echohoard-planning`, ID equal to the story or feature ID.

The existing module is the single execution catalog for V1, the V1.1 compatibility feature, review remediation, and V2. Feature and initiative records are tracking parents; only leaf stories are implementation assignments.

## V1.1 publication

- Feature `EH-13`: `AIEX-120` / `21b55b45-5018-416c-83a4-70f05d6dbec2`, parented to the V1 overview.
- Leaves `EH-13-01` through `EH-13-08`: `AIEX-129` through `AIEX-136`, parented to `EH-13`.
- `EH-13-01` is Ready and `ai-preferred`; the other seven leaves are Backlog until their textual `Blocked by` prerequisites are Done.
- Existing feature `EH-12` and leaf `EH-12-01` were updated so real-data acceptance is blocked by the completed private deployment boundary and `EH-13-08`.

## V2 publication

- Initiative `EHV2`: `AIEX-121` / `d2abe4fc-b56e-4059-885b-26616f1cfe59`, unparented in the same module.
- Feature `EHV2-01`: `AIEX-122` / `f5a04797-6a9b-482a-b103-e361a45cc838`; leaves `AIEX-137` through `AIEX-144`.
- Feature `EHV2-02`: `AIEX-123` / `b5cf8e0e-d79f-4076-893a-f002debc9904`; leaves `AIEX-145` through `AIEX-149`.
- Feature `EHV2-03`: `AIEX-124` / `58414296-343a-4801-91bf-cd0914f9e8df`; leaves `AIEX-150` through `AIEX-155`.
- Feature `EHV2-04`: `AIEX-125` / `d43a2459-ff94-41a1-ada1-29e6505d5e9b`; leaves `AIEX-156` through `AIEX-160`.
- Feature `EHV2-05`: `AIEX-126` / `4e23c333-75e3-4ea5-b097-6afbfd5f7a27`; leaves `AIEX-161` through `AIEX-167`.
- Feature `EHV2-06`: `AIEX-127` / `87066486-04c0-42a5-ac3b-9f2287da5227`; leaves `AIEX-168` through `AIEX-174`.
- Feature `EHV2-07`: `AIEX-128` / `c9b91c0c-449e-4feb-be19-de92293a4e21`; leaves `AIEX-175` through `AIEX-178`.

Sequence IDs within a feature may not reflect dependency order because independent records were published concurrently. External IDs and `docs/TASK_GRAPH.md` are authoritative.

## Worker policy

- Public repository leaves use `ai-preferred`.
- Private deployment/acceptance leaves in `/home/matthijs/projects/unraided-treasures` use `ai-allowed`.
- Final attended V2 sign-off `EHV2-07-04` uses `human-required`.
- All new V2 leaves are Backlog. The orchestrator may promote a leaf only after every textual `Blocked by` ID is Done.
- Every new leaf body contains its repository, context, work, acceptance criteria, verification, exclusions, blockers, priority, model class, explicit start condition, and explicit stop condition.

## Verification

Published and read back on 2026-09-13 through the Plane MCP workflow.

- 59 records were added: one V1.1 feature with eight leaves, and one V2 initiative with seven features and 42 leaves.
- The module reports and lists 148 records after publication; all 59 added IDs are members.
- Every added record has the expected external mapping, state, label, and parent. `EH-13-01` is the only newly Ready leaf.
- Representative public, private, and human-attended leaves were retrieved and confirmed to contain Goal, Verification, Start condition, and Stop condition sections.
- Plane CE dependency relations are not relied upon. Exact blockers remain in each leaf body and in `docs/TASK_GRAPH.md`.
- No implementation, real archive content, credentials, private paths, or deployment values were published.
