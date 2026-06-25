'use strict';

const express = require('express');
const http    = require('http');
const WebSocket = require('ws');
const pty     = require('node-pty');
const simpleGit = require('simple-git');
const path    = require('path');
const fs      = require('fs/promises');

const PORT      = process.env.PORT || 3057;
const REPOS_DIR = process.env.REPOS_DIR || path.join(__dirname, 'repos');
const SHELL     = process.env.SHELL || '/bin/bash';

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server, path: '/terminal' });

app.use(express.json({ limit: '10mb' }));

// Serve index.html at root (all static assets live alongside server.js)
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.use(express.static(path.join(__dirname, 'public')));  // future static assets

// ── helpers ──────────────────────────────────────────────────────────────────

async function ensureDirs() {
  await fs.mkdir(REPOS_DIR, { recursive: true });
}
ensureDirs().catch(console.error);

function g(repoName) {
  return simpleGit(path.join(REPOS_DIR, repoName));
}

function repoPath(repoName) {
  return path.join(REPOS_DIR, repoName);
}

function injectToken(rawUrl, token) {
  if (!token || !rawUrl) return rawUrl;
  try {
    const u = new URL(rawUrl);
    u.username = 'oauth2';
    u.password = token;
    return u.toString();
  } catch {
    return rawUrl;
  }
}

// Sanitise repo name — prevent path traversal
function safeRepoName(name) {
  return path.basename(name).replace(/[^a-zA-Z0-9_.\-]/g, '_');
}

// ── REST API ─────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// List all repos on disk
app.get('/api/repos', async (_req, res) => {
  try {
    const entries = await fs.readdir(REPOS_DIR, { withFileTypes: true });
    const repos = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      try {
        const status = await simpleGit(path.join(REPOS_DIR, e.name)).status();
        repos.push({ name: e.name, branch: status.current, ahead: status.ahead, behind: status.behind });
      } catch { /* not a git repo */ }
    }
    res.json({ repos });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Clone a repository
app.post('/api/clone', async (req, res) => {
  const { url, name, token } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });

  const repoName = safeRepoName(name || path.basename(url, '.git'));
  const dest = repoPath(repoName);

  try { await fs.access(dest); return res.status(409).json({ error: `"${repoName}" already exists` }); } catch {}

  try {
    await simpleGit().clone(injectToken(url, token), dest, ['--progress']);
    res.json({ success: true, name: repoName });
  } catch (err) {
    try { await fs.rm(dest, { recursive: true, force: true }); } catch {}
    res.status(500).json({ error: err.message });
  }
});

// Delete a repo from disk
app.delete('/api/repos/:repo', async (req, res) => {
  try {
    await fs.rm(repoPath(safeRepoName(req.params.repo)), { recursive: true, force: true });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Session cleanup — called via sendBeacon when the user leaves the page
// Deletes all repos that were cloned in that browser session
app.post('/api/cleanup', async (req, res) => {
  const { repos } = req.body;
  if (!Array.isArray(repos) || !repos.length) return res.json({ success: true, deleted: 0 });
  let deleted = 0;
  for (const name of repos) {
    try {
      await fs.rm(repoPath(safeRepoName(name)), { recursive: true, force: true });
      deleted++;
      console.log(`[cleanup] removed ${name}`);
    } catch { /* already gone — that's fine */ }
  }
  res.json({ success: true, deleted });
});

// git status
app.get('/api/repos/:repo/status', async (req, res) => {
  try { res.json(await g(req.params.repo).status()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// git log
app.get('/api/repos/:repo/log', async (req, res) => {
  try {
    const log = await g(req.params.repo).log({ maxCount: parseInt(req.query.limit) || 60 });
    res.json(log);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// git diff (unstaged or staged, optionally for a single file)
app.get('/api/repos/:repo/diff', async (req, res) => {
  try {
    const args = req.query.staged === 'true' ? ['--cached'] : [];
    if (req.query.file) args.push('--', req.query.file);
    res.json({ diff: await g(req.params.repo).diff(args) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// git branch -a
app.get('/api/repos/:repo/branches', async (req, res) => {
  try { res.json(await g(req.params.repo).branch(['-a', '-vv'])); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// git checkout
app.post('/api/repos/:repo/checkout', async (req, res) => {
  try {
    const { branch, create } = req.body;
    const git = g(req.params.repo);
    create ? await git.checkoutLocalBranch(branch) : await git.checkout(branch);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// git add
app.post('/api/repos/:repo/add', async (req, res) => {
  try {
    const files = req.body.files;
    await g(req.params.repo).add(Array.isArray(files) && files.length ? files : ['.']);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// git reset HEAD (unstage)
app.post('/api/repos/:repo/reset', async (req, res) => {
  try {
    const files = req.body.files;
    const git = g(req.params.repo);
    if (Array.isArray(files) && files.length) {
      await git.raw(['reset', 'HEAD', '--', ...files]);
    } else {
      await git.reset(['HEAD']);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// git commit
app.post('/api/repos/:repo/commit', async (req, res) => {
  try {
    const { message, author_name, author_email } = req.body;
    if (!message) return res.status(400).json({ error: 'message is required' });
    const git = g(req.params.repo);
    if (author_name)  await git.addConfig('user.name', author_name);
    if (author_email) await git.addConfig('user.email', author_email);
    res.json(await git.commit(message));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// git push
app.post('/api/repos/:repo/push', async (req, res) => {
  try {
    const { remote = 'origin', branch, token, setUpstream } = req.body;
    const git = g(req.params.repo);
    if (token) {
      const remotes = await git.getRemotes(true);
      const r = remotes.find(r => r.name === remote);
      if (r?.refs?.push) await git.remote(['set-url', remote, injectToken(r.refs.push, token)]);
    }
    // Build push args safely — never append undefined to the git command
    const args = [];
    if (setUpstream) args.push('-u');
    args.push(remote);
    if (branch) args.push(branch);
    res.json({ success: true, result: await git.push(args) });

  } catch (err) { res.status(500).json({ error: err.message }); }
});

// git pull
app.post('/api/repos/:repo/pull', async (req, res) => {
  try {
    const { remote = 'origin', branch, token } = req.body;
    const git = g(req.params.repo);
    if (token) {
      const remotes = await git.getRemotes(true);
      const r = remotes.find(r => r.name === remote);
      if (r?.refs?.fetch) await git.remote(['set-url', remote, injectToken(r.refs.fetch, token)]);
    }
    res.json(await git.pull(remote, branch));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// git fetch --all
app.post('/api/repos/:repo/fetch', async (req, res) => {
  try {
    const { token } = req.body;
    const git = g(req.params.repo);
    if (token) {
      for (const r of await git.getRemotes(true)) {
        if (r?.refs?.fetch) await git.remote(['set-url', r.name, injectToken(r.refs.fetch, token)]);
      }
    }
    await git.fetch(['--all', '--prune']);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── File browser / editor ────────────────────────────────────────────────────

// Resolve and validate that a repo-relative path stays inside the repo
function guardPath(repoName, filePath) {
  const full = path.resolve(path.join(repoPath(repoName), filePath));
  const base = path.resolve(repoPath(repoName));
  if (full !== base && !full.startsWith(base + path.sep)) throw new Error('Access denied');
  return full;
}

// Recursively build a file tree, skipping .git
async function buildTree(dir, relBase, depth = 0) {
  if (depth > 8) return [];
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return []; }
  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
  const nodes = [];
  for (const e of entries) {
    if (e.name === '.git') continue;
    const relPath = relBase ? `${relBase}/${e.name}` : e.name;
    if (e.isDirectory()) {
      nodes.push({ type: 'dir', name: e.name, path: relPath,
        children: await buildTree(path.join(dir, e.name), relPath, depth + 1) });
    } else {
      let size = 0;
      try { size = (await fs.stat(path.join(dir, e.name))).size; } catch {}
      nodes.push({ type: 'file', name: e.name, path: relPath, size });
    }
  }
  return nodes;
}

// Get full file tree
app.get('/api/repos/:repo/tree', async (req, res) => {
  try {
    const repo = safeRepoName(req.params.repo);
    res.json({ tree: await buildTree(repoPath(repo), '') });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Read a single file (text files up to 1.5 MB)
app.get('/api/repos/:repo/file', async (req, res) => {
  if (!req.query.path) return res.status(400).json({ error: 'path is required' });
  try {
    const repo = safeRepoName(req.params.repo);
    const full = guardPath(repo, req.query.path);
    const stat = await fs.stat(full);
    if (stat.size > 1_500_000) return res.json({ tooLarge: true, size: stat.size });
    const buf = await fs.readFile(full);
    const binary = buf.indexOf(0) !== -1;
    res.json({ content: binary ? null : buf.toString('utf8'), binary, size: stat.size });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Save a text file
app.put('/api/repos/:repo/file', async (req, res) => {
  const { path: filePath, content } = req.body;
  if (!filePath) return res.status(400).json({ error: 'path is required' });
  if (content == null) return res.status(400).json({ error: 'content is required' });
  try {
    const repo = safeRepoName(req.params.repo);
    const full = guardPath(repo, filePath);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, 'utf8');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Upload files as base64-encoded JSON — no extra dependencies needed
app.post('/api/repos/:repo/upload', async (req, res) => {
  const { files, destDir = '' } = req.body;
  if (!Array.isArray(files) || !files.length) return res.status(400).json({ error: 'files array is required' });
  const repo = safeRepoName(req.params.repo);
  const results = [];
  for (const f of files) {
    const dest = destDir ? `${destDir}/${f.name}` : f.name;
    try {
      const full = guardPath(repo, dest);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, Buffer.from(f.data, 'base64'));
      results.push({ name: f.name, path: dest, success: true });
    } catch (err) {
      results.push({ name: f.name, error: err.message });
    }
  }
  res.json({ results });
});

// ── WebSocket PTY terminal ────────────────────────────────────────────────────

wss.on('connection', (ws, req) => {
  const params  = new URL(req.url, 'http://x').searchParams;
  const repo    = params.get('repo');
  const cwd     = repo ? repoPath(safeRepoName(repo)) : REPOS_DIR;
  const cols    = Math.max(10, parseInt(params.get('cols'))  || 80);
  const rows    = Math.max(4,  parseInt(params.get('rows'))  || 24);

  let ptyProc;
  try {
    ptyProc = pty.spawn(SHELL, [], {
      name: 'xterm-256color',
      cols, rows, cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        FORCE_COLOR: '3',
        GIT_TERMINAL_PROMPT: '0',   // never hang waiting for stdin credentials
        LANG: 'en_US.UTF-8',
      },
    });
  } catch (err) {
    ws.send(JSON.stringify({ type: 'error', message: String(err.message) }));
    ws.close();
    return;
  }

  ptyProc.onData(data => {
    if (ws.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify({ type: 'output', data }));
  });

  ptyProc.onExit(({ exitCode }) => {
    if (ws.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify({ type: 'exit', exitCode }));
  });

  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'input')  ptyProc.write(msg.data);
      if (msg.type === 'resize') ptyProc.resize(
        Math.max(10, msg.cols),
                                                Math.max(4,  msg.rows)
      );
    } catch { /* ignore parse errors */ }
  });

  ws.on('close', () => { try { ptyProc.kill(); } catch {} });
  ws.on('error', ()  => { try { ptyProc.kill(); } catch {} });
});

// ── start ─────────────────────────────────────────────────────────────────────

server.listen(PORT, '0.0.0.0', () => {
  console.log(`WebGit listening on port ${PORT}`);
  console.log(`Repos dir: ${REPOS_DIR}`);
  console.log(`Shell: ${SHELL}`);
});
