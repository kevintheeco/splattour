import {wrapDegrees,mapYawToward} from './pano-calibration.js';
export function defaultTransition(from,to,hotspot={}) {
 return {from:from.id,to:to.id,enabled:true,label:hotspot.label||to.label,
 yawDeg:hotspot.yawDeg??wrapDegrees(mapYawToward(from.mapPosition,to.mapPosition)-(from.imageYawDeg||0)),
 pitchDeg:hotspot.pitchDeg??-30,arrowRotationDeg:hotspot.arrowRotationDeg??0,
 preserveHeading:hotspot.arrivalYawDeg==null,arrivalYawDeg:hotspot.arrivalYawDeg??to.heading??0,arrivalPitchDeg:hotspot.arrivalPitchDeg??-12};
}
export function ensureTransitions(model) {
 const by=new Map(model.nodes.map(n=>[n.id,n]));model.transitions ||= [];
 model.transitions=model.transitions.filter(t=>by.has(t.from)&&by.has(t.to)&&model.edges.some(e=>e.includes(t.from)&&e.includes(t.to)));
 for(const [a,b]of model.edges)for(const [from,to]of [[a,b],[b,a]])if(by.has(from)&&by.has(to)&&!model.transitions.some(t=>t.from===from&&t.to===to))model.transitions.push(defaultTransition(by.get(from),by.get(to),by.get(from).hotspots?.find(h=>h.to===to)));
 return model.transitions;
}
export function compileEditorNav(model,base){
 const transitions=ensureTransitions(model);const nav={...base,nodes:model.nodes.map(n=>({...n,position:[(n.mapPosition[0]-1000)/100,1.5,(n.mapPosition[1]-740)/100],startYawDeg:n.heading,neighbors:[],hotspots:[]}))};
 const by=new Map(nav.nodes.map(n=>[n.id,n]));
 for(const t of transitions){if(t.enabled===false)continue;const n=by.get(t.from);n.neighbors.push(t.to);n.hotspots.push({to:t.to,label:t.label,yawDeg:t.yawDeg,pitchDeg:t.pitchDeg,arrowRotationDeg:t.arrowRotationDeg,...(!t.preserveHeading?{arrivalYawDeg:t.arrivalYawDeg,arrivalPitchDeg:t.arrivalPitchDeg}:{})});}
 nav.directed=true;nav.start=by.has(base.start)?base.start:nav.nodes[0]?.id;return nav;
}
