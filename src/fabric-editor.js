import {strikeText,strikeStyles,textFamily} from './rich-text.js';
import {priceTagNode} from './price-tag.js';
import {posterMasks,paintedPosterMasks} from './poster-reuse.js';
import {retailText,canvasMeasure,region} from './retail.js';
import {cleanTemplateElements} from './template-layout.js';
import {containIcon} from './icon-assets.js';
import {productMetrics,imageRegion} from './auto-layout.js';
import {installDragGuard} from './drag-guard.js';
import {sizeInfo,backgroundBox,displaySize} from './sizing.js';
import { WIDTH, HEIGHT, priceLabel } from './model.js';
import { pictures, pictureAt } from './composition.js';

const fontFamily='"PingFang TC", "Microsoft JhengHei", sans-serif';
const controls={originX:'left',originY:'top',strokeWidth:0,lockRotation:true,lockSkewingX:true,lockSkewingY:true,lockScalingFlip:true,cornerColor:'#296b47',borderColor:'#296b47',cornerStyle:'circle',transparentCorners:false};
const measure=canvasMeasure(document.createElement('canvas').getContext('2d'));
const fixed={...controls,selectable:false,evented:false};

// Use a local, build-pinned dependency. No public CDN calls from the editor.
export async function createFabricEditor(element, callbacks) {
  const url=new URL('../vendor/fabric/index.min.js',import.meta.url);
  const response=await fetch(url,{method:'HEAD'});
  if(!response.ok)throw new Error(`Fabric 資源不存在或無法讀取（HTTP ${response.status}），請重新構建前端`);
  const mime=response.headers.get('content-type')||'';
  if(!/(javascript|ecmascript)/i.test(mime))throw new Error(`Fabric 腳本類型不正確：${mime||'未提供 Content-Type'}`);
  const F=await import(url.href);
  const canvas=new F.Canvas(element,{width:WIDTH,height:HEIGHT,preserveObjectStacking:true,selection:true,enablePointerEvents:true,enableRetinaScaling:true,uniformScaling:true,uniScaleKey:null});
  let rendering=false, serial=0, latestProject=null, latestSelected=null, latestRegionKey=null, missedUpdate=false, suspended=false, editBackground=false, moveBackground=false, displayScale=1;
  const cache=new Map();
  function loadImage(src,used){
    used?.add(src);
    if(!cache.has(src))cache.set(src,new Promise((resolve,reject)=>{const img=new Image();img.onload=()=>resolve(img);img.onerror=()=>{cache.delete(src);reject(new Error('商品或底圖無法載入'));};img.src=src;}));
    return cache.get(src);
  }
  const text=(value,x,y,w,size,color,weight=400,family=fontFamily)=>new F.Textbox(String(value),{...fixed,left:x,top:y,width:w,fontSize:size,fontFamily:family,fill:color,fontWeight:weight,splitByGrapheme:true,lineHeight:1.15});
  const rect=(x,y,w,h,fill)=>new F.Rect({...fixed,left:x,top:y,width:w,height:h,fill});
  function fitText(value,x,y,w,size,color,weight,maxHeight,minFont=8,autoFit=true,align='left',lineHeight=1.3,family=fontFamily){
    // Fabric 行高另乘 1.13 的字體係數；換算後與匯出畫布的行距一致。
    const result=text(strikeText(value).plain,x,y,w,size,color,weight,family);result.set({textAlign:align,styles:strikeStyles(value),lineHeight:lineHeight/1.13});result.initDimensions();
    while(autoFit&&result.height>maxHeight&&result.fontSize>minFont){result.set('fontSize',Math.max(minFont,result.fontSize-1));result.initDimensions();}
    return result;
  }
  async function objects(project, exporting=false, used=null){
    const {w:WIDTH,h:HEIGHT}=sizeInfo(project),image=src=>loadImage(src,used);
    const result=[], bg=project.template==='custom'?project.background:{membership:'output/evaluation/membership-background-v1.png',promotion:'output/evaluation/promotion-background-v1.png'}[project.template];
    if(bg){const img=await image(bg),box=backgroundBox(project,img.width,img.height);result.push(rect(0,0,WIDTH,HEIGHT,'#fff5df'));const background=new F.FabricImage(img,{...fixed,left:box.x,top:box.y,scaleX:box.w/img.width,scaleY:box.h/img.height});background.backgroundNode=true;result.push(background);}

    else{
      result.push(rect(0,0,WIDTH,HEIGHT,'#fff5df'));
      for(const item of cleanTemplateElements(project)){if(item.type==='image'){const img=await image(item.src);result.push(new F.FabricImage(img,{...fixed,left:item.x,top:item.y,scaleX:item.w/img.width,scaleY:item.h/img.height}));continue;}result.push(item.type==='rect'
        ?rect(item.x,item.y,item.w,item.h,item.color)
        :fitText(item.value,item.x,item.y,item.w,item.font,item.color,item.weight,item.h,1));}
    }
    for(const m of paintedPosterMasks(project)){const mask=rect(m.x,m.y,m.w,m.h,m.color);mask.set({strokeWidth:0,stroke:null});result.push(mask);}
    for(const n of project.nodes){
      const children=[rect(0,0,n.w,n.h,'rgba(0,0,0,0)')];
      if(n.type==='imageIcon'){
        const asset=(project.icons||[]).find(a=>a.id===n.iconId);if(!asset)throw new Error('缺少標識圖片');
        const img=await image(asset.imageUrl),box=containIcon({...n,x:0,y:0},img.width,img.height);
        children.push(new F.FabricImage(img,{...fixed,left:box.x,top:box.y,scaleX:box.w/img.width,scaleY:box.h/img.height}));
      }else if(n.type==='product'){
        const {font:size,padding,priceSize}=productMetrics(n.h,n.fontSize,n.priceFontSize),box=imageRegion(n),areaH=box.h;
        for(const p of pictures(n)){
          const asset=project.products.find(a=>a.id===p.productId);if(!asset)throw new Error('缺少組內商品圖片');
          const img=await image(asset.imageUrl),scale=Math.min(p.w*box.w/img.width,p.h*areaH/img.height);
          const object=new F.FabricImage(img,{...fixed,evented:true,left:box.x+p.x*box.w+(p.w*box.w-img.width*scale)/2,top:box.y+p.y*areaH+p.h*areaH-img.height*scale,scaleX:scale,scaleY:scale,shadow:new F.Shadow({color:'#1c241b40',blur:n.shadow,offsetY:n.shadow/2})});
          object.pictureId=p.id;children.push(object);
        }
        for(const p of retailText(n,measure)){
          const object=p.type==='rect'?rect(p.x,p.y,p.w,p.h,p.color):new F.FabricText(p.text,{...fixed,left:p.x,top:p.y,fontSize:p.size,fontFamily:p.family,fill:p.color,fontWeight:p.weight,linethrough:!!p.strike});
          if(p.clip&&p.type==='text'){const fit=Math.min(1,(p.clip.x+p.clip.w-p.x)/Math.max(1,object.width),(p.clip.y+p.clip.h-p.y)/Math.max(1,object.height));object.set({scaleX:Math.max(0,fit),scaleY:Math.max(0,fit)});}
          object.regionKey=p.part;object.set({evented:true});children.push(object);
        }
      }else{
        if(n.priceTag){for(const p of retailText(priceTagNode(n),measure).filter(p=>p.text!==''))children.push(p.type==='rect'?rect(p.x,p.y,p.w,p.h,p.color):new F.FabricText(p.text,{...fixed,left:p.x,top:p.y,fontSize:p.size,fontFamily:p.family,fill:p.color,fontWeight:p.weight}));}
        else{if(n.type==='icon'){const back=rect(0,0,n.w,n.h,n.color);back.set({rx:10,ry:10});children.push(back);}
        children.push(fitText(n.text,n.type==='icon'?10:0,n.type==='icon'?10:0,n.w-(n.type==='icon'?20:0),n.fontSize,n.type==='icon'?'#fff':n.color,n.type==='icon'?600:(n.textLayout?.weight||600),n.h-(n.type==='icon'?20:0),8,n.autoFit!==false,n.textLayout?.align||'left',n.type==='icon'?1.3:(n.textLayout?.lineHeight||1.3),n.type==='icon'?fontFamily:textFamily(n)));}
      }
      const group=new F.Group(children,{...controls,left:n.x,top:n.y,width:n.w,height:n.h,objectCaching:false,subTargetCheck:true,layoutManager:new F.LayoutManager(new F.FixedLayout())});
      group.nodeId=n.id;group.nodeLocked=!!n.locked;group.set({lockMovementX:!!n.locked,lockMovementY:!!n.locked,lockScalingX:!!n.locked,lockScalingY:!!n.locked});group.setControlsVisibility({mtr:false});result.push(group);
    }
    if(exporting&&project.exportMode!=='print'){const k=WIDTH/900;result.push(rect(0,HEIGHT-39*k,WIDTH,39*k,'#ffffffdb'),text(`待核對海報 · 未核對門店價格 · V${project.revision}`,22*k,HEIGHT-30*k,WIDTH-44*k,17*k,'#b84b43',600));}
    return result;
  }
  function resize(){
    const stage=element.closest('.canvas-stage');if(!stage||stage.clientWidth===0)return;
    const {w:WIDTH,h:HEIGHT}=sizeInfo(latestProject||{});
    const {width}=displaySize(latestProject||{},displayScale);
    canvas.setDimensions({width:`${width}px`,height:`${width*HEIGHT/WIDTH}px`},{cssOnly:true});canvas.calcOffset();
  }
  const observer=new ResizeObserver(resize);observer.observe(element.closest('.canvas-stage'));resize();
  async function update(project,selected,backgroundMode=editBackground,moveMode=moveBackground,regionKey=null){
    moveBackground=moveMode;
    editBackground=backgroundMode;
    latestProject=project;latestSelected=selected;latestRegionKey=regionKey;
    if(suspended){missedUpdate=true;return;}  // re-rendered once the gesture ends
    missedUpdate=false;
    const ticket=++serial,used=new Set();
    try{
      const nodes=await objects(structuredClone(project),false,used);if(ticket!==serial)return;
      // Drop decoded images no longer on the poster (deleted products, replaced cutouts…).
      for(const src of cache.keys())if(!used.has(src))cache.delete(src);
      const dimensions=sizeInfo(project);
      rendering=true;canvas.setDimensions({width:dimensions.w,height:dimensions.h});canvas.discardActiveObject();canvas.remove(...canvas.getObjects());canvas.add(...nodes);
      for(const n of nodes){if(n.backgroundNode){n.set({selectable:editBackground,evented:editBackground,lockMovementX:!moveBackground,lockMovementY:!moveBackground});n.setControlsVisibility({mtr:false,ml:false,mr:false,mt:false,mb:false});}else if(n.nodeId)n.set({selectable:!editBackground,evented:!editBackground});}
      let target=nodes.find(n=>editBackground?n.backgroundNode:n.nodeId===selected);
      const node=project.nodes.find(n=>n.id===selected);
      if(regionKey&&node?.type==='product'&&!editBackground){
        const b=region(node,regionKey),overlay=new F.Rect({...controls,left:node.x+b.x,top:node.y+b.y,width:b.w,height:b.h,fill:'rgba(22,140,196,0.04)',stroke:'#168cc4',strokeWidth:1,lockMovementX:!!node.locked,lockMovementY:!!node.locked,lockScalingX:!!node.locked,lockScalingY:!!node.locked});
        overlay.regionNodeId=node.id;overlay.regionKey=regionKey;overlay.setControlsVisibility({mtr:false});canvas.add(overlay);target=overlay;
      }
      if(target)canvas.setActiveObject(target);

      canvas.requestRenderAll();resize();
    }catch(error){callbacks.error(error);}finally{rendering=false;}
  }
  function selected(){if(rendering||suspended)return;const active=canvas.getActiveObjects();if(active.some(o=>o.regionNodeId))return;const ids=active.map(o=>o.nodeId||o.regionNodeId).filter(Boolean);callbacks.select(ids);}
  canvas.on('selection:created',selected);canvas.on('selection:updated',selected);canvas.on('selection:cleared',selected);
  canvas.on('before:transform',()=>{suspended=true;++serial;});
  let guideObjects=[];
  const clearGuides=()=>{if(guideObjects.length)canvas.remove(...guideObjects);guideObjects=[];};
  canvas.on('object:moving',event=>{
    clearGuides();const object=event.target;if(!object?.nodeId||object.nodeLocked)return;
    const point=object.getXY(),scaling=object.getObjectScaling(),snap=callbacks.snap?.({id:object.nodeId,x:point.x,y:point.y,w:object.width*scaling.x,h:object.height*scaling.y});
    if(!snap)return;object.set({left:snap.x,top:snap.y});
    const dimensions=sizeInfo(latestProject);
    guideObjects=(snap.guides||[]).map(g=>new F.Line(g.axis==='x'?[g.value,0,g.value,dimensions.h]:[0,g.value,dimensions.w,g.value],{...fixed,stroke:'#168cc4',strokeWidth:1,strokeDashArray:[5,5]}));
    canvas.add(...guideObjects);
  });

  let pendingTransform=null;
  function flushTransform(){
    if(!pendingTransform)return;
    const result=pendingTransform;pendingTransform=null;suspended=false;
    if(result.region){const {id,key,box}=result.region;callbacks.regionModify?.(id,key,box);}
    if(result.background)callbacks.background(result.background);
    if(result.updates.length)callbacks.modify(result.updates);
  }
  function resumeRendering(){
    flushTransform();
    if(missedUpdate&&!suspended&&latestProject)update(latestProject,latestSelected,editBackground,moveBackground,latestRegionKey);
  }
  canvas.on('object:modified',()=>{
    // Keep Fabric's active selection intact until its release handler finishes.
    // getXY/getObjectScaling include any temporary multi-selection transform.
    const active=canvas.getActiveObjects();
    const box=o=>{const point=o.getXY(),scale=o.getObjectScaling();return {x:point.x,y:point.y,w:o.width*scale.x,h:o.height*scale.y};};
    const bg=active.find(o=>o.backgroundNode),overlay=active.find(o=>o.regionNodeId);
    const parent=overlay&&latestProject.nodes.find(n=>n.id===overlay.regionNodeId),rbox=overlay&&box(overlay);
    const editedRegion=parent?{id:parent.id,key:overlay.regionKey,box:{...rbox,x:rbox.x-parent.x,y:rbox.y-parent.y}}:null;
    pendingTransform={region:editedRegion,updates:active.filter(o=>o.nodeId).map(o=>({id:o.nodeId,...box(o)})),background:bg?box(bg):null};
    queueMicrotask(flushTransform);
  });
  function endGesture(){
    clearGuides();
    if(suspended){canvas.endCurrentTransform();suspended=false;}
    resumeRendering();
  }
  const gestureGuard=installDragGuard(canvas.upperCanvasEl,endGesture);
  canvas.on('mouse:up',event=>{
    clearGuides();
    // object:modified fires before mouse:up, so a pending transform means this was a drag, not a click.
    const dragged=!!pendingTransform||event.isClick===false;
    suspended=false;queueMicrotask(resumeRendering);
    if(dragged)return;
    const group=event.target,part=[...(event.subTargets||[])].reverse().find(o=>o.regionKey);
    if(group?.nodeId&&part&&canvas.getActiveObjects().length===1){callbacks.region?.(group.nodeId,part.regionKey);return;}
    const picture=[...(event.subTargets||[])].reverse().find(o=>o.pictureId);
    if(group?.nodeId&&canvas.getActiveObjects().length===1){
      const node=latestProject?.nodes.find(n=>n.id===group.nodeId);
      const point=event.scenePoint||canvas.getScenePoint(event.e);
      const id=picture?.pictureId||(node&&pictureAt(node,point,latestProject.products));
      if(id)callbacks.picture?.(group.nodeId,id);
    }
  });
  return {
    update,
    stopDragging(){gestureGuard.stop();},
    setDisplayScale(value){endGesture();displayScale=value;resize();},
    remove(ids){
      ++serial;suspended=false;rendering=true;
      try{canvas.discardActiveObject();canvas.remove(...canvas.getObjects().filter(o=>ids.includes(o.nodeId||o.regionNodeId)));latestSelected=null;canvas.requestRenderAll();}
      finally{rendering=false;}
    },
    selectedIds:()=>[...new Set(canvas.getActiveObjects().map(o=>o.nodeId||o.regionNodeId).filter(Boolean))],
    async renderBlob(project){
      await document.fonts.ready;
      const {w:WIDTH,h:HEIGHT,scale,width:pixelW,height:pixelH}=sizeInfo(project);
      const target=new F.StaticCanvas(document.createElement('canvas'),{width:WIDTH,height:HEIGHT,enableRetinaScaling:false});
      try{target.add(...await objects(project,true));target.renderAll();let output=target.toCanvasElement(scale);if(output.width!==pixelW||output.height!==pixelH){const exact=document.createElement('canvas');exact.width=pixelW;exact.height=pixelH;exact.getContext('2d').drawImage(output,0,0,pixelW,pixelH);output=exact;}return await new Promise((resolve,reject)=>output.toBlob(blob=>blob?resolve(blob):reject(new Error('PNG 匯出失敗')),'image/png'));}
      finally{await target.dispose();}
    },
  };
}
