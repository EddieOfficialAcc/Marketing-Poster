import test from 'node:test';
import assert from 'node:assert/strict';
import {newProjectFromPoster} from '../src/new-project.js';
import {applyPdfReconstruction} from '../src/pdf-rebuild.js';
import {validate,parseBackup} from '../src/model.js';
const imageUrl='data:image/png;base64,YQ==';
function fixture(){return {version:1,pageWidth:500,pageHeight:700,products:[{name:'Rice',spec:'1kg',price:'39.9',quantity:2,originalPrice:'23',box:[20,100,220,300],imageBox:[20,100,220,200],textBox:[20,305,220,95],images:[{imageUrl,box:[30,110,100,180]},{imageUrl,box:[125,120,100,175]}],ocr:{nameAndSpec:[{text:'Rice 1kg'}],offer:[{text:'$39.9/2件'}]}}],regions:[{box:[.04,1/7,.44,3/7],color:'#fff5df'}],warnings:['核對']};}
function project(){return newProjectFromPoster({}, {id:'bg',name:'poster.png',imageUrl},{width:1000,height:1400});}
test('reconstructed products retain separate pictures and editable offer with review required',()=>{
 const p=project();applyPdfReconstruction(p,fixture());assert.equal(p.nodes.length,1);const n=p.nodes[0];assert.equal(n.pictures.length,2);assert.equal(n.price,'39.9');assert.equal(n.quantity,2);assert.equal(n.pdfReview,false);assert.equal(p.posterReuse.masks[0].nodeId,n.id);assert.equal(p.step,1);
 p.campaign={name:'Sale',start:'2026-10-01',end:'2026-10-02',stores:'HK'};
 assert.ok(validate(p).errors.some(e=>e.includes('PDF')));n.pdfReview=true;assert.deepEqual(validate(p).errors,[]);
 const restored=parseBackup(JSON.stringify(p));assert.equal(restored.nodes[0].pdfOcr.offer[0].text,'$39.9/2件');assert.equal(restored.pdfImport.productCount,1);
});
test('invalid grouped images do not partially mutate project',()=>{
 const p=project(),r=fixture();r.products[0].images=[];assert.throws(()=>applyPdfReconstruction(p,r));assert.equal(p.products.length,0);assert.equal(p.nodes.length,0);
});
