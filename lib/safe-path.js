// Central path guards for every filesystem path built from request input.
//
// AgentXRay reads agent session directories, and the API lets the UI point a
// platform at another directory (?dir=, dirCodex=, …). Those overrides and every
// name joined under a base (agent, session id, library prompt, analysis key) go
// through here so a request can never reach outside the directories this tool is
// meant to read:
//   - resolveInside(base, ...parts): resolve under a trusted base and require the
//     result to stay inside it (rejects '..', absolute segments, NUL bytes).
//   - resolveAllowedDir(input): an absolute directory override; its realpath must
//     sit inside an allowed root (HOME, the configured platform/storage dirs, or
//     AGENTXRAY_ALLOWED_DIRS), so a symlink cannot lead outside either.
// Violations throw PathEscapeError (HTTP 403 via its `status`).
const fs = require('fs');
const path = require('path');

class PathEscapeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PathEscapeError';
    this.code = 'EPATHESCAPE';
    this.status = 403;
  }
}

function isInside(root, candidate) {
  return candidate === root || candidate.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

function assertCleanSegment(part) {
  if (typeof part !== 'string') throw new PathEscapeError('path segment must be a string');
  if (part.includes('\0')) throw new PathEscapeError('path segment contains a NUL byte');
}

function resolveInside(base, ...parts) {
  const root = path.resolve(base);
  for (const part of parts) {
    assertCleanSegment(part);
    if (path.isAbsolute(part)) throw new PathEscapeError('absolute path segment not allowed');
  }
  const target = path.resolve(root, ...parts);
  if (!isInside(root, target)) {
    throw new PathEscapeError('path escapes its base directory');
  }
  return target;
}

function realpathOrSelf(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

function allowedRoots(extraRoots) {
  const listed = (process.env.AGENTXRAY_ALLOWED_DIRS || '').split(path.delimiter).filter(Boolean);
  const roots = new Set();
  for (const r of [...extraRoots, ...listed]) {
    if (typeof r !== 'string' || !path.isAbsolute(r)) continue;
    const resolved = path.resolve(r);
    roots.add(resolved);
    roots.add(realpathOrSelf(resolved));
  }
  return [...roots];
}

// Validate a directory override. Returns the realpath (or the resolved path when
// it does not exist yet) once it is proven to sit inside an allowed root.
function resolveAllowedDir(input, extraRoots) {
  assertCleanSegment(input);
  if (!path.isAbsolute(input)) throw new PathEscapeError('dir must be an absolute path');
  if (input.split(/[\\/]/).includes('..')) throw new PathEscapeError("dir must not contain '..'");
  const real = realpathOrSelf(path.resolve(input));
  for (const root of allowedRoots(extraRoots)) {
    if (isInside(root, real)) return resolveInside(root, path.relative(root, real));
  }
  throw new PathEscapeError('dir is outside the allowed roots (HOME, configured dirs, AGENTXRAY_ALLOWED_DIRS)');
}

module.exports = { PathEscapeError, resolveInside, resolveAllowedDir, isInside };
