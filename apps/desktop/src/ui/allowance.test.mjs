// Ported from the WorkTreeAI preview template (node:test -> vitest); assertions unchanged.
import { test } from "vitest";
import assert from "node:assert/strict";

const load=()=>import('./allowance.mjs');
const node=()=>({id:'builder',role:'Builder',provider:'OpenAI',model:'Codex (demo)',backups:[{id:'b1',provider:'Anthropic',model:'Claude (demo)'},{id:'b2',provider:'Google',model:'Gemini (demo)'}]});
test('exhausted primary selects the first configured funded backup and preserves the role',async()=>{const {recoveryFor}=await load();const r=recoveryFor(node(),{OpenAI:0,Anthropic:40,Google:70});assert.equal(r.to.id,'b1');assert.equal(r.node.role,'Builder');assert.equal(r.node.id,'builder');});
test('exhausted backups are skipped in stack order',async()=>{const {recoveryFor}=await load();assert.equal(recoveryFor(node(),{OpenAI:0,Anthropic:0,Google:70}).to.id,'b2');});
test('same-provider models share the exhausted account allowance',async()=>{const {recoveryFor}=await load();const n=node();n.backups.unshift({id:'same-account',provider:'OpenAI',model:'GPT (demo)'});assert.equal(recoveryFor(n,{OpenAI:0,Anthropic:40}).to.id,'b1');});
test('all exhausted pauses instead of inventing capacity',async()=>{const {recoveryFor}=await load();const r=recoveryFor(node(),{OpenAI:0,Anthropic:0,Google:0});assert.equal(r.to,null);assert.equal(r.node.recoveryPaused,true);});
test('unknown primary allowance does not trigger recovery',async()=>{const {recoveryFor}=await load();assert.equal(recoveryFor(node(),{Anthropic:40}).changed,false);});
test('unknown backup allowance is not assumed available',async()=>{const {recoveryFor}=await load();assert.equal(recoveryFor(node(),{OpenAI:0,Google:70}).to.id,'b2');});
test('recovery never loops back to earlier profiles',async()=>{const {recoveryFor}=await load();const n={...node(),activeProfileId:'b2'};const r=recoveryFor(n,{OpenAI:100,Anthropic:100,Google:0});assert.equal(r.to,null);assert.equal(r.node.recoveryPaused,true);});
test('a funded active backup stays active when the primary resets',async()=>{const {recoveryFor,activeProfile}=await load();const n={...node(),activeProfileId:'b1'};assert.equal(recoveryFor(n,{OpenAI:100,Anthropic:40}).changed,false);assert.equal(activeProfile(n).id,'b1');});
