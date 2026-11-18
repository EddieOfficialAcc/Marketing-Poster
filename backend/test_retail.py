import unittest
from backend import test_archives as archive_tests
payload=archive_tests.payload
image_data=archive_tests.image_data


class RetailArchiveTests(unittest.TestCase):
    setUp=archive_tests.ArchiveTests.setUp
    tearDown=archive_tests.ArchiveTests.tearDown
    save=archive_tests.ArchiveTests.save
    def test_retail_confirmation_restores_prices_regions_and_brand_assets(self):
        data = payload()
        project = data['project']
        project['template'] = 'retail'
        project['retailHeader'] = image_data()[0]
        project['retailLogo'] = image_data(color='blue')[0]
        project['exportMode'] = 'print'
        project['nodes'][0].update(cardStyle='retail', originalPrice='29.9', originalPriceMax='33', averageRounding='integer', originalStrike=True, regions={'price': {'x': .5, 'y': .7, 'w': .5, 'h': .3}})
        data.update(confirmed=True, confirmedBy='admin', poster=image_data((1800,2560))[0])
        receipt = self.save(data)
        restored = self.client.get(f"/api/archives/{receipt['id']}/project").json()['project']
        self.assertEqual(restored['nodes'], project['nodes'])
        self.assertEqual(restored['retailHeader'], project['retailHeader'])
        self.assertEqual(restored['retailLogo'], project['retailLogo'])
        self.assertEqual(restored['exportMode'], 'print')

    def test_invalid_retail_fields_rejected(self):
        for change in ({'originalPrice':'20','originalPriceMax':'10'}, {'averageRounding':'floor'}, {'regions':{'price':{'x':.8,'y':0,'w':.5,'h':1}}}):
            data = payload()
            data['project']['nodes'][0].update(change)
            self.assertEqual(self.client.post('/api/archives', json=data).status_code,422)

class RetailImportTests(unittest.TestCase):
    def test_optional_retail_fields_and_invalid_range(self):
        from backend.campaigns import parse_rows
        from backend.test_campaigns import HEADERS, ROW
        headers=HEADERS+['原價','原價上限','原價刪除線','平均價取整','促銷角標']
        result=parse_rows([headers,ROW+['29.9','33','是','整元','新']])
        self.assertFalse(result['errors'])
        self.assertEqual(result['rows'][0]['averageRounding'],'integer')
        self.assertTrue(result['rows'][0]['originalStrike'])
        self.assertTrue(parse_rows([headers,ROW+['33','29.9','是','整元','新']])['errors'])
