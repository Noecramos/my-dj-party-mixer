/**
 * MY DJ — Standalone Tablet Party Mixer
 * Real-time Web Audio API 3-Band EQ (Bass, Mid, Treble) + Isolator Kills + Crossfader
 * Offline IndexedDB Party Vault + YouTube Cloud Streamer + Continuous Auto-Mix
 */

// 1. Force-update Service Worker & purge any stale browser caches so the latest DJ engine always runs!
if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k)));
      }
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const r of regs) {
        await r.update();
      }
    } catch (_) {}
  });
}

// 2. Sync all custom range sliders per modern-web-guidance `slider` pattern
function syncSliderValue(slider) {
  slider.style.setProperty('--attr-min', slider.min || 0);
  slider.style.setProperty('--attr-max', slider.max || 100);
  slider.style.setProperty('--control-value', slider.value);
}

document.querySelectorAll('input[type="range"].styled-slider').forEach((slider) => {
  syncSliderValue(slider);
  slider.addEventListener('input', () => syncSliderValue(slider));
});

// 3. IndexedDB Offline Tablet Party Vault (stores songs directly inside tablet storage)
const DB_NAME = 'MyDjPartyVaultDB';
const STORE_NAME = 'tracks';

function openVaultDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveTrackToVault(trackObj) {
  const db = await openVaultDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(trackObj);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getAllVaultTracks() {
  const db = await openVaultDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function deleteVaultTrack(id) {
  const db = await openVaultDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// 4. Web Audio Context & Master Bus
let audioCtx = null;
let masterAnalyser = null;

function ensureAudioContext() {
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AudioContextClass();
    masterAnalyser = audioCtx.createAnalyser();
    masterAnalyser.fftSize = 128;
    masterAnalyser.smoothingTimeConstant = 0.78;
    masterAnalyser.connect(audioCtx.destination);
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
}

// Format seconds to MM:SS
function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '00:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// 5. DJ Deck Class with 3-Band EQ (Bass, Mid, Treble), Kill Switches, Jog Wheel & Loop
class DJDeck {
  constructor(id) {
    this.id = id; // 'a' or 'b'
    this.audio = new Audio();
    this.audio.crossOrigin = 'anonymous';
    this.audio.preload = 'auto';
    this.audio.preservesPitch = false;

    this.connected = false;
    this.isPlaying = false;
    this.cuePoint = 0;
    this.loopActive = false;
    this.loopStart = 0;
    this.loopLength = 2.0; // 4 beats at 120 BPM
    this.rotationAngle = 0;

    // EQ Kill States
    this.kills = { low: false, mid: false, high: false };
    this.savedEq = { low: 0, mid: 0, high: 0 };

    // Waveform peaks array for visual canvas
    this.waveformPeaks = this.generateDefaultWaveform();

    this.bindDOM();
    this.drawStaticWaveform();
  }

  connectAudioGraph() {
    ensureAudioContext();
    if (this.connected || !audioCtx) return;
    // Set this.connected = true BEFORE any calls that might re-enter connectAudioGraph()!
    this.connected = true;

    try {
      if (!this.sourceNode) {
        this.sourceNode = audioCtx.createMediaElementSource(this.audio);
      }
    } catch (err) {
      console.warn(`Deck ${this.id} createMediaElementSource:`, err);
      return;
    }

    // BASS (Low-Shelf Filter @ 250 Hz)
    this.lowFilter = audioCtx.createBiquadFilter();
    this.lowFilter.type = 'lowshelf';
    this.lowFilter.frequency.value = 250;
    this.lowFilter.gain.value = 0;

    // MIDS (Peaking Filter @ 1100 Hz)
    this.midFilter = audioCtx.createBiquadFilter();
    this.midFilter.type = 'peaking';
    this.midFilter.frequency.value = 1100;
    this.midFilter.Q.value = 0.9;
    this.midFilter.gain.value = 0;

    // TREBLE (High-Shelf Filter @ 3600 Hz)
    this.highFilter = audioCtx.createBiquadFilter();
    this.highFilter.type = 'highshelf';
    this.highFilter.frequency.value = 3600;
    this.highFilter.gain.value = 0;

    // Channel Volume Gain + Crossfader Gain
    this.channelGain = audioCtx.createGain();
    this.channelGain.gain.value = 1.0;

    this.xfadeGain = audioCtx.createGain();
    const xVal = (typeof crossfader !== 'undefined' && crossfader) ? parseFloat(crossfader.value || '0') : 0;
    const norm = (xVal + 1) / 2;
    this.xfadeGain.gain.value = this.id === 'a' ? Math.cos(norm * 0.5 * Math.PI) : Math.sin(norm * 0.5 * Math.PI);

    // Deck VU Meter Analyser
    this.analyser = audioCtx.createAnalyser();
    this.analyser.fftSize = 64;

    // Chain: Source -> Bass -> Mid -> Treble -> Channel Gain -> Xfade Gain -> Deck Analyser -> Master Analyser
    this.sourceNode.connect(this.lowFilter);
    this.lowFilter.connect(this.midFilter);
    this.midFilter.connect(this.highFilter);
    this.highFilter.connect(this.channelGain);
    this.channelGain.connect(this.xfadeGain);
    this.xfadeGain.connect(this.analyser);
    this.analyser.connect(masterAnalyser);
  }

  generateDefaultWaveform(seedStr = '') {
    const arr = [];
    let seed = 1;
    for (let c = 0; c < seedStr.length; c++) {
      seed = (seed * 31 + seedStr.charCodeAt(c)) % 9973;
    }
    for (let i = 0; i < 140; i++) {
      const v = 0.22 + 0.68 * Math.abs(Math.sin(i * 0.21 + seed) * Math.cos(i * 0.08 + seed * 0.5));
      arr.push(v);
    }
    return arr;
  }

  async extractWaveformFromBlob(blob, title = '') {
    // Always draw deterministic club waveform immediately so the waveform canvas is NEVER blank,
    // and never call decodeAudioData on files > 5MB or when AudioContext hasn't been started by a user gesture!
    this.waveformPeaks = this.generateDefaultWaveform(title || String(blob ? blob.size : ''));
    this.drawStaticWaveform();
    if (!blob || blob.size > 5 * 1024 * 1024 || !audioCtx || audioCtx.state !== 'running') {
      return;
    }
    try {
      const arrayBuf = await blob.arrayBuffer();
      const audioBuf = await audioCtx.decodeAudioData(arrayBuf);
      const raw = audioBuf.getChannelData(0);
      const samples = 140;
      const blockSize = Math.floor(raw.length / samples);
      const peaks = [];
      for (let i = 0; i < samples; i++) {
        let sum = 0;
        const start = i * blockSize;
        for (let j = 0; j < blockSize; j += 32) {
          const v = Math.abs(raw[start + j] || 0);
          if (v > sum) sum = v;
        }
        peaks.push(Math.max(0.08, Math.min(1, sum)));
      }
      this.waveformPeaks = peaks;
      this.drawStaticWaveform();
    } catch (_) {
      this.waveformPeaks = this.generateDefaultWaveform(title);
      this.drawStaticWaveform();
    }
  }

  drawStaticWaveform() {
    const canvas = this.waveCanvas;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const barW = w / this.waveformPeaks.length;
    const progress = this.audio.duration ? (this.audio.currentTime / this.audio.duration) : 0;

    for (let i = 0; i < this.waveformPeaks.length; i++) {
      const pct = i / this.waveformPeaks.length;
      const amp = this.waveformPeaks[i] * (h * 0.85);
      const x = i * barW;
      const y = (h - amp) / 2;

      if (pct <= progress) {
        ctx.fillStyle = this.id === 'a' ? '#00f0ff' : '#ff2a85';
      } else {
        ctx.fillStyle = this.id === 'a' ? 'rgba(0, 240, 255, 0.28)' : 'rgba(255, 42, 133, 0.28)';
      }
      ctx.fillRect(x, y, Math.max(1.5, barW - 1), amp);
    }
  }

  bindDOM() {
    const s = this.id;
    this.titleEl = document.getElementById(`title-${s}`);
    this.subEl = document.getElementById(`sub-${s}`);
    this.topTitleEl = document.getElementById(`top-title-${s}`);
    this.topTimeEl = document.getElementById(`top-time-${s}`);
    this.fileInput = document.getElementById(`file-${s}`);
    this.waveWrap = document.getElementById(`wave-wrap-${s}`);
    this.waveCanvas = document.getElementById(`wave-${s}`);
    this.playheadEl = document.getElementById(`playhead-${s}`);
    this.dlOverlayEl = document.getElementById(`dl-overlay-${s}`);
    this.dlBarEl = document.getElementById(`dl-bar-${s}`);
    this.dlTextEl = document.getElementById(`dl-text-${s}`);
    this.jogEl = document.getElementById(`jog-${s}`);
    this.jogRotorEl = document.getElementById(`jog-rotor-${s}`);
    this.jogResetBtn = document.getElementById(`jog-reset-${s}`);
    this.bpmEl = document.getElementById(`bpm-${s}`);
    this.pitchSlider = document.getElementById(`pitch-${s}`);
    this.pitchValEl = document.getElementById(`pitch-val-${s}`);
    this.pitchResetBtn = document.getElementById(`pitch-reset-${s}`);

    this.playBtn = document.getElementById(`play-${s}`);
    this.cueBtn = document.getElementById(`cue-${s}`);
    this.loopBtn = document.getElementById(`loop-${s}`);
    this.bassDropBtn = document.getElementById(`bassdrop-${s}`);

    // EQ Controls
    this.eqHigh = document.getElementById(`eq-high-${s}`);
    this.eqMid = document.getElementById(`eq-mid-${s}`);
    this.eqLow = document.getElementById(`eq-low-${s}`);
    this.volSlider = document.getElementById(`vol-${s}`);

    this.valHigh = document.getElementById(`val-high-${s}`);
    this.valMid = document.getElementById(`val-mid-${s}`);
    this.valLow = document.getElementById(`val-low-${s}`);
    this.valVol = document.getElementById(`val-vol-${s}`);

    this.killHighBtn = document.getElementById(`kill-high-${s}`);
    this.killMidBtn = document.getElementById(`kill-mid-${s}`);
    this.killLowBtn = document.getElementById(`kill-low-${s}`);

    this.zeroHighBtn = document.getElementById(`zero-high-${s}`);
    this.zeroMidBtn = document.getElementById(`zero-mid-${s}`);
    this.zeroLowBtn = document.getElementById(`zero-low-${s}`);
    this.vol50Btn = document.getElementById(`vol-50-${s}`);
    this.vol100Btn = document.getElementById(`vol-100-${s}`);

    this.eqResetBtn = document.getElementById(`eq-reset-${s}`);
    this.vuCanvas = document.getElementById(`vu-${s}`);

    // File Upload
    this.fileInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      await this.loadBlob(file, file.name.replace(/\.[^/.]+$/, ''), 'Tablet Storage File');
    });

    // Waveform Scrubbing
    let scrubbing = false;
    const scrubTo = (clientX) => {
      if (!this.audio.duration) return;
      const rect = this.waveWrap.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      this.audio.currentTime = ratio * this.audio.duration;
      this.updateTimeUI();
    };
    this.waveWrap.addEventListener('pointerdown', (e) => {
      scrubbing = true;
      this.waveWrap.setPointerCapture(e.pointerId);
      scrubTo(e.clientX);
    });
    this.waveWrap.addEventListener('pointermove', (e) => {
      if (scrubbing) scrubTo(e.clientX);
    });
    this.waveWrap.addEventListener('lostpointercapture', () => {
      scrubbing = false;
    });

    // Jog Wheel Scratch / Nudge (using Pointer Capture on outer platter, ignoring center reset button)
    let lastX = 0;
    this.jogEl.addEventListener('pointerdown', (e) => {
      if ((e.button !== 0 && e.pointerType === 'mouse') || e.target.closest('.jog-center')) return;
      lastX = e.clientX;
      this.jogEl.setPointerCapture(e.pointerId);
      this.jogEl.classList.add('dragging');
    });
    this.jogEl.addEventListener('pointermove', (e) => {
      if (!this.jogEl.hasPointerCapture(e.pointerId)) return;
      const dx = e.clientX - lastX;
      lastX = e.clientX;
      this.rotationAngle += dx * 1.4;
      if (this.jogRotorEl) {
        this.jogRotorEl.style.transform = `rotate(${this.rotationAngle}deg)`;
      }
      if (this.audio.duration) {
        this.audio.currentTime = Math.max(0, Math.min(this.audio.duration, this.audio.currentTime + dx * 0.035));
        this.updateTimeUI();
      }
    });
    this.jogEl.addEventListener('lostpointercapture', () => {
      this.jogEl.classList.remove('dragging');
    });

    // Center Platter Button: Reset Platter Marker to Top Center (0°) + Reset Tempo to 100.0%
    const resetPlatterAndTempo = () => {
      this.rotationAngle = 0;
      if (this.jogRotorEl) {
        this.jogRotorEl.style.transform = 'rotate(0deg)';
      }
      this.pitchSlider.value = 1;
      syncSliderValue(this.pitchSlider);
      this.pitchSlider.dispatchEvent(new Event('input'));
      if (this.jogResetBtn) {
        this.jogResetBtn.classList.add('reset-flash');
        setTimeout(() => this.jogResetBtn.classList.remove('reset-flash'), 240);
      }
    };

    if (this.jogResetBtn) {
      this.jogResetBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        resetPlatterAndTempo();
      });
    }

    // Pitch / Tempo Slider
    this.pitchSlider.addEventListener('input', () => {
      const rate = parseFloat(this.pitchSlider.value);
      this.audio.playbackRate = rate;
      const diffPct = ((rate - 1) * 100).toFixed(1);
      this.pitchValEl.textContent = `${diffPct > 0 ? '+' : ''}${diffPct}%`;
      this.bpmEl.textContent = `${(rate * 100).toFixed(1)}%`;
    });

    this.pitchResetBtn.addEventListener('click', resetPlatterAndTempo);

    // Play / Pause
    this.playBtn.addEventListener('click', () => this.togglePlay());

    // Cue Button
    this.cueBtn.addEventListener('click', () => {
      ensureAudioContext();
      if (this.isPlaying) {
        this.audio.pause();
        this.audio.currentTime = this.cuePoint;
        this.isPlaying = false;
        this.playBtn.classList.remove('active');
        this.playBtn.textContent = '▶ PLAY';
        this.updateTimeUI();
      } else {
        this.cuePoint = this.audio.currentTime;
        this.cueBtn.textContent = `⏺ CUE (${fmtTime(this.cuePoint)})`;
      }
    });

    // 4-Beat Loop Toggle
    this.loopBtn.addEventListener('click', () => {
      this.loopActive = !this.loopActive;
      this.loopStart = this.audio.currentTime;
      this.loopBtn.classList.toggle('active', this.loopActive);
    });

    // Bass Drop FX (Momentary Bass Cut -> +9dB Sub Slam)
    this.bassDropBtn.addEventListener('click', () => {
      this.connectAudioGraph();
      const now = audioCtx.currentTime;
      this.lowFilter.gain.cancelScheduledValues(now);
      this.lowFilter.gain.setValueAtTime(-24, now);
      this.lowFilter.gain.exponentialRampToValueAtTime(10, now + 0.65);
      this.lowFilter.gain.linearRampToValueAtTime(parseFloat(this.eqLow.value), now + 1.8);
    });

    // 3-Band EQ Sliders
    this.eqHigh.addEventListener('input', () => {
      this.connectAudioGraph();
      const db = parseFloat(this.eqHigh.value);
      this.savedEq.high = db;
      if (!this.kills.high) this.highFilter.gain.value = db;
      this.valHigh.textContent = `${db > 0 ? '+' : ''}${db} dB`;
    });

    this.eqMid.addEventListener('input', () => {
      this.connectAudioGraph();
      const db = parseFloat(this.eqMid.value);
      this.savedEq.mid = db;
      if (!this.kills.mid) this.midFilter.gain.value = db;
      this.valMid.textContent = `${db > 0 ? '+' : ''}${db} dB`;
    });

    this.eqLow.addEventListener('input', () => {
      this.connectAudioGraph();
      const db = parseFloat(this.eqLow.value);
      this.savedEq.low = db;
      if (!this.kills.low) this.lowFilter.gain.value = db;
      this.valLow.textContent = `${db > 0 ? '+' : ''}${db} dB`;
    });

    this.volSlider.addEventListener('input', () => {
      this.connectAudioGraph();
      const v = parseFloat(this.volSlider.value);
      this.channelGain.gain.value = v;
      this.valVol.textContent = `${Math.round(v * 100)}%`;
    });

    // Kill Switches (-40 dB full band isolation)
    this.killHighBtn.addEventListener('click', () => this.toggleKill('high', this.highFilter, this.killHighBtn));
    this.killMidBtn.addEventListener('click', () => this.toggleKill('mid', this.midFilter, this.killMidBtn));
    this.killLowBtn.addEventListener('click', () => this.toggleKill('low', this.lowFilter, this.killLowBtn));

    // Individual 0 dB Reset Buttons + Double-Tap on Sliders
    const resetSingleBand = (band, sliderEl, killBtnEl) => {
      this.connectAudioGraph();
      this.kills[band] = false;
      this.savedEq[band] = 0;
      if (killBtnEl) killBtnEl.classList.remove('killed');
      sliderEl.value = 0;
      syncSliderValue(sliderEl);
      sliderEl.dispatchEvent(new Event('input'));
    };

    if (this.zeroHighBtn) this.zeroHighBtn.addEventListener('click', () => resetSingleBand('high', this.eqHigh, this.killHighBtn));
    if (this.zeroMidBtn) this.zeroMidBtn.addEventListener('click', () => resetSingleBand('mid', this.eqMid, this.killMidBtn));
    if (this.zeroLowBtn) this.zeroLowBtn.addEventListener('click', () => resetSingleBand('low', this.eqLow, this.killLowBtn));

    this.eqHigh.addEventListener('dblclick', () => resetSingleBand('high', this.eqHigh, this.killHighBtn));
    this.eqMid.addEventListener('dblclick', () => resetSingleBand('mid', this.eqMid, this.killMidBtn));
    this.eqLow.addEventListener('dblclick', () => resetSingleBand('low', this.eqLow, this.killLowBtn));

    // Volume 50% and 100% Quick Reset Buttons
    const setDeckVolume = (targetVal) => {
      this.connectAudioGraph();
      this.volSlider.value = targetVal;
      syncSliderValue(this.volSlider);
      this.volSlider.dispatchEvent(new Event('input'));
    };

    if (this.vol50Btn) this.vol50Btn.addEventListener('click', () => setDeckVolume(0.5));
    if (this.vol100Btn) this.vol100Btn.addEventListener('click', () => setDeckVolume(1.0));
    this.volSlider.addEventListener('dblclick', () => setDeckVolume(0.5));

    // Flat EQ Reset (All Bands 0 dB)
    this.eqResetBtn.addEventListener('click', () => {
      resetSingleBand('high', this.eqHigh, this.killHighBtn);
      resetSingleBand('mid', this.eqMid, this.killMidBtn);
      resetSingleBand('low', this.eqLow, this.killLowBtn);
    });

    // Audio Events
    this.audio.addEventListener('loadedmetadata', () => {
      this.updateTimeUI();
    });

    this.audio.addEventListener('canplay', () => {
      this.updateTimeUI();
    });

    this.audio.addEventListener('play', () => {
      this.isPlaying = true;
      this.playBtn.classList.add('active');
      this.playBtn.textContent = '⏸ PAUSE';
    });

    this.audio.addEventListener('pause', () => {
      this.isPlaying = false;
      this.playBtn.classList.remove('active');
      this.playBtn.textContent = '▶ PLAY';
    });

    this.audio.addEventListener('error', (e) => {
      console.error(`Deck ${this.id.toUpperCase()} audio element error:`, this.audio.error);
      const code = this.audio.error ? this.audio.error.code : 'unknown';
      this.subEl.textContent = `⚠️ Audio decode error (code ${code}). Tap to retry.`;
    });

    this.audio.addEventListener('ended', () => {
      this.isPlaying = false;
      this.playBtn.classList.remove('active');
      this.playBtn.textContent = '▶ PLAY';
      handleTrackEndedOnDeck(this);
    });
  }

  toggleKill(band, filterNode, btnEl) {
    this.connectAudioGraph();
    this.kills[band] = !this.kills[band];
    btnEl.classList.toggle('killed', this.kills[band]);
    filterNode.gain.value = this.kills[band] ? -42 : this.savedEq[band];
  }

  setDownloadProgress(pct, label) {
    if (!this.dlOverlayEl) return;
    if (pct === null) {
      this.isDownloading = false;
      this.dlOverlayEl.hidden = true;
      return;
    }
    this.isDownloading = true;
    this.dlOverlayEl.hidden = false;
    const clamped = Math.max(0, Math.min(100, Math.round(pct)));
    this.dlBarEl.style.inlineSize = `${clamped}%`;
    this.dlTextEl.textContent = label || `DOWNLOADING TO RAM: ${clamped}%`;
  }

  waitForAudioReady(timeoutMs = 8000) {
    if (this.audio.readyState >= 2) return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        this.audio.removeEventListener('canplay', finish);
        this.audio.removeEventListener('loadeddata', finish);
        this.audio.removeEventListener('error', finish);
        resolve();
      };
      this.audio.addEventListener('canplay', finish, { once: true });
      this.audio.addEventListener('loadeddata', finish, { once: true });
      this.audio.addEventListener('error', finish, { once: true });
      setTimeout(finish, timeoutMs);
    });
  }

  unlockAudioOnUserGesture() {
    ensureAudioContext();
    this.connectAudioGraph();
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
    // Unlock this specific HTMLAudioElement in Android Chrome's AutoplayPolicy during the user's synchronous tap gesture
    // so programmatic play() after a 15-second cloud download succeeds automatically!
    if (this.audio.paused && this.audio.src) {
      this.audio.muted = true;
      const unlockSrc = this.audio.src;
      const p = this.audio.play();
      if (p !== undefined) {
        p.then(() => {
          if (this.audio.src === unlockSrc && this.isDownloading) {
            this.audio.pause();
          }
          this.audio.muted = false;
        }).catch(() => {
          this.audio.muted = false;
        });
      } else {
        this.audio.pause();
        this.audio.muted = false;
      }
    }
  }

  async loadBlob(blob, title, subtitle) {
    this.setDownloadProgress(null);
    this.audio.muted = false;
    if (!this.audio.paused) this.audio.pause();
    if (this.currentObjectUrl) URL.revokeObjectURL(this.currentObjectUrl);
    // Ensure valid audio MIME type on Android Chrome
    const safeBlob = (!blob.type || blob.type === 'application/octet-stream' || blob.type.includes('text'))
      ? new Blob([blob], { type: 'audio/mp4' })
      : blob;
    this.currentObjectUrl = URL.createObjectURL(safeBlob);
    this.audio.src = this.currentObjectUrl;
    this.audio.load();
    this.titleEl.textContent = title;
    this.subEl.textContent = subtitle || '100% Buffered (Zero Stutter)';
    this.topTitleEl.textContent = `DECK ${this.id.toUpperCase()}: ${title}`;
    this.cuePoint = 0;
    this.cueBtn.textContent = '⏺ CUE';
    this.waveformPeaks = this.generateDefaultWaveform(title);
    this.drawStaticWaveform();
    this.updateTimeUI();
    this.extractWaveformFromBlob(safeBlob, title);
  }

  async loadStreamUrl(url, title, subtitle) {
    this.setDownloadProgress(null);
    this.audio.muted = false;
    if (!this.audio.paused) this.audio.pause();
    if (this.currentObjectUrl) {
      URL.revokeObjectURL(this.currentObjectUrl);
      this.currentObjectUrl = null;
    }
    this.audio.src = url;
    this.audio.load();
    this.titleEl.textContent = title;
    this.subEl.textContent = subtitle || '100% Server-Buffered • Zero Cutting & Zero RAM Crash';
    this.topTitleEl.textContent = `DECK ${this.id.toUpperCase()}: ${title}`;
    this.cuePoint = 0;
    this.cueBtn.textContent = '⏺ CUE';
    this.waveformPeaks = this.generateDefaultWaveform(title);
    this.drawStaticWaveform();
    this.updateTimeUI();
  }

  async togglePlay() {
    ensureAudioContext();
    this.connectAudioGraph();
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
    if (this.isDownloading) {
      this.wantAutoPlayAfterDownload = true;
      this.subEl.textContent = '⏳ Finishing 100% buffer — will auto-play immediately!';
      return;
    }
    if (!this.audio.src) {
      generateDemoBeats();
    }
    if (this.audio.paused) {
      try {
        // CRITICAL FOR ANDROID TABLETS: Call audioCtx.resume() and audio.play() SYNCHRONOUSLY inside the tap event!
        // Never `await` before `this.audio.play()`, otherwise Android Chrome drops the user-gesture token and blocks play()!
        this.audio.muted = false;
        const playPromise = this.audio.play();
        this.isPlaying = true;
        this.playBtn.classList.add('active');
        this.playBtn.textContent = '⏸ PAUSE';
        if (playPromise !== undefined) {
          await playPromise;
        }
      } catch (err) {
        if (err && err.name === 'AbortError') return;
        this.isPlaying = false;
        this.playBtn.classList.remove('active');
        this.playBtn.textContent = '▶ PLAY';
        if (err && err.name === 'NotAllowedError') {
          this.subEl.textContent = '🔊 100% Ready! Tap ▶ PLAY below to start audio';
          return;
        }
        console.warn('Playback error:', err);
        this.subEl.textContent = `⚠️ ${err.message || 'Tap ▶ PLAY again'}`;
      }
    } else {
      this.audio.pause();
      this.isPlaying = false;
      this.playBtn.classList.remove('active');
      this.playBtn.textContent = '▶ PLAY';
    }
  }

  updateTimeUI() {
    const cur = this.audio.currentTime || 0;
    const dur = this.audio.duration || 0;
    this.topTimeEl.textContent = `${fmtTime(cur)} / ${fmtTime(dur)}`;
    const pct = dur > 0 ? (cur / dur) * 100 : 0;
    this.playheadEl.style.insetInlineStart = `${pct}%`;
    this.drawStaticWaveform();
  }

  tick() {
    if (this.isPlaying && !this.audio.paused) {
      if (this.loopActive && this.audio.currentTime >= this.loopStart + this.loopLength) {
        this.audio.currentTime = this.loopStart;
      }
      this.rotationAngle = (this.rotationAngle + 2.2 * this.audio.playbackRate) % 360;
      if (this.jogRotorEl) {
        this.jogRotorEl.style.transform = `rotate(${this.rotationAngle}deg)`;
      }
      this.updateTimeUI();

      // Check Auto-DJ Continuous Party Mix trigger (within last 6 seconds of track)
      if (autoMixEnabled && this.audio.duration > 12 && (this.audio.duration - this.audio.currentTime) <= 6.0) {
        triggerAutoMixFrom(this);
      }
    }
    this.drawVUMeter();
  }

  drawVUMeter() {
    const canvas = this.vuCanvas;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    let level = 0;
    if (this.connected && this.analyser && this.isPlaying) {
      const data = new Uint8Array(this.analyser.frequencyBinCount);
      this.analyser.getByteFrequencyData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i];
      level = Math.min(1, (sum / data.length) / 175);
    }

    const segments = 18;
    const segH = (h - segments * 2) / segments;
    const activeSegs = Math.round(level * segments);

    for (let i = 0; i < segments; i++) {
      const segIndexFromBottom = segments - 1 - i;
      const y = i * (segH + 2);
      if (segIndexFromBottom < activeSegs) {
        if (segIndexFromBottom > 14) ctx.fillStyle = '#ff1744';
        else if (segIndexFromBottom > 10) ctx.fillStyle = '#ffb800';
        else ctx.fillStyle = '#00e676';
      } else {
        ctx.fillStyle = 'rgba(255,255,255,0.07)';
      }
      ctx.fillRect(2, y, w - 4, segH);
    }
  }
}

const deckA = new DJDeck('a');
const deckB = new DJDeck('b');

// 6. Master Crossfader (Equal-Power Curve)
const crossfader = document.getElementById('crossfader');
const xfadeLabel = document.getElementById('xfade-label');

function applyCrossfader(val) {
  deckA.connectAudioGraph();
  deckB.connectAudioGraph();
  // x ranges from -1 (Full A) to +1 (Full B)
  const norm = (val + 1) / 2; // 0..1
  const gainA = Math.cos(norm * 0.5 * Math.PI);
  const gainB = Math.sin(norm * 0.5 * Math.PI);
  deckA.xfadeGain.gain.value = gainA;
  deckB.xfadeGain.gain.value = gainB;

  if (Math.abs(val) < 0.05) {
    xfadeLabel.textContent = 'CROSSFADER (CENTER)';
  } else if (val < 0) {
    xfadeLabel.textContent = `DECK A (${Math.round((1 - norm) * 100)}%)`;
  } else {
    xfadeLabel.textContent = `DECK B (${Math.round(norm * 100)}%)`;
  }
}

crossfader.addEventListener('input', () => {
  applyCrossfader(parseFloat(crossfader.value));
});

document.getElementById('xfade-to-a').addEventListener('click', () => {
  crossfader.value = -1;
  syncSliderValue(crossfader);
  applyCrossfader(-1);
});

document.getElementById('xfade-center').addEventListener('click', () => {
  crossfader.value = 0;
  syncSliderValue(crossfader);
  applyCrossfader(0);
});

document.getElementById('xfade-to-b').addEventListener('click', () => {
  crossfader.value = 1;
  syncSliderValue(crossfader);
  applyCrossfader(1);
});

// Smooth 6-Second Automated Transition
let transitionInterval = null;
function smoothCrossfadeTo(targetVal, durationMs = 5500) {
  if (transitionInterval) clearInterval(transitionInterval);
  const startVal = parseFloat(crossfader.value);
  const startTime = performance.now();

  transitionInterval = setInterval(() => {
    const elapsed = performance.now() - startTime;
    const t = Math.min(1, elapsed / durationMs);
    const current = startVal + (targetVal - startVal) * t;
    crossfader.value = current.toFixed(2);
    syncSliderValue(crossfader);
    applyCrossfader(current);
    if (t >= 1) clearInterval(transitionInterval);
  }, 40);
}

document.getElementById('xfade-auto-swap').addEventListener('click', () => {
  const cur = parseFloat(crossfader.value);
  const target = cur <= 0 ? 1 : -1;
  if (target === 1 && !deckB.isPlaying) deckB.togglePlay();
  if (target === -1 && !deckA.isPlaying) deckA.togglePlay();
  smoothCrossfadeTo(target, 5500);
});

// 7. Continuous Auto-Mix Party Mode
let autoMixEnabled = false;
let autoMixInProgress = false;
let partyQueueIndex = 0;
let cachedVaultTracks = [];

const autoDjBtn = document.getElementById('btn-autodj');
const autoDjState = document.getElementById('autodj-state');

autoDjBtn.addEventListener('click', () => {
  autoMixEnabled = !autoMixEnabled;
  autoDjState.textContent = autoMixEnabled ? 'ON' : 'OFF';
  autoDjBtn.classList.toggle('btn-accent', autoMixEnabled);
});

async function triggerAutoMixFrom(endingDeck) {
  if (autoMixInProgress) return;
  autoMixInProgress = true;

  const nextDeck = endingDeck.id === 'a' ? deckB : deckA;
  // Load next track from Offline Party Vault if available
  if (cachedVaultTracks.length > 0) {
    const nextTrack = cachedVaultTracks[partyQueueIndex % cachedVaultTracks.length];
    partyQueueIndex++;
    await nextDeck.loadBlob(nextTrack.blob, nextTrack.title, 'Auto-Mix Party Queue');
  }

  if (!nextDeck.isPlaying) {
    await nextDeck.togglePlay();
  }
  smoothCrossfadeTo(nextDeck.id === 'a' ? -1 : 1, 5000);

  setTimeout(() => {
    autoMixInProgress = false;
  }, 7000);
}

function handleTrackEndedOnDeck(deck) {
  if (autoMixEnabled) {
    const otherDeck = deck.id === 'a' ? deckB : deckA;
    if (!otherDeck.isPlaying) {
      triggerAutoMixFrom(deck);
    }
  }
}

// 8. Built-in Club Synthesizer Demo Tracks (So you can test Bass/Mid/Treble immediately with 0 files!)
function createSynthTrackWav(bpm, style) {
  const sampleRate = 44100;
  const seconds = 24;
  const numSamples = sampleRate * seconds;
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);

  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + numSamples * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, numSamples * 2, true);

  const beatDur = 60 / bpm;
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const beatPos = (t % beatDur) / beatDur;
    const barBeat = Math.floor(t / beatDur) % 4;

    // Punchy Sub Kick (tests BASS EQ!)
    const kickEnv = Math.exp(-beatPos * 14);
    const kickFreq = 52 + 110 * Math.exp(-beatPos * 28);
    const kick = Math.sin(2 * Math.PI * kickFreq * t) * kickEnv * 0.75;

    // Bassline Riff (tests BASS & MIDS!)
    const notes = style === 'house' ? [55, 55, 65.41, 73.42] : [49, 58.27, 65.41, 49];
    const bassFreq = notes[barBeat];
    const saw = 2 * ((t * bassFreq) - Math.floor(0.5 + t * bassFreq));
    const bass = saw * 0.28 * (1 - beatPos * 0.5);

    // Synth Chord Stab on off-beats (tests MIDS!)
    const offBeatPos = ((t + beatDur * 0.5) % beatDur) / beatDur;
    const chordEnv = Math.exp(-offBeatPos * 9);
    const midFreq = style === 'house' ? 440 : 523.25;
    const midChord = (Math.sin(2 * Math.PI * midFreq * t) + Math.sin(2 * Math.PI * (midFreq * 1.25) * t)) * 0.2 * chordEnv;

    // Crisp Hi-Hat on 16ths (tests TREBLE EQ!)
    const sixteenthPos = (t % (beatDur / 4)) / (beatDur / 4);
    const hatEnv = Math.exp(-sixteenthPos * 26);
    const noise = (Math.random() * 2 - 1) * hatEnv * 0.22;

    const mix = Math.max(-0.98, Math.min(0.98, kick + bass + midChord + noise));
    view.setInt16(44 + i * 2, mix * 32767, true);
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

async function generateDemoBeats() {
  const blobA = createSynthTrackWav(124, 'house');
  const blobB = createSynthTrackWav(126, 'techno');
  await deckA.loadBlob(blobA, 'Ibiza Sunset Groove (124 BPM)', 'Built-in Club Synth • Test Bass/Mid/Treble');
  await deckB.loadBlob(blobB, 'Berlin Warehouse Peak (126 BPM)', 'Built-in Club Synth • Test Bass/Mid/Treble');
}

document.getElementById('btn-demo-tracks').addEventListener('click', async () => {
  await generateDemoBeats();
  if (!deckA.isPlaying) await deckA.togglePlay();
});

// 9. Master Spectrum Visualizer & Animation Loop
const specCanvas = document.getElementById('master-spectrum');
const specCtx = specCanvas.getContext('2d');

function renderLoop() {
  deckA.tick();
  deckB.tick();

  // Draw Master Frequency Spectrum
  const w = specCanvas.width;
  const h = specCanvas.height;
  specCtx.clearRect(0, 0, w, h);

  if (masterAnalyser) {
    const freqData = new Uint8Array(masterAnalyser.frequencyBinCount);
    masterAnalyser.getByteFrequencyData(freqData);
    const bars = 36;
    const barW = w / bars;

    for (let i = 0; i < bars; i++) {
      const val = freqData[i] / 255;
      const barH = Math.max(2, val * h);
      const x = i * barW;
      const y = h - barH;

      // Color code frequency bands: Left = Bass (Cyan), Middle = Mids (Gold), Right = Treble (Pink)
      if (i < 10) specCtx.fillStyle = '#00f0ff';
      else if (i < 24) specCtx.fillStyle = '#ffb800';
      else specCtx.fillStyle = '#ff2a85';

      specCtx.fillRect(x + 1, y, barW - 2, barH);
    }
  }

  requestAnimationFrame(renderLoop);
}
requestAnimationFrame(renderLoop);

// 10. YouTube Search & Offline Tablet Party Crate Modal + Drag Handle (modern-web-guidance `drag` pattern)
const crateModal = document.getElementById('crate-panel');
const crateHandle = document.getElementById('crate-drag-handle');
const btnOpenCrate = document.getElementById('btn-open-crate');
const btnCloseCrate = document.getElementById('btn-close-crate');

btnOpenCrate.addEventListener('click', () => {
  crateModal.hidden = false;
  refreshOfflineVaultUI();
});

btnCloseCrate.addEventListener('click', () => {
  crateModal.hidden = true;
});

// Pointer-capture drag logic per modern-web-guidance `drag` guide
let dragOffsetX = 0;
let dragOffsetY = 0;

function moveCrateTo(left, top) {
  const maxLeft = Math.max(0, window.innerWidth - crateModal.offsetWidth);
  const maxTop = Math.max(0, window.innerHeight - crateModal.offsetHeight);
  crateModal.style.insetInlineStart = `${Math.max(0, Math.min(left, maxLeft))}px`;
  crateModal.style.insetBlockStart = `${Math.max(0, Math.min(top, maxTop))}px`;
}

crateHandle.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || event.target.closest('button, input, select, textarea, a')) return;
  const rect = crateModal.getBoundingClientRect();
  dragOffsetX = event.clientX - rect.left;
  dragOffsetY = event.clientY - rect.top;
  crateHandle.setPointerCapture(event.pointerId);
});

crateHandle.addEventListener('pointermove', (event) => {
  if (!crateHandle.hasPointerCapture(event.pointerId)) return;
  crateHandle.classList.add('dragging');
  moveCrateTo(event.clientX - dragOffsetX, event.clientY - dragOffsetY);
});

crateHandle.addEventListener('lostpointercapture', () => {
  crateHandle.classList.remove('dragging');
});

crateHandle.addEventListener('keydown', (event) => {
  const step = 15;
  const rect = crateModal.getBoundingClientRect();
  if (event.key === 'ArrowLeft') { event.preventDefault(); moveCrateTo(rect.left - step, rect.top); }
  if (event.key === 'ArrowRight') { event.preventDefault(); moveCrateTo(rect.left + step, rect.top); }
  if (event.key === 'ArrowUp') { event.preventDefault(); moveCrateTo(rect.left, rect.top - step); }
  if (event.key === 'ArrowDown') { event.preventDefault(); moveCrateTo(rect.left, rect.top + step); }
});

// 11. Offline Vault Management (Import files or Save YouTube audio offline onto Tablet)
const multiFilesInput = document.getElementById('crate-multi-files');
const offlineListEl = document.getElementById('offline-crate-list');
const crateCountEl = document.getElementById('crate-count');

multiFilesInput.addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  for (const file of files) {
    const id = `file-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    await saveTrackToVault({
      id,
      title: file.name.replace(/\.[^/.]+$/, ''),
      artist: 'Tablet Local Audio',
      blob: file,
      addedAt: Date.now()
    });
  }
  await refreshOfflineVaultUI();
});

async function refreshOfflineVaultUI() {
  cachedVaultTracks = await getAllVaultTracks();
  crateCountEl.textContent = cachedVaultTracks.length;

  if (cachedVaultTracks.length === 0) {
    offlineListEl.innerHTML = `<div class="empty-hint">No offline party tracks saved yet. Import MP3s from your tablet or save tracks from YouTube results so you can mix anywhere with zero PC or Wi-Fi!</div>`;
    return;
  }

  offlineListEl.innerHTML = '';
  cachedVaultTracks.forEach((tr) => {
    const row = document.createElement('div');
    row.className = 'track-item';
    row.innerHTML = `
      <div class="track-item-info">
        <div class="track-item-title">${escapeHtml(tr.title)}</div>
        <div class="track-item-sub">${escapeHtml(tr.artist || 'Saved Offline in Tablet Vault')}</div>
      </div>
      <div class="track-item-actions">
        <button type="button" class="btn-micro btn-load-a">DECK A</button>
        <button type="button" class="btn-micro btn-load-b">DECK B</button>
        <button type="button" class="btn-micro" title="Delete from Vault">🗑</button>
      </div>
    `;
    const [btnA, btnB, btnDel] = row.querySelectorAll('button');
    const loadVaultItemToDeck = async (trItem, targetDeck, btnEl) => {
      targetDeck.unlockAudioOnUserGesture();
      if (trItem.blob && trItem.blob.size >= 15000) {
        await targetDeck.loadBlob(trItem.blob, trItem.title, 'Offline Party Vault');
        crateModal.hidden = true;
        if (targetDeck.audio.paused) {
          await targetDeck.togglePlay();
        }
        return;
      }
      // If it's a Cloud-Buffered Mix (no local blob), verify if the server still has the file cached;
      // if the server container restarted, re-prepare it with 0% -> 100% progress bar so it NEVER 404s!
      const vid = trItem.videoId || (trItem.id && trItem.id.startsWith('yt-') ? trItem.id.slice(3) : null);
      if (vid && vid.length === 11) {
        await loadYouTubeTrackToDeck({ videoId: vid, title: trItem.title, artist: trItem.artist, duration: 1800 }, targetDeck, btnEl);
        return;
      }
      if (trItem.streamUrl) {
        await targetDeck.loadStreamUrl(trItem.streamUrl, trItem.title, 'Cloud-Buffered Mix');
        crateModal.hidden = true;
        if (targetDeck.audio.paused) {
          await targetDeck.togglePlay();
        }
      }
    };
    btnA.addEventListener('click', () => loadVaultItemToDeck(tr, deckA, btnA));
    btnB.addEventListener('click', () => loadVaultItemToDeck(tr, deckB, btnB));
    btnDel.addEventListener('click', async () => {
      await deleteVaultTrack(tr.id);
      await refreshOfflineVaultUI();
    });
    offlineListEl.appendChild(row);
  });
}

// 12. YouTube Search & Direct Audio Stream / Offline Caching
const ytInput = document.getElementById('yt-input');
const btnYtSearch = document.getElementById('btn-yt-search');
const ytResultsList = document.getElementById('yt-results-list');
const ytStatus = document.getElementById('yt-status');

function setYtStatus(msg, isError = false) {
  ytStatus.hidden = !msg;
  ytStatus.textContent = msg;
  ytStatus.style.borderColor = isError ? '#ff2a85' : '#00f0ff';
  ytStatus.style.color = isError ? '#ff7eb6' : '#00f0ff';
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (m) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}

async function performYouTubeSearch() {
  const q = ytInput.value.trim();
  if (!q) return;

  // Check if user pasted a direct YouTube URL
  if (q.includes('youtube.com/') || q.includes('youtu.be/')) {
    setYtStatus('Fetching direct YouTube audio stream for 3-Band EQ...');
    try {
      const res = await fetch(`/api/youtube/info?url=${encodeURIComponent(q)}`);
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'Failed to resolve YouTube URL');
      renderYouTubeResults([data]);
      setYtStatus(`Found "${data.title}"! Choose Deck A, Deck B, or Save to Tablet Vault.`);
    } catch (err) {
      setYtStatus(err.message, true);
    }
    return;
  }

  setYtStatus(`Searching YouTube for "${q}"...`);
  try {
    const res = await fetch(`/api/youtube/search?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'Search failed');
    renderYouTubeResults(data.items || []);
    setYtStatus(`Loaded ${data.items.length} YouTube tracks. Tap Deck A/B to mix or Save Offline!`);
  } catch (err) {
    setYtStatus(err.message, true);
  }
}

function renderYouTubeResults(items) {
  if (!items.length) {
    ytResultsList.innerHTML = `<div class="empty-hint">No results found. Try another song name or paste a YouTube link.</div>`;
    return;
  }
  ytResultsList.innerHTML = '';
  items.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'track-item';
    row.innerHTML = `
      <div class="track-item-info">
        <div class="track-item-title">${escapeHtml(item.title)}</div>
        <div class="track-item-sub">${escapeHtml(item.artist)} ${item.duration ? '• ' + fmtTime(item.duration) : ''}</div>
      </div>
      <div class="track-item-actions">
        <button type="button" class="btn-micro btn-load-a">DECK A</button>
        <button type="button" class="btn-micro btn-load-b">DECK B</button>
        <button type="button" class="btn-micro btn-accent" title="Save inside Tablet Offline Party Vault">💾 SAVE OFFLINE</button>
      </div>
    `;
    const [btnA, btnB, btnSave] = row.querySelectorAll('button');
    btnA.addEventListener('click', () => loadYouTubeTrackToDeck(item, deckA, btnA));
    btnB.addEventListener('click', () => loadYouTubeTrackToDeck(item, deckB, btnB));
    btnSave.addEventListener('click', () => saveYouTubeTrackOffline(item, btnSave));
    ytResultsList.appendChild(row);
  });
}

async function resolveYouTubeProxyUrl(item) {
  const vidParam = item.videoId ? `&v=${encodeURIComponent(item.videoId)}` : '';
  if (item.streamUrl) {
    return `/api/youtube/proxy?url=${encodeURIComponent(item.streamUrl)}${vidParam}`;
  }
  const res = await fetch(`/api/youtube/info?v=${encodeURIComponent(item.videoId)}`);
  const data = await res.json();
  if (!res.ok || !data.streamUrl) {
    if (item.videoId) {
      return `/api/youtube/proxy?v=${encodeURIComponent(item.videoId)}`;
    }
    throw new Error(data.error || 'Could not extract audio stream for this video');
  }
  return `/api/youtube/proxy?url=${encodeURIComponent(data.streamUrl)}${vidParam}`;
}

// Download stream with real-time 0% -> 100% progress callback so playback NEVER cuts or buffers mid-song!
async function fetchAudioBlobWithProgress(url, onProgress) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Download failed (HTTP ${resp.status})`);

  const totalBytes = parseInt(resp.headers.get('content-length') || '0', 10);
  if (!resp.body) {
    const blob = await resp.blob();
    onProgress(100, blob.size, blob.size);
    return blob;
  }

  const reader = resp.body.getReader();
  const chunks = [];
  let receivedBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    receivedBytes += value.length;
    if (totalBytes > 0) {
      const pct = Math.min(99, Math.round((receivedBytes / totalBytes) * 100));
      onProgress(pct, receivedBytes, totalBytes);
    } else {
      // Estimate based on ~3.5MB average song size if Content-Length header is omitted
      const estPct = Math.min(95, Math.round((receivedBytes / (3.5 * 1024 * 1024)) * 100));
      onProgress(estPct, receivedBytes, 0);
    }
  }

  onProgress(100, receivedBytes, totalBytes);
  const mime = resp.headers.get('content-type') || 'audio/mp4';
  return new Blob(chunks, { type: mime });
}

// Poll server-side download progress (0% -> 100%) so the Railway server buffers the file to disk,
// avoiding YouTube throttling AND keeping Tablet RAM usage near 0 MB (even for 1-hour Afro House sets)!
async function prepareServerAudioWithProgress(videoId, onProgress) {
  while (true) {
    const res = await fetch(`/api/youtube/prepare?v=${encodeURIComponent(videoId)}`);
    const data = await res.json();
    if (!res.ok || data.error || data.status === 'error') {
      throw new Error(data.error || 'Could not buffer track on server');
    }
    if (data.status === 'ready') {
      onProgress(100);
      return data.streamUrl || data.directUrl || `/api/youtube/file/${encodeURIComponent(videoId)}`;
    }
    onProgress(data.progress || 10);
    await new Promise((r) => setTimeout(r, 900));
  }
}

async function loadYouTubeTrackToDeck(item, deck, btnEl) {
  const origBtnText = btnEl ? btnEl.textContent : '';
  try {
    // Unlock AudioContext AND the deck's HTMLAudioElement synchronously inside the user's tap gesture
    // so Android Chrome permits auto-play even after a 15-second cloud download finishes!
    deck.unlockAudioOnUserGesture();

    if (btnEl) btnEl.disabled = true;
    deck.currentVideoId = item.videoId || null;
    deck.titleEl.textContent = item.title;
    deck.subEl.textContent = 'Buffering 100% on Cloud Server for zero-cut playback...';
    deck.setDownloadProgress(5, 'PREPARING 5%');
    setYtStatus(`Buffering "${item.title}" for Deck ${deck.id.toUpperCase()} (5%)...`);

    const isLongSet = (item.duration && item.duration > 600); // > 10 minutes

    if (item.videoId) {
      const serverFileUrl = await prepareServerAudioWithProgress(item.videoId, (pct) => {
        deck.setDownloadProgress(pct, `DOWNLOADING ${pct}%`);
        if (btnEl) btnEl.textContent = `⏳ ${pct}%`;
        setYtStatus(`Downloading "${item.title}" to 100% before playing: ${pct}%`);
      });

      if (!isLongSet) {
        try {
          const resp = await fetch(serverFileUrl);
          if (resp.ok) {
            const rawBlob = await resp.blob();
            if (rawBlob.size > 25000) {
              const blob = new Blob([rawBlob], { type: 'audio/mp4' });
              await saveTrackToVault({
                id: `yt-${item.videoId}`,
                title: item.title,
                artist: `${item.artist} (100% Offline Ready)`,
                blob,
                addedAt: Date.now()
              });
              await refreshOfflineVaultUI();
              await deck.loadBlob(blob, item.title, `100% Offline Ready • ${item.artist}`);
            } else {
              await deck.loadStreamUrl(serverFileUrl, item.title, `100% Buffered • ${item.artist}`);
            }
          } else {
            await deck.loadStreamUrl(serverFileUrl, item.title, `100% Buffered • ${item.artist}`);
          }
        } catch (_) {
          await deck.loadStreamUrl(serverFileUrl, item.title, `100% Buffered • ${item.artist}`);
        }
      } else {
        await deck.loadStreamUrl(serverFileUrl, item.title, `100% Buffered Long DJ Set • ${item.artist}`);
      }
    } else {
      const proxyUrl = await resolveYouTubeProxyUrl(item);
      await deck.loadStreamUrl(proxyUrl, item.title, `YouTube • ${item.artist}`);
    }

    setYtStatus(`✅ 100% Ready "${item.title}" on Deck ${deck.id.toUpperCase()}! Playing now.`);
    if (btnEl) {
      btnEl.textContent = '✅ 100%';
      btnEl.disabled = false;
    }
    crateModal.hidden = true;
    
    // Explicitly un-pause or trigger play now that stream/blob is loaded
    try {
      if (deck.audio.paused) {
        await deck.togglePlay();
      }
    } catch (_) {}
  } catch (err) {
    deck.setDownloadProgress(null);
    if (btnEl) {
      btnEl.textContent = origBtnText;
      btnEl.disabled = false;
    }
    setYtStatus(err.message, true);
  }
}

async function saveYouTubeTrackOffline(item, btnEl) {
  const origText = btnEl.textContent;
  try {
    btnEl.disabled = true;
    btnEl.textContent = '⏳ 0%';
    setYtStatus(`Downloading "${item.title}" (0%)...`);

    let downloadUrl;
    if (item.videoId) {
      downloadUrl = await prepareServerAudioWithProgress(item.videoId, (pct) => {
        btnEl.textContent = `⏳ ${pct}%`;
        setYtStatus(`Buffering "${item.title}": ${pct}%...`);
      });
    } else {
      downloadUrl = await resolveYouTubeProxyUrl(item);
    }

    // For long mixes (> 15 mins / 900s), store a lightweight Server-Backed Offline Entry so we never exceed tablet RAM,
    // and automatically load it into the first available Deck!
    const isLongMix = item.duration && item.duration > 900;
    let blobToSave = null;

    if (!isLongMix) {
      const resp = await fetch(downloadUrl);
      if (!resp.ok) throw new Error('Download failed');
      const rawBlob = await resp.blob();
      blobToSave = new Blob([rawBlob], { type: 'audio/mp4' });
    }

    await saveTrackToVault({
      id: `yt-${item.videoId || Date.now()}`,
      videoId: item.videoId || null,
      streamUrl: downloadUrl,
      title: item.title,
      artist: `${item.artist} (${isLongMix ? '100% Cloud-Buffered Mix' : '100% Offline Ready'})`,
      blob: blobToSave,
      addedAt: Date.now()
    });
    btnEl.textContent = '✅ 100% SAVED';
    setYtStatus(`✅ 100% Saved "${item.title}" to your Party Vault!`);
    await refreshOfflineVaultUI();
  } catch (err) {
    btnEl.textContent = origText;
    btnEl.disabled = false;
    setYtStatus(err.message, true);
  }
}

btnYtSearch.addEventListener('click', performYouTubeSearch);
ytInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') performYouTubeSearch();
});

// Global first-touch Web Audio unlocker for Android Chrome / iOS Safari tablets & phones
function unlockWebAudioOnFirstTouch() {
  ensureAudioContext();
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
  deckA.connectAudioGraph();
  deckB.connectAudioGraph();
}
['pointerdown', 'touchstart', 'click', 'keydown'].forEach((evt) => {
  window.addEventListener(evt, unlockWebAudioOnFirstTouch, { once: true, passive: true });
});

// Initialize Demo Tracks & Offline Vault Count on Startup (auto-clean corrupted or expired broken items)
window.addEventListener('DOMContentLoaded', async () => {
  try {
    const tracks = await getAllVaultTracks();
    for (const tr of tracks) {
      if (tr.blob && (tr.blob.size < 15000 || tr.blob.size > 20 * 1024 * 1024)) {
        await deleteVaultTrack(tr.id);
      } else if (!tr.blob && !tr.streamUrl && !tr.videoId) {
        await deleteVaultTrack(tr.id);
      } else if (tr.videoId === 'mn0PupX6Q20' || (tr.id && tr.id.includes('mn0PupX6Q20'))) {
        // Automatically delete the dead deleted video from the user's vault
        await deleteVaultTrack(tr.id);
      }
    }
  } catch (_) {}
  await generateDemoBeats();
  await refreshOfflineVaultUI();
});
