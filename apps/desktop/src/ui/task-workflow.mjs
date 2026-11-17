import {demoSequence} from './demo-run.mjs';
import {activeProfile} from './allowance.mjs';

const TITLES={Manager:'Coordinate the project',Planner:'Plan the implementation',Builder:'Build the requested change',Reviewer:'Review the proposed result',Tester:'Verify the result',Researcher:'Research the approach',Database:'Plan the data changes',Designer:'Explore the interface',Documentation:'Document the result',Security:'Review security boundaries'};
export function assignmentFor(role){return {
  Manager:'Route specialist work, track its state, and bring questions and decisions back to the user.',
  Planner:'Break the request into a clear plan, identify dependencies, and hand the plan back to the Manager.',
  Builder:'Follow the plan and prepare the requested changes within the approved scope.',
  Reviewer:'Inspect the builder’s result, report findings to the Manager, and identify corrections.',
  Tester:'Run the agreed checks and report passed, failed, interrupted, infrastructure error, or not-run outcomes.',
}[role]||`Carry out the ${role.toLowerCase()} assignment and return findings to the Manager.`;}
function event(task,at,text){return {...task,events:[...task.events,{at,text}]};}
function updateTask(run,task){return {...run,tasks:run.tasks.map(t=>t.id===task.id?task:t)};}
function gateFor(run,task){
  if(!run.withApprovals)return null;
  if(task.role==='Planner')return {kind:'question',title:'What should the plan focus on?',body:'The Planner needs a direction before continuing. As Manager, I am bringing this question to you.',scope:'Choose the goal for this simulated planning task. Your answer is saved with this request.'};
  if(task.role==='Builder')return {kind:'permission',title:'Allow the Builder’s demo step?',body:'The Builder is ready for the implementation step. As Manager, I need your approval before this preview continues.',scope:'One simulated implementation step in this run only. No files, commands, provider requests, or operating-system permissions are affected.'};
  if(task.role==='Reviewer'&&!run.sequence.some(n=>n.role==='Tester'))return {kind:'blocked',title:'There is no Test agent in this worktree.',body:'The review step has no connected Tester to perform verification. Should I continue the demo without verification, or stop?',scope:'Continuing explicitly records “Completed — unverified (user chose to skip verification)”. No real test results will be claimed.'};
  return null;
}
function begin(run,now){
  const task=run.tasks[run.index];
  const gate=gateFor(run,task);
  if(gate){
    const approval={...gate,id:`${task.id}:decision`,runId:run.id,projectId:run.projectId,taskId:task.id,nodeId:task.nodeId,nodeName:task.nodeName,role:task.role,status:'pending',createdAt:now,resolvedAt:null,decision:null,response:null};
    const status=gate.kind==='question'?'needs_input':gate.kind==='permission'?'awaiting_approval':'blocked';
    return {...updateTask(run,event({...task,status,progress:0},now,`Manager requested ${gate.kind==='permission'?'permission':gate.kind==='question'?'your input':'a verification decision'}.`)),phase:'waiting',startedAt:now,approvals:[...run.approvals,approval]};
  }
  return {...updateTask(run,event({...task,status:'running',startedAt:now},now,'Simulated task started. No provider request was sent.')),phase:'running',startedAt:now};
}
export function createDemoRun(graph,{id,projectId,now=Date.now(),withApprovals=true}){
  const sequence=demoSequence(graph);
  const tasks=sequence.map(n=>{const original=graph.nodes.find(x=>x.id===n.id);const profile=activeProfile(original);return {id:`${id}:${n.id}`,runId:id,projectId,nodeId:n.id,nodeName:n.name,role:n.role,provider:profile.provider,model:profile.model,title:TITLES[n.role]||`${n.role} assignment`,assignment:assignmentFor(n.role),status:'queued',progress:0,createdAt:now,startedAt:null,finishedAt:null,verification:'not_run',output:null,error:null,events:[{at:now,text:'Added to the demo queue from the worktree snapshot.'}]};});
  return begin({id,projectId,sequence,tasks,approvals:[],index:0,phase:'running',startedAt:now,withApprovals,unverified:false},now);
}
export function advanceDemo(run,now=Date.now()){
  if(run.phase!=='running')return run;
  const task=run.tasks[run.index];
  const finished=event({...task,status:'completed',progress:100,finishedAt:now,output:`Example ${task.role.toLowerCase()} output\n\n${task.assignment}\n\nThis is a UI fixture, not output from a model. No source file was created or changed.\nVerification: ${task.verification==='skipped_by_user'?'explicitly skipped by the user':'not run'}.`},now,'Demo step completed. Real execution and verification were not performed.');
  const next=updateTask(run,finished);
  if(run.index+1>=run.tasks.length)return {...next,phase:'completed',finishedAt:now};
  return begin({...next,index:run.index+1},now);
}
export function cancelDemo(run,now=Date.now(),activeStatus='interrupted'){
  if(!run||!['running','waiting'].includes(run.phase))return run;
  return {...run,phase:'cancelled',finishedAt:now,tasks:run.tasks.map((t,index)=>index<run.index?t:event({...t,status:index===run.index?activeStatus:'not_run',finishedAt:now},now,index===run.index?'Demo stopped. No real task was running.':'Not run because the demo stopped.')),approvals:run.approvals.map(a=>a.status==='pending'?{...a,status:'cancelled',resolvedAt:now,decision:'stop',response:'The demo was stopped.'}:a)};
}
export function resolveDemoApproval(run,approvalId,{decision,response='',projectId,taskId,runId},now=Date.now()){
  const approval=run?.approvals.find(a=>a.id===approvalId);
  if(!approval||approval.status!=='pending'||run.phase!=='waiting'||run.id!==runId||run.projectId!==projectId||approval.taskId!==taskId||run.tasks[run.index].id!==taskId)throw Error('This request is stale or belongs to another task. It cannot resume this demo.');
  const allowed=approval.kind==='question'?['answer','stop']:approval.kind==='permission'?['approve','deny']:['skip_verification','stop'];
  if(!allowed.includes(decision))throw Error('Choose an available Manager action.');
  if(approval.kind==='question'&&decision==='answer'&&!response.trim())throw Error('Write an answer before continuing.');
  if(response.length>2000)throw Error('Keep the answer under 2,000 characters.');
  const denied=['deny','stop'].includes(decision);
  const resolved={...approval,status:denied?'denied':'resolved',decision,response:response.trim(),resolvedAt:now};
  let next={...run,approvals:run.approvals.map(a=>a.id===approval.id?resolved:a)};
  if(denied)return cancelDemo(next,now,decision==='deny'?'denied':'interrupted');
  let task=next.tasks[next.index];
  task=event({...task,status:'running',startedAt:now,verification:decision==='skip_verification'?'skipped_by_user':task.verification},now,`Manager recorded your decision: ${decision}${response.trim()?` — ${response.trim()}`:''}.`);
  return {...updateTask(next,task),phase:'running',startedAt:now,unverified:next.unverified||decision==='skip_verification'};
}
export function mergeRunIntoProject(project,run){
  if(project.id!==run.projectId)return project;
  return {...project,tasks:[...(project.tasks||[]).filter(t=>t.runId!==run.id),...run.tasks],approvals:[...(project.approvals||[]).filter(a=>a.runId!==run.id),...run.approvals]};
}
export function recoverTaskHistory(project,now=Date.now()){
  return {...project,tasks:(project.tasks||[]).map(t=>['running','queued','needs_input','awaiting_approval','blocked'].includes(t.status)?event({...t,status:t.status==='queued'?'not_run':'interrupted',finishedAt:now},now,'Preview restarted. This task was not resumed.'):t),approvals:(project.approvals||[]).map(a=>a.status==='pending'?{...a,status:'stale',resolvedAt:now,response:'Preview restarted; this request can no longer resume a task.'}:a)};
}
