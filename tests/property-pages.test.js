import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {requestedFontSize} from '../src/font-settings.js';
import {region,offer} from '../src/retail.js';
import {productMetrics} from '../src/auto-layout.js';
import {productNode,priceLabel} from '../src/model.js';
const source=await readFile(new URL('../src/app.js',import.meta.url),'utf8');
const fn=source.slice(source.indexOf('function selectInput('),source.indexOf('function activateRetail('));
test('content dropdown renders only the selected fields and one style editor',()=>{
 const node={...productNode({id:'rice',name:'Rice',spec:'1kg'}),price:'55'};
 const expected={name:'name',spec:'spec',original:'originalPrice',price:'price'};
 for(const activeRegion of ['image','name','spec','original','price']){
  const ctx={activeRegion,requestedFontSize,region,offer,productMetrics,priceLabel,esc:String,input:(label,key,value)=>`<input data-prop="${key}" value="${value}">`};
  vm.createContext(ctx);vm.runInContext(fn,ctx);const html=ctx.retailProperties(node);
  assert.equal((html.match(/id="retail-region"/g)||[]).length,1);
  for(const field of Object.values(expected))assert.equal(html.includes(`data-prop="${field}"`),field===expected[activeRegion]);
  assert.equal(html.includes('data-prop="priceFontSize"'),activeRegion==='price');
  assert.equal(html.includes('data-text-style="size"'),['name','spec','original'].includes(activeRegion));
  assert.ok(!html.includes('調整組合價格'));
 }
});
