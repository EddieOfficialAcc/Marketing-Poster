// Prices refer to product identities, not the changing paint order of pictures.
export function replacePictureAsset(node,oldId,newId,pictureId=null){
 let changed=false;
 for(const picture of node.pictures||[]){
  if(picture.productId===oldId&&(!pictureId||picture.id===pictureId)){picture.productId=newId;changed=true;}
 }
 if(node.productId===oldId&&(!pictureId||changed))node.productId=newId;
 if(changed&&node.price2ProductId===oldId)node.price2ProductId=newId;
}

export function repairPairedPriceBindings(project){
 const assets=new Map((project.products||[]).map(a=>[a.id,a]));
 let repaired=0;
 for(const node of project.nodes||[]){
  if(!node.price2||!Array.isArray(node.pictures)||node.pictures.length!==2)continue;
  const ids=[...new Set(node.pictures.map(p=>p.productId))];
  if(ids.length!==2||ids.some(id=>!assets.has(id))||ids.includes(node.price2ProductId))continue;
  const previous=node.price2ProductId,code=node.groupCodes?.[1];
  const candidates=ids.filter(id=>{
   const seen=new Set();let asset=assets.get(id);
   while(asset&&!seen.has(asset.id)){
    seen.add(asset.id);
    if(previous&&asset.originalAssetId===previous)return true;
    if(!previous&&code&&(asset.sku===code||asset.code===code))return true;
    asset=assets.get(asset.originalAssetId);
   }
   return false;
  });
  // Legacy two-picture cards used productId for the first product. Only use
  // that invariant when neither a previous binding nor an explicit code exists.
  if(!previous&&!code&&ids.includes(node.productId))candidates.push(...ids.filter(id=>id!==node.productId));
  if(candidates.length===1){node.price2ProductId=candidates[0];repaired++;}
 }
 return repaired;
}
