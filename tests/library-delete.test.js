import test from 'node:test';
import assert from 'node:assert/strict';
import {isUploadAsset,assetUsers,deleteLibraryAsset} from '../src/library-delete.js';
import {seedCatalog} from '../src/catalog.js';
import {newProject} from '../src/new-project.js';
import {EditorHistory} from '../src/editor-history.js';
import {defaultProject,productNode,parseBackup} from '../src/model.js';
const asset=id=>({id,name:id,sku:'',spec:'1kg',aliases:[],source:'sample',imageUrl:'data:image/png;base64,eA=='});
function sample(){const p=defaultProject();p.products=[asset('a'),asset('b')];p.nodes=[{...productNode(p.products[0]),id:'only'},{...productNode(p.products[0]),id:'combo',price:'33',quantity:2,pictures:[{id:'pa',productId:'a',x:0,y:0,w:.5,h:1},{id:'pb',productId:'b',x:.5,y:0,w:.5,h:1}]}];return p;}
test('library deletion preserves canvas nodes, paired pictures and prices',()=>{
 const p=sample(),before=structuredClone(p.nodes);assert.equal(assetUsers(p,'a').length,2);
 const result=deleteLibraryAsset(p,'a');assert.deepEqual(result.removedNodes,[]);
 assert.deepEqual(p.nodes,before);assert.equal(p.products.find(a=>a.id==='a').libraryHidden,true);
 assert.deepEqual(parseBackup(JSON.stringify(p)).nodes.map(n=>n.productId),['a','a']);
});
test('deleted built-in samples are skipped on reload and preserved when reusing library',async()=>{
 const p=sample();deleteLibraryAsset(p,'a');const original=globalThis.fetch;
 globalThis.fetch=async path=>{assert.equal(path,'assets/catalog.json');return {ok:true,json:async()=>({products:[asset('a'),asset('b')]})};};
 try{assert.equal(await seedCatalog(p),0);}finally{globalThis.fetch=original;}
 assert.deepEqual(newProject(p,{keepAssets:true}).deletedSampleIds,['a']);
});
test('undo restores removed assets, cards and automatic sample eligibility',()=>{
 const p=sample(),history=new EditorHistory();history.reset(p);deleteLibraryAsset(p,'a');history.record(p);const restored=history.travel('undo',p);assert.equal(restored.products.length,2);assert.equal(restored.nodes.length,2);assert.equal(restored.deletedSampleIds,undefined);
});
test('removing an upload preserves in-flight cutout and unused uploads can be removed',()=>{
 const p=sample();p.cutoutPending={assetId:'b',remaining:['a','b']};const pending=structuredClone(p.cutoutPending);
 deleteLibraryAsset(p,'a');deleteLibraryAsset(p,'b');assert.deepEqual(p.cutoutPending,pending);
 p.products.push({...asset('unused'),source:'upload'});deleteLibraryAsset(p,'unused');assert.ok(!p.products.some(a=>a.id==='unused'));
});
test('upload library excludes POS, sample, PDF and their cutouts',()=>{
 const products=[{id:'u',source:'upload'},{id:'pos',source:'pos-library'},{id:'s',source:'sample'},{id:'pdf',source:'pdf-extract'},
 {id:'cu',source:'cutout',originalAssetId:'u'},{id:'cp',source:'cutout',originalAssetId:'pos'},{id:'hidden',source:'upload',libraryHidden:true}];
 assert.deepEqual(products.filter(p=>isUploadAsset(p,products)).map(p=>p.id),['u','cu']);
 products[0].libraryHidden=true;
 assert.ok(isUploadAsset(products[4],products),'removing original does not hide a separately retained cutout');
});
