import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const config = JSON.parse(await readFile(new URL('panel.config.json', root), 'utf8'));
const origin = process.argv.includes('--local') ? 'http://localhost:5173' : config.workerOrigin;
if (origin) {
  const parsed = new URL(origin);
  if (parsed.origin !== origin || (parsed.protocol !== 'https:' && origin !== 'http://localhost:5173')) {
    throw new Error('panel.config.json must contain a valid HTTPS Worker origin.');
  }
}

const output = new URL('panel-dist/', root);
await mkdir(output, { recursive: true });
for (const file of ['app.js', 'catalog.js', 'limits.js', 'workspace.js', 'style.css', 'agent.md', '.nojekyll']) {
  await copyFile(new URL('docs/' + file, root), new URL(file, output));
}
const browserPackage = new URL('node_modules/@simplewebauthn/browser/', root);
await copyFile(new URL('dist/bundle/index.umd.min.js', browserPackage), new URL('webauthn.js', output));
await copyFile(new URL('LICENSE.md', browserPackage), new URL('webauthn-LICENSE.md', output));
const html = await readFile(new URL('docs/index.html', root), 'utf8');
await writeFile(new URL('index.html', output), html.replace('__WORKER_ORIGIN__', origin || "'none'"));
await writeFile(new URL('config.js', output), 'export const workerOrigin = ' + JSON.stringify(origin) + ';\n');
