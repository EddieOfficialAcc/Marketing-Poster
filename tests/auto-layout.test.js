import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultProject,productNode,arrange,parseBackup} from '../src/model.js';
import {autoLayoutPictures,addPicture} from '../src/composition.js';
import {sizeInfo} from '../src/sizing.js';
const asset=(id,w,h)=>({id,name:id,sku:'',spec:'',imageWidth:w,imageHeight:h,imageUrl:'data:image/png;base64,iVBORw0KGgo='});
const overlaps=(a,b)=>a.x<b.x+b.w-1e-8&&a.x+a.w>b.x+1e-8&&a.y<b.y+b.h-1e-8&&a.y+a.h>b.y+1e-8;
test('three-image automatic layout chooses sides for tall bottles and rows for wide packs',()=>{
 for(const [w,h,expected] of [[100,300,'side'],[400,100,'stack']]){
  const assets=[asset('a',w,h),asset('b',w,h)],node=productNode(assets[0]);node.w=300;node.h=400;addPicture(node,'b');addPicture(node,'b');node.pictureLayout='side';autoLayoutPictures(node,assets);
  assert.equal(node.pictureLayout,expected);assert.equal(overlaps(...node.pictures),false);
 }
});
test('one product has a bounded feature size rather than filling the whole poster',()=>{
 const p=defaultProject();p.products=[asset('a',400,300)];p.nodes=[productNode(p.products[0])];arrange(p);
 assert.ok(p.nodes[0].w<=900*.62);assert.ok(p.nodes[0].h<=1280*.55);
 assert.equal(p.nodes[0].x+p.nodes[0].w/2,450);
});
test('automatic layouts fit portrait, landscape, square and membership pages without product collisions',()=>{
 for(const [width,height] of [[1800,2560],[1920,1080],[1080,1080]])for(const template of ['clean','promotion','membership'])for(const count of [1,2,3,8,12]){
  const p=defaultProject();p.page={width,height,unit:'px',dpi:150};p.template=template;
  p.products=Array.from({length:count},(_,i)=>asset(String(i),i%2?400:100,300));p.nodes=p.products.map(productNode);arrange(p);
  const box=sizeInfo(p);
  for(const n of p.nodes){assert.ok(n.w>0&&n.h>0);assert.ok(n.x>=0&&n.y>=0&&n.x+n.w<=box.w+1e-8&&n.y+n.h<=box.h+1e-8);}
  for(let i=0;i<count;i++)for(let j=i+1;j<count;j++)assert.equal(overlaps(p.nodes[i],p.nodes[j]),false);
 }
});
test('automatic layout preserves offer data, text elements, and persists image arrangement in backups',()=>{
 const p=defaultProject();p.products=[asset('a',400,100),asset('b',400,100)];
 const n=productNode(p.products[0]);n.price='33';n.quantity=2;n.sku='sku';n.spec='85g × 5';addPicture(n,'b');
 const text={id:'text',type:'text',text:'優惠',x:30,y:170,w:120,h:40,fontSize:20,shadow:0,color:'#112233'};
 p.nodes=[n,text];const before=structuredClone(text);arrange(p);autoLayoutPictures(n,p.products);
 assert.equal(n.price,'33');assert.equal(n.quantity,2);assert.equal(n.spec,'85g × 5');assert.deepEqual(text,before);
 const restored=parseBackup(JSON.stringify(p));assert.deepEqual(restored.nodes[0].pictures,n.pictures);
 assert.equal(restored.products[0].imageWidth,400);
});
test('six-image automatic groups remain inside the frame with gaps and missing dimensions fall back safely',()=>{
 const n=productNode(asset('a',0,0));for(let i=1;i<6;i++)addPicture(n,'a');n.pictureLayout='side';autoLayoutPictures(n,[]);
 for(const p of n.pictures)assert.ok(p.x>=0&&p.y>=0&&p.w>=.1&&p.h>=.1&&p.x+p.w<=1.00001&&p.y+p.h<=1.00001);
 for(let i=0;i<6;i++)for(let j=i+1;j<6;j++)assert.equal(overlaps(n.pictures[i],n.pictures[j]),false);
});

test('reserved text area keeps two-line names and specs above the price at small and large sizes',async()=>{
 const {productMetrics}=await import('../src/auto-layout.js');
 for(const h of [100,180,285,400,704]){
  const m=productMetrics(h,24),specBottom=m.imageHeight+m.padding+m.font*3.7;
  assert.ok(m.imageHeight>0);assert.ok(specBottom<h-m.priceSize*1.15);
 }
});
