import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './app.css';
import { zoomAt, wheelCamera } from './camera.mjs';
import { AGREED_ROLES, isAgreedRole, canConnect, nextPriority, priorityConflict } from './tree-rules.mjs';
import {useUpdates,UpdateDialog} from './UpdateDialog.jsx';
import {prepareForUpdate} from './update-gate.mjs';
import {PROJECTS_KEY,readStored} from './storage-keys.mjs';
import {DEMO_REMOVED_KEY,cleanDemoStorage,migrateProject} from './migrate-demo.mjs';
import {ProfileMenu,SettingsDialog,HelpDialog,UpdateIntro} from './Shell.jsx';
import {readTheme,applyTheme} from './theme.mjs';
import {readLaunch,dismissBoot} from './launch.mjs';
import {ChatTargetPicker,MessageActions,AssistantMessage} from './LiveChat.jsx';
import {readTarget,saveTarget,effectiveTarget,historyFor,newAssistant,applyChatEvent,settleInterrupted,parsePlanRequest,plannerOf,replanMessage,planningUsage,parseRemember,addMemory,directPlanFor,undoableRunId,placeProducts,mergeProducts,readProblem,addProblem,problemsFor,fixMessage,editMessage,isRealAgent,autoTeam,mixTeam,usesOneTool,onlyManager,starterTeam,teamNeedsSetup,readyProviders,teamMembers,teamAgents,planAssignments,newTeamRun,applyTeamEvent,nodeStates,agentTarget,nodeFieldsFor,agentBadge,TEST_PROMPT,isTerminal,greeting} from './live-chat.mjs';
import {AgentRunsOn,TryAgent} from './AgentRuntime.jsx';
import {PlanCard,TeamRunCard,PlannerCard} from './TeamRun.jsx';
import {ProductNode,ProductPreview} from './Preview.jsx';
import {UsagePanel} from './Activity.jsx';
import {AgentPanel} from './AgentPanel.jsx';
import {MemoryDialog} from './Memory.jsx';
import {chatList,ensureGeneral,GENERAL_ID,isGeneral,removeChat,startChat,switchChat} from './chats.mjs';
import {AttachMenu,PendingAttachments,SentAttachments,attachFiles,handlePaste,MAX_ATTACHMENTS} from './Attachments.jsx';
import {arrangeTree} from './tree-layout.mjs';
import {AccountsPage} from './AccountsSetup.jsx';
import {TeamsPage} from './TeamsPage.jsx';
import {AccountLoading,AccountWelcome} from './AccountWelcome.jsx';
import {ACCOUNT_CHOICE_KEY,accountLabel,gateState} from './account-ui.mjs';
import {BridgePanel,TeamAskBar,TeamInfoMessage,TeamOverlay,overlayBoxes} from './TeamBridge.jsx';
import {displayName,linkedTeamProject,memberStatus,waitingCount} from './teams-ui.mjs';
import {FriendsPage} from './FriendsPage.jsx';
import {ProjectMenu,ProjectActionDialog,RenameProjectForm} from './ProjectMenu.jsx';
import {AGENT_LIBRARY_KEY,isRunning,readLibrary,renameProject,retireAgents,teamLinkFor,withoutProject} from './project-removal.mjs';
import {ComputerAccess} from './ComputerAccess.jsx';
import {DEFAULT_RATIO,DIVIDER,chatWidth,fitsSplit,ratioAt,ratioForKey,readLayout,saveLayout,shownView} from './pane-layout.mjs';
import {catchUpDue,catchUpMessage,statusPrompt,statusSource,statusSummary,withCatchUp} from './team-catchup.mjs';

const ICONS = {
  tree: <><path d="M12 3v5m-7 4V8h14v4M5 16v5m14-5v5M12 8v10"/><rect x="2" y="12" width="6" height="4" rx="1"/><rect x="16" y="12" width="6" height="4" rx="1"/><rect x="9" y="18" width="6" height="4" rx="1"/></>,
  chat: <path d="M20 11a8 8 0 0 1-8 8H5l-4 3 2-7a8 8 0 1 1 17-4Z"/>,
  globe: <><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z"/></>,
  desktop: <><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8m-4-4v4"/></>,
  phone: <><rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18h2"/></>,
  cursor: <path d="M5 3l14 7-6 2-2 6L5 3Z"/>,
  arrange: <><rect x="9" y="3" width="6" height="4" rx="1"/><rect x="3" y="17" width="6" height="4" rx="1"/><rect x="15" y="17" width="6" height="4" rx="1"/><path d="M12 7v5M6 17v-5h12v5"/></>,
  clip: <path d="M20.5 11.5 12.4 19.6a5 5 0 0 1-7.1-7.1l8.5-8.5a3.4 3.4 0 0 1 4.8 4.8l-8.5 8.5a1.8 1.8 0 0 1-2.5-2.5l7.8-7.8"/>,
  refresh: <path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6"/>,
  plus: <path d="M12 5v14M5 12h14"/>,
  copy: <><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5"/></>,
  edit: <path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-4-4L4 16v4ZM13.5 6.5l4 4"/>,
  retry: <path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>,
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
  hideLeft: <><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M9 3v18m7-12-3 3 3 3"/></>,
  hideRight: <><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M15 3v18M8 9l3 3-3 3"/></>,
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
const ROLE_COLOR = {Manager:'green',Planner:'blue',Builder:'violet','Code Reviewer':'amber',Debugger:'pink','Security Reviewer':'teal',Reviewer:'amber',Tester:'teal',Researcher:'blue',Database:'teal',Designer:'pink',Documentation:'amber',Security:'pink'};
const ROLE_ICON = {Manager:'tree',Planner:'grid',Builder:'code','Code Reviewer':'check',Debugger:'search','Security Reviewer':'check',Reviewer:'check',Tester:'check',Researcher:'search',Database:'folder',Designer:'spark',Documentation:'folder',Security:'check'};
const id = () => crypto.randomUUID();
const clone = (x) => JSON.parse(JSON.stringify(x));
// A new project starts with its Manager only; the user adds agents and chooses their tools.
function initialGraph() { return { nodes:[{id:'manager',name:'Manager',role:'Manager',priority:1,x:410,y:75,agent:null}], edges:[] }; }
const makeProject = (name) => ({id:id(),name,graph:initialGraph(),messages:[]});
// Saved projects are kept. Anything left from the removed Demo mode is cleaned up once
// (migrate-demo.mjs); `demoWasRemoved` tells the window to explain that once.
let demoWasRemoved=false;
function loadWorkspace() {
  let stored=null;
  try { const v=JSON.parse(readStored(localStorage,PROJECTS_KEY)); if(Array.isArray(v) && v.length && v.every(p=>typeof p.id==='string' && typeof p.name==='string' && Array.isArray(p.graph?.nodes) && Array.isArray(p.graph?.edges) && Array.isArray(p.messages))) stored=v; } catch { /* Unavailable or unreadable storage: a fresh workspace. */ }
  try { if(cleanDemoStorage(localStorage,stored||[])&&!localStorage.getItem(DEMO_REMOVED_KEY)){demoWasRemoved=true;localStorage.setItem(DEMO_REMOVED_KEY,'1');} } catch { /* nothing to clean */ }
  if(stored) return ensureGeneral(stored.map(p=>migrateProject({...p,messages:settleInterrupted(p.messages)})));
  return ensureGeneral([makeProject('My first project')]);
}
const isWorking=state=>['working','reviewing'].includes(state);
// canConnect comes from tree-rules.mjs (D1: cycles between specialists are allowed).

function App() {
  const [projects,setProjects]=useState(loadWorkspace);
  const [activeId,setActiveId]=useState(projects[0].id);
  const project=projects.find(p=>p.id===activeId)||projects[0];
  const graph=project.graph;
  // "Ask anything": questions that belong to no project, answered by the Manager alone (chats.mjs).
  const general=isGeneral(project);
  // Workspace layout (pane-layout.mjs): which panes show, the chat's share of a split, and the sidebar. Saved across restarts.
  const [initialLayout]=useState(()=>{try{return readLayout(localStorage);}catch{return readLayout(null);}});
  const [view,setView]=useState(initialLayout.view);
  const [chatRatio,setChatRatio]=useState(initialLayout.chatRatio);
  // Each project's tree camera (zoom and position), so hiding and showing the tree keeps the view.
  const cameras=useRef({});
  const [productsByProject,setProductsByProject]=useState({});
  const [previewId,setPreviewId]=useState(null);
  const [agentPanelId,setAgentPanelId]=useState(null);
  // Files and images waiting to be sent with the next message, per project (Attachments.jsx).
  const [pendingFiles,setPendingFiles]=useState({});
  const [previewVersion,setPreviewVersion]=useState(0);
  // Apps the team built, running in the sandbox (main/sandbox): per project, per product, its host and status.
  const [appsByProject,setAppsByProject]=useState({});
  const [previewProblems,setPreviewProblems]=useState({});
  const [selected,setSelected]=useState(null);
  const [selectedEdge,setSelectedEdge]=useState(null);
  const [connecting,setConnecting]=useState(null);
  const [dialog,setDialog]=useState(null);
  const [agentLibrary,setAgentLibrary]=useState(()=>{try{return readLibrary(localStorage);}catch{return [];}});
  useEffect(()=>{try{localStorage.setItem(AGENT_LIBRARY_KEY,JSON.stringify(agentLibrary));}catch{/* kept for this session */}},[agentLibrary]);
  const [toast,setToast]=useState('');
  const updates=useUpdates();
  const [input,setInput]=useState('');
  const [history,setHistory]=useState([]);
  const [navOpen,setNavOpen]=useState(initialLayout.navOpen);
  useEffect(()=>{try{saveLayout(localStorage,{view,chatRatio,navOpen});}catch{/* kept for this session */}},[view,chatRatio,navOpen]);
  // The width the two panes share, measured so a saved split fits the window it opens in.
  const [panelsWidth,setPanelsWidth]=useState(0);
  const panelsEl=useRef(null);const panelsObserver=useRef(null);const chatPanelEl=useRef(null);const resizing=useRef(null);
  const panelsRef=useCallback(el=>{panelsObserver.current?.disconnect();panelsObserver.current=null;panelsEl.current=el;if(el&&typeof ResizeObserver!=='undefined'){const ro=new ResizeObserver(entries=>{const w=entries[0]?.contentRect?.width;if(w)setPanelsWidth(Math.round(w));});ro.observe(el);panelsObserver.current=ro;}},[]);
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
  const [page,setPage]=useState('project');
  // Teams: the main process sends the whole Teams view (sign-in, teams, links, presence) on every change.
  const [teamsView,setTeamsView]=useState(null);
  const [bridgeOpen,setBridgeOpen]=useState(false);
  const linkedTeam=linkedTeamProject(teamsView,project.id);
  // The 0rqestra account (the same account Teams uses). Until the saved session has been read the
  // window shows a short loading state, so a returning user never sees the welcome screen flash.
  const [teamsLoaded,setTeamsLoaded]=useState(false);
  const [accountChoice,setAccountChoice]=useState(()=>{try{return localStorage.getItem(ACCOUNT_CHOICE_KEY);}catch{return null;}});
  const [gateOpen,setGateOpen]=useState(false);
  const [dismissedEnd,setDismissedEnd]=useState(false);
  useEffect(()=>{const api=window.orqestra?.teams;if(!api){setTeamsLoaded(true);return undefined;}api.subscribe(m=>{if(m?.view?.status)setTeamsView(m.view);});const fallback=setTimeout(()=>setTeamsLoaded(true),4000);(async()=>{try{setTeamsView(await api.status(false));setTeamsLoaded(true);setTeamsView(await api.status(true));}catch{setTeamsLoaded(true);/* Teams shows the problem on its page. */}})();
    // Back online: check the session again (a refresh, or the server ending it) and reload Teams.
    const online=()=>{api.status(true).then(v=>v?.status&&setTeamsView(v)).catch(()=>{});};window.addEventListener('online',online);
    return()=>{clearTimeout(fallback);window.removeEventListener('online',online);};},[]);
  useEffect(()=>{if(teamsView?.status==='signed_in'){setGateOpen(false);setDismissedEnd(false);}},[teamsView?.status]);
  const gate=gateOpen&&teamsView?.status!=='signed_in'?'welcome':gateState({loaded:teamsLoaded,view:teamsView,choice:accountChoice,dismissedEnd});
  function continueLocal(){try{localStorage.setItem(ACCOUNT_CHOICE_KEY,'local');}catch{/* the choice lasts this session */}setAccountChoice('local');setGateOpen(false);if(teamsView?.status==='code_sent')window.orqestra?.teams?.cancelCode().then(v=>v?.status&&setTeamsView(v)).catch(()=>{});}
  // Signing out clears the account and Teams; local projects and settings stay.
  async function signOutAccount(){try{const v=await window.orqestra.teams.signOut();setTeamsView(v);}catch{/* signed out locally anyway */}try{localStorage.removeItem(ACCOUNT_CHOICE_KEY);}catch{/* ignore */}setAccountChoice(null);setToast('Signed out. Your local projects are still here.');}
  // Real chat (main/chat-ipc.ts): which tools are ready, which one answers, and the replies being written.
  const [chatProviders,setChatProviders]=useState([]);
  // The latest statuses for callbacks set up once (the Planner's request after a reply).
  const providersRef=useRef([]);providersRef.current=chatProviders;
  const [providersLoading,setProvidersLoading]=useState(false);
  // The products the team built in a project's folder (main/preview/products.ts). Only the main process reads the folder.
  // The preview reloads when a product's files changed: after the team wrote files, or when the window gets focus again.
  const productStamps=useRef({});
  function refreshProducts(projectId,changed){const team=window.orqestra?.team;if(!team?.products)return;team.products(projectId).then(info=>{if(!info||!Array.isArray(info.products))return;const stamp=info.products.map(p=>`${p.id}:${p.updatedAt}`).join('|');const before=productStamps.current[projectId];productStamps.current[projectId]=stamp;setProductsByProject(all=>({...all,[projectId]:{host:info.host,products:info.products}}));if(changed||(before!==undefined&&before!==stamp)){for(const p of info.products)if(p.kind==='app')team.appSync?.({projectId,productId:p.id}).catch(()=>{});setPreviewVersion(v=>v+1);setPreviewProblems(all=>({...all,[projectId]:[]}));}}).catch(()=>{});}
  async function refreshProviders(refresh){if(!window.orqestra?.chat)return;setProvidersLoading(true);try{const list=await window.orqestra.chat.providers(refresh===true);setChatProviders(Array.isArray(list)?list:[]);}catch{/* AI accounts shows the problem on the next check. */}finally{setProvidersLoading(false);}}
  useEffect(()=>{void refreshProviders(false);},[]);
  const [chatTarget,setChatTarget]=useState(()=>readTarget(localStorage));
  // The Manager's tool, model and effort are the Manager node's own settings, so the box under the chat
  // and the agent editor always agree. Older projects fall back to the last choice made in the box.
  const managerNode=graph.nodes.find(n=>n.role==='Manager');
  const target=effectiveTarget(agentTarget(managerNode)||chatTarget,chatProviders);
  function changeTarget(next){
    setChatTarget(next);saveTarget(localStorage,next);
    if(!managerNode)return;
    const status=chatProviders.find(t=>t.provider===next.provider);
    patchProject({graph:{...graph,nodes:graph.nodes.map(n=>n.id===managerNode.id?{...n,...nodeFieldsFor(next,status,'Manager')}:n)}});
  }
  // AI accounts: choose a connected tool for the Manager or for one agent, with the tool's default model.
  function defaultModel(status){const m=(status?.models||[]).find(x=>x.isDefault)||(status?.models||[])[0];return m?m.id:null;}
  // One step: every agent without a tool gets a connected tool (reviewers on another tool when there is one).
  // Both tools connected but the whole team on one: move each role to the tool that suits it (undo restores).
  function mixTools(){const {graph:next,changed}=mixTeam(graph,chatProviders);if(!changed.length){setToast('The team already uses both tools.');return;}if(runningTeam){setToast('Stop the team run before changing the team.');return;}setHistory(h=>[...h.slice(-29),clone(graph)]);patchProject({graph:next});setToast(`${changed.map(c=>`${c.name} → ${c.tool}`).join(', ')}. Claude and ChatGPT now work together.`);}
  // A project with only its Manager: one click gives it a starting team on the connected tools, arranged.
  function createTeam(){const {graph:next,changed}=starterTeam(graph,chatProviders);if(!changed.length){setToast('Connect Claude Code or Codex first, in AI accounts.');return;}const at=arrangeTree(next);setHistory(h=>[...h.slice(-29),clone(graph)]);patchProject({graph:{...next,nodes:next.nodes.map(n=>at[n.id]?{...n,...at[n.id]}:n)}});setFitKey(k=>k+1);setToast('Your team is ready: a Planner, two Builders and a reviewer. Ask the Manager to build something and watch them work in the team tree.');}
  function setupTeam(){const {graph:next,changed}=autoTeam(graph,chatProviders);if(!changed.length){setToast('Every agent already runs on Claude Code or Codex.');return;}patchProject({graph:next});setToast(`Team set up: ${changed.map(c=>`${c.name} → ${c.tool}`).join(', ')}. You can change any agent in the tree.`);}
  const canSetUpTeam=readyProviders(chatProviders).length>0&&graph.nodes.some(n=>!isRealAgent(n));
  function useToolForManager(provider){const status=chatProviders.find(t=>t.provider===provider);if(!status)return;changeTarget({provider,model:defaultModel(status),effort:null});setToast(`Your Manager now answers with ${status.name}.`);}
  function useToolForAgent(nodeId,provider){const status=chatProviders.find(t=>t.provider===provider);const node=graph.nodes.find(n=>n.id===nodeId);if(!status||!node)return;patchProject({graph:{...graph,nodes:graph.nodes.map(n=>n.id===nodeId?{...n,...nodeFieldsFor({provider,model:defaultModel(status),effort:null},status)}:n)}});setToast(`${node.name} now runs on ${status.name}.`);}
  // "Try this agent": one short real request with this tool, model and effort. It never touches the chat.
  // Claude Code reports the 5-hour and weekly usage only while it answers, so "Check now" sends one tiny message.
  function checkClaudeUsage(done){
    const status=chatProviders.find(t=>t.provider==='claude');const model=status?.models?.find(m=>/haiku/i.test(m.id))?.id||'haiku';
    const handle=testAgent({provider:'claude',model,effort:null},event=>{if(isTerminal(event)){void refreshProviders(false).finally(done);}});
    if(!handle)done();
  }
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
  useEffect(()=>{const chat=window.orqestra?.chat;if(!chat)return;chat.subscribe(message=>{const r=replies.current.get(message?.requestId);if(!r)return;if(r.onEvent){r.onEvent(message.event);if(isTerminal(message.event)){replies.current.delete(message.requestId);void refreshProviders(false);}return;}updateReply(r.projectId,r.messageId,message.event);if(isTerminal(message.event)){endReply(message.requestId,r.projectId);void refreshProviders(false);if(message.event.type==='completed'){const remembered=parseRemember(message.event.text);if(remembered.facts.length)setProjects(ps=>ps.map(p=>p.id===r.projectId?{...p,memory:addMemory(p.memory,remembered.facts)}:p));const brief=parsePlanRequest(remembered.text).brief;if(brief)requestPlan(r.projectId,r.messageId,brief);}}});},[]);
  // AI accounts reads the tools itself and hands the result back (onProvidersChanged).
  // Teams: a teammate can link a checkout to a new local project named after the shared project.
  function createLinkedProject(name){const next=makeProject(String(name).slice(0,50)||'Shared project');setProjects(ps=>[...ps,next]);return next.id;}
  // Once, after Demo mode was removed: say so, and where to choose a real tool.
  useEffect(()=>{if(demoWasRemoved){demoWasRemoved=false;setToast('Demo mode was removed. Your projects and chats are kept; choose Claude Code or Codex in AI accounts for your Manager and agents.');}},[]);
  const [saved,setSaved]=useState(true);
  // Teams phase 4: the catch-up in each linked project's chat. A project is checked once per
  // account and session, and again whenever its connection comes back after a failed check.
  // Revisions are marked seen only after the message is in the chat and saved on this computer.
  const catchUp=useRef({checked:new Set(),inflight:new Set(),wasLive:{},pending:new Map(),marking:new Set()});
  const teammateCache=useRef({});
  const projectsRef=useRef(projects);projectsRef.current=projects;
  const [catchUpTick,setCatchUpTick]=useState(0);
  useEffect(()=>{const api=window.orqestra?.teams;if(typeof api?.catchUp!=='function'||teamsView?.status!=='signed_in'||!teamsView.userId)return;const me=teamsView.userId;const c=catchUp.current;
    for(const team of teamsView.teams||[])for(const sp of team.projects||[]){
      if(sp.link?.state!=='linked')continue;const local=projectsRef.current.find(p=>p.id===sp.link.localProjectId);if(!local)continue;
      const key=`${me}:${sp.id}`;if(!catchUpDue(c,key,teamsView.presence?.[sp.id]?.connection==='live'))continue;
      c.inflight.add(key);
      (async()=>{
        // Catch-ups kept on disk that this chat lost (for example after a crash) come back first.
        if(typeof api.keptCatchUps==='function'&&!c.restored?.has(key)){(c.restored||(c.restored=new Set())).add(key);try{const kept=await api.keptCatchUps();for(const k of kept||[])if(k.localProjectId===local.id&&k.message?.sharedProjectId===sp.id)setProjects(ps=>ps.map(p=>p.id!==local.id?p:{...p,messages:withCatchUp(p.messages,k.message)}));}catch{/* nothing kept */}}
        const r=await api.catchUp(sp.id);if(!r?.ok)return;c.checked.add(key);if(!r.items.length)return;
        const msg=catchUpMessage(sp.id,sp.name,r.items);
        setProjects(ps=>ps.map(p=>p.id!==local.id?p:{...p,messages:withCatchUp(p.messages,msg)}));
        // Marked seen only once the message is safely on disk; otherwise it stays eligible.
        let kept=typeof api.keepCatchUp!=='function';try{if(!kept)kept=await api.keepCatchUp(local.id,msg);}catch{kept=false;}
        if(!kept)return;
        c.pending.set(msg.id,{userId:me,sharedProjectId:sp.id,localId:local.id,items:r.items.map(i=>({id:i.id,seq:i.seq}))});setCatchUpTick(t=>t+1);
      })().catch(()=>{}).finally(()=>c.inflight.delete(key));
    }
  },[teamsView]);
  useEffect(()=>{const api=window.orqestra?.teams;if(typeof api?.markSeen!=='function'||!saved||teamsView?.status!=='signed_in')return;const c=catchUp.current;
    for(const [msgId,entry] of c.pending){
      if(entry.userId!==teamsView.userId||c.marking.has(msgId))continue;
      const shown=projects.find(p=>p.id===entry.localId)?.messages.some(m=>m.id===msgId);if(!shown)continue;
      c.marking.add(msgId);api.markSeen(entry.sharedProjectId,entry.items).then(ok=>{if(ok)c.pending.delete(msgId);}).catch(()=>{}).finally(()=>c.marking.delete(msgId));
    }
  },[projects,saved,catchUpTick,teamsView]);
  // "What is [name] working on?": read-only. With a connected tool the Manager explains it from the
  // brief fields; otherwise (or if that fails) a summary of the same fields is shown.
  async function askTeammate(member){
    if(!linkedTeam||!window.orqestra?.teams)return;const sp=linkedTeam.project;const projectId=project.id;const me=teamsView.userId;
    const name=displayName(member.name);const presence=memberStatus(teamsView,sp.id,member.userId);const cacheKey=`${me}:${sp.id}:${member.userId}`;
    let result;try{result=await window.orqestra.teams.teammateWork(sp.id,member.userId);}catch(error){result={ok:false,problem:String(error?.message||error)};}
    if(result?.ok)teammateCache.current[cacheKey]={items:result.items,at:result.at};
    const known=sp.briefs?.filter(b=>b.authorId===member.userId);const fallbackCache=teammateCache.current[cacheKey]||(known&&teamsView.briefsAt?.[sp.id]?{items:known,at:teamsView.briefsAt[sp.id]}:null);
    const data=statusSource(result,fallbackCache);const summary=statusSummary(name,data,presence);const question=`What is ${name} working on?`;
    const canAsk=toolReady&&readyProviders(chatProviders).some(s=>s.provider===target.provider);
    if(!canAsk||data.source==='none'||replying[projectId]){setProjects(ps=>ps.map(p=>p.id!==projectId?p:{...p,messages:[...p.messages,{id:id(),kind:'user',text:question},{id:id(),kind:'teamInfo',infoType:'status',text:summary}]}));return;}
    const requestId=id();const messageId=id();
    setProjects(ps=>ps.map(p=>p.id!==projectId?p:{...p,messages:[...p.messages,{id:id(),kind:'user',text:question},{...newAssistant(messageId,target),readOnly:true,fallback:summary}]}));
    replies.current.set(requestId,{projectId,messageId});setReplying(x=>({...x,[projectId]:requestId}));
    // No history and no team: the Manager gets no planning instructions for this request.
    window.orqestra.chat.send({requestId,projectId,provider:target.provider,model:target.model,effort:target.effort,history:[],text:statusPrompt(name,data,presence),team:[]}).catch(error=>{endReply(requestId,projectId);updateReply(projectId,messageId,{type:'failed',reason:'provider_error',message:String(error?.message||error).replace(/^Error invoking remote method '[^']+': (Error: )?/,''),text:''});});
  }
  const chatEnd=useRef(null);
  useEffect(()=>{try {localStorage.setItem(PROJECTS_KEY,JSON.stringify(projects));setSaved(true);}catch {setSaved(false);}},[projects]);
  useEffect(()=>{if(!toast)return;const timer=setTimeout(()=>setToast(''),4500);return()=>clearTimeout(timer);},[toast]);
  // The chat follows a reply as it is written only while you are at the bottom; scrolled up, it stays put
  // and "Jump to latest" brings you back. Sending a message always goes to the bottom.
  const chatScroll=useRef(null);const stick=useRef(true);const [atBottom,setAtBottom]=useState(true);
  function onChatScroll(){const el=chatScroll.current;if(!el)return;const near=el.scrollHeight-el.scrollTop-el.clientHeight<80;stick.current=near;if(near!==atBottom)setAtBottom(near);}
  function toBottom(smooth){const el=chatScroll.current;if(!el)return;stick.current=true;setAtBottom(true);el.scrollTo({top:el.scrollHeight,behavior:smooth?'smooth':'auto'});}
  useEffect(()=>{stick.current=true;setAtBottom(true);requestAnimationFrame(()=>toBottom(false));},[project.id,project.chatId]);
  useEffect(()=>{if(project.messages.at(-1)?.kind==='user')stick.current=true;if(stick.current){const el=chatScroll.current;if(el)el.scrollTop=el.scrollHeight;}},[project.messages.length,project.messages.at(-1)?.text?.length,project.messages.at(-1)?.status]);
  // Called by the main process before installing an update (main/update/index.ts). Saves the
  // projects and refuses while a run is active, saying what must finish or stop first.
  useEffect(()=>{
    window.__orqestraPrepareUpdate=()=>prepareForUpdate({projects,runs:projects.flatMap(p=>p.messages.filter(m=>m.kind==='team'&&m.run).map(m=>({projectId:p.id,status:m.run.status}))),storage:localStorage});
    return ()=>{delete window.__orqestraPrepareUpdate;};
  });
  function patchProject(patch) {setProjects(ps=>ps.map(p=>p.id===project.id?{...p,...patch}:p));}
  function updateGraph(next,remember=true) {if(runningTeam){setToast('Stop the team run before editing this tree.');return;}if(remember)setHistory(h=>[...h.slice(-29),clone(graph)]);patchProject({graph:next});}
  // The sidebar's project menu. Removing or unlinking only drops the app's entry and links; the
  // folder, its Git working tree and the GitHub repository stay (see ProjectMenu.jsx).
  function projectAction(kind,p){
    if(kind==='open'){void window.orqestra?.team?.openFolder(p.id);return;}
    setDialog({kind:`project-${kind}`,projectId:p.id});
  }
  async function stopProjectWork(pid){
    const team=window.orqestra?.team;
    if(replying[pid])await window.orqestra?.chat?.stop(replying[pid]).catch(()=>{});
    await team?.stopProject?.(pid);
    for(const [runId,r] of teamRuns.current)if(r.projectId===pid)await team?.stop(runId).catch(()=>false);
  }
  async function removeProject(p){
    const teams=window.orqestra?.teams;const link=teamLinkFor(teamsView,p.id);
    await window.orqestra?.team?.appStopProject?.(p.id).catch(()=>{});
    if(link&&teams)setTeamsView(await teams.unlink(link.project.id));
    await window.orqestra?.access?.forgetProject?.(p.id).catch(()=>{});
    setAgentLibrary(lib=>retireAgents(lib,p));
    const next=withoutProject(projects,p.id,activeId,GENERAL_ID);
    setProjects(next.projects);if(next.activeId!==activeId)switchProject(next.activeId);
    setDialog(null);setToast(`“${p.name}” was removed from 0rqestra. Its folder and Git changes are still on this computer.`);
  }
  async function unlinkProject(p){
    const link=teamLinkFor(teamsView,p.id);if(!link)return setDialog(null);
    setTeamsView(await window.orqestra.teams.unlink(link.project.id));
    setDialog(null);setToast(`Your checkout is unlinked. ${link.project.name} is still shared with ${link.team.name}.`);
  }
  async function removeFromTeam(p){
    const link=teamLinkFor(teamsView,p.id);if(!link)return setDialog(null);
    setTeamsView(await window.orqestra.teams.removeSharedProject(link.project.id));
    setDialog(null);setToast(`${link.project.name} is no longer shared with ${link.team.name}. Every checkout stays.`);
  }
  function switchProject(pid){setBridgeOpen(false);setPage('project');setActiveId(pid);setSelected(null);setSelectedEdge(null);setConnecting(null);setHistory([]);}
  function undo(){if(runningTeam){setToast('Stop the team run before editing this tree.');return;}if(!history.length)return;patchProject({graph:history.at(-1)});setHistory(h=>h.slice(0,-1));setSelected(null);setSelectedEdge(null);setToast('Last tree change undone.');}
  function removeNode(nid){const n=graph.nodes.find(n=>n.id===nid);if(!n||n.role==='Manager')return;updateGraph({nodes:graph.nodes.filter(n=>n.id!==nid),edges:graph.edges.filter(e=>e.from!==nid&&e.to!==nid)});setSelected(null);setToast(`${n.name} removed. Its other agents are kept.`);}
  useEffect(()=>{const listener=e=>{if(e.key==='Escape'){setDialog(null);setConnecting(null);setSelectedEdge(null);} if((e.ctrlKey||e.metaKey)&&e.key==='z'&&!['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)){e.preventDefault();undo();}};window.addEventListener('keydown',listener);return()=>window.removeEventListener('keydown',listener);});
  function selectNode(nid) {if(connecting){const error=canConnect(graph,connecting,nid);if(error){setToast(error);return;}updateGraph({...graph,edges:[...graph.edges,{id:id(),from:connecting,to:nid}]});setConnecting(null);setToast('Agents connected.');}setSelected(nid);setSelectedEdge(null);}
  function saveAgent(data) {
    if(dialog.kind==='edit') {const previous=graph.nodes.find(n=>n.id===dialog.node);const next={...data};if(previous.role!=='Manager'&&next.role!==previous.role){next.priority=nextPriority(graph,next.role,previous.id);}else if(previous.role!=='Manager'){const clash=priorityConflict(graph,previous.id,next.role,next.priority);if(clash){setToast(`Priority ${next.priority} is already used by ${clash.name} in the ${next.role} role. Choose a free priority.`);return;}}updateGraph({...graph,nodes:graph.nodes.map(n=>n.id===previous.id?{...n,...next}:n)});setToast(next.role!==previous.role?`Agent updated. It now has priority ${next.priority} in the ${next.role} role.`:'Agent updated.');}
    else {const parent=graph.nodes.find(n=>n.id===dialog.parent);const priority=nextPriority(graph,data.role);const siblings=graph.edges.filter(e=>e.from===parent.id).length;let x=parent.x+(siblings%3-1)*255;let y=parent.y+220+Math.floor(siblings/3)*185; x=Math.max(35,x);while(graph.nodes.some(n=>Math.abs(n.x-x)<235&&Math.abs(n.y-y)<150)){x+=255;if(x>1100){x=35;y+=185;}}const child={...data,id:id(),agentKey:data.agentKey||id(),x,y,priority};updateGraph({nodes:[...graph.nodes,child],edges:[...graph.edges,{id:id(),from:parent.id,to:child.id}]});setSelected(child.id);setToast(`${child.name} added and connected to ${parent.name}.`);}
    setDialog(null);
  }
  // Only a connected tool answers. Without one nothing is sent, and the box says how to connect one.
  const toolReady=target.provider!=='none'&&Boolean(window.orqestra?.chat);
  function retryReply(messageId){if(replying[project.id]||!toolReady)return;const ms=project.messages;const i=ms.findIndex(m=>m.id===messageId);let u=i-1;while(u>=0&&ms[u].kind!=='user')u--;if(u<0)return;const user=ms[u];sendLive(user.text,ms.slice(0,u),(user.attachments||[]).filter(a=>a.id));}
  function editUserMessage(m){setInput(m.text);setTimeout(()=>document.querySelector('.composer textarea')?.focus(),0);}
  function sendMessage(e){e.preventDefault();const files=pendingFiles[project.id]||[];const text=input.trim()||(files.length?'Here are the attached files.':'');if(!text)return;if(!toolReady){setToast('Connect Claude Code or Codex in AI accounts, then choose it below the message box. Nothing was sent.');return;}if(replying[project.id])return;setInput('');setPendingFiles(all=>({...all,[project.id]:[]}));sendLive(text,project.messages,files);}
  // A real reply: the user's message and an empty Manager reply that fills in as events arrive.
  async function addFiles(files){const projectId=project.id;const current=pendingFiles[projectId]||[];keepFiles(projectId,await attachFiles(files,MAX_ATTACHMENTS-current.length));}
  function keepFiles(projectId,{kept,errors}){if(kept.length)setPendingFiles(all=>({...all,[projectId]:[...(all[projectId]||[]),...kept].slice(0,MAX_ATTACHMENTS)}));if(errors.length)setToast(errors.join(' '));}
  function onPaste(e){const projectId=project.id;handlePaste(e,MAX_ATTACHMENTS-(pendingFiles[projectId]||[]).length,r=>keepFiles(projectId,r));}
  const pasteRef=useRef(onPaste);pasteRef.current=onPaste;
  // Paste anywhere in the chat, like Claude: when nothing else that takes text has focus, the paste goes to the message box.
  useEffect(()=>{const on=e=>{const t=e.target;if(t&&(t.closest?.('textarea,input,[contenteditable="true"]')))return;if(!document.querySelector('.composer textarea'))return;pasteRef.current(e);if(!e.defaultPrevented){const text=e.clipboardData?.getData('text/plain');if(text){e.preventDefault();setInput(v=>v+text);document.querySelector('.composer textarea')?.focus();}}};document.addEventListener('paste',on);return()=>document.removeEventListener('paste',on);},[]);
  const [dropping,setDropping]=useState(false);
  // A file from the project's own folder, attached like a picked file (the main process reads it).
  async function addProjectFile(rel){const projectId=project.id;try{const meta=await window.orqestra.chat.attachProjectFile(projectId,rel);setPendingFiles(all=>({...all,[projectId]:[...(all[projectId]||[]),{...meta,thumb:null}].slice(0,MAX_ATTACHMENTS)}));}catch(error){setToast(String(error?.message||error).replace(/^Error invoking remote method '[^']+': (Error: )?/,''));}}
  function sendLive(text,messages=project.messages,attachments=[]){const requestId=id();const messageId=id();const projectId=project.id;const history=historyFor(messages);patchProject({messages:[...messages,{id:id(),kind:'user',text,...(attachments.length?{attachments:attachments.map(a=>({id:a.id,name:a.name,kind:a.kind,size:a.size,thumb:a.thumb||null,...(a.pasted?{pasted:true,preview:a.preview}:{})}))}:{})},newAssistant(messageId,target)]});replies.current.set(requestId,{projectId,messageId});setReplying(x=>({...x,[projectId]:requestId}));window.orqestra.chat.send({requestId,projectId,provider:target.provider,model:target.model,effort:target.effort,history,text,...(general?{}:{team:teamMembers(graph,chatProviders)}),...((project.memory||[]).length?{memory:project.memory.map(m=>m.text)}:{}),...(attachments.length?{attachments:attachments.map(a=>a.id)}:{})}).catch(error=>{endReply(requestId,projectId);updateReply(projectId,messageId,{type:'failed',reason:'provider_error',message:String(error?.message||error).replace(/^Error invoking remote method '[^']+': (Error: )?/,''),text:''});});}
  // An answer to a Manager question becomes the next message; the question shows what was chosen.
  function answerQuestion(messageId,text,choice){if(replying[project.id]||!window.orqestra?.chat)return;if(!toolReady){setToast('Connect Claude Code or Codex to answer the Manager.');return;}const messages=project.messages.map(m=>m.id===messageId?{...m,answered:{kind:choice.kind,label:choice.label,...(choice.items?{items:choice.items}:{})}}:m);sendLive(text,messages);}
  // Team runs (phase 3): the user starts the Manager's plan; the main process runs it and reports back.
  const teamRuns=useRef(new Map());
  function updateTeamRun(projectId,messageId,fn){setProjects(ps=>ps.map(p=>p.id!==projectId?p:{...p,messages:p.messages.map(m=>m.id===messageId?{...m,run:fn(m.run)}:m)}));}
  useEffect(()=>{const team=window.orqestra?.team;if(!team)return;team.subscribe(message=>{const r=teamRuns.current.get(message?.runId);if(!r)return;updateTeamRun(r.projectId,r.messageId,run=>applyTeamEvent(run,message.event));if(['files','run-finished'].includes(message.event?.type))refreshProducts(r.projectId,true);if(message.event?.type==='run-finished'){teamRuns.current.delete(message.runId);void refreshProviders(false);}});},[]);
  // Decision A6: a brief from the Manager goes to the Planner, whose plan is shown on the same reply.
  function patchMessage(projectId,messageId,fn){setProjects(ps=>ps.map(p=>p.id!==projectId?p:{...p,messages:p.messages.map(m=>m.id===messageId?fn(m):m)}));}
  function requestPlan(projectId,messageId,brief){
    const team=window.orqestra?.team;const proj=projectsRef.current.find(p=>p.id===projectId);if(!team||!proj)return;
    const planner=plannerOf(proj.graph);
    if(!planner){patchMessage(projectId,messageId,m=>({...m,planning:{status:'failed',error:'No Planner runs on Claude Code or Codex any more. Set one in the tree, or ask the Manager to plan.'}}));return;}
    const requestId=id();
    patchMessage(projectId,messageId,m=>({...m,planning:{status:'running',startedAt:Date.now(),requestId,plannerId:planner.id,plannerName:planner.name}}));
    team.plan({requestId,projectId,brief,planner,agents:teamAgents(proj.graph,providersRef.current),team:teamMembers(proj.graph,providersRef.current)})
      .then(result=>patchMessage(projectId,messageId,m=>({...m,planning:{status:'done',plannerId:planner.id,plannerName:planner.name,plan:result.plan,summary:result.summary,usage:result.usage||null,tool:planner.tool}})))
      .catch(error=>patchMessage(projectId,messageId,m=>({...m,planning:{status:'failed',plannerName:planner.name,error:String(error?.message||error).replace(/^Error invoking remote method '[^']+': (Error: )?/,'')}})))
      .finally(()=>void refreshProviders(false));
  }
  // A request the user gives one agent directly, from its panel in the tree: no Manager and no plan to approve.
  function askAgent(agentId,request){
    const team=window.orqestra?.team;if(!team?.direct){setToast('Direct requests work in the installed app.');return false;}
    const agent=teamAgents(graph,chatProviders).find(a=>a.id===agentId);const node=graph.nodes.find(n=>n.id===agentId);
    if(!agent||!node){setToast('Set this agent to Claude Code or Codex first.');return false;}
    if([...teamRuns.current.values()].some(r=>r.projectId===project.id)){setToast('The team is already working in this project. Wait for it or stop it.');return false;}
    const plan=directPlanFor(request,agent);if(!plan.goal)return false;
    const runId=`direct-${id()}`.replace(/[^A-Za-z0-9_-]/g,'').slice(0,90);const messageId=id();const projectId=project.id;
    patchProject({messages:[...project.messages,{id:id(),kind:'user',text:request.trim(),to:node.name},{id:messageId,kind:'team',runId,run:newTeamRun(runId,plan,Date.now(),{agentId,name:node.name})}]});
    teamRuns.current.set(runId,{projectId,messageId});
    const notStarted=(summary)=>{teamRuns.current.delete(runId);updateTeamRun(projectId,messageId,run=>applyTeamEvent(run,{type:'run-finished',status:'failed',summary,files:[],calls:0,usage:null}));};
    team.direct({runId,projectId,agentId,request,agents:teamAgents(graph,chatProviders)}).then(result=>{if(result&&result.ok===false)notStarted(`${result.message} (Nothing was started.)`);}).catch(error=>notStarted(String(error?.message||error).replace(/^Error invoking remote method '[^']+': (Error: )?/,'')));
    return true;
  }
  // Undo: puts back the files a finished run changed (main/team/history.ts).
  function undoTeamRun(messageId,run){
    const team=window.orqestra?.team;if(!team?.undo){setToast('Undo works in the installed app.');return;}
    if(linkedTeam){setToast('In a shared Teams project, ask the Manager to change it back, so your team sees the change.');return;}
    const projectId=project.id;
    team.undo({projectId,runId:run.id}).then(result=>{updateTeamRun(projectId,messageId,r=>({...r,undone:{at:Date.now(),restored:result.restored,removed:result.removed}}));refreshProducts(projectId,true);const n=result.restored.length+result.removed.length;setToast(n===1?'Undone: 1 file is back as it was.':`Undone: ${n} files are back as they were.`);})
      .catch(error=>setToast(String(error?.message||error).replace(/^Error invoking remote method '[^']+': (Error: )?/,'')));
  }
  function startPlan(assistantId,plan){
    const team=window.orqestra?.team;if(!team){setToast('Team runs work in the installed app.');return;}
    if([...teamRuns.current.values()].some(r=>r.projectId===project.id)){setToast('The team is already working in this project.');return;}
    // A stable run id per approved plan: retrying a start that was refused reuses it, so a
    // coordinated start can never hold two reservations for the same plan.
    const runId=`plan-${String(assistantId).replace(/[^A-Za-z0-9_-]/g,'').slice(0,90)}`;const messageId=id();const projectId=project.id;
    const source=project.messages.find(m=>m.id===assistantId);patchProject({messages:[...project.messages.map(m=>m.id===assistantId?{...m,planStarted:runId}:m),{id:messageId,kind:'team',runId,run:newTeamRun(runId,plan,Date.now(),null,planningUsage(source))}]});
    teamRuns.current.set(runId,{projectId,messageId});
    // A refused or failed start ran nothing: the plan can be started again (retry) or changed.
    const notStarted=(summary)=>{teamRuns.current.delete(runId);updateTeamRun(projectId,messageId,run=>applyTeamEvent(run,{type:'run-finished',status:'failed',summary,files:[],calls:0,usage:null}));setProjects(ps=>ps.map(p=>p.id!==projectId?p:{...p,messages:p.messages.map(m=>m.id===assistantId?{...m,planStarted:undefined}:m)}));};
    team.start({runId,projectId,plan,agents:teamAgents(graph,chatProviders)}).then(result=>{if(result&&result.ok===false)notStarted(`${result.message} (Nothing was started; press Start on the plan to try again.)`);}).catch(error=>notStarted(String(error?.message||error).replace(/^Error invoking remote method '[^']+': (Error: )?/,'')));
  }
  const runningTeam=[...project.messages].reverse().find(m=>m.kind==='team'&&m.run?.status==='running');
  const planningNow=project.messages.find(m=>m.planning?.status==='running');
  const liveStates=runningTeam||planningNow?{...(runningTeam?nodeStates(runningTeam.run):{}),...(planningNow?{[planningNow.planning.plannerId]:'planning'}:{})}:null;
  const nameOf=nodeId=>graph.nodes.find(n=>n.id===nodeId)?.name||'an agent no longer in the tree';
  const productInfo=productsByProject[project.id]||{host:null,products:[]};
  const placedProducts=placeProducts(mergeProducts(productInfo.products,project.messages).map(p=>p.kind==='app'?{...p,app:appsByProject[project.id]?.[p.id]||null}:p),project.messages,graph,project.productPos||{}).map(p=>({...p,problems:problemsFor(p,previewProblems[project.id])}));
  // Tidy the tree in one step (tree-layout.mjs). Only places change, so it also works while the team runs, and Undo brings the old places back.
  const [fitKey,setFitKey]=useState(0);
  function arrangeTeam(){const at=arrangeTree(graph);setHistory(h=>[...h.slice(-29),clone(graph)]);patchProject({graph:{...graph,nodes:graph.nodes.map(n=>at[n.id]?{...n,...at[n.id]}:n)},productPos:{}});setFitKey(k=>k+1);}
  function askToEdit(product,picked,request){if(replying[project.id]){setToast('Wait for the Manager to finish its reply.');return;}if(!toolReady){setToast('Connect the Manager to Claude Code or Codex first.');return;}sendLive(editMessage(product,picked,request));setToast('The Manager got your change and will plan it.');}
  // Conversations (chats.mjs): not while a reply or the team is working here, so nothing lands in the wrong one.
  const busyHere=Boolean(replying[project.id])||Boolean(runningTeam)||project.messages.some(m=>m.planning?.status==='running');
  function newChat(){if(busyHere){setToast('Wait until the Manager and the team are done, then start a new chat.');return;}if(!project.messages.length){setPage('project');setView('chat');return;}patchProject(startChat(project,`c${id()}`.replace(/[^A-Za-z0-9_-]/g,'').slice(0,40)));setPage('project');setView('chat');}
  function openChat(chatId){if(chatId===project.chatId){setPage('project');setView('chat');return;}if(busyHere){setToast('Wait until the Manager and the team are done, then switch chats.');return;}patchProject(switchChat(project,chatId));setPage('project');setView('chat');}
  function deleteChat(chatId){if(busyHere&&chatId===project.chatId){setToast('Wait until the Manager and the team are done.');return;}patchProject(removeChat(project,chatId,`c${id()}`.replace(/[^A-Za-z0-9_-]/g,'').slice(0,40)));}
  const ChatLinks=()=><div className="chat-links">{chatList(project).slice(0,12).map(c=><div key={c.id} className={`chat-link ${c.current&&page==='project'&&(view==='chat'||general)?'child-active':''}`}><button className="chat-link-open" title={c.title} onClick={()=>openChat(c.id)}><Icon name="chat" size={14}/><span>{c.title}</span></button>{chatList(project).length>1&&<button className="chat-link-remove" title="Delete this chat" aria-label={`Delete ${c.title}`} onClick={()=>deleteChat(c.id)}>×</button>}</div>)}<button className="chat-link-new" onClick={newChat}><Icon name="plus" size={13}/> New chat</button></div>;
  function moveProduct(productId,x,y){patchProject({productPos:{...(project.productPos||{}),[productId]:{x,y}}});}
  function clearProblems(product){setPreviewProblems(all=>({...all,[project.id]:(all[project.id]||[]).filter(p=>!problemsFor(product,[p]).length)}));}
  function askToFix(product){if(replying[project.id]){setToast('Wait for the Manager to finish its reply.');return;}if(!toolReady){setToast('Connect the Manager to Claude Code or Codex first.');return;}sendLive(fixMessage(product,product.problems));setToast('The Manager got the problems and will plan a fix.');}
  const previewed=previewId?placedProducts.find(p=>p.id===previewId)||null:null;
  useEffect(()=>{setPreviewId(null);setAgentPanelId(null);refreshProducts(project.id,false);const team=window.orqestra?.team;if(team?.appStatus)team.appStatus(project.id).then(map=>{if(map&&typeof map==='object')setAppsByProject(all=>({...all,[project.id]:{...(all[project.id]||{}),...map}}));}).catch(()=>{});},[project.id]);
  useEffect(()=>{const team=window.orqestra?.team;if(!team?.onAppEvent)return;team.onAppEvent(message=>{if(!message||typeof message.projectId!=='string'||typeof message.productId!=='string'||!message.status)return;setAppsByProject(all=>({...all,[message.projectId]:{...(all[message.projectId]||{}),[message.productId]:{host:message.host,status:message.status}}}));});},[]);
  function startApp(product){const team=window.orqestra?.team;if(!team?.appStart){setToast('Apps run in the installed app.');return;}team.appStart({projectId:project.id,productId:product.id}).catch(error=>setToast(String(error?.message||error).replace(/^Error invoking remote method '[^']+': (Error: )?/,'')));}
  function stopApp(product){window.orqestra?.team?.appStop?.({projectId:project.id,productId:product.id}).catch(()=>{});}
  useEffect(()=>{const team=window.orqestra?.team;if(!team?.onPreviewProblem)return;team.onPreviewProblem(message=>{const problem=readProblem(message);if(!problem||typeof message?.projectId!=='string')return;setPreviewProblems(all=>({...all,[message.projectId]:addProblem(all[message.projectId],problem)}));});},[]);
  useEffect(()=>{const onFocus=()=>refreshProducts(project.id,false);window.addEventListener('focus',onFocus);return()=>window.removeEventListener('focus',onFocus);},[project.id]);
  // The product a run worked on, if its files make one.
  const productFor=run=>placedProducts.find(p=>run.tasks.some(t=>[...(t.deliverables||[]),...(t.files||[]).map(f=>f.path)].some(f=>p.files.includes(f))));
  function openProduct(productId){setPreviewId(productId);setView('split');}
  const splitFits=!panelsWidth||fitsSplit(panelsWidth);
  const shown=shownView(view,{hasTree:!general,containerWidth:panelsWidth||Infinity});
  const chatPx=panelsWidth?chatWidth(chatRatio,panelsWidth):0;
  const chatShare=panelsWidth>DIVIDER?Math.round(chatPx/(panelsWidth-DIVIDER)*100):Math.round(chatRatio*100);
  // Show a hidden pane again. A split that cannot fit the window shows that pane alone instead.
  function showChat(){setView(splitFits?'split':'chat');}
  function showTree(){setView(splitFits?'split':'tree');}
  function panelsLeft(){const el=panelsEl.current;const rect=el.getBoundingClientRect();return rect.left+(parseFloat(getComputedStyle(el).paddingLeft)||0);}
  // Dragging moves the chat's width straight on the element (no re-render per frame); the ratio is kept on release.
  function startResize(e){if(e.button!==0||!panelsEl.current||!panelsWidth)return;e.preventDefault();e.currentTarget.focus();e.currentTarget.setPointerCapture(e.pointerId);resizing.current={left:panelsLeft(),ratio:chatRatio};document.body.classList.add('pane-resizing');}
  function moveResize(e){const r=resizing.current;if(!r)return;r.ratio=ratioAt(e.clientX-r.left,panelsWidth);const px=chatWidth(r.ratio,panelsWidth);if(chatPanelEl.current){chatPanelEl.current.style.flexBasis=px+'px';chatPanelEl.current.style.width=px+'px';}e.currentTarget.setAttribute('aria-valuenow',String(Math.round(px/(panelsWidth-DIVIDER)*100)));}
  function endResize(){const r=resizing.current;if(!r)return;resizing.current=null;document.body.classList.remove('pane-resizing');setChatRatio(r.ratio);}
  function resizeKey(e){const next=ratioForKey(chatShare/100,e.key,e.shiftKey,panelsWidth);if(next===null)return;e.preventDefault();setChatRatio(next);}
  const selectedNode=graph.nodes.find(n=>n.id===selected);
  return <div className={`application ${navOpen?'nav-open':'nav-closed'}`}>
    {navOpen&&<aside className="navigation" aria-label="Workspace navigation"><div className="nav-brand"><span className="brand-mark brand-mark-app"><AppMark size={28}/></span><span className="nav-brand-name">0rqestra</span><button className="icon-button nav-collapse" onClick={()=>setNavOpen(false)} title="Hide sidebar" aria-label="Hide sidebar"><Icon name="panel"/></button></div><div className="nav-section-label">WORKSPACE</div><button className={`nav-item ${page==='project'&&general?'nav-item-active':''}`} onClick={()=>{switchProject(GENERAL_ID);setView('chat');}}><Icon name="spark" size={17}/> Ask anything</button>{general&&page==='project'&&<ChatLinks/>}<button className={`nav-item ${page==='project'&&view==='chat'&&!general?'nav-item-active':''}`} onClick={()=>{if(general){const first=projects.find(p=>!isGeneral(p));if(first)switchProject(first.id);}setPage('project');setView('chat');}}><Icon name="chat" size={17}/> Manager chat</button><button className={`nav-item ${page==='accounts'?'nav-item-active':''}`} onClick={()=>{setPage('accounts');}}><Icon name="link" size={17}/> AI accounts</button><button className={`nav-item ${page==='teams'?'nav-item-active':''}`} onClick={()=>{setPage('teams');}}><Icon name="tree" size={17}/> Teams</button><button className={`nav-item ${page==='friends'?'nav-item-active':''}`} onClick={()=>{setPage('friends');}}><Icon name="chat" size={17}/> Friends{waitingCount(teamsView)>0&&<span className="nav-badge" aria-label={`${waitingCount(teamsView)} waiting for your answer`}>{waitingCount(teamsView)}</span>}</button><div className="nav-section-heading"><span className="nav-section-label">PROJECTS</span><button className="icon-button" title="New project" aria-label="New project" onClick={()=>setDialog({kind:'project'})}><Icon name="plus" size={15}/></button></div><div className="project-list">{projects.filter(p=>!isGeneral(p)).map(p=><div key={p.id} className={`nav-project ${p.id===project.id?'nav-project-current':''}`}><button className="project-button" onClick={()=>switchProject(p.id)}><span className="project-color"/><span>{p.name}</span><Icon name="chevron" size={12}/></button><ProjectMenu project={p} link={teamLinkFor(teamsView,p.id)} Icon={Icon} onAction={kind=>projectAction(kind,p)}/>{p.id===project.id&&<div className="project-children"><ChatLinks/><button className={page==='project'&&view!=='chat'?'child-active':''} onClick={()=>{setPage('project');setView(view==='chat'?'split':'chat');}}><Icon name="tree" size={14}/> Team tree<span>{graph.nodes.length}</span></button></div>}</div>)}</div><button className="new-project" onClick={()=>setDialog({kind:'project'})}><Icon name="plus" size={15}/> New project</button><div className="nav-bottom"><UsagePanel statuses={chatProviders} onCheck={checkClaudeUsage} Icon={Icon} onAccounts={()=>setPage('accounts')}/><ProfileMenu name={profileName} version={appInfo?.appVersion} updates={updates} theme={theme} onTheme={setTheme} onSettings={tab=>setShellDialog({kind:'settings',tab})} onHelp={()=>setShellDialog({kind:'help'})} account={accountLabel(teamsView)} accountAvailable={Boolean(window.orqestra?.teams)&&teamsView?.status!=='unconfigured'} onSignOut={signOutAccount} onSignIn={()=>setGateOpen(true)}/></div></aside>}
    <header className="titlebar">
      <div className="brand">{!navOpen&&<><button className="icon-button" onClick={()=>setNavOpen(true)} title="Show sidebar" aria-label="Show sidebar"><Icon name="panel"/></button><span className="brand-mark brand-mark-app"><AppMark size={28}/></span><span>0rqestra</span><span className="title-divider"/></>}<span className="breadcrumb">Personal workspace <Icon name="chevron" size={12}/> <strong>{project.name}</strong></span></div>
    </header>
    <div className="workspace">
      <main className={`main-area view-${page==='project'?shown:view} ${page==='accounts'||page==='teams'||page==='friends'?'accounts-main':''}`}>{page==='friends'?<FriendsPage view={teamsView} onView={setTeamsView} onBack={()=>setPage('project')} notify={setToast} onTeams={()=>setPage('teams')}/>:page==='teams'?<TeamsPage view={teamsView} onView={setTeamsView} onBack={()=>setPage('project')} notify={setToast} projects={projects.filter(p=>!isGeneral(p))} onCreateProject={createLinkedProject} onFriends={()=>setPage('friends')}/>:page==='accounts'?<AccountsPage onBack={()=>setPage('project')} notify={setToast} onProvidersChanged={setChatProviders} managerProvider={target.provider} agents={graph.nodes} onUseForManager={useToolForManager} onUseForAgent={useToolForAgent}/>:<>
        <div className="project-header"><div><div className="eyebrow">YOUR PROJECT</div><h1>{project.name}</h1></div><div className="project-actions"><button type="button" className="button memory-button" title="What the Manager remembers about this project" onClick={()=>setDialog({kind:'memory'})}><Icon name="spark" size={14}/> Memory{(project.memory||[]).length>0&&<span className="count-badge">{project.memory.length}</span>}</button><span className="save-state"><span className={saved?'saved-dot':'unsaved-dot'}/>{saved?'Saved on this device':'Storage unavailable'}</span>{!general&&<button className={`button ${shown!=='chat'?'button-active':''}`} onClick={()=>{if(shown==='chat')showTree();else setView('chat');setPreviewId(null);}}><Icon name="tree" size={16}/>{shown==='chat'?'Open team tree':previewId?'Close preview':'Close team tree'}<span className="count-badge">{graph.nodes.length}</span></button>}</div></div>
        <div className={`content-panels ${shown==='split'?'split-panels':''}`} ref={panelsRef}>
          {shown==='tree'&&<button type="button" className="pane-reveal pane-reveal-left" onClick={showChat} title="Show the Manager chat" aria-label="Show Chat"><Icon name="chat" size={16}/><span>Show Chat</span></button>}
          {shown!=='tree'&&<section className={`chat-panel ${dropping?'is-dropping':''} ${project.messages.length===0?'is-empty':''} ${general?'is-general':''}`} onDragEnter={e=>{if(e.dataTransfer?.types?.includes('Files'))setDropping(true);}} onDragOver={e=>{if(e.dataTransfer?.types?.includes('Files')){e.preventDefault();setDropping(true);}}} onDragLeave={e=>{if(!e.currentTarget.contains(e.relatedTarget))setDropping(false);}} onDrop={e=>{setDropping(false);if(e.dataTransfer?.files?.length){e.preventDefault();void addFiles([...e.dataTransfer.files]);}}} id="manager-chat-panel" aria-label="Manager chat" ref={chatPanelEl} style={shown==='split'&&chatPx?{flexBasis:chatPx,width:chatPx}:undefined}>
            <div className="panel-header"><div className="panel-heading"><span className="mini-avatar green"><Icon name={general?'spark':'tree'} size={17}/></span><div><strong>{general?'Ask anything':'Manager'}</strong><span>{general?'Quick answers, study help and writing':'Your point of contact'}</span></div></div><button className="icon-button chat-new" title="New chat" aria-label="New chat" onClick={newChat}><Icon name="plus" size={15}/></button>{!general&&shown==='split'&&<><button className="icon-button" title="Hide chat (team tree only)" aria-label="Hide chat" onClick={()=>setView('tree')}><Icon name="hideLeft" size={15}/></button><button className="icon-button" title="Chat only (hide team tree)" aria-label="Chat only" onClick={()=>setView('chat')}><Icon name="expand" size={15}/></button></>}{!general&&shown==='chat'&&<button className="icon-button" title="Show the team tree beside the chat" aria-label="Show team tree" onClick={showTree}><Icon name="panel" size={15}/></button>}</div>
            {dropping&&<div className="drop-overlay" aria-hidden="true"><Icon name="clip" size={30}/><strong>Drop files here to add them to the chat</strong><span>Images, PDFs and text files</span></div>}<div className="chat-scroll" ref={chatScroll} onScroll={onChatScroll}>
              {project.messages.length===0?<div className="welcome welcome-hello"><h2><span className="hello-mark"><AppMark size={36}/></span><span>{general?greeting(profileName):project.name}</span></h2>{!general&&<p>{graph.nodes.length===1?'Your Manager plans the work and the team builds it.':`Your Manager and ${graph.nodes.length-1} ${graph.nodes.length===2?'agent':'agents'} are ready.`} <button className="welcome-tree-link" onClick={()=>setView('split')}>Shape your team <Icon name="chevron" size={13}/></button></p>}</div>:<div className="messages">{project.messages.map(m=>m.kind==='teamInfo'?<TeamInfoMessage key={m.id} m={m} Icon={Icon}/>:m.kind==='team'&&m.run?<TeamRunCard key={m.id} run={m.run} nameOf={nameOf} toolOf={nid=>graph.nodes.find(n=>n.id===nid)?.agent?.tool||null} onUndo={m.run.id===undoableRunId(project.messages)?()=>undoTeamRun(m.id,m.run):null} onPreview={productFor(m.run)?()=>openProduct(productFor(m.run).id):null} onStop={()=>window.orqestra?.team?.stop(m.run.id)} onOpenFolder={()=>window.orqestra?.team?.openFolder(project.id)} onReplan={()=>{if(replying[project.id])return;if(!toolReady){setToast('Connect the Manager to Claude Code or Codex first.');return;}sendLive(replanMessage(m.run));}}/>:m.kind==='assistant'?<AssistantMessage key={m.id} m={m} Icon={Icon} who={general?null:'Manager'} onRetry={m.id===project.messages[project.messages.length-1]?.id&&!replying[project.id]&&!m.readOnly?()=>retryReply(m.id):null} onAccounts={()=>{setPage('accounts');}} onAnswer={answerQuestion} busy={Boolean(replying[project.id])} renderPlan={(plan,msg)=><PlanCard plan={plan} assignments={planAssignments(plan,graph,chatProviders)} startedRunId={msg.planStarted} busy={Boolean(runningTeam)} onStart={()=>startPlan(msg.id,plan)} onTree={()=>{setPage('project');setView('split');}}/>} renderPlanRequest={(brief,msg)=>msg.planning?.status==='done'?<PlanCard plan={msg.planning.plan} plannedBy={msg.planning.plannerName} summary={msg.planning.summary} assignments={planAssignments(msg.planning.plan,graph,chatProviders)} startedRunId={msg.planStarted} busy={Boolean(runningTeam)} onStart={()=>startPlan(msg.id,msg.planning.plan)} onTree={()=>{setPage('project');setView('split');}}/>:<PlannerCard planning={msg.planning} brief={brief} onStop={()=>window.orqestra?.team?.stopPlan(msg.planning?.requestId)} onRetry={()=>requestPlan(project.id,msg.id,brief)}/>}/>:<div className={`message message-${m.kind}`} key={m.id}>{m.kind==='manager'&&<div className="message-author"><span className="mini-avatar green"><Icon name="tree" size={14}/></span>Manager<span>Earlier preview reply · no model was used</span></div>}<SentAttachments items={m.attachments} Icon={Icon}/>{m.to&&<div className="message-to">To {m.to}</div>}<div className="message-body">{m.text}</div>{m.kind==='user'&&<MessageActions text={m.text} Icon={Icon} onEdit={()=>editUserMessage(m)}/>}</div>)}<div ref={chatEnd}/></div>}{!atBottom&&project.messages.length>0&&<button type="button" className="jump-latest" title="Jump to latest" aria-label="Jump to latest" onClick={()=>toBottom(true)}>↓</button>}
            </div>
            <div className="composer-wrap">{linkedTeam&&<TeamAskBar linked={linkedTeam} view={teamsView} busy={Boolean(replying[project.id])} onAsk={askTeammate}/>}{!general&&onlyManager(graph)&&readyProviders(chatProviders).length>0&&<div className="team-setup-banner" role="note"><span><strong>This project has no team yet.</strong> The Manager plans and the team builds, so you can follow the work in the team tree.</span><button type="button" className="shell-button primary" onClick={createTeam}>Create the team</button></div>}{!general&&teamNeedsSetup(graph,chatProviders)&&<div className="team-setup-banner" role="note"><span><strong>Your agents are not set up yet.</strong> Connect them to your tools so the Manager can plan real work.</span><button type="button" className="shell-button primary" onClick={setupTeam}>Set up the team</button></div>}{!general&&!teamNeedsSetup(graph,chatProviders)&&usesOneTool(graph,chatProviders)&&<div className="team-setup-banner" role="note"><span><strong>Your whole team runs on one tool.</strong> Both Claude Code and Codex are connected: let them work together, each on what it does best.</span><button type="button" className="shell-button primary" onClick={mixTools}>Use both</button></div>}<form className="composer" onSubmit={sendMessage}><PendingAttachments items={pendingFiles[project.id]||[]} Icon={Icon} onRemove={fid=>setPendingFiles(all=>({...all,[project.id]:(all[project.id]||[]).filter(a=>a.id!==fid)}))}/><textarea onPaste={onPaste} aria-label="Message your Manager" placeholder={project.messages.length===0?(general?'How can I help you today?':'What should the team build?'):'Reply…'} value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMessage(e);}}} rows={2}/><div className="composer-footer"><AttachMenu Icon={Icon} projectId={general?null:project.id} disabled={(pendingFiles[project.id]||[]).length>=MAX_ATTACHMENTS} onFiles={files=>void addFiles(files)} onProjectFile={addProjectFile} onNewChat={newChat} onMemory={()=>setDialog({kind:'memory'})}/><ChatTargetPicker target={target} statuses={chatProviders} onChange={changeTarget} onAccounts={()=>{setPage('accounts');}}/>{replying[project.id]?<button className="send-button stop-button" type="button" onClick={()=>window.orqestra?.chat?.stop(replying[project.id])} title="Stop the reply" aria-label="Stop the reply"><span className="stop-square"/></button>:<button className="send-button" type="submit" disabled={(!input.trim()&&!(pendingFiles[project.id]||[]).length)||!toolReady} title={toolReady?'Send message':'Connect Claude Code or Codex first'} aria-label="Send message"><Icon name="arrow" size={17}/></button>}</div></form>{project.messages.length===0&&<div className="starter-pills">{(general?[['edit','Write','Help me write '],['spark','Learn','Explain simply: '],['code','Code','Help me with this code: '],['chat','Study','Help me study for a test on ']]:[['spark','Plan an app','Help me plan the first version of my app: '],['code','Build a website','Build a website for '],['chat','Improve something','Look at the project and suggest what to improve first.']]).map(([icon,label,text])=><button type="button" key={label} onClick={()=>{setInput(text);document.querySelector('.composer textarea')?.focus();}}><Icon name={icon} size={15}/>{label}</button>)}{general?<button type="button" onClick={()=>setDialog({kind:'project'})}><Icon name="tree" size={15}/>Start a project</button>:<button type="button" onClick={()=>setView('split')}><Icon name="tree" size={15}/>Build your team</button>}</div>}{toolReady?<p className="composer-note">{`${target.name} · Your own subscription · History stays on this device`}</p>:<p className="composer-note composer-setup">No AI tool is connected, so your Manager cannot answer yet. <button type="button" className="chat-connect" onClick={()=>setPage('accounts')}>Set up Claude Code or Codex</button></p>}</div>
          </section>}
          {shown==='chat'&&!general&&<button type="button" className="pane-reveal pane-reveal-right" onClick={showTree} title="Show the team tree" aria-label="Show Tree"><Icon name="tree" size={16}/><span>Show Tree</span></button>}
          {shown==='split'&&<div className="pane-divider" role="separator" tabIndex={0} aria-orientation="vertical" aria-controls="manager-chat-panel" aria-label="Resize chat and team tree" aria-valuemin={0} aria-valuemax={100} aria-valuenow={chatShare} aria-valuetext={`Chat ${chatShare}% of the width`} title="Drag or use the arrow keys to resize. Double-click to reset." onPointerDown={startResize} onPointerMove={moveResize} onPointerUp={endResize} onPointerCancel={endResize} onLostPointerCapture={endResize} onKeyDown={resizeKey} onDoubleClick={()=>setChatRatio(DEFAULT_RATIO)}><span/></div>}
          {shown!=='chat'&&previewId&&<ProductPreview key={`${project.id}:${previewId}`} product={previewed} host={productInfo.host} version={previewVersion} nameOf={nameOf} Icon={Icon} onFix={()=>previewed&&askToFix(previewed)} onEdit={(picked,request)=>previewed&&askToEdit(previewed,picked,request)} onStartApp={()=>previewed&&startApp(previewed)} onStopApp={()=>previewed&&stopApp(previewed)} checkDocker={()=>window.orqestra?.team?.appDocker?window.orqestra.team.appDocker():Promise.resolve(null)} busy={Boolean(replying[project.id])} onClearProblems={()=>previewed&&clearProblems(previewed)} onTree={()=>setPreviewId(null)} onClose={()=>{setPreviewId(null);setView('chat');}} onOpenFolder={()=>window.orqestra?.team?.openFolder(project.id)}/>}
          {shown!=='chat'&&!previewId&&<section className="tree-panel" aria-label="Project team tree"><div className="panel-header"><div className="tree-panel-title"><Icon name="tree" size={17}/><strong>Team tree</strong><span className="count-label">{graph.nodes.length} agents</span></div><div className="inline-actions">{shown==='tree'?<button className="icon-button" title="Show chat beside tree" aria-label="Show chat beside tree" onClick={showChat}><Icon name="minimize" size={15}/></button>:<button className="icon-button" title="Tree only (hide chat)" aria-label="Tree only" onClick={()=>setView('tree')}><Icon name="expand" size={15}/></button>}<button className="icon-button" title="Hide team tree (chat only)" aria-label="Hide team tree" onClick={()=>setView('chat')}><Icon name="hideRight" size={16}/></button></div></div>
            <TreeCanvas key={project.id} savedCamera={cameras.current[project.id]} onCamera={c=>{cameras.current[project.id]=c;}} graph={graph} extraBoxes={overlayBoxes(graph,linkedTeam,teamsView)} overlay={linkedTeam?(at)=><TeamOverlay graph={graph} linked={linkedTeam} view={teamsView} managerAt={at} onOpen={()=>setBridgeOpen(true)} Icon={Icon}/>:null} liveStates={liveStates} products={placedProducts} productHost={productInfo.host} productVersion={previewVersion} onOpenProduct={openProduct} onMoveProduct={moveProduct} fitKey={fitKey} onInspect={setAgentPanelId} selected={selected} selectedEdge={selectedEdge} connecting={connecting} onSelect={selectNode} onSelectEdge={eid=>{setSelectedEdge(eid);setSelected(null);}} onBackground={()=>{setSelected(null);setSelectedEdge(null);}} onAdd={parent=>setDialog({kind:'add',parent})} onEdit={node=>setDialog({kind:'edit',node})} onMove={(nid,x,y)=>updateGraph({...graph,nodes:graph.nodes.map(n=>n.id===nid?{...n,x,y}:n)})}>
              <div className="canvas-toolbar">{canSetUpTeam&&<><button className="toolbar-text" title="Connect every agent without a tool to a signed-in tool" onClick={setupTeam}><Icon name="link" size={15}/> Use connected tools</button><span className="toolbar-divider"/></>}{usesOneTool(graph,chatProviders)&&<><button className="toolbar-text" title="Move builders to Codex and planning and reviews to Claude, so both tools work" onClick={mixTools}><Icon name="link" size={15}/> Use both tools</button><span className="toolbar-divider"/></>}<button className="tool" title="Undo last tree change" aria-label="Undo last tree change" disabled={!history.length} onClick={()=>{undo();setFitKey(k=>k+1);}}><Icon name="undo" size={17}/></button><span className="toolbar-divider"/><button className="toolbar-text" title="Place every agent and product in neat rows" onClick={arrangeTeam}><Icon name="arrange" size={15}/> Arrange</button><span className="toolbar-divider"/><button className={`tool ${connecting?'tool-active':''}`} title="Connect selected agent" aria-label="Connect selected agent" onClick={()=>{if(!selectedNode){setToast('Select an agent, then click Connect.');return;}setConnecting(connecting?null:selectedNode.id);setToast('Click the agent this connection should lead to.');}}><Icon name="link" size={17}/></button>{selectedNode&&<><span className="toolbar-divider"/><button className="toolbar-text" onClick={()=>setDialog({kind:'edit',node:selectedNode.id})}><Icon name="settings" size={15}/> Configure</button>{selectedNode.role!=='Manager'&&<button className="tool danger" title="Remove selected agent" aria-label="Remove selected agent" onClick={()=>removeNode(selectedNode.id)}><Icon name="trash" size={16}/></button>}</>}{selectedEdge&&<button className="toolbar-text danger" onClick={()=>{updateGraph({...graph,edges:graph.edges.filter(e=>e.id!==selectedEdge)});setSelectedEdge(null);}}>Remove connection</button>}</div>
              {connecting&&<div className="connection-banner"><Icon name="link" size={14}/> Select the next agent <button onClick={()=>setConnecting(null)}>Cancel</button></div>}
            </TreeCanvas>
            {agentPanelId&&graph.nodes.find(n=>n.id===agentPanelId)&&<AgentPanel key={agentPanelId} node={graph.nodes.find(n=>n.id===agentPanelId)} state={liveStates?.[agentPanelId]||'idle'} messages={project.messages} Icon={Icon} canAsk={isRealAgent(graph.nodes.find(n=>n.id===agentPanelId))} busy={Boolean(runningTeam)} onAsk={text=>askAgent(agentPanelId,text)} onClose={()=>setAgentPanelId(null)} onConfigure={()=>setDialog({kind:'edit',node:agentPanelId})} graph={graph} projectId={project.id} notify={setToast} onPatchNode={patch=>patchProject({graph:{...graph,nodes:graph.nodes.map(n=>n.id===agentPanelId?{...n,...patch}:n)}})} onPatchProjectSkills={skills=>patchProject({graph:{...graph,skills}})}/>}
            <div className="tree-footer"><span><span className="status-dot"/>{graph.nodes.filter(isRealAgent).length} of {graph.nodes.length} agents can work <span className="dot-separator">·</span> an agent works once it runs on Claude Code or Codex</span><span>+ adds a connected child</span></div>
          </section>}
        </div>
      </>}
      {page==='project'&&bridgeOpen&&linkedTeam&&<BridgePanel linked={linkedTeam} view={teamsView} onClose={()=>setBridgeOpen(false)} Icon={Icon}/>}
      </main>
      
    </div>
    {dialog&&<Modal onClose={()=>setDialog(null)}>{dialog.kind==='memory'?<MemoryDialog memory={project.memory||[]} Icon={Icon} onClose={()=>setDialog(null)} onChange={memory=>patchProject({memory})}/>:['add','edit'].includes(dialog.kind)?<AgentForm tools={chatProviders.filter(t=>t.installed&&t.subscription)} onTest={testAgent} existing={dialog.kind==='add'?existingAgents(projects,project,agentLibrary):[]} key={`${dialog.kind}-${dialog.node||dialog.parent}`} node={dialog.kind==='edit'?graph.nodes.find(n=>n.id===dialog.node):null} parent={dialog.kind==='add'?graph.nodes.find(n=>n.id===dialog.parent):null} onSave={saveAgent} onClose={()=>setDialog(null)}/>:dialog.kind==='project-rename'&&projects.find(p=>p.id===dialog.projectId)?<RenameProjectForm project={projects.find(p=>p.id===dialog.projectId)} Icon={Icon} onClose={()=>setDialog(null)} onSave={name=>{setProjects(ps=>renameProject(ps,dialog.projectId,name));setDialog(null);}}/>:dialog.kind==='project-access'&&projects.find(p=>p.id===dialog.projectId)?<ComputerAccess project={projects.find(p=>p.id===dialog.projectId)} link={teamLinkFor(teamsView,dialog.projectId)} Icon={Icon} notify={setToast} onClose={()=>setDialog(null)}/>:['project-remove','project-unlink','project-remove-team'].includes(dialog.kind)&&projects.find(p=>p.id===dialog.projectId)?(()=>{const p=projects.find(x=>x.id===dialog.projectId);const kind=dialog.kind.slice(8);return <ProjectActionDialog kind={kind} project={p} link={teamLinkFor(teamsView,p.id)} running={isRunning(p)||Boolean(replying[p.id])} Icon={Icon} onStop={()=>stopProjectWork(p.id)} onConfirm={()=>kind==='remove'?removeProject(p):kind==='unlink'?unlinkProject(p):removeFromTeam(p)} onClose={()=>setDialog(null)}/>;})():dialog.kind==='project'?<ProjectForm onClose={()=>setDialog(null)} onSave={name=>{const p=makeProject(name);setProjects(ps=>[...ps,p]);switchProject(p.id);setView('chat');setDialog(null);setToast('Project created. Add agents in the team tree.');}}/>:null}</Modal>}
    <UpdateDialog updates={updates} Icon={Icon}/>
    {shellDialog?.kind==='settings'&&<SettingsDialog tab={shellDialog.tab} onTab={tab=>setShellDialog({kind:'settings',tab})} onClose={()=>setShellDialog(null)} theme={theme} onTheme={setTheme} name={profileName} onName={setProfileName} updates={updates} appInfo={appInfo}/>}
    {shellDialog?.kind==='help'&&<HelpDialog onClose={()=>setShellDialog(null)}/>}
    {gate==='loading'&&<AccountLoading/>}
    {(gate==='welcome'||gate==='username')&&window.orqestra?.teams&&<AccountWelcome api={window.orqestra.teams} view={teamsView} onView={setTeamsView} onContinueLocal={continueLocal} onDismissEnded={()=>setDismissedEnd(true)} onSignOut={signOutAccount}/>}
    {bootDone&&launch?.kind==='update'&&<UpdateIntro version={appInfo?.appVersion} previous={launch.previous} onDone={()=>setLaunch(l=>({...l,kind:'start'}))}/>}
    {toast&&<div className="toast" role="status"><Icon name="check" size={15}/>{toast}<button aria-label="Dismiss notification" onClick={()=>setToast('')}><Icon name="close" size={13}/></button></div>}
  </div>;
}

function TreeCanvas({savedCamera=null,onCamera,onInspect,graph,extraBoxes=[],overlay=null,products=[],productHost=null,productVersion=0,onOpenProduct,onMoveProduct,fitKey=0,selected,selectedEdge,connecting,onSelect,onSelectEdge,onBackground,onAdd,onEdit,onMove,children,liveStates}) {
  const viewport=useRef(null);
  const gesture=useRef(null);
  const justDragged=useRef(false);
  const [camera,setCamera]=useState(()=>savedCamera?.camera||{x:0,y:0,zoom:.7});
  const [drag,setDrag]=useState(null);
  // Fit once per set of boxes, not on every resize: resizing the pane keeps the zoom and position.
  const boxSignature=`${graph.nodes.length}:${extraBoxes.length}:${products.length}`;
  const fittedFor=useRef(savedCamera?.signature??null);
  const lastFitKey=useRef(fitKey);
  useEffect(()=>{onCamera?.({camera,signature:fittedFor.current});},[camera]);
  useEffect(()=>{
    const el=viewport.current;
    function wheel(event){
      if(event.target.closest?.('.canvas-toolbar,.zoom-controls,.connection-banner'))return;
      event.preventDefault();
      if(gesture.current)return;
      const rect=el.getBoundingClientRect();
      const point={x:event.clientX-rect.left,y:event.clientY-rect.top};
      setCamera(c=>wheelCamera(c,event,point,el.clientHeight));
    }
    el.addEventListener('wheel',wheel,{passive:false});
    return()=>el.removeEventListener('wheel',wheel);
  },[]);
  function fit(){const el=viewport.current;if(!el)return;const boxes=[...graph.nodes,...extraBoxes,...products];if(!boxes.length)return;const maxX=Math.max(...boxes.map(n=>n.x+224+30));const maxY=Math.max(...boxes.map(n=>n.y+159+24));const minX=Math.min(...boxes.map(n=>n.x))-30;const minY=Math.min(...boxes.map(n=>n.y))-24;const top=66,bottom=44;const z=Math.max(.25,Math.min(1.3,(el.clientWidth-24)/(maxX-minX),(el.clientHeight-top-bottom)/(maxY-minY)));setCamera({zoom:z,x:(el.clientWidth-(maxX-minX)*z)/2-minX*z,y:top-minY*z});}
  useEffect(()=>{const observer=new ResizeObserver(()=>{const el=viewport.current;if(!el||!el.clientWidth||!el.clientHeight||fittedFor.current===boxSignature)return;fittedFor.current=boxSignature;fit();});observer.observe(viewport.current);return()=>observer.disconnect();},[boxSignature]);
  useEffect(()=>{if(fitKey!==lastFitKey.current){lastFitKey.current=fitKey;fit();}},[fitKey]);
  const nodeAt=n=>drag?.id===n.id?{...n,x:drag.x,y:drag.y}:n;
  function down(e,node){justDragged.current=false;if(e.button!==0||e.target.closest('button'))return;if(node&&connecting){onSelect(node.id);return;}e.preventDefault();e.currentTarget.setPointerCapture(e.pointerId);gesture.current={kind:node?'node':'pan',id:node?.id,startX:e.clientX,startY:e.clientY,x:node?.x??camera.x,y:node?.y??camera.y,moved:false};if(!node)onBackground();else if(!String(node.id).startsWith('product:'))onSelect(node.id);}
  function move(e){const g=gesture.current;if(!g)return;const dx=e.clientX-g.startX,dy=e.clientY-g.startY;if(Math.abs(dx)+Math.abs(dy)>3)g.moved=true;if(g.kind==='node')setDrag({id:g.id,x:Math.max(0,g.x+dx/camera.zoom),y:Math.max(0,g.y+dy/camera.zoom)});else setCamera(c=>({...c,x:g.x+dx,y:g.y+dy}));}
  function up(){const g=gesture.current;justDragged.current=Boolean(g?.moved);gesture.current=null;if(g?.kind==='node'&&g.moved&&drag){if(drag.id.startsWith('product:'))onMoveProduct?.(drag.id.slice(8),Math.round(drag.x),Math.round(drag.y));else onMove(drag.id,Math.round(drag.x),Math.round(drag.y));}setDrag(null);}
  function zoom(delta){const el=viewport.current;setCamera(c=>zoomAt(c,{x:el.clientWidth/2,y:el.clientHeight/2},c.zoom+delta));}
  return <div ref={viewport} className={`canvas ${connecting?'canvas-connecting':''}`} onPointerDown={e=>{if(e.target===e.currentTarget||e.target.classList.contains('canvas-ground'))down(e,null);}} onPointerMove={move} onPointerUp={up} onPointerCancel={()=>{gesture.current=null;setDrag(null);}}>
    <div className="canvas-ground"/>{children}<div className="canvas-world" style={{transform:`translate(${camera.x}px,${camera.y}px) scale(${camera.zoom})`}}><svg className="edges" width="5000" height="4000">{graph.edges.map(edge=>{const a=graph.nodes.find(n=>n.id===edge.from),b=graph.nodes.find(n=>n.id===edge.to);if(!a||!b)return null;const n=nodeAt(a),m=nodeAt(b);const x1=n.x+112,y1=n.y+158,x2=m.x+112,y2=m.y;const dy=Math.max(60,Math.abs(y2-y1)/2);const d=`M ${x1} ${y1} C ${x1} ${y1+dy},${x2} ${y2-dy},${x2} ${y2}`;return <g key={edge.id} className={`edge ${isWorking(liveStates?.[edge.to])?'edge-flowing':''} ${selectedEdge===edge.id?'edge-selected':''}`} onPointerDown={e=>e.stopPropagation()} onClick={()=>onSelectEdge(edge.id)}><path className="edge-hit" d={d}/><path className="edge-line" d={d}/><circle cx={x2} cy={y2} r="3.5"/></g>;})}{products.flatMap(p=>p.agents.map(agentId=>{const a=graph.nodes.find(n=>n.id===agentId);if(!a)return null;const n=nodeAt(a);const q=nodeAt({id:`product:${p.id}`,x:p.x,y:p.y});const x1=n.x+112,y1=n.y+159,x2=q.x+112,y2=q.y;const dy=Math.max(60,Math.abs(y2-y1)/2);const d=`M ${x1} ${y1} C ${x1} ${y1+dy},${x2} ${y2-dy},${x2} ${y2}`;return <g key={`${p.id}:${agentId}`} className={`edge edge-product ${p.building&&liveStates?.[agentId]==='working'?'edge-flowing':''}`}><path className="edge-line" d={d}/><circle cx={x2} cy={y2} r="3.5"/></g>;}))}</svg>{products.map(p=>{const box={id:`product:${p.id}`,x:p.x,y:p.y};const at=nodeAt(box);return <ProductNode key={box.id} product={{...p,x:at.x,y:at.y}} host={productHost} version={productVersion} Icon={Icon} dragging={drag?.id===box.id} onPointerDown={e=>{e.stopPropagation();if(!connecting)down(e,box);}} onPointerMove={move} onPointerUp={e=>{e.stopPropagation();up();}} onOpen={()=>{if(!justDragged.current)onOpenProduct?.(p.id);}}/>;})}{graph.nodes.map(original=>{const n=nodeAt(original);const state=liveStates?.[n.id]||'idle';const working=isWorking(state);const real=isRealAgent(n);return <div key={n.id} className={`agent-node agent-state-${state} ${real?'':'node-no-tool'} ${selected===n.id?'node-selected':''} ${connecting&&n.id!==connecting?'node-connect-target':''}`} style={{left:n.x,top:n.y}} onPointerDown={e=>{e.stopPropagation();down(e,original);}} onPointerMove={move} onPointerUp={e=>{e.stopPropagation();up();}} onClick={e=>{if(!justDragged.current&&!connecting&&!e.target.closest('button'))onInspect?.(n.id);}} onDoubleClick={()=>onEdit(n.id)}>{working&&<span className="working-halo"/>}<span className="node-port top-port"/><div className="node-heading"><span className={`node-avatar ${ROLE_COLOR[n.role]}`}><Icon name={ROLE_ICON[n.role]} size={19}/></span><div><span className="node-role">{n.role}{!isAgreedRole(n.role)&&' · not an agreed role'}</span><strong>{n.name}</strong></div><button className="node-menu" title={`Configure ${n.name}`} aria-label={`Configure ${n.name}`} onPointerDown={e=>e.stopPropagation()} onClick={()=>onEdit(n.id)}><Icon name="more" size={16}/></button></div><div className="node-model">{real?<><span className={`provider-dot provider-${n.agent.tool}`}/>{n.provider}<span className="dot-separator">·</span>{n.model}{n.agent.effort&&<><span className="dot-separator">·</span>{n.agent.effort}</>}</>:<span className="node-no-tool-label">No tool chosen · configure to run it on Claude Code or Codex</span>}</div><div className="node-bottom"><span><span className="status-dot"/>{state!=='idle'?state.replaceAll('_',' ').replace(/^./,c=>c.toUpperCase()):real?'Ready':'Not set up'}</span><span className="node-bottom-actions"><span>Priority {n.priority}</span></span></div><button className="node-add" title={`Add child agent to ${n.name}`} aria-label={`Add child agent to ${n.name}`} onPointerDown={e=>e.stopPropagation()} onClick={()=>onAdd(n.id)}><Icon name="plus" size={14}/></button></div>;})}{overlay?.(nodeAt)}</div><div className="canvas-help"><Icon name="tree" size={14}/>{connecting?'Click an agent to connect':'Drag agents to arrange your team'}<span>Double-click to configure</span></div><div className="zoom-controls"><button title="Zoom out" aria-label="Zoom out" onClick={()=>zoom(-.1)}>−</button><span>{Math.round(camera.zoom*100)}%</span><button title="Zoom in" aria-label="Zoom in" onClick={()=>zoom(.1)}>+</button><span className="toolbar-divider"/><button title="Fit tree to view" aria-label="Fit tree to view" onClick={fit}><Icon name="expand" size={14}/></button></div>
  </div>;
}

function Modal({children,onClose}) {const ref=useRef(null);useEffect(()=>{const previous=document.activeElement;const el=ref.current;el.querySelector('input,select,button')?.focus();const trap=e=>{if(e.key!=='Tab')return;const items=[...el.querySelectorAll('button:not([disabled]),input,select,textarea')];if(e.shiftKey&&document.activeElement===items[0]){e.preventDefault();items.at(-1)?.focus();}else if(!e.shiftKey&&document.activeElement===items.at(-1)){e.preventDefault();items[0]?.focus();}};el.addEventListener('keydown',trap);return()=>{el.removeEventListener('keydown',trap);previous?.focus();};},[]);return <div className="modal-scrim" onMouseDown={e=>{if(e.target===e.currentTarget)onClose();}}><div className="modal" role="dialog" aria-modal="true" aria-labelledby="dialog-title" ref={ref}>{children}</div></div>;}
// Agents in other projects that can be added here with their skills (not ones already in this tree).
// Agents of removed projects stay in the agent library, so they can still be added (with their skills).
function existingAgents(projects,project,library=[]){const here=new Set(project.graph.nodes.map(n=>n.agentKey).filter(Boolean));const seen=new Map();for(const p of projects){if(p.id===project.id)continue;for(const n of p.graph?.nodes||[]){if(n.role==='Manager'||!n.agentKey||here.has(n.agentKey)||seen.has(n.agentKey))continue;seen.set(n.agentKey,{...n,projectName:p.name});}}for(const a of library){if(!a?.agentKey||a.role==='Manager'||here.has(a.agentKey)||seen.has(a.agentKey))continue;seen.set(a.agentKey,{...a,projectName:`${a.projectName} (removed)`});}return [...seen.values()];}
function AgentForm({node,parent,onSave,onClose,tools=[],onTest,existing=[]}) {
  // Adding an agent you already have (from another project) keeps its permanent key, so the skills
  // installed on it come along (Capabilities). Two agents with the same name stay separate.
  const [reuse,setReuse]=useState(null);
  const [role,setRole]=useState(node?.role||'');const [name,setName]=useState(node?.name||'');const [priority,setPriority]=useState(node?.priority||1);const [run,setRun]=useState(()=>agentTarget(node)||{provider:'none',model:null,effort:null});const toolStatus=tools.find(t=>t.provider===run.provider);const isAuto=run.provider==='auto'&&node?.role==='Manager';const real=Boolean(toolStatus)||isAuto;
  return <form onSubmit={e=>{e.preventDefault();if(!role)return;const keepTool=!node&&reuse&&(agentTarget(reuse)?.provider||'none')===run.provider;onSave({name:name.trim()||role,role,...(keepTool?{agent:reuse.agent??null,...(reuse.provider?{provider:reuse.provider}:{}),...(reuse.model?{model:reuse.model}:{})}:nodeFieldsFor(real?run:null,toolStatus,role)),...(node?{priority:Number(priority)}:{}),...(!node&&reuse?{agentKey:reuse.agentKey}:{})});}}><div className="dialog-heading"><span className="dialog-icon"><Icon name={node?'settings':'plus'} size={21}/></span><button className="icon-button" type="button" aria-label="Close agent editor" onClick={onClose}><Icon name="close"/></button></div><h2 id="dialog-title">{node?'Configure agent':'A new teammate.'}</h2><p className="dialog-description">{node?'Give this agent a clear role in your project.':'Choose a role and the tool it runs on. Your tree takes care of the connection.'}</p>{parent&&<div className="parent-chip"><Icon name="tree" size={14}/>{parent.name}<Icon name="chevron" size={12}/><span>New agent</span><span className="auto-label">Auto-connected</span></div>}<div className="form-fields">{!node&&existing.length>0&&<label>Add an agent you already have<select value={reuse?.agentKey||''} onChange={e=>{const a=existing.find(x=>x.agentKey===e.target.value)||null;setReuse(a);if(a){setRole(a.role);setName(a.name);setRun(agentTarget(a)||{provider:'none',model:null,effort:null});}}}><option value="">No, a new agent</option>{existing.map(a=><option key={a.agentKey} value={a.agentKey}>{a.name} ({a.role}) · from {a.projectName}</option>)}</select><small>It keeps the skills installed on it.</small></label>}<label>Role<select value={role} disabled={node?.role==='Manager'} required onChange={e=>setRole(e.target.value)}><option value="" disabled>Choose a role</option>{(node?.role==='Manager'?['Manager']:node&&!isAgreedRole(node.role)?[node.role,...ROLES]:ROLES).map(r=><option key={r} value={r}>{isAgreedRole(r)?r:`${r} (not an agreed role)`}</option>)}</select></label><AgentRunsOn run={run} onChange={setRun} tools={tools} canAuto={node?.role==='Manager'}/>{toolStatus&&<TryAgent run={run} onTest={onTest}/>}<label>Agent name <span className="optional">Optional</span><input maxLength={48} placeholder={role?`e.g. ${role==='Builder'?'Frontend builder':role}`:'Give your agent a name'} value={name} onChange={e=>setName(e.target.value)}/></label>{node&&<label>Role priority<input type="number" min="1" max="9999" required value={priority} onChange={e=>setPriority(e.target.value)}/><small>Lower numbers have higher priority. Each priority can be used once per role.</small></label>}</div><div className="form-note"><Icon name="link" size={14}/><span>{real?(isAuto?'Runs on your own subscriptions through the official tools. Nothing is billed per use.':'Runs on your own subscription through the official tool. Nothing is billed per use.'):'Without a tool this agent cannot work yet. Connect Claude Code or Codex under AI accounts to choose one.'}</span></div><div className="dialog-footer"><button className="button" type="button" onClick={onClose}>Cancel</button><button className="button primary-button" type="submit" disabled={!role}>{node?'Save changes':<><Icon name="plus" size={15}/>Add agent</>}</button></div></form>;
}
function ProjectForm({onSave,onClose}){const [name,setName]=useState('');return <form onSubmit={e=>{e.preventDefault();if(name.trim())onSave(name.trim());}}><div className="dialog-heading"><span className="dialog-icon"><Icon name="folder" size={21}/></span><button className="icon-button" type="button" aria-label="Close new project" onClick={onClose}><Icon name="close"/></button></div><h2 id="dialog-title">Room for your next idea.</h2><p className="dialog-description">Every project gets its own conversation and team tree.</p><div className="form-fields"><label>Project name<input value={name} onChange={e=>setName(e.target.value)} placeholder="e.g. My next app" maxLength={50} required/></label></div><div className="dialog-footer"><button className="button" type="button" onClick={onClose}>Cancel</button><button className="button primary-button" type="submit" disabled={!name.trim()}>Create project</button></div></form>;}


createRoot(document.getElementById('root')).render(<App/>);
