import {requestSignal} from './request-signal.js';
import {layoutPictures} from './composition.js';
import {readImage} from './products.js';
import { productNode, arrange, uid } from './model.js';

// Rank only candidates already associated with this POS product, never unrelated images.
export function preferredCampaignImages(candidates,row={}){
 const normalized=value=>String(value??'').normalize('NFKC').trim().toLowerCase();
 const rank=asset=>{
  const filename=String(asset.filename||'').split(/[\\/]/).at(-1),stem=filename.replace(/\.[^.]+$/,'');
  const identifiers=[row.code,row.sku,row.productid,asset.sku,asset.externalId,...(asset.aliases||[])].filter(Boolean).map(normalized);
  const exact=identifiers.includes(normalized(stem));
  const category=String(asset.angle||asset.category||'').split(' · ')[0].trim();
  return [/\.png$/i.test(filename)?0:1,category==='街貨'||category==='街货'?0:1,exact?0:1,stem.length];
 };
 return [...candidates].sort((a,b)=>{
  const ar=rank(a),br=rank(b);for(let i=0;i<ar.length;i++)if(ar[i]!==br[i])return ar[i]-br[i];
  const ak=normalized(a.angle||a.filename||a.id),bk=normalized(b.angle||b.filename||b.id);
  return ak<bk?-1:ak>bk?1:String(a.id).localeCompare(String(b.id));
 });
}

export async function matchCampaign(rows, provider) {
  return Promise.all(rows.map(async source=>{
    const row={...source};for(const key of ['companion','companion3','companion4'])if(source[key])row[key]=(await matchCampaign([source[key]],provider))[0];
    // POS 查詢成功時只用 POS 圖片庫的候選（後端一定附上 libraryProducts，可為空）；
    // POS 無法連線時後端不附候選，改按商品編號或名稱匹配本機素材。
    if(row.libraryLookup||Array.isArray(row.libraryProducts)){
      const candidates=preferredCampaignImages(row.libraryProducts||[],row);
      const selected=candidates.find(p=>p.id===row.assetId)||candidates[0];
      return {...row,libraryProducts:candidates,assetId:selected?.id||'',matchStatus:selected?'matched':'missing'};
    }
    const match=await provider.resolve(row.sku||row.code||row.name);
    return {...row, assetId:match.status==='matched'?match.product.id:'', matchStatus:match.status};
  }));
}
export function applyCampaign(project, rows, filename = '') {
  if(!rows.length||rows.length>12)throw new Error('一次支援 1–12 件商品');
  if(project.template==='retail'&&rows.length>(project.retailRows||[3,3,4]).reduce((a,b)=>a+b,0))throw new Error('匯入商品超出模板格數，請先增加每行商品數');
  if(rows.some(row=>row.code2&&(!row.companion?.assetId||!project.products.some(p=>p.id===row.companion.assetId))))throw new Error('請選擇第二件商品圖片');
  if(rows.some(r=>[3,4].some(i=>r['code'+i]&&!project.products.some(a=>a.id===r['companion'+i]?.assetId))))throw new Error('請選擇第三、第四件商品圖片');
  const assets=rows.map(row=>project.products.find(p=>p.id===row.assetId));
  if(assets.some(p=>!p))throw new Error('請為每一行選擇商品圖片');
  const nodes=rows.map((row,i)=>({...productNode(assets[i],i),name:row.name,sku:row.sku||assets[i].sku,spec:row.spec||assets[i].spec,price:row.price,quantity:row.quantity,...Object.fromEntries(['price2','originalPrice2','originalPrice','originalPriceMax','originalStrike','averageRounding','badge'].filter(key=>row[key]!==undefined).map(key=>[key,row[key]])),importedOffer:{filename,row:row.row,price:row.price,price2:row.price2,quantity:row.quantity}}));
  const first=rows[0];
  project.campaign={name:first.campaign,start:first.start,end:first.end,stores:first.stores};
  project.nodes=nodes;arrange(project);
  nodes.forEach((node,i)=>attachCampaignPictures(node,rows[i],project.products));
}

// Snapshot only the selected server assets; never substitute a local asset by name.
export async function snapshotCampaignImages(project, rows, load = async remote => {
  const response=await fetch(remote.imageUrl,{signal:requestSignal(45000)});
  if(!response.ok)throw new Error('伺服器商品圖片讀取失敗，請檢查圖片掛載');
  return readImage(new File([await response.blob()],remote.filename,{type:'image/png'}));
}, onProgress = () => {}) {
  const products=new Map(project.products.map(p=>[p.id,p]));
  const selected=new Map();
  for(const row of rows.flatMap(row=>[row,...['companion','companion3','companion4'].map(k=>row[k]).filter(Boolean)])){
    const remote=(row.libraryProducts||[]).find(p=>p.id===row.assetId);
    if((row.productid||row.code||row.libraryLookup)&&row.libraryProducts?.length&&!remote)throw new Error(`商品 ${row.code||row.productid}：請選擇對應的伺服器圖片`);
    if(remote)selected.set(remote.id,remote);
  }
  if(new Set([...products.keys(),...selected.keys()]).size>100)throw new Error('素材庫超過 100 張，請刪除不需要的素材後再匯入');
  const queue=[...selected.values()];let cursor=0,completed=0,failure=null;
  onProgress(`正在下載商品圖片（0/${queue.length}）…`);
  await Promise.all(Array.from({length:Math.min(3,queue.length)},async()=>{
    while(!failure&&cursor<queue.length){
      const remote=queue[cursor++];
      try{
        products.set(remote.id,{...remote,imageUrl:await load(remote)});
        if(!failure)onProgress(`正在下載商品圖片（${++completed}/${queue.length}）…`);
      }catch(error){failure ||= new Error(`商品 ${remote.sku||remote.code||remote.name||remote.filename||remote.id} 圖片讀取失敗：${error.message}`,{cause:error});}
    }
  }));
  if(failure)throw failure;
  project.products=[...products.values()];
}

export function attachCampaignPictures(node,row,assets=[]){
 if(![row.code2,row.code3,row.code4].some(Boolean))return;
 const members=[2,3,4].filter(i=>row['code'+i]).map(i=>row[i===2?'companion':'companion'+i]);
 if(members.some(r=>!r?.assetId))throw new Error('請選擇組內每件商品圖片');
 node.pictures=[row.assetId,...members.map(r=>r.assetId)].map(productId=>({id:uid(),productId,x:0,y:0,w:1,h:1}));
 node.groupCodes=[row.code||row.sku,...[2,3,4].map(i=>row['code'+i]).filter(Boolean)];
 if(row.price2)node.price2ProductId=row.companion.assetId;
 layoutPictures(node,'overlap',assets);
}
