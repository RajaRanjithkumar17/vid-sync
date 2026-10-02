# Timeline Sync

Turns a set of images tagged with timecodes (e.g. `scene_[00:00:12].png`) plus one
audio track into a single synced MP4 — entirely in the browser, via ffmpeg.wasm.

## Setup

```bash
npm install
npm run dev
```

Open the printed local URL. No backend, no API keys.

## How to use

1. **Images** — drop in your images. The tool reads a `[HH:MM:SS]` or `[MM:SS]`
   tag out of each filename automatically. If a filename doesn't parse, that row
   is highlighted and starts at `00:00` — click the timecode field to fix it
   manually (accepts `MM:SS` or `HH:MM:SS`).
2. **Audio** — drop in the narration/track. Its duration becomes the video's
   total length, and the last image's on-screen duration is `audio length −
   last image's timecode`.
3. **Preview** — scrub or hit Play to confirm the sync before spending time on
   export. The timeline strip shows each image's segment sized to its duration.
4. **Export** — pick resolution/fps and hit Export MP4. The ffmpeg.wasm core
   (~30 MB) is served from your own `public/ffmpeg/` folder, so the first
   export just loads it from your dev server, not a CDN.

## How the export works

Each image becomes a segment lasting until the next image's timecode. That's
fed to ffmpeg's `concat` demuxer as a list like:

```
file 'img_0.png'
duration 2.40
file 'img_1.png'
duration 3.10
file 'img_1.png'
```

(the repeated last line is a known quirk — the concat demuxer ignores the
final `duration` value, so the last file is listed twice.) That's muxed
against your audio with:

```
ffmpeg -f concat -safe 0 -i concat.txt -i audio.mp3 \
  -vf scale=W:H:force_original_aspect_ratio=decrease,pad=W:H:(ow-iw)/2:(oh-ih)/2,format=yuv420p \
  -r FPS -c:v libx264 -preset veryfast -crf 20 -c:a aac -b:a 192k -shortest output.mp4
```

The scale+pad filter normalizes mixed image sizes/aspect ratios onto one
canvas instead of stretching or crashing on mismatched inputs.

## Troubleshooting

- **`Error: failed to import ffmpeg-core.js`** — this means the browser
  couldn't load the ffmpeg core JS/wasm. It used to be loaded from a CDN
  (unpkg), which corporate firewalls, antivirus, and ad-blockers commonly
  block — that's the #1 cause. The project now self-hosts the core instead:
  `npm install` runs `scripts/copy-ffmpeg-core.js`, which copies
  the ESM `ffmpeg-core.js`/`ffmpeg-core.wasm` from `node_modules/@ffmpeg/core`
  into `public/ffmpeg/`, and the app loads from `/ffmpeg/...` (same origin) first,
  only falling back to the CDN if that's missing. If you still hit this:
  - Run `npm install` again and check for a `[copy-ffmpeg-core] Copied …`
    line in the output.
  - Confirm `public/ffmpeg/ffmpeg-core.js` and `.wasm` actually exist.
  - Restart the dev server after the files appear (Vite needs to pick up the
    new `public/` contents).
  - If `public/ffmpeg` exists but it still fails, check the browser's
    Network tab for the `/ffmpeg/ffmpeg-core.wasm` request — a 404 there
    usually means the dev server was started before postinstall ran.

- **`The file does not exist at ".../node_modules/.vite/deps/worker.js..."`**
  — this is a Vite dep-optimizer quirk with `@ffmpeg/ffmpeg`'s internal
  Worker. `vite.config.js` already excludes `@ffmpeg/ffmpeg`/`@ffmpeg/util`
  from `optimizeDeps` to prevent it. If you still see it (e.g. after pulling
  an older copy of this project), stop the dev server and delete the Vite
  cache: `rm -rf node_modules/.vite` (Windows: delete the
  `node_modules\.vite` folder), then `npm run dev` again.

## Notes / things you'll likely want to change

- **Speed**: this uses ffmpeg.wasm's single-threaded core, which needs no
  special server headers but is slower than native ffmpeg. If exports feel
  slow, switch to the `-mt` (multi-thread) core — it needs
  `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp` response headers (see the
  commented-out block in `vite.config.js`), and you'd change `CORE_BASE` in
  `src/App.jsx` accordingly.
- **Large images**: ffmpeg.wasm keeps everything in an in-memory virtual FS,
  so a lot of very large images can use a lot of RAM. Downscaling source
  images before upload helps if you hit browser memory limits.
- **No crossfades/transitions** yet — segments hard-cut at each timecode. If
  you want crossfades between images, that's a filter_complex change on the
  ffmpeg command (happy to add it if useful).
- **Timezone-free timecodes**: the `[HH:MM:SS]` tag is just plain elapsed time
  into the track, not wall-clock time.
