// Product-prefixed environment variables, post-rename.
//
// The product was called Tether, and every knob was a TETHER_* variable. Those
// names are baked into places this repo cannot reach: the owner's shell
// profile, the LaunchAgent plist an earlier install wrote, scheduled-task
// definitions, CI configs. Renaming the variables outright would have silently
// reverted every one of those settings to its default — a different port, a
// fresh empty state file, notifications off — with no error anywhere.
//
// So BELAY_* is canonical and documented, and TETHER_* is read as a
// fallback, forever cheap to keep. When both are set, BELAY_* wins,
// because the newer name is the one someone set on purpose more recently.

/**
 * Read `BELAY_<suffix>`, falling back to the legacy `TETHER_<suffix>`.
 *
 * The env object is injectable for the same reason notify.ts's loader takes
 * one: tests can exercise both names without mutating process.env.
 */
export function productEnv(
  suffix: string,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const renamed = env[`BELAY_${suffix}`];
  if (renamed !== undefined) return renamed;
  return env[`TETHER_${suffix}`];
}
