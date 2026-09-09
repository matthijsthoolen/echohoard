# EchoHoard V1 validated task graph

## Execution summary

| ID | Task | Priority | Model class | Blocked by | Plane state |
|---|---|---|---|---|---|
| EH-01 | Bootstrap framework and quality gates | high | medium | none | Ready |
| EH-02 | Establish archive schema and isolation | high | complex | EH-01 | Backlog |
| EH-03 | Preserve and decrypt snapshot batches | high | complex | EH-01, EH-02 | Backlog |
| EH-04 | Import text history with provenance and convergence | high | reasoning | EH-02, EH-03 | Backlog |
| EH-05 | Import rich messages and content-addressed media | high | complex | EH-04 | Backlog |
| EH-06 | Build bounded read services and PostgreSQL search | high | complex | EH-04 | Backlog |
| EH-07 | Deliver authenticated responsive archive viewer | high | complex | EH-05, EH-06 | Backlog |
| EH-08 | Expose archive health and deterministic statistics | high | medium | EH-03, EH-05, EH-06 | Backlog |
| EH-09 | Expose the private read-only MCP surface | high | complex | EH-05, EH-06, EH-08 | Backlog |
| EH-10 | Package the production web and worker roles | medium | medium | EH-07, EH-08, EH-09 | Backlog |
| EH-11 | Integrate the private Unraid deployment and recovery | high | complex | EH-10 | Backlog |
| EH-12 | Accept real data, scale, security, and Hermes traversal | high | complex | EH-11 | Backlog |

Only tasks with no unresolved blockers may move to Ready. EH-12 requires attended access to private data and systems and should carry `human-required`; EH-01 through EH-10 are `ai-preferred`; EH-11 is `ai-allowed` because it crosses private infrastructure and deployment approvals.

## Dependency graph

```text
EH-01
  |
  +--> EH-02 --> EH-03 --> EH-04 --+--> EH-05 --+
                                   |            +--> EH-07 --+
                                   +--> EH-06 --+             |
                                        |       +--> EH-08 ---+--> EH-10 --> EH-11 --> EH-12
                                        +----------------> EH-09 --+
                                                EH-05/08 ---^      |
```

The edge list is authoritative if the diagram is visually ambiguous:

- EH-02 blocked by EH-01
- EH-03 blocked by EH-01, EH-02
- EH-04 blocked by EH-02, EH-03
- EH-05 blocked by EH-04
- EH-06 blocked by EH-04
- EH-07 blocked by EH-05, EH-06
- EH-08 blocked by EH-03, EH-05, EH-06
- EH-09 blocked by EH-05, EH-06, EH-08
- EH-10 blocked by EH-07, EH-08, EH-09
- EH-11 blocked by EH-10
- EH-12 blocked by EH-11

## Coverage of feature acceptance

| Acceptance criteria | Owning task(s) |
|---|---|
| AC-01, AC-02, AC-03 | EH-01 |
| AC-04, AC-05, AC-06, AC-07, AC-08 | EH-03, EH-10, EH-12 |
| AC-09, AC-10, AC-11, AC-12, AC-13, AC-14, AC-15, AC-16 | EH-02, EH-04, EH-05, EH-12 |
| AC-17, AC-18, AC-19, AC-20 | EH-05, EH-07, EH-08 |
| AC-21, AC-22, AC-23 | EH-06, EH-07, EH-12 |
| AC-24, AC-25 | EH-08 |
| AC-26, AC-27, AC-28 | EH-09, EH-11, EH-12 |
| AC-29 | EH-10, EH-11 |
| AC-30 | EH-11, EH-12 |

## Graph validation

- Every acceptance criterion has an owning task and observable verification.
- Every task has a finite end state in its task file.
- The blocker graph is acyclic.
- Media import (EH-05) and search (EH-06) can proceed in parallel after the core importer.
- Viewer (EH-07) and health/statistics (EH-08) can overlap once their read seams exist.
- Public packaging is separated from private deployment; no public task requires private hostnames, credentials, or data.
- Real-data and live Hermes claims are reserved for EH-12; repository tests cannot falsely satisfy them.
- No task introduces a V1 non-goal.

## Task contracts

- [EH-01](tasks/EH-01.md)
- [EH-02](tasks/EH-02.md)
- [EH-03](tasks/EH-03.md)
- [EH-04](tasks/EH-04.md)
- [EH-05](tasks/EH-05.md)
- [EH-06](tasks/EH-06.md)
- [EH-07](tasks/EH-07.md)
- [EH-08](tasks/EH-08.md)
- [EH-09](tasks/EH-09.md)
- [EH-10](tasks/EH-10.md)
- [EH-11](tasks/EH-11.md)
- [EH-12](tasks/EH-12.md)
