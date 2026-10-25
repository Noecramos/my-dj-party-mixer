const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Temporary disk cache for YouTube audio files so Android tablets can stream with HTTP Range requests & zero RAM crash
const AUDIO_CACHE_DIR = path.join(os.tmpdir(), 'mydj-audio-cache');
if (!fs.existsSync(AUDIO_CACHE_DIR)) {
  fs.mkdirSync(AUDIO_CACHE_DIR, { recursive: true });
}

const IOS_UA = 'com.google.ios.youtube/20.03.02 (iPhone16,2; U; CPU iOS 18_2_1 like Mac OS X;)';
const WEB_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel Tablet) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// Helper to fetch JSON from URLs
function fetchJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, {
      headers: {
        'User-Agent': WEB_UA,
        'Accept': 'application/json',
        ...headers
      },
      timeout: 8000
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchJson(res.headers.location, headers).then(resolve).catch(reject);
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
  const trimmed = String(input).trim();
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

// Primary: Direct YouTube InnerTube iOS Player API (Bypasses LOGIN_REQUIRED & returns direct m4a audio stream)
async function resolveViaInnerTube(videoId) {
  const clients = [
    { name: 'IOS', version: '20.03.02', ua: IOS_UA, deviceMake: 'Apple', deviceModel: 'iPhone16,2', osName: 'iPhone', osVersion: '18.2.1.22C161' },
    { name: 'ANDROID', version: '19.44.38', ua: 'com.google.android.youtube/19.44.38 (Linux; U; Android 14) gzip', androidSdkVersion: 34 }
  ];

  for (const c of clients) {
    try {
      const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': c.ua
        },
        body: JSON.stringify({
          videoId,
          context: {
            client: {
              clientName: c.name,
              clientVersion: c.version,
              deviceMake: c.deviceMake,
              deviceModel: c.deviceModel,
              osName: c.osName,
              osVersion: c.osVersion,
              androidSdkVersion: c.androidSdkVersion,
              hl: 'en',
              gl: 'US'
            }
          },
          contentCheckOk: true,
          racyCheckOk: true
        }),
        signal: AbortSignal.timeout(7000)
      });
      if (!res.ok) continue;
      const data = await res.json();
      const formats = (data.streamingData && data.streamingData.adaptiveFormats) || [];
      const audioStreams = formats
        .filter(f => f.mimeType && f.mimeType.startsWith('audio/') && f.url)
        .sort((a, b) => {
          // Prefer audio/mp4 (m4a) for universal Android/iOS/Desktop support
          const aMp4 = a.mimeType.includes('mp4') ? 1 : 0;
          const bMp4 = b.mimeType.includes('mp4') ? 1 : 0;
          if (aMp4 !== bMp4) return bMp4 - aMp4;
          return (b.bitrate || 0) - (a.bitrate || 0);
        });

      if (audioStreams.length > 0) {
        const best = audioStreams[0];
        const details = data.videoDetails || {};
        return {
          videoId,
          title: details.title || `YouTube Track (${videoId})`,
          artist: details.author || 'YouTube',
          duration: parseInt(details.lengthSeconds || '0', 10),
          thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
          streamUrl: best.url,
          mimeType: best.mimeType.split(';')[0] || 'audio/mp4',
          contentLength: parseInt(best.contentLength || '0', 10),
          ua: c.ua
        };
      }
    } catch (_) {}
  }
  return null;
}

const PIPED_INSTANCES = [
  'https://api.piped.private.coffee',
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.tokhmi.xyz',
  'https://pipedapi.moomoo.me',
  'https://pipedapi-libre.kavin.rocks'
];

// Direct YouTube InnerTube Search (Fastest, zero Piped downtime!)
async function searchViaInnerTube(query) {
  try {
    const res = await fetch('https://www.youtube.com/youtubei/v1/search?prettyPrint=false', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': WEB_UA },
      body: JSON.stringify({
        query,
        context: { client: { clientName: 'WEB', clientVersion: '2.20250101.00.00', hl: 'en', gl: 'US' } }
      }),
      signal: AbortSignal.timeout(7000)
    });
    if (!res.ok) return null;
    const data = await res.json();
    const contents = data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];
    const items = [];
    for (const sec of contents) {
      const list = sec?.itemSectionRenderer?.contents || [];
      for (const entry of list) {
        const v = entry.videoRenderer;
        if (!v || !v.videoId) continue;
        const title = v.title?.runs?.map(r => r.text).join('') || 'YouTube Track';
        const artist = v.ownerText?.runs?.[0]?.text || 'YouTube';
        const durText = v.lengthText?.simpleText || '';
        let duration = 0;
        if (durText) {
          const parts = durText.split(':').map(Number);
          if (parts.length === 3) duration = parts[0] * 3600 + parts[1] * 60 + parts[2];
          else if (parts.length === 2) duration = parts[0] * 60 + parts[1];
        }
        items.push({
          videoId: v.videoId,
          title,
          artist,
          duration,
          thumbnail: `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`
        });
        if (items.length >= 14) break;
      }
      if (items.length >= 14) break;
    }
    return items.length > 0 ? items : null;
  } catch (_) {
    return null;
  }
}

// 1. Search YouTube tracks
app.get('/api/youtube/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'Missing query parameter q' });

  // Try direct YouTube InnerTube search first
  const innerResults = await searchViaInnerTube(q);
  if (innerResults && innerResults.length > 0) {
    return res.json({ source: 'youtube-direct', items: innerResults });
  }

  // Fallback to Piped instances
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
              thumbnail: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`
            };
          });
        if (results.length > 0) {
          return res.json({ source: instance, items: results });
        }
      }
    } catch (_) {}
  }

  res.status(502).json({ error: 'Could not reach YouTube search right now. Try again in a moment.' });
});

// 2. Resolve audio stream info
app.get('/api/youtube/info', async (req, res) => {
  const videoId = extractVideoId(req.query.url || req.query.v);
  if (!videoId) return res.status(400).json({ error: 'Invalid YouTube URL or Video ID' });

  const info = await resolveViaInnerTube(videoId);
  if (info) return res.json(info);

  for (const instance of PIPED_INSTANCES) {
    try {
      const data = await fetchJson(`${instance}/streams/${videoId}`);
      if (data && Array.isArray(data.audioStreams) && data.audioStreams.length > 0) {
        const sorted = data.audioStreams.filter(s => s.url).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
        if (sorted.length > 0) {
          return res.json({
            videoId,
            title: data.title || `YouTube Track (${videoId})`,
            artist: data.uploader || 'YouTube',
            duration: data.duration || 0,
            thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
            streamUrl: sorted[0].url,
            mimeType: sorted[0].mimeType || 'audio/mp4'
          });
        }
      }
    } catch (_) {}
  }

  return res.status(502).json({ error: 'Stream extraction unavailable for this video.' });
});

// 3. Server-side High-Speed Downloader with Real-Time 0% -> 100% Progress Tracking
const downloadJobs = new Map();

async function downloadStreamToFile(streamUrl, ua, filePath, job) {
  const resp = await fetch(streamUrl, {
    headers: { 'User-Agent': ua || IOS_UA }
  });
  if (!resp.ok || !resp.body) {
    throw new Error(`Upstream HTTP ${resp.status}`);
  }
  const totalBytes = parseInt(resp.headers.get('content-length') || '0', 10) || job.totalBytes || 0;
  const tmpPath = filePath + '.part';
  const fileStream = fs.createWriteStream(tmpPath);
  const reader = resp.body.getReader();
  let received = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    fileStream.write(Buffer.from(value));
    received += value.length;
    if (totalBytes > 0) {
      job.progress = Math.min(99, Math.max(5, Math.round((received / totalBytes) * 100)));
    } else {
      job.progress = Math.min(95, Math.round((received / (4 * 1024 * 1024)) * 100));
    }
  }

  await new Promise((resolve, reject) => {
    fileStream.end();
    fileStream.on('finish', resolve);
    fileStream.on('error', reject);
  });

  if (received < 10000) {
    throw new Error('Downloaded audio file was empty or incomplete');
  }
  fs.renameSync(tmpPath, filePath);
  job.status = 'ready';
  job.progress = 100;
}

app.get('/api/youtube/prepare', async (req, res) => {
  const videoId = extractVideoId(req.query.v || req.query.url);
  if (!videoId) return res.status(400).json({ error: 'Invalid videoId' });

  const filePath = path.join(AUDIO_CACHE_DIR, `${videoId}.m4a`);
  if (fs.existsSync(filePath) && fs.statSync(filePath).size > 25000) {
    downloadJobs.set(videoId, { status: 'ready', progress: 100, filePath });
    return res.json({ status: 'ready', progress: 100, streamUrl: `/api/youtube/file/${videoId}` });
  }

  const existing = downloadJobs.get(videoId);
  if (existing && existing.status === 'downloading') {
    return res.json({ status: 'downloading', progress: existing.progress || 8 });
  }

  const job = { status: 'downloading', progress: 5, filePath, error: null, totalBytes: 0 };
  downloadJobs.set(videoId, job);

  // Start async background download via InnerTube iOS stream
  (async () => {
    try {
      const info = await resolveViaInnerTube(videoId);
      if (info && info.streamUrl) {
        job.totalBytes = info.contentLength || 0;
        job.progress = 12;
        await downloadStreamToFile(info.streamUrl, info.ua, filePath, job);
        return;
      }
      throw new Error('Could not resolve direct audio stream for this video');
    } catch (err) {
      // Fallback to yt-dlp with iOS player client if available
      const proc = spawn('yt-dlp', [
        '--extractor-args', 'youtube:player_client=ios,web',
        '-f', 'bestaudio[ext=m4a]/bestaudio',
        '--no-playlist',
        '--newline',
        '-o', filePath,
        `https://www.youtube.com/watch?v=${videoId}`
      ]);
      let handled = false;
      proc.stdout.on('data', (chunk) => {
        const m = chunk.toString().match(/(\d+(?:\.\d+)?)%/);
        if (m) job.progress = Math.min(99, Math.max(job.progress, Math.round(parseFloat(m[1]))));
      });
      proc.on('close', (code) => {
        if (handled) return;
        handled = true;
        if (code === 0 && fs.existsSync(filePath) && fs.statSync(filePath).size > 25000) {
          job.status = 'ready';
          job.progress = 100;
        } else {
          job.status = 'error';
          job.error = err.message || 'Unable to extract audio for this track';
          downloadJobs.delete(videoId);
        }
      });
      proc.on('error', () => {
        if (handled) return;
        handled = true;
        job.status = 'error';
        job.error = err.message || 'Unable to extract audio for this track';
        downloadJobs.delete(videoId);
      });
    }
  })();

  res.json({ status: 'downloading', progress: job.progress });
});

// 4. Serve cached audio file with full HTTP 206 Partial Content / Range support
app.get('/api/youtube/file/:videoId', (req, res) => {
  const videoId = extractVideoId(req.params.videoId);
  if (!videoId) return res.status(400).send('Invalid ID');
  const filePath = path.join(AUDIO_CACHE_DIR, `${videoId}.m4a`);
  if (!fs.existsSync(filePath) || fs.statSync(filePath).size < 25000) {
    return res.status(404).send('Audio file not ready');
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', 'audio/mp4');
  res.sendFile(filePath);
});

// 5. Direct Proxy with iOS User-Agent & Range support
app.get('/api/youtube/proxy', async (req, res) => {
  try {
    let targetUrl = req.query.url;
    let ua = IOS_UA;
    const videoId = extractVideoId(req.query.v);

    if (!targetUrl && videoId) {
      const info = await resolveViaInnerTube(videoId);
      if (info && info.streamUrl) {
        targetUrl = info.streamUrl;
        ua = info.ua || IOS_UA;
      }
    }
    if (!targetUrl) return res.status(400).send('Missing stream URL');

    const headers = { 'User-Agent': ua };
    if (req.headers.range) headers['Range'] = req.headers.range;

    const client = targetUrl.startsWith('https') ? https : http;
    client.get(targetUrl, { headers }, (upstream) => {
      res.status(upstream.statusCode || 200);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', upstream.headers['content-type'] || 'audio/mp4');
      if (upstream.headers['content-length']) res.setHeader('Content-Length', upstream.headers['content-length']);
      if (upstream.headers['content-range']) res.setHeader('Content-Range', upstream.headers['content-range']);
      res.setHeader('Accept-Ranges', 'bytes');
      upstream.pipe(res);
    }).on('error', (e) => {
      if (!res.headersSent) res.status(502).send('Proxy error: ' + e.message);
    });
  } catch (e) {
    if (!res.headersSent) res.status(502).send('Proxy exception: ' + e.message);
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🎧 MY DJ PARTY MIXER running at:`);
  console.log(`   Local:   http://localhost:${PORT}`);
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log(`   Tablet Wi-Fi URL: http://${net.address}:${PORT}`);
      }
    }
  }
});
