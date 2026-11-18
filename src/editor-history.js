const copy=value=>Array.isArray(value)?value.map(copy):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,item])=>[key,copy(item)])):value;
// Immutable snapshots share image strings; limit the undo stack to 30 edits.
export class EditorHistory {
 constructor(limit=30){this.limit=limit;this.reset({});}
 reset(project){this.past=[];this.future=[];this.current=copy(project);}
 record(project){this.past.push(this.current);if(this.past.length>this.limit)this.past.shift();this.current=copy(project);this.future=[];}
 travel(direction,project){const from=direction==='undo'?this.past:this.future,to=direction==='undo'?this.future:this.past;if(!from.length)return null;to.push(copy(project));const result=copy(from.pop());result.revision=project.revision;result.status='draft';result.reviewedRevision=null;result.approvedRevision=null;this.current=copy(result);return result;}
}
export function alignNodes(nodes,action){
 const movable=nodes.filter(n=>!n.locked);if(movable.length<2)return;
 const left=Math.min(...movable.map(n=>n.x)),right=Math.max(...movable.map(n=>n.x+n.w)),top=Math.min(...movable.map(n=>n.y)),bottom=Math.max(...movable.map(n=>n.y+n.h));
 if(action==='spaceX'||action==='spaceY'){
  if(movable.length<3)return;const horizontal=action==='spaceX',pos=horizontal?'x':'y',size=horizontal?'w':'h';
  const list=[...movable].sort((a,b)=>a[pos]-b[pos]),span=horizontal?right-left:bottom-top,gap=(span-list.reduce((s,n)=>s+n[size],0))/(list.length-1);let at=list[0][pos];for(const n of list){n[pos]=at;at+=n[size]+gap;}return;
 }
 for(const n of movable){if(action==='left')n.x=left;if(action==='right')n.x=right-n.w;if(action==='top')n.y=top;if(action==='bottom')n.y=bottom-n.h;if(action==='center')n.x=(left+right-n.w)/2;}
}
export function snapPosition(node,others,w,h,tolerance=6){
 const result={x:node.x,y:node.y},guides=[];
 for(const [pos,size,limit] of [['x','w',w],['y','h',h]]){
  const targets=[0,limit/2,limit,...others.filter(n=>n.id!==node.id).flatMap(n=>[n[pos],n[pos]+n[size]/2,n[pos]+n[size]])];
  let best=tolerance,delta=0,guide=null;
  for(const offset of [0,node[size]/2,node[size]])for(const target of targets){const d=target-node[pos]-offset;if(Math.abs(d)<best){best=Math.abs(d);delta=d;guide=target;}}
  result[pos]=Math.max(0,Math.min(limit-node[size],node[pos]+delta));if(guide!==null)guides.push({axis:pos,value:guide});
 }
 return {...result,guides};
}
