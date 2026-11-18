import test from 'node:test';
import assert from 'node:assert/strict';
import {matchCampaign,applyCampaign,snapshotCampaignImages} from '../src/campaign-import.js';
import {UploadProductProvider} from '../src/products.js';
import {defaultProject} from '../src/model.js';
const row={campaign:'活動',name:'秋田米',sku:'',spec:'1kg',price:'33',quantity:2,start:'2026-11-01',end:'2026-11-30',stores:'門店 A',row:2};
test('Excel name ambiguity is never guessed; user must select an asset',async()=>{
 const provider=new UploadProductProvider([{id:'a',name:'秋田米',sku:'',aliases:[]},{id:'b',name:'秋田米',sku:'',aliases:[]}]);
 const [matched]=await matchCampaign([row],provider);assert.equal(matched.assetId,'');assert.equal(matched.matchStatus,'choose');
});
test('known SKU takes precedence over a conflicting display name',async()=>{
 const provider=new UploadProductProvider([{id:'a',name:'商品 A',sku:'001',aliases:[]},{id:'b',name:'秋田米',sku:'002',aliases:[]}]);
 const [matched]=await matchCampaign([{...row,sku:'001'}],provider);assert.equal(matched.assetId,'a');
});
test('import builds campaign and offer without treating total price as unit price',()=>{
 const p=defaultProject();p.products=[{id:'a',name:'秋田米',sku:'',spec:'1kg'}];
 applyCampaign(p,[{...row,assetId:'a'}],'sale.xlsx');
 assert.equal(p.nodes[0].price,'33');assert.equal(p.nodes[0].quantity,2);assert.equal(p.campaign.name,'活動');assert.equal(p.nodes[0].importedOffer.filename,'sale.xlsx');
});
test('unmatched import cannot replace the existing poster',()=>{
 const p=defaultProject();p.nodes=[{id:'keep'}];
 assert.throws(()=>applyCampaign(p,[{...row,assetId:''}]),/選擇/);assert.equal(p.nodes[0].id,'keep');
});
test('productid selects unique server result and never falls back to a same-name local asset',async()=>{
 const provider=new UploadProductProvider([{id:'wrong',name:row.name,sku:'001',aliases:[]}]);
 const [unique,missing,multiple]=await matchCampaign([
  {...row,productid:'4837',libraryProducts:[{id:'server'}]},
  {...row,productid:'4838',libraryProducts:[]},
  {...row,productid:'4839',libraryProducts:[{id:'one'},{id:'two'}]},
 ],provider);
 assert.equal(unique.assetId,'server');assert.equal(missing.assetId,'');assert.equal(multiple.assetId,'one');assert.equal(multiple.matchStatus,'matched');
});

test('server image is snapshotted instead of an existing same-name local picture',async()=>{
 const project={products:[{id:'local',name:row.name,imageUrl:'wrong'}]};
 const remote={id:'pos-4837-photo',name:row.name,source:'pos-library',imageUrl:'/api/product-library/photos/token'};
 const rows=[{...row,productid:'4837',assetId:remote.id,libraryProducts:[remote]}];
 await snapshotCampaignImages(project,rows,async asset=>{assert.equal(asset.id,remote.id);return 'data:image/png;base64,c25hcHNob3Q=';});
 assert.equal(project.products.find(p=>p.id===remote.id).imageUrl,'data:image/png;base64,c25hcHNob3Q=');
 assert.equal(project.products.find(p=>p.id==='local').imageUrl,'wrong');
});
test('server product cannot silently select an unrelated local asset',async()=>{
 const project={products:[{id:'local'}]};
 await assert.rejects(snapshotCampaignImages(project,[{productid:'4837',assetId:'local',libraryProducts:[{id:'remote'}]}]),/4837/);
 assert.deepEqual(project.products,[{id:'local'}]);
});
test('failed image download leaves existing assets intact',async()=>{
 const project={products:[{id:'local'}]},before=structuredClone(project);
 const rows=['a','b'].map(id=>({assetId:id,libraryProducts:[{id}]}));
 await assert.rejects(snapshotCampaignImages(project,rows,async asset=>{if(asset.id==='b')throw new Error('download failed');return 'snapshot';}),/download failed/);
 assert.deepEqual(project,before);
});

test('image downloads have bounded concurrency and report completion before committing',async()=>{
 const project={products:[]};let active=0,peak=0;const progress=[];
 const rows=Array.from({length:7},(_,i)=>({assetId:String(i),libraryProducts:[{id:String(i)}]}));
 await snapshotCampaignImages(project,rows,async()=>{active++;peak=Math.max(active,peak);await new Promise(resolve=>setTimeout(resolve,1));active--;return 'snapshot';},text=>progress.push(text));
 assert.equal(peak,3);assert.equal(project.products.length,7);assert.match(progress.at(-1),/7\/7/);
});

test('code without numeric productid uses server candidates instead of local SKU fallback',async()=>{
 const provider={resolve(){throw new Error('must not use local assets');}};
 const rows=await matchCampaign([{...row,code:'BD-101643',libraryProducts:[{id:'server'}]}],provider);
 assert.equal(rows[0].assetId,'server');
});

test('two codes produce one product component with both images and one unchanged offer',async()=>{
 const provider={resolve(){throw new Error('local lookup not expected');}};
 const [matched]=await matchCampaign([{...row,code:'A',code2:'B',libraryProducts:[{id:'a'}],companion:{code:'B',libraryProducts:[{id:'b'}]}}],provider);
 const project=defaultProject();project.products=[{id:'a',name:'A',sku:'A',spec:''},{id:'b',name:'B',sku:'B',spec:''}];
 applyCampaign(project,[matched]);
 assert.equal(project.nodes.length,1);assert.deepEqual(project.nodes[0].pictures.map(p=>p.productId),['a','b']);
 assert.equal(project.nodes[0].price,'33');assert.equal(project.nodes[0].quantity,2);
 const before=structuredClone(project);
 assert.throws(()=>applyCampaign(project,[{...matched,companion:{}}]),/第二件/);
 assert.deepEqual(project,before);
 const snapshots={products:[]};await snapshotCampaignImages(snapshots,[matched],async asset=>'snapshot-'+asset.id);
 assert.deepEqual(snapshots.products.map(p=>p.id).sort(),['a','b']);
});

test('four Excel codes match and snapshot all images into one unchanged offer',async()=>{
 const source={...row,code:'A',code2:'B',code3:'C',code4:'D',libraryProducts:[{id:'a'}]};
 for(const [key,id] of [['companion','b'],['companion3','c'],['companion4','d']])source[key]={code:id.toUpperCase(),libraryProducts:[{id}]};
 const [matched]=await matchCampaign([source],{});
 const project=defaultProject();project.products=['a','b','c','d'].map(id=>({id,name:id,sku:id,spec:''}));
 applyCampaign(project,[matched]);
 assert.deepEqual(project.nodes[0].pictures.map(p=>p.productId),['a','b','c','d']);
 assert.equal(project.nodes[0].pictureLayout,'overlap');
 assert.equal(project.nodes[0].price,'33');assert.equal(project.nodes[0].quantity,2);
 const snapshots={products:[]};await snapshotCampaignImages(snapshots,[matched],async a=>'snapshot-'+a.id);
 assert.equal(snapshots.products.length,4);
});

test('with POS unreachable (no server candidates) a code row matches the local library by code',async()=>{
 const provider={resolve:async query=>query==='4891118024431-1'?{status:'matched',product:{id:'local'}}:{status:'missing',matches:[]}};
 const [matched]=await matchCampaign([{name:'雀巢三花',code:'4891118024431-1',sku:'4891118024431-1',price:'159',quantity:1,row:2}],provider);
 assert.equal(matched.assetId,'local');assert.equal(matched.matchStatus,'matched');
 const [pos]=await matchCampaign([{name:'雀巢三花',code:'4891118024431-1',libraryProducts:[],row:2}],provider);
 assert.equal(pos.assetId,'');assert.equal(pos.matchStatus,'missing');  // POS ran and found nothing: no local substitute
});

test('an image and its own cutout are one product: the cutout is matched, not an ambiguity',async()=>{
 const provider=new UploadProductProvider([{id:'o',name:'4891118024431-1',sku:'',filename:'4891118024431-1.jpg',aliases:[],source:'upload'},
  {id:'c',name:'4891118024431-1',sku:'',filename:'4891118024431-1-cutout.png',aliases:[],source:'cutout',originalAssetId:'o'}]);
 const [matched]=await matchCampaign([{...row,name:'雀巢三花',sku:'4891118024431-1'}],provider);
 assert.equal(matched.assetId,'c');
 const other=new UploadProductProvider([{id:'a',name:'同名',sku:'',aliases:[]},{id:'b',name:'同名',sku:'',aliases:[],source:'upload'}]);
 assert.equal((await matchCampaign([{...row,name:'同名'}],other))[0].matchStatus,'choose');  // unrelated images stay ambiguous
});

test('POS defaults prefer PNG then street then exact identifier filename, including companions',async()=>{
 const candidates=[
  {id:'jpeg',filename:'BD-123.jpg',angle:'街貨 · BD-123.jpg',sku:'BD-123'},
  {id:'warehouse',filename:'BD-123.png',angle:'倉貨 · BD-123.png',sku:'BD-123'},
  {id:'suffix',filename:'BD-123_front.PNG',angle:'街貨 · BD-123_front.PNG',sku:'BD-123'},
  {id:'barcode',filename:'4891118024431.png',angle:'街貨 · 4891118024431.png',aliases:['4891118024431']},
  {id:'exact',filename:'BD-123.PNG',angle:'街貨 · BD-123.PNG',sku:'BD-123'}
 ];
 const source={...row,code:'BD-123',libraryProducts:candidates,code2:'BD-123',companion:{code:'BD-123',libraryProducts:candidates},code3:'BD-123',companion3:{code:'BD-123',libraryProducts:candidates},code4:'BD-123',companion4:{code:'BD-123',libraryProducts:candidates}};
 const [matched]=await matchCampaign([source],{});
 assert.equal(matched.assetId,'exact');
 assert.deepEqual(matched.libraryProducts.map(p=>p.id),['exact','barcode','suffix','warehouse','jpeg']);
 for(const key of ['companion','companion3','companion4'])assert.equal(matched[key].assetId,'exact');
 assert.equal(candidates[0].id,'jpeg');
 const [chosen]=await matchCampaign([{...source,assetId:'warehouse'}],{});
 assert.equal(chosen.assetId,'warehouse','preserve a valid manual choice');
 const [missing]=await matchCampaign([{...row,code:'missing',libraryProducts:[]}],{});
 assert.equal(missing.assetId,'');
});
