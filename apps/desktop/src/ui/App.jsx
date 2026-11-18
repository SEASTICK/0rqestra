import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './app.css';
import { DEMO_ALLOWANCES, activeProfile, profilesFor, recoveryFor } from './allowance.mjs';
import { demoSequence, demoStatus, isWorking } from './demo-run.mjs';
import { zoomAt, wheelCamera } from './camera.mjs';
import { AGREED_ROLES, isAgreedRole, canConnect, nextPriority, priorityConflict } from './tree-rules.mjs';
import {createDemoRun,advanceDemo,cancelDemo,resolveDemoApproval,mergeRunIntoProject,recoverTaskHistory} from './task-workflow.mjs';
import {TaskDetails,ManagerInbox} from './TaskPanels.jsx';
import {useUpdates,UpdateDialog} from './UpdateDialog.jsx';
import {prepareForUpdate} from './update-gate.mjs';
import {ALLOWANCES_KEY,PROJECTS_KEY,readStored} from './storage-keys.mjs';
import {ProfileMenu,SettingsDialog,HelpDialog,UpdateIntro} from './Shell.jsx';
import {readTheme,applyTheme} from './theme.mjs';
import {readLaunch,dismissBoot} from './launch.mjs';
import {ChatTargetPicker,AssistantMessage} from './LiveChat.jsx';
import {readTarget,saveTarget,effectiveTarget,historyFor,newAssistant,applyChatEvent,settleInterrupted,parsePlanRequest,plannerOf,replanMessage,isRealAgent,autoTeam,teamNeedsSetup,readyProviders,teamMembers,teamAgents,planAssignments,newTeamRun,applyTeamEvent,nodeStates,agentTarget,nodeFieldsFor,agentBadge,TEST_PROMPT,isTerminal} from './live-chat.mjs';
import {AgentRunsOn,TryAgent} from './AgentRuntime.jsx';
import {PlanCard,TeamRunCard,PlannerCard} from './TeamRun.jsx';
// Provider screens are simulated stand-ins in 0rqestra Stage 2 (see SimulatedProviders.jsx).
import {LocalWorkflow,apiGraph} from './SimulatedProviders.jsx';
import {AccountsPage} from './AccountsSetup.jsx';

const ICONS = {
  tree: <><path d="M12 3v5m-7 4V8h14v4M5 16v5m14-5v5M12 8v10"/><rect x="2" y="12" width="6" height="4" rx="1"/><rect x="16" y="12" width="6" height="4" rx="1"/><rect x="9" y="18" width="6" height="4" rx="1"/></>,
  chat: <path d="M20 11a8 8 0 0 1-8 8H5l-4 3 2-7a8 8 0 1 1 17-4Z"/>,
  plus: <path d="M12 5v14M5 12h14"/>,
  arrow: <path d="m5 12 7-7 7 7M12 5v14"/>,
  chevron: <path d="m9 5 7 7-7 7"/>,
  close: <path d="m6 6 12 12M6 18 18 6"/>,
  expand: <><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M3 3l6 6m12-6-6 6M3 21l6-6m12 6-6-6"/></>,
  minimize: <path d="M3 9h6V3m12 6h-6V3M3 15h6v6m12-6h-6v6"/>,
  folder: <path d="M3 6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v10H3Z"/>,
  settings: <><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/></>,
  clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
  link: <><path d="m10 13 4-4m-7 7-1 1a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m2 5 1-1a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0" transform="translate(2 -1)"/></>,
  grid: <><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/></>,
  code: <path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 20"/>,
  check: <path d="m5 12 4 4L19 6"/>,
  search: <><circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/></>,
  undo: <path d="M8 4 3 9l5 5M3 9h11a6 6 0 0 1 0 12"/>,
  more: <><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></>,
  trash: <><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/></>,
  spark: <><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z"/><path d="m20 2 1 2 2 1-2 1-1 2-1-2-2-1 2-1Z"/></>,
  panel: <><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M16 3v18"/></>,
  sun: <><circle cx="12" cy="12" r="4"/><path d="M12 1v2m0 18v2M1 12h2m18 0h2M4 4l2 2m12 12 2 2M4 20l2-2M18 6l2-2"/></>,
};
// The 0rqestra app mark. Same drawings as assets/icon/icon.svg (master, used above 48 px) and
// icon-small.svg (heavier, used at 48 px and below), so the in-app logo matches the app icon.
function AppMark({size=32}) {
  const small=size<=48;
  return <svg width={size} height={size} viewBox="0 0 1024 1024" role="img" aria-label="0rqestra">{small?<>
    <rect x="8" y="8" width="1008" height="1008" rx="232" fill="#FBF7F0"/>
    <rect x="16" y="16" width="992" height="992" rx="224" fill="none" stroke="#D9CFBF" strokeWidth="16"/>
    <g fill="none" stroke="#3F8A70" strokeWidth="44" strokeLinecap="round" strokeLinejoin="round"><path d="M372 276 L578 300 L712 236"/><path d="M578 300 Q480 392 296 500"/></g>
    <g fill="#3F8A70"><circle cx="372" cy="276" r="82"/><circle cx="712" cy="236" r="88"/><circle cx="296" cy="500" r="84"/></g>
    <path fill="#2B2B2B" d="M 260.4 872.7 L 862.6 392.6 A 28 28 0 0 0 829.4 347.4 L 191.6 779.3 A 58 58 0 0 0 260.4 872.7 Z"/>
  </>:<>
    <rect x="40" y="40" width="944" height="944" rx="210" fill="#FBF7F0"/>
    <rect x="42" y="42" width="940" height="940" rx="208" fill="none" stroke="#E7DFD2" strokeWidth="4"/>
    <g fill="none" stroke="#569E85" strokeWidth="12" strokeLinecap="round"><path d="M391.4 288.6 L580.2 307.5 L704 246.7"/><path d="M580.2 307.5 Q482.5 391.4 312.7 489"/></g>
    <g fill="#569E85"><circle cx="391.4" cy="288.6" r="55.6"/><circle cx="704" cy="246.7" r="60.8"/><circle cx="312.7" cy="489" r="57.7"/></g>
    <path fill="#343434" d="M 231.2 855.8 L 859.8 369.5 A 8 8 0 0 0 850.4 356.7 L 199.2 812.4 A 27 27 0 0 0 231.2 855.8 Z"/>
  </>}</svg>;
}
function Icon({name, size=18, ...rest}) { return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>{ICONS[name] || ICONS.spark}</svg>; }
const ROLES = AGREED_ROLES;
const MODELS = { OpenAI:['Codex (demo)','GPT (demo)'], Anthropic:['Claude (demo)'], Google:['Gemini (demo)'], xAI:['Grok (demo)'] };
const ROLE_COLOR = {Manager:'green',Planner:'blue',Builder:'violet','Code Reviewer':'amber',Debugger:'pink','Security Reviewer':'teal',Reviewer:'amber',Tester:'teal',Researcher:'blue',Database:'teal',Designer:'pink',Documentation:'amber',Security:'pink'};
const ROLE_ICON = {Manager:'tree',Planner:'grid',Builder:'code','Code Reviewer':'check',Debugger:'search','Security Reviewer':'check',Reviewer:'check',Tester:'check',Researcher:'search',Database:'folder',Designer:'spark',Documentation:'folder',Security:'check'};
const id = () => crypto.randomUUID();
const clone = (x) => JSON.parse(JSON.stringify(x));
function initialGraph() { return {
  nodes:[
    {id:'manager',name:'Project manager',role:'Manager',provider:'OpenAI',model:'Codex (demo)',priority:1,x:410,y:75},
    {id:'planner',name:'The architect',role:'Planner',provider:'Anthropic',model:'Claude (demo)',priority:1,x:120,y:305},
    {id:'builder',name:'Code builder',role:'Builder',provider:'OpenAI',model:'Codex (demo)',priority:1,x:410,y:305},
    {id:'reviewer',name:'A fresh pair of eyes',role:'Code Reviewer',provider:'Google',model:'Gemini (demo)',priority:1,x:700,y:305},
  ],
  edges:[{id:'e1',from:'manager',to:'planner'},{id:'e2',from:'manager',to:'builder'},{id:'e3',from:'builder',to:'reviewer'}],
}; }
const makeProject = (name) => ({id:id(),name,graph:initialGraph(),messages:[],tasks:[],approvals:[]});
function loadWorkspace() {
  try { const v=JSON.parse(readStored(localStorage,PROJECTS_KEY)); if(Array.isArray(v) && v.length && v.every(p=>typeof p.id==='string' && typeof p.name==='string' && Array.isArray(p.graph?.nodes) && Array.isArray(p.graph?.edges) && Array.isArray(p.messages))) return v.map(p=>recoverTaskHistory({...p,messages:settleInterrupted(p.messages)})); } catch { /* Safe defaults for unavailable or invalid preview storage. */ }
  return [makeProject('0rqestra')];
}
// canConnect comes from tree-rules.mjs (D1: cycles between specialists are allowed).

function App() {
  const [projects,setProjects]=useState(loadWorkspace);
  const [activeId,setActiveId]=useState(projects[0].id);
  const project=projects.find(p=>p.id===activeId)||projects[0];
  const graph=project.graph;
  const [view,setView]=useState('chat');
  const [selected,setSelected]=useState(null);
  const [selectedEdge,setSelectedEdge]=useState(null);
  const [connecting,setConnecting]=useState(null);
  const [dialog,setDialog]=useState(null);
  const [toast,setToast]=useState('');
  const updates=useUpdates();
  const [input,setInput]=useState('');
  const [history,setHistory]=useState([]);
  const [navOpen,setNavOpen]=useState(true);
  const [theme,setTheme]=useState(()=>readTheme(localStorage));
  useEffect(()=>{applyTheme(theme,document.documentElement,localStorage);},[theme]);
  const [shellDialog,setShellDialog]=useState(null);
  const [appInfo,setAppInfo]=useState(null);
  const [launch,setLaunch]=useState(null);
  const [bootDone,setBootDone]=useState(false);
  // The start screen in index.html leaves once it has played; "Updated to vX" follows when the version went up.
  useEffect(()=>{let alive=true;dismissBoot().then(()=>{if(alive)setBootDone(true);});Promise.resolve(window.orqestra?.getAppInfo?.()).then(info=>{if(!alive)return;setAppInfo(info||null);setLaunch(readLaunch(localStorage,info?.appVersion));}).catch(()=>{if(alive)setLaunch({kind:'start',previous:null});});return()=>{alive=false;};},[]);
  const [profileName,setProfileName]=useState(()=>{try{return localStorage.getItem('orqestra-profile-name')||'My workspace';}catch{return 'My workspace';}});
  useEffect(()=>{try{localStorage.setItem('orqestra-profile-name',profileName);}catch{/* Kept for this session only. */}},[profileName]);
  const [activity,setActivity]=useState(false);
  const [page,setPage]=useState('project');
  const [run,setRun]=useState(null);
  const [liveRun,setLiveRun]=useState(null);
  const [liveDraft,setLiveDraft]=useState('');
  // Real chat (main/chat-ipc.ts): which tools are ready, which one answers, and the replies being written.
  const [chatProviders,setChatProviders]=useState([]);
  const [providersLoading,setProvidersLoading]=useState(false);
  async function refreshProviders(refresh){if(!window.orqestra?.chat)return;setProvidersLoading(true);try{const list=await window.orqestra.chat.providers(refresh===true);setChatProviders(Array.isArray(list)?list:[]);}catch{/* AI accounts shows the problem on the next check. */}finally{setProvidersLoading(false);}}
  useEffect(()=>{void refreshProviders(false);},[]);
  const subscriptionStatus={providers:chatProviders.filter(p=>p.subscription).map(p=>({provider:p.provider==='claude'?'Anthropic':'OpenAI',verifiedModels:p.models.map(m=>m.id)}))};
  const [chatTarget,setChatTarget]=useState(()=>readTarget(localStorage));
  // The Manager's tool, model and effort are the Manager node's own settings, so the box under the chat
  // and the agent editor always agree. Older projects fall back to the last choice made in the box.
  const managerNode=graph.nodes.find(n=>n.role==='Manager');
  const target=effectiveTarget(agentTarget(managerNode)||chatTarget,chatProviders);
  function changeTarget(next){
    setChatTarget(next);saveTarget(localStorage,next);
    if(!managerNode)return;
    const status=chatProviders.find(t=>t.provider===next.provider);
    patchProject({graph:{...graph,nodes:graph.nodes.map(n=>n.id===managerNode.id?{...n,...nodeFieldsFor(next,status)}:n)}});
  }
  // AI accounts: choose a connected tool for the Manager or for one agent, with the tool's default model.
  function defaultModel(status){const m=(status?.models||[]).find(x=>x.isDefault)||(status?.models||[])[0];return m?m.id:null;}
  // One step: every agent that is still a demo agent gets a connected tool (reviewers on another tool when there is one).
  function setupTeam(){const {graph:next,changed}=autoTeam(graph,chatProviders);if(!changed.length){setToast('Every agent already runs on Claude Code, Codex or Gemini.');return;}patchProject({graph:next});setToast(`Team set up: ${changed.map(c=>`${c.name} → ${c.tool}`).join(', ')}. You can change any agent in the tree.`);}
  const canSetUpTeam=readyProviders(chatProviders).length>0&&graph.nodes.some(n=>!isRealAgent(n));
  function useToolForManager(provider){const status=chatProviders.find(t=>t.provider===provider);if(!status)return;changeTarget({provider,model:defaultModel(status),effort:null});setToast(`Your Manager now answers with ${status.name}.`);}
  function useToolForAgent(nodeId,provider){const status=chatProviders.find(t=>t.provider===provider);const node=graph.nodes.find(n=>n.id===nodeId);if(!status||!node)return;patchProject({graph:{...graph,nodes:graph.nodes.map(n=>n.id===nodeId?{...n,...nodeFieldsFor({provider,model:defaultModel(status),effort:null},status)}:n)}});setToast(`${node.name} now runs on ${status.name}.`);}
  // "Try this agent": one short real request with this tool, model and effort. It never touches the chat.
  function testAgent(spec,onEvent){
    const chat=window.orqestra?.chat;if(!chat)return null;
    const requestId=id();const projectId=`test-${requestId}`;
    replies.current.set(requestId,{projectId,onEvent});
    chat.send({requestId,projectId,provider:spec.provider,model:spec.model,effort:spec.effort,history:[],text:TEST_PROMPT}).catch(error=>{replies.current.delete(requestId);onEvent({type:'failed',reason:'provider_error',message:String(error?.message||error).replace(/^Error invoking remote method '[^']+': (Error: )?/,''),text:''});});
    return {requestId,stop:()=>{chat.stop(requestId);}};
  }
  const replies=useRef(new Map());
  const [replying,setReplying]=useState({});
  function endReply(requestId,projectId){replies.current.delete(requestId);setReplying(x=>{const n={...x};delete n[projectId];return n;});}
  function updateReply(projectId,messageId,event){setProjects(ps=>ps.map(p=>p.id!==projectId?p:{...p,messages:p.messages.map(m=>m.id===messageId?applyChatEvent(m,event):m)}));}
  useEffect(()=>{const chat=window.orqestra?.chat;if(!chat)return;chat.subscribe(message=>{const r=replies.current.get(message?.requestId);if(!r)return;if(r.onEvent){r.onEvent(message.event);if(isTerminal(message.event)){replies.current.delete(message.requestId);void refreshProviders(false);}return;}updateReply(r.projectId,r.messageId,message.event);if(isTerminal(message.event)){endReply(message.requestId,r.projectId);void refreshProviders(false);if(message.event.type==='completed'){const brief=parsePlanRequest(message.event.text).brief;if(brief)requestPlan(r.projectId,r.messageId,brief);}}});},[]);
  // AI accounts reads the tools itself and hands the result back (onProvidersChanged).
  const liveModels={...MODELS};for(const p of subscriptionStatus?.providers||[])liveModels[p.provider]=[...(MODELS[p.provider]||[]),...(p.verifiedModels||[])];
  const liveCompletion=useRef(new Set());
  useEffect(()=>{if(liveRun)setProjects(ps=>ps.map(p=>mergeRunIntoProject(p,liveRun)));},[liveRun]);
  useEffect(()=>{if(!window.orqestra?.workflowList)return;let disposed=false;window.orqestra.workflowList().then(runs=>{if(!disposed&&runs[0])setLiveRun(runs[0]);}).catch(e=>setToast(e.message));return()=>{disposed=true;};},[]);
  useEffect(()=>{if(!liveRun)return;let disposed=false;const timer=setInterval(()=>{window.orqestra.workflowStatus(liveRun.id).then(next=>{if(!disposed)setLiveRun(old=>JSON.stringify(old)===JSON.stringify(next)?old:next);}).catch(e=>{if(!disposed)setToast(e.message);});},1000);return()=>{disposed=true;clearInterval(timer);};},[liveRun?.id]);
  useEffect(()=>{if(!liveRun||['running','waiting'].includes(liveRun.phase)||liveCompletion.current.has(liveRun.id))return;liveCompletion.current.add(liveRun.id);setProjects(ps=>ps.map(p=>p.id===liveRun.projectId?{...p,messages:[...p.messages,{id:id(),kind:'manager',text:liveRun.managerSummary||`Workflow ${liveRun.phase}. ${liveRun.error||'Inspect the saved workflow for details.'}`}]}:p));},[liveRun?.id,liveRun?.phase]);
  function receiveLive(next){setLiveRun(next);setProjects(ps=>ps.map(p=>p.id===next.projectId&&!p.messages.some(m=>m.id===`${next.id}:request`)?{...p,messages:[...p.messages,{id:`${next.id}:request`,kind:'user',text:next.prompt}]}:p));}
  function createApiProject(selection){const next={...makeProject('Subscription workspace'),graph:apiGraph(selection),liveWorkflow:true};setProjects(ps=>[...ps,next]);setActiveId(next.id);setPage('workflow');}
  const [taskNodeId,setTaskNodeId]=useState(null);
  const [inboxSelected,setInboxSelected]=useState(null);
  useEffect(()=>{if(run)setProjects(ps=>ps.map(p=>mergeRunIntoProject(p,run)));},[run]);
  const [runTick,setRunTick]=useState(Date.now());
  const completionRecorded=useRef(null);
  useEffect(()=>{if(run?.phase!=='running')return;const timer=setTimeout(()=>setRun(r=>!r||r.id!==run.id||r.phase!=='running'?r:advanceDemo(r,Date.now())),2800);return()=>clearTimeout(timer);},[run?.id,run?.index,run?.phase]);
  useEffect(()=>{if(run?.phase!=='running')return;const timer=setInterval(()=>setRunTick(Date.now()),100);return()=>clearInterval(timer);},[run?.id,run?.phase]);
  useEffect(()=>{if(!run||!['completed','cancelled'].includes(run.phase)||completionRecorded.current===run.id)return;completionRecorded.current=run.id;setProjects(ps=>ps.map(p=>p.id===run.projectId?{...mergeRunIntoProject(p,run),messages:[...p.messages,{id:id(),kind:'manager',text:run.phase==='cancelled'?'Demo stopped. Remaining tasks were not run. No real provider task was executing.':run.unverified?'Completed — unverified (user chose to skip verification). This was a simulation; no models were called and no tests were run.':`Demo finished: ${run.sequence.length} connected agents animated in worktree order. No models were called, no files were changed, and no tests were run.`}]}:p));},[run?.phase,run?.id]);
  function startDemo(){if(project.liveWorkflow){setPage('workflow');return;}if(['running','waiting'].includes(run?.phase)){setToast('A demo is already active. Open the Manager inbox or stop it first.');return;}try{const sequence=demoSequence(graph);if(sequence.some(s=>graph.nodes.find(n=>n.id===s.id)?.recoveryPaused)){setToast('Reset exhausted demo allowances before running the animation.');return;}setRun(createDemoRun(graph,{id:id(),projectId:project.id,now:Date.now(),withApprovals:true}));setPage('project');setView('tree');setActivity(false);}catch(error){setToast(error.message);}}
  function stopDemo(){if(projectRun?.mode==='live'){setPage('workflow');return;}setRun(r=>cancelDemo(r,Date.now()));setToast('Animation stopped. No real task was running.');}
  const projectRun=liveRun?.projectId===project.id?liveRun:run?.projectId===project.id?run:null;
  const workflowProjects=projects.map(p=>{const demo=run?mergeRunIntoProject(p,run):p;return liveRun?mergeRunIntoProject(demo,liveRun):demo;});
  const workflowProject=workflowProjects.find(p=>p.id===project.id);
  const pendingCount=workflowProjects.reduce((count,p)=>count+(p.approvals||[]).filter(a=>a.status==='pending').length,0);
  function openInbox(approvalId){if(approvalId)setInboxSelected(approvalId);setPage('inbox');setActivity(false);}
  async function answerApproval(item,choice){try{if(item.mode==='live'){setLiveRun(await window.orqestra.workflowRespond({runId:item.runId,approvalId:item.id,projectId:item.projectId,taskId:item.taskId,decision:choice.decision}));setToast('Manager recorded your decision.');return {ok:true};}const next=resolveDemoApproval(run,item.id,{...choice,projectId:item.projectId,taskId:item.taskId,runId:item.runId});setRun(next);setToast(next.phase==='cancelled'?'Manager recorded your decision and stopped the demo.':'Manager recorded your response. The demo can continue.');return {ok:true};}catch(error){return {error:error.message};}}
  function inspectTask(item){if(item.projectId!==project.id)switchProject(item.projectId);setPage('project');setView('tree');setTaskNodeId(item.nodeId);setSelected(item.nodeId);}
  useEffect(()=>{if(run?.phase==='waiting')setToast('Your Manager needs a decision. Open the Manager inbox to continue.');},[run?.id,run?.index,run?.phase]);
  const runProgress=projectRun?.mode!=='live'&&projectRun?.phase==='running'?Math.min(100,Math.max(0,(runTick-projectRun.startedAt)/28)):0;
  const [saved,setSaved]=useState(true);
  const [allowances,setAllowances]=useState(()=>{try {return {...DEMO_ALLOWANCES,...JSON.parse(readStored(localStorage,ALLOWANCES_KEY))};}catch{return {...DEMO_ALLOWANCES};}});
  useEffect(()=>{try{localStorage.setItem(ALLOWANCES_KEY,JSON.stringify(allowances));}catch{/* Demo storage may be unavailable. */}},[allowances]);
  const chatEnd=useRef(null);
  useEffect(()=>{try {localStorage.setItem(PROJECTS_KEY,JSON.stringify(projects));setSaved(true);}catch {setSaved(false);}},[projects]);
  useEffect(()=>{if(!toast)return;const timer=setTimeout(()=>setToast(''),4500);return()=>clearTimeout(timer);},[toast]);
  useEffect(()=>{chatEnd.current?.scrollIntoView({behavior:'smooth'});},[project.messages.length,project.messages.at(-1)?.text?.length,project.messages.at(-1)?.status]);
  // Called by the main process before installing an update (main/update/index.ts). Saves the
  // projects and refuses while a run is active, saying what must finish or stop first.
  useEffect(()=>{
    window.__orqestraPrepareUpdate=()=>prepareForUpdate({projects,allowances,runs:[run,liveRun],storage:localStorage});
    return ()=>{delete window.__orqestraPrepareUpdate;};
  });
  function patchProject(patch) {setProjects(ps=>ps.map(p=>p.id===project.id?{...p,...patch}:p));}
  function updateGraph(next,remember=true) {if(['running','waiting'].includes(projectRun?.phase)){setToast('Stop the active workflow before editing this tree.');return;}if(remember)setHistory(h=>[...h.slice(-29),clone(graph)]);patchProject({graph:next});}
  function switchProject(pid){setTaskNodeId(null);setPage('project');setActiveId(pid);setSelected(null);setSelectedEdge(null);setConnecting(null);setHistory([]);setActivity(false);}
  function undo(){if(['running','waiting'].includes(projectRun?.phase)){setToast('Stop the active workflow before editing this tree.');return;}if(!history.length)return;patchProject({graph:history.at(-1)});setHistory(h=>h.slice(0,-1));setSelected(null);setSelectedEdge(null);setToast('Last tree change undone.');}
  function removeNode(nid){const n=graph.nodes.find(n=>n.id===nid);if(!n||n.role==='Manager')return;updateGraph({nodes:graph.nodes.filter(n=>n.id!==nid),edges:graph.edges.filter(e=>e.from!==nid&&e.to!==nid)});setSelected(null);setToast(`${n.name} removed. Its other agents are kept.`);}
  useEffect(()=>{const listener=e=>{if(e.key==='Escape'){setDialog(null);setTaskNodeId(null);setConnecting(null);setSelectedEdge(null);} if((e.ctrlKey||e.metaKey)&&e.key==='z'&&!['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)){e.preventDefault();undo();}};window.addEventListener('keydown',listener);return()=>window.removeEventListener('keydown',listener);});
  function selectNode(nid) {if(connecting){const error=canConnect(graph,connecting,nid);if(error){setToast(error);return;}updateGraph({...graph,edges:[...graph.edges,{id:id(),from:connecting,to:nid}]});setConnecting(null);setToast('Agents connected.');}setSelected(nid);setSelectedEdge(null);}
  function saveAgent(data) {
    if(dialog.kind==='edit') {const previous=graph.nodes.find(n=>n.id===dialog.node);const next={...data};if(previous.role!=='Manager'&&next.role!==previous.role){next.priority=nextPriority(graph,next.role,previous.id);}else if(previous.role!=='Manager'){const clash=priorityConflict(graph,previous.id,next.role,next.priority);if(clash){setToast(`Priority ${next.priority} is already used by ${clash.name} in the ${next.role} role. Choose a free priority.`);return;}}updateGraph({...graph,nodes:graph.nodes.map(n=>n.id===previous.id?{...n,...next}:n)});setToast(next.role!==previous.role?`Agent updated. It now has priority ${next.priority} in the ${next.role} role.`:'Agent updated.');}
    else {const parent=graph.nodes.find(n=>n.id===dialog.parent);const priority=nextPriority(graph,data.role);const siblings=graph.edges.filter(e=>e.from===parent.id).length;let x=parent.x+(siblings%3-1)*255;let y=parent.y+220+Math.floor(siblings/3)*185; x=Math.max(35,x);while(graph.nodes.some(n=>Math.abs(n.x-x)<235&&Math.abs(n.y-y)<150)){x+=255;if(x>1100){x=35;y+=185;}}const child={...data,id:id(),x,y,priority};updateGraph({nodes:[...graph.nodes,child],edges:[...graph.edges,{id:id(),from:parent.id,to:child.id}]});setSelected(child.id);setToast(`${child.name} added and connected to ${parent.name}.`);}
    setDialog(null);
  }
  function sendMessage(e){e.preventDefault();const text=input.trim();if(!text)return;if(!project.liveWorkflow&&target.provider!=='demo'&&window.orqestra?.chat){if(replying[project.id])return;setInput('');sendLive(text);return;}sendDemo(text);}
  // A real reply: the user's message and an empty Manager reply that fills in as events arrive.
  function sendLive(text,messages=project.messages){const requestId=id();const messageId=id();const projectId=project.id;const history=historyFor(messages);patchProject({messages:[...messages,{id:id(),kind:'user',text},newAssistant(messageId,target)]});replies.current.set(requestId,{projectId,messageId});setReplying(x=>({...x,[projectId]:requestId}));window.orqestra.chat.send({requestId,projectId,provider:target.provider,model:target.model,effort:target.effort,history,text,team:teamMembers(graph)}).catch(error=>{endReply(requestId,projectId);updateReply(projectId,messageId,{type:'failed',reason:'provider_error',message:String(error?.message||error).replace(/^Error invoking remote method '[^']+': (Error: )?/,''),text:''});});}
  // An answer to a Manager question becomes the next message; the question shows what was chosen.
  function answerQuestion(messageId,text,choice){if(replying[project.id]||!window.orqestra?.chat)return;if(target.provider==='demo'){setToast('Connect Claude Code or Codex to answer the Manager.');return;}const messages=project.messages.map(m=>m.id===messageId?{...m,answered:{kind:choice.kind,label:choice.label}}:m);sendLive(text,messages);}
  // Team runs (phase 3): the user starts the Manager's plan; the main process runs it and reports back.
  const teamRuns=useRef(new Map());
  function updateTeamRun(projectId,messageId,fn){setProjects(ps=>ps.map(p=>p.id!==projectId?p:{...p,messages:p.messages.map(m=>m.id===messageId?{...m,run:fn(m.run)}:m)}));}
  useEffect(()=>{const team=window.orqestra?.team;if(!team)return;team.subscribe(message=>{const r=teamRuns.current.get(message?.runId);if(!r)return;updateTeamRun(r.projectId,r.messageId,run=>applyTeamEvent(run,message.event));if(message.event?.type==='run-finished'){teamRuns.current.delete(message.runId);void refreshProviders(false);}});},[]);
  // Decision A6: a brief from the Manager goes to the Planner, whose plan is shown on the same reply.
  const projectsRef=useRef(projects);projectsRef.current=projects;
  function patchMessage(projectId,messageId,fn){setProjects(ps=>ps.map(p=>p.id!==projectId?p:{...p,messages:p.messages.map(m=>m.id===messageId?fn(m):m)}));}
  function requestPlan(projectId,messageId,brief){
    const team=window.orqestra?.team;const proj=projectsRef.current.find(p=>p.id===projectId);if(!team||!proj)return;
    const planner=plannerOf(proj.graph);
    if(!planner){patchMessage(projectId,messageId,m=>({...m,planning:{status:'failed',error:'No Planner runs on Claude Code or Codex any more. Set one in the tree, or ask the Manager to plan.'}}));return;}
    const requestId=id();
    patchMessage(projectId,messageId,m=>({...m,planning:{status:'running',requestId,plannerId:planner.id,plannerName:planner.name}}));
    team.plan({requestId,projectId,brief,planner,agents:teamAgents(proj.graph),team:teamMembers(proj.graph)})
      .then(result=>patchMessage(projectId,messageId,m=>({...m,planning:{status:'done',plannerId:planner.id,plannerName:planner.name,plan:result.plan,summary:result.summary}})))
      .catch(error=>patchMessage(projectId,messageId,m=>({...m,planning:{status:'failed',plannerName:planner.name,error:String(error?.message||error).replace(/^Error invoking remote method '[^']+': (Error: )?/,'')}})))
      .finally(()=>void refreshProviders(false));
  }
  function startPlan(assistantId,plan){
    const team=window.orqestra?.team;if(!team){setToast('Team runs work in the installed app.');return;}
    if([...teamRuns.current.values()].some(r=>r.projectId===project.id)){setToast('The team is already working in this project.');return;}
    const runId=id();const messageId=id();const projectId=project.id;
    patchProject({messages:[...project.messages.map(m=>m.id===assistantId?{...m,planStarted:runId}:m),{id:messageId,kind:'team',runId,run:newTeamRun(runId,plan)}]});
    teamRuns.current.set(runId,{projectId,messageId});
    team.start({runId,projectId,plan,agents:teamAgents(graph)}).catch(error=>{teamRuns.current.delete(runId);updateTeamRun(projectId,messageId,run=>applyTeamEvent(run,{type:'run-finished',status:'failed',summary:String(error?.message||error).replace(/^Error invoking remote method '[^']+': (Error: )?/,''),files:[],calls:0,usage:null}));});
  }
  const runningTeam=[...project.messages].reverse().find(m=>m.kind==='team'&&m.run?.status==='running');
  const planningNow=project.messages.find(m=>m.planning?.status==='running');
  const liveStates=runningTeam||planningNow?{...(runningTeam?nodeStates(runningTeam.run):{}),...(planningNow?{[planningNow.planning.plannerId]:'planning'}:{})}:null;
  const nameOf=nodeId=>graph.nodes.find(n=>n.id===nodeId)?.name||'an agent no longer in the tree';
  function sendDemo(text){if(project.liveWorkflow){setLiveDraft(text);setPage('workflow');setToast('Send and authorize this request in Build & review.');return;}patchProject({messages:[...project.messages,{id:id(),kind:'user',text},{id:id(),kind:'manager',text:`Your message is saved in this preview. Your project currently has ${graph.nodes.length} agents and ${graph.edges.length} connections. You can keep shaping the team in Worktree; live delegation and provider connections are not enabled yet.`}]});setInput('');}
  const selectedNode=graph.nodes.find(n=>n.id===selected);
  function saveRecovery(nodeId,backups) {
    updateGraph({...graph,nodes:graph.nodes.map(n=>n.id!==nodeId?n:recoveryFor({...n,backups,activeProfileId:backups.some(b=>b.id===n.activeProfileId)?n.activeProfileId:'primary',recoveryPaused:false},allowances).node)});
    setDialog(null);setToast('Recovery stack saved. Backups keep this agent’s role and tree position.');
  }
  function exhaustDemo(provider) {
    const next={...allowances,[provider]:0};setAllowances(next);
    setProjects(ps=>ps.map(p=>{if(p.liveWorkflow)return p;const reports=[];const nodes=p.graph.nodes.map(n=>{const r=recoveryFor(n,next);if(r.changed)reports.push(`${n.name}: ${r.to?`${r.from.provider} allowance exhausted; ${r.to.provider} / ${r.to.model} takes over the same role.`:'all remaining configured backups are exhausted or unavailable; this agent is paused.'}`);return r.node;});return {...p,graph:{...p.graph,nodes},messages:reports.length?[...p.messages,{id:id(),kind:'manager',text:`Simulated recovery — no provider task was run.\n\n${reports.join('\n\n')}`}]:p.messages};}));
    setDialog(null);setToast('Demo allowance exhausted. See Manager chat for the recovery summary.');
  }
  function resetDemo() {
    setAllowances({...DEMO_ALLOWANCES});setProjects(ps=>ps.map(p=>({...p,graph:{...p.graph,nodes:p.graph.nodes.map(n=>({...n,activeProfileId:'primary',recoveryPaused:false}))}})));setDialog(null);setToast('Demo allowances restored; primary models are active again.');
  }
  return <div className={`application ${navOpen?'nav-open':'nav-closed'}`}>
    {navOpen&&<aside className="navigation" aria-label="Workspace navigation"><div className="nav-brand"><span className="brand-mark brand-mark-app"><AppMark size={28}/></span><span className="nav-brand-name">0rqestra</span><button className="icon-button nav-collapse" onClick={()=>setNavOpen(false)} title="Hide sidebar" aria-label="Hide sidebar"><Icon name="panel"/></button></div><div className="nav-section-label">WORKSPACE</div><button className={`nav-item ${page==='project'&&!activity&&view==='chat'?'nav-item-active':''}`} onClick={()=>{setPage('project');setView('chat');setActivity(false);}}><Icon name="chat" size={17}/> Manager chat</button><button className={`nav-item ${activity?'nav-item-active':''}`} onClick={()=>setActivity(!activity)}><Icon name="clock" size={17}/> Activity <span className="nav-soon">Preview</span></button><button className={`nav-item ${page==='accounts'?'nav-item-active':''}`} onClick={()=>{setPage('accounts');setActivity(false);}}><Icon name="link" size={17}/> AI accounts</button><button className={`nav-item ${page==='inbox'?'nav-item-active':''}`} onClick={()=>openInbox()}><Icon name="chat" size={17}/> Manager inbox{pendingCount>0&&<span className="inbox-count-badge">{pendingCount}</span>}</button><button className={"nav-item "+(page==='workflow'?'nav-item-active':'')} onClick={()=>{setPage('workflow');setActivity(false);}}><Icon name="code" size={17}/> Build &amp; review</button><div className="nav-section-heading"><span className="nav-section-label">PROJECTS</span><button className="icon-button" title="New project" aria-label="New project" onClick={()=>setDialog({kind:'project'})}><Icon name="plus" size={15}/></button></div><div className="project-list">{projects.map(p=><div key={p.id} className={`nav-project ${p.id===project.id?'nav-project-current':''}`}><button className="project-button" onClick={()=>switchProject(p.id)}><span className="project-color"/><span>{p.name}</span><Icon name="chevron" size={12}/></button>{p.id===project.id&&<div className="project-children"><button className={page==='project'&&view==='chat'?'child-active':''} onClick={()=>{setPage('project');setView('chat');setActivity(false);}}><Icon name="chat" size={14}/> Chat</button><button className={page==='project'&&view!=='chat'?'child-active':''} onClick={()=>{setPage('project');setView(view==='chat'?'split':'chat');setActivity(false);}}><Icon name="tree" size={14}/> Worktree<span>{graph.nodes.length}</span></button></div>}</div>)}</div><button className="new-project" onClick={()=>setDialog({kind:'project'})}><Icon name="plus" size={15}/> New project</button><div className="nav-bottom"><div className="connection-card"><span className="connection-icon"><Icon name="link" size={17}/></span><strong>Your models, your team.</strong><p>Chat with Claude Code or Codex on your own subscription.</p><button onClick={()=>{setPage('accounts');setActivity(false);}}>Manage accounts <Icon name="chevron" size={12}/></button></div><ProfileMenu name={profileName} version={appInfo?.appVersion} updates={updates} theme={theme} onTheme={setTheme} onSettings={tab=>setShellDialog({kind:'settings',tab})} onHelp={()=>setShellDialog({kind:'help'})}/></div></aside>}
    <header className="titlebar">
      <div className="brand">{!navOpen&&<><button className="icon-button" onClick={()=>setNavOpen(true)} title="Show sidebar" aria-label="Show sidebar"><Icon name="panel"/></button><span className="brand-mark brand-mark-app"><AppMark size={28}/></span><span>0rqestra</span><span className="title-divider"/></>}<span className="breadcrumb">Personal workspace <Icon name="chevron" size={12}/> <strong>{project.name}</strong></span></div>
      <div className="title-actions"><span className="preview-badge"><span/> UI preview</span></div>
    </header>
    <div className="workspace">
      <main className={`main-area view-${view} ${page==='accounts'?'accounts-main':''}`}>{page==='accounts'?<AccountsPage onBack={()=>setPage('project')} notify={setToast} onProvidersChanged={setChatProviders} managerProvider={target.provider} agents={graph.nodes} onUseForManager={useToolForManager} onUseForAgent={useToolForAgent} onUseDemo={()=>{changeTarget({provider:'demo',model:null,effort:null});setToast('The Manager answers in Demo mode again.');}}/>:page==='workflow'?<LocalWorkflow initialPrompt={liveDraft} project={project} run={liveRun?.projectId===project.id?liveRun:null} onRun={receiveLive} onCreate={createApiProject} onAccounts={()=>setPage('accounts')} onInbox={openInbox} onTree={()=>{setPage('project');setView('tree');}} Icon={Icon}/>:page==='inbox'?<ManagerInbox projects={workflowProjects} selectedId={inboxSelected} onSelect={setInboxSelected} onDecision={answerApproval} onTask={inspectTask} onStartDemo={startDemo} Icon={Icon}/>:<>
        <div className="project-header"><div><div className="eyebrow">YOUR PROJECT</div><h1>{project.name}<span className="project-status">Draft</span></h1></div><div className="project-actions"><button className="button inbox-header-button" onClick={()=>openInbox()}><Icon name="chat" size={14}/> Manager inbox{pendingCount>0&&<span className="inbox-count-badge">{pendingCount}</span>}</button><button className={`button demo-run-button ${projectRun?.phase==='running'?'demo-is-running':''}`} onClick={project.liveWorkflow?()=>setPage('workflow'):['running','waiting'].includes(projectRun?.phase)?stopDemo:startDemo}><Icon name={['running','waiting'].includes(projectRun?.phase)?'close':'spark'} size={14}/>{project.liveWorkflow?'Build & review':['running','waiting'].includes(projectRun?.phase)?'Stop demo':'Run demo'}</button><span className="save-state"><span className={saved?'saved-dot':'unsaved-dot'}/>{saved?'Saved on this device':'Storage unavailable'}</span><button className={`button ${view!=='chat'?'button-active':''}`} onClick={()=>{setView(view==='chat'?'split':'chat');setActivity(false);}}><Icon name="tree" size={16}/>{view==='chat'?'Open worktree':'Close worktree'}<span className="count-badge">{graph.nodes.length}</span></button></div></div>
        <div className="content-panels">
          {view!=='tree'&&<section className="chat-panel" aria-label="Manager chat">
            <div className="panel-header"><div className="panel-heading"><span className="mini-avatar green"><Icon name="tree" size={17}/></span><div><strong>Manager</strong><span>Your point of contact</span></div></div><button className="icon-button" title="Expand chat" aria-label="Expand chat" onClick={()=>setView('chat')}><Icon name="expand" size={15}/></button></div>
            <div className="chat-scroll">
              {project.messages.length===0?<div className="welcome"><div className="welcome-symbol welcome-symbol-app"><AppMark size={68}/><span className="tiny-spark"><Icon name="spark" size={12}/></span></div><div className="eyebrow welcome-eyebrow">ONE CONVERSATION. A WHOLE TEAM.</div><h2>Big ideas.<br/><span>A clear way forward.</span></h2><p>Give your project a direction.<br/>Your Manager brings the right agents together.</p><div className="welcome-team"><div className="avatar-stack">{graph.nodes.slice(0,4).map(n=><span key={n.id} className={`mini-avatar ${ROLE_COLOR[n.role]}`}><Icon name={ROLE_ICON[n.role]} size={14}/></span>)}</div><span>{graph.nodes.length} agents in your worktree</span></div><button className="welcome-tree-link" onClick={()=>setView('split')}>Shape your team <Icon name="chevron" size={13}/></button><div className="suggestions"><button onClick={()=>setInput('Help me plan the first version of my app.')}><Icon name="spark"/><span>Start with an idea<small>Turn a thought into a plan</small></span><Icon name="plus" size={15}/></button><button onClick={()=>setView('split')}><Icon name="tree"/><span>Build your worktree<small>Choose who works on what</small></span><Icon name="chevron" size={15}/></button></div></div>:<div className="messages">{project.messages.map(m=>m.kind==='team'&&m.run?<TeamRunCard key={m.id} run={m.run} nameOf={nameOf} onStop={()=>window.orqestra?.team?.stop(m.run.id)} onOpenFolder={()=>window.orqestra?.team?.openFolder(project.id)} onReplan={()=>{if(replying[project.id])return;if(target.provider==='demo'){setToast('Connect the Manager to Claude Code or Codex first.');return;}sendLive(replanMessage(m.run));}}/>:m.kind==='assistant'?<AssistantMessage key={m.id} m={m} Icon={Icon} onAccounts={()=>{setPage('accounts');setActivity(false);}} onAnswer={answerQuestion} busy={Boolean(replying[project.id])} renderPlan={(plan,msg)=><PlanCard plan={plan} assignments={planAssignments(plan,graph)} startedRunId={msg.planStarted} busy={Boolean(runningTeam)} onStart={()=>startPlan(msg.id,plan)} onTree={()=>{setPage('project');setView('split');}}/>} renderPlanRequest={(brief,msg)=>msg.planning?.status==='done'?<PlanCard plan={msg.planning.plan} plannedBy={msg.planning.plannerName} summary={msg.planning.summary} assignments={planAssignments(msg.planning.plan,graph)} startedRunId={msg.planStarted} busy={Boolean(runningTeam)} onStart={()=>startPlan(msg.id,msg.planning.plan)} onTree={()=>{setPage('project');setView('split');}}/>:<PlannerCard planning={msg.planning} brief={brief} onStop={()=>window.orqestra?.team?.stopPlan(msg.planning?.requestId)} onRetry={()=>requestPlan(project.id,msg.id,brief)}/>}/>:<div className={`message message-${m.kind}`} key={m.id}>{m.kind==='manager'&&<div className="message-author"><span className="mini-avatar green"><Icon name="tree" size={14}/></span>Manager<span>Preview response</span></div>}<div className="message-body">{m.text}</div></div>)}<div ref={chatEnd}/></div>}
            </div>
            <div className="composer-wrap">{teamNeedsSetup(graph,chatProviders)&&<div className="team-setup-banner" role="note"><span><strong>Your team is still in demo mode.</strong> Connect the agents to your tools so the Manager can plan real work.</span><button type="button" className="shell-button primary" onClick={setupTeam}>Set up the team</button></div>}<form className="composer" onSubmit={sendMessage}><textarea aria-label="Message your Manager" placeholder="Tell your Manager what you want to build…" value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMessage(e);}}} rows={2}/><div className="composer-footer"><ChatTargetPicker target={target} statuses={chatProviders} onChange={changeTarget} onAccounts={()=>{setPage('accounts');setActivity(false);}}/>{replying[project.id]?<button className="send-button stop-button" type="button" onClick={()=>window.orqestra?.chat?.stop(replying[project.id])} title="Stop the reply" aria-label="Stop the reply"><span className="stop-square"/></button>:<button className="send-button" type="submit" disabled={!input.trim()} title="Send message" aria-label="Send message"><Icon name="arrow" size={17}/></button>}</div></form><p className="composer-note">{target.provider==='demo'?'Demo · Messages stay on this device · No model requests':`${target.name} · Your own subscription · History stays on this device`}</p></div>
          </section>}
          {view!=='chat'&&<section className="tree-panel" aria-label="Project worktree"><div className="panel-header"><div className="tree-panel-title"><Icon name="tree" size={17}/><strong>Worktree</strong><span className="count-label">{graph.nodes.length} agents</span></div><div className="inline-actions"><button className="icon-button" title={view==='tree'?'Show chat beside tree':'Expand worktree'} aria-label={view==='tree'?'Show chat beside tree':'Expand worktree'} onClick={()=>setView(view==='tree'?'split':'tree')}><Icon name={view==='tree'?'minimize':'expand'} size={15}/></button><button className="icon-button" title="Close worktree" aria-label="Close worktree" onClick={()=>setView('chat')}><Icon name="close" size={16}/></button></div></div>
            <TreeCanvas graph={graph} liveStates={liveStates} onInspect={setTaskNodeId} onInbox={()=>openInbox(projectRun?.approvals.find(a=>a.status==='pending')?.id)} run={projectRun} runProgress={runProgress} allowances={allowances} onRecovery={node=>project.liveWorkflow||isRealAgent(graph.nodes.find(x=>x.id===node))?setToast('This agent runs on your own subscription. There is no per-use billing and no automatic fallback to another model.'):setDialog({kind:'recovery',node})} selected={selected} selectedEdge={selectedEdge} connecting={connecting} onSelect={selectNode} onSelectEdge={eid=>{setSelectedEdge(eid);setSelected(null);}} onBackground={()=>{setSelected(null);setSelectedEdge(null);}} onAdd={parent=>setDialog({kind:'add',parent})} onEdit={node=>setDialog({kind:'edit',node})} onMove={(nid,x,y)=>updateGraph({...graph,nodes:graph.nodes.map(n=>n.id===nid?{...n,x,y}:n)})}>
              <div className="canvas-toolbar">{canSetUpTeam&&<><button className="toolbar-text" title="Connect every demo agent to a signed-in tool" onClick={setupTeam}><Icon name="link" size={15}/> Use connected tools</button><span className="toolbar-divider"/></>}<button className="tool" title="Undo last tree change" aria-label="Undo last tree change" disabled={!history.length} onClick={undo}><Icon name="undo" size={17}/></button><span className="toolbar-divider"/><button className={`tool ${connecting?'tool-active':''}`} title="Connect selected agent" aria-label="Connect selected agent" onClick={()=>{if(!selectedNode){setToast('Select an agent, then click Connect.');return;}setConnecting(connecting?null:selectedNode.id);setToast('Click the agent this connection should lead to.');}}><Icon name="link" size={17}/></button>{selectedNode&&<><span className="toolbar-divider"/><button className="toolbar-text" onClick={()=>setDialog({kind:'edit',node:selectedNode.id})}><Icon name="settings" size={15}/> Configure</button>{selectedNode.role!=='Manager'&&<button className="tool danger" title="Remove selected agent" aria-label="Remove selected agent" onClick={()=>removeNode(selectedNode.id)}><Icon name="trash" size={16}/></button>}</>}{selectedEdge&&<button className="toolbar-text danger" onClick={()=>{updateGraph({...graph,edges:graph.edges.filter(e=>e.id!==selectedEdge)});setSelectedEdge(null);}}>Remove connection</button>}</div>
              {connecting&&<div className="connection-banner"><Icon name="link" size={14}/> Select the next agent <button onClick={()=>setConnecting(null)}>Cancel</button></div>}
            </TreeCanvas>
            <div className="tree-footer"><span><span className="status-dot"/>Demo agents · see individual status <span className="dot-separator">·</span> Demo configuration</span><span>+ adds a connected child</span></div>
          </section>}
        </div>
      </>}
      {page==='project'&&taskNodeId&&graph.nodes.find(n=>n.id===taskNodeId)&&<TaskDetails key={`${project.id}:${taskNodeId}`} node={graph.nodes.find(n=>n.id===taskNodeId)} tasks={workflowProject.tasks||[]} approvals={workflowProject.approvals||[]} run={projectRun} progress={runProgress} onClose={()=>setTaskNodeId(null)} onInbox={openInbox} onConfigure={()=>setDialog({kind:'edit',node:taskNodeId})} Icon={Icon}/>}
      </main>
      
      {activity&&<div className="activity-popover"><div className="dialog-heading"><h3>Project activity</h3><button className="icon-button" aria-label="Close activity" onClick={()=>setActivity(false)}><Icon name="close"/></button></div><p className="muted">{projectRun?.mode==='live'?'Live workflow — '+projectRun.phase:'Demo project activity'}</p><div className="activity-entry"><span className="mini-avatar green"><Icon name="tree" size={15}/></span><div><strong>Team ready to configure</strong><p>{graph.nodes.length} agents · {graph.edges.length} connections</p></div></div><p className="activity-footnote">Open Build & review for real workflow activity and evidence.</p></div>}
    </div>
    {dialog&&<Modal onClose={()=>setDialog(null)}>{['add','edit'].includes(dialog.kind)?<AgentForm models={liveModels} tools={chatProviders.filter(t=>t.installed&&t.subscription)} onTest={testAgent} key={`${dialog.kind}-${dialog.node||dialog.parent}`} node={dialog.kind==='edit'?graph.nodes.find(n=>n.id===dialog.node):null} parent={dialog.kind==='add'?graph.nodes.find(n=>n.id===dialog.parent):null} onSave={saveAgent} onClose={()=>setDialog(null)}/>:dialog.kind==='recovery'?<RecoveryForm node={graph.nodes.find(n=>n.id===dialog.node)} allowances={allowances} onSave={saveRecovery} onExhaust={exhaustDemo} onReset={resetDemo} onClose={()=>setDialog(null)}/>:dialog.kind==='project'?<ProjectForm onClose={()=>setDialog(null)} onSave={name=>{const p=makeProject(name);setProjects(ps=>[...ps,p]);switchProject(p.id);setView('chat');setDialog(null);setToast('Project created. Your worktree is ready.');}}/>:<ProviderDialog onClose={()=>setDialog(null)}/>}</Modal>}
    <UpdateDialog updates={updates} Icon={Icon}/>
    {shellDialog?.kind==='settings'&&<SettingsDialog tab={shellDialog.tab} onTab={tab=>setShellDialog({kind:'settings',tab})} onClose={()=>setShellDialog(null)} theme={theme} onTheme={setTheme} name={profileName} onName={setProfileName} updates={updates} appInfo={appInfo}/>}
    {shellDialog?.kind==='help'&&<HelpDialog onClose={()=>setShellDialog(null)}/>}
    {bootDone&&launch?.kind==='update'&&<UpdateIntro version={appInfo?.appVersion} previous={launch.previous} onDone={()=>setLaunch(l=>({...l,kind:'start'}))}/>}
    {toast&&<div className="toast" role="status"><Icon name="check" size={15}/>{toast}<button aria-label="Dismiss notification" onClick={()=>setToast('')}><Icon name="close" size={13}/></button></div>}
  </div>;
}

function TreeCanvas({graph,onInspect,onInbox,run,runProgress,allowances,onRecovery,selected,selectedEdge,connecting,onSelect,onSelectEdge,onBackground,onAdd,onEdit,onMove,children,liveStates}) {
  const viewport=useRef(null);
  const gesture=useRef(null);
  const justDragged=useRef(false);
  const [camera,setCamera]=useState({x:0,y:0,zoom:.7});
  const [drag,setDrag]=useState(null);
  useEffect(()=>{
    const el=viewport.current;
    function wheel(event){
      if(event.target.closest?.('.canvas-toolbar,.zoom-controls,.connection-banner,.demo-run-banner'))return;
      event.preventDefault();
      if(gesture.current)return;
      const rect=el.getBoundingClientRect();
      const point={x:event.clientX-rect.left,y:event.clientY-rect.top};
      setCamera(c=>wheelCamera(c,event,point,el.clientHeight));
    }
    el.addEventListener('wheel',wheel,{passive:false});
    return()=>el.removeEventListener('wheel',wheel);
  },[]);
  function fit(){const el=viewport.current;if(!el)return;const maxX=Math.max(...graph.nodes.map(n=>n.x+280));const maxY=Math.max(...graph.nodes.map(n=>n.y+195));const minX=Math.min(...graph.nodes.map(n=>n.x))-45;const minY=Math.min(...graph.nodes.map(n=>n.y))-65;const z=Math.min(1,(el.clientWidth-75)/(maxX-minX+45),(el.clientHeight-130)/(maxY-minY+45));setCamera({zoom:Math.max(.25,z),x:(el.clientWidth-(maxX-minX)*z)/2-minX*z,y:85-minY*z});}
  useEffect(()=>{const observer=new ResizeObserver(fit);observer.observe(viewport.current);return()=>observer.disconnect();},[graph.nodes.length]);
  const nodeAt=n=>drag?.id===n.id?{...n,x:drag.x,y:drag.y}:n;
  function down(e,node){justDragged.current=false;if(e.button!==0||e.target.closest('button'))return;if(node&&connecting){onSelect(node.id);return;}e.preventDefault();e.currentTarget.setPointerCapture(e.pointerId);gesture.current={kind:node?'node':'pan',id:node?.id,startX:e.clientX,startY:e.clientY,x:node?.x??camera.x,y:node?.y??camera.y,moved:false};if(node)onSelect(node.id);else onBackground();}
  function move(e){const g=gesture.current;if(!g)return;const dx=e.clientX-g.startX,dy=e.clientY-g.startY;if(Math.abs(dx)+Math.abs(dy)>3)g.moved=true;if(g.kind==='node')setDrag({id:g.id,x:Math.max(0,g.x+dx/camera.zoom),y:Math.max(0,g.y+dy/camera.zoom)});else setCamera(c=>({...c,x:g.x+dx,y:g.y+dy}));}
  function up(){const g=gesture.current;justDragged.current=Boolean(g?.moved);gesture.current=null;if(g?.kind==='node'&&g.moved&&drag)onMove(drag.id,Math.round(drag.x),Math.round(drag.y));setDrag(null);}
  function zoom(delta){const el=viewport.current;setCamera(c=>zoomAt(c,{x:el.clientWidth/2,y:el.clientHeight/2},c.zoom+delta));}
  return <div ref={viewport} className={`canvas ${connecting?'canvas-connecting':''}`} onPointerDown={e=>{if(e.target===e.currentTarget||e.target.classList.contains('canvas-ground'))down(e,null);}} onPointerMove={move} onPointerUp={up} onPointerCancel={()=>{gesture.current=null;setDrag(null);}}>
    <div className="canvas-ground"/>{children}{run&&<div className={`demo-run-banner ${run.phase}`}><span className="demo-running-dot"/>{run.phase==='running'?`${run.sequence[run.index].name} is ${demoStatus(run,run.sequence[run.index].id)}`:run.phase==='waiting'?'Waiting for your Manager decision':run.mode==='live'?run.phase.replaceAll('_',' '):run.phase==='completed'?'Demo complete':'Demo stopped'}{run.phase==='waiting'&&<button onClick={onInbox}>Open Manager inbox</button>}<span>{run.mode==='live'?'Subscription workflow — no generated code execution':'Simulation — no model requests'}</span></div>}<div className="canvas-world" style={{transform:`translate(${camera.x}px,${camera.y}px) scale(${camera.zoom})`}}><svg className="edges" width="5000" height="4000">{graph.edges.map(edge=>{const a=graph.nodes.find(n=>n.id===edge.from),b=graph.nodes.find(n=>n.id===edge.to);if(!a||!b)return null;const n=nodeAt(a),m=nodeAt(b);const x1=n.x+112,y1=n.y+158,x2=m.x+112,y2=m.y;const dy=Math.max(60,Math.abs(y2-y1)/2);const d=`M ${x1} ${y1} C ${x1} ${y1+dy},${x2} ${y2-dy},${x2} ${y2}`;return <g key={edge.id} className={`edge ${run?.phase==='running'&&run.sequence[run.index]?.id===edge.to?'edge-flowing':''} ${selectedEdge===edge.id?'edge-selected':''}`} onPointerDown={e=>e.stopPropagation()} onClick={()=>onSelectEdge(edge.id)}><path className="edge-hit" d={d}/><path className="edge-line" d={d}/><circle cx={x2} cy={y2} r="3.5"/></g>;})}</svg>{graph.nodes.map(original=>{const n=nodeAt(original);const state=liveStates?.[n.id]||demoStatus(run,n.id);const working=isWorking(state);const profile=activeProfile(n);const remaining=allowances[profile.provider];return <div key={n.id} className={`agent-node agent-state-${state} ${(n.backups||[]).length?'node-has-stack':''} ${n.recoveryPaused?'node-paused':''} ${selected===n.id?'node-selected':''} ${connecting&&n.id!==connecting?'node-connect-target':''}`} style={{left:n.x,top:n.y}} onPointerDown={e=>{e.stopPropagation();down(e,original);}} onPointerMove={move} onPointerUp={e=>{e.stopPropagation();up();}} onDoubleClick={()=>onEdit(n.id)} onClick={e=>{if(!justDragged.current&&!connecting&&!e.target.closest('button'))onInspect(n.id);}}>{working&&<span className="working-halo"/>}{!isRealAgent(n)&&<button className="node-allowance" title={`Demo ${profile.provider} allowance: ${remaining??'unknown'}${remaining==null?'':'%'} remaining. Shared account allowance, not live credits. Click to configure recovery.`} aria-label={`Allowance and backups for ${n.name}`} onPointerDown={e=>e.stopPropagation()} onClick={()=>onRecovery(n.id)}><AllowanceRing percent={remaining}/><span>DEMO</span></button>}<span className="node-port top-port"/><div className="node-heading"><span className={`node-avatar ${ROLE_COLOR[n.role]}`}><Icon name={ROLE_ICON[n.role]} size={19}/></span><div><span className="node-role">{n.role}{!isAgreedRole(n.role)&&' · not an agreed role'}</span><strong>{n.name}</strong></div><button className="node-menu" title={`Configure ${n.name}`} aria-label={`Configure ${n.name}`} onPointerDown={e=>e.stopPropagation()} onClick={()=>onEdit(n.id)}><Icon name="more" size={16}/></button></div><div className="node-model"><span className={`provider-dot provider-${profile.provider.toLowerCase()}`}/>{profile.provider}<span className="dot-separator">·</span>{profile.model.replace(' (demo)','')}{isRealAgent(n)&&n.agent.effort&&<><span className="dot-separator">·</span>{n.agent.effort}</>}</div><div className="node-bottom"><span><span className="status-dot"/>{state!=='idle'?state.replaceAll('_',' ').replace(/^./,c=>c.toUpperCase()):n.recoveryPaused?'Paused':profile.id!=='primary'?'Backup active':'Idle'}</span><span className="node-bottom-actions"><span>Priority {n.priority}</span><button className="node-task-button" title={`Task details for ${n.name}`} aria-label={`Task details for ${n.name}`} onPointerDown={e=>e.stopPropagation()} onClick={()=>onInspect(n.id)}><Icon name="panel" size={12}/></button></span></div><button className="node-recovery" onPointerDown={e=>e.stopPropagation()} onClick={()=>onRecovery(n.id)}><Icon name="grid" size={12}/>{isRealAgent(n)?'Your subscription':(n.backups||[]).length?`${n.backups.length} backup${n.backups.length===1?'':'s'} in stack`:'Add recovery stack'}<Icon name="chevron" size={10}/></button>{working&&<div className="agent-progress" aria-label={run?.mode==='live'?'Agent is working; percentage unavailable':`${Math.round(runProgress)}% simulated progress`}><span style={{width:`${runProgress}%`}}/></div>}<button className="node-add" title={`Add child agent to ${n.name}`} aria-label={`Add child agent to ${n.name}`} onPointerDown={e=>e.stopPropagation()} onClick={()=>onAdd(n.id)}><Icon name="plus" size={14}/></button></div>;})}</div><div className="canvas-help"><Icon name="tree" size={14}/>{connecting?'Click an agent to connect':'Drag agents to arrange your team'}<span>Double-click to configure</span></div><div className="zoom-controls"><button title="Zoom out" aria-label="Zoom out" onClick={()=>zoom(-.1)}>−</button><span>{Math.round(camera.zoom*100)}%</span><button title="Zoom in" aria-label="Zoom in" onClick={()=>zoom(.1)}>+</button><span className="toolbar-divider"/><button title="Fit tree to view" aria-label="Fit tree to view" onClick={fit}><Icon name="expand" size={14}/></button></div>
  </div>;
}

function Modal({children,onClose}) {const ref=useRef(null);useEffect(()=>{const previous=document.activeElement;const el=ref.current;el.querySelector('input,select,button')?.focus();const trap=e=>{if(e.key!=='Tab')return;const items=[...el.querySelectorAll('button:not([disabled]),input,select,textarea')];if(e.shiftKey&&document.activeElement===items[0]){e.preventDefault();items.at(-1)?.focus();}else if(!e.shiftKey&&document.activeElement===items.at(-1)){e.preventDefault();items[0]?.focus();}};el.addEventListener('keydown',trap);return()=>{el.removeEventListener('keydown',trap);previous?.focus();};},[]);return <div className="modal-scrim" onMouseDown={e=>{if(e.target===e.currentTarget)onClose();}}><div className="modal" role="dialog" aria-modal="true" aria-labelledby="dialog-title" ref={ref}>{children}</div></div>;}
function AgentForm({node,parent,onSave,onClose,models=MODELS,tools=[],onTest}) {
  const [role,setRole]=useState(node?.role||'');const [provider,setProvider]=useState(node?.provider||'');const [model,setModel]=useState(node?.model||'');const [name,setName]=useState(node?.name||'');const [priority,setPriority]=useState(node?.priority||1);const [run,setRun]=useState(()=>agentTarget(node)||{provider:'demo',model:null,effort:null});const real=run.provider!=='demo';const toolStatus=tools.find(t=>t.provider===run.provider);
  return <form onSubmit={e=>{e.preventDefault();if(!role)return;if(real){if(!toolStatus)return;onSave({name:name.trim()||role,role,...nodeFieldsFor(run,toolStatus),...(node?{priority:Number(priority)}:{})});}else if(provider&&model)onSave({name:name.trim()||role,role,provider,model,agent:null,...(node?{priority:Number(priority)}:{})});}}><div className="dialog-heading"><span className="dialog-icon"><Icon name={node?'settings':'plus'} size={21}/></span><button className="icon-button" type="button" aria-label="Close agent editor" onClick={onClose}><Icon name="close"/></button></div><h2 id="dialog-title">{node?'Configure agent':'A new teammate.'}</h2><p className="dialog-description">{node?'Give this agent a clear role in your project.':'Choose a role and a model. Your tree takes care of the connection.'}</p>{parent&&<div className="parent-chip"><Icon name="tree" size={14}/>{parent.name}<Icon name="chevron" size={12}/><span>New agent</span><span className="auto-label">Auto-connected</span></div>}<div className="form-fields"><label>Role<select value={role} disabled={node?.role==='Manager'} required onChange={e=>setRole(e.target.value)}><option value="" disabled>Choose a role</option>{(node?.role==='Manager'?['Manager']:node&&!isAgreedRole(node.role)?[node.role,...ROLES]:ROLES).map(r=><option key={r} value={r}>{isAgreedRole(r)?r:`${r} (not an agreed role)`}</option>)}</select></label><AgentRunsOn run={run} onChange={setRun} tools={tools}/>{!real&&<div className="field-row"><label>Provider<select required value={provider} onChange={e=>{setProvider(e.target.value);setModel('');}}><option value="" disabled>Choose a provider</option>{Object.keys(models).map(p=><option key={p}>{p}</option>)}</select></label><label>Model<select required value={model} disabled={!provider} onChange={e=>setModel(e.target.value)}><option value="" disabled>Choose a model</option>{(models[provider]||[]).map(m=><option key={m}>{m}</option>)}</select></label></div>}{real&&toolStatus&&<TryAgent run={run} onTest={onTest}/>}<label>Agent name <span className="optional">Optional</span><input maxLength={48} placeholder={role?`e.g. ${role==='Builder'?'Frontend builder':role}`:'Give your agent a name'} value={name} onChange={e=>setName(e.target.value)}/></label>{node&&<label>Role priority<input type="number" min="1" max="9999" required value={priority} onChange={e=>setPriority(e.target.value)}/><small>Lower numbers have higher priority. Each priority can be used once per role.</small></label>}</div><div className="form-note"><Icon name="link" size={14}/><span>{real?'Runs on your own subscription through the official tool. Nothing is billed per use.':'Demo agents never send a request to a model.'}</span></div><div className="dialog-footer"><button className="button" type="button" onClick={onClose}>Cancel</button><button className="button primary-button" type="submit" disabled={!role||(real?!toolStatus:(!provider||!model))}>{node?'Save changes':<><Icon name="plus" size={15}/>Add agent</>}</button></div></form>;
}
function AllowanceRing({percent,large=false}) {
  const known=typeof percent==='number'&&Number.isFinite(percent);
  const value=known?Math.max(0,Math.min(100,percent)):0;
  return <span className={`allowance-ring ${large?'ring-large':''} ${!known?'ring-unknown':value===0?'ring-empty':value<=20?'ring-low':''}`} style={{'--remaining':`${value}%`}}><span>{known?`${value}%`:'?'}</span></span>;
}
function RecoveryForm({node,allowances,onSave,onExhaust,onReset,onClose}) {
  const [backups,setBackups]=useState(()=>clone(node.backups||[]));
  const profile=activeProfile(node);
  const dirty=JSON.stringify(backups)!==JSON.stringify(node.backups||[]);
  const valid=backups.every(b=>b.provider&&b.model);
  function patch(bid,changes){setBackups(bs=>bs.map(b=>b.id===bid?{...b,...changes}:b));}
  function move(index,delta){setBackups(bs=>{const result=[...bs];[result[index],result[index+delta]]=[result[index+delta],result[index]];return result;});}
  return <form className="recovery-form" onSubmit={e=>{e.preventDefault();if(valid)onSave(node.id,backups);}}>
    <div className="dialog-heading"><span className="dialog-icon"><Icon name="grid" size={21}/></span><button className="icon-button" type="button" aria-label="Close recovery stack" onClick={onClose}><Icon name="close"/></button></div>
    <h2 id="dialog-title">A team behind each agent.</h2>
    <p className="dialog-description">{node.name} · {node.role}<br/>Choose who takes over when the active account’s allowance runs out.</p>
    <div className="allowance-summary"><AllowanceRing percent={allowances[profile.provider]} large/><div><strong>{profile.provider} allowance</strong><span>Demo value · shared by this provider’s agents</span><small>{node.recoveryPaused?'Paused — no available backup':profile.id==='primary'?'Primary model active':'Backup model active'} · {profile.model}</small></div><span className="demo-tag">DEMO</span></div>
    <div className="stack-title"><strong>Recovery order</strong><span>Same role. Same tree position.</span></div>
    <div className="primary-profile"><span className="order-number">1</span><div><strong>{node.provider}</strong><span>{node.model}</span></div><span className="primary-tag">Primary</span></div>
    <div className="backup-list">{backups.map((backup,index)=><div className={`backup-profile ${node.activeProfileId===backup.id?'backup-is-active':''}`} key={backup.id}>
      <div className="backup-profile-top"><span className="order-number">{index+2}</span><strong>Backup {index+1}</strong>{node.activeProfileId===backup.id&&<span className="backup-active-label">Active</span>}<span className="backup-row-actions"><button type="button" title={`Move backup ${index+1} up`} aria-label={`Move backup ${index+1} up`} disabled={index===0} onClick={()=>move(index,-1)}>↑</button><button type="button" title={`Move backup ${index+1} down`} aria-label={`Move backup ${index+1} down`} disabled={index===backups.length-1} onClick={()=>move(index,1)}>↓</button><button type="button" aria-label={`Remove backup ${index+1}`} onClick={()=>setBackups(bs=>bs.filter(b=>b.id!==backup.id))}><Icon name="close" size={13}/></button></span></div>
      <div className="field-row form-fields backup-fields"><label>Provider<select aria-label={`Backup ${index+1} provider`} required value={backup.provider} onChange={e=>patch(backup.id,{provider:e.target.value,model:''})}><option value="" disabled>Choose a provider</option>{Object.keys(MODELS).map(p=><option key={p}>{p}</option>)}</select></label><label>Model<select aria-label={`Backup ${index+1} model`} required disabled={!backup.provider} value={backup.model} onChange={e=>patch(backup.id,{model:e.target.value})}><option value="" disabled>Choose a model</option>{(MODELS[backup.provider]||[]).map(m=><option key={m}>{m}</option>)}</select></label></div>
      {backup.provider&&<div className="backup-allowance"><AllowanceRing percent={allowances[backup.provider]}/><span>{allowances[backup.provider]??'Unknown'}{typeof allowances[backup.provider]==='number'?'% demo allowance remaining':''}</span>{profilesFor({...node,backups:backups.slice(0,index)}).some(p=>p.provider===backup.provider)&&<small>Shares an earlier account’s allowance</small>}</div>}
    </div>)}</div>
    <button className="add-backup" type="button" onClick={()=>setBackups(bs=>[...bs,{id:id(),provider:'',model:''}])}><Icon name="plus" size={15}/> Add backup model</button>
    <p className="recovery-explanation">At zero allowance, try the next available backup in this order. If none is available, pause and report in Manager chat. This preview simulates handoff; it does not resume real tasks or enable API billing.</p>
    <details className="recovery-demo"><summary>Try recovery with demo allowances</summary><p>Only saved stacks are used. Exhausting an account affects every agent using that provider. Unknown allowance never triggers an automatic switch.</p><div><button className="button" type="button" disabled={dirty} onClick={()=>onExhaust(profile.provider)}>Simulate {profile.provider} exhausted</button><button className="button" type="button" disabled={dirty} onClick={onReset}>Reset demo</button></div>{dirty&&<small>Save this stack, then reopen to test it.</small>}</details>
    <div className="dialog-footer"><button className="button" type="button" onClick={onClose}>Cancel</button><button className="button primary-button" type="submit" disabled={!valid}>Save recovery stack</button></div>
  </form>;
}
function ProjectForm({onSave,onClose}){const [name,setName]=useState('');return <form onSubmit={e=>{e.preventDefault();if(name.trim())onSave(name.trim());}}><div className="dialog-heading"><span className="dialog-icon"><Icon name="folder" size={21}/></span><button className="icon-button" type="button" aria-label="Close new project" onClick={onClose}><Icon name="close"/></button></div><h2 id="dialog-title">Room for your next idea.</h2><p className="dialog-description">Every project gets its own conversation and worktree.</p><div className="form-fields"><label>Project name<input value={name} onChange={e=>setName(e.target.value)} placeholder="e.g. My next app" maxLength={50} required/></label></div><div className="dialog-footer"><button className="button" type="button" onClick={onClose}>Cancel</button><button className="button primary-button" type="submit" disabled={!name.trim()}>Create project</button></div></form>;}
function ProviderDialog({onClose}){return <><div className="dialog-heading"><span className="dialog-icon"><Icon name="link" size={21}/></span><button className="icon-button" aria-label="Close providers" onClick={onClose}><Icon name="close"/></button></div><h2 id="dialog-title">Bring your own intelligence.</h2><p className="dialog-description">Choose providers for your agents in the tree. Simulated — no provider is connected in this build, and no models are verified.</p><div className="provider-list">{Object.entries(MODELS).map(([p,models])=><div key={p}><span className={`provider-dot provider-${p.toLowerCase()}`}/><strong>{p}</strong><span>{models[0].replace(' (demo)','')}</span><span className="provider-preview">Preview only</span></div>)}</div><p className="form-note">Nothing here signs you in or sends a request. 0rqestra never asks for your provider password.</p><div className="dialog-footer"><button className="button primary-button" onClick={onClose}>Got it</button></div></>;}


createRoot(document.getElementById('root')).render(<App/>);
