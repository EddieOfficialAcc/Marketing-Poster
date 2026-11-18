import {sizeInfo} from './sizing.js';
const encoder=new TextEncoder();
const bytes=text=>encoder.encode(text);
export function buildPosterPdf(jpeg,widthMm,heightMm,bleedMm=0){
 if(!(jpeg instanceof Uint8Array)||!jpeg.length||![widthMm,heightMm,bleedMm].every(Number.isFinite)||widthMm<=0||heightMm<=0||![0,3].includes(bleedMm))throw new Error('PDF 尺寸無效');
 // JPEG dimensions are read from its SOF segment, independent of browser DPI.
 let iw=0,ih=0;
 for(let i=2;i<jpeg.length-8;){if(jpeg[i]!==255){i++;continue;}const marker=jpeg[i+1],length=(jpeg[i+2]<<8)|jpeg[i+3];if([192,193,194].includes(marker)){ih=(jpeg[i+5]<<8)|jpeg[i+6];iw=(jpeg[i+7]<<8)|jpeg[i+8];break;}if(!length)break;i+=2+length;}
 if(!iw||!ih)throw new Error('PDF 圖片格式無效');
 const pt=72/25.4,trimW=widthMm*pt,trimH=heightMm*pt,b=bleedMm*pt,margin=bleedMm?9*pt:0,W=trimW+margin*2,H=trimH+margin*2;
 const f=n=>n.toFixed(4),box=(x,y,w,h)=>`[${[x,y,x+w,y+h].map(f).join(' ')}]`;
 let content=`q ${f(trimW+2*b)} 0 0 ${f(trimH+2*b)} ${f(margin-b)} ${f(margin-b)} cm /Im0 Do Q\n`;
 if(bleedMm){content+='0 G 0.3 w\n';const gap=b+pt,outer=margin-pt;for(const x of [margin,margin+trimW])for(const y of [margin,margin+trimH]){const sx=x===margin?-1:1,sy=y===margin?-1:1;content+=`${f(x+sx*gap)} ${f(y)} m ${f(x+sx*outer)} ${f(y)} l S\n${f(x)} ${f(y+sy*gap)} m ${f(x)} ${f(y+sy*outer)} l S\n`;}}
 const stream=bytes(content),objects=[
 bytes('<< /Type /Catalog /Pages 2 0 R >>'),bytes('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
 bytes(`<< /Type /Page /Parent 2 0 R /MediaBox ${box(0,0,W,H)} /TrimBox ${box(margin,margin,trimW,trimH)} /BleedBox ${box(margin-b,margin-b,trimW+2*b,trimH+2*b)} /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`),
 [bytes(`<< /Type /XObject /Subtype /Image /Width ${iw} /Height ${ih} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`),jpeg,bytes('\nendstream')],
 [bytes(`<< /Length ${stream.length} >>\nstream\n`),stream,bytes('endstream')],
 ];
 const chunks=[bytes('%PDF-1.4\n')],offsets=[0];let position=chunks[0].length;
 objects.forEach((object,index)=>{offsets.push(position);for(const part of [bytes(`${index+1} 0 obj\n`),...[object].flat(),bytes('\nendobj\n')]){chunks.push(part);position+=part.length;}});
 chunks.push(bytes(`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${position}\n%%EOF\n`));
 return new Blob(chunks,{type:'application/pdf'});
}
export async function posterPdf(png,project,bleedMm=0){
 const size=sizeInfo(project),widthMm=size.width*25.4/size.dpi,heightMm=size.height*25.4/size.dpi;
 const image=await createImageBitmap(png);
 try{
  const pad=Math.round(bleedMm*size.dpi/25.4),canvas=document.createElement('canvas');canvas.width=image.width+2*pad;canvas.height=image.height+2*pad;const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);
  if(pad){ctx.drawImage(image,0,0,image.width,1,pad,0,image.width,pad);ctx.drawImage(image,0,image.height-1,image.width,1,pad,pad+image.height,image.width,pad);ctx.drawImage(image,0,0,1,image.height,0,pad,pad,image.height);ctx.drawImage(image,image.width-1,0,1,image.height,pad+image.width,pad,pad,image.height);for(const x of [0,1])for(const y of [0,1])ctx.drawImage(image,x*(image.width-1),y*(image.height-1),1,1,x*(pad+image.width),y*(pad+image.height),pad,pad);}
  ctx.drawImage(image,pad,pad);const jpg=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.98));if(!jpg)throw new Error('PDF 圖片轉換失敗');return buildPosterPdf(new Uint8Array(await jpg.arrayBuffer()),widthMm,heightMm,bleedMm);
 }finally{image.close();}
}
