const express = require('express');
const cors = require('cors');
const path = require('path');
const { spawn } = require('child_process');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Helper to fetch JSON from URLs
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 14; Pixel Tablet) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept': 'application/json'
      },
      timeout: 8000
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchJson(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// Extract YouTube Video ID from any URL or ID
function extractVideoId(input) {
  if (!input) return null;
  const trimmed = input.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;
  try {
    const u = new URL(trimmed);
    if (u.hostname.includes('youtu.be')) {
      return u.pathname.slice(1).split('/')[0];
    }
    if (u.searchParams.has('v')) {
      return u.searchParams.get('v');
    }
    const shortsMatch = u.pathname.match(/\/(?:shorts|embed|v)\/([a-zA-Z0-9_-]{11})/);
    if (shortsMatch) return shortsMatch[1];
  } catch (_) {}
  const regexMatch = trimmed.match(/(?:v=|\/)([0-9A-Za-z_-]{11}).*/);
  return regexMatch ? regexMatch[1] : null;
}

const PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.tokhmi.xyz',
  'https://pipedapi.moomoo.me',
  'https://pipedapi-libre.kavin.rocks',
  'https://api.piped.private.coffee'
];

// Search YouTube tracks via public Piped APIs or yt-dlp
app.get('/api/youtube/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'Missing query parameter q' });

  // Try Piped instances first
  for (const instance of PIPED_INSTANCES) {
    try {
      const data = await fetchJson(`${instance}/search?q=${encodeURIComponent(q)}&filter=music_songs`);
      if (data && Array.isArray(data.items) && data.items.length > 0) {
        const results = data.items
          .filter(item => item.url && item.url.includes('v='))
          .slice(0, 12)
          .map(item => {
            const vid = extractVideoId('https://youtube.com' + item.url);
            return {
              videoId: vid,
              title: item.title || 'Unknown Track',
              artist: item.uploaderName || 'YouTube Artist',
              duration: item.duration || 0,
              thumbnail: item.thumbnail || `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`
            };
          });
        if (results.length > 0) {
          return res.json({ source: instance, items: results });
        }
      }
    } catch (_) {
      // Continue to next instance
    }
  }

  // Fallback general video search on Piped
  for (const instance of PIPED_INSTANCES) {
    try {
      const data = await fetchJson(`${instance}/search?q=${encodeURIComponent(q)}&filter=videos`);
      if (data && Array.isArray(data.items) && data.items.length > 0) {
        const results = data.items
          .filter(item => item.url && item.url.includes('v='))
          .slice(0, 12)
          .map(item => {
            const vid = extractVideoId('https://youtube.com' + item.url);
            return {
              videoId: vid,
              title: item.title || 'Unknown Track',
              artist: item.uploaderName || 'YouTube',
              duration: item.duration || 0,
              thumbnail: item.thumbnail || `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`
            };
          });
        if (results.length > 0) {
          return res.json({ source: instance, items: results });
        }
      }
    } catch (_) {}
  }

  // Fallback: try yt-dlp for search if Piped APIs are busy
  const proc = spawn('yt-dlp', ['ytsearch10:' + q, '--dump-json', '--flat-playlist', '--no-warnings']);
  let stdout = '';
  proc.stdout.on('data', d => stdout += d.toString());
  proc.on('close', code => {
    if (code === 0 && stdout.trim()) {
      try {
        const lines = stdout.trim().split('\n');
        const results = lines.map(line => {
          const item = JSON.parse(line);
          return {
            videoId: item.id,
            title: item.title || 'YouTube Track',
            artist: item.uploader || item.channel || 'YouTube',
            duration: item.duration || 0,
            thumbnail: `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`
          };
        }).filter(r => r.videoId);
        if (results.length > 0) {
          return res.json({ source: 'yt-dlp', items: results });
        }
      } catch (_) {}
    }
    res.status(502).json({ error: 'Could not reach YouTube search providers right now. Try pasting a direct YouTube URL or loading local audio files.' });
  });
  proc.on('error', () => {
    res.status(502).json({ error: 'Could not reach YouTube search providers right now. Try pasting a direct YouTube URL or loading local audio files.' });
  });
});

// Resolve audio stream info and proxy audio with CORS so Web Audio API 3-Band EQ works!
app.get('/api/youtube/info', async (req, res) => {
  const videoId = extractVideoId(req.query.url || req.query.v);
  if (!videoId) return res.status(400).json({ error: 'Invalid YouTube URL or Video ID' });

  for (const instance of PIPED_INSTANCES) {
    try {
      const data = await fetchJson(`${instance}/streams/${videoId}`);
      if (data && Array.isArray(data.audioStreams) && data.audioStreams.length > 0) {
        // Pick best m4a/mp4 or webm audio stream
        const sorted = data.audioStreams
          .filter(s => s.url)
          .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
        if (sorted.length > 0) {
          return res.json({
            videoId,
            title: data.title || `YouTube Track (${videoId})`,
            artist: data.uploader || 'YouTube',
            duration: data.duration || 0,
            thumbnail: data.thumbnailUrl || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
            streamUrl: sorted[0].url,
            mimeType: sorted[0].mimeType || 'audio/mp4'
          });
        }
      }
    } catch (_) {}
  }

  // Fallback: try yt-dlp binary first, then python -m yt_dlp
  const runYtDlp = (cmd, args, onFail) => {
    const proc = spawn(cmd, args);
    let stdout = '';
    proc.stdout.on('data', d => stdout += d.toString());
    proc.on('close', code => {
      if (code === 0 && stdout) {
        try {
          const info = JSON.parse(stdout);
          return res.json({
            videoId,
            title: info.title || `YouTube Track (${videoId})`,
            artist: info.uploader || 'YouTube',
            duration: info.duration || 0,
            thumbnail: info.thumbnail || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
            streamUrl: info.url,
            mimeType: info.ext === 'm4a' ? 'audio/mp4' : 'audio/webm'
          });
        } catch (_) {}
      }
      onFail();
    });
    proc.on('error', onFail);
  };

  const ytUrl = `https://www.youtube.com/watch?v=${videoId}`;
  runYtDlp('yt-dlp', ['-f', 'bestaudio', '--dump-json', '--no-warnings', ytUrl], () => {
    runYtDlp('python', ['-m', 'yt_dlp', '-f', 'bestaudio', '--dump-json', '--no-warnings', ytUrl], () => {
      res.status(502).json({
        error: 'Stream extraction unavailable for this video. Try another YouTube track or load local MP3/WAV files.'
      });
    });
  });
});

const fs = require('fs');
const os = require('os');

// Temporary disk cache for YouTube audio files so Android tablets can stream with HTTP Range requests & zero RAM crash
const AUDIO_CACHE_DIR = path.join(os.tmpdir(), 'mydj-audio-cache');
if (!fs.existsSync(AUDIO_CACHE_DIR)) {
  fs.mkdirSync(AUDIO_CACHE_DIR, { recursive: true });
}

// Track active downloads and progress: videoId -> { status: 'downloading'|'ready'|'error', progress: 0..100, filePath, title, error }
const downloadJobs = new Map();

// Start or check server-side download job for a YouTube videoId
app.get('/api/youtube/prepare', async (req, res) => {
  const videoId = extractVideoId(req.query.v || req.query.url);
  if (!videoId) return res.status(400).json({ error: 'Invalid videoId' });

  const existing = downloadJobs.get(videoId);
  if (existing && existing.status === 'ready' && fs.existsSync(existing.filePath)) {
    return res.json({ status: 'ready', progress: 100, streamUrl: `/api/youtube/file/${videoId}` });
  }
  if (existing && existing.status === 'downloading') {
    return res.json({ status: 'downloading', progress: existing.progress || 5 });
  }

  const filePath = path.join(AUDIO_CACHE_DIR, `${videoId}.m4a`);
  if (fs.existsSync(filePath) && fs.statSync(filePath).size > 50000) {
    downloadJobs.set(videoId, { status: 'ready', progress: 100, filePath });
    return res.json({ status: 'ready', progress: 100, streamUrl: `/api/youtube/file/${videoId}` });
  }

  const job = { status: 'downloading', progress: 2, filePath, error: null };
  downloadJobs.set(videoId, job);

  // First try downloading via Piped direct stream or yt-dlp
  let startedYtDlp = false;
  const startYtDlpDownload = () => {
    if (startedYtDlp) return;
    startedYtDlp = true;
    const proc = spawn('yt-dlp', [
      '-f', 'bestaudio[ext=m4a]/bestaudio[acodec^=mp4a]/bestaudio',
      '--no-playlist',
      '--newline',
      '-o', filePath,
      `https://www.youtube.com/watch?v=${videoId}`
    ]);

    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      const match = text.match(/(\d+(?:\.\d+)?)%/);
      if (match) {
        job.progress = Math.min(99, Math.max(job.progress, Math.round(parseFloat(match[1]))));
      }
    });

    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(filePath) && fs.statSync(filePath).size > 10000) {
        job.status = 'ready';
        job.progress = 100;
      } else {
        job.status = 'error';
        job.error = 'Could not buffer this YouTube video on server.';
      }
    });

    proc.on('error', () => {
      job.status = 'error';
      job.error = 'yt-dlp unavailable on server.';
    });
  };

  startYtDlpDownload();
  res.json({ status: 'downloading', progress: job.progress });
});

// Serve cached audio file with full HTTP 206 Partial Content / Range support so Android Chrome uses < 2MB RAM even on 2-hour sets!
app.get('/api/youtube/file/:videoId', (req, res) => {
  const videoId = extractVideoId(req.params.videoId);
  if (!videoId) return res.status(400).send('Invalid ID');
  const filePath = path.join(AUDIO_CACHE_DIR, `${videoId}.m4a`);
  if (!fs.existsSync(filePath)) return res.status(404).send('Audio file not ready');

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', 'audio/mp4');
  res.sendFile(filePath);
});

// Proxy external audio stream with full CORS headers so Web Audio API can apply Bass/Mid/Treble EQ
app.get('/api/youtube/proxy', (req, res) => {
  const targetUrl = req.query.url;
  const videoId = extractVideoId(req.query.v);

  // If videoId is provided (or URL fails), we can stream directly via yt-dlp to stdout with zero throttling!
  const streamViaYtDlp = (vid) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'audio/mp4');
    res.setHeader('Cache-Control', 'public, max-age=86400');

    const proc = spawn('yt-dlp', [
      '-f', 'bestaudio[ext=m4a]/bestaudio',
      '--no-part',
      '--no-playlist',
      '--no-warnings',
      '-o', '-',
      `https://www.youtube.com/watch?v=${vid}`
    ]);

    proc.stdout.pipe(res);
    req.on('close', () => {
      try { proc.kill('SIGKILL'); } catch (_) {}
    });
    proc.on('error', () => {
      if (!res.headersSent) res.status(502).send('yt-dlp stream error');
    });
  };

  if (videoId && !targetUrl) {
    return streamViaYtDlp(videoId);
  }

  if (!targetUrl) return res.status(400).send('Missing url or v');

  const client = targetUrl.startsWith('https') ? https : http;
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Linux; Android 14; Pixel Tablet) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
  };
  if (req.headers.range) {
    headers['Range'] = req.headers.range;
  }

  client.get(targetUrl, { headers }, (upstream) => {
    if ((upstream.statusCode === 403 || upstream.statusCode >= 500) && videoId) {
      return streamViaYtDlp(videoId);
    }
    res.status(upstream.statusCode || 200);
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (upstream.headers['content-type']) res.setHeader('Content-Type', upstream.headers['content-type']);
    if (upstream.headers['content-length']) res.setHeader('Content-Length', upstream.headers['content-length']);
    if (upstream.headers['content-range']) res.setHeader('Content-Range', upstream.headers['content-range']);
    res.setHeader('Accept-Ranges', 'bytes');
    upstream.pipe(res);
  }).on('error', (err) => {
    if (videoId) return streamViaYtDlp(videoId);
    res.status(502).send('Proxy error: ' + err.message);
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🎧 MY DJ PARTY MIXER running at:`);
  console.log(`   Local:   http://localhost:${PORT}`);
  const os = require('os');
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log(`   Tablet Wi-Fi URL: http://${net.address}:${PORT}`);
      }
    }
  }
});
