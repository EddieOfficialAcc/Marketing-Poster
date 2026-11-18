import test from 'node:test';
import assert from 'node:assert/strict';
import {setFontSize,requestedFontSize} from '../src/font-settings.js';
import {retailText} from '../src/retail.js';
import {productNode,defaultProject,parseBackup} from '../src/model.js';
const asset={id:'rice',name:'Rice',sku:'',spec:'1kg',imageUrl:'data:image/png;base64,eA=='};
const measure=(text,size)=>[...text].length*size*.6;
for(const cardStyle of ['classic','retail'])test(`${cardStyle}: manually setting every text field to 50 really renders at 50`,()=>{
 const n={...productNode(asset),cardStyle,originalPrice:'60',price:'55',quantity:1};
 for(const part of ['name','spec','original','price']){
  assert.equal(setFontSize(n,part,50),true);
  const result=retailText(n,measure).filter(p=>p.part===part&&p.type==='text'&&(part!=='price'||p.primary));
  assert.ok(result.length);for(const line of result)assert.equal(line.size,50);
  assert.equal(requestedFontSize(n,part),50);
 }
 const p=defaultProject();p.products=[asset];p.nodes=[n];assert.deepEqual(parseBackup(JSON.stringify(p)).nodes[0].textStyles,n.textStyles);
});
test('font edits preserve color, typeface, alignment and spacing',()=>{
 const n={...productNode(asset),textStyles:{spec:{autoFit:true,color:'#112233',font:'serif',align:'right',lineHeight:1.7,bold:true}}};
 setFontSize(n,'spec',50);assert.deepEqual(n.textStyles.spec,{autoFit:false,size:50,color:'#112233',font:'serif',align:'right',lineHeight:1.7,bold:true});
 const row=retailText(n,measure).find(p=>p.part==='spec');assert.equal(row.color,'#112233');assert.equal(row.weight,700);assert.match(row.family,/Songti/);
});
test('ordinary text and badges also switch to fixed font size',()=>{
 for(const type of ['text','icon']){const n={type,fontSize:20,autoFit:true};setFontSize(n,'text',50);assert.equal(n.fontSize,50);assert.equal(n.autoFit,false);}
});
test('empty and invalid font input leaves the previous value unchanged',()=>{
 const n={...productNode(asset)};const before=structuredClone(n);assert.equal(setFontSize(n,'spec',''),false);assert.equal(setFontSize(n,'spec','no'),false);assert.deepEqual(n,before);
});
test('old specification default shown in the panel matches its requested render size',()=>{
 const n=productNode(asset);assert.equal(requestedFontSize(n,'spec'),Math.min(n.fontSize,n.h*.052)*.8);assert.ok(requestedFontSize(n,'spec')<n.fontSize);
});
