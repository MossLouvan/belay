// Creating a project folder from the phone — the first *write* path in a
// server that has so far only ever read the filesystem. That asymmetry drives
// the design: everything here is at least as strict as the read-only browser
// in files.ts, and stricter where writing raises the stakes.
//
// Confinement reuses the same allow-list the file browser enforces, for two
// reasons. First, the phone can only ever *see* directories through that
// browser, so a parent outside the roots could only arrive as a hand-typed or
// forged path — exactly the input a write API must not honour. Second, a
// write primitive that escaped the roots would be strictly worse than the read
// escape files.ts defends against: creating attacker-named directories in,
// say, /Library/LaunchDaemons or a $PATH directory is a persistence primitive,
// not just a disclosure. (The agent's `POST /agent/sessions` does accept an
// arbitrary cwd today — but it only ever *enters* directories that already
// exist; it never mints new names on disk, so the bar here is higher.)
//
// The split of responsibilities mirrors files.ts: the *parent* is a path and
// goes through realpath so neither `..` nor a symlink can smuggle it outside
// the roots; the *name* is never a path at all — one plain segment, validated
// lexically, appended only after the parent has been resolved. mkdir is called
// non-recursively, so a still-missing parent fails instead of minting a chain
// of directories, and an existing target of any kind (file, dir, symlink —
// mkdir refuses to replace even a dangling link) fails with EEXIST rather
// than being clobbered. That EEXIST check happens *inside* the syscall, so
// there is no check-then-create race on the target itself; the residual
// check-then-use window on the parent path string is the same one files.ts
// documents and accepts under Tether's threat model (local user trusted).

import { mkdir, realpath, stat } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';

import { isInsideRoots, isDenied } from './files.js';

// One path segment on every mainstream filesystem is 255 bytes; half of that
// is already an absurd project name, and a tight cap keeps the created paths
// comfortably usable in shells and UIs.
const MAX_NAME_LENGTH = 128;

// Matches the entry shape of GET /agent/projects (listProjects in agent.ts):
// the phone renders the response of a create straight into the same list.
export interface CreatedProject {
  readonly path: string;
  readonly name: string;
  readonly recent: boolean;
}

/**
 * Validate a project name as a single path segment. Returns the trimmed name
 * or throws a message safe to show on the phone.
 *
 * Leading dots are rejected wholesale, not just `.` and `..`: a dot-name would
 * be invisible in the Files tab (listings skip dotfiles' credential dirs and
 * the phone hides the rest), and names like `.ssh` collide with the deny-list
 * in the worst way. Control characters are rejected because the name ends up
 * in shell prompts, logs and terminal titles once a session runs there.
 */
function validateName(name: unknown): string {
  if (typeof name !== 'string') throw new Error('project name is required');
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new Error('project name is required');
  if (trimmed.length > MAX_NAME_LENGTH) {
    throw new Error(`project name must be ${MAX_NAME_LENGTH} characters or fewer`);
  }
  if (/[/\\]/.test(trimmed)) throw new Error('project name cannot contain slashes');
  // eslint-disable-next-line no-control-regex
  if (/[\0-\x1f\x7f]/.test(trimmed)) throw new Error('project name contains unusable characters');
  if (trimmed.startsWith('.')) throw new Error('project name cannot start with a dot');
  return trimmed;
}

/**
 * Resolve the parent to its real location and assert it is a directory inside
 * the allow-list. Deny-listed locations report the same "outside" message as
 * genuinely outside ones — distinguishing them would confirm to a probing
 * client which sensitive paths exist.
 */
async function resolveParent(parent: unknown): Promise<string> {
  if (typeof parent !== 'string' || parent.trim().length === 0) {
    throw new Error('parent folder is required');
  }
  let real: string;
  try {
    real = await realpath(resolve(parent));
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') throw new Error('parent folder does not exist');
    if (code === 'EACCES' || code === 'EPERM') throw new Error('parent folder is not accessible');
    throw new Error('parent folder could not be resolved');
  }
  if (!isInsideRoots(real) || isDenied(real)) {
    throw new Error('parent folder is outside the allowed folders');
  }
  const s = await stat(real);
  if (!s.isDirectory()) throw new Error('parent is not a folder');
  return real;
}

export async function createProject(name: unknown, parent: unknown): Promise<CreatedProject> {
  const segment = validateName(name);
  const dir = await resolveParent(parent);
  const target = join(dir, segment);
  // The name alone can steer the target onto the deny-list (`tether-state.json`
  // as a directory name, say) even with a clean parent.
  if (isDenied(target)) throw new Error('that name cannot be used here');
  try {
    await mkdir(target); // non-recursive on purpose — see the header comment
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'EEXIST') throw new Error('something with that name already exists there');
    if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
      throw new Error('that folder is not writable');
    }
    throw new Error('the project folder could not be created');
  }
  return { path: target, name: segment, recent: true };
}

/**
 * Where a new project should go when the phone offers no opinion: Documents
 * when it exists (it is also where listProjects scans for repos, so the new
 * project shows up naturally), Home otherwise.
 */
export function defaultProjectParent(): string {
  const documents = join(homedir(), 'Documents');
  try {
    if (existsSync(documents) && statSync(documents).isDirectory()) return documents;
  } catch { /* fall through to home */ }
  return homedir();
}
