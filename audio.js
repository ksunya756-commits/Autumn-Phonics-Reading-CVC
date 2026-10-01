const LOCAL_AUDIO_FILES = [
  'a', 'b', 'd', 'e', 'f', 'g', 'h', 'i',
  'j', 'k', 'l', 'm', 'n', 'o', 'p', 'r',
].map((key) => ({ key, filename: `${key}.m4a`, mime: 'audio/mp4' }));

class PhonicsAudio {
  constructor(manifestUrl) {
    this.manifestUrl = manifestUrl;
    this.context = null;
    this.gain = null;
    this.manifest = null;
    this.manifestLoading = null;
    this.soundMap = new Map();
    this.buffers = new Map();
    this.loading = new Map();
    this.currentSource = null;
    this.waitTimer = null;
    this.generation = 0;
    this.volume = 0.9;
    this.localFileMode = window.location.protocol === 'file:';
  }

  ensureContext() {
    if (!this.context) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) throw new Error('This browser cannot play the phonics audio.');
      this.context = new AudioContextClass();
      this.gain = this.context.createGain();
      this.gain.gain.value = this.volume;
      this.gain.connect(this.context.destination);
    }
    return this.context;
  }

  async unlock() {
    if (this.localFileMode) return;
    const context = this.ensureContext();
    if (context.state === 'suspended') await context.resume();
  }

  setVolume(value) {
    this.volume = Math.max(0, Math.min(1, Number(value)));
    if (this.gain) this.gain.gain.value = this.volume;
    if (this.localFileMode && this.currentSource?.node) this.currentSource.node.volume = this.volume;
  }

  async loadManifest() {
    if (this.manifest) return this.manifest;
    if (this.manifestLoading) return this.manifestLoading;
    this.manifestLoading = (async () => {
      let manifest;
      if (this.localFileMode) {
        manifest = { version: 1, sounds: LOCAL_AUDIO_FILES };
      } else {
        const response = await fetch(this.manifestUrl, { cache: 'no-cache' });
        if (!response.ok) throw new Error(`Audio manifest could not be loaded (${response.status}).`);
        manifest = await response.json();
      }
      if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.sounds)) {
        throw new Error('The audio manifest has an unsupported format.');
      }
      const base = new URL('.', new URL(this.manifestUrl, window.location.href));
      manifest.sounds.forEach((sound) => {
        if (!sound.key || !sound.filename) throw new Error('The audio manifest contains an incomplete sound entry.');
        this.soundMap.set(sound.key, { ...sound, url: new URL(sound.filename, base).href });
      });
      this.manifest = manifest;
      return manifest;
    })();
    try {
      return await this.manifestLoading;
    } finally {
      this.manifestLoading = null;
    }
  }

  async loadKey(key) {
    if (this.buffers.has(key)) return this.buffers.get(key);
    if (this.loading.has(key)) return this.loading.get(key);
    const task = (async () => {
      await this.loadManifest();
      const sound = this.soundMap.get(key);
      if (!sound) throw new Error(`The /${key}/ sound is missing from the audio manifest.`);
      if (this.localFileMode) {
        await this.preloadLocalFile(sound);
        this.buffers.set(key, sound.url);
        return sound.url;
      }
      const response = await fetch(sound.url, { cache: 'force-cache' });
      if (!response.ok) throw new Error(`The sound “${key}” could not be loaded (${response.status}).`);
      const data = await response.arrayBuffer();
      const buffer = await this.ensureContext().decodeAudioData(data.slice(0));
      if (!buffer || buffer.duration <= 0) throw new Error(`The sound “${key}” is empty.`);
      this.buffers.set(key, buffer);
      return buffer;
    })();
    this.loading.set(key, task);
    try {
      return await task;
    } finally {
      this.loading.delete(key);
    }
  }

  async loadKeys(keys) {
    const uniqueKeys = [...new Set(keys)];
    await Promise.all(uniqueKeys.map((key) => this.loadKey(key)));
    return uniqueKeys;
  }

  preloadLocalFile(sound) {
    return new Promise((resolve, reject) => {
      const media = new Audio();
      let settled = false;
      const timeout = setTimeout(() => finish(new Error(`The sound “${sound.key}” took too long to load.`)), 12000);
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        media.removeEventListener('canplay', ready);
        media.removeEventListener('error', failed);
        if (error) reject(error);
        else resolve();
      };
      const ready = () => {
        if (!Number.isFinite(media.duration) || media.duration <= 0) finish(new Error(`The sound “${sound.key}” is empty.`));
        else finish();
      };
      const failed = () => finish(new Error(`The local sound “${sound.key}” could not be loaded.`));
      media.preload = 'auto';
      media.addEventListener('canplay', ready);
      media.addEventListener('error', failed);
      media.src = sound.url;
      media.load();
    });
  }

  cancel() {
    this.generation += 1;
    if (this.waitTimer) {
      clearTimeout(this.waitTimer.id);
      this.waitTimer.resolve(false);
      this.waitTimer = null;
    }
    if (this.currentSource) {
      if (this.currentSource.cancel) {
        this.currentSource.cancel();
      } else {
        this.currentSource.wasStopped = true;
        try { this.currentSource.node.stop(); } catch (_) { /* already stopped */ }
      }
      this.currentSource = null;
    }
  }

  begin() {
    this.cancel();
    return this.generation;
  }

  async playInSession(key, token, hooks = {}) {
    if (token !== this.generation) return false;
    const buffer = this.buffers.get(key) || await this.loadKey(key);
    if (token !== this.generation) return false;
    if (this.localFileMode) return this.playLocalFile(key, buffer, token, hooks);
    await this.unlock();
    if (token !== this.generation) return false;

    return new Promise((resolve, reject) => {
      const node = this.context.createBufferSource();
      const record = { node, wasStopped: false };
      node.buffer = buffer;
      node.connect(this.gain);
      this.currentSource = record;
      hooks.onStart?.();
      node.onended = () => {
        if (this.currentSource === record) this.currentSource = null;
        const completed = !record.wasStopped && token === this.generation;
        if (completed) hooks.onComplete?.();
        hooks.onStop?.(completed);
        resolve(completed);
      };
      try {
        node.start();
      } catch (error) {
        if (this.currentSource === record) this.currentSource = null;
        hooks.onStop?.(false);
        reject(error);
      }
    });
  }

  playLocalFile(key, url, token, hooks = {}) {
    return new Promise((resolve, reject) => {
      const media = new Audio(url);
      let settled = false;
      const finish = (completed, error) => {
        if (settled) return;
        settled = true;
        media.onended = null;
        media.onerror = null;
        if (this.currentSource === record) this.currentSource = null;
        if (completed) hooks.onComplete?.();
        hooks.onStop?.(completed);
        if (error) reject(error);
        else resolve(completed);
      };
      const record = {
        node: media,
        wasStopped: false,
        cancel: () => {
          record.wasStopped = true;
          media.pause();
          try { media.currentTime = 0; } catch (_) { /* not seekable yet */ }
          finish(false);
        },
      };
      media.preload = 'auto';
      media.volume = this.volume;
      media.onended = () => finish(!record.wasStopped && token === this.generation);
      media.onerror = () => finish(false, new Error(`The local sound “${key}” could not be played.`));
      this.currentSource = record;
      media.play().then(() => {
        if (token !== this.generation) record.cancel();
        else hooks.onStart?.();
      }).catch(() => finish(false, new Error(`The local sound “${key}” could not be played.`)));
    });
  }

  wait(milliseconds, token) {
    if (token !== this.generation) return Promise.resolve(false);
    return new Promise((resolve) => {
      const id = setTimeout(() => {
        if (this.waitTimer?.id === id) this.waitTimer = null;
        resolve(token === this.generation);
      }, milliseconds);
      this.waitTimer = { id, resolve };
    });
  }

  playSingle(key, hooks = {}) {
    const token = this.begin();
    return this.playInSession(key, token, hooks);
  }

  async playSequence(items, gap, hooks = {}) {
    const token = this.begin();
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const completed = await this.playInSession(item.key, token, {
        onStart: () => hooks.onStart?.(item, index),
        onComplete: () => hooks.onComplete?.(item, index),
        onStop: (done) => hooks.onStop?.(item, index, done),
      });
      if (!completed) return false;
      if (index < items.length - 1 && !(await this.wait(gap, token))) return false;
    }
    hooks.onSequenceComplete?.();
    return token === this.generation;
  }
}

