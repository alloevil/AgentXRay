const fsp = require('fs/promises');
const path = require('path');
const { ARCHIVE_DIR } = require('../config');
const { runFullBackup, AUTO_BACKUP_INTERVAL_MS, runAutoBackup } = require('../backup');

// Backup: manual trigger + status; auto-backup timers
module.exports = function mountBackupRoutes(app) {
  // Auto-backup: once shortly after startup, then daily. Failures are logged, never fatal.
  setTimeout(runAutoBackup, 10_000).unref();
  setInterval(runAutoBackup, AUTO_BACKUP_INTERVAL_MS).unref();

  app.post('/api/backup', async (req, res) => {
    try {
      res.json(await runFullBackup());
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/backup/status', async (req, res) => {
    try {
      let files = 0;
      let bytes = 0;
      let newest = 0;
      try {
        const entries = await fsp.readdir(ARCHIVE_DIR, { recursive: true });
        for (const rel of entries) {
          if (typeof rel !== 'string') continue;
          const st = await fsp.stat(path.join(ARCHIVE_DIR, rel)).catch(() => null);
          if (!st || !st.isFile()) continue;
          files++;
          bytes += st.size;
          if (st.mtimeMs > newest) newest = st.mtimeMs;
        }
      } catch {
        /* no archive yet */
      }
      res.json({ archiveDir: ARCHIVE_DIR, files, bytes, lastBackup: newest ? new Date(newest).toISOString() : null });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
};
