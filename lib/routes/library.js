const fsp = require('fs/promises');
const { LIBRARY_DIR } = require('../config');
const {
  LIBRARY_NAME_RE,
  INSTALL_TARGETS,
  sanitizeLibraryName,
  libraryFilePath,
  installedFilePath,
  normalizeLibraryTags,
  parseLibraryFile,
  serializeLibraryFile,
  detectInstalled,
  readLibraryPrompt,
  installLibraryPrompt,
  uninstallLibraryPrompt,
  parseInstallTargets,
  gitLibrary,
  startLibraryGit,
  commitLibrary,
  fetchFabricPattern,
  listFabricPatternNames,
  fabricLibraryName,
  fabricDescription,
  listLibraryNames,
  getLibraryUsageCache,
  setLibraryUsageCache,
  computeLibraryUsage,
} = require('../library');
const { runClaudeCli } = require('../prompts');

// Prompt Library: curated prompts stored as markdown files with frontmatter
module.exports = function mountLibraryRoutes(app) {
  startLibraryGit();

  app.get('/api/library', async (req, res) => {
    try {
      let entries;
      try {
        entries = await fsp.readdir(LIBRARY_DIR);
      } catch (error) {
        if (error.code === 'ENOENT') return res.json({ prompts: [] });
        throw error;
      }
      const names = entries
        .filter((entry) => entry.endsWith('.md'))
        .map((entry) => entry.slice(0, -3))
        .filter((name) => LIBRARY_NAME_RE.test(name));
      const prompts = await Promise.all(names.map((name) => readLibraryPrompt(name)));
      prompts.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
      res.json({ prompts });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/library', async (req, res) => {
    try {
      const body = req.body || {};
      const name = sanitizeLibraryName(body.name);
      if (!name) {
        return res.status(400).json({ error: 'Invalid name: must match /^[a-z0-9][a-z0-9-]{0,63}$/' });
      }
      const content = typeof body.content === 'string' ? body.content : '';
      if (!content.trim()) {
        return res.status(400).json({ error: 'content is required' });
      }
      const meta = {
        description: typeof body.description === 'string' ? body.description : '',
        tags: normalizeLibraryTags(body.tags),
        source: typeof body.source === 'string' && body.source ? body.source : 'manual',
        createdAt: new Date().toISOString(),
      };
      await fsp.mkdir(LIBRARY_DIR, { recursive: true });
      try {
        await fsp.writeFile(libraryFilePath(name), serializeLibraryFile(meta, content), {
          encoding: 'utf8',
          flag: 'wx',
        });
      } catch (error) {
        if (error.code === 'EEXIST') return res.status(409).json({ error: `Prompt "${name}" already exists` });
        throw error;
      }
      commitLibrary(`create: ${name}`);
      res.status(201).json({ prompt: await readLibraryPrompt(name) });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/library/usage', async (req, res) => {
    try {
      const cachedUsage = getLibraryUsageCache();
      if (cachedUsage) {
        return res.json(cachedUsage);
      }
      let entries = [];
      try {
        entries = await fsp.readdir(LIBRARY_DIR);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      const names = entries
        .filter((entry) => entry.endsWith('.md'))
        .map((entry) => entry.slice(0, -3))
        .filter((name) => LIBRARY_NAME_RE.test(name));
      const data = { usage: names.length ? await computeLibraryUsage(names) : {} };
      setLibraryUsageCache(data);
      res.json(data);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.put('/api/library/:name', async (req, res) => {
    const name = sanitizeLibraryName(req.params.name);
    if (!name) {
      return res.status(400).json({ error: 'Invalid name' });
    }

    try {
      const body = req.body || {};
      let raw;
      try {
        raw = await fsp.readFile(libraryFilePath(name), 'utf8');
      } catch (error) {
        if (error.code === 'ENOENT') return res.status(404).json({ error: 'Prompt not found' });
        throw error;
      }
      const { meta, content } = parseLibraryFile(raw);

      let newName = name;
      if (body.newName !== undefined && body.newName !== name) {
        newName = sanitizeLibraryName(body.newName);
        if (!newName) {
          return res.status(400).json({ error: 'Invalid newName: must match /^[a-z0-9][a-z0-9-]{0,63}$/' });
        }
        const exists = await fsp.access(libraryFilePath(newName)).then(
          () => true,
          () => false
        );
        if (exists) return res.status(409).json({ error: `Prompt "${newName}" already exists` });
      }

      if (body.description !== undefined)
        meta.description = typeof body.description === 'string' ? body.description : '';
      if (body.tags !== undefined) meta.tags = normalizeLibraryTags(body.tags);
      const nextContent = body.content !== undefined ? String(body.content) : content;
      if (!nextContent.trim()) {
        return res.status(400).json({ error: 'content must not be empty' });
      }

      await fsp.writeFile(libraryFilePath(newName), serializeLibraryFile(meta, nextContent), 'utf8');
      if (newName !== name) {
        await fsp.unlink(libraryFilePath(name)).catch(() => {});
      }

      // Refresh installed copies; a rename also renames them
      for (const target of Object.keys(INSTALL_TARGETS)) {
        const wasInstalled = await fsp.access(installedFilePath(target, name)).then(
          () => true,
          () => false
        );
        if (!wasInstalled) continue;
        if (newName !== name) await uninstallLibraryPrompt(name, [target]);
        await installLibraryPrompt({ name: newName, description: meta.description, content: nextContent }, [target]);
      }

      commitLibrary(newName !== name ? `rename: ${name} -> ${newName}` : `update: ${newName}`);

      res.json({ prompt: await readLibraryPrompt(newName) });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.delete('/api/library/:name', async (req, res) => {
    const name = sanitizeLibraryName(req.params.name);
    if (!name) {
      return res.status(400).json({ error: 'Invalid name' });
    }

    try {
      try {
        await fsp.unlink(libraryFilePath(name));
      } catch (error) {
        if (error.code === 'ENOENT') return res.status(404).json({ error: 'Prompt not found' });
        throw error;
      }
      await uninstallLibraryPrompt(name, Object.keys(INSTALL_TARGETS));
      commitLibrary(`delete: ${name}`);
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/library/:name/install', async (req, res) => {
    const name = sanitizeLibraryName(req.params.name);
    if (!name) {
      return res.status(400).json({ error: 'Invalid name' });
    }

    try {
      const targets = parseInstallTargets(req.body);
      if (!targets) {
        return res.status(400).json({ error: 'targets must be a non-empty array of "claude" | "codex" | "omp"' });
      }
      let prompt;
      try {
        prompt = await readLibraryPrompt(name);
      } catch (error) {
        if (error.code === 'ENOENT') return res.status(404).json({ error: 'Prompt not found' });
        throw error;
      }
      await installLibraryPrompt(prompt, targets);
      res.json({ installed: await detectInstalled(name) });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/library/:name/uninstall', async (req, res) => {
    const name = sanitizeLibraryName(req.params.name);
    if (!name) {
      return res.status(400).json({ error: 'Invalid name' });
    }

    try {
      const targets = parseInstallTargets(req.body);
      if (!targets) {
        return res.status(400).json({ error: 'targets must be a non-empty array of "claude" | "codex" | "omp"' });
      }
      await uninstallLibraryPrompt(name, targets);
      res.json({ installed: await detectInstalled(name) });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Suggest a kebab-case slash-command name for a prompt via the local claude CLI.
  // Always replies { name } — name is null when the CLI is missing or its output
  // can't be shaped into a valid library name. 400 only for a missing/empty text.
  app.post('/api/library/suggest-name', async (req, res) => {
    const text = typeof (req.body || {}).text === 'string' ? req.body.text.trim() : '';
    if (!text) {
      return res.status(400).json({ error: 'text is required' });
    }
    const prompt = [
      'Suggest a short slash-command name for the prompt below.',
      'Reply with ONLY the name: 2-4 English words, kebab-case, ascii lowercase letters/digits/dashes.',
      'No explanation, no quotes, no punctuation other than dashes.',
      '',
      'Prompt:',
      text.slice(0, 500),
    ].join('\n');
    try {
      const raw = await runClaudeCli(prompt, 10_000);
      const name = raw
        .trim()
        .split('\n')
        .pop()
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/-+/g, '-')
        .slice(0, 64)
        .replace(/^-+|-+$/g, '');
      res.json({ name: sanitizeLibraryName(name) });
    } catch {
      res.json({ name: null });
    }
  });

  // Available fabric pattern names, flagged with whether each is already in the
  // library (checked against the sanitized name the import would use).
  app.get('/api/library/fabric-patterns', async (req, res) => {
    try {
      let names;
      try {
        names = await listFabricPatternNames();
      } catch (error) {
        return res.status(502).json({ error: `Could not fetch fabric patterns: ${error.message}` });
      }
      const existing = await listLibraryNames();
      res.json({ patterns: names.map((name) => ({ name, imported: existing.has(fabricLibraryName(name)) })) });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Import fabric patterns by name: downloads each pattern's system.md and
  // creates a library entry. Result arrays echo the requested (raw) names.
  app.post('/api/library/import-fabric', async (req, res) => {
    try {
      const names = Array.isArray((req.body || {}).names) ? req.body.names : null;
      if (
        !names ||
        names.length < 1 ||
        names.length > 300 ||
        !names.every((name) => typeof name === 'string' && name)
      ) {
        return res.status(400).json({ error: 'names must be an array of 1-300 pattern names' });
      }
      await fsp.mkdir(LIBRARY_DIR, { recursive: true });
      const existing = await listLibraryNames();
      const imported = [];
      const skipped = [];
      const failed = [];
      for (let i = 0; i < names.length; i += 8) {
        await Promise.all(
          names.slice(i, i + 8).map(async (rawName) => {
            const name = fabricLibraryName(rawName);
            if (!name) return failed.push(rawName);
            if (existing.has(name)) return skipped.push(rawName);
            try {
              const content = await fetchFabricPattern(rawName);
              if (!content.trim()) throw new Error('empty pattern');
              const meta = {
                description: fabricDescription(content),
                tags: ['fabric'],
                source: 'fabric',
                createdAt: new Date().toISOString(),
              };
              await fsp.writeFile(libraryFilePath(name), serializeLibraryFile(meta, content), {
                encoding: 'utf8',
                flag: 'wx',
              });
              existing.add(name);
              imported.push(rawName);
            } catch (error) {
              if (error.code === 'EEXIST') skipped.push(rawName);
              else failed.push(rawName);
            }
          })
        );
      }
      if (imported.length) {
        commitLibrary(
          `import: ${imported.length === 1 ? fabricLibraryName(imported[0]) : `${imported.length} fabric patterns`}`
        );
      }
      res.json({ imported, skipped, failed });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Commit history for one prompt. No repo / never committed → { commits: [] }.
  app.get('/api/library/:name/history', async (req, res) => {
    const name = sanitizeLibraryName(req.params.name);
    if (!name) {
      return res.status(400).json({ error: 'Invalid name' });
    }
    try {
      const log = await gitLibrary(['log', '--follow', '--format=%H%x09%cI%x09%s', '--', `${name}.md`]);
      const commits = log
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [hash, date, ...message] = line.split('\t');
          return { hash, date, message: message.join('\t') };
        });
      res.json({ commits });
    } catch {
      res.json({ commits: [] });
    }
  });

  // The prompt as of a given commit
  app.get('/api/library/:name/history/:hash', async (req, res) => {
    const name = sanitizeLibraryName(req.params.name);
    if (!name) {
      return res.status(400).json({ error: 'Invalid name' });
    }
    if (!/^[0-9a-f]{7,40}$/.test(req.params.hash)) {
      return res.status(400).json({ error: 'Invalid hash' });
    }
    try {
      const raw = await gitLibrary(['show', `${req.params.hash}:${name}.md`]);
      const { meta, content } = parseLibraryFile(raw);
      res.json({ content, description: meta.description, tags: meta.tags });
    } catch {
      res.status(404).json({ error: 'Revision not found' });
    }
  });
};
