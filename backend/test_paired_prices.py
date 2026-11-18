import unittest
from backend.campaigns import parse_rows

class PairedPricesTests(unittest.TestCase):
    def test_individual_prices_keep_both_product_codes(self):
        headers=['活動名稱','code','code2','優惠總價','price2','優惠件數','開始日期','結束日期','適用門店','原價','originalPrice2']
        row=['Test','A','B',99,109,1,'2026-11-10','2026-11-19','Demo',119,129]
        result=parse_rows([headers,row])
        self.assertFalse(result['errors'])
        self.assertEqual(result['rows'][0]['price2'],'109')
        self.assertEqual(result['rows'][0]['originalPrice2'],'129')
        for index,value in [(2,''),(4,-1),(4,'109.999'),(5,2)]:
            bad=row.copy();bad[index]=value
            self.assertTrue(parse_rows([headers,bad])['errors'])

    def test_four_codes_share_one_offer(self):
        headers=['活動名稱','code','code2','code3','code4','優惠總價','優惠件數','開始日期','結束日期','適用門店']
        row=['Test','A','B','C','D',33,2,'2026-11-10','2026-11-19','Demo']
        result=parse_rows([headers,row])
        self.assertFalse(result['errors'])
        self.assertEqual(result['rows'][0]['code4'],'D')
        self.assertEqual(result['rows'][0]['quantity'],2)
        self.assertTrue(parse_rows([headers+['price2'],row+[10]])['errors'])

    def test_archive_keeps_and_validates_price_to_image_mapping(self):
        from copy import deepcopy
        from fastapi import HTTPException
        from backend.archives import check_project
        from backend.test_archives import payload
        project=payload()['project']
        project['products'].append({'id':'other','name':'Other'})
        node=project['nodes'][0]
        node.update(price='99',price2='109',originalPrice='119',originalPrice2='129',quantity=1,
                    price2ProductId='other',pictures=[{'productId':'rice'},{'productId':'other'}])
        check_project(project,True)
        for key,value in [('quantity',2),('price2','-1'),('price2ProductId','missing'),('pictures',None),('originalPrice2','bad')]:
            invalid=deepcopy(project);invalid['nodes'][0][key]=value
            with self.assertRaises(HTTPException):check_project(invalid,True)
