import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultProject, moneyCents, priceLabel, productNode, touch, transition, validate, parseBackup } from '../src/model.js';
import { ProductFileIndex } from '../src/file-index.js';
import { UploadProductProvider } from '../src/products.js';

const pixel = 'data:image/png;base64,iVBORw0KGgo=';
const rice = {id:'rice-front',name:'秋田小町米',filename:'NP-103801.jpeg',sku:'001234',spec:'1kg',aliases:['秋田米','Akita Komachi Rice'],imageUrl:pixel};
function ready() {
  const p=defaultProject();p.campaign={name:'測試促銷',start:'2026-11-01',end:'2026-11-07',stores:'測試門店'};
  p.products=[structuredClone(rice)];const n=productNode(rice);n.price='33';n.quantity=2;p.nodes=[n];return p;
}
test('money input is exact to cents and rejects invalid or overprecise input',()=>{
  assert.equal(moneyCents('16.50'),1650);assert.equal(moneyCents('0.01'),1);
  for(const invalid of ['1.234','-1','NaN','1e3','', 'Infinity'])assert.equal(moneyCents(invalid),null);
  assert.equal(priceLabel({price:'33',quantity:2}),'$33 / 2件');
});
test('invalid price blocks submission; incomplete metadata does not pass checks',()=>{
  const p=ready();p.nodes[0].price='wrong';assert.throws(()=>transition(p,'submit'),/價格/);
  assert.equal(p.status,'draft');
  const errors=validate(defaultProject()).errors;
  assert.ok(errors.some(e=>e.includes('日期')));assert.ok(errors.some(e=>e.includes('門店')));assert.ok(errors.some(e=>e.includes('商品')));
});
test('approval is tied to the current revision and any edit invalidates it',()=>{
  const p=ready();transition(p,'submit');transition(p,'approve');assert.equal(p.approvedRevision,p.revision);
  p.nodes[0].price='20';touch(p,'價格修改');assert.equal(p.status,'draft');assert.equal(p.approvedRevision,null);
  assert.throws(()=>transition(p,'approve'),/先提交/);
});
test('import always requires fresh approval and preserves file index metadata',()=>{
  const p=ready();transition(p,'submit');transition(p,'approve');
  const restored=parseBackup(JSON.stringify(p));assert.equal(restored.status,'draft');assert.equal(restored.approvedRevision,null);
  assert.deepEqual(restored.products[0].aliases,rice.aliases);assert.equal(restored.products[0].filename,rice.filename);
});
test('backup rejects remote image references, duplicate IDs and invalid index data',()=>{
  const p=ready();p.products[0].imageUrl='https://example.com/tracking.png';assert.throws(()=>parseBackup(JSON.stringify(p)));
  const q=ready();q.nodes.push({...q.nodes[0]});assert.throws(()=>parseBackup(JSON.stringify(q)),/元素格式/);
  const r=ready();r.products[0].aliases='not an array';assert.throws(()=>parseBackup(JSON.stringify(r)),/索引/);
});
test('file index resolves names, aliases, original filenames and leading-zero SKU',()=>{
  const index=new ProductFileIndex([rice]);
  for(const query of ['秋田小町米','秋田 米','AKITA KOMACHI RICE','NP-103801','NP-103801.jpeg','001234']) {
    assert.equal(index.resolve(query).status,'matched',query);assert.equal(index.resolve(query).product.id,rice.id);
  }
  assert.equal(index.resolve('1234').status,'choose'); // partial SKU must not be auto-linked
  assert.equal(index.resolve('').status,'empty');assert.equal(index.resolve('不存在的商品').status,'missing');
});
test('multiple angles and partial names require user choice',()=>{
  const side={...rice,id:'rice-side',filename:'rice-side.jpg'};
  const index=new ProductFileIndex([rice,side]);assert.equal(index.resolve('秋田小町米').status,'choose');
  assert.equal(index.resolve('秋田小町米').matches.length,2);
  assert.equal(new ProductFileIndex([rice]).resolve('秋田').status,'choose');
  assert.equal(index.resolve('NP-103801').product.id,rice.id);
});
test('renaming indexed assets immediately changes lookup without changing poster snapshots',async()=>{
  const p=ready(),provider=new UploadProductProvider(p.products);
  await provider.updateMetadata(rice.id,{name:'秋田小町米 1kg',sku:'001234',aliases:['秋田米','秋田米']});
  assert.equal((await provider.resolve('秋田小町米 1kg')).status,'matched');
  assert.equal((await provider.resolve('秋田米')).status,'matched');
  assert.equal(p.products[0].aliases.length,1);assert.equal(p.nodes[0].name,'秋田小町米');
  assert.equal((await provider.list('NP-103801')).length,1);
});

test('decimal sizes are not merged when searching products',()=>{
  const index=new ProductFileIndex([{id:'a',name:'礦泉水 15L',sku:'W15'}]);
  assert.notEqual(index.resolve('1.5L').status,'matched');
  assert.equal(index.resolve('礦泉水 15L').status,'matched');
});
