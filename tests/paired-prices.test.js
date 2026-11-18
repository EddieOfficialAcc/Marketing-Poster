import test from 'node:test';
import assert from 'node:assert/strict';
import {applyCampaign} from '../src/campaign-import.js';
import {defaultProject,parseBackup,priceLabel} from '../src/model.js';
import {offer,originalLabel,retailText,retailErrors} from '../src/retail.js';
import {movePicture,removePicture} from '../src/composition.js';
const row={assetId:'a',code:'A',code2:'B',companion:{assetId:'b'},name:'A / B',spec:'各款',price:'99',price2:'109',quantity:1,originalPrice:'119',originalPrice2:'129',campaign:'Test',start:'2026-11-10',end:'2026-11-19',stores:'Demo'};
function setup(){const p=defaultProject();p.products=[{id:'a',name:'A',sku:'A',spec:'各款',imageUrl:'data:image/png;base64,YQ==',width:100,height:100},{id:'b',name:'B',sku:'B',spec:'各款',imageUrl:'data:image/png;base64,Yg==',width:100,height:100}];applyCampaign(p,[row]);return p;}
test('paired individual prices survive import/backup and render without a bundle',()=>{
 const p=setup(),n=p.nodes[0];
 assert.equal(n.price2ProductId,'b');assert.equal(offer(n).main,'99–109');assert.equal(offer(n).bundle,'');assert.equal(priceLabel(n),'$99–109');assert.equal(originalLabel(n),'$119–129');
 const scene=retailText(n,(t,size)=>t.length*size*.5);
 assert.equal(scene.filter(x=>x.part==='price').map(x=>x.text||'').join(''),'$99–109');
 assert.equal(parseBackup(JSON.stringify(p)).nodes[0].price2,'109');
 n.price='99.9';n.price2='109.5';assert.equal(retailText(n,(t,size)=>t.length*size*.5).filter(x=>x.part==='price').map(x=>x.text||'').join(''),'$99.9–109.5');
 n.quantity=2;assert.ok(retailErrors(n).length);
});
test('reordering and removing paired pictures preserves the remaining price identity',()=>{
 const n=setup().nodes[0],a=n.pictures[0].id,b=n.pictures[1].id;
 movePicture(n,b,-1);removePicture(n,a);
 assert.equal(n.productId,'b');assert.equal(n.price,'109');assert.equal(n.originalPrice,'129');assert.equal(n.price2,undefined);
 const other=setup().nodes[0];removePicture(other,other.pictures[1].id);assert.equal(other.price,'99');assert.equal(other.originalPrice,'119');
});

test('cutout replacement updates the second price binding and repairs older drafts by provenance',async()=>{
 const {replacePictureAsset,repairPairedPriceBindings}=await import('../src/paired-prices.js');
 const p=setup(),n=p.nodes[0];p.products.push({...p.products[1],id:'cutout-b',originalAssetId:'b',source:'cutout'});
 replacePictureAsset(n,'b','cutout-b');assert.equal(n.price2ProductId,'cutout-b');assert.equal(retailErrors(n).length,0);
 // Reproduce old clients: the picture changed but the price still points at the source.
 n.price2ProductId='b';assert.ok(retailErrors(n).length);
 assert.equal(repairPairedPriceBindings(p),1);assert.equal(n.price2ProductId,'cutout-b');assert.equal(retailErrors(n).length,0);
 n.price2ProductId='b';assert.equal(parseBackup(JSON.stringify(p)).nodes[0].price2ProductId,'cutout-b');
 const unknown=setup();unknown.nodes[0].price2ProductId='unrelated';assert.equal(repairPairedPriceBindings(unknown),0,'never guess an existing unrelated price identity');
});
test('deleting a library image preserves both independently priced products',async()=>{
 const {deleteLibraryAsset}=await import('../src/library-delete.js');
 const p=setup(),before=structuredClone(p.nodes);deleteLibraryAsset(p,'a');assert.deepEqual(p.nodes,before);assert.equal(retailErrors(p.nodes[0]).length,0);
});
