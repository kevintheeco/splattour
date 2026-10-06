import * as THREE from 'three';
import { LookControls } from './look.js';

const $ = (id) => document.getElementById(id);
const base = '/pano-additional/';
let manifest, current, visible = [], request = 0;
const canvas = $('view');

async function main() {
  const response = await fetch(base + 'manifest.json');
  if (!response.ok) throw new Error('사진 목록을 불러오지 못했습니다.');
  manifest = await response.json();
  const renderer = new THREE.WebGLRenderer({canvas, antialias: false});
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, .05, 100);
  const look = new LookControls(camera, canvas);
  const uniforms = { photo: {value: new THREE.DataTexture(new Uint8Array([20,24,22,255]),1,1)} };
  uniforms.photo.value.needsUpdate = true;
  const material = new THREE.ShaderMaterial({
    uniforms, side:THREE.BackSide, depthTest:false, depthWrite:false,
    vertexShader: 'varying vec3 dir; void main(){dir=position;vec4 p=projectionMatrix*modelViewMatrix*vec4(position,1.);gl_Position=p.xyww;}',
    fragmentShader: 'uniform sampler2D photo; varying vec3 dir; void main(){vec3 d=normalize(dir);float yaw=atan(-d.x,-d.z);vec2 uv=vec2(fract(.5-yaw/6.28318531),.5+asin(clamp(d.y,-1.,1.))/3.14159265);gl_FragColor=texture2D(photo,uv);\n#include <colorspace_fragment>\n}'
  });
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(40,40,40),material));
  function reset() { if(current){look.set((current.yaw||0)*Math.PI/180,-.12);look.targetFov=75;} }
  function updateUI() {
    const index=visible.findIndex(n=>n.id===current?.id);
    $('counter').textContent=index>=0 ? `${index+1} / ${visible.length}` : `— / ${visible.length}`;
    $('prev').disabled=index<=0;
    $('next').disabled=index<0 || index>=visible.length-1;
    for(const b of $('thumbs').children)b.setAttribute('aria-pressed',String(b.dataset.id===current?.id));
  }
  async function select(id) {
    const item=manifest.items.find(n=>n.id===id);if(!item)return;
    const token=++request;$('status').textContent=`${item.label} 불러오는 중…`;
    let texture;
    try {
      texture=await new THREE.TextureLoader().loadAsync(base+item.file);
      if(token!==request){texture.dispose();return;}
      const limit=Math.min(renderer.capabilities.maxTextureSize,matchMedia('(pointer:coarse)').matches?3072:8192);
      if(texture.image.width>limit){const c=document.createElement('canvas');c.width=limit;c.height=limit/2;c.getContext('2d').drawImage(texture.image,0,0,c.width,c.height);texture.image=c;}
      texture.colorSpace=THREE.SRGBColorSpace;texture.wrapS=THREE.RepeatWrapping;texture.minFilter=THREE.LinearFilter;texture.generateMipmaps=false;texture.needsUpdate=true;
      renderer.initTexture(texture);
      const old=uniforms.photo.value;uniforms.photo.value=texture;old.dispose();
      current=item;reset();$('title').textContent=item.label;$('status').textContent='';updateUI();
      document.querySelector(`[data-id="${id}"]`)?.scrollIntoView({block:'nearest',inline:'nearest'});
      const url=new URL(location.href);url.searchParams.set('photo',id);history.replaceState(null,'',url);
    }catch(error){texture?.dispose();if(token===request)$('status').textContent='사진을 불러오지 못했습니다. 목록에서 다시 선택해 주세요.';console.error(error);}
  }
  function list() {
    visible=manifest.items.filter(n=>!$('filter').value||n.group===$('filter').value);
    $('thumbs').replaceChildren();
    for(const item of visible){
      const b=document.createElement('button');b.className='thumb';b.dataset.id=item.id;b.setAttribute('aria-label',item.label);b.setAttribute('aria-pressed','false');
      const im=document.createElement('img');im.src=base+item.thumbnail;im.alt='';im.loading='lazy';
      const label=document.createElement('span');label.textContent=item.label;b.append(im,label);b.onclick=()=>select(item.id);$('thumbs').append(b);
    }
    updateUI();
  }
  for(const group of new Set(manifest.items.map(n=>n.group))){const o=document.createElement('option');o.value=o.textContent=group;$('filter').append(o);}
  $('filter').onchange=()=>{list();if(!visible.some(n=>n.id===current?.id))select(visible[0].id);};
  $('prev').onclick=()=>select(visible[visible.findIndex(n=>n.id===current?.id)-1]?.id);
  $('next').onclick=()=>select(visible[visible.findIndex(n=>n.id===current?.id)+1]?.id);
  $('reset').onclick=reset;
  $('toggle').onclick=()=>{const hidden=!$('gallery').hidden;$('gallery').hidden=hidden;$('toggle').setAttribute('aria-expanded',String(!hidden));$('toggle').textContent=hidden?'사진 목록 펼치기':'사진 목록 접기';};
  $('fullscreen').onclick=async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen();}catch{$('status').textContent='이 브라우저에서는 전체 화면을 지원하지 않습니다.';}};
  addEventListener('resize',()=>{renderer.setSize(innerWidth,innerHeight);camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();});
  let previous=performance.now();renderer.setAnimationLoop(now=>{look.update(Math.min((now-previous)/1000,.1));previous=now;renderer.render(scene,camera);});
  list();
  const requested=new URLSearchParams(location.search).get('photo');
  await select(manifest.items.some(n=>n.id===requested)?requested:manifest.start);
  window.additionalPano={select,look,get current(){return current;},count:manifest.items.length};
}
main().catch(error=>{$('status').textContent=error.message;console.error(error);});
