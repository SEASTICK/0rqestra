// Ported from the WorkTreeAI preview template (node:test -> vitest); assertions unchanged.
import { test } from "vitest";
import assert from "node:assert/strict";

const graph={nodes:[{id:'m',name:'Manager',role:'Manager',priority:1},{id:'b',name:'Builder',role:'Builder',priority:1},{id:'p',name:'Planner',role:'Planner',priority:1},{id:'r',name:'Reviewer',role:'Reviewer',priority:1},{id:'orphan',name:'Unconnected',role:'Researcher',priority:1}],edges:[{from:'m',to:'b'},{from:'m',to:'p'},{from:'b',to:'r'}]};
test('demo plans first, respects edges, and excludes unreachable agents',async()=>{const {demoSequence}=await import('./demo-run.mjs');assert.deepEqual(demoSequence(graph).map(n=>n.id),['m','p','b','r']);});
test('multiple incoming dependencies must finish before a node is ready',async()=>{const {demoSequence}=await import('./demo-run.mjs');const g={...graph,edges:[...graph.edges,{from:'p',to:'r'}]};const ids=demoSequence(g).map(n=>n.id);assert.ok(ids.indexOf('r')>ids.indexOf('p'));assert.ok(ids.indexOf('r')>ids.indexOf('b'));});
test('cancelled demo does not mark queued nodes completed',async()=>{const {demoStatus}=await import('./demo-run.mjs');const run={sequence:graph.nodes,index:1,phase:'cancelled'};assert.equal(demoStatus(run,'m'),'completed');assert.equal(demoStatus(run,'b'),'interrupted');assert.equal(demoStatus(run,'p'),'idle');});
test('running review and queued work have distinct statuses',async()=>{const {demoStatus}=await import('./demo-run.mjs');const run={sequence:graph.nodes,index:3,phase:'running'};assert.equal(demoStatus(run,'r'),'reviewing');assert.equal(demoStatus(run,'orphan'),'queued');});
test('cycle is rejected instead of looping or fabricating completion',async()=>{const {demoSequence}=await import('./demo-run.mjs');assert.throws(()=>demoSequence({...graph,edges:[...graph.edges,{from:'r',to:'b'}]}),/loop/);});
