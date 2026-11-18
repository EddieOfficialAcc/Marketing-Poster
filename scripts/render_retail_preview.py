"""Offline Pillow preview of shared layout primitives (not a browser screenshot)."""
from pathlib import Path
import json,subprocess
from PIL import Image,ImageDraw,ImageFont
root=Path(__file__).resolve().parents[1]
fonts={'sans':{'normal':'/System/Library/Fonts/STHeiti Light.ttc','bold':'/System/Library/Fonts/STHeiti Medium.ttc'},'price':{'normal':'/System/Library/Fonts/Supplemental/Arial.ttf','bold':'/System/Library/Fonts/Supplemental/Arial Bold.ttf'}}
chars=set(''.join(p.read_text() for p in [root/'assets/retail/demo.json',root/'scripts/retail-preview.mjs']))|set('0123456789.$/件平均新待填– —')
folder=root/'tmp/pdfs';folder.mkdir(parents=True,exist_ok=True)
metrics={family:{weight:{c:ImageFont.truetype(path,1000).getlength(c) for c in chars} for weight,path in weights.items()} for family,weights in fonts.items()}
(folder/'font-metrics.json').write_text(json.dumps(metrics,ensure_ascii=False))
subprocess.run(['node','scripts/retail-preview.mjs'],cwd=root,check=True)
scene=json.loads((folder/'retail-scene.json').read_text());scale=2
im=Image.new('RGB',(scene['size']['width'],scene['size']['height']),'white');draw=ImageDraw.Draw(im)
def rect(x,y,w,h,color):draw.rectangle((x*scale,y*scale,(x+w)*scale,(y+h)*scale),fill=color)
def image(src,x,y,w,h):
 asset=Image.open(root/src).convert('RGBA').resize((max(1,round(w*scale)),max(1,round(h*scale))),Image.Resampling.LANCZOS);im.paste(asset,(round(x*scale),round(y*scale)),asset)
def text(t,x,y,size,color,weight=400,family='sans',strike=False):
 f=ImageFont.truetype(fonts['price' if 'Arial' in family else 'sans']['bold' if weight>=700 else 'normal'],max(1,round(size*scale)))
 draw.text((x*scale,y*scale),t,font=f,fill=color,anchor='lt')
 if strike:draw.line((x*scale,(y+size*.55)*scale,x*scale+draw.textlength(t,font=f),(y+size*.55)*scale),fill=color,width=max(1,round(size*.05*scale)))
for p in scene['template']:
 if p['type']=='rect':rect(p['x'],p['y'],p['w'],p['h'],p['color'])
 elif p['type']=='image':image(p['src'],p['x'],p['y'],p['w'],p['h'])
 else:text(p['value'],p['x'],p['y'],p['font'],p['color'],p['weight'])
for n in scene['nodes']:
 for p in n['images']:image(p['path'],n['x']+p['x'],n['y']+p['y'],p['w'],p['h'])
 for p in n['primitives']:
  if p['type']=='rect':rect(n['x']+p['x'],n['y']+p['y'],p['w'],p['h'],p['color'])
  else:text(p['text'],n['x']+p['x'],n['y']+p['y'],p['size'],p['color'],p['weight'],p['family'],p.get('strike',False))
out=root/'output/evaluation';out.mkdir(parents=True,exist_ok=True);im.save(out/'retail-preview.png');im.save(folder/'retail-preview.jpg',quality=98)
print(out/'retail-preview.png')
