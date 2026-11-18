import test from 'node:test';
import assert from 'node:assert/strict';
import {sizeInfo,resizeProject,backgroundBox,displaySize,upgradeCanvasCoordinates} from '../src/sizing.js';
import {defaultProject,productNode,arrange,validate,parseBackup} from '../src/model.js';
import {withDpi} from '../src/png.js';
test('legacy and mm pages convert to exact output pixels',()=>{
 assert.equal(sizeInfo({}).height,2560);
 assert.deepEqual([sizeInfo({page:{width:210,height:297,unit:'mm',dpi:300}}).width,sizeInfo({page:{width:210,height:297,unit:'mm',dpi:300}}).height],[2480,3508]);
 assert.equal(sizeInfo({page:{width:435,height:620,unit:'mm',dpi:300}}).height,7323);
 assert.throws(()=>sizeInfo({page:{width:9000,height:9000,unit:'px',dpi:300}}));
});
test('page resize preserves image ratio and explicit layout fits nodes within bounds',()=>{
 const p=defaultProject();p.nodes=[productNode({id:'a',name:'米'})];const ratio=p.nodes[0].w/p.nodes[0].h;
 resizeProject(p,{width:1920,height:1080,unit:'px',dpi:150});
 assert.ok(Math.abs(p.nodes[0].w/p.nodes[0].h-ratio)<1e-9);
 arrange(p);assert.ok(p.nodes[0].y+p.nodes[0].h<=sizeInfo(p).h);
 assert.ok(!validate(p).errors.some(e=>e.includes('超出畫布')));
});
test('background contain, cover and manual transforms preserve image aspect',()=>{
 const p={page:{width:1080,height:1080,unit:'px',dpi:150}};
 const fit=backgroundBox(p,100,200);assert.equal(fit.w,450);assert.equal(fit.h,900);
 const cover=backgroundBox({...p,backgroundFit:'cover'},100,200);assert.equal(cover.w,900);assert.equal(cover.y,-450);
 const manual={x:-20,y:10,w:400,h:800};assert.deepEqual(backgroundBox({...p,backgroundPlacement:manual},100,200),manual);
});
test('page and background transforms survive backup validation',()=>{
 const p=defaultProject();p.page={width:1080,height:1920,unit:'px',dpi:150};p.backgroundPlacement={x:0,y:20,w:600,h:1000};
 const restored=parseBackup(JSON.stringify(p));assert.deepEqual(restored.page,p.page);assert.deepEqual(restored.backgroundPlacement,p.backgroundPlacement);
});
test('PNG contains chosen physical density',async()=>{
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE1QAAAAASUVORK5CYII=','base64');
 const output=Buffer.from(await (await withDpi(new Blob([png]),300)).arrayBuffer());
 const at=output.indexOf('pHYs');assert.equal(output.readUInt32BE(at+4),11811);assert.equal(output[at+12],1);
});

test('whole-poster resize applies one transform to background, products and text',()=>{
 const p=defaultProject();p.nodes=[productNode({id:'a',name:'米'}),{x:200,y:400,w:100,h:80,fontSize:30,shadow:0}];
 p.backgroundPlacement={x:0,y:0,w:900,h:1280};const before=structuredClone(p);
 resizeProject(p,{width:1080,height:1080,unit:'px',dpi:150},{scaleContents:true});const factor=540/1280;
 assert.equal(p.backgroundPlacement.h,540);
 for(let i=0;i<p.nodes.length;i++){
  assert.ok(Math.abs((p.nodes[i].x-p.backgroundPlacement.x)-before.nodes[i].x*factor)<1e-8);
  assert.ok(Math.abs((p.nodes[i].y-p.backgroundPlacement.y)-before.nodes[i].y*factor)<1e-8);
 }
});

test('resizing the page leaves product and text data unchanged, and reports overflow',()=>{
 const p=defaultProject();p.nodes=[productNode({id:'a',name:'米'}),{id:'t',type:'text',text:'優惠',x:50,y:1000,w:200,h:100,fontSize:30,shadow:0}];
 const before=structuredClone(p.nodes);
 resizeProject(p,{width:1920,height:1080,unit:'px',dpi:150});
 assert.deepEqual(p.nodes,before);
 assert.ok(validate(p).errors.some(e=>e.includes('超出畫布')));
});

test('doubling paper size doubles visible canvas but preserves product screen size',()=>{
 const p=defaultProject();p.nodes=[productNode({id:'a',name:'米'})];const before=structuredClone(p.nodes),view=displaySize(p);
 resizeProject(p,{width:3600,height:5120,unit:'px',dpi:150});
 assert.equal(displaySize(p).width,view.width*2);assert.equal(displaySize(p).height,view.height*2);
 assert.deepEqual(p.nodes,before);assert.equal(sizeInfo(p).scale,2);
});
test('legacy projects upgrade without changing rendered product pixels',()=>{
 const p=defaultProject();delete p.canvasSpace;p.page={width:1080,height:1920,unit:'px',dpi:150};p.nodes=[productNode({id:'a',name:'米'})];
 const pixels=p.nodes[0].w*sizeInfo(p).scale;
 upgradeCanvasCoordinates(p);assert.ok(Math.abs(p.nodes[0].w*sizeInfo(p).scale-pixels)<1e-8);
 const once=structuredClone(p);upgradeCanvasCoordinates(p);assert.deepEqual(p,once);
});
