import {uid} from './model.js';
import {sizeInfo} from './sizing.js';

export function iconNode(asset,project){
 const {w:width,h:height}=sizeInfo(project);
 const ratio=asset.width/asset.height;
 if(!Number.isFinite(ratio)||ratio<=0)throw new Error('標識圖片尺寸無效');
 const w=Math.min(160*width/900,width*.2,height*.15*ratio),h=w/ratio;  // 160 units on a 900-unit-wide canvas
 return {id:uid(),type:'imageIcon',iconId:asset.id,text:asset.name,x:width*.08,y:height*.17,w,h,fontSize:20,shadow:0,color:'#e52731'};
}
export function containIcon(node,width,height){
 const scale=Math.min(node.w/width,node.h/height);
 return {x:node.x+(node.w-width*scale)/2,y:node.y+(node.h-height*scale)/2,w:width*scale,h:height*scale};
}
