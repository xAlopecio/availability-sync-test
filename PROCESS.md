# PROCESS

How this was built with an AI agent (Claude Code). The detailed record, kept as it happened with commit hashes, is in [`docs/PROCESS-LOG.md`](docs/PROCESS-LOG.md). Every block's PR also carries its review table.

## What I delegated and what I did by hand

**The AI wrote the code, the tests and the documents.** It also probed the portal (about 150 requests to measure its real limits) and ran the suites. I wrote no production code by hand.

**My part was to direct and to decide, and I validated what the AI produced:**
- **The method, before any code.**
  - I asked for the exercise to be explained to me, and for each open decision's consequences, before the SPEC. I wanted the method itself (TDD, skills, branching) in the SPEC.
  - Before the first push I noticed that no branching strategy existed. I had it folded into SPEC v1 instead of the v2 the AI had opened (`f878a08`).
  - Test scenarios had to be approved by me before any test was written.
  - One branch and one PR per block, merged by me, with no branch ever deleted.
- **The design decisions.** The AI analysed the options; I chose:
  - Only `400` and `404` are permanent (SPEC v3, `d692fb4`). Before that, an undocumented status such as `408` would have dropped an accepted update.
  - No ORM (D8).
  - D1 with an optional `Idempotency-Key`. I asked for the reviewer's per-day alternative to be explained before deciding, and the explanation showed that it did not remove the risk.
  - D9's settle window.
  - A single active worker, with the limiter seeded from the database.
  - Alert rules tested with `promtool`. Two of those tests failed against the original rules, so they caught real bugs.
- **Quality checks I asked for:**
  - ESLint and Prettier, which the AI had skipped.
  - Extending the deliberate-defect (mutation) testing from the rate limiter to the domain. 11 of the 41 mutants survived the first run, and they pointed to real gaps in the tests.
  - Restructuring the source tree when I saw tests mixed with code in `src/`. I chose the split by topic against the AI's suggestion.
- **The adversarial review.** I brought the agent from another project and decided to run it once per block. It receives only the SPEC excerpts, the external constraints and the diff, never our reasoning. I decided which of its risks to fix and which to accept, and each PR records it.
- **Before delivery** I reviewed every document before it was committed.

## Where the AI got it wrong, and how we noticed

- **Wrong facts:**
  - "Docker is not installed": I pointed out it was only missing from `PATH`.
  - "The portal hangs": the Mac had gone to sleep, and `pmset` showed it.
  - TypeScript 7 installed without checking that typescript-eslint supports it.
  - A claim that prom-client rejects unknown label values; a probe showed it accepts any.
- **Tests that checked nothing:**
  - Several red tests passed against the stub.
  - One assertion compared a date with a boolean.
  - "No connections after exit" held even without `pool.end()`.

  We caught them by requiring that each red test fail *for the right reason*, and with mutants.
- **Design holes in the first design:**
  - Late writes after a timeout (a flaky AC8 run, which led to D9).
  - The D9 hold checked too early (review).
  - Duplicate POSTs that are not harmless (review).
  - Alerts that read missing data as healthy (review).
  - A crash mid-PUT that let an older value land last (the first e2e run).

  Each became a test, and a SPEC change where it changed the design.
- **Process slips:**
  - A scripted edit that silently matched nothing (`tsc` caught it).
  - A commit made with a failing check.
  - A `git stash drop` that the permission guard blocked before it could discard work.
- **The reviewer erred too:**
  - It called the 25/min limit "a guess"; it never sees the probe.
  - It claimed the per-day model would remove the duplicate-POST risk, which turned out not to be true.

## What I left out, and what I would do next

- **Read-back verification or reconciliation:** a `GET` of the affected days after a queue drains. It is the generic fix for D9's residual risk, a portal that applies a request more than 30 s late, and the first thing I would add.
- **Per-day desired state with coalescing.**
- **A shared rate limiter**, for more than one sending instance.
- **Manual re-drive** of failed updates.
- **`LISTEN/NOTIFY`** instead of polling.
- **A pinned portal image.**

The exercise suggests 3–4 hours. I chose to spend more, on rigour rather than scope.
