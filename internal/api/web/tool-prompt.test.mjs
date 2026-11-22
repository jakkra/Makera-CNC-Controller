import test from 'node:test';
import assert from 'node:assert/strict';
import { createMachineStatusFeature } from './modules/machine-status.js';
import { toolDisplayName } from './modules/tooling.js';
import { mountActiveJobLoader } from './modules/active-job.js';
import { mountFilesTransitions } from './modules/files.js';
import { createLiveUpdates } from './modules/live-updates.js';

test('tool prompt receives metadata when the active file becomes cached during a preview request', async () => {
  const path = '/sd/gcodes/current.nc';
  const machine = { connected: true, stale: false, state: 'Tool', tool: { target: 1 } };
  const nodes = new Map(['attention-tool', 'attention-tool-number', 'attention-tool-name', 'attention-tool-spec'].map(id => [id, { hidden: true, textContent: '' }]));
  let active = { path };
  let loading = false;
  let finishFirstResponse;
  let requests = 0;
  const metadata = { number: 1, name: 'Makera Metal - 3.175*10mm', diameter_mm: 3.175, kind: 'ball end mill' };
  const status = createMachineStatusFeature({
    documentRef: { getElementById: id => nodes.get(id) || null },
    getActiveGcode: () => active,
    toolDisplayName,
  });
  const loader = mountActiveJobLoader({
    request: async () => {
      requests++;
      return { json: () => requests === 1
        ? new Promise(resolve => { finishFirstResponse = resolve; })
        : { path, preview: { tool_metadata: [metadata] } } };
    },
    getActiveGcodeLoading: () => loading,
    setActiveGcodeLoading: value => { loading = value; },
    setActiveGcode: value => { active = value; },
    clearConnectivityIssue: () => {},
    setConnectivityIssue: (...args) => assert.fail(JSON.stringify(args)),
    renderActiveGcode: () => {},
    getMachine: () => machine,
    renderAttention: status.renderAttention,
  });
  const files = new Map();
  const transitions = mountFilesTransitions({
    getFiles: () => files,
    isActiveGcodePath: value => value === active.path,
    loadActiveGcode: loader.loadActiveGcode,
    renderMachine: () => status.renderAttention(machine),
    renderFiles: () => {},
  });
  const first = loader.loadActiveGcode();
  await Promise.resolve();
  status.renderAttention(machine);
  assert.equal(nodes.get('attention-tool-number').textContent, 'T1');
  transitions.applyEntry({ path, sync: 'synced', cache_state: 'ready' });
  transitions.applyEntry({ path, sync: 'synced', cache_state: 'ready' });
  assert.equal(requests, 1, 'file events must not start overlapping requests');
  finishFirstResponse({ path });
  await first;
  assert.equal(requests, 2, 'cache changes during a request need one follow-up read');
  assert.equal(nodes.get('attention-tool-name').hidden, false);
  assert.equal(nodes.get('attention-tool-name').textContent, metadata.name);
  assert.equal(nodes.get('attention-tool-spec').textContent, '3.175 mm · ball end mill');
  assert.equal(loading, false);
});

test('tool-change prompt highlights the requested tool and clears stale metadata on live changes', () => {
  const nodes = new Map(['attention-state', 'attention-detail', 'attention-tool', 'attention-tool-number', 'attention-tool-name', 'attention-tool-spec'].map(id => [id, { hidden: true, textContent: '' }]));
  const status = createMachineStatusFeature({
    documentRef: { getElementById: id => nodes.get(id) || null },
    toolDisplayName,
    getActiveGcode: () => ({ preview: { tool_metadata: [{ number: 2, name: 'Makera Metal - 3.175*10mm', diameter_mm: 3.175, kind: 'ball end mill' }] } }),
  });
  const show = target => status.renderAttention({ connected: true, stale: false, state: 'Tool', tool: { target } });
  show(2);
  assert.equal(nodes.get('attention-tool').hidden, false);
  assert.equal(nodes.get('attention-tool-number').textContent, 'T2');
  assert.equal(nodes.get('attention-tool-name').textContent, 'Makera Metal - 3.175*10mm');
  assert.equal(nodes.get('attention-tool-spec').textContent, '3.175 mm · ball end mill');
  assert.equal(nodes.get('attention-detail').textContent, 'Confirm the physical change, then continue.');
  show(4);
  assert.equal(nodes.get('attention-tool-number').textContent, 'T4');
  assert.equal(nodes.get('attention-tool-name').hidden, true);
  assert.equal(nodes.get('attention-tool-spec').hidden, true);
  show(0);
  assert.equal(nodes.get('attention-tool-number').textContent, 'Probe');
  show(null);
  assert.equal(nodes.get('attention-tool').hidden, true);
  status.renderAttention({ connected: true, state: 'Idle' });
  assert.equal(nodes.get('attention-tool').hidden, true);
});

// Live machine snapshots own availability while the same button node remains wired.
test('paused-job attention Resume waits for the server spindle-ready contract', () => {
 const resume={hidden:false,disabled:false,dataset:{},textContent:'',setAttribute(){}};
 const feature=createMachineStatusFeature({documentRef:{getElementById:id=>id==='attention-resume'?resume:null}});
 const show=ready=>feature.renderAttention({state:'Pause',connected:true,stale:false,age_ms:0,job_control:{can_resume:ready}});
 show(false);
 assert.equal(resume.disabled,true);
 assert.equal(resume.dataset.resumeAction,'resume_job');
 show(true);
 assert.equal(resume.disabled,false);
 assert.equal(resume.textContent,'Resume paused job');
});


test('control stream updates the tool prompt without opening Files', async () => {
 const path='/sd/gcodes/current.nc';
 const machine={state:'Tool',connected:true,tool:{active:3,target:5}};
 const nodes=new Map(['attention-tool','attention-tool-number','attention-tool-name','attention-tool-spec'].map(id=>[id,{hidden:true,textContent:''}]));
 let active={path};
 let loading=false;
 let completeFirst;
 let requests=0;
 const metadata={number:5,name:'Makera Metal Ball Nose 2x6mm',diameter_mm:2,kind:'ball end mill'};
 const status=createMachineStatusFeature({documentRef:{getElementById:id=>nodes.get(id)||null},getActiveGcode:()=>active,toolDisplayName});
 const loader=mountActiveJobLoader({request:async()=>({json:()=>++requests===1?new Promise(resolve=>{completeFirst=resolve}):{path,preview:{tool_metadata:[metadata]}}}),
  getActiveGcodeLoading:()=>loading,setActiveGcodeLoading:value=>{loading=value},setActiveGcode:value=>{active=value},
  clearConnectivityIssue(){},setConnectivityIssue:()=>assert.fail('metadata request failed'),renderActiveGcode(){},getMachine:()=>machine,renderAttention:status.renderAttention});
 const streams=[];
 class EventSource {
  constructor(url){this.url=url;this.events={};streams.push(this)}
  addEventListener(name,fn){this.events[name]=fn}
 }
 const live=createLiveUpdates({EventSource,applyChange:event=>{if(event.kind==='active_gcode') loader.loadActiveGcode()}});
 live.connectControlSSE();
 const first=loader.loadActiveGcode();
 await Promise.resolve();
 status.renderAttention(machine);
 assert.equal(nodes.get('attention-tool-name').hidden,true);
 streams[0].events.change({data:JSON.stringify({kind:'active_gcode',active_gcode_path:path})});
 completeFirst({path});
 await first;
 assert.equal(streams.length,1,'no Files stream needed');
 assert.equal(streams[0].url,'/api/events?scope=control&up_next=1');
 assert.equal(requests,2);
 assert.equal(nodes.get('attention-tool-number').textContent,'T5');
 assert.equal(nodes.get('attention-tool-name').hidden,false);
 assert.equal(nodes.get('attention-tool-name').textContent,metadata.name);
 assert.equal(nodes.get('attention-tool-spec').textContent,'2 mm · ball end mill');
});
