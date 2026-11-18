import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from fastapi import HTTPException
from backend.campaigns import parse_rows
from backend import product_library as library


class ProductLibraryTests(unittest.TestCase):
    def sheet(self, productid=4837):
        return [['活動名稱','productid','優惠總價','優惠件數','開始日期','結束日期','適用門店'],
                ['十一月', productid, 33, 2, '2026-11-01','2026-11-30','全線']]

    def test_numeric_id_without_name(self):
        result = parse_rows(self.sheet())
        self.assertEqual(result['errors'], [])
        self.assertEqual(result['rows'][0]['productid'], '4837')
        self.assertEqual(result['rows'][0]['name'], '')

    def test_invalid_ids_are_rejected(self):
        for value in ('1 OR 1=1', 'nan', 1.5, -1):
            self.assertTrue(parse_rows(self.sheet(value))['errors'])

    def test_match_boundaries_and_id_folder(self):
        for name in ('4837.jpg','BD-101643_正面.jpg','BD-101643/side.png'):
            self.assertTrue(library.matches(name, ['4837','BD-101643']))
        for name in ('14837.jpg','BD-1016430.jpg','BD-101643-2.jpg','14837/side.jpg'):
            self.assertFalse(library.matches(name, ['4837','BD-101643']))

    def test_barcode_photo_angle_suffix(self):
        self.assertTrue(library.matches('4891118024431-1.jpg', ['4891118024431']))
        self.assertFalse(library.matches('48911180244310-1.jpg', ['4891118024431']))
        self.assertFalse(library.matches('BD-101643-2.jpg', ['BD-101643']))

    def test_enrichment_retains_offer_and_all_candidates(self):
        photos = {'a': ('街貨', Path('/photos'), Path('/photos/BD-101643.jpg'), 'BD-101643.jpg'),
                  'b': ('倉貨', Path('/photos'), Path('/photos/4837.png'), '4837.png')}
        with patch.object(library, 'lookup_items', return_value={'4837': {'name':'蒟蒻果凍','code':'BD-101643','barcodes':['012345']}}), patch.object(library, 'photo_index', return_value=photos):
            row = library.enrich_campaign(parse_rows(self.sheet()))['rows'][0]
        self.assertEqual(row['sku'], 'BD-101643')
        self.assertEqual(row['name'], '蒟蒻果凍')
        self.assertEqual(row['price'], '33')
        self.assertEqual(len(row['libraryProducts']), 2)
        self.assertEqual(row['libraryProducts'][0]['externalId'], '4837')

    def test_missing_item_blocks_import(self):
        with patch.object(library, 'lookup_items', return_value={}), patch.object(library, 'photo_index', return_value={}):
            self.assertIn('4837', library.enrich_campaign(parse_rows(self.sheet()))['errors'][0])

    def test_pos_outage_falls_back_to_local_matching(self):
        from fastapi import HTTPException
        data={'rows':[{'name':'有名稱','code':'BD-1','row':2},{'name':'','code':'BD-2','row':3}],'errors':[],'warnings':[]}
        with patch.object(library, 'lookup_items', side_effect=HTTPException(503, 'POS 查詢失敗')):
            result=library.enrich_campaign(data)
        self.assertIn('改用本機素材庫', result['warnings'][0])
        self.assertEqual(result['errors'], ['第 3 行：POS 無法連線，請在 Excel 補填商品名稱'])
        self.assertNotIn('libraryProducts', result['rows'][0])

    def test_scan_does_not_expose_symlink_outside_root(self):
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as other:
            Path(other, 'secret.jpg').write_bytes(b'secret')
            Path(root, '4837.jpg').symlink_to(Path(other, 'secret.jpg'))
            with patch.dict(os.environ, {'PRODUCT_PHOTO_STREET_ROOT':root,'PRODUCT_PHOTO_WAREHOUSE_ROOT':''}), patch.object(library, '_cache', None):
                self.assertEqual(library.photo_index(), {})

    def test_legacy_import_needs_no_sql(self):
        data={'rows':[{'name':'舊商品'}], 'errors':[], 'warnings':[]}
        with patch.object(library, 'lookup_items', side_effect=AssertionError('must not query')):
            self.assertIs(library.enrich_campaign(data), data)

    def test_directory_index_avoids_per_photo_resolve_and_survives_restart(self):
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as data:
            for i in range(100):
                Path(root, f'{i}.jpg').write_bytes(b'photo')
            config={'PRODUCT_PHOTO_STREET_ROOT':root,'PRODUCT_PHOTO_WAREHOUSE_ROOT':'','POSTER_DATA_DIR':data}
            original=Path.resolve
            calls=[]
            def resolve(path, *args, **kwargs):
                calls.append(path)
                return original(path, *args, **kwargs)
            with patch.dict(os.environ,config), patch.object(library,'_cache',None), patch.object(Path,'resolve',resolve):
                first=library.photo_index()
                self.assertEqual(len(first),100)
                self.assertLess(len(calls),5)
            with patch.dict(os.environ,config), patch.object(library,'_cache',None), patch.object(os,'scandir',side_effect=AssertionError('must use persisted index')):
                self.assertEqual(library.photo_index(),first)

    def test_corrupted_disk_index_rebuilds(self):
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as data:
            Path(root,'photo.png').write_bytes(b'photo')
            Path(data,'product-photo-index.json').write_text('broken')
            with patch.dict(os.environ,{'PRODUCT_PHOTO_STREET_ROOT':root,'PRODUCT_PHOTO_WAREHOUSE_ROOT':'','POSTER_DATA_DIR':data}), patch.object(library,'_cache',None):
                self.assertEqual(len(library.photo_index()),1)

    def test_code_or_chinese_header_without_product_name(self):
        for header in ('code', 'Code', '商品編號', '商品编号'):
            sheet=self.sheet()
            sheet[0][1]=header;sheet[1][1]='BD-101643'
            result=parse_rows(sheet)
            self.assertEqual(result['errors'],[])
            self.assertEqual(result['rows'][0]['code'],'BD-101643')
            self.assertNotIn('productid',result['rows'][0])

    def test_code_resolves_id_and_matches_barcode_photo(self):
        sheet=self.sheet();sheet[0][1]='code';sheet[1][1]='bd-101643'
        photos={'photo':('街貨',Path('/photos'),Path('/photos/4571157254340-1.jpg'),'4571157254340-1.jpg')}
        with patch.object(library,'lookup_items',return_value={'4837':{'code':'BD-101643','name':'蒟蒻果凍者喱-提子','barcodes':['4571157254340']}}) as lookup, patch.object(library,'photo_index',return_value=photos):
            result=library.enrich_campaign(parse_rows(sheet))
        lookup.assert_called_once_with([],['bd-101643'])
        row=result['rows'][0]
        self.assertEqual(result['errors'],[])
        self.assertEqual(row['productid'],'4837')
        self.assertEqual(row['sku'],'BD-101643')
        self.assertEqual(row['name'],'蒟蒻果凍者喱-提子')
        self.assertEqual(len(row['libraryProducts']),1)
        self.assertEqual(row['price'],'33')

    def test_unknown_or_duplicate_code_is_not_auto_selected(self):
        for items in ({}, {'1':{'code':'BD-101643','name':'A','barcodes':[]},'2':{'code':'BD-101643','name':'B','barcodes':[]}}):
            sheet=self.sheet();sheet[0][1]='code';sheet[1][1]='BD-101643'
            with patch.object(library,'lookup_items',return_value=items), patch.object(library,'photo_index',return_value={}):
                result=library.enrich_campaign(parse_rows(sheet))
            self.assertTrue(result['errors'])
            self.assertEqual(result['rows'][0]['libraryProducts'],[])

    def test_pair_codes_share_row_offer_but_resolve_separate_photos(self):
        sheet=self.sheet();sheet[0][1]='code';sheet[1][1]='BD-101643'
        sheet[0].append('code2');sheet[1].append('HD-236187')
        items={'4837':{'code':'BD-101643','name':'果凍','barcodes':[]},'19542':{'code':'HD-236187','name':'奶粉','barcodes':[]}}
        photos={str(i):(label,Path('/photos'),Path('/photos')/name,name) for i,(label,name) in enumerate([('街貨','BD-101643.jpg'),('倉貨','HD-236187.jpg')])}
        with patch.object(library,'lookup_items',return_value=items) as lookup,patch.object(library,'photo_index',return_value=photos):
            result=library.enrich_campaign(parse_rows(sheet))
        self.assertEqual(result['errors'],[])
        row=result['rows'][0]
        self.assertEqual(len(result['rows']),1)
        self.assertEqual(row['name'],'果凍／奶粉')
        self.assertEqual(row['price'],'33');self.assertEqual(row['quantity'],2)
        self.assertEqual(row['productid'],'4837');self.assertEqual(row['companion']['productid'],'19542')
        self.assertEqual(len(row['libraryProducts']),1);self.assertEqual(len(row['companion']['libraryProducts']),1)
        lookup.assert_called_once_with([],['BD-101643','HD-236187'])

class IdentifierIndexTests(unittest.TestCase):
    def test_index_matches_legacy_rules_and_rebuilds_for_new_snapshot(self):
        from backend.product_library import matching_photos, matches, identifier_index
        from pathlib import Path
        paths=['BD-101643.jpg','BD-101643_extra.png','BD-1016430.jpg','4891118024431-1.jpg','4891118024431-123.jpg','4837/front.png','other/4837.jpg','BD_101643.jpg','name BD.101643.png']
        entries={str(i):('街貨',Path('/tmp'),Path(p),p) for i,p in enumerate(paths)}
        for keys in [['BD-101643'],['4837'],['4891118024431'],['BD.101643'],['BD_101643']]:
            expected={t for t,e in entries.items() if matches(e[3],keys)}
            self.assertEqual({t for t,e in matching_photos(entries,keys)},expected)
        self.assertIs(identifier_index(entries),identifier_index(entries))
        refreshed={**entries,'new':('街貨',Path('/tmp'),Path('NEW.jpg'),'NEW.jpg')}
        self.assertEqual(len(matching_photos(refreshed,['NEW'])),1)
