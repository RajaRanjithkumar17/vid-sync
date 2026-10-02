// Copies the ffmpeg-core build (JS + wasm) from node_modules into public/ffmpeg
// so the app loads it from the same origin at runtime instead of a CDN
// (unpkg/jsdelivr). Self-hosting avoids "failed to import ffmpeg-core.js"
// errors caused by corporate firewalls, antivirus, ad-blockers, or a flaky
// CDN edge — all of which show up as that exact error since the browser's
// dynamic import() of the CDN URL silently fails.
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
// @ffmpeg/ffmpeg creates a module worker, so its core must be the ESM build
// (the UMD build has no default export and fails with ERROR_IMPORT_FAILURE).
const src = join(root, 'node_modules', '@ffmpeg', 'core', 'dist', 'esm');
const dest = join(root, 'public', 'ffmpeg');

const files = ['ffmpeg-core.js', 'ffmpeg-core.wasm'];

if (!existsSync(src)) {
  console.warn(
    `[copy-ffmpeg-core] Could not find ${src} — is @ffmpeg/core installed? Skipping copy.`
  );
  process.exit(0);
}

mkdirSync(dest, { recursive: true });

for (const file of files) {
  const from = join(src, file);
  const to = join(dest, file);
  if (!existsSync(from)) {
    console.warn(`[copy-ffmpeg-core] Missing ${from}, skipping.`);
    continue;
  }
  copyFileSync(from, to);
  console.log(`[copy-ffmpeg-core] Copied ${file} -> public/ffmpeg/${file}`);
}
