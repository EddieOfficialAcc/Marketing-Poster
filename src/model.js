import {repairPairedPriceBindings} from './paired-prices.js';
import {validPosterReuse} from './poster-reuse.js';
import {retailErrors,retailPageErrors,offer} from './retail.js';
import {validPriceTag} from './price-tag.js';
import {restoreTemplateSnapshot} from './template-layout.js';
import {arrangeProducts} from './auto-layout.js';
import {sizeInfo,upgradeCanvasCoordinates} from './sizing.js';
export const WIDTH = 900, HEIGHT = 1280;
export function uid() {
  const crypto = globalThis.crypto;
  if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID();
  // getRandomValues is also available on ordinary HTTP origins.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export const defaultProject = () => ({
  schema: 1, canvasSpace:2, campaign: { name: '新建營銷活動', start: '', end: '', stores: '' },
  template: 'clean', background: null, products: [], icons: [], nodes: [], revision: 1,
  status: 'draft', exportMode:'print', approvedRevision: null, history: [],
});

export function moneyCents(value) {
  const s = String(value).trim();
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}
export function amount(cents) {
  return (cents / 100).toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
}
export function priceLabel(node) {
  if(node.imageOnly)return '僅圖片';
  const cents = moneyCents(node.price);
  if (cents === null || cents <= 0) return '待填價格';
  if(node.price2)return '$'+offer(node).main;
  return node.quantity > 1 ? `$${amount(cents)} / ${node.quantity}件` : `$${amount(cents)}`;
}
export function touch(project, message = '內容修改') {
  const previous = project.status;
  project.revision += 1;
  project.status = 'draft';
  project.approvedRevision = null;
  project.reviewedRevision = null;
  if (previous !== 'draft') log(project, `${message}，原流程狀態失效，返回草稿`);
}
export function log(project, message) {
  project.history.unshift({ at: new Date().toISOString(), message, revision: project.revision });
  project.history = project.history.slice(0, 40);
}
export function validate(project) {
  let dimensions;try{dimensions=sizeInfo(project);}catch(error){return {errors:[error.message],warnings:[]};}
  const {w:WIDTH,h:HEIGHT}=dimensions;
  const errors = retailPageErrors(project), warnings = [];
  if (!project.campaign.name.trim()) errors.push('請填寫活動名稱');
  if (!project.campaign.start || !project.campaign.end) errors.push('請填寫活動開始及結束日期');
  else if (project.campaign.start > project.campaign.end) errors.push('結束日期不能早於開始日期');
  if (!project.campaign.stores.trim()) errors.push('請填寫適用門店範圍');
  for(const n of project.nodes.filter(n=>n.type==='imageIcon'))if(!(project.icons||[]).some(a=>a.id===n.iconId))errors.push('找不到標識圖片，請重新選擇');
  const goods = project.nodes.filter(n => n.type === 'product');
  if (!goods.length&&!(project.template==='custom'&&project.background&&project.posterReuse&&project.nodes.length)) errors.push('請至少加入一件商品');
  for (const n of goods) {
    const name = n.name.trim() || '未命名商品';
    if(!n.imageOnly&&n.pdfOcr&&n.pdfReview!==true)errors.push(`${name}：請核對 PDF 識別的名稱、規格、總價及件數`);
    errors.push(...retailErrors(n).map(e=>`${name}：${e}`));
    if(n.cardStyle==='retail'&&n.quantity>1)warnings.push(`${name}：平均單價按${{integer:'整元',tenth:'一位小數',cent:'兩位小數'}[n.averageRounding||'tenth']}四捨五入，請核對展示價格`);
    if (!n.name.trim()) errors.push('有商品尚未填寫名稱');
    const images=n.pictures||[{productId:n.productId}];
    if (images.some(image=>!project.products.some(p => p.id === image.productId))) errors.push(`${name}：找不到商品圖片`);
    if(images.length>1) warnings.push(`${name}：組合包含 ${images.length} 張圖片，請確認名稱、規格及優惠件數`);
    if (!n.imageOnly&&(moneyCents(n.price) === null || moneyCents(n.price) <= 0)) errors.push(`${name}：價格須為大於 0 的金額，最多兩位小數`);
    if (!Number.isInteger(n.quantity) || n.quantity < 1 || n.quantity > 99) errors.push(`${name}：優惠件數須為 1–99`);
    if (!n.sku.trim()) warnings.push(`${name}：未填商品編號，尚不能與商品庫對照`);
    if (!n.spec.trim()) warnings.push(`${name}：未填包裝規格`);
    if(n.importedOffer && (moneyCents(n.price)!==moneyCents(n.importedOffer.price)||moneyCents(n.price2)!==moneyCents(n.importedOffer.price2)||n.quantity!==n.importedOffer.quantity))warnings.push(`${name}：價格或件數與匯入表格第 ${n.importedOffer.row} 行不同，請重新確認促銷來源`);
  }
  for (const n of project.nodes) if (n.x < 0 || n.y < 0 || n.x + n.w > WIDTH || n.y + n.h > HEIGHT) errors.push('有元素超出畫布，請調整位置或尺寸');
  if (!['clean','retail'].includes(project.template)) warnings.push('目前底圖可能含歷史活動文字，請人工核對全部條款');
  warnings.push('未接入門店 POS：目前檢查不代表實際收銀價格一致');
  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}
export function transition(project, action) {
  if (action === 'submit') {
    const { errors } = validate(project);
    if (errors.length) throw new Error(errors[0]);
    if (project.status !== 'draft') throw new Error('只有草稿可以提交');
    project.status = 'review'; log(project, '提交校對');
  } else if (action === 'approve') {
    if (project.status !== 'review') throw new Error('請先提交校對');
    const { errors } = validate(project);
    if (errors.length) throw new Error(errors[0]);
    project.status = 'approved'; project.approvedRevision = project.revision;
    log(project, '已校對；仍需核對門店價格');
  } else if (action === 'return') {
    project.status = 'draft'; project.approvedRevision = null; log(project, '退回草稿');
  } else throw new Error('未知流程操作');
}
export function productNode(product, index = 0) {
  return { id: uid(), type: 'product', productId: product.id, name: product.name, sku: product.sku || '', spec: product.spec || '', price: '', quantity: 1,
    x: 50 + (index % 3) * 275, y: 210 + Math.floor(index / 3) % 3 * 320, w: 245, h: 285, shadow: 8, color: '#e52731', fontSize: 20 };
}
export function arrange(project) { arrangeProducts(project); }
export function textEntries(project) {
  return project.nodes.filter(n=>!n.imageOnly).flatMap(n => n.type === 'product' ? [
    { id: n.id, field: 'name', label: '商品名稱', text: n.name },
    { id: n.id, field: 'spec', label: '包裝規格', text: n.spec },
    { id: n.id, field: 'price', label: '促銷價格', text: priceLabel(n) },
  ] : [{ id: n.id, field: 'text', label: ['icon','imageIcon'].includes(n.type) ? '標識' : '自訂文字', text: n.text }]);
}

const imageSource = value => typeof value === 'string' && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value);
export function parseBackup(raw) {
  let p;try{p=JSON.parse(raw);}catch{throw new Error('不是有效的海報專案 JSON 備份');}
  if(!p||typeof p!=='object'||p.schema!==1||!p.campaign||!Array.isArray(p.products)||!Array.isArray(p.nodes)||p.nodes.some(n=>!n||typeof n!=='object'))throw new Error('不是支援的海報專案備份');
  if(p.posterReuse!==undefined&&!validPosterReuse(p.posterReuse))throw new Error('舊海報遮蓋區格式錯誤');
  upgradeCanvasCoordinates(p);
  const {w:WIDTH,h:HEIGHT}=sizeInfo(p);
  if(p.backgroundPlacement&&!(['x','y','w','h'].every(k=>Number.isFinite(p.backgroundPlacement[k]))&&p.backgroundPlacement.w>0&&p.backgroundPlacement.h>0))throw new Error('底圖位置格式錯誤');
  const str = (v, max = 200) => typeof v === 'string' && v.length <= max;
  if (!p || p.schema !== 1 || !p.campaign || !Array.isArray(p.products) || !Array.isArray(p.nodes)) throw new Error('不是支援的海報專案備份');
  if (!['name','start','end','stores'].every(k => str(p.campaign[k])) || !['clean','retail','membership','promotion','custom'].includes(p.template)) throw new Error('活動或模板資料格式錯誤');
  if (p.products.length > 100 || p.nodes.length > 100) throw new Error('備份超出 100 個素材或元素的上限');
  const validDate = d => d === '' || /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d));
  if (!validDate(p.campaign.start) || !validDate(p.campaign.end)) throw new Error('日期格式錯誤');
  const ids = new Set();
  for (const product of p.products) {
    if (!str(product.id, 80) || ids.has(product.id) || !str(product.name) || !str(product.sku) || !str(product.spec) || !imageSource(product.imageUrl)) throw new Error('商品素材格式錯誤');
    ids.add(product.id);
    // Backwards compatible with projects created before file indexing.
    product.filename ??= product.name;
    product.aliases ??= [];
    if (!str(product.filename, 300) || !Array.isArray(product.aliases) || product.aliases.length > 20 || !product.aliases.every(a => str(a, 100))) throw new Error('檔案索引格式錯誤');
  }
  if(p.deletedSampleIds!==undefined&&(!Array.isArray(p.deletedSampleIds)||p.deletedSampleIds.length>1000||!p.deletedSampleIds.every(id=>str(id,80))))throw new Error('已刪除樣品索引格式錯誤');
  p.icons ??= [];
  if(!Array.isArray(p.icons)||p.icons.length>50)throw new Error('標識索引格式錯誤');
  const iconIds=new Set();
  for(const a of p.icons){
    if(!a||!str(a.id,80)||iconIds.has(a.id)||!str(a.name,200)||!imageSource(a.imageUrl)||!Number.isFinite(a.width)||!Number.isFinite(a.height)||a.width<=0||a.height<=0)throw new Error('標識素材格式錯誤');
    iconIds.add(a.id);
  }
  if(retailPageErrors(p).length)throw new Error(retailPageErrors(p)[0]);
  repairPairedPriceBindings(p);
  const nodeIds = new Set();
  for (const n of p.nodes) {
    if (!str(n.id, 80) || nodeIds.has(n.id) || !['product','text','icon','imageIcon'].includes(n.type)) throw new Error('元素格式錯誤');
    nodeIds.add(n.id);
    if(n.type==='product'&&retailErrors(n).length)throw new Error(retailErrors(n)[0]);
    if(n.cardStyle!==undefined&&!['classic','retail'].includes(n.cardStyle))throw new Error('商品版式無效');
    if(n.priceFontSize !== undefined && (!Number.isFinite(n.priceFontSize) || n.priceFontSize < 1 || n.priceFontSize > 1000)) throw new Error('價格字號錯誤');
    if (!['x','y','w','h','fontSize','shadow'].every(k => Number.isFinite(n[k])) || n.x < -WIDTH || n.y < -HEIGHT || n.x > WIDTH * 2 || n.y > HEIGHT * 2 || n.w < 1 || n.w > 8192 || n.h < 1 || n.h > 8192 || n.fontSize < 1 || n.fontSize > 1000 || n.shadow < 0 || n.shadow > 300 || !/^#[0-9a-f]{6}$/i.test(n.color)) throw new Error('元素樣式或尺寸錯誤');
    if (n.type === 'product' && (!ids.has(n.productId) || !['name','sku','spec','price'].every(k => str(n[k])) || !Number.isInteger(n.quantity) || n.quantity < 1 || n.quantity > 99)) throw new Error('商品欄位錯誤');
    if(n.type==='imageIcon'&&!iconIds.has(n.iconId))throw new Error('找不到標識圖片');
    if (n.type !== 'product' && !str(n.text, 500)) throw new Error('文字欄位錯誤');
    if (n.priceTag !== undefined && (n.type !== 'text' || !validPriceTag(n.priceTag))) throw new Error('價格牌總價或件數錯誤');
    if(n.pictures !== undefined) {
      if(n.type!=='product'||!Array.isArray(n.pictures)||n.pictures.length<1||n.pictures.length>6)throw new Error('商品組合格式錯誤');
      const pictureIds=new Set();
      for(const pic of n.pictures){
        if(!pic||!str(pic.id,80)||pictureIds.has(pic.id)||!ids.has(pic.productId)||!['x','y','w','h'].every(k=>Number.isFinite(pic[k]))||pic.x<0||pic.y<0||pic.w<.1||pic.h<.1||pic.x+pic.w>1.00001||pic.y+pic.h>1.00001)throw new Error('組內圖片位置或素材錯誤');
        pictureIds.add(pic.id);
      }
    }
  }
  p.backgrounds ??= [];
  if(!Array.isArray(p.backgrounds)||p.backgrounds.length>20)throw new Error('底圖索引格式錯誤');
  const backgroundIds=new Set();
  for(const asset of p.backgrounds){
    if(!asset||!str(asset.id,80)||backgroundIds.has(asset.id)||!str(asset.name,300)||!imageSource(asset.imageUrl))throw new Error('底圖索引格式錯誤');
    backgroundIds.add(asset.id);
  }
  for(const key of ['retailHeader','retailLogo'])if(p[key]!==undefined&&!imageSource(p[key]))throw new Error('品牌素材格式錯誤');
  if (p.templateImage !== undefined && !imageSource(p.templateImage)) throw new Error('存檔底圖格式錯誤');
  if (p.background !== null && !imageSource(p.background)) throw new Error('底圖資料格式錯誤');
  if (p.template === 'custom' && !p.background) throw new Error('缺少自訂底圖');
  restoreTemplateSnapshot(p);
  p.history = []; p.status = 'draft'; p.approvedRevision = null;
  p.reviewedRevision = null; p.step = 1;
  p.revision = Number.isSafeInteger(p.revision) && p.revision > 0 ? p.revision + 1 : 1;
  log(p, '匯入備份，需重新校對');
  return p;
}
