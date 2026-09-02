export const meta = {
  name: 'belay-idea-loop',
  description: 'CEO generates Belay ideas, a cross-verifying agent panel judges them, the PM ships survivors as pull requests (never main)',
  whenToUse: 'One round of the autonomous Belay product loop. Wrap in /loop to keep it running.',
  phases: [
    { title: 'Ideate', detail: 'CEO reads the repo and proposes candidate ideas', model: 'fable' },
    { title: 'Judge', detail: 'four lenses judge each idea independently', model: 'fable' },
    { title: 'Cross-audit', detail: 'auditor checks the judges on each other', model: 'fable' },
    { title: 'Triage', detail: 'PM ranks survivors and picks what to build', model: 'fable' },
    { title: 'Build', detail: 'one PM agent per idea, isolated worktree, branch only', model: 'fable' },
    { title: 'Review', detail: 'four lenses review each diff independently', model: 'fable' },
    { title: 'Audit code', detail: 'auditor checks the reviewers on each other', model: 'fable' },
    { title: 'Ship', detail: 'open a pull request carrying both verification tables', model: 'fable' },
  ],
};

// Every agent in this loop runs on Fable 5.
const MODEL = 'fable';

// The verification matrix. Each artifact is judged once per lens by an
// independent agent, then every one of those verdicts is audited by a peer —
// that second pass is the agents verifying each other, and it is what stops a
// confident verifier who never opened a file from carrying a vote.
const IDEA_LENSES = ['feasibility', 'value', 'novelty', 'risk'];
const CODE_LENSES = ['correctness', 'scope', 'tests', 'conventions'];

const cfg = args ?? {};
const IDEA_COUNT = cfg.ideaCount ?? 6;
const BUILD_LIMIT = cfg.buildLimit ?? 2;
const REPO = cfg.repo ?? 'MossLouvan/belay';

// ---------------------------------------------------------------- schemas

const IDEAS_SCHEMA = {
  type: 'object',
  required: ['ideas'],
  properties: {
    ideas: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'title', 'problem', 'change', 'evidence'],
        properties: {
          id: { type: 'string', description: 'short kebab-case slug' },
          title: { type: 'string' },
          problem: { type: 'string', description: 'the friction a real user hits' },
          change: { type: 'string', description: 'what would actually be built' },
          evidence: { type: 'string', description: 'file, doc or commit this came from' },
          risks: { type: 'string' },
        },
      },
    },
  },
};

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['verdict', 'confidence', 'reason'],
  properties: {
    verdict: { type: 'string', enum: ['pass', 'pass_with_notes', 'block'] },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    reason: { type: 'string', description: 'one or two sentences' },
    evidence: { type: 'string', description: 'file:line, symbol or commit examined' },
  },
};

const AUDIT_SCHEMA = {
  type: 'object',
  required: ['rulings'],
  properties: {
    rulings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['lens', 'upheld', 'note'],
        properties: {
          lens: { type: 'string' },
          upheld: { type: 'boolean' },
          note: { type: 'string' },
        },
      },
    },
    missedObvious: { type: 'string', description: 'empty when the panel missed nothing' },
  },
};

const PICK_SCHEMA = {
  type: 'object',
  required: ['build', 'killed'],
  properties: {
    build: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'why'],
        properties: { id: { type: 'string' }, why: { type: 'string' } },
      },
    },
    killed: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'why'],
        properties: { id: { type: 'string' }, why: { type: 'string' } },
      },
    },
  },
};

const BUILD_SCHEMA = {
  type: 'object',
  required: ['status', 'branch', 'summary'],
  properties: {
    status: { type: 'string', enum: ['built', 'blocked'] },
    branch: { type: 'string' },
    summary: { type: 'string' },
    testOutput: { type: 'string' },
    blockedReason: { type: 'string' },
  },
};

const SHIP_SCHEMA = {
  type: 'object',
  required: ['status'],
  properties: {
    status: { type: 'string', enum: ['opened', 'skipped'] },
    prUrl: { type: 'string' },
    note: { type: 'string' },
  },
};

// ---------------------------------------------------------------- helpers

/** Renders one artifact's panel + audit as a markdown table for the PR body. */
function verdictTable(rows) {
  const header = '| Agent | Lens | Verdict | Confidence | Evidence | Peer audit |';
  const rule = '|---|---|---|---|---|---|';
  const body = rows.map((r) => {
    const audit = r.upheld === false ? `overturned — ${r.auditNote}` : 'upheld';
    return `| ${r.agent} | ${r.lens} | ${r.verdict} | ${r.confidence} | ${cell(r.evidence)} | ${cell(audit)} |`;
  });
  return [header, rule, ...body].join('\n');
}

/** Keeps a free-text field from breaking out of its table cell. */
function cell(text) {
  return String(text ?? '—').replace(/\|/g, '\\|').replace(/\n+/g, ' ').slice(0, 180);
}

/**
 * Merges a lens panel with the auditor's rulings. An overturned verdict is
 * dropped from the vote entirely rather than flipped — the auditor establishes
 * that a verifier did not do its job, not what the right answer was.
 */
function scorePanel(agentName, lenses, verdicts, audit) {
  const rulings = new Map((audit?.rulings ?? []).map((r) => [r.lens, r]));
  const rows = lenses.map((lens, i) => {
    const v = verdicts[i];
    const ruling = rulings.get(lens);
    return {
      agent: agentName,
      lens,
      verdict: v?.verdict ?? 'missing',
      confidence: v?.confidence ?? '—',
      evidence: v?.evidence ?? v?.reason ?? '—',
      upheld: ruling ? ruling.upheld : true,
      auditNote: ruling?.note ?? '',
    };
  });
  const counted = rows.filter((r) => r.upheld && r.verdict !== 'missing');
  const blocked = counted.some((r) => r.verdict === 'block');
  const passes = counted.filter((r) => r.verdict !== 'block').length;
  return {
    rows,
    table: verdictTable(rows),
    survives: !blocked && passes >= Math.ceil(lenses.length / 2),
    missedObvious: audit?.missedObvious ?? '',
  };
}

// ---------------------------------------------------------------- 1. ideate

phase('Ideate');
const ideation = await agent(
  `Propose ${IDEA_COUNT} candidate ideas for Belay. Read the repo first — ` +
    `docs/PRODUCT-REVIEW.md, docs/FEATURE-AUDIT.md, docs/CHECKLIST.md, docs/DESIGN.md, ` +
    `and \`git log --oneline -40\` — so nothing you propose is already shipped. ` +
    `Each idea must be one pull request's worth of work and must name the evidence it came from.`,
  { agentType: 'ceo', model: MODEL, phase: 'Ideate', label: 'ceo:ideate', schema: IDEAS_SCHEMA },
);

const ideas = (ideation?.ideas ?? []).slice(0, IDEA_COUNT);
if (ideas.length === 0) {
  log('CEO returned no ideas — nothing to do this round.');
  return { ideas: [], built: [], prs: [] };
}
log(`${ideas.length} ideas proposed. Judging each on ${IDEA_LENSES.length} lenses.`);

// ------------------------------------------------- 2 + 3. judge, cross-audit

// Pipelined on purpose: an idea reaches the auditor as soon as its own panel
// finishes, instead of every idea waiting on the slowest panel in the batch.
const judged = await pipeline(
  ideas,
  (idea) =>
    parallel(
      IDEA_LENSES.map((lens) => () =>
        agent(
          `Judge this Belay idea through the ${lens} lens only.\n\n` +
            `Title: ${idea.title}\nProblem: ${idea.problem}\n` +
            `Proposed change: ${idea.change}\nCEO's evidence: ${idea.evidence}\n` +
            `CEO's stated risks: ${idea.risks ?? 'none stated'}`,
          {
            agentType: 'idea-verifier',
            model: MODEL,
            phase: 'Judge',
            label: `judge:${lens}:${idea.id}`,
            schema: VERDICT_SCHEMA,
          },
        ),
      ),
    ),
  async (verdicts, idea) => {
    const audit = await agent(
      `Audit these verdicts on the Belay idea "${idea.title}". Check every citation ` +
        `against the real repo, flag any verifier that strayed outside its lens, and ` +
        `report anything the whole panel missed. Do not re-judge the idea itself.\n\n` +
        IDEA_LENSES.map((lens, i) => `${lens}: ${JSON.stringify(verdicts[i])}`).join('\n'),
      {
        agentType: 'cross-auditor',
        model: MODEL,
        phase: 'Cross-audit',
        label: `audit:${idea.id}`,
        schema: AUDIT_SCHEMA,
      },
    );
    return { idea, ...scorePanel('idea-verifier', IDEA_LENSES, verdicts, audit) };
  },
);

const surviving = judged.filter(Boolean).filter((j) => j.survives);
log(`${surviving.length} of ${ideas.length} ideas survived the panel.`);
if (surviving.length === 0) {
  return {
    built: [],
    prs: [],
    ideaTables: judged.filter(Boolean).map((j) => ({ id: j.idea.id, table: j.table })),
  };
}

// ---------------------------------------------------------------- 4. triage

// A genuine barrier: the PM ranks ideas against each other, so it needs the
// whole surviving set before it can choose.
phase('Triage');
const picked = await agent(
  `Here are the Belay ideas that survived the verification panel, each with its ` +
    `verdict table. Pick at most ${BUILD_LIMIT} to build this round, and say why you ` +
    `killed the rest. Prefer small, user-visible, cleanly landable work.\n\n` +
    surviving
      .map((s) => `### ${s.idea.id} — ${s.idea.title}\n${s.idea.problem}\n\n${s.table}\n` +
        (s.missedObvious ? `\nAuditor flagged as missed: ${s.missedObvious}\n` : ''))
      .join('\n'),
  { agentType: 'project-manager', model: MODEL, phase: 'Triage', label: 'pm:triage', schema: PICK_SCHEMA },
);

const byId = new Map(surviving.map((s) => [s.idea.id, s]));
const chosen = (picked?.build ?? []).map((b) => byId.get(b.id)).filter(Boolean).slice(0, BUILD_LIMIT);
log(`PM picked ${chosen.length}: ${chosen.map((c) => c.idea.id).join(', ') || 'none'}`);
if (chosen.length === 0) {
  return { built: [], prs: [], killed: picked?.killed ?? [] };
}

// ------------------------------------------- 5 + 6 + 7. build, review, ship

const shipped = await pipeline(
  chosen,
  // Worktree isolation: these agents edit files concurrently and would
  // otherwise trample each other in one checkout.
  (item) =>
    agent(
      `Implement this Belay idea on a NEW BRANCH. Never commit to main, never push to main.\n\n` +
        `Idea: ${item.idea.title}\nProblem: ${item.idea.problem}\nChange: ${item.idea.change}\n\n` +
        `Match the conventions of the code you are changing. Pure logic gets its own module ` +
        `and an adjacent .test.mjs. Then run \`cd app && npx tsc --noEmit && npm test\` and ` +
        `\`cd server && npm test\` and report their real output. Commit to the branch. ` +
        `Do NOT open the pull request — a later step does that.`,
      {
        agentType: 'project-manager',
        model: MODEL,
        phase: 'Build',
        isolation: 'worktree',
        label: `build:${item.idea.id}`,
        schema: BUILD_SCHEMA,
      },
    ).then((build) => ({ item, build })),

  async ({ item, build }) => {
    if (!build || build.status !== 'built') {
      log(`${item.idea.id}: blocked — ${build?.blockedReason ?? 'build agent returned nothing'}`);
      return { item, build, shipped: null };
    }
    const verdicts = await parallel(
      CODE_LENSES.map((lens) => () =>
        agent(
          `Review branch ${build.branch} through the ${lens} lens only. Read the real diff ` +
            `with \`git diff main...${build.branch}\` — the summary below is a claim to check, ` +
            `not a description to trust.\n\nClaimed: ${build.summary}`,
          {
            agentType: 'code-verifier',
            model: MODEL,
            phase: 'Review',
            label: `review:${lens}:${item.idea.id}`,
            schema: VERDICT_SCHEMA,
          },
        ),
      ),
    );
    return { item, build, verdicts };
  },

  async (stage, item) => {
    if (!stage?.verdicts) return stage;
    const { build, verdicts } = stage;
    const audit = await agent(
      `Audit these code-review verdicts on branch ${build.branch}. Verify every cited ` +
        `file and line actually says what the reviewer claims, flag any reviewer that ` +
        `strayed outside its lens, and report anything the whole panel walked past. ` +
        `Do not re-review the diff yourself.\n\n` +
        CODE_LENSES.map((lens, i) => `${lens}: ${JSON.stringify(verdicts[i])}`).join('\n'),
      {
        agentType: 'cross-auditor',
        model: MODEL,
        phase: 'Audit code',
        label: `audit-code:${item.idea.id}`,
        schema: AUDIT_SCHEMA,
      },
    );
    const panel = scorePanel('code-verifier', CODE_LENSES, verdicts, audit);

    if (!panel.survives) {
      log(`${item.idea.id}: blocked by code panel — branch ${build.branch} left unmerged, no PR.`);
      return { item, build, panel, shipped: null };
    }

    const ship = await agent(
      `Open a pull request for branch ${build.branch} against main in ${REPO}, using ` +
        `\`gh pr create\`. Do not merge it and do not touch main.\n\n` +
        `The body must contain, in order: what changed and why; the idea's verification ` +
        `table; the code verification table; the real test output; and anything left out ` +
        `of scope.\n\n## Idea\n${item.idea.title}\n${item.idea.problem}\n\n` +
        `## Idea verification\n${item.table}\n\n## Code verification\n${panel.table}\n\n` +
        `## Tests\n${build.testOutput ?? 'not reported'}\n` +
        (panel.missedObvious ? `\n## Auditor flagged\n${panel.missedObvious}\n` : ''),
      {
        agentType: 'project-manager',
        model: MODEL,
        phase: 'Ship',
        label: `pr:${item.idea.id}`,
        schema: SHIP_SCHEMA,
      },
    );
    return { item, build, panel, shipped: ship };
  },
);

const results = shipped.filter(Boolean);
const prs = results.filter((r) => r.shipped?.status === 'opened').map((r) => r.shipped.prUrl);
log(`Round complete. ${prs.length} pull request(s) opened; nothing was pushed to main.`);

return {
  proposed: ideas.length,
  survivedPanel: surviving.length,
  built: results.filter((r) => r.build?.status === 'built').map((r) => r.item.idea.id),
  blocked: results.filter((r) => !r.shipped).map((r) => r.item.idea.id),
  prs,
  killed: picked?.killed ?? [],
};
