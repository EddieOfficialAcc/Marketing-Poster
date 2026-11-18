// Run release checks in the DOM capture phase, before an editor transforms objects.
export function installDragGuard(surface,finish,{root=document,host=window,defer=fn=>setTimeout(fn,0)}={}){
 let pointer=null,generation=0;
 const listeners=[];
 function on(target,type,fn){target.addEventListener(type,fn,true);listeners.push(()=>target.removeEventListener(type,fn,true));}
 function stop(){pointer=null;generation++;finish();}
 on(surface,'pointerdown',e=>{
  if(e.button!==0||e.isPrimary===false)return;
  stop();pointer=e.pointerId;
 });
 on(root,'pointermove',e=>{
  const released=(e.pointerType==='mouse'||e.pointerType==='pen')&&!(e.buttons&1);
  if(released)stop();
 });
 on(root,'pointerup',e=>{
  if(pointer!==null&&e.pointerId!==pointer)return;
  pointer=null;const ticket=++generation;
  // Let the editor's own release event commit its final pointer position first.
  defer(()=>{if(generation===ticket)finish();});
 });
 on(root,'pointercancel',e=>{if(pointer===null||pointer===e.pointerId)stop();});
 on(surface,'lostpointercapture',()=>{const ticket=++generation;pointer=null;defer(()=>{if(ticket===generation)finish();});});
 on(host,'blur',stop);
 on(root,'visibilitychange',()=>{if(root.hidden)stop();});
 return {stop,dispose(){listeners.forEach(remove=>remove());stop();}};
}
