import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { pictures, addPicture, layoutPictures, cycleOverlap, movePicture, mergeProducts } from '../src/composition.js';
import { productNode, defaultProject, parseBackup, validate } from '../src/model.js';
const product=id=>({id,name:id,sku:'',spec:'',filename:id,aliases:[],imageUrl:'data:image/png;base64,iVBORw0KGgo='});
test('legacy single images upgrade; visual duplication never changes offer quantity or price',()=>{
 const n=productNode(product('a'));n.price='20';
 assert.equal(pictures(n).length,1);addPicture(n,'a');assert.equal(pictures(n).length,2);
 assert.equal(n.price,'20');assert.equal(n.quantity,1);
 for(const p of pictures(n)){assert.ok(p.x+p.w<=1);assert.ok(p.y+p.h<=1);}
});
test('front-back order and side-by-side layouts operate on independent image members',()=>{
 const n=productNode(product('a'));const id=addPicture(n,'b');
 movePicture(n,id,-1);assert.equal(n.pictures[0].productId,'b');
 layoutPictures(n,'side');assert.equal(n.pictures[0].w,.5);assert.equal(n.pictures[1].x,.5);
});
test('merge retains both images, combines offer counts and forces price reconfirmation',()=>{
 const p=defaultProject();p.nodes=[productNode(product('a')),productNode(product('b'))];p.nodes[0].price='10';p.nodes[1].price='25';
 const primary=p.nodes[0];mergeProducts(p,primary.id,p.nodes[1].id);
 assert.equal(p.nodes.length,1);assert.equal(primary.quantity,2);assert.equal(primary.price,'');assert.equal(pictures(primary).length,2);
 assert.ok(validate(p).errors.some(e=>e.includes('價格')));
});
test('composition and background index survive backup; broken member references are rejected',()=>{
 const p=defaultProject();p.products=[product('a'),product('b')];p.nodes=[productNode(p.products[0])];addPicture(p.nodes[0],'b');
 p.backgrounds=[{id:'bg-1',name:'自訂底圖',imageUrl:p.products[0].imageUrl}];
 const restored=parseBackup(JSON.stringify(p));assert.equal(restored.nodes[0].pictures.length,2);assert.equal(restored.backgrounds.length,1);
 p.nodes[0].pictures[1].productId='missing';assert.throws(()=>parseBackup(JSON.stringify(p)),/組內圖片/);
});
test('six-image limit does not partially mutate a merge',()=>{
 const p=defaultProject();p.nodes=[productNode(product('a')),productNode(product('b'))];
 for(let i=0;i<5;i++)addPicture(p.nodes[0],'a');
 assert.throws(()=>mergeProducts(p,p.nodes[0].id,p.nodes[1].id),/6/);assert.equal(p.nodes.length,2);
});
test('all five supplied sample images are packaged with distinct angle metadata',()=>{
 const catalog=JSON.parse(readFileSync(new URL('../assets/catalog.json',import.meta.url)));
 assert.equal(catalog.products.length,5);assert.equal(new Set(catalog.products.map(p=>p.id)).size,5);
 for(const p of catalog.products){assert.ok(existsSync(new URL('../'+p.path,import.meta.url)));assert.ok(p.angle);}
});

test('two-image default uses staggered layout and stays in bounds',()=>{
 const n=productNode(product('a'));addPicture(n,'b');
 assert.ok(n.pictures[0].x+n.pictures[0].w>n.pictures[1].x);
 layoutPictures(n,'overlap');
 assert.ok(n.pictures[0].h<n.pictures[1].h);
 assert.ok(n.pictures[0].x+n.pictures[0].w>n.pictures[1].x);
 for(const pic of n.pictures){assert.ok(pic.x+pic.w<=1);assert.ok(pic.y+pic.h<=1);}
});

test('overlap repeat swaps paint order without moving images or changing offer data',()=>{
 const n=productNode(product('a'));n.price='33';n.quantity=2;addPicture(n,'b');layoutPictures(n,'side');
 cycleOverlap(n);assert.deepEqual(n.pictures.map(p=>p.productId),['a','b']);
 const geometry=structuredClone(n.pictures);
 cycleOverlap(n);assert.deepEqual(n.pictures.map(p=>p.productId),['b','a']);
 for(const p of n.pictures)assert.deepEqual(p,geometry.find(x=>x.id===p.id));
 cycleOverlap(n);assert.deepEqual(n.pictures,geometry);assert.equal(n.price,'33');assert.equal(n.quantity,2);
 layoutPictures(n,'side');cycleOverlap(n);assert.deepEqual(n.pictures.map(p=>p.productId),['a','b']);
});
test('legacy overlap rotates through every image, including identical product copies',()=>{
 const n=productNode(product('a'));addPicture(n,'a');addPicture(n,'b');layoutPictures(n,'overlap');delete n.pictureLayout;
 const ids=n.pictures.map(p=>p.id);
 cycleOverlap(n);assert.equal(n.pictures.at(-1).id,ids[0]);
 cycleOverlap(n);assert.equal(n.pictures.at(-1).id,ids[1]);
 cycleOverlap(n);assert.deepEqual(n.pictures.map(p=>p.id),ids);
});

test('automatic rearrangement keeps staggered pairs and deletion preserves the offer and source assets',async()=>{
 const {autoLayoutPictures,removePicture,pictureAt}=await import('../src/composition.js');
 const assets=[{...product('a'),imageWidth:100,imageHeight:100},{...product('b'),imageWidth:100,imageHeight:100}];
 const n=productNode(assets[0]);n.price='33';n.quantity=2;addPicture(n,'b');autoLayoutPictures(n,assets);
 assert.equal(n.pictureLayout,'overlap');assert.ok(n.pictures[0].x+n.pictures[0].w>n.pictures[1].x);
 const removed=n.pictures[1].id;
 assert.equal(removePicture(n,'missing'),false);assert.equal(removePicture(n,removed),true);
 assert.equal(n.pictures.length,1);assert.equal(n.pictures[0].w,1);assert.equal(n.productId,'a');
 assert.equal(n.quantity,2);assert.equal(n.price,'33');assert.equal(assets.length,2);
 assert.equal(pictureAt(n,{x:-100,y:-100},assets),null);
 assert.throws(()=>removePicture(n,n.pictures[0].id),/最後一張/);
});
test('removing a rear picture leaves remaining geometry and order unchanged in a larger group',async()=>{
 const {removePicture,autoLayoutPictures}=await import('../src/composition.js');
 const n=productNode(product('a'));addPicture(n,'b');addPicture(n,'c');layoutPictures(n,'overlap');
 autoLayoutPictures(n,[]);assert.equal(n.pictureLayout,'overlap');
 const before=structuredClone(n.pictures.slice(1));removePicture(n,n.pictures[0].id);
 assert.deepEqual(n.pictures,before);assert.equal(n.productId,'b');
});
test('picture hit testing picks the front image in overlap and the exposed rear image separately',async()=>{
 const {pictureAt}=await import('../src/composition.js');
 const {productMetrics}=await import('../src/auto-layout.js');
 const assets=[{...product('a'),imageWidth:100,imageHeight:100},{...product('b'),imageWidth:100,imageHeight:100}];
 const n=productNode(assets[0]);addPicture(n,'b');const h=productMetrics(n.h,n.fontSize).imageHeight;
 assert.equal(pictureAt(n,{x:n.x+n.w*.5,y:n.y+h*.5},assets),n.pictures[1].id);
 assert.equal(pictureAt(n,{x:n.x+n.w*.15,y:n.y+h*.5},assets),n.pictures[0].id);
 assert.equal(pictureAt(n,{x:n.x+n.w*.5,y:n.y+n.h-10},assets),null);
});

test('compact paired layout overlaps actual narrow and wide images within the image area',()=>{
 for(const ratio of [.3,1.2]){
  const n=productNode(product('a'));n.imageOnly=true;n.w=300;n.h=350;
  n.pictures=[{id:'first',productId:'a'},{id:'second',productId:'b'}];
  const assets=['a','b'].map(id=>({...product(id),imageWidth:ratio*100,imageHeight:100}));
  layoutPictures(n,'overlap',assets);
  const [back,front]=n.pictures;
  assert.ok(back.x+back.w>front.x,'actual image edges overlap');
  assert.ok(front.y>back.y,'front image sits lower');
  assert.ok(front.h>back.h,'front image is larger');
  for(const p of n.pictures){
   assert.ok(p.x>=0&&p.y>=0&&p.x+p.w<=1.000001&&p.y+p.h<=1.000001);
   assert.ok(Math.abs((p.w*n.w)/(p.h*n.h)-ratio)<1e-8);
  }
 }
});

test('transparent side margins do not separate visible products in compact groups',()=>{
 for(const count of [2,3,4]){
  const n=productNode(product('a'));n.imageOnly=true;n.w=400;n.h=350;
  const assets=Array.from({length:count},(_,i)=>({...product(String(i)),imageWidth:200,imageHeight:400,imageBounds:{x:.25,w:.5}}));
  n.pictures=assets.map(a=>({id:a.id,productId:a.id}));layoutPictures(n,'overlap',assets);
  for(let i=1;i<count;i++){
   const a=n.pictures[i-1],b=n.pictures[i];
   assert.ok(a.x+a.w*.75>b.x+b.w*.25);
  }
 }
});
