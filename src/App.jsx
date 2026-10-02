import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';

// Self-hosted copy (see scripts/copy-ffmpeg-core.js, run on `npm install`).
// Loading from the same origin avoids "failed to import ffmpeg-core.js"
// errors that a CDN (unpkg/jsdelivr) can trigger behind corporate
// firewalls, antivirus, or ad-blockers.
// Respect Vite's configured base path when deployed below `/`.
const LOCAL_CORE_BASE = `${import.meta.env.BASE_URL}ffmpeg`;
const CDN_CORE_BASE = 'https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm';

const describeError = (error) => {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error.message === 'string') return error.message;
  try {
    return JSON.stringify(error) || String(error);
  } catch {
    return String(error);
  }
};

/**
 * Parses a timecode out of a filename, returns seconds (or null).
 * Supports a few naming conventions (colon or dash, bracketed or underscored):
 *  - bracket + colon:   scene_[00:00:12].png   or   scene_[00:12].png
 *  - bracket + dash:    02_[00-03]_desc.jpg    or   02_[00-03-12]_desc.jpg
 *  - underscored:       1789193573095_02__00-03__desc.jpg          (MM-SS between __)
 *  - underscored hms:   clip_01__00-03-12__desc.jpg                (HH-MM-SS between __)
 */
function parseTimestampFromName(name) {
  const bracketColonHms = name.match(/\[(\d{1,2}):(\d{2}):(\d{2})\]/);
  if (bracketColonHms) {
    const [, h, m, s] = bracketColonHms;
    return Number(h) * 3600 + Number(m) * 60 + Number(s);
  }
  const bracketColonMs = name.match(/\[(\d{1,2}):(\d{2})\]/);
  if (bracketColonMs) {
    const [, m, s] = bracketColonMs;
    return Number(m) * 60 + Number(s);
  }
  // e.g. "[00-03-12]" -> HH-MM-SS (checked before the 2-part form so it wins)
  const bracketDashHms = name.match(/\[(\d{2})-(\d{2})-(\d{2})\]/);
  if (bracketDashHms) {
    const [, h, m, s] = bracketDashHms;
    return Number(h) * 3600 + Number(m) * 60 + Number(s);
  }
  // e.g. "[00-03]" -> MM-SS
  const bracketDashMs = name.match(/\[(\d{2})-(\d{2})\]/);
  if (bracketDashMs) {
    const [, m, s] = bracketDashMs;
    return Number(m) * 60 + Number(s);
  }
  // e.g. "__00-03-12__" -> HH-MM-SS (checked before the 2-part form so it wins)
  const underscoreHms = name.match(/_(\d{2})-(\d{2})-(\d{2})_/);
  if (underscoreHms) {
    const [, h, m, s] = underscoreHms;
    return Number(h) * 3600 + Number(m) * 60 + Number(s);
  }
  // e.g. "__00-03__" -> MM-SS (this project's actual export format — no hour part)
  const underscoreMs = name.match(/_(\d{2})-(\d{2})_/);
  if (underscoreMs) {
    const [, m, s] = underscoreMs;
    return Number(m) * 60 + Number(s);
  }
  return null;
}

function secondsToTimecode(totalSeconds) {
  const s = Math.max(0, totalSeconds || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = (s % 60).toFixed(2);
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0
    ? `${pad(h)}:${pad(m)}:${sec.padStart(5, '0')}`
    : `${pad(m)}:${sec.padStart(5, '0')}`;
}

/** Parses a user-typed "HH:MM:SS", "MM:SS", or bare seconds string back to seconds. */
function parseTimecodeInput(str) {
  const parts = str.trim().split(':').map((p) => Number(p));
  if (parts.some((p) => Number.isNaN(p))) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 1) return parts[0];
  return null;
}

let nextId = 1;

export default function App() {
  const [images, setImages] = useState([]); // {id, file, name, url, timestamp}
  const [audio, setAudio] = useState(null); // {file, url, duration, ext}
  const [tailSeconds, setTailSeconds] = useState(3);
  const [resolution, setResolution] = useState('1280x720');
  const [fps, setFps] = useState(30);

  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);

  const [ffmpegReady, setFfmpegReady] = useState(false);
  const [loadingFfmpeg, setLoadingFfmpeg] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [logLines, setLogLines] = useState([]);
  const [outputUrl, setOutputUrl] = useState(null);
  const [error, setError] = useState(null);

  const audioRef = useRef(null);
  const ffmpegRef = useRef(null);
  const noAudioTickRef = useRef(null);

  const sortedImages = useMemo(
    () => [...images].sort((a, b) => a.timestamp - b.timestamp || a.id - b.id),
    [images]
  );

  const totalDuration = useMemo(() => {
    if (audio?.duration) return audio.duration;
    if (sortedImages.length === 0) return 0;
    return sortedImages[sortedImages.length - 1].timestamp + tailSeconds;
  }, [audio, sortedImages, tailSeconds]);

  const segments = useMemo(() => {
    return sortedImages.map((img, i) => {
      const next = sortedImages[i + 1];
      const end = next ? next.timestamp : totalDuration;
      return { ...img, start: img.timestamp, end, duration: Math.max(0, end - img.timestamp) };
    });
  }, [sortedImages, totalDuration]);

  const activeIndex = useMemo(() => {
    let idx = -1;
    for (let i = 0; i < segments.length; i++) {
      if (segments[i].start <= currentTime) idx = i;
      else break;
    }
    return idx;
  }, [segments, currentTime]);

  // --- File handling -------------------------------------------------

  const handleImageFiles = useCallback((fileList) => {
    const files = Array.from(fileList);
    setImages((prev) => {
      const additions = files.map((file) => {
        const guess = parseTimestampFromName(file.name);
        return {
          id: nextId++,
          file,
          name: file.name,
          url: URL.createObjectURL(file),
          timestamp: guess ?? 0,
          parsedOk: guess !== null,
        };
      });
      return [...prev, ...additions];
    });
  }, []);

  const handleAudioFile = useCallback((file) => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    const el = new Audio(url);
    el.addEventListener('loadedmetadata', () => {
      setAudio({ file, url, duration: el.duration, ext: file.name.split('.').pop() || 'mp3' });
    });
  }, []);

  const updateTimestamp = (id, text) => {
    const secs = parseTimecodeInput(text);
    if (secs === null) return;
    setImages((prev) => prev.map((img) => (img.id === id ? { ...img, timestamp: secs } : img)));
  };

  const removeImage = (id) => {
    setImages((prev) => prev.filter((img) => img.id !== id));
  };

  // --- Preview playback ------------------------------------------------

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const onTime = () => setCurrentTime(el.currentTime);
    const onEnd = () => setPlaying(false);
    el.addEventListener('timeupdate', onTime);
    el.addEventListener('ended', onEnd);
    return () => {
      el.removeEventListener('timeupdate', onTime);
      el.removeEventListener('ended', onEnd);
    };
  }, [audio]);

  // Fallback ticker when there's no audio track yet, so preview still scrubs.
  useEffect(() => {
    if (audio || !playing) {
      clearInterval(noAudioTickRef.current);
      return;
    }
    const start = performance.now() - currentTime * 1000;
    noAudioTickRef.current = setInterval(() => {
      const t = (performance.now() - start) / 1000;
      if (t >= totalDuration) {
        setCurrentTime(totalDuration);
        setPlaying(false);
      } else {
        setCurrentTime(t);
      }
    }, 100);
    return () => clearInterval(noAudioTickRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, audio]);

  const togglePlay = () => {
    if (audio && audioRef.current) {
      if (playing) audioRef.current.pause();
      else audioRef.current.play();
    }
    setPlaying((p) => !p);
  };

  const seek = (t) => {
    setCurrentTime(t);
    if (audioRef.current) audioRef.current.currentTime = t;
  };

  // --- ffmpeg.wasm export ------------------------------------------------

  const loadFfmpeg = useCallback(async () => {
    if (ffmpegRef.current) return ffmpegRef.current;
    setLoadingFfmpeg(true);
    setError(null);
    const tryLoad = async (base) => {
      // A failed load can leave its worker partially initialized. Retry with
      // a clean worker so the CDN fallback is independent.
      const ffmpeg = new FFmpeg();
      ffmpeg.on('log', ({ message }) => setLogLines((p) => [...p.slice(-80), message]));
      const toCheckedBlobURL = async (url, type) => {
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} loading ${url}`);
        }
        return URL.createObjectURL(new Blob([await response.arrayBuffer()], { type }));
      };
      const [coreURL, wasmURL] = await Promise.all([
        toCheckedBlobURL(`${base}/ffmpeg-core.js`, 'text/javascript'),
        toCheckedBlobURL(`${base}/ffmpeg-core.wasm`, 'application/wasm'),
      ]);
      await ffmpeg.load({ coreURL, wasmURL });
      return ffmpeg;
    };

    try {
      let ffmpeg;
      try {
        ffmpeg = await tryLoad(LOCAL_CORE_BASE);
      } catch (localErr) {
        // Local copy missing (e.g. postinstall didn't run) — fall back to CDN.
        setLogLines((p) => [...p.slice(-80), `Local ffmpeg-core failed (${describeError(localErr)}), trying CDN…`]);
        ffmpeg = await tryLoad(CDN_CORE_BASE);
      }
      ffmpegRef.current = ffmpeg;
      setFfmpegReady(true);
      return ffmpeg;
    } catch (e) {
      setError(
        `Failed to load ffmpeg-core from both the local copy and the CDN (${describeError(e)}). ` +
          'Run "npm install" again so scripts/copy-ffmpeg-core.js can populate public/ffmpeg, ' +
          'and check that nothing (firewall/antivirus/ad-blocker) is blocking unpkg.com as a fallback.'
      );
      throw e;
    } finally {
      setLoadingFfmpeg(false);
    }
  }, []);

  const handleExport = async () => {
    if (segments.length === 0) {
      setError('Add at least one image first.');
      return;
    }
    if (!audio) {
      setError('Add an audio file — export needs one to mux against.');
      return;
    }
    setError(null);
    setOutputUrl(null);
    setProgress(0);
    setExporting(true);
    try {
      const ffmpeg = await loadFfmpeg();
      ffmpeg.on('progress', ({ progress: p }) => setProgress(Math.min(100, Math.round(p * 100))));

      // Write images under sanitized names to avoid quoting issues with
      // brackets/colons/spaces from the original [HH:MM:SS] filenames.
      const concatLines = [];
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const ext = (seg.name.split('.').pop() || 'png').toLowerCase();
        const fsName = `img_${i}.${ext}`;
        await ffmpeg.writeFile(fsName, await fetchFile(seg.file));
        concatLines.push(`file '${fsName}'`);
        concatLines.push(`duration ${seg.duration.toFixed(3)}`);
      }
      // ffmpeg's concat demuxer ignores the final "duration" line, so the
      // last image is repeated once more without one to make it stick.
      const lastExt = (segments[segments.length - 1].name.split('.').pop() || 'png').toLowerCase();
      concatLines.push(`file 'img_${segments.length - 1}.${lastExt}'`);
      await ffmpeg.writeFile('concat.txt', new TextEncoder().encode(concatLines.join('\n')));

      const audioExt = audio.ext || 'mp3';
      await ffmpeg.writeFile(`audio.${audioExt}`, await fetchFile(audio.file));

      const [w, h] = resolution.split('x').map(Number);
      await ffmpeg.exec([
        '-f', 'concat',
        '-safe', '0',
        '-i', 'concat.txt',
        '-i', `audio.${audioExt}`,
        '-vf', `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`,
        '-r', String(fps),
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '20',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-shortest',
        'output.mp4',
      ]);

      const data = await ffmpeg.readFile('output.mp4');
      const blob = new Blob([data.buffer], { type: 'video/mp4' });
      setOutputUrl(URL.createObjectURL(blob));
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setExporting(false);
    }
  };

  // --- render ------------------------------------------------------------

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-title">
          <span className="dot" />
          Timeline Sync
        </div>
        <div className="topbar-sub">images tagged with [HH:MM:SS] + one audio track → one MP4</div>
      </header>

      <main className="layout">
        <section className="panel">
          <h2>1. Images</h2>
          <p className="hint">
            Filenames should contain a timecode, e.g. <code>xyz_02__00-03__desc.jpg</code> (MM-SS)
            or <code>scene_[00:00:12].png</code>. Each image displays from its own timecode until
            the next image's timecode.
          </p>
          <label className="dropzone">
            <input
              type="file"
              accept="image/*"
              multiple
              onChange={(e) => handleImageFiles(e.target.files)}
              hidden
            />
            Drop or choose images
          </label>

          {sortedImages.length > 0 && (
            <table className="table">
              <thead>
                <tr>
                  <th></th>
                  <th>File</th>
                  <th>Starts at</th>
                  <th>Duration</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {segments.map((seg) => (
                  <tr key={seg.id} className={seg.parsedOk ? '' : 'row-warn'}>
                    <td>
                      <img src={seg.url} alt="" className="thumb" />
                    </td>
                    <td className="filename" title={seg.name}>
                      {seg.name}
                    </td>
                    <td>
                      <input
                        className="tc-input"
                        defaultValue={secondsToTimecode(seg.timestamp)}
                        onBlur={(e) => updateTimestamp(seg.id, e.target.value)}
                      />
                    </td>
                    <td className="mono">{seg.duration.toFixed(2)}s</td>
                    <td>
                      <button className="icon-btn" onClick={() => removeImage(seg.id)}>
                        ×
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="panel">
          <h2>2. Audio</h2>
          <label className="dropzone">
            <input
              type="file"
              accept="audio/*"
              onChange={(e) => handleAudioFile(e.target.files[0])}
              hidden
            />
            {audio ? audio.file.name : 'Drop or choose audio'}
          </label>
          {audio && (
            <audio ref={audioRef} src={audio.url} className="audio-el" controls={false} />
          )}
          {!audio && (
            <div className="field-row">
              <label>Tail duration for last image (no audio yet)</label>
              <input
                type="number"
                min="0"
                step="0.5"
                value={tailSeconds}
                onChange={(e) => setTailSeconds(Number(e.target.value))}
              />
            </div>
          )}
        </section>

        <section className="panel panel-preview">
          <h2>3. Preview</h2>
          <div className="stage">
            {activeIndex >= 0 ? (
              <img src={segments[activeIndex].url} alt="" className="stage-img" />
            ) : (
              <div className="stage-empty">No image at this time</div>
            )}
          </div>

          <div className="transport">
            <button className="play-btn" onClick={togglePlay} disabled={segments.length === 0}>
              {playing ? 'Pause' : 'Play'}
            </button>
            <span className="mono time-readout">
              {secondsToTimecode(currentTime)} / {secondsToTimecode(totalDuration)}
            </span>
          </div>

          <div
            className="timeline"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const ratio = (e.clientX - rect.left) / rect.width;
              seek(Math.max(0, Math.min(totalDuration, ratio * totalDuration)));
            }}
          >
            {segments.map((seg, i) => (
              <div
                key={seg.id}
                className={`seg ${i === activeIndex ? 'seg-active' : ''}`}
                style={{ width: `${(seg.duration / (totalDuration || 1)) * 100}%` }}
                title={`${seg.name} (${seg.duration.toFixed(2)}s)`}
              />
            ))}
            {totalDuration > 0 && (
              <div
                className="playhead"
                style={{ left: `${(currentTime / totalDuration) * 100}%` }}
              />
            )}
          </div>
        </section>

        <section className="panel">
          <h2>4. Export</h2>
          <div className="field-row">
            <label>Resolution</label>
            <select value={resolution} onChange={(e) => setResolution(e.target.value)}>
              <option value="1920x1080">1920×1080</option>
              <option value="1280x720">1280×720</option>
              <option value="1080x1920">1080×1920 (vertical)</option>
              <option value="720x1280">720×1280 (vertical)</option>
            </select>
          </div>
          <div className="field-row">
            <label>Frame rate</label>
            <select value={fps} onChange={(e) => setFps(Number(e.target.value))}>
              <option value={24}>24</option>
              <option value={30}>30</option>
              <option value={60}>60</option>
            </select>
          </div>

          <button className="export-btn" onClick={handleExport} disabled={exporting || loadingFfmpeg}>
            {loadingFfmpeg ? 'Loading ffmpeg…' : exporting ? `Exporting… ${progress}%` : 'Export MP4'}
          </button>

          {(exporting || loadingFfmpeg) && (
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${loadingFfmpeg ? 100 : progress}%` }} />
            </div>
          )}

          {error && <div className="error">{error}</div>}

          {outputUrl && (
            <div className="output">
              <video src={outputUrl} controls className="output-video" />
              <a href={outputUrl} download="synced-video.mp4" className="download-link">
                Download synced-video.mp4
              </a>
            </div>
          )}

          <details className="log">
            <summary>ffmpeg log ({logLines.length})</summary>
            <pre>{logLines.join('\n')}</pre>
          </details>
        </section>
      </main>
    </div>
  );
}
