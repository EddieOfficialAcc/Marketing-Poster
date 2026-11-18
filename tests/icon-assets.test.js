import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultProject,parseBackup,validate,arrange} from '../src/model.js';
import {iconNode,containIcon} from '../src/icon-assets.js';
const asset={id:'logo',name:'品牌標識',width:400,height:100,imageUrl:'data:image/png;base64,iVBORw0KGgo='};
test('uploaded icons retain their ratio, fit the page, and are excluded from product arrangement',()=>{
 const p=defaultProject();p.icons=[asset];const n=iconNode(asset,p);p.nodes=[n];const before=structuredClone(n);arrange(p);
 assert.deepEqual(n,before);assert.equal(n.w/n.h,4);assert.ok(n.x+n.w<=900&&n.y+n.h<=1280);
 assert.deepEqual(containIcon({x:0,y:0,w:200,h:200},400,100),{x:0,y:75,w:200,h:50});
});
test('backup restores icon pixels and references; deleting a placement leaves reusable assets',()=>{
 const p=defaultProject();p.icons=[asset];p.nodes=[iconNode(asset,p)];
 const restored=parseBackup(JSON.stringify(p));assert.deepEqual(restored.icons,[asset]);assert.equal(restored.nodes[0].iconId,'logo');
 p.nodes=[];assert.deepEqual(parseBackup(JSON.stringify(p)).icons,[asset]);
});
test('missing icons and unsafe image sources cannot be imported or silently confirmed',()=>{
 const p=defaultProject();p.icons=[asset];p.nodes=[iconNode(asset,p)];p.nodes[0].iconId='missing';
 assert.throws(()=>parseBackup(JSON.stringify(p)),/標識圖片/);assert.ok(validate(p).errors.some(e=>e.includes('標識圖片')));
 p.nodes[0].iconId='logo';p.icons=[{...asset,imageUrl:'data:image/svg+xml;base64,PHN2Zz4='}];
 assert.throws(()=>parseBackup(JSON.stringify(p)),/標識素材/);
});
