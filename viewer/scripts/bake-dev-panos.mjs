// DEV ONLY: renders an equirectangular panorama at every capture point of a
// space's nav.json from its 3DGS scene, so the 360° viewer can be exercised
// before real 360 captures exist. These images must never be used for the
// study's 360° condition (docs/TERMS.md: 3DGS에서 뽑은 파노라마 금지 — 비교 불성립);
// nav.json keeps status.devPlaceholder = true while they are in use.
//   node scripts/bake-dev-panos.mjs <space> [scene=<space>] [width=2048]
// Needs the dev server (VIEWER_URL, default http://localhost:5190).
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const [space = "drjohnson", scene = space, width = "2048"] = process.argv.slice(2);
const base = process.env.VIEWER_URL || "http://localhost:5190";
const dir = path.resolve(import.meta.dirname, `../public/spaces/${space}`);
const nav = JSON.parse(fs.readFileSync(path.join(dir, "nav.json"), "utf8"));
if (!nav.status?.devPlaceholder) throw new Error("nav.json is not flagged devPlaceholder: refusing to overwrite real captures");
const out = path.join(dir, "pano-dev");
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await page.goto(`${base}/?scene=${scene}&onboarding=0&quality=full`);
await page.waitForFunction(() => window.splattour, null, { timeout: 240000 });
await page.waitForTimeout(1500);

for (const n of nav.nodes) {
  const url = await page.evaluate(async ({ pos, yawDeg, W }) => {
    const S = window.splattour, THREE = S.THREE, renderer = S.renderer;
    const scene = S.rig.parent;
    renderer.setAnimationLoop(null);
    const hide = scene.children.filter((o) => o !== S.spark && o !== S.splat);
    const cube = await S.spark.renderCubeMap({ scene, worldCenter: new THREE.Vector3(...pos), size: 1024, near: 0.05, far: 200, hideObjects: hide, update: true, filter: false });
    const mat = new THREE.ShaderMaterial({
      uniforms: { cube: { value: cube }, y0: { value: (yawDeg * Math.PI) / 180 } },
      vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
      fragmentShader: `uniform samplerCube cube; uniform float y0; varying vec2 vUv;
        void main(){ float lon = (vUv.x - 0.5) * 6.28318531; float lat = (vUv.y - 0.5) * 3.14159265; float yaw = y0 - lon;
          vec3 d = vec3(-sin(yaw) * cos(lat), sin(lat), -cos(yaw) * cos(lat));
          gl_FragColor = textureCube(cube, d);
          #include <colorspace_fragment>
        }`,
      depthTest: false, depthWrite: false,
    });
    const q = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    q.frustumCulled = false;
    const s = new THREE.Scene();
    s.add(q);
    const size = renderer.getSize(new THREE.Vector2());
    const pr = renderer.getPixelRatio();
    renderer.setPixelRatio(1);
    renderer.setSize(W, W / 2, false);
    renderer.render(s, new THREE.OrthographicCamera());
    const c = document.createElement("canvas");
    c.width = W; c.height = W / 2;
    c.getContext("2d").drawImage(renderer.domElement, 0, 0, W, W / 2);
    renderer.setPixelRatio(pr);
    renderer.setSize(size.x, size.y, false);
    mat.dispose(); q.geometry.dispose();
    return c.toDataURL("image/jpeg", 0.86);
  }, { pos: n.position, yawDeg: n.imageYawDeg || 0, W: +width });
  fs.writeFileSync(path.join(out, `${n.id}.jpg`), Buffer.from(url.split(",")[1], "base64"));
  process.stdout.write(`${n.id} `);
}
console.log(`\n${nav.nodes.length} dev panoramas -> ${out}`);
await browser.close();
