import { execSync } from 'node:child_process';
import { defineConfig, type Plugin } from 'vite';

/** Output of a git command, or '' (the first git on the PATH may not run, so try the system one too). */
const git = (args: string) => {
  for (const bin of ['git', '/usr/bin/git'])
    try {
      return execSync(`${bin} ${args}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    } catch {
      /* next */
    }
  return '';
};
const commit = () => (git('rev-parse --short HEAD') || 'unknown') + (git('status --porcelain') ? '-dirty' : '');

/** The commit snapshots record: `__COMMIT__` at start-up, and live from the dev server at `/__commit`. */
const commitInfo = (): Plugin => ({
  name: 'topo-commit',
  config: () => ({ define: { __COMMIT__: JSON.stringify(commit()) } }),
  configureServer(server) {
    server.middlewares.use('/__commit', (_req, res) => {
      res.setHeader('Content-Type', 'text/plain');
      res.end(commit());
    });
  },
});

export default defineConfig({
  plugins: [commitInfo()],
  worker: { format: 'es' },
  build: { target: 'es2022' },
});
