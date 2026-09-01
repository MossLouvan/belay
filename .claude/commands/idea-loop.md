---
description: Run one round of the autonomous Belay product loop — CEO ideates, a cross-verifying panel judges, the PM ships survivors as PRs
---

Run one round of the Belay product loop by invoking the Workflow tool with
`{ name: "belay-idea-loop" }`.

Optional tuning via the workflow's `args` (pass as a real JSON object, not a
string):

- `ideaCount` — how many ideas the CEO proposes (default 6)
- `buildLimit` — how many survivors the PM may build this round (default 2)
- `repo` — the GitHub repo PRs target (default `MossLouvan/belay`)

The user has explicitly opted into this multi-agent orchestration by asking
for the loop, so calling Workflow here is authorised.

**Hard rule:** nothing this loop produces may reach `main`. Every change ships
as a pull request. If the workflow reports a branch that was built but blocked
by the code panel, leave the branch unmerged and say so — do not open the PR
and do not merge it yourself.

When the workflow returns, report to the user: how many ideas were proposed,
how many survived the panel, which were killed and why, and the URL of every
pull request opened. If zero PRs opened, say plainly why — a quiet round is a
valid outcome, a silent one is not.

To keep it running continuously, the user wraps this in `/loop` — for example
`/loop 45m /idea-loop`.
