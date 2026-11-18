import unittest
from fastapi import HTTPException
from backend.archives import check_project
from backend.test_archives import payload

class PosterEditValidationTests(unittest.TestCase):
 def test_image_only_can_have_no_price_but_full_product_cannot(self):
  p=payload()['project'];n=p['nodes'][0];n['imageOnly']=True;n['price']=''
  check_project(p,True)
  n['imageOnly']=False
  with self.assertRaises(HTTPException):check_project(p,True)
 def test_existing_poster_can_export_text_edits_without_creating_a_priced_product(self):
  p=payload()['project'];p['template']='custom';p['background']=p['products'][0]['imageUrl'];p['posterReuse']={'masks':[]}
  p['nodes']=[{'id':'text','type':'text','text':'新日期','x':40,'y':200,'w':240,'h':50}]
  check_project(p,True)
  p['nodes']=[]
  with self.assertRaises(HTTPException):check_project(p,True)
