import { readImage } from './products.js';

export const backgrounds = [
  {id:'retail',name:'至優價 · 3＋3＋4 商品版'},
  {id:'clean',name:'清爽促銷版（無歷史條款）'},
  {id:'membership',name:'會員八格底圖（已清除商品）',path:'output/evaluation/membership-background-v1.png'},
  {id:'promotion',name:'感謝祭底圖（已清除商品）',path:'output/evaluation/promotion-background-v1.png'},
];

export async function seedCatalog(project) {
  const response = await fetch('assets/catalog.json');
  if (!response.ok) throw new Error('樣品索引載入失敗');
  const catalog = await response.json();
  let added = 0;
  for (const record of catalog.products) {
    if ((project.deletedSampleIds||[]).includes(record.id)||project.products.some(p => p.id === record.id)) continue;
    if (project.products.length >= 100) break;
    const response = await fetch(record.path);
    if (!response.ok) throw new Error(`樣品圖片載入失敗：${record.filename}`);
    const blob = await response.blob();
    const imageUrl = await readImage(new File([blob], record.filename, { type: 'image/jpeg' }));
    if((project.deletedSampleIds||[]).includes(record.id)||project.products.some(p=>p.id===record.id))continue;
    project.products.push({...record,imageUrl});added++;
  }
  return added;
}
