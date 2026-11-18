import { validate } from './model.js';

export const steps = [
  { title: '活動資料', hint: '上傳底圖後先填寫活動名稱、日期及門店，再進入加商品。' },
  { title: '加商品', hint: '選商品、填價格；需要兩件展示時點擊「加一張」，再選並排或前後錯落。' },
  { title: '確認下載', hint: '先查看海報與檢查結果，確認內容後下載。' },
];
export function stepIssues(project, step) {
  if(step===1){
    const c=project.campaign, issues=[];
    if(!c.name.trim())issues.push('請填寫活動名稱');
    if(!c.start||!c.end)issues.push('請填寫活動開始及結束日期');
    else if(c.start>c.end)issues.push('結束日期不能早於開始日期');
    if(!c.stores.trim())issues.push('請填寫適用門店');
    if(project.template==='custom'&&!project.background)issues.push('請選擇或上傳底圖');
    return issues;
  }
  if(step===2)return (project.nodes.some(n=>n.type==='product')||(project.template==='custom'&&project.background&&project.posterReuse&&project.nodes.length))?validate(project).errors:['請至少加入一件商品'];
  if(step===3)return [...validate(project).errors,...(project.reviewedRevision===project.revision?[]:['請確認已校對本版本的海報內容'])];
  return [];
}
export function firstIncomplete(project, target) {
  for(let step=1;step<target;step++){
    const issues=stepIssues(project,step);
    if(issues.length)return {step,issues};
  }
  return null;
}
