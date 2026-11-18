from io import BytesIO
from openpyxl import load_workbook
from fastapi.testclient import TestClient
from backend.app import app
from backend.campaigns import parse_campaign
from backend.campaign_template import HEADERS
from backend.test_support import IsolatedAuthTest, authenticated_client

class CampaignTemplateTests(IsolatedAuthTest):
    def test_template_download_requires_login(self):
        self.assertEqual(TestClient(app).get('/api/campaign-template').status_code,401)

    def test_template_round_trips_existing_importer_without_changes(self):
        client=authenticated_client(app)
        response=client.get('/api/campaign-template')
        self.assertEqual(response.status_code,200)
        self.assertIn('attachment',response.headers['content-disposition'])
        workbook=load_workbook(BytesIO(response.content))
        sheet=workbook['活動商品']
        self.assertEqual([cell.value for cell in sheet[1]], HEADERS)
        self.assertEqual(sheet['C2'].value,'BD-101643')
        self.assertEqual(sheet['C2'].number_format,'@')
        self.assertEqual(sheet.freeze_panes,'A2')
        result=parse_campaign(response.content,'xlsx')
        self.assertEqual(result['errors'],[])
        self.assertEqual(len(result['rows']),1)
        self.assertEqual(result['rows'][0]['sku'],'BD-101643')
        self.assertEqual(result['rows'][0]['price'],'33')
        self.assertEqual(result['rows'][0]['quantity'],2)
