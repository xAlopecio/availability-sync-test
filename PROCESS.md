# PROCESS

How this was built with an AI agent (Claude Code). The detailed record, kept as it happened with commit hashes, is in [`docs/PROCESS-LOG.md`](docs/PROCESS-LOG.md). Every block's PR also carries its review table.

## What I delegated and what I did by hand

**The AI wrote the code, the tests and the documents.** It also probed the portal (about 150 requests to measure its real limits) and ran the suites. I wrote no production code by hand.

**My part was to direct and decide, and to validate what the AI produced:**
- **The method, before any code:**
  - I had the exercise and each open decision explained to me before the SPEC.
  - I put the method itself in the SPEC.
  - Before the first push I noticed that no branching strategy existed, and had it folded into v1 (`f878a08`).
  - Every block's test scenarios were approved by me before any test existed.
  - One PR per block, merged by me, with no branch deleted.
- **The design decisions.** The AI analysed the options; I chose:
  - Only `400`/`404` are permanent (`d692fb4`). Before that, a `408` would have dropped an accepted update.
  - No ORM (D8). I raised the question, the AI argued against Prisma, and I agreed.
  - D1 with an optional `Idempotency-Key`. I had the reviewer's per-day alternative explained first, and the explanation showed it did not remove the risk.
  - D9's settle window.
  - A single active worker.
  - Alert rules tested with `promtool`. Two of those tests failed against the original rules.
- **Quality checks I asked for:**
  - ESLint and Prettier, which the AI had skipped.
  - Mutation testing extended to response classification and input validation. 11 of 41 mutants survived, which exposed real gaps.
  - Restructuring the source tree when I saw tests mixed with code. I chose the split by topic against the AI's suggestion.
- **The adversarial review:**
  - I brought the agent from another project and run it once per block.
  - It sees only the SPEC excerpts, the external constraints and the diff.
  - I decided which risks to fix or accept, and each PR records that.
- **Before delivery** I reviewed every document. The AI had already committed them locally, and I had the commits undone first.

## Where the AI got it wrong, and how we noticed

- **Wrong facts, caught by checking:**
  - "Docker is not installed": I pointed out it was only missing from `PATH`.
  - "The portal hangs": the Mac had slept, as `pmset` showed.
  - TypeScript 7, which typescript-eslint does not support.
  - prom-client "rejecting" unknown label values: a probe showed it accepts any.
- **Tests that checked nothing:** red tests passing against stubs, a date compared with a boolean, a shutdown check that held without `pool.end()`. We caught them by requiring each red test to fail for the right reason, with mutants, and by rereading.
- **Holes in the first design**, each turned into a test and, where needed, a SPEC change:
  - late writes after a timeout, from a flaky run (this led to D9);
  - a D9 hold checked too early (review);
  - duplicate POSTs that are not harmless (review);
  - alerts that read missing data as healthy (review);
  - an older value landing last after a crash mid-PUT, from the first e2e run.
- **Process slips:**
  - a scripted edit that matched nothing (`tsc` caught it);
  - a commit made with a failing check;
  - a `git stash drop` blocked by the permission guard;
  - the delivery documents committed before my review.
- **The reviewer erred too.** It called the 25/min limit "a guess", because it never sees the probe. It also claimed the per-day model removed the duplicate-POST risk.

## What I left out, and what I would do next

- **Read-back verification or reconciliation:** a `GET` of the affected days after a queue drains. It closes D9's residual risk, a portal more than 30 s late, and would be my first addition.
- **Per-day desired state with coalescing:** left out for time at first. Later it proved no more correct than D1 + `Idempotency-Key`, only cheaper in requests.
- **A shared rate limiter** for more than one sending instance, **manual re-drive** of failed updates, and **`LISTEN/NOTIFY`** instead of polling.

The exercise suggests 3–4 hours. I chose to spend more, on rigour rather than scope.
