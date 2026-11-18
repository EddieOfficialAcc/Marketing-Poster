// Offline visual QA: emit the same layout primitives used by both renderers.
import {readFileSync,writeFileSync} from 'node:fs';
import {arrangeProducts,imageRegion} from '../src/auto-layout.js';
import {retailText} from '../src/retail.js';
import {cleanTemplateElements} from '../src/template-layout.js';
import {sizeInfo} from '../src/sizing.js';
const demo=JSON.parse(readFileSync('assets/retail/demo.json')),metrics=JSON.parse(readFileSync('tmp/pdfs/font-metrics.json'));
const measure=(text,size,family,weight)=>[...text].reduce((sum,c)=>sum+(metrics[family.includes('Arial')?'price':'sans'][weight>=700?'bold':'normal'][c]||1000)*size/1000,0);
const project={canvasSpace:2,template:'retail',page:{width:297,height:420,unit:'mm',dpi:150},campaign:{name:'至優價 · 排版示例',start:'2026-11-01',end:'2026-11-07',stores:'指定門店（示例）'},retailTerms:'排版示例，非本次活動價格。請核對商品、價格及活動條款。',products:demo.products,nodes:demo.goods.map((g,i)=>({...g,id:String(i),type:'product',productId:g.productIds[0],color:'#f11926',fontSize:20,shadow:8}))};
arrangeProducts(project);
const nodes=project.nodes.map(n=>{const box=imageRegion(n),pics=n.productIds.map((id,i)=>{const asset=demo.products.find(a=>a.id===id),count=n.productIds.length;const w=box.w*(count===1?1:.68),h=box.h*(count===1?1:.85+.15*i),scale=Math.min(w/asset.imageWidth,h/asset.imageHeight);return {path:asset.path,x:box.x+(count===1?0:box.w*.32*i)+(w-asset.imageWidth*scale)/2,y:box.y+h-asset.imageHeight*scale,w:asset.imageWidth*scale,h:asset.imageHeight*scale};});return {...n,images:pics,primitives:retailText(n,measure)};});
writeFileSync('tmp/pdfs/retail-scene.json',JSON.stringify({size:sizeInfo(project),template:cleanTemplateElements(project),nodes}));
