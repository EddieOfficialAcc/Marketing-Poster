// PNG pHYs chunk records the chosen physical print resolution without changing pixels.
export async function withDpi(blob,dpi){
 const bytes=new Uint8Array(await blob.arrayBuffer()),chunk=new Uint8Array(21),view=new DataView(chunk.buffer);
 view.setUint32(0,9);chunk.set([112,72,89,115],4);const ppm=Math.round(dpi/0.0254);view.setUint32(8,ppm);view.setUint32(12,ppm);chunk[16]=1;
 let crc=0xffffffff;for(const byte of chunk.slice(4,17)){crc^=byte;for(let j=0;j<8;j++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}view.setUint32(17,(crc^0xffffffff)>>>0);
 // Drop any existing pHYs chunk, then insert the selected resolution after IHDR.
 const pieces=[bytes.slice(0,33),chunk];let pos=33;
 while(pos+12<=bytes.length){const length=new DataView(bytes.buffer,bytes.byteOffset+pos,4).getUint32(0),end=pos+length+12;if(end>bytes.length)throw new Error('PNG 格式不完整');const type=String.fromCharCode(...bytes.slice(pos+4,pos+8));if(type!=='pHYs')pieces.push(bytes.slice(pos,end));pos=end;}
 return new Blob(pieces,{type:'image/png'});
}
