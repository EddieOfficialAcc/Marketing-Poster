export const defaultSize={width:1800,height:2560,unit:'px',dpi:150};
export function sizeInfo(project){
 const s=project.page||defaultSize;
 if(!['px','mm'].includes(s.unit)||![s.width,s.height,s.dpi].every(Number.isFinite)||s.width<=0||s.height<=0||s.dpi<72||s.dpi>600)throw new Error('尺寸或解析度無效（72–600 DPI）');
 const width=Math.round(s.unit==='mm'?s.width*s.dpi/25.4:s.width),height=Math.round(s.unit==='mm'?s.height*s.dpi/25.4:s.height);
 if(width<200||height<200||width>8192||height>8192||width*height>40000000||width/height<.4||width/height>2.5)throw new Error('輸出每邊限 200–8192 px、總計 4000 萬像素，寬高比限 0.4–2.5');
 return project.canvasSpace===2?{width,height,w:width/2,h:height/2,scale:2,dpi:s.dpi}:{width,height,w:900,h:900*height/width,scale:width/900,dpi:s.dpi};
}
export function resizeProject(project,page,{scaleContents=false}={}){
 upgradeCanvasCoordinates(project);
 const old=sizeInfo(project),next=sizeInfo({page,canvasSpace:2});const factor=Math.min(next.w/old.w,next.h/old.h);
 if(scaleContents)for(const n of project.nodes){n.x=n.x*factor+(next.w-old.w*factor)/2;n.y=n.y*factor+(next.h-old.h*factor)/2;n.w=Math.max(20,n.w*factor);n.h=Math.max(20,n.h*factor);n.fontSize=Math.max(10,Math.min(100,n.fontSize*factor));if(Number.isFinite(n.priceFontSize))n.priceFontSize=Math.max(1,Math.min(1000,n.priceFontSize*factor));for(const style of Object.values(n.textStyles||{}))if(Number.isFinite(style.size))style.size=Math.max(1,Math.min(1000,style.size*factor));n.shadow=Math.min(30,n.shadow*factor);n.x=Math.max(0,Math.min(next.w-n.w,n.x));n.y=Math.max(0,Math.min(next.h-n.h,n.y));}
 if(project.backgroundPlacement){const b=project.backgroundPlacement;project.backgroundPlacement={x:b.x*factor+(next.w-old.w*factor)/2,y:b.y*factor+(next.h-old.h*factor)/2,w:b.w*factor,h:b.h*factor};}
 project.page={...page};
}
export function backgroundBox(project,iw,ih){
 const {w,h}=sizeInfo(project),p=project.backgroundPlacement;
 if(p)return {...p};
 const scale=(project.backgroundFit==='cover'?Math.max:Math.min)(w/iw,h/ih);
 return {x:(w-iw*scale)/2,y:(h-ih*scale)/2,w:iw*scale,h:ih*scale};
}

export function upgradeCanvasCoordinates(project){
 if(project.canvasSpace===2)return;
 const factor=sizeInfo(project).width/1800;
 for(const node of project.nodes||[])for(const key of ['x','y','w','h','fontSize','priceFontSize','shadow'])if(Number.isFinite(node[key]))node[key]*=factor;
 for(const node of project.nodes||[])for(const style of Object.values(node.textStyles||{}))if(Number.isFinite(style.size))style.size*=factor;
 if(project.backgroundPlacement)for(const key of ['x','y','w','h'])project.backgroundPlacement[key]*=factor;
 project.canvasSpace=2;
}
export function displaySize(project,zoom=1){const {w,h}=sizeInfo(project);return {width:w*.6*zoom,height:h*.6*zoom};}

export function clampNodeTransform(update,width,height){
 if(!['x','y','w','h'].every(k=>Number.isFinite(update[k])))throw new Error('元素位置或尺寸無效');
 const w=Math.max(1,Math.min(width,update.w)),h=Math.max(1,Math.min(height,update.h));
 return {x:Math.max(0,Math.min(width-w,update.x)),y:Math.max(0,Math.min(height-h,update.y)),w,h};
}
