import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultProject,productNode,touch,parseBackup} from '../src/model.js';
import {firstIncomplete,stepIssues} from '../src/steps.js';
function ready(){
 const p=defaultProject();p.campaign={name:'測試',start:'2026-11-01',end:'2026-11-30',stores:'測試門店'};
 const item={id:'a',name:'米',sku:'A',spec:'1kg',imageUrl:'data:image/png;base64,aA==',filename:'a.png',aliases:[]};
 p.products=[item];p.nodes=[productNode(item)];p.nodes[0].price='33';return p;
}
test('three-stage flow sends missing activity or product data back to its editor',()=>{
 assert.equal(firstIncomplete(defaultProject(),3).step,1);
 const p=ready();p.nodes=[];assert.equal(firstIncomplete(p,3).step,2);
 p.nodes=[productNode(p.products[0])];assert.equal(firstIncomplete(p,3).step,2);
 p.nodes[0].price='33';assert.equal(firstIncomplete(p,3),null);
 p.template='custom';p.background=null;assert.equal(firstIncomplete(p,3).step,1);
});
test('preview is available before review, download requires current revision confirmation',()=>{
 const p=ready();assert.equal(firstIncomplete(p,3),null);
 assert.equal(firstIncomplete(p,4).step,3);p.reviewedRevision=p.revision;
 assert.equal(firstIncomplete(p,4),null);touch(p);
 assert.equal(firstIncomplete(p,3),null);assert.equal(firstIncomplete(p,4).step,3);
});
test('backup import cannot carry a prior review or jump to the download stage',()=>{
 const p=ready();p.reviewedRevision=p.revision;p.step=6;
 const restored=parseBackup(JSON.stringify(p));assert.equal(restored.step,1);assert.equal(restored.reviewedRevision,null);
});

test('PDF upload requires activity details before editing, but framing happens in the product stage',()=>{
 const p=defaultProject();p.template='custom';p.background='data:image/png;base64,YQ==';p.posterReuse={width:1000,height:1400,masks:[],prepared:false,mode:'replace'};
 assert.equal(firstIncomplete(p,2).step,1);assert.equal(firstIncomplete(p,3).step,1);
 p.campaign=ready().campaign;assert.equal(firstIncomplete(p,2),null);assert.equal(firstIncomplete(p,3).step,2);
 p.campaign.start='';assert.equal(firstIncomplete(p,2).step,1);
 p.campaign=ready().campaign;p.background=null;assert.equal(firstIncomplete(p,2).step,1);
});
