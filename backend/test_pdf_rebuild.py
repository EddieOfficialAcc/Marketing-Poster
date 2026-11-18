import io
import subprocess
from unittest.mock import patch
import unittest
import fitz
from PIL import Image
from fastapi import HTTPException
from backend.pdf_rebuild import group_products,parse_offer,ocr_lines,reconstruct_pdf,analyze_text_image
from backend.poster_pdf import process_rebuild
from backend.app import app
from backend.test_support import IsolatedAuthTest,authenticated_client

def rows(*text):return [{'text':t,'confidence':.9,'box':[0,0,1,1]} for t in text]

class PdfRebuildTests(IsolatedAuthTest):
 def test_bundle_total_is_not_confused_with_rounded_unit_price(self):
  r=parse_offer(rows('DAHFA','120克','$23'),rows('$20','平均每件','$39.9/2件'))
  self.assertEqual((r['name'],r['spec'],r['price'],r['quantity'],r['originalPrice']),('DAHFA','120克','39.9',2,'23'))
  self.assertEqual(parse_offer([],rows('$20','平均每件'))['price'],'')
  self.assertEqual(parse_offer([],rows('$62.9'))['price'],'62.9')
  self.assertEqual(parse_offer([],rows('$0'))['price'],'')
 def test_touching_neighbor_products_do_not_merge_but_overlapping_packshots_do(self):
  items=[{'rect':fitz.Rect(466,736,687,1107)},{'rect':fitz.Rect(567,736,775,1095)}, {'rect':fitz.Rect(774,831,972,1032)},{'rect':fitz.Rect(951,874,1150,1032)}]
  groups=group_products(items,1190,1684)
  self.assertEqual([len(g['items']) for g in groups],[2,2])
 def test_native_pdf_reconstructs_without_ocr_and_preserves_alpha_image(self):
  data=io.BytesIO();Image.new('RGBA',(200,300),(240,80,10,180)).save(data,'PNG')
  doc=fitz.open();p=doc.new_page(width=600,height=840);p.insert_image(fitz.Rect(100,200,300,500),stream=data.getvalue())
  p.insert_text((40,520),'Rice',fontsize=12);p.insert_text((40,537),'1kg',fontsize=12);p.insert_text((40,554),'$40',fontsize=12);p.insert_text((360,535),'$35',fontsize=22)
  def no_ocr(image):raise AssertionError('native text should not need OCR')
  result=reconstruct_pdf(doc.tobytes(),recognize=no_ocr)
  self.assertEqual(len(result['products']),1);r=result['products'][0]
  self.assertEqual((r['name'],r['spec'],r['price']),('Rice','1kg','35'))
  import base64
  asset=Image.open(io.BytesIO(base64.b64decode(r['images'][0]['imageUrl'].split(',')[1])))
  self.assertEqual(asset.mode,'RGBA');self.assertEqual(len(result['regions']),1)
 def test_ocr_tsv_and_missing_engine_error(self):
  tsv='level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n5\t1\t1\t1\t1\t1\t10\t20\t30\t10\t85\tRice\n'
  with patch('backend.pdf_rebuild.subprocess.run',return_value=subprocess.CompletedProcess([],0,tsv.encode(),b'')):
   r=ocr_lines(Image.new('RGB',(100,100)));self.assertEqual(r[0]['text'],'Rice');self.assertEqual(r[0]['confidence'],.85)
  with patch('backend.pdf_rebuild.subprocess.run',side_effect=FileNotFoundError()):
   with self.assertRaises(HTTPException) as e:ocr_lines(Image.new('RGB',(10,10)))
   self.assertEqual(e.exception.status_code,503)
 def test_text_analysis_estimates_alignment_strike_and_badge(self):
  from PIL import ImageDraw
  im=Image.new('RGB',(300,160),(255,245,223));d=ImageDraw.Draw(im)
  for y in (20,60,100):
   for x in range(20,140,24):d.rectangle((x,y,x+18,y+24),outline=(40,40,40),width=3)
  d.line((92,112,140,112),fill=(40,40,40),width=3)
  box=lambda x0,y0,x1,y1:[x0/300,y0/160,(x1-x0)/300,(y1-y0)/160]
  rows=[{'text':'甲乙丙丁戊','confidence':.9,'box':box(20,20,135,45),'words':[{'text':'甲乙丙丁戊','box':box(20,20,135,45)}]},
        {'text':'己庚辛壬癸','confidence':.9,'box':box(20,60,135,85),'words':[]},
        {'text':'90克 $14','confidence':.9,'box':box(20,100,141,125),'words':[{'text':'90克','box':box(20,100,87,125)},{'text':'$14','box':box(92,100,141,125)}]}]
  block=lambda result:lambda image,timeout=15,psm='6':result if psm=='6' else []  # no extra line-by-line readings
  with patch('backend.pdf_rebuild.ocr_lines',side_effect=block(rows)):r=analyze_text_image(im)
  self.assertEqual(r['text'],'甲乙丙丁戊\n己庚辛壬癸\n90克 ~~$14~~');self.assertEqual((r['align'],r['color'],r['mixed'],r['badge']),('left','#282828',False,False))
  self.assertAlmostEqual(r['fontSizeRatio']*160,115/4.9,delta=.5);self.assertAlmostEqual(r['lineHeight'],40/(115/4.9),places=2);self.assertIn(r['weight'],(300,400,500,600,700))
  d.rectangle((160,20,290,140),fill=(220,50,50));d.rectangle((190,60,260,90),outline=(255,255,255),width=4)
  with patch('backend.pdf_rebuild.ocr_lines',side_effect=block([{'text':'$36','confidence':.9,'box':box(190,60,261,91),'words':[]}])):r=analyze_text_image(im)
  self.assertEqual((r['color'],r['badge'],r['mixed']),('#ffffff',True,False))
  from backend.pdf_rebuild import _price_offer
  self.assertEqual(_price_offer([{'text':'$ 平均 18'},{'text':'每件'},{'text':'$36/2件'}]),{'price':'36','quantity':2})
  self.assertIsNone(_price_offer([{'text':'平均每件 18'}]));self.assertIsNone(_price_offer([{'text':'樂事'}]))
  badge=Image.new('RGB',(60,40),(220,50,50));ImageDraw.Draw(badge).rectangle((10,10,50,30),fill=(255,255,255))
  with patch('backend.pdf_rebuild.ocr_lines',return_value=[{'text':'s36/2f','confidence':.5,'box':[0,0,1,1],'words':[]}]) as ocr:
   self.assertEqual(_price_offer([{'text':'#18'}],badge),{'price':'36','quantity':2});self.assertTrue(ocr.called)
 def test_ocr_spacing_follows_printed_gaps(self):
  from backend.pdf_rebuild import join_words,tidy_ocr_text
  w=lambda text,x,width:{'text':text,'x':x,'w':width}
  # CJK glyphs 30px wide: a 4px gap is letter spacing, a 12px gap is a printed space.
  self.assertEqual(join_words([w('即',0,30),w('食',32,30),w('裝',64,30),w('/',106,8)],34),'即食裝 /')
  self.assertEqual(join_words([w('味',0,30),w('/',33,8)],34),'味/')
  self.assertEqual(join_words([w('飯',0,30),w('4',40,15),w('件',58,30)],34),'飯4件')
  self.assertEqual(join_words([w('90',0,30),w('克',32,30),w('$14',75,40)],34),'90克 $14')
  self.assertEqual(join_words([w('Yuka',0,60),w('Lay',72,40)],34),'Yuka Lay')
  self.assertEqual(tidy_ocr_text('$29.9 – 33'),'$29.9-33')
 def test_bad_pdf_and_rebuild_endpoint(self):
  with self.assertRaises(HTTPException):process_rebuild(b'bad',1)
  with patch('backend.poster_pdf.process_rebuild',return_value={'version':1,'products':[]}) as build:
   response=authenticated_client(app).post('/api/poster-pdf/rebuild?page=2',content=b'%PDF')
   self.assertEqual(response.status_code,200);build.assert_called_once_with(b'%PDF',2)
