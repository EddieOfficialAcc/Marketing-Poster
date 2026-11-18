export function setFontSize(node,part,value){
 const size=Number(value);if(value===''||!Number.isFinite(size))return false;
 const bounded=Math.max(1,Math.min(1000,size));
 if(part==='price'){node.priceFontSize=bounded;node.priceAutoFit=false;}
 else if(['name','spec','original'].includes(part)){node.textStyles||={};node.textStyles[part]||={};Object.assign(node.textStyles[part],{size:bounded,autoFit:false});}
 else if(part==='text'){node.fontSize=bounded;node.autoFit=false;}
 else return false;
 return true;
}
export function requestedFontSize(node,part){
 if(part==='price')return node.priceFontSize??(node.cardStyle==='retail'?null:Math.min(42,node.h*.12));
 if(['name','spec','original'].includes(part))return node.textStyles?.[part]?.size??(node.cardStyle==='retail'?(node.fontSize||node.w*.047):Math.min(node.fontSize,node.h*.052)*(part==='spec'?.8:1));
 return node.fontSize;
}
