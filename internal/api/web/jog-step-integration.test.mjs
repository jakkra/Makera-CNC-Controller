import test from 'node:test';
import assert from 'node:assert/strict';
import {createSurfaceJogFeature, defaultSurfaceViewPreferences, surfaceZStepFeed} from './modules/surface-jog.js';
import {createSurfaceControls} from './modules/surface-controls.js';
import {createSurfaceActions} from './modules/surface-actions.js';
import {createJogFeature} from './modules/jog.js';
import {bindButtonAction} from './modules/dom.js';
import {createFeatureStatePorts} from './modules/feature-state-ports.js';

function fixture() {
 const node=(dataset={})=>({dataset,value:'',handlers:{},classList:{toggle(){}},style:{setProperty(){}},
  addEventListener(name,fn){this.handlers[name]=fn},contains(target){return target===this},setAttribute(name,v){this[name]=v},toggleAttribute(){},setPointerCapture(){}});
 const ids=new Map(); const chips=[10,1,0.1,0.01].map(step=>node({surfaceStep:String(step)}));
 const zButton=node({surfaceZSign:"1"});
 const axis=node({surfaceAxis:'x',surfaceSign:'1'});
 let releaseTarget=null;
 const documentRef={activeElement:null,elementFromPoint:()=>releaseTarget,getElementById(id){if(!ids.has(id))ids.set(id,node());return ids.get(id)},
  querySelectorAll(q){if(q==='[data-surface-step]')return chips;if(q==='[data-surface-z-sign]')return [zButton];if(q.includes('[data-surface-axis]'))return [axis];return []}};
 const wire=[];const saved=[];
 const state={surface:{...defaultSurfaceViewPreferences(),step_mm:10},machine:{state:'Idle',connected:true},
  jog:{caps:{enabled:true,max_z_step_mm_min:900},link:'online',armed:true,seq:1,sent:new Map(),surfaceStepPending:0,
   surfaceWheel:{pointerId:null,value:0,angle:0},ws:{readyState:1,send:raw=>wire.push(JSON.parse(raw))}}};
 const ports=createFeatureStatePorts(state);
 const feature=createSurfaceJogFeature({stateFacade:ports.surfaceJog,documentRef,windowRef:{matchMedia:()=>({matches:false})},
  saveSurfaceViewPreferences:()=>saved.push({...state.surface})});
 const jog=createJogFeature({jogState:state.jog,surfaceState:state.surface,documentRef,windowRef:{},WebSocketCtor:{OPEN:1},performanceRef:{now:()=>0}});
 const actions=createSurfaceActions({request:async()=>{},getJog:()=>state.jog,
  surfaceJogBaseReady:feature.surfaceJogBaseReady,surfaceStepDistance:feature.surfaceStepDistance,
  getZStepFeed:()=>surfaceZStepFeed(state.surface,state.jog.caps),sendJog:jog.sendJog,renderJog:feature.renderSurfaceJog});
 const controls=createSurfaceControls({state:ports.surfaceControls,documentRef,callbacks:{
  ...feature,...actions,bindButtonAction:(button,fn)=>bindButtonAction(button,fn,{documentRef,performanceRef:{now:()=>1000}}),bindSurfaceMPGWheel:()=>{},
  applySurfaceAutomaticView:()=>{},saveSurfaceViewPreferences:()=>{},normalizeMachineSettings:v=>v,clampNumber:v=>v}});
 controls.init(); feature.renderSurfaceJog();
 const clickStep=()=>{axis.handlers.pointerdown({button:0,pointerId:1,preventDefault(){}});axis.handlers.pointerup({pointerId:1});state.jog.surfaceStepPending=0};
 const touch=(button)=>{
  releaseTarget=button;
  const event={button:0,pointerId:2,clientX:100,clientY:200,preventDefault(){},stopPropagation(){}};
  button.handlers.pointerdown?.(event);button.handlers.pointerup?.(event);
 };
 const click=(button)=>{const e={preventDefault(){},stopPropagation(){}};button.onclick?.(e);button.handlers.click?.(e)};
 return {state,feature,ids,chips,wire,saved,clickStep,touch,click,zButton};
}

test('native increment selection survives live updates and changes the next jog frame',()=>{
 const f=fixture();const select=f.ids.get('surface-jog-step');
 f.clickStep();
 for(const step of [1,0.1,0.01,10]) {
  // Native touch pickers need not keep the underlying select as activeElement.
  select.value=String(step);
  f.state.machine={...f.state.machine,age_ms:0};
  f.feature.renderSurfaceJog();
  select.onchange({target:select});
  f.clickStep();
  assert.equal(f.wire.at(-1).distance,step,'next WebSocket step must use the committed increment');
  assert.equal(f.saved.at(-1).step_mm,step);
 }
 assert.deepEqual(f.wire.map(v=>v.distance),[10,1,0.1,0.01,10]);
});

test('quick increment buttons use the same current step after live renders',()=>{
 const f=fixture();
 for(const chip of f.chips) {
  f.click(chip);f.feature.renderSurfaceJog();f.clickStep();
  assert.equal(f.wire.at(-1).distance,Number(chip.dataset.surfaceStep));
 }
});

test('kiosk step buttons accept touch release without a synthesized click',()=>{
 const f=fixture();
 for(const step of [1,0.1,0.01,10]) {
  const chip=f.chips.find(b=>Number(b.dataset.surfaceStep)===step);
  f.touch(chip);
  f.feature.renderSurfaceJog();
  f.clickStep();
  assert.equal(f.wire.at(-1).distance,step,'touch-selected increment must reach the next jog frame');
 }
});

test('touch followed by synthesized click commits the selection only once',()=>{
 const f=fixture();const chip=f.chips.find(b=>b.dataset.surfaceStep==='0.1');
 f.touch(chip);f.click(chip);
 assert.equal(f.saved.length,1);
 assert.equal(f.state.surface.step_mm,0.1);
});

test("Z step speed selection reaches the Z button's WebSocket payload", () => {
  const f = fixture();
  const select = f.ids.get("surface-z-step-feed");
  select.value = "900";
  select.onchange();
  f.touch(f.zButton);
  const { type, axis, distance, feed_mm_min } = f.wire.at(-1);
  assert.deepEqual({ type, axis, distance, feed_mm_min }, { type: "step", axis: "z", distance: 10, feed_mm_min: 900 });
  f.state.jog.surfaceStepPending = 0;
  f.clickStep();
  assert.equal(f.wire.at(-1).feed_mm_min, undefined);
});
