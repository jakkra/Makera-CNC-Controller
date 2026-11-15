import test from 'node:test';
import assert from 'node:assert/strict';
import { createMachineStatusFeature } from './modules/machine-status.js';
import { toolDisplayName } from './modules/tooling.js';

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
