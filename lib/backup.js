const fsp = require('fs/promises');
const path = require('path');
const { CODEX_DIR, CLAUDE_CODE_DIR, OMP_DIR, DSH_DIR, ARCHIVE_DIR } = require('./config');

// --- Backup ---
// Incremental session backup: copies platform session logs into
// ARCHIVE_DIR/<platform>/<relative-path-from-platform-root>. A file is skipped
// when its archived copy already exists with the same size and an mtime no
// older than the source. Hermes is excluded (live SQLite db); openclaw too.

// Copy src → dest unless the archived copy is already current; count the outcome
async function backupCopy(srcPath, destPath, counter) {
  let srcStat;
  try {
    srcStat = await fsp.stat(srcPath);
  } catch {
    return;
  }
  try {
    const destStat = await fsp.stat(destPath);
    if (destStat.size === srcStat.size && destStat.mtimeMs >= srcStat.mtimeMs) {
      counter.skipped++;
      return;
    }
  } catch {
    /* not archived yet */
  }
  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  await fsp.copyFile(srcPath, destPath);
  counter.copied++;
}

// Codex sessions live at <root>/YYYY/MM/DD/rollout-*.jsonl
async function backupCodex(counter) {
  const root = CODEX_DIR;
  const destRoot = path.join(ARCHIVE_DIR, 'codex');
  try {
    const entries = await fsp.readdir(root, { recursive: true });
    for (const rel of entries) {
      if (typeof rel === 'string' && rel.endsWith('.jsonl')) {
        await backupCopy(path.join(root, rel), path.join(destRoot, rel), counter);
      }
    }
  } catch {
    /* no codex dir */
  }
}

// Claude Code sessions live at <root>/<project-slug>/*.jsonl; the prompt
// history sits beside the projects dir (~/.claude/history.jsonl)
async function backupClaudeCode(counter) {
  const root = CLAUDE_CODE_DIR;
  const destRoot = path.join(ARCHIVE_DIR, 'claude-code');
  try {
    const slugs = await fsp.readdir(root, { withFileTypes: true });
    for (const s of slugs) {
      if (!s.isDirectory()) continue;
      const slugDir = path.join(root, s.name);
      const entries = await fsp.readdir(slugDir, { withFileTypes: true }).catch(() => []);
      for (const f of entries) {
        if (f.isFile() && f.name.endsWith('.jsonl')) {
          await backupCopy(path.join(slugDir, f.name), path.join(destRoot, s.name, f.name), counter);
        }
      }
    }
  } catch {
    /* no claude dir */
  }
  await backupCopy(path.join(path.dirname(root), 'history.jsonl'), path.join(destRoot, 'history.jsonl'), counter);
}

// OMP sessions live at <root>/<slug>/*.jsonl
async function backupOmp(counter) {
  const root = OMP_DIR;
  const destRoot = path.join(ARCHIVE_DIR, 'omp');
  try {
    const slugs = await fsp.readdir(root, { withFileTypes: true });
    for (const s of slugs) {
      if (!s.isDirectory()) continue;
      const slugDir = path.join(root, s.name);
      const entries = await fsp.readdir(slugDir, { withFileTypes: true }).catch(() => []);
      for (const f of entries) {
        if (f.isFile() && f.name.endsWith('.jsonl')) {
          await backupCopy(path.join(slugDir, f.name), path.join(destRoot, s.name, f.name), counter);
        }
      }
    }
  } catch {
    /* no omp dir */
  }
}

// dsh sessions live at <root>/<projectKey>/<sessionId>/session.jsonl[.zstd]
async function backupDsh(counter) {
  const root = DSH_DIR;
  const destRoot = path.join(ARCHIVE_DIR, 'dsh');
  try {
    const entries = await fsp.readdir(root, { recursive: true });
    for (const rel of entries) {
      if (typeof rel === 'string' && (rel.endsWith('.jsonl') || rel.endsWith('.jsonl.zstd'))) {
        await backupCopy(path.join(root, rel), path.join(destRoot, rel), counter);
      }
    }
  } catch {
    /* no dsh dir */
  }
}

// Run every platform backup and return the summary object served by POST /api/backup
async function runFullBackup() {
  const byPlatform = {
    codex: { copied: 0, skipped: 0 },
    'claude-code': { copied: 0, skipped: 0 },
    omp: { copied: 0, skipped: 0 },
    dsh: { copied: 0, skipped: 0 },
  };
  await Promise.all([
    backupCodex(byPlatform.codex),
    backupClaudeCode(byPlatform['claude-code']),
    backupOmp(byPlatform.omp),
    backupDsh(byPlatform.dsh),
  ]);
  let copied = 0;
  let skipped = 0;
  for (const c of Object.values(byPlatform)) {
    copied += c.copied;
    skipped += c.skipped;
  }
  return { copied, skipped, total: copied + skipped, byPlatform, archiveDir: ARCHIVE_DIR };
}

// Auto-backup: once shortly after startup, then daily. Failures are logged, never fatal.
const AUTO_BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

async function runAutoBackup() {
  try {
    const summary = await runFullBackup();
    console.log(`[backup] copied=${summary.copied} skipped=${summary.skipped} total=${summary.total}`);
  } catch (error) {
    console.log(`[backup] failed: ${error.message}`);
  }
}

module.exports = {
  runFullBackup,
  AUTO_BACKUP_INTERVAL_MS,
  runAutoBackup,
};
