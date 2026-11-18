import {backgroundBox,sizeInfo} from './sizing.js';
import {selectionBox} from './poster-reuse.js';

export function posterSelection(project,width,height,start,end){
 const scene=sizeInfo(project),bg=backgroundBox(project,width,height);
 const a={x:(start.x*scene.w-bg.x)/bg.w,y:(start.y*scene.h-bg.y)/bg.h};
 const b={x:(end.x*scene.w-bg.x)/bg.w,y:(end.y*scene.h-bg.y)/bg.h};
 const box=selectionBox(a,b);
 if(box.w*width<8||box.h*height<8)throw new Error('請在底圖內拖曳框選商品區域');
 return box;
}

// An explicit selection layer intercepts Fabric's object-selection gestures only
// while framing a source-image region. Remove it before opening the edit dialog.
export function selectOnPoster(element,onSelect,onError){
 let bounds=element.getBoundingClientRect();
 const layer=document.createElement('div'),outline=document.createElement('div'),hint=document.createElement('div');
 layer.className='poster-selection-layer';Object.assign(layer.style,{left:`${bounds.left}px`,top:`${bounds.top}px`,width:`${bounds.width}px`,height:`${bounds.height}px`});
 outline.className='poster-selection-outline';outline.hidden=true;hint.className='poster-selection-hint';hint.textContent='拖曳框選完整商品區域 · Esc 取消';layer.append(outline,hint);document.body.append(layer);
 let start=null;
 const point=e=>({x:Math.max(0,Math.min(1,(e.clientX-bounds.left)/bounds.width)),y:Math.max(0,Math.min(1,(e.clientY-bounds.top)/bounds.height))});
 function reposition(){bounds=element.getBoundingClientRect();Object.assign(layer.style,{left:`${bounds.left}px`,top:`${bounds.top}px`,width:`${bounds.width}px`,height:`${bounds.height}px`});}
 function cleanup(){layer.remove();document.removeEventListener('keydown',key);window.removeEventListener('resize',reposition);window.removeEventListener('scroll',reposition,true);}
 function key(e){if(e.key==='Escape'){e.preventDefault();cleanup();}}
 document.addEventListener('keydown',key);window.addEventListener('resize',reposition);window.addEventListener('scroll',reposition,true);
 layer.onpointerdown=e=>{if(e.button!==0)return;e.preventDefault();start=point(e);layer.setPointerCapture(e.pointerId);};
 layer.onpointermove=e=>{if(!start)return;const b=selectionBox(start,point(e));outline.hidden=false;Object.assign(outline.style,{left:`${b.x*100}%`,top:`${b.y*100}%`,width:`${b.w*100}%`,height:`${b.h*100}%`});};
 layer.onpointercancel=cleanup;
 layer.onpointerup=e=>{if(!start)return;const end=point(e),a=start;cleanup();Promise.resolve().then(()=>onSelect(a,end)).catch(onError);};
 return cleanup;
}
