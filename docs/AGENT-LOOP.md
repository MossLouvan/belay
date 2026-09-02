# The Belay agent loop

An autonomous product loop: a CEO proposes work, a panel of agents judges it,
those agents are audited by each other, and a project manager ships what
survives as **pull requests**. Nothing it produces reaches `main`.

Run one round with `/idea-loop`. Keep it running with `/loop 45m /idea-loop`.

Every agent in the loop runs on **Fable 5**.

> Implementation note: the workflow runtime resolves only built-in subagent types, so each role's instructions are inlined into its prompt and every agent runs as `general-purpose` (still on Fable 5). The `.claude/agents/*.md` files remain the human-readable source of truth for these roles.

## The roster

| Agent | Role | Writes code | Verified by |
|---|---|---|---|
| `ceo` | Proposes ideas grounded in the repo and its docs | no | the four idea lenses |
| `idea-verifier` × 4 | Judges one idea through one lens | no | `cross-auditor` |
| `cross-auditor` | Audits the verifiers' verdicts | no | nobody — last layer, on purpose |
| `project-manager` | Triages, implements, opens the PR | yes | the four code lenses |
| `code-verifier` × 4 | Reviews one diff through one lens | no | `cross-auditor` |

## The verification matrix

Every idea and every diff is judged once per lens by an independent agent.
Each lens is narrow by design — that is what keeps the votes independent
rather than four generalists agreeing with each other.

| Stage | Lens | Asks |
|---|---|---|
| Idea | `feasibility` | Can this be built inside this repo as it actually is? |
| Idea | `value` | Would a real person notice, and care? |
| Idea | `novelty` | Does this already exist, wholly or partly? |
| Idea | `risk` | What breaks — pairing, auth, the compatibility shims? |
| Code | `correctness` | Does it do what the PR claims, and what breaks it? |
| Code | `scope` | Is anything here beyond what the idea asked for? |
| Code | `tests` | Do the tests prove the claim, or restate the code? |
| Code | `conventions` | Does this look like the code around it? |

Then the agents verify each other: a `cross-auditor` reads the panel's
verdicts and checks every citation against the real repo, flags any verifier
that strayed outside its lens, catches contradictions, and reports what the
whole panel walked past.

An overturned verdict is **dropped from the vote**, not flipped. The auditor
establishes that a verifier did not do its job — not what the right answer
was.

Without that layer a confident verifier who never opened a file carries the
same weight as one who read the diff, and the panel quietly degrades into a
vote of vibes.

## Surviving

An artifact survives when no upheld verdict is a `block` and at least half the
upheld verdicts pass. A blocked diff leaves its branch unmerged with **no pull
request** — a round that ships nothing is a valid outcome.

## Why pull requests, never main

The owner pushes to `main` himself for work he asked for directly. Work that
no human requested turn by turn gets a review gate. The PM agent is told this
in its own definition, the slash command repeats it, and the workflow only
ever calls `gh pr create`.

## Shape of a round

```
Ideate      CEO → N candidate ideas
Judge       4 lenses per idea, independently          ─┐ pipelined: an idea
Cross-audit auditor checks those 4 verdicts           ─┘ moves on alone
Triage      PM ranks survivors, picks ≤ buildLimit     ← barrier, ranks against each other
Build       one PM agent per idea, isolated worktree  ─┐
Review      4 lenses per diff, independently           │ pipelined
Audit code  auditor checks those 4 verdicts            │
Ship        gh pr create, carrying both tables        ─┘
```

Judging is pipelined rather than barriered: an idea reaches the auditor as
soon as its own panel finishes, instead of every idea waiting on the slowest
panel in the batch. Triage is the one genuine barrier, because ranking is
inherently comparative.

## Tuning

`/idea-loop` takes `ideaCount` (default 6), `buildLimit` (default 2) and
`repo` (default `MossLouvan/belay`). Raising `buildLimit` raises the number of
open PRs per round, not the quality of any one of them.
