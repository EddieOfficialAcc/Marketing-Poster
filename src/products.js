// UI depends on this provider contract. Replace this provider with a server API
// adapter later; the editor continues to reference productId and an asset snapshot.
import { uid } from './model.js';
import {isUploadAsset} from './library-delete.js';
import { ProductFileIndex } from './file-index.js';
export class UploadProductProvider {
  constructor(products) { this.products = products; }
  index() { return new ProductFileIndex(this.products.filter(p=>isUploadAsset(p,this.products))); }
  async list(query = '') {
    return this.index().search(query).map(match => match.product);
  }
  async get(id) { return this.products.find(p => p.id === id) ?? null; }
  async resolve(query) { return this.index().resolve(query); }
  async updateMetadata(id, metadata) {
    const product = await this.get(id);
    if (!product) throw new Error('找不到商品素材');
    const name = metadata.name.trim(), sku = metadata.sku.trim();
    const aliases = [...new Set(metadata.aliases.map(alias => alias.trim()).filter(Boolean))];
    if (!name || name.length > 100 || sku.length > 80 || aliases.length > 20 || aliases.some(alias => alias.length > 100)) throw new Error('請填寫名稱；最多 20 個別名，每個最多 100 字');
    Object.assign(product, { name, sku, aliases, updatedAt: new Date().toISOString() });
    return product;
  }
  async upload(file) {
    const imageUrl = await readImage(file);
    const product = { id: uid(), externalId: null, source: 'upload', assetVersion: 1,
      name: file.name.replace(/\.[^.]+$/, '').slice(0, 100), filename: file.name, aliases: [], sku: '', spec: '', imageUrl,
      createdAt: new Date().toISOString() };
    this.products.push(product);
    return product;
  }
}
export async function readImage(file) {
  if (!['image/png','image/jpeg','image/webp'].includes(file.type)) throw new Error('僅支援 PNG、JPG、WebP 圖片');
  if (file.size > 12 * 1024 * 1024) throw new Error('單張圖片不可超過 12 MB');
  const url = await new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('讀取圖片失敗')); reader.readAsDataURL(file);
  });
  const img = new Image(); img.src = url;
  // decode() can reject for a valid image while the browser is busy decoding many large ones
  // (batch uploads); fall back to the load event and fail only if the image really cannot load.
  try { await img.decode(); }
  catch {
    await new Promise((resolve, reject) => {
      if (img.complete) return img.naturalWidth ? resolve() : reject(new Error('圖片無法解碼，請更換檔案'));
      img.onload = resolve; img.onerror = () => reject(new Error('圖片無法解碼，請更換檔案'));
    });
  }
  if (!img.naturalWidth || !img.naturalHeight || img.naturalWidth * img.naturalHeight > 50_000_000) throw new Error('圖片尺寸過大或無效');
  // Retain uploaded pixels without generative reconstruction or automatic cutout.
  return url;
}

let dbPromise;
function database() {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('bestmart-poster-studio', 2);
    request.onupgradeneeded = () => {
      for(const name of ['projects','posterPdfs'])if(!request.result.objectStoreNames.contains(name))request.result.createObjectStore(name);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}
// Storage revision is independent of the campaign's editable revision and backups.
let draftRevision=null;
export async function loadProject() {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx=db.transaction('projects'),store=tx.objectStore('projects');
    const draft=store.get('current'),revision=store.get('current-revision');
    tx.oncomplete=()=>{draftRevision=revision.result??0;resolve(draft.result??null);};
    tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error('讀取草稿中斷'));
  });
}
export async function saveProject(snapshot) {
  const db = await database();
  if(draftRevision===null)throw new Error('尚未成功讀取本機草稿，請先匯出備份後重新載入');
  return new Promise((resolve, reject) => {
    // IndexedDB serializes read/write transactions across tabs. Check and put
    // must be in this same transaction, never a separate preflight read.
    const tx = db.transaction('projects', 'readwrite'),store=tx.objectStore('projects');
    let conflict,nextRevision;
    const revision=store.get('current-revision');
    revision.onsuccess=()=>{
      const stored=revision.result??0;
      if(stored!==draftRevision){
        conflict=Object.assign(new Error('另一個分頁已更新草稿，本頁未覆寫。請先匯出本頁專案備份，再重新載入最新草稿。'),{code:'DRAFT_CONFLICT'});
        tx.abort();return;
      }
      nextRevision=stored+1;
      store.put(snapshot,'current');store.put(nextRevision,'current-revision');
    };
    tx.oncomplete=()=>{draftRevision=nextRevision;resolve();};
    tx.onerror=()=>reject(conflict||tx.error);
    tx.onabort=()=>reject(conflict||tx.error||new Error('儲存中斷'));
  });
}

// 舊海報原始 PDF（以底圖 ID 為鍵）：底圖素材只存圖片，「全自動換商品」偵測舊商品格需要原 PDF。
// 只存在本機瀏覽器；底圖被刪除後一併清理。
export async function savePosterPdf(backgroundId,record,keepIds=[]){
  const db=await database();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction('posterPdfs','readwrite'),store=tx.objectStore('posterPdfs');
    const keys=store.getAllKeys();
    keys.onsuccess=()=>{for(const key of keys.result)if(key!==backgroundId&&!keepIds.includes(key))store.delete(key);store.put(record,backgroundId);};
    tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error('保存舊海報 PDF 中斷'));
  });
}
export async function loadPosterPdf(backgroundId){
  const db=await database();
  return new Promise((resolve,reject)=>{
    const request=db.transaction('posterPdfs').objectStore('posterPdfs').get(backgroundId);
    request.onsuccess=()=>resolve(request.result??null);request.onerror=()=>reject(request.error);
  });
}
export async function posterPdfIds(){
  const db=await database();
  return new Promise((resolve,reject)=>{
    const request=db.transaction('posterPdfs').objectStore('posterPdfs').getAllKeys();
    request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
  });
}
