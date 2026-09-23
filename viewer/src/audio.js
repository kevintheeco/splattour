// Sound for the tour: background music (tracks from tour.json, or a
// generative ambient score when none are given) and positional ambience
// (e.g. wind chimes by the courtyard) that pans and fades as you move.
import * as THREE from "three";

// Pyeongjo-like pentatonic (sol-la-do-re-mi) in two octaves, around G3.
const SCALE = [0, 2, 5, 7, 9];
const ROOT_HZ = 196;

function makeImpulse(ctx, seconds = 3.2, decay = 2.4) {
  const rate = ctx.sampleRate;
  const len = Math.floor(rate * seconds);
  const buf = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return buf;
}

// Karplus–Strong plucked string: a short noise burst through a tuned,
// damped delay loop. Rendered offline once per pitch and cached.
function pluckBuffer(ctx, hz, seconds = 3.5) {
  const rate = ctx.sampleRate;
  const len = Math.floor(rate * seconds);
  const buf = ctx.createBuffer(1, len, rate);
  const d = buf.getChannelData(0);
  const period = Math.max(2, Math.round(rate / hz));
  const ring = new Float32Array(period);
  for (let i = 0; i < period; i++) ring[i] = (Math.random() * 2 - 1) * (1 - i / period);
  let idx = 0;
  let prev = 0;
  const damp = 0.996 - hz / 60000;
  for (let i = 0; i < len; i++) {
    const cur = ring[idx];
    const next = damp * 0.5 * (cur + prev);
    prev = cur;
    ring[idx] = next;
    idx = (idx + 1) % period;
    // gentle attack shaping + slow bend down, like a gayageum string released
    d[i] = cur * Math.min(1, i / 60);
  }
  return buf;
}

class GenerativeScore {
  constructor(ctx, out) {
    this.ctx = ctx;
    this.out = out;
    this.cache = new Map();
    this.timer = null;
    this.step = 0;
  }

  note(deg, octave) {
    const semis = SCALE[((deg % 5) + 5) % 5] + 12 * (octave + Math.floor(deg / 5));
    return ROOT_HZ * Math.pow(2, semis / 12);
  }

  pluck(hz, when, gain = 0.35, pan = 0) {
    const key = Math.round(hz);
    if (!this.cache.has(key)) this.cache.set(key, pluckBuffer(this.ctx, hz));
    const src = this.ctx.createBufferSource();
    src.buffer = this.cache.get(key);
    // nonghyeon: a slight pitch bend on some notes
    if (Math.random() < 0.3) {
      src.playbackRate.setValueAtTime(1, when + 0.25);
      src.playbackRate.linearRampToValueAtTime(Math.random() < 0.5 ? 1.03 : 0.985, when + 0.9);
      src.playbackRate.linearRampToValueAtTime(1, when + 1.6);
    }
    const g = this.ctx.createGain();
    g.gain.value = gain;
    const p = this.ctx.createStereoPanner();
    p.pan.value = pan;
    src.connect(g).connect(p).connect(this.out);
    src.start(when);
  }

  drone() {
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.value = 0;
    g.gain.linearRampToValueAtTime(0.05, ctx.currentTime + 6);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 600;
    for (const [mult, det] of [[0.5, -4], [0.75, 3], [1, 0]]) {
      const o = ctx.createOscillator();
      o.type = "triangle";
      o.frequency.value = ROOT_HZ * mult;
      o.detune.value = det;
      o.connect(lp);
      o.start();
      this.oscs = [...(this.oscs || []), o];
    }
    // slow breathing of the drone
    const lfo = ctx.createOscillator();
    const lfoG = ctx.createGain();
    lfo.frequency.value = 0.05;
    lfoG.gain.value = 180;
    lfo.connect(lfoG).connect(lp.frequency);
    lfo.start();
    this.oscs.push(lfo);
    lp.connect(g).connect(this.out);
    this.droneGain = g;
  }

  start() {
    this.drone();
    let deg = 2;
    const beat = 0.62;
    let t = this.ctx.currentTime + 0.5;
    const schedule = () => {
      const horizon = this.ctx.currentTime + 2.5;
      while (t < horizon) {
        const phrasePos = this.step % 16;
        // sparse, phrase-shaped melody: rests grow toward phrase ends
        const restP = phrasePos > 12 ? 0.65 : 0.35;
        if (Math.random() > restP) {
          deg += [-2, -1, -1, 0, 1, 1, 2][Math.floor(Math.random() * 7)];
          deg = THREE.MathUtils.clamp(deg, 0, 9);
          this.pluck(this.note(deg, 0), t, 0.28 + Math.random() * 0.12, (Math.random() - 0.5) * 0.6);
          if (phrasePos % 8 === 0) this.pluck(this.note(deg - 5, -1), t, 0.2, -0.2);
        }
        t += beat * (Math.random() < 0.2 ? 1.5 : 1);
        this.step++;
      }
    };
    schedule();
    this.timer = setInterval(schedule, 500);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    const now = this.ctx.currentTime;
    this.droneGain?.gain.linearRampToValueAtTime(0, now + 1.5);
    for (const o of this.oscs || []) o.stop(now + 1.6);
    this.oscs = [];
  }
}

export class TourAudio {
  constructor({ tour, camera }) {
    this.tour = tour;
    this.camera = camera;
    this.ctx = null;
    this.playing = false;
    this.volume = 0.7;
    this.tracks = (tour.data.music || []).map((m) => ({ title: m.title || "Music", src: tour.resolve(m.src) }));
    this.sounds = (tour.data.sounds || []).map((s) => ({
      src: tour.resolve(s.src),
      position: new THREE.Vector3().fromArray(s.position),
      radius: s.radius ?? 6,
      volume: s.volume ?? 0.6,
    }));
    this._p = new THREE.Vector3();
    this._f = new THREE.Vector3();
    this._u = new THREE.Vector3();
  }

  _init() {
    if (this.ctx) return;
    const ctx = (this.ctx = new AudioContext());
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(ctx.destination);
    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = 0.8;
    const verb = ctx.createConvolver();
    verb.buffer = makeImpulse(ctx);
    const wet = ctx.createGain();
    wet.gain.value = 0.45;
    this.musicBus.connect(this.master);
    this.musicBus.connect(verb).connect(wet).connect(this.master);
    this.ambBus = ctx.createGain();
    this.ambBus.connect(this.master);
  }

  async play() {
    this._init();
    await this.ctx.resume();
    if (this.playing) return;
    this.playing = true;
    if (this.tracks.length) {
      this.el = this.el || new Audio();
      this.el.crossOrigin = "anonymous";
      this.trackIndex = this.trackIndex ?? 0;
      this.el.src = this.tracks[this.trackIndex].src;
      this.el.loop = this.tracks.length === 1;
      this.el.onended = () => this.next();
      if (!this.elNode) this.elNode = this.ctx.createMediaElementSource(this.el);
      this.elNode.connect(this.musicBus);
      await this.el.play().catch(() => {});
    } else {
      this.score = new GenerativeScore(this.ctx, this.musicBus);
      this.score.start();
    }
    await this._startAmbience();
  }

  next() {
    if (!this.tracks.length) return;
    this.trackIndex = (this.trackIndex + 1) % this.tracks.length;
    this.el.src = this.tracks[this.trackIndex].src;
    this.el.play().catch(() => {});
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    this.el?.pause();
    this.score?.stop();
    this.score = null;
    for (const s of this.sounds) {
      s.node?.stop();
      s.node = null;
    }
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
    return this.playing;
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  async _startAmbience() {
    for (const s of this.sounds) {
      if (!s.buffer) {
        const res = await fetch(s.src);
        s.buffer = await this.ctx.decodeAudioData(await res.arrayBuffer());
      }
      const src = this.ctx.createBufferSource();
      src.buffer = s.buffer;
      src.loop = true;
      const panner = new PannerNode(this.ctx, {
        panningModel: "HRTF",
        distanceModel: "inverse",
        refDistance: 1,
        maxDistance: s.radius * 3,
        rolloffFactor: 1.2,
        positionX: s.position.x,
        positionY: s.position.y,
        positionZ: s.position.z,
      });
      const g = this.ctx.createGain();
      g.gain.value = s.volume;
      src.connect(g).connect(panner).connect(this.ambBus);
      src.start();
      s.node = src;
    }
  }

  // Keep the Web Audio listener glued to the camera.
  update() {
    if (!this.ctx || !this.playing) return;
    const L = this.ctx.listener;
    this.camera.getWorldPosition(this._p);
    this.camera.getWorldDirection(this._f);
    this._u.set(0, 1, 0).applyQuaternion(this.camera.getWorldQuaternion(new THREE.Quaternion()));
    const t = this.ctx.currentTime;
    if (L.positionX) {
      L.positionX.setTargetAtTime(this._p.x, t, 0.05);
      L.positionY.setTargetAtTime(this._p.y, t, 0.05);
      L.positionZ.setTargetAtTime(this._p.z, t, 0.05);
      L.forwardX.setTargetAtTime(this._f.x, t, 0.05);
      L.forwardY.setTargetAtTime(this._f.y, t, 0.05);
      L.forwardZ.setTargetAtTime(this._f.z, t, 0.05);
      L.upX.setTargetAtTime(this._u.x, t, 0.05);
      L.upY.setTargetAtTime(this._u.y, t, 0.05);
      L.upZ.setTargetAtTime(this._u.z, t, 0.05);
    } else {
      L.setPosition(this._p.x, this._p.y, this._p.z);
      L.setOrientation(this._f.x, this._f.y, this._f.z, this._u.x, this._u.y, this._u.z);
    }
  }
}
