from backend.test_support import authenticated_client, IsolatedAuthTest
import unittest
from unittest.mock import patch
from fastapi import HTTPException
from fastapi.testclient import TestClient
from backend.app import app
from backend.campaigns import parse_campaign, parse_rows

HEADERS = ["活動名稱", "商品名稱", "商品編號", "規格", "優惠總價", "優惠件數", "開始日期", "結束日期", "適用門店"]
ROW = ["會員活動", "秋田米", "00123", "1kg", "33", "2", "2026-11-01", "2026-11-30", "門店 A"]


class CampaignTests(IsolatedAuthTest):
    def setUp(self):
        super().setUp()
        lookup = patch('backend.product_library.lookup_items', return_value={'1': {'code':'00123','name':'秋田米','barcodes':[]}})
        photos = patch('backend.product_library.photo_index', return_value={})
        lookup.start(); photos.start()
        self.addCleanup(lookup.stop); self.addCleanup(photos.stop)

    def test_empty_import_returns_422(self):
        response = authenticated_client(app).post("/api/import-campaign?kind=xlsx", content=b"")
        self.assertEqual(response.status_code, 422)
        self.assertIn("不可為空", response.json()["detail"])

    def test_csv_preserves_leading_zero_sku_and_total_price(self):
        data = (",".join(HEADERS)+"\n"+",".join(ROW)).encode("utf-8-sig")
        result = parse_campaign(data, "csv")
        self.assertEqual(result["errors"], [])
        self.assertEqual(result["rows"][0]["sku"], "00123")
        self.assertEqual(result["rows"][0]["price"], "33")

    def test_formula_bad_money_and_numeric_sku_are_rejected(self):
        for index, value in [(4, "=1+2"), (4, "10.123"), (2, 123), (5, "1.5"), (6, "2026-02-30")]:
            row = ROW.copy(); row[index] = value
            self.assertTrue(parse_rows([HEADERS, row])["errors"])

    def test_different_store_campaigns_cannot_share_one_poster(self):
        row = ROW.copy(); row[-1] = "門店 B"
        self.assertTrue(parse_rows([HEADERS, ROW, row])["errors"])

    def test_unsupported_member_conditions_block_import(self):
        result = parse_rows([HEADERS+["所需積分"], ROW+["200"]])
        self.assertTrue(any("促銷條件" in error for error in result["errors"]))

    def test_overflow_does_not_silently_drop_products(self):
        with self.assertRaises(HTTPException):
            parse_rows([HEADERS]+[ROW]*13)

    def test_import_endpoint_and_invalid_xlsx(self):
        data = (",".join(HEADERS)+"\n"+",".join(ROW)).encode()
        result = authenticated_client(app).post("/api/import-campaign?kind=csv", content=data)
        self.assertEqual(result.status_code, 200)
        self.assertEqual(len(result.json()["rows"]), 1)
        self.assertEqual(authenticated_client(app).post("/api/import-campaign?kind=xlsx", content=b"broken").status_code, 422)


    def test_missing_or_wrong_sheet_dimensions_use_actual_rows_and_columns(self):
        import io, re, zipfile
        from backend.campaign_template import template_bytes
        def rewrite(dimension, extra=''):
            output=io.BytesIO()
            with zipfile.ZipFile(io.BytesIO(template_bytes())) as source, zipfile.ZipFile(output,'w') as target:
                for entry in source.infolist():
                    content=source.read(entry.filename)
                    if entry.filename=='xl/worksheets/sheet1.xml':
                        content=re.sub(rb'<dimension[^>]*/>',dimension,content)
                        content=content.replace(b'</sheetData>',extra.encode()+b'</sheetData>')
                    target.writestr(entry,content)
            return output.getvalue()
        for dimension in [b'',b'<dimension ref="A1:A1"/>',b'<dimension ref="A1:XFD1048576"/>']:
            result=parse_campaign(rewrite(dimension),'xlsx')
            self.assertEqual(result['errors'],[])
            self.assertEqual(result['rows'][0]['sku'],'BD-101643')
        for extra in [''.join(f'<row r="{i}"><c r="A{i}" t="inlineStr"><is><t>overflow</t></is></c></row>' for i in range(20, 221)),
                      '<row r="14"><c r="AO14" t="inlineStr"><is><t>overflow</t></is></c></row>']:
            with self.assertRaises(HTTPException) as error:parse_campaign(rewrite(b'<dimension ref="A1:A1"/>',extra),'xlsx')
            self.assertIn('200 行或 40 欄',error.exception.detail)

    def test_formatting_only_cells_are_ignored_and_error_row_is_preserved(self):
        import io
        from openpyxl import Workbook
        from openpyxl.styles import PatternFill
        workbook = Workbook()
        sheet = workbook.active
        sheet.append(HEADERS)
        sheet.append(ROW)
        for coordinate in ["A300", "AX1", "AX2", "AX300"]:
            sheet[coordinate].fill = PatternFill("solid", fgColor="FF0000")
        output = io.BytesIO()
        workbook.save(output)
        response = authenticated_client(app).post("/api/import-campaign?kind=xlsx", content=output.getvalue())
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["errors"], [])
        self.assertEqual(len(response.json()["rows"]), 1)
        bad = ROW.copy()
        bad[6] = "bad-date"
        for column, value in enumerate(bad, 1):
            sheet.cell(350, column, value)
        output = io.BytesIO()
        workbook.save(output)
        result = parse_campaign(output.getvalue(), "xlsx")
        self.assertIn("第 350 行", result["errors"][0])

    def test_scan_limit_and_real_column_content_are_not_ignored(self):
        import io
        from openpyxl import Workbook
        from openpyxl.styles import PatternFill
        workbook = Workbook()
        sheet = workbook.active
        sheet.append(HEADERS)
        sheet.append(ROW)
        sheet["A10001"].fill = PatternFill("solid", fgColor="FF0000")
        output = io.BytesIO()
        workbook.save(output)
        with self.assertRaises(HTTPException) as error:
            parse_campaign(output.getvalue(), "xlsx")
        self.assertIn("10,000", error.exception.detail)
        del sheet["A10001"]
        sheet["AX2"] = 0
        output = io.BytesIO()
        workbook.save(output)
        with self.assertRaises(HTTPException) as error:
            parse_campaign(output.getvalue(), "xlsx")
        self.assertIn("40 欄", error.exception.detail)

    def test_invalid_dates_are_reported_in_chinese(self):
        row=ROW.copy();row[6]='2026/11/01'
        result=parse_rows([HEADERS,row])
        self.assertIn('日期須為有效的 YYYY-MM-DD',result['errors'][0])
        self.assertNotIn('time data',result['errors'][0])


if __name__ == "__main__":
    unittest.main()
