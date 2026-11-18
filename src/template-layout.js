import {sizeInfo} from './sizing.js';

// Shared geometry for the Fabric and compatibility renderers.
export function cleanTemplateElements(project){
 if(project.template==='retail')return retailTemplateElements(project);
 const {w,h}=sizeInfo(project),s=Math.min(w/900,h/1100),sx=w/900;
 const footer=h-90*s-39; // Keep campaign details above the export status strip.
 const text=(value,x,y,width,size,color,weight=400,lines=1)=>({type:'text',value,x:x*sx,y,w:width*sx,h:size*s*1.3*lines,font:size*s,color,weight,lines});
 return [
  {type:'rect',x:0,y:0,w,h:154*s,color:'#e72932'},
  text('友好 Buy',40,28*s,430,51,'#fff1cc',800),text('感謝祭',510,25*s,350,69,'#fff',900),
  text(project.campaign.name,42,104*s,816,23,'#fff',600),
  {type:'rect',x:0,y:footer,w,h:90*s,color:'#e72932'},
  text('優品360',35,footer+14*s,300,31,'#fff',800),
  text(`${project.campaign.start||'日期待填'} — ${project.campaign.end||'日期待填'}`,390,footer+12*s,475,16,'#fff'),
  text(project.campaign.stores||'適用門店待確認',390,footer+38*s,475,12,'#fff',400,2),
 ];
}
export function restoreTemplateSnapshot(project){
 if(['membership','promotion'].includes(project.template)&&project.templateImage){
  project.background=project.templateImage;project.template='custom';
 }
 delete project.templateImage;
 return project;
}

export function retailTemplateElements(project){
 const {w,h}=sizeInfo(project),footer=h*.946;
 return [
  {type:'rect',x:0,y:0,w,h,color:'#40c2e8'},
  {type:'rect',x:w*.023,y:h*.113,w:w*.954,h:h*.833,color:'#fff8e6'},
  {type:'image',src:project.retailHeader||'assets/retail/header.png',x:0,y:0,w,h:h*.15},
  {type:'rect',x:0,y:footer,w,h:h-footer,color:'#f32131'},
  {type:'image',src:project.retailLogo||'assets/retail/logo.png',x:w*.825,y:footer+h*.007,w:w*.15,h:h*.039},
  {type:'text',value:project.campaign.name,x:w*.04,y:footer+h*.005,w:w*.74,h:h*.016,font:h*.012,color:'#ffffff',weight:800,lines:1},
  {type:'text',value:`${project.campaign.start||'日期待填'} — ${project.campaign.end||'日期待填'} · ${project.campaign.stores||'門店待填'}`,x:w*.04,y:footer+h*.023,w:w*.74,h:h*.012,font:h*.0075,color:'#ffffff',weight:400,lines:1},
  {type:'text',value:project.retailTerms||'優惠詳情以門店公佈為準。',x:w*.04,y:footer+h*.036,w:w*.74,h:h*.013,font:h*.006,color:'#ffffff',weight:400,lines:2},
 ];
}
