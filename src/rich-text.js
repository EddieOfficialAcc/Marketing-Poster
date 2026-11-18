// 自訂文字標記：~~文字~~ 為刪除線（例如舊價 ~~$14~~），**文字** 為粗體（例如品牌行 **樂事**）。
// 渲染時移除標記並逐字記錄樣式。
export function strikeText(text){
 const chars=[],marks=[],bold=[],s=String(text);let strike=false,heavy=false;
 for(let i=0;i<s.length;){
  if(s.startsWith('~~',i)){strike=!strike;i+=2;continue;}
  if(s.startsWith('**',i)){heavy=!heavy;i+=2;continue;}
  const char=String.fromCodePoint(s.codePointAt(i));chars.push(char);marks.push(strike);bold.push(heavy);i+=char.length;
 }
 return {plain:chars.join(''),chars,marks,bold};
}
export const BOLD_WEIGHT=700;
// 文字層字體：舊海報的英文與數字多為 Arial／Helvetica，識別出的文字層用「海報」字體以貼近原樣。
export const TEXT_FONTS={default:'"PingFang TC", "Microsoft JhengHei", sans-serif',poster:'Arial, "Helvetica Neue", "PingFang TC", "Microsoft JhengHei", sans-serif'};
export function textFamily(node){return TEXT_FONTS[node?.textLayout?.font]||TEXT_FONTS.default;}
// Fabric Textbox 的 styles 以未換行的原始行與行內字元位置為索引。
export function strikeStyles(text){
 const {chars,marks,bold}=strikeText(text),styles={};let line=0,col=0;
 chars.forEach((char,i)=>{
  if(char==='\n'){line++;col=0;return;}
  if(marks[i]||bold[i])(styles[line]||={})[col]={...(marks[i]?{linethrough:true}:{}),...(bold[i]?{fontWeight:BOLD_WEIGHT}:{})};
  col++;
 });
 return styles;
}
// 按字重分段量度與繪製；canvas 一次只能用一種字體。
export function richRuns(chars,flags,bold){
 const runs=[];
 chars.forEach((char,i)=>{const last=runs.at(-1);if(last&&last.bold===!!bold[i]&&last.strike===!!flags[i])last.text+=char;else runs.push({text:char,bold:!!bold[i],strike:!!flags[i]});});
 return runs;
}
