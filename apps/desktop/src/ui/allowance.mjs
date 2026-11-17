export const DEMO_ALLOWANCES = {OpenAI:74,Anthropic:18,Google:61,xAI:88};

export function profilesFor(node) {
  return [{id:'primary',provider:node.provider,model:node.model},...(node.backups||[])];
}
export function activeProfile(node) {
  const profiles=profilesFor(node);
  return profiles.find(p=>p.id===node.activeProfileId)||profiles[0];
}
export function recoveryFor(node, allowances) {
  const profiles=profilesFor(node);
  const index=Math.max(0,profiles.findIndex(p=>p.id===(node.activeProfileId||'primary')));
  // Unknown is not exhaustion: do not infer a provider balance or trigger a takeover.
  if(allowances[profiles[index].provider]!==0) return {node,changed:false};
  for(let i=index+1;i<profiles.length;i++) {
    if(typeof allowances[profiles[i].provider]==='number'&&allowances[profiles[i].provider]>0) {
      return {node:{...node,activeProfileId:profiles[i].id,recoveryPaused:false},changed:true,from:profiles[index],to:profiles[i]};
    }
  }
  return {node:{...node,recoveryPaused:true},changed:!node.recoveryPaused,from:profiles[index],to:null};
}
