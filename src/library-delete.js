// The upload library is a view over assets, separate from canvas references.
export function isUploadAsset(asset,assets=[]){
 if(!asset||asset.libraryHidden)return false;
 const seen=new Set();let current=asset;
 while(current&&!seen.has(current.id)){
  seen.add(current.id);
  if(current.source==='upload'||!current.source)return true;
  if(current.source!=='cutout')return false;
  current=assets.find(p=>p.id===current.originalAssetId);
 }
 return false;
}
export function assetUsers(project,id){
 return project.nodes.filter(n=>n.type==='product'&&(n.productId===id||(n.pictures||[]).some(p=>p.productId===id)));
}
export function deleteLibraryAsset(project,id){
 const asset=project.products.find(p=>p.id===id);if(!asset)return {removedNodes:[],affected:0};
 const users=assetUsers(project,id);
 // Keep data needed by existing cards, cutout ancestry or an in-flight task.
 const retained=users.length||project.products.some(p=>p.originalAssetId===id)||
  project.cutoutPending?.assetId===id||project.cutoutPending?.resultAssetId===id;
 if(retained)asset.libraryHidden=true;
 else project.products.splice(project.products.indexOf(asset),1);
 if(asset.source==='sample')project.deletedSampleIds=[...new Set([...(project.deletedSampleIds||[]),id])];
 return {removedNodes:[],affected:0,retained:!!retained};
}
