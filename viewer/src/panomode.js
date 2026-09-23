// Baseline condition for the study: a conventional panorama tour.
// Each viewpoint is a static 360 image (from tour.json, or rendered from the
// splat at that node). Moving between viewpoints cross-fades with a small
// zoom, like commercial 360 tours, with no motion through space.
import * as THREE from "three";

const vert = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position = p.xyww;
  }
`;
const frag = /* glsl */ `
  uniform samplerCube mapA;
  uniform samplerCube mapB;
  uniform float mixAB;
  varying vec3 vDir;
  void main() {
    vec3 d = normalize(vDir);
    vec4 a = textureCube(mapA, d);
    vec4 b = textureCube(mapB, d);
    gl_FragColor = mix(a, b, mixAB);
    #include <colorspace_fragment>
  }
`;

export class PanoMode {
  constructor({ renderer, spark, scene, splat, hideObjects = [] }) {
    this.renderer = renderer;
    this.spark = spark;
    this.scene = scene;
    this.splat = splat;
    this.hideObjects = hideObjects;
    this.cache = new Map();
    this.active = false;
    this.material = new THREE.ShaderMaterial({
      uniforms: { mapA: { value: null }, mapB: { value: null }, mixAB: { value: 0 } },
      vertexShader: vert,
      fragmentShader: frag,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
    });
    this.sky = new THREE.Mesh(new THREE.BoxGeometry(10, 10, 10), this.material);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -100;
    this.sky.visible = false;
    scene.add(this.sky);
    this.fade = null;
    this.queue = Promise.resolve();
  }

  async cubeFor(node) {
    if (this.cache.has(node.id)) return this.cache.get(node.id);
    const p = (async () => {
      if (node.pano) {
        const tex = await new THREE.TextureLoader().loadAsync(node.pano);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.mapping = THREE.EquirectangularReflectionMapping;
        const rt = new THREE.WebGLCubeRenderTarget(1024);
        rt.fromEquirectangularTexture(this.renderer, tex);
        tex.dispose();
        return rt.texture;
      }
      // Cube renders toggle object visibility, so they must never overlap.
      const prev = this.queue;
      let release;
      this.queue = new Promise((r) => (release = r));
      await prev;
      try {
        this.splat.visible = true;
        const cube = await this.spark.renderCubeMap({
          scene: this.scene,
          worldCenter: node.position,
          size: 1024,
          near: 0.05,
          far: 200,
          hideObjects: [this.sky, ...this.hideObjects],
          update: true,
          filter: false,
        });
        // Spark reuses one shared cube target for every call, so copy it out.
        return this._copyCube(cube, 1024);
      } finally {
        this.splat.visible = !this.active;
        this.sky.visible = this.active;
        release();
      }
    })();
    this.cache.set(node.id, p);
    return p;
  }

  _copyCube(src, size) {
    const rt = new THREE.WebGLCubeRenderTarget(size, { colorSpace: THREE.SRGBColorSpace });
    const cam = new THREE.CubeCamera(0.1, 10, rt);
    const s = new THREE.Scene();
    const mat = new THREE.ShaderMaterial({
      uniforms: { mapA: { value: src }, mapB: { value: src }, mixAB: { value: 0 } },
      vertexShader: vert,
      fragmentShader: frag,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
    });
    const box = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), mat);
    s.add(box);
    cam.update(this.renderer, s);
    box.geometry.dispose();
    mat.dispose();
    return rt.texture;
  }

  async enter(node) {
    this.active = true;
    const cube = await this.cubeFor(node);
    this.material.uniforms.mapA.value = cube;
    this.material.uniforms.mapB.value = cube;
    this.material.uniforms.mixAB.value = 0;
    this.sky.visible = true;
    this.splat.visible = false;
  }

  exit() {
    this.active = false;
    this.sky.visible = false;
    this.splat.visible = true;
    this.fade = null;
  }

  // Cross-fade to another node. Resolves when the fade completes.
  async transition(to, look, duration = 0.9) {
    const cube = await this.cubeFor(to);
    this.material.uniforms.mapB.value = cube;
    this.material.uniforms.mixAB.value = 0;
    return new Promise((resolve) => {
      this.fade = { t: 0, duration, resolve, look, baseFov: look.fov };
    });
  }

  update(dt, rig) {
    if (!this.active) return;
    this.sky.position.copy(rig.position);
    const f = this.fade;
    if (!f) return;
    f.t = Math.min(1, f.t + dt / f.duration);
    const e = f.t * f.t * (3 - 2 * f.t);
    this.material.uniforms.mixAB.value = e;
    // conventional tours zoom in while fading, then snap back
    f.look.fovKick = -12 * Math.sin(Math.PI * Math.min(1, f.t * 1.1)) * (1 - f.t * 0.2);
    if (f.t >= 1) {
      this.material.uniforms.mapA.value = this.material.uniforms.mapB.value;
      this.material.uniforms.mixAB.value = 0;
      f.look.fovKick = 0;
      this.fade = null;
      f.resolve();
    }
  }

  // Warm the cache for neighbours so fades start instantly.
  prefetch(nodes) {
    for (const n of nodes) this.cubeFor(n);
  }
}
