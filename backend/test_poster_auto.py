import base64
import io
import json
import os
from unittest.mock import patch

import numpy as np
from PIL import Image, ImageDraw
from fastapi import HTTPException

from backend import vision_llm
from backend.poster_auto import name_block, price_box, check_slots, review_poster, analyze_poster, blank_layout, blank_analysis, analyze_image, badge_grid, single_product, image_poster, first_row_photo_bounds
from backend.app import app
from backend.test_support import IsolatedAuthTest, authenticated_client

PAPER = (255, 247, 228)
RED = (237, 28, 36)
DARK = (35, 31, 32)
AZURE = {'AZURE_OPENAI_ENDPOINT': 'https://example.openai.azure.com/', 'AZURE_OPENAI_API_KEY': 'k', 'AZURE_OPENAI_DEPLOYMENT': 'gpt-6.1-sol'}


def text_box():
    """A 300×200 text box: product photo edge at the top, three dark lines, a red badge on the
    right, and a red 「新」 tag below the text after a large gap."""
    image = Image.new('RGB', (300, 200), PAPER)
    d = ImageDraw.Draw(image)
    d.rectangle((0, 0, 140, 6), fill=(30, 90, 160))             # photo bottom edge
    for y in (30, 52, 74):
        d.rectangle((10, y, 120, y+14), fill=DARK)               # text lines, 8px apart
    d.rectangle((190, 26, 290, 110), fill=RED)                   # price badge
    d.rectangle((60, 150, 100, 190), fill=RED)                   # 「新」 tag at 20–33% width
    return image


class PosterAutoTests(IsolatedAuthTest):
    def test_first_row_covers_tall_photo_without_covering_header(self):
        image = Image.new('RGB', (300, 500), PAPER)
        draw = ImageDraw.Draw(image)
        draw.rectangle((0, 0, 299, 35), fill=(30, 90, 160))
        draw.rectangle((25, 55, 90, 75), fill=RED)
        draw.rectangle((110, 90, 180, 275), fill=DARK)
        top, patches = first_row_photo_bounds(image, 0, 300, 300, 180, 180, PAPER)
        self.assertLess(top, 95)
        self.assertTrue(patches)
        self.assertTrue(any(x <= 145 <= x+w and y <= 100 <= y+h for x,y,w,h in patches))
        self.assertTrue(all(y > 75 for x,y,w,h in patches))

    def test_name_block_spans_the_text_lines_only(self):
        left, top, right, bottom = name_block(np.asarray(text_box()), anchor=32)
        self.assertEqual(top, 30)
        self.assertTrue(88 <= bottom <= 92, bottom)                # stops at the gap before the tag
        self.assertTrue(180 <= right <= 190, right)                 # stops where the badge begins

    def test_price_box_skips_stray_red_pixels_above_the_badge(self):
        image = text_box()
        ImageDraw.Draw(image).rectangle((200, 12, 203, 13), fill=RED)   # packaging speck
        box = price_box(image, (0, 30, 300, 170), 1, 130, 30, 14)
        self.assertEqual([round(v) for v in box], [190, 26, 101, 85])

    def test_ai_slot_check_keeps_only_ids_and_flags(self):
        reply = {'slots': [{'id': 1, 'status': 'product', 'printed_name': '大發'}, {'id': '2', 'status': 'not_product', 'note': '人物照片'},
                           {'id': 'x'}, {'id': 3, 'status': 'weird'}], 'uncovered_products': 2}
        slots = [{'id': i, 'box': [10*i, 10, 50, 50]} for i in (1, 2, 3)]
        with patch.dict(os.environ, AZURE), patch.object(vision_llm, 'ask_json', return_value=reply) as ask:
            result = check_slots(Image.new('RGB', (400, 200), PAPER), slots, 1)
        self.assertEqual(result['slots'][2]['status'], 'not_product')
        self.assertEqual(result['slots'][3]['status'], 'product')    # unknown status falls back to product
        self.assertEqual(result['uncovered'], 2)
        self.assertEqual(result['deployment'], 'gpt-6.1-sol')
        self.assertEqual(ask.call_args[0][1][0]['image_url']['detail'], 'high')

    def test_analysis_without_ai_and_with_failing_ai(self):
        background = io.BytesIO()
        Image.new('RGB', (400, 560), PAPER).save(background, 'PNG')
        rebuilt = {'background': 'data:image/png;base64,'+base64.b64encode(background.getvalue()).decode(), 'width': 400, 'height': 560,
                   'pageWidth': 400, 'pageHeight': 560, 'regions': [{'box': [0, 0, .5, .5], 'color': '#fff7e4'}],
                   'products': [{'box': [0, 0, 200, 280], 'imageBox': [0, 0, 200, 200], 'textBox': [0, 200, 200, 80]}]}
        with patch('backend.poster_auto.reconstruct_pdf', return_value=rebuilt) as rebuild, patch.dict(os.environ, {'AZURE_OPENAI_ENDPOINT': ''}):
            result = analyze_poster(b'%PDF-1.4', 1)
        self.assertEqual(rebuild.call_args[1]['recognize'](None), [])  # old text OCR is skipped
        self.assertEqual(result['ai'], {'used': False, 'available': False})
        self.assertEqual(len(result['slots']), 1)
        self.assertIn('error', result['slots'][0]['nameStyle'])         # blank text box is reported, not fatal
        with patch('backend.poster_auto.reconstruct_pdf', return_value=rebuilt), patch.dict(os.environ, AZURE), \
             patch.object(vision_llm, 'ask_json', side_effect=HTTPException(502, 'AI 視覺模型呼叫失敗：timeout')):
            result = analyze_poster(b'%PDF-1.4', 1)
        self.assertFalse(result['ai']['used'])
        self.assertIn('AI 檢查未完成', result['warnings'][0])

    def test_review_returns_only_known_cells(self):
        image = io.BytesIO()
        Image.new('RGB', (300, 400), PAPER).save(image, 'JPEG')
        payload = {'image': 'data:image/jpeg;base64,'+base64.b64encode(image.getvalue()).decode(),
                   'slots': [{'id': 1, 'box': [0, 0, .5, .5], 'expected': {'name': '樂事', 'price': '$18'}}]}
        reply = {'slots': [{'id': 1, 'ok': True, 'issues': ['價格與預期不符']}, {'id': 9, 'ok': False, 'issues': ['x']}], 'general': ['右下角有舊價格']}
        with patch.dict(os.environ, AZURE), patch.object(vision_llm, 'ask_json', return_value=reply) as ask:
            result = review_poster(payload)
        self.assertEqual(result['slots'], [{'id': 1, 'ok': False, 'issues': ['價格與預期不符']}])  # an issue overrides ok
        self.assertEqual(result['general'], ['右下角有舊價格'])
        self.assertIn('"price": "$18"', ask.call_args[0][0])
        with patch.dict(os.environ, {'AZURE_OPENAI_ENDPOINT': ''}), self.assertRaises(HTTPException) as error:
            review_poster(payload)
        self.assertEqual(error.exception.status_code, 503)
        with patch.dict(os.environ, AZURE), self.assertRaises(HTTPException):
            review_poster({'image': 'http://example.com/a.png', 'slots': []})

    def test_model_json_is_extracted_and_repaired(self):
        self.assertEqual(vision_llm.parse_json('結果如下：\n```json\n{"slots":[{"id":1}\n{"id":2}],}\n```'), {'slots': [{'id': 1}, {'id': 2}]})
        with self.assertRaises(ValueError):
            vision_llm.parse_json('no json')

    def test_endpoints_require_login_and_report_status(self):
        from fastapi.testclient import TestClient
        self.assertEqual(TestClient(app).get('/api/poster-auto/status').status_code, 401)
        with patch.dict(os.environ, AZURE):
            body = authenticated_client(app).get('/api/poster-auto/status').json()
        self.assertEqual(body, {'available': True, 'deployment': 'gpt-6.1-sol'})
        response = authenticated_client(app).post('/api/poster-auto/review', content=b'not json')
        self.assertEqual(response.status_code, 422)

    def test_blank_background_boxes_panel_or_nothing(self):
        boxes = Image.new('RGB', (800, 1100), (140, 190, 60))                     # green poster with 2×3 white boxes
        d = ImageDraw.Draw(boxes)
        for row in range(2):
            for col in range(3):
                d.rectangle((40+col*250, 250+row*380, 40+col*250+230, 250+row*380+350), fill=(255, 255, 255))
        layout = blank_layout(boxes)
        self.assertEqual((layout['layout'], len(layout['boxes'])), ('cells', 6))
        panel = Image.new('RGB', (800, 1100), (200, 30, 40))                      # red header, cream panel
        ImageDraw.Draw(panel).rectangle((30, 200, 770, 1040), fill=(255, 245, 223))
        layout = blank_layout(panel)
        self.assertEqual(layout['layout'], 'panel')
        x, y, w, h = layout['boxes'][0]
        self.assertTrue(30 <= x < 60 and 200 <= y < 230 and w > 680 and h > 780, layout['boxes'][0])
        busy = Image.new('RGB', (800, 1100), PAPER)                                # products everywhere
        d = ImageDraw.Draw(busy)
        for x in range(0, 800, 90):
            for y in range(0, 1100, 90):
                d.rectangle((x+10, y+10, x+70, y+70), fill=((x*3) % 255, (y*7) % 255, 120))
        self.assertIsNone(blank_layout(busy))

    def test_blank_analysis_orders_boxes_and_picks_readable_colours(self):
        image = Image.new('RGB', (800, 1100), (20, 40, 90))                        # dark poster, 2 rows of 2 boxes
        d = ImageDraw.Draw(image)
        for row in range(2):
            for col in range(2):
                d.rectangle((60+col*360, 200+row*420, 60+col*360+320, 200+row*420+380), fill=(30, 60, 120))
        result = blank_analysis(image, 2, use_ai=False)
        self.assertEqual(result['layout'], 'cells')
        # Reading order, in page units (pixels ÷ 2); detection runs on a reduced copy, so allow ±2.
        for slot, (x, y) in zip(result['slots'], [(30, 100), (210, 100), (30, 310), (210, 310)]):
            self.assertTrue(abs(slot['box'][0]-x) <= 2 and abs(slot['box'][1]-y) <= 2, slot['box'])
        self.assertEqual((result['slots'][0]['nameStyle']['color'], result['slots'][0]['priceColor']), ('#ffffff', '#ffd200'))
        self.assertIsNone(result['slots'][0]['region'])

    def test_blank_page_falls_back_to_ai_or_explains(self):
        busy = Image.new('RGB', (400, 560), PAPER)
        d = ImageDraw.Draw(busy)
        for x in range(0, 400, 40):
            for y in range(0, 560, 40):
                d.rectangle((x+5, y+5, x+30, y+30), fill=((x*5) % 255, 90, (y*3) % 255))
        with patch.dict(os.environ, {'AZURE_OPENAI_ENDPOINT': ''}), self.assertRaises(HTTPException) as error:
            blank_analysis(busy, 1)
        self.assertIn('原始 PDF', error.exception.detail)
        with patch.dict(os.environ, AZURE), patch.object(vision_llm, 'ask_json', return_value={'has_products': True}), self.assertRaises(HTTPException) as error:
            blank_analysis(busy, 1)
        self.assertIn('已有商品', error.exception.detail)
        with patch.dict(os.environ, AZURE), patch.object(vision_llm, 'ask_json', return_value={'has_products': False, 'x': .1, 'y': .2, 'w': .8, 'h': .6}):
            result = blank_analysis(busy, 1)
        self.assertEqual((result['layout'], [round(v) for v in result['zone']]), ('panel', [40, 112, 320, 336]))
        self.assertIn('AI 指出', result['warnings'][0])

    def test_image_upload_and_pdf_without_products_use_blank_mode(self):
        panel = Image.new('RGB', (800, 1100), (200, 30, 40))
        ImageDraw.Draw(panel).rectangle((30, 200, 770, 1040), fill=(255, 245, 223))
        data = io.BytesIO()
        panel.save(data, 'JPEG', quality=92)
        result = analyze_image(data.getvalue(), use_ai=False)
        self.assertTrue(result['blank'])
        self.assertTrue(result['background'].startswith('data:image/jpeg;base64,'))
        self.assertEqual((result['pageWidth'], len(result['slots'])), (800, 2))
        with self.assertRaises(HTTPException):
            analyze_image(b'not an image')
        background = io.BytesIO()
        panel.save(background, 'PNG')
        rebuilt = {'background': 'data:image/png;base64,'+base64.b64encode(background.getvalue()).decode(), 'width': 800, 'height': 1100,
                   'pageWidth': 400, 'pageHeight': 550, 'regions': [], 'products': []}
        with patch('backend.poster_auto.reconstruct_pdf', return_value=rebuilt):
            result = analyze_poster(b'%PDF-1.4', 1, use_ai=False)
        self.assertEqual(result['layout'], 'panel')
        self.assertTrue(result['zone'][0] < 30 and result['zone'][2] < 400)        # page units, not pixels
        response = authenticated_client(app).post('/api/poster-auto/analyze-image?ai=0', content=data.getvalue())
        self.assertEqual(response.status_code, 200)

    def test_cells_come_from_price_badges_when_photo_grouping_is_wrong(self):
        from PIL import ImageFont
        font = ImageFont.load_default(size=56)
        image = Image.new('RGB', (1200, 1600), (230, 30, 120))                   # pink border
        d = ImageDraw.Draw(image)
        d.rectangle((40, 100, 1160, 1500), fill=(255, 247, 228))                  # cream panel
        rows = [(560, 3), (1180, 4)]
        for top, count in rows:
            width = 1120/count
            for i in range(count):
                x = 40+width*i
                d.rectangle((x+20, top-380, x+width-20, top-60), fill=(40, 90, 200))           # product photo
                d.text((x+20, top+10), 'Name', fill=DARK, font=ImageFont.load_default(size=22))
                d.text((x+width-130, top), '$29', fill=RED, font=font)                         # price badge digits
            d.rectangle((60, top+110, 110, top+150), fill=RED)                                  # 「新」 tag below the text
        # The rebuild grouped the second row wrongly (2 overlapping groups) but its text rows are right.
        rebuilt = {'pageWidth': 1200, 'pageHeight': 1600, 'products': [
            {'box': [40, 180, 373, 480], 'textBox': [40, 560, 373, 90]}, {'box': [413, 180, 373, 480], 'textBox': [413, 560, 373, 90]},
            {'box': [786, 180, 373, 480], 'textBox': [786, 560, 373, 90]},
            {'box': [40, 800, 700, 480], 'textBox': [40, 1180, 700, 90]}, {'box': [500, 800, 660, 480], 'textBox': [500, 1180, 660, 90]}]}
        cells = badge_grid(image, 1, rebuilt)
        self.assertEqual(len(cells), 7)
        first, second = cells[:3], cells[3:]
        for row in (first, second):
            self.assertTrue(abs(row[0]['box'][0]-40) <= 6 and abs(row[-1]['box'][0]+row[-1]['box'][2]-1160) <= 6)   # panel edges, not the border
            for a, b in zip(row, row[1:]):
                self.assertAlmostEqual(a['box'][0]+a['box'][2], b['box'][0], places=6)                         # cells tile the row
        self.assertTrue(all(c['region']['color'] == '#fff7e4' or c['region']['color'].startswith('#ff') for c in cells))
        self.assertTrue(all(c['badge'][0] > c['box'][0] and c['badge'][0]+c['badge'][2] <= c['box'][0]+c['box'][2]+6 for c in cells))

    @patch('backend.product_library.photo_index', return_value={})
    @patch('backend.product_library.lookup_items', return_value={})
    def test_full_automatic_flow_accepts_up_to_30_products(self, lookup, photos):
        from backend.campaigns import parse_campaign
        header = '活動名稱,商品名稱,商品編號,規格,優惠總價,優惠件數,開始日期,結束日期,適用門店\n'
        sheet = lambda n: (header+''.join(f'雙十一,商品{i},S{i},100克,{10+i},1,2026-11-01,2026-11-11,全線\n' for i in range(n))).encode()
        with self.assertRaises(HTTPException) as error:
            parse_campaign(sheet(15), 'csv')
        self.assertIn('最多匯入 12 件', error.exception.detail)
        self.assertEqual(len(parse_campaign(sheet(18), 'csv', 30)['rows']), 18)
        client = authenticated_client(app)
        self.assertEqual(client.post('/api/import-campaign?kind=csv', content=sheet(15)).status_code, 422)
        response = client.post('/api/import-campaign?kind=csv&limit=30', content=sheet(18))
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(len(response.json()['rows']), 18)
        response = client.post('/api/import-campaign?kind=csv&limit=999', content=sheet(31))
        self.assertIn('最多匯入 30 件', response.json()['detail'])

    def test_one_product_pop_page_keeps_tag_terms_and_plus_sign(self):
        from PIL import ImageFont
        image = Image.new('RGB', (600, 850), (255, 247, 228))
        d = ImageDraw.Draw(image)
        d.ellipse((20, 20, 220, 200), fill=(240, 120, 30))                                  # 「一買即換」 tag
        d.rectangle((250, 110, 570, 630), fill=(150, 30, 30))                              # product photo
        for i, line in enumerate(['Brand', 'Product', '380g', '$55']):
            d.text((40, 330+i*55), line, fill=(5, 5, 5), font=ImageFont.load_default(size=44))
        d.rectangle((40, 640, 90, 655), fill=RED)                                           # 「+」 bar
        d.rectangle((58, 622, 72, 673), fill=RED)
        d.text((100, 630), '$39', fill=RED, font=ImageFont.load_default(size=140))
        d.text((30, 825), 'terms', fill=(5, 5, 5), font=ImageFont.load_default(size=16))
        slot = single_product(image, 1, 600, 850, [[250, 110, 320, 520]])
        self.assertIsNotNone(slot)
        self.assertEqual([round(v) for v in slot['imageBox']], [250, 110, 320, 520])
        x, y, w, h = slot['textBox']
        self.assertTrue(30 <= x <= 45 and 325 <= y <= 350 and y+h <= 600, slot['textBox'])
        self.assertTrue(slot['priceBox'][0] >= 92, slot['priceBox'])                       # starts after the 「+」
        self.assertEqual(len(slot['region']), 3)                                             # photo, name, price only
        for region in slot['region']:
            top = region['box'][1]*850
            self.assertTrue(top > 90 and top+region['box'][3]*850 < 822)                    # tag and terms untouched
        self.assertAlmostEqual(slot['nameStyle']['lineHeight']*slot['nameStyle']['fontSize'], 55, delta=4)

    def test_old_poster_image_without_pdf_finds_badges_beside_name_blocks(self):
        from PIL import ImageFont
        image = Image.new('RGB', (1200, 1600), (230, 30, 120))
        d = ImageDraw.Draw(image)
        d.rectangle((40, 100, 1160, 1500), fill=(255, 247, 228))
        d.text((300, 120), '$', fill=RED, font=ImageFont.load_default(size=40))                 # red title with a $: no name block
        d.text((330, 110), '99', fill=RED, font=ImageFont.load_default(size=90))
        small = ImageFont.load_default(size=22)
        for top, count in [(560, 3), (1180, 4)]:
            width = 1120/count
            for i in range(count):
                x = 40+width*i
                d.rectangle((x+20, top-380, x+width-20, top-60), fill=(40, 90, 200))
                for n, line in enumerate(['Brand', 'Name', '100g', '$12']):
                    d.text((x+16, top+n*26), line, fill=DARK, font=small)
                d.text((x+width-140, top+4), '$', fill=RED, font=ImageFont.load_default(size=28))   # superscript $
                d.text((x+width-120, top), '29', fill=RED, font=ImageFont.load_default(size=60))
        result = image_poster(image)
        self.assertEqual((result['layout'], len(result['slots'])), ('grid', 7))
        self.assertTrue(all(s['priceBox'][1] > 400 for s in result['slots']))         # the title is not a price badge
        data = io.BytesIO()
        image.save(data, 'PNG')
        analysed = analyze_image(data.getvalue(), use_ai=False)
        self.assertEqual((analysed.get('layout'), len(analysed['slots']), analysed.get('blank')), ('grid', 7, None))
