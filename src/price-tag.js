import {offer,cents} from './retail.js';
// 價格牌（$18 平均每件 + $36/2件）沿用零售商品卡的價格排版；只記錄總價與件數，平均價由程式計算。
export function validPriceTag(tag){
 return !!tag&&cents(tag.price)>0&&Number.isInteger(tag.quantity)&&tag.quantity>=1&&tag.quantity<=99;
}
export function priceTagLabel(tag){
 const label=offer({price:tag.price,quantity:tag.quantity});
 return label.average?`$${label.main} 平均每件 ${label.bundle}`:`$${label.main}`;
}
// 轉成只有價格區域的零售商品節點，交給 retailText 產生與商品卡一致的圖元。
export function priceTagNode(n){
 const empty={x:0,y:0,w:.001,h:.001};
 return {id:n.id,type:'product',cardStyle:'retail',x:n.x,y:n.y,w:n.w,h:n.h,fontSize:n.fontSize,color:n.color,name:'',spec:'',originalPrice:'',price:n.priceTag.price,quantity:n.priceTag.quantity,regions:{price:{x:0,y:0,w:1,h:1},name:empty,spec:empty,original:empty}};
}
