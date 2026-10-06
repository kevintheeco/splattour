import {createTransitionEditor} from './transition-editor.js';
import {imageYawForAnchor,panoramaUForHeading,mapYawToward} from './pano-calibration.js';
const $=s=>document.querySelector(s), NS='http://www.w3.org/2000/svg';
let KEY=new URLSearchParams(location.search).get('layout')==='assigned'?'wolhajeong-map-editor-assigned-v1':'wolhajeong-map-editor-v1';
const original=await fetch('/spaces/wolhajeong/nav.pano.json').then(r=>{if(!r.ok)throw Error('지도 데이터를 불러오지 못했어요');return r.json()});
if(original.editorRevision) KEY+='-'+original.editorRevision;
const catalog=await fetch('/pano-additional/manifest.json').then(r=>{if(!r.ok)throw Error('사진 목록을 불러오지 못했어요');return r.json()}).then(m=>m.items);
function sourceOf(n){if(!n)return null;return n.pano?n:original.nodes.find(p=>p.id===n.id)||null}
function captureOf(n){const src=sourceOf(n);return catalog.find(c=>c.id===src?.photoAssignmentId||c.number===src?.captureNumber)}
function previewLink(n){const c=captureOf(n);return c?`/pano-additional.html?photo=${encodeURIComponent(c.id)}`:`/pano.html?space=wolhajeong&node=${encodeURIComponent(n.id)}`}
const excludedIds = ["p067", "p068", "p078", "p100", ...(original.excludedPointIds || [])];
original.nodes = original.nodes.filter(n => !excludedIds.includes(n.id));
for (const n of original.nodes) n.neighbors = n.neighbors.filter(id => !excludedIds.includes(id));
$('#reset').textContent=`현재 ${original.nodes.length}개 배치 복원`;
const initial=()=>({version:1,kind:'panorama-map-edit',excludedIds,referenceSize:[1952,1277],nodes:original.nodes.map(n=>({...n,mapPosition:n.mapPosition||[n.position[0]*100+1000,n.position[2]*100+740],heading:n.startYawDeg||0})),edges:structuredClone(original.editorEdges||[...new Map(original.nodes.flatMap(n=>n.neighbors.map(id=>[n.id,id].sort())).map(e=>[JSON.stringify(e),e])).values()]),...(original.transitions?{transitions:structuredClone(original.transitions)}:{})});
let model=initial(),selected=null,mode='move',connectFrom=null,zoom=1,undo=[];
function validate(m){if(m?.kind!=='panorama-map-edit'||m.version!==1||!Array.isArray(m.nodes)||m.nodes.length>500||!Array.isArray(m.edges)||m.edges.length>5000)throw Error('지원하지 않는 편집 파일입니다.');const ids=new Set();for(const n of m.nodes){if(typeof n.id!=='string'||ids.has(n.id)||typeof n.label!=='string'||typeof n.room!=='string'||!Array.isArray(n.mapPosition)||n.mapPosition.length!==2||!n.mapPosition.every(Number.isFinite)||n.mapPosition[0]<0||n.mapPosition[0]>1952||n.mapPosition[1]<0||n.mapPosition[1]>1277||!Number.isFinite(n.heading))throw Error('시점 정보가 올바르지 않습니다.');ids.add(n.id)}for(const e of m.edges)if(!Array.isArray(e)||e.length!==2||e[0]===e[1]||!e.every(id=>ids.has(id)))throw Error('연결 정보가 올바르지 않습니다.');if(m.transitions!=null){if(!Array.isArray(m.transitions)||m.transitions.length>10000)throw Error('이동 설정이 올바르지 않습니다.');const keys=new Set();for(const t of m.transitions){const key=JSON.stringify([t.from,t.to]);if(!ids.has(t.from)||!ids.has(t.to)||t.from===t.to||keys.has(key)||typeof t.label!=='string'||typeof t.enabled!=='boolean'||typeof t.preserveHeading!=='boolean'||!['yawDeg','pitchDeg','arrowRotationDeg','arrivalYawDeg','arrivalPitchDeg'].every(k=>Number.isFinite(t[k])&&Math.abs(t[k])<=(k.toLowerCase().includes('pitch')?85:180)))throw Error('이동 방향 설정이 올바르지 않습니다.');keys.add(key)}}return m}
try{const saved=localStorage.getItem(KEY);if(saved)model=validate(JSON.parse(saved))}catch{ /* keep original on invalid local storage */ }
// Apply requested arrow restorations once without replacing the user's draft.
let restoredTransitions=false;
for(const change of original.editorTransitionRestorations||[]){
 model.appliedTransitionRestorations ||= [];
 if(model.appliedTransitionRestorations.includes(change.revision))continue;
 if(![change.from,change.to].every(id=>model.nodes.some(n=>n.id===id)))continue;
 model.transitions ||= [];
 const existing=model.transitions.find(t=>t.from===change.from&&t.to===change.to);
 const source=original.transitions?.find(t=>t.from===change.from&&t.to===change.to);
 if(existing)existing.enabled=true;
 else if(source)model.transitions.push({...source,enabled:true});
 else continue;
 if(!model.edges.some(e=>e.includes(change.from)&&e.includes(change.to)))model.edges.push([change.from,change.to]);
 model.appliedTransitionRestorations.push(change.revision);restoredTransitions=true;
}
if(restoredTransitions){try{localStorage.setItem(KEY,JSON.stringify(model))}catch{ /* regular save reports storage errors */ }}
// Restore explicitly requested points once, preserving other local edits.
for (const change of original.editorRestorations || []) {
  model.appliedRestorations ||= [];
  if (model.appliedRestorations.includes(change.revision)) continue;
  const n = original.nodes.find(n => n.id === change.node);
  if (n && !model.nodes.some(p => p.id === n.id)) model.nodes.push({...n, heading:n.startYawDeg || 0});
  for (const edge of change.removeEdges || []) model.edges = model.edges.filter(e => !(e.includes(edge[0]) && e.includes(edge[1])));
  for (const id of n?.neighbors || []) if (model.nodes.some(p => p.id === id) && !model.edges.some(e => e.includes(id) && e.includes(n.id))) model.edges.push([n.id,id]);
  model.appliedRestorations.push(change.revision);
}
function status(t,error=false){$('#status').textContent=t;$('#status').classList.toggle('error',error)}
function save(){try{localStorage.setItem(KEY,JSON.stringify(model));status('이 브라우저에 저장됨 · 실제 투어에는 미적용')}catch{status('자동 저장 실패 — 편집본 저장 버튼으로 파일을 받아 주세요.',true)}}
function checkpoint(){undo.push(JSON.stringify(model));if(undo.length>50)undo.shift()}
function element(tag,attrs){const el=document.createElementNS(NS,tag);for(const [k,v]of Object.entries(attrs))el.setAttribute(k,v);return el}
function node(){return model.nodes.find(n=>n.id===selected)}
function renderMap(){const svg=$('#overlay');svg.replaceChildren();const by=new Map(model.nodes.map(n=>[n.id,n]));if($('#lines').checked)for(const [a,b]of model.edges){const p=by.get(a)?.mapPosition,q=by.get(b)?.mapPosition;if(p&&q)svg.append(element('line',{x1:p[0],y1:p[1],x2:q[0],y2:q[1],stroke:'#7aa7e7','stroke-width':4,'pointer-events':'none'}))}for(const [i,n]of model.nodes.entries()){const [x,y]=n.mapPosition,on=n.id===selected;const yaw=n.heading*Math.PI/180;if(on){svg.append(element('path',{d:`M ${x} ${y} L ${x-Math.sin(yaw-.38)*85} ${y-Math.cos(yaw-.38)*85} L ${x-Math.sin(yaw+.38)*85} ${y-Math.cos(yaw+.38)*85} Z`,fill:'#3b82f644'}))}const g=element('g',{'data-id':n.id});const c=element('circle',{cx:x,cy:y,r:on?14:10,fill:n.id===connectFrom?'#f59e0b':on?'#2563eb':'white',stroke:'#2563eb','stroke-width':4,tabindex:0,role:'button','aria-label':n.label});c.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();select(n.id)}});g.append(c);const t=element('text',{x:x+17,y:y-15});t.textContent=(n.pointNumber||n.captureNumber)?String(n.pointNumber||n.captureNumber).padStart(3,'0'):String(i+1);g.append(t);svg.append(g)}}
function select(id){selected=id;render()}
function render(){const removedIds=new Set(model.nodes.filter(n=>excludedIds.includes(n.id)).map(n=>n.id));model.nodes=model.nodes.filter(n=>!excludedIds.includes(n.id));model.edges=model.edges.filter(e=>!e.some(id=>excludedIds.includes(id)));model.excludedIds=excludedIds;for(const [a,b] of Object.entries(original.editorRemovalBridges||{p077:original.editorBridgeEdges||[]}).filter(([id])=>removedIds.has(id)).flatMap(([,edges])=>edges)){if(model.nodes.some(n=>n.id===a)&&model.nodes.some(n=>n.id===b)&&!model.edges.some(e=>e.includes(a)&&e.includes(b)))model.edges.push([a,b]);}if(!model.nodes.some(n=>n.id===selected))selected=model.nodes[0]?.id||null;renderMap();const n=node();updatePhoto(n);$('#empty').hidden=!!n;$('#details').hidden=!n;$('#count').textContent=`(${model.nodes.length})`;$('#undo').disabled=!undo.length;if(n){$('#name').value=n.label;$('#room').value=n.room;$('#angle').value=n.heading;$('#angleLabel').textContent=`${Math.round(n.heading)}°`;const orig=sourceOf(n);$('#preview').hidden=!orig?.thumbnail;if(orig?.thumbnail)$('#preview').src=orig.thumbnail;$('#viewPano').hidden=!orig;$('#viewPano').href=previewLink(n);$('#pointInfo').textContent=orig?`시점 ${n.pointNumber||n.captureNumber} / 연결 사진 ${orig.captureNumber} · 점을 옮겨 촬영 위치를 지정하세요.`:'새로 표시한 희망 시점 · 연결할 촬영 사진은 아직 없습니다.'}$('#list').replaceChildren();for(const n of model.nodes){const b=document.createElement('button');b.classList.toggle('selected',n.id===selected);const orig=sourceOf(n);if(orig?.thumbnail){const im=document.createElement('img');im.src=orig.thumbnail;im.alt='';im.loading='lazy';b.append(im)}const t=document.createElement('span');t.textContent=`시점 ${n.pointNumber||n.captureNumber||'새 시점'} · ${n.label}${orig ? ' / 사진 #'+orig.captureNumber : ' / 사진 미배정'}`;b.append(t);b.onclick=()=>select(n.id);$('#list').append(b)}renderPhotoChoices();transitionEditor.render()}
function coords(e){const r=$('#overlay').getBoundingClientRect();return [Math.max(0,Math.min(1952,(e.clientX-r.left)/r.width*1952)),Math.max(0,Math.min(1277,(e.clientY-r.top)/r.height*1277))]}
let drag=null;
$('#overlay').addEventListener('pointerdown',e=>{if(e.button!==0)return;const id=e.target.closest('[data-id]')?.dataset.id;if(mode==='heading'&&node()){if(id&&id!==selected){select(id);return}const target=coords(e),n=node();if(Math.hypot(target[0]-n.mapPosition[0],target[1]-n.mapPosition[1])>3){checkpoint();anchor(n);n.heading=mapYawToward(n.mapPosition,target);calibrate(n);save();render()}return}if(mode==='add'&&!id){checkpoint();const id=crypto.randomUUID();model.nodes.push({id,label:`새 시점 ${model.nodes.filter(n=>!n.pano).length+1}`,room:'unassigned',mapPosition:coords(e),heading:0,neighbors:[]});select(id);save();return}if(!id){connectFrom=null;renderMap();return}if(mode==='connect'){if(!connectFrom){connectFrom=id;selected=id;render()}else if(connectFrom!==id){checkpoint();const i=model.edges.findIndex(e=>e.includes(id)&&e.includes(connectFrom));if(i>=0)model.edges.splice(i,1);else model.edges.push([connectFrom,id]);connectFrom=null;select(id);save()}return}checkpoint();selected=id;drag={id,pointer:e.pointerId};$('#overlay').setPointerCapture(e.pointerId);render()});
$('#overlay').addEventListener('pointermove',e=>{if(!drag||e.pointerId!==drag.pointer)return;const n=model.nodes.find(n=>n.id===drag.id);n.mapPosition=coords(e).map(x=>Math.round(x));renderMap()});
function endDrag(){if(drag){drag=null;save();render()}}$('#overlay').addEventListener('pointerup',endDrag);$('#overlay').addEventListener('pointercancel',endDrag);
for(const b of document.querySelectorAll('[data-mode]'))b.onclick=()=>{mode=b.dataset.mode;connectFrom=null;document.querySelectorAll('[data-mode]').forEach(x=>x.classList.toggle('active',x===b));$('#hint').textContent=mode==='heading'?'선택한 점에서 바라볼 방향을 지도 위에서 클릭하세요. 사진의 파란 구간과 이 방향이 연결됩니다.':mode==='add'?'지도 빈 곳을 클릭하면 새 시점이 추가됩니다.':mode==='connect'?'두 점을 차례로 클릭하면 연결됩니다. 같은 두 점을 다시 연결하면 연결선이 지워집니다.':'점을 드래그해 옮기세요. 목록에서 사진을 보고 선택할 수도 있어요.';renderMap()};
for(const [id,key]of [['name','label'],['room','room']])$('#'+id).addEventListener('change',e=>{const n=node();if(!n)return;checkpoint();n[key]=key==='heading'?Number(e.target.value):e.target.value.trim()||'이름 없는 시점';save();render()});

$('#delete').onclick=()=>{if(!node())return;checkpoint();model.nodes=model.nodes.filter(n=>n.id!==selected);model.edges=model.edges.filter(e=>!e.includes(selected));selected=null;save();render()};
$('#undo').onclick=()=>{if(!undo.length)return;model=JSON.parse(undo.pop());selected=null;save();render()};
$('#blank').onclick=()=>{checkpoint();model.nodes=[];model.edges=[];selected=null;save();render()};$('#reset').onclick=()=>{checkpoint();model=initial();selected=null;save();render()};$('#lines').onchange=renderMap;
function scale(d){zoom=Math.max(1,Math.min(3,zoom+d));$('#stage').style.width=`${zoom*100}%`;$('#zoomLabel').textContent=`${Math.round(zoom*100)}%`}$('#plus').onclick=()=>scale(.25);$('#minus').onclick=()=>scale(-.25);
function download(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000)}
$('#export').onclick=()=>download(new Blob([JSON.stringify({...model,editedAt:new Date().toISOString()},null,2)],{type:'application/json'}),'wolhajeong-viewpoints.json');
$('#import').onclick=()=>$('#file').click();$('#file').onchange=async e=>{try{const file=e.target.files[0];if(!file)return;if(file.size>5e6)throw Error('파일이 너무 큽니다.');const next=validate(JSON.parse(await file.text()));checkpoint();model=next;selected=null;save();render()}catch(err){status(err.message,true)}finally{e.target.value=''}};
$('#png').onclick=async()=>{try{await $('#map').decode();const c=document.createElement('canvas');c.width=1952;c.height=1277;const g=c.getContext('2d');g.drawImage($('#map'),0,0,c.width,c.height);const svg=$('#overlay').cloneNode(true);svg.setAttribute('xmlns',NS);svg.setAttribute('width',1952);svg.setAttribute('height',1277);const url=URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)],{type:'image/svg+xml'}));try{const im=new Image();im.src=url;await im.decode();g.drawImage(im,0,0)}finally{URL.revokeObjectURL(url)}c.toBlob(b=>{if(b)download(b,'wolhajeong-viewpoints.png')})}catch{status('이미지 저장에 실패했습니다. 다시 시도해 주세요.',true)}};


function photoUrl(n){const source=sourceOf(n);return source?.pano?new URL(source.pano,new URL('/spaces/wolhajeong/',location.href)).href:null}
let shownPhotoId=null;
function updatePhoto(n){
 const source=sourceOf(n),url=photoUrl(n);
 document.body.classList.toggle('has-photo',!!n);$('#photoCard').hidden=!n;if(!n)return;
 $('#photoTitle').textContent=`시점 ${source?.pointNumber||n.pointNumber||n.captureNumber||'새 시점'} · ${source?.label||n.label}`;
 $('#photoMeta').textContent=source?`배정 사진 #${source.captureNumber} · ${source.sourceFile}`:'사진 미배정';
 $('#photoEmpty').hidden=!!url;$('#enlargePhoto').disabled=!url;$('#inline360').disabled=!url;
 if(shownPhotoId!==n.id+'|'+url){shownPhotoId=n.id+'|'+url;$('#panoFrame').hidden=true;$('#panoFrame').removeAttribute('src');$('#assignedPhoto').hidden=!url;if(url)$('#assignedPhoto').src=url;}
 renderCalibration(n,!!url);
 if(source){for(const key of ['pano','thumbnail','captureNumber','sourceFile','sourceCaptureId','pointNumber'])if(source[key]!==undefined)n[key]=source[key];}
}
$('#enlargePhoto').onclick=()=>{const n=node(),url=photoUrl(n);if(!url)return;$('#largeTitle').textContent=$('#photoTitle').textContent+' / '+$('#photoMeta').textContent;$('#largePhoto').src=url;$('#photoDialog').showModal()};
$('#preview').onclick=()=>$('#enlargePhoto').click();
$('#closePhoto').onclick=()=>$('#photoDialog').close();
$('#inline360').onclick=()=>{const n=node();if(!photoUrl(n))return;$('#panoFrame').hidden=false;$('#panoFrame').src=previewLink(n);};



function anchor(n){if(!Number.isFinite(n.panoramaCenterU))n.panoramaCenterU=panoramaUForHeading(n.imageYawDeg||0,n.heading);}
function calibrate(n){anchor(n);n.imageYawDeg=imageYawForAnchor(n.heading,n.panoramaCenterU);n.startYawDeg=n.heading;n.headingCalibration={mapYawDeg:n.heading,panoramaU:n.panoramaCenterU};renderMap();renderCalibration(n,true);$('#angle').value=n.heading;$('#angleLabel').textContent=`${Math.round(n.heading)}°`;syncFrame();}
function renderCalibration(n,visible){
 $('#photoSurface').hidden=!visible;$('#calibrationControls').hidden=!visible;$('#calibrationHelp').hidden=!visible;
 if(!visible)return;anchor(n);const im=$('#assignedPhoto');const ratio=im.naturalWidth&&im.naturalHeight?im.naturalWidth/im.naturalHeight:2;const width=100*(9/16)/ratio;const centre=n.panoramaCenterU*100,left=centre-width/2;
 $('#panoWindow').style.width=$('#panoWindowWrap').style.width=`${width}%`;
 $('#panoWindow').style.left=`${left}%`;const wrap=left<0?left+100:left+width>100?left-100:null;
 $('#panoWindowWrap').hidden=wrap===null;if(wrap!==null)$('#panoWindowWrap').style.left=`${wrap}%`;
 $('#panoPosition').value=Math.round(n.panoramaCenterU*1000);
 $('#calibrationState').textContent=`파란 구간의 중심 ↔ 지도 방향 ${Math.round(n.heading)}°${n.headingCalibration?' · 방향 보정 설정됨':''}`;
}
$('#assignedPhoto').addEventListener('load',()=>{if(node())renderCalibration(node(),true)});
let photoDragging=false;
function moveWindow(e){const n=node();if(!n||!photoUrl(n))return;const r=$('#photoSurface').getBoundingClientRect();n.panoramaCenterU=Math.max(0,Math.min(.999999,(e.clientX-r.left)/r.width));calibrate(n);}
$('#photoSurface').addEventListener('pointerdown',e=>{if(e.button!==0||!photoUrl(node()))return;e.preventDefault();checkpoint();photoDragging=true;e.currentTarget.setPointerCapture(e.pointerId);moveWindow(e)});
$('#photoSurface').addEventListener('pointermove',e=>{if(photoDragging)moveWindow(e)});
for(const name of ['pointerup','pointercancel'])$('#photoSurface').addEventListener(name,()=>{if(photoDragging){photoDragging=false;save();$('#undo').disabled=false}});
for(const id of ['panoPosition','angle']){
 const el=$('#'+id);el.addEventListener('pointerdown',()=>{if(node()){checkpoint();anchor(node())}});el.addEventListener('keydown',e=>{if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(e.key)&&node()){checkpoint();anchor(node())}});
 el.addEventListener('input',()=>{const n=node();if(!n)return;anchor(n);if(id==='angle')n.heading=Number(el.value);else n.panoramaCenterU=Number(el.value)/1000;calibrate(n)});
 el.addEventListener('change',()=>{save();$('#undo').disabled=false});
}
function syncFrame(){const frame=$('#panoFrame'),n=node();if(frame.hidden||!n)return;try{const a=frame.contentWindow.additionalPano;if(a){if(a.current.id===captureOf(n)?.id)a.look.set((.5-n.panoramaCenterU)*Math.PI*2,-.12);return}const p=frame.contentWindow.pano360;if(!p||p.current.id!==n.id)return;const offset=n.imageYawDeg*Math.PI/180;p.U.yawA.value=p.U.yawB.value=offset;p.look.set(n.heading*Math.PI/180,-.12);}catch{}}
$('#panoFrame').addEventListener('load',()=>{let attempts=0;const t=setInterval(()=>{syncFrame();if(++attempts>30||$('#panoFrame').contentWindow?.pano360||$('#panoFrame').contentWindow?.additionalPano)clearInterval(t)},150)});
function assignPhoto(c){
 const n=node();if(!n||captureOf(n)?.id===c.id)return;checkpoint();
 const src=original.nodes.find(p=>p.captureNumber===c.number);
 for(const k of ['exposure','colorBalance','highlightPreservation','headingCalibration'])delete n[k];
 Object.assign(n,{photoAssignmentId:c.id,pano:'/pano-additional/'+c.file,thumbnail:'/pano-additional/'+c.thumbnail,captureNumber:c.number,sourceFile:c.original,sourceCaptureId:c.id});
 n.panoramaCenterU=.5;n.imageYawDeg=imageYawForAnchor(n.heading,.5);n.startYawDeg=n.heading;
 for(const k of ['exposure','colorBalance','highlightPreservation'])if(src?.[k]!==undefined)n[k]=src[k];
 save();render();status(`시점 ${n.pointNumber||n.label}에 사진 #${c.number} 배정 · 파란 구간으로 방향을 맞춰 주세요.`);
}
function renderPhotoChoices(){
 const query=$('#photoSearch').value.trim().toLowerCase(), group=$('#photoGroup').value;
 const items=catalog.filter(c=>(!group||c.group===group)&&(!query||`${c.number} ${c.original} ${c.label}`.toLowerCase().includes(query)));
 $('#photoChoiceCount').textContent=`${items.length} / ${catalog.length}장`;$('#photoChoices').replaceChildren();
 for(const c of items){
  const b=document.createElement('button');b.type='button';b.dataset.photo=c.id;b.disabled=!node();b.setAttribute('aria-label',`사진 ${c.number} 배정`);b.setAttribute('aria-pressed',String(captureOf(node())?.id===c.id));
  const im=document.createElement('img');im.src='/pano-additional/'+c.thumbnail;im.alt='';im.loading='lazy';
  const label=document.createElement('span');const uses=model.nodes.filter(n=>captureOf(n)?.id===c.id).map(n=>n.pointNumber||n.label);
  label.textContent=`#${c.number} · ${c.group}${uses.length?' / 선택됨 — 시점 '+uses.join(', ')+'에서 사용 중':' / 미사용 · 선택 가능'}${captureOf(node())?.id===c.id?' / 현재 시점의 사진':''}`;b.title=c.original;b.append(im,label);b.onclick=()=>assignPhoto(c);$('#photoChoices').append(b);
 }
}
for(const group of new Set(catalog.map(c=>c.group))){const o=document.createElement('option');o.value=o.textContent=group;$('#photoGroup').append(o)}
$('#photoSearch').oninput=renderPhotoChoices;$('#photoGroup').onchange=renderPhotoChoices;
const transitionEditor=createTransitionEditor({getModel:()=>model,getNode:node,checkpoint,save,photoUrl,base:original,onChange:renderMap});
selected=new URLSearchParams(location.search).get('point')||model.nodes[0]?.id||null;render();status('점 선택 → 아래에서 배정 사진 확인 · 브라우저 자동 저장');
