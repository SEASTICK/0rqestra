// Agreed roles first; the template's older role names stay ordered so saved projects still run.
const ORDER={Manager:0,Planner:1,Researcher:2,Builder:3,Debugger:4,Database:4,Designer:4,Documentation:5,'Code Reviewer':6,Reviewer:6,Tester:7,'Security Reviewer':8,Security:8};
const REVIEW_ROLES=['Code Reviewer','Security Reviewer','Reviewer'];
export function demoSequence(graph){
  const managers=graph.nodes.filter(n=>n.role==='Manager');if(managers.length!==1)throw Error('The worktree needs exactly one Manager.');
  const reachable=new Set([managers[0].id]);let changed=true;
  while(changed){changed=false;for(const e of graph.edges)if(reachable.has(e.from)&&graph.nodes.some(n=>n.id===e.to)&&!reachable.has(e.to)){reachable.add(e.to);changed=true;}}
  const pending=graph.nodes.filter(n=>reachable.has(n.id));const done=new Set();const result=[];
  const created=new Map(graph.nodes.map((n,i)=>[n.id,i]));
  const order=(a,b)=>(ORDER[a.role]??9)-(ORDER[b.role]??9)||a.priority-b.priority||created.get(a.id)-created.get(b.id);
  // D1 allows cycles between specialists. One simulated pass runs each reachable agent once: an
  // agent waits for all its predecessors, except inside a loop, where the loop is entered at an
  // agent that already has a finished predecessor. Real runs are bounded by the agreed limits.
  while(result.length<pending.length){let ready=pending.filter(n=>!done.has(n.id)&&graph.edges.filter(e=>e.to===n.id&&reachable.has(e.from)).every(e=>done.has(e.from)));
    if(!ready.length)ready=pending.filter(n=>!done.has(n.id)&&graph.edges.some(e=>e.to===n.id&&done.has(e.from)));
    ready.sort(order);const n=ready[0];done.add(n.id);result.push({id:n.id,name:n.name,role:n.role});
  }
  return result;
}
export function demoStatus(run,nodeId){
  if(!run)return 'idle';const index=run.sequence.findIndex(n=>n.id===nodeId);if(index<0)return 'idle';
  const task=run.tasks?.find(t=>t.nodeId===nodeId);if(task&&task.status!=='running')return task.status;
  if(run.phase==='completed'||index<run.index)return 'completed';
  if(run.phase==='cancelled')return index===run.index?'interrupted':'idle';
  if(index>run.index)return 'queued';
  if(run.phase==='waiting')return run.tasks?.[index]?.status||'blocked';
  const role=run.sequence[index].role;return role==='Manager'||role==='Planner'?'planning':REVIEW_ROLES.includes(role)?'reviewing':role==='Tester'?'testing':'working';
}
export const isWorking=status=>['planning','reviewing','testing','working'].includes(status);
