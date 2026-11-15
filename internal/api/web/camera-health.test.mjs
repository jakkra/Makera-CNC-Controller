import test from "node:test";
import assert from "node:assert/strict";
import {mountDashboardCamera} from "./modules/camera.js";

test("offline camera source never renders fallback JPEG as live and recovers on health refresh", async (t) => {
 const node=()=>({dataset:{},style:{setProperty(){}},classList:{toggle(){}},setAttribute(){}});
 const nodes=new Map([["dashboard-external-camera",node()],["dashboard-builtin-camera",node()],
  ["dashboard-external-camera-state",node()],["dashboard-external-camera-image",{...node(),removeAttribute(key){delete this[key]}}]]);
 let online=false;
 let failed=false;
 let activeTab="dashboard";
 const feature=mountDashboardCamera({getActiveTab:()=>activeTab,getReadOnly:()=>false,
  documentRef:{hidden:false,getElementById:id=>nodes.get(id)||null,querySelector:()=>null},
  windowRef:{location:{href:"http://sensei.local/"}},setTextIfChanged(){},setStatusMessage(){},
  request:async()=>{if(failed) throw new Error("network timeout"); return ({json:async()=>({external:{configured:true,stream_url:"/api/camera/external",health_configured:true,online},builtin:{configured:false}})})}});
 t.after(() => feature.stopDashboardExternalCamera());
 failed=true;
 await feature.loadDashboardCameras();
 assert.match(nodes.get("dashboard-external-camera-state").textContent,/Loading camera configuration/);
 failed=false;
 await feature.loadDashboardCameras();
 assert.equal(nodes.get("dashboard-external-camera-image").src,undefined);
 assert.match(nodes.get("dashboard-external-camera-state").textContent,/no video/);
 assert.equal(nodes.get("dashboard-external-camera-image").hidden,true);
 online=true;
 await feature.loadDashboardCameras();
 const image=nodes.get("dashboard-external-camera-image");
 assert.match(image.src,/api\/camera\/external/);
 image.onload();
 assert.equal(image.hidden,false);
 assert.match(nodes.get("dashboard-external-camera-state").textContent,/live/);
 const currentURL=image.src;
 failed=true;
 await feature.loadDashboardCameras();
 assert.equal(image.src,currentURL,"status lookup failure must preserve the working stream");
 assert.equal(image.hidden,false);
 failed=false;
 online=false;
 await feature.loadDashboardCameras();
 assert.equal(image.src,undefined,"a verified video loss must hide the fallback stream");
 assert.match(nodes.get("dashboard-external-camera-state").textContent,/no video/);
 activeTab="files";
 feature.syncDashboardCameras();
 assert.equal(image.src,undefined);
});
