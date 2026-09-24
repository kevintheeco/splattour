// Interactive lighting for a baked radiance field.
//
// A 3DGS scene stores outgoing radiance, not materials, so there is no real
// light to switch off. We approximate relighting per splat on the GPU:
//
//   normal  n  = the Gaussian's thinnest axis (splats flatten onto surfaces)
//   lamp i  contributes  f_i(p) = falloff(|p - x_i| / r_i) * (0.15 + 0.85 |n·l|)
//
//   day/night:  c' = c * ( a + (1 - a) * Σ_on f_i )     a = ambient level
//   lamp off:   c' *= (1 - k * f_i)  and emitter splats (|p - x_i| < e_i) dim
//   lamp on (added/virtual): c' += c * g_i * f_i * colour_i
//
// followed by exposure, white balance (colour temperature) and saturation.
// Because it runs as a Spark world modifier, every control is a uniform and
// updates in real time on millions of splats.
import * as THREE from "three";
import { dyno } from "@sparkjsdev/spark";

export const MAX_LIGHTS = 16;

// Tanner Helland's blackbody approximation, normalised so 6500K ≈ white.
export function kelvinToRgb(k) {
  const t = k / 100;
  let r, g, b;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }
  const c = [r, g, b].map((v) => THREE.MathUtils.clamp(v, 0, 255) / 255);
  return new THREE.Vector3(...c);
}
const WHITE = kelvinToRgb(6500);

const GLOBALS = /* glsl */ `
uniform float stExposure;
uniform vec3  stWhite;
uniform float stSaturation;
uniform float stAmbient;
uniform float stContrast;
uniform int   stNumLights;
uniform vec4  stLightPos[${MAX_LIGHTS}];   // xyz, reach radius
uniform vec4  stLightCol[${MAX_LIGHTS}];   // rgb colour, w = gain when on
uniform vec4  stLightState[${MAX_LIGHTS}]; // x = on (0..1), y = captured-on (0/1), z = emitter radius, w = strength
float stFalloff(float d, float r) {
  float x = d / max(r, 1e-3);
  float w = clamp(1.0 - x * x * x * x, 0.0, 1.0);
  // Windowed inverse-square: bright pool under the lamp, walls a few metres
  // away fall off instead of the whole room lighting up evenly.
  float y = x / 0.35;
  return w * w / (1.0 + y * y);
}
vec3 stLight(vec3 p, vec3 n, vec3 sc, vec3 c) {
  // Only flat Gaussians have a trustworthy normal; blobs get even light so
  // per-splat shading never exposes the splat structure (painterly streaks).
  float smin = min(sc.x, min(sc.y, sc.z));
  float smid = sc.x + sc.y + sc.z - smin - max(sc.x, max(sc.y, sc.z));
  float flatness = clamp(1.0 - smin / max(smid, 1e-6), 0.0, 1.0);
  float nTrust = flatness * flatness * flatness * 0.8;
  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  vec3 carried = vec3(0.0);   // light kept alive by lamps that are on
  float removed = 0.0;        // light taken away by captured lamps now off
  vec3 added = vec3(0.0);     // light from lamps that were off at capture
  float emitterDim = 1.0;
  for (int i = 0; i < ${MAX_LIGHTS}; i++) {
    if (i >= stNumLights) break;
    vec3 L = stLightPos[i].xyz - p;
    float d = length(L);
    float lam = mix(1.0, 0.15 + 0.85 * abs(dot(n, L / max(d, 1e-4))), nTrust);
    float f = stFalloff(d, stLightPos[i].w) * lam * stLightState[i].w;
    float on = stLightState[i].x;
    float captured = stLightState[i].y;
    vec3 col = stLightCol[i].rgb;
    carried += on * f * col * 2.2;
    removed += captured * (1.0 - on) * f;
    added += (1.0 - captured) * on * f * col * stLightCol[i].w;
    // the lamp's own glowing splats
    float e = stLightState[i].z;
    if (e > 0.0 && d < e) {
      float core = 1.0 - smoothstep(0.35 * e, e, d);
      emitterDim = min(emitterDim, mix(1.0, 0.12 + 0.88 * on, core));
    }
  }
  float a = stAmbient;
  // Ambient (sky / moonlight) takes the scene colour temperature; lamp
  // light keeps each lamp's own colour.
  vec3 amb = mix(vec3(1.0), stWhite, 1.0 - a * 0.5);
  vec3 k = a * amb + (1.0 - a) * (amb * 0.25 * a + min(carried, vec3(1.8)));
  vec3 outc = c * k * (1.0 - 0.8 * clamp(removed, 0.0, 1.0)) * emitterDim;
  outc += c * added + added * 0.06 * (1.0 - lum);
  return outc;
}
vec3 stGrade(vec3 c) {
  c *= stExposure;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, stSaturation);
  c = (c - 0.5) * stContrast + 0.5;
  return c;
}
`;

export class Lighting {
  constructor(splat, lights = []) {
    this.splat = splat;
    this.params = { exposure: 1, kelvin: 6500, saturation: 1, contrast: 1, ambient: 1 };
    this.lights = lights.slice(0, MAX_LIGHTS).map((l, i) => ({
      id: l.id ?? `light${i}`,
      name: l.name ?? `조명 ${i + 1}`,
      position: new THREE.Vector3().fromArray(l.position),
      radius: l.radius ?? 3.5,
      emitter: l.emitter ?? 0.35,
      color: kelvinToRgb(l.kelvin ?? 2900),
      kelvin: l.kelvin ?? 2900,
      gain: l.gain ?? 1.2,
      strength: l.strength ?? 1,
      captured: l.capturedOn ?? true,
      on: l.on ?? l.capturedOn ?? true,
      level: (l.on ?? l.capturedOn ?? true) ? 1 : 0, // animated 0..1
    }));
    const U = (value) => ({ value });
    this.u = {
      stExposure: U(1),
      stWhite: U(new THREE.Vector3(1, 1, 1)),
      stSaturation: U(1),
      stAmbient: U(1),
      stContrast: U(1),
      stNumLights: U(this.lights.length),
      stLightPos: U(Array.from({ length: MAX_LIGHTS }, () => new THREE.Vector4())),
      stLightCol: U(Array.from({ length: MAX_LIGHTS }, () => new THREE.Vector4())),
      stLightState: U(Array.from({ length: MAX_LIGHTS }, () => new THREE.Vector4())),
    };
    const uniforms = this.u;
    const block = new dyno.Dyno({
      inTypes: { gsplat: dyno.Gsplat },
      outTypes: { gsplat: dyno.Gsplat },
      generate: ({ inputs, outputs }) => ({
        globals: [dyno.defineGsplat, dyno.defineGsplatNormal, GLOBALS],
        statements: [
          `${outputs.gsplat} = ${inputs.gsplat};`,
          `{`,
          `  vec3 n = gsplatNormal(${inputs.gsplat}.scales, ${inputs.gsplat}.quaternion);`,
          `  vec3 c = stLight(${inputs.gsplat}.center, n, ${inputs.gsplat}.scales, ${inputs.gsplat}.rgba.rgb);`,
          `  ${outputs.gsplat}.rgba.rgb = max(stGrade(c), vec3(0.0));`,
          `}`,
        ],
        uniforms,
      }),
    });
    splat.worldModifier = { apply: ({ gsplat }) => block.apply({ gsplat }) };
    splat.updateGenerator();
    this.sync();
  }

  // Push parameters to the GPU and ask Spark to regenerate the splats.
  sync() {
    const p = this.params;
    const w = kelvinToRgb(p.kelvin);
    // "Light colour": low kelvin tints the scene warm, high kelvin cool.
    this.u.stWhite.value.set(w.x / WHITE.x, w.y / WHITE.y, w.z / WHITE.z);
    // keep perceived brightness roughly constant across temperatures
    const lumW = 0.2126 * this.u.stWhite.value.x + 0.7152 * this.u.stWhite.value.y + 0.0722 * this.u.stWhite.value.z;
    this.u.stWhite.value.multiplyScalar(1 / Math.max(lumW, 1e-3));
    this.u.stExposure.value = p.exposure;
    this.u.stSaturation.value = p.saturation;
    this.u.stContrast.value = p.contrast;
    this.u.stAmbient.value = p.ambient;
    this.u.stNumLights.value = this.lights.length;
    this.lights.forEach((l, i) => {
      this.u.stLightPos.value[i].set(l.position.x, l.position.y, l.position.z, l.radius);
      this.u.stLightCol.value[i].set(l.color.x, l.color.y, l.color.z, l.gain);
      this.u.stLightState.value[i].set(l.level, l.captured ? 1 : 0, l.emitter, l.strength);
    });
    this.splat.updateVersion();
  }

  set(key, value) {
    this.params[key] = value;
    this.sync();
  }

  toggle(id, on) {
    const l = this.lights.find((x) => x.id === id);
    if (!l) return;
    l.on = on ?? !l.on;
    this.animating = true;
    return l.on;
  }

  // Smoothly fade lamps (a real bulb takes a moment to warm up / cool down).
  update(dt) {
    if (!this.animating) return;
    let moving = false;
    for (const l of this.lights) {
      const target = l.on ? 1 : 0;
      const rate = l.on ? 3.5 : 5;
      const next = l.level + Math.sign(target - l.level) * Math.min(Math.abs(target - l.level), dt * rate);
      if (next !== l.level) moving = true;
      l.level = next;
    }
    this.sync();
    this.animating = moving;
  }

  // Presets used by the UI's mood buttons.
  preset(name) {
    const P = {
      day: { exposure: 1, kelvin: 6500, saturation: 1, contrast: 1, ambient: 1 },
      golden: { exposure: 1.05, kelvin: 3900, saturation: 1.1, contrast: 1.04, ambient: 0.8 },
      evening: { exposure: 1.0, kelvin: 7200, saturation: 1.0, contrast: 1.06, ambient: 0.32 },
      night: { exposure: 1.1, kelvin: 11000, saturation: 0.92, contrast: 1.08, ambient: 0.07 },
    }[name];
    if (!P) return;
    Object.assign(this.params, P);
    this.sync();
  }
}
