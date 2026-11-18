import {defaultProject,uid} from './model.js';
export function newProject(previous,{name='',template='clean',keepAssets=true}={}){
 if(!['clean','retail','membership','promotion'].includes(template))throw new Error('請選擇有效模板');
 const next=defaultProject();next.archiveCampaignId=uid();next.step=1;next.template=template;
 next.campaign.name=name.trim().slice(0,100)||'新建營銷活動';
 if(keepAssets)for(const key of ['products','icons','backgrounds'])next[key]=(previous[key]||[]).map(asset=>({...asset,aliases:asset.aliases?[...asset.aliases]:undefined}));
 if(keepAssets)next.deletedSampleIds=[...(previous.deletedSampleIds||[])];
 if(template==='retail'){next.retailRows=[3,3,4];next.retailRowHeights=[1,1,.85];next.retailTerms='優惠詳情以門店公佈為準。';}
 return next;
}

export function newProjectFromPoster(previous,asset,{width,height},{name,keepAssets=true}={}){
 if(!asset?.imageUrl||!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0)throw new Error('底圖資料不完整');
 const next=newProject(previous,{name:name||asset.name.replace(/\.[^.]+$/,'').slice(0,60),keepAssets});
 next.backgrounds=uniqueBackgrounds(next.backgrounds);
 const existing=next.backgrounds.find(b=>b.imageUrl===asset.imageUrl);
 if(existing)asset=existing;
 if(!next.backgrounds.some(b=>b.id===asset.id)&&next.backgrounds.length>=20)throw new Error('底圖素材庫已滿，請先移除不用的底圖');
 if(!next.backgrounds.some(b=>b.id===asset.id))next.backgrounds.push({...asset});next.backgroundId=asset.id;
 next.template='custom';next.background=asset.imageUrl;
 next.posterReuse={width,height,masks:[],mode:'replace',prepared:false};
 next.page={width,height,unit:'px',dpi:150};next.flowVersion=2;next.step=1;
 return next;
}

export function uniqueBackgrounds(assets=[]){
 const seen=new Set();return assets.filter(a=>{if(!a.imageUrl||seen.has(a.imageUrl))return false;seen.add(a.imageUrl);return true;});
}
export function backgroundChoices(assets=[]){
 const unique=uniqueBackgrounds(assets),counts=new Map(),indices=new Map();
 for(const a of unique)counts.set(a.name,(counts.get(a.name)||0)+1);
 return unique.map(a=>{const i=(indices.get(a.name)||0)+1;indices.set(a.name,i);return {...a,label:counts.get(a.name)>1?`${a.name}（版本 ${i}）`:a.name};});
}
