"""Automatic product replacement on an old poster.

Geometry comes from the PDF rebuild, text style from the old printed text, product data only from
the uploaded activity sheet. The vision model (optional) only confirms which detected cells are
product offers and reviews the finished poster; it never supplies names or prices.
"""
import base64
import io
import json
import logging
import re
import time

import fitz

from fastapi import APIRouter, HTTPException, Request
from PIL import Image, ImageDraw
from starlette.concurrency import run_in_threadpool

try:
    from . import vision_llm
    from .pdf_rebuild import reconstruct_pdf, analyze_text_image, _dominant
    from .poster_pdf import _render_lock, read_pdf, MAX_BYTES
except ImportError:
    import vision_llm
    from pdf_rebuild import reconstruct_pdf, analyze_text_image, _dominant
    from poster_pdf import _render_lock, read_pdf, MAX_BYTES

logger = logging.getLogger(__name__)
router = APIRouter()
NAME_SHARE = .53  # the rebuild splits each text box: name/spec/original left, price badge right


def _crop(image, rect, scale, pad=4):
    x, y, w, h = rect
    box = (max(0, int(x*scale)-pad), max(0, int(y*scale)-pad),
           min(image.width, int((x+w)*scale)+pad), min(image.height, int((y+h)*scale)+pad))
    return image.crop(box), box


def _ink_color(crop):
    import numpy as np
    pixels = np.asarray(crop.convert('RGB')).astype(int)
    border = np.concatenate([pixels[0], pixels[-1], pixels[:, 0], pixels[:, -1]])
    paper = np.median(border, axis=0)
    ink = np.abs(pixels-paper).max(axis=2) > 55
    if ink.sum() < 20:
        return None
    return '#%02x%02x%02x' % _dominant(pixels[ink])


def name_block(pixels, anchor=0):
    """Pixel bounds (left, top, right, bottom) of the name/spec/original text in a text box.

    The detected text box is approximate: it may start half a line low and run into the next
    row's photo or 「新」 tag. So the block climbs from `anchor` (the detected top) through the
    line straddling it, ends at the first blank gap taller than a text line, and its right edge is where the red
    price badge begins within those rows.
    """
    import numpy as np
    pixels = pixels.astype(int)
    height, width = pixels.shape[:2]
    paper = np.median(np.concatenate([pixels[-1], pixels[:, 0], pixels[:, -1]]), axis=0)
    ink = np.abs(pixels-paper).max(axis=2) > 55
    saturated = pixels.max(axis=2)-pixels.min(axis=2) > 90
    left_part = slice(0, int(width*NAME_SHARE))
    rows = ink[:, left_part].any(axis=1)
    # Start at the detected top and climb only through the text line straddling it.
    top = min(height-1, int(anchor))
    while top > 0 and rows[top-1]:
        top -= 1
    # The text ends at the first blank gap taller than most of a text line: gaps between lines are
    # smaller, while a tag or the next row's photo below always sits beyond such a gap.
    bottom, seen, blank, line, first_line = height, False, 0, 0, None
    for y in range(top, height):
        if rows[y]:
            seen, blank, line = True, 0, line+1
            continue
        if seen and first_line is None:
            first_line = line
        if seen:
            blank += 1
            if blank > max(6, .8*first_line):
                bottom = y-blank+2
                break
    columns = np.flatnonzero(saturated[top:bottom, int(width*.2):].sum(axis=0) >= 3)
    right = int(width*.2)+int(columns[0])-4 if len(columns) else int(width*NAME_SHARE)
    return 0, top, max(8, right), bottom


def _text_style(image, rect, scale):
    """Style of the old name/spec/original block, in page units."""
    import numpy as np
    x, y, w, h = rect
    # Reach up a little: on some rows the detected text box starts half a line low.
    whole, (x0, y0, _, _) = _crop(image, (x, y-h*.3, w, h*1.3), scale)
    bx0, by0, bx1, by1 = name_block(np.asarray(whole), (y*scale-y0) if y*scale > y0 else 0)
    crop = whole.crop((bx0, by0, bx1, by1))
    left, top, right, bottom = x0+bx0, y0+by0, x0+bx1, y0+by1
    try:
        result = analyze_text_image(crop)
    except HTTPException as exc:
        return {'error': exc.detail}
    height = bottom-top
    bx, by, bw, bh = result['box']
    return {
        'fontSize': result['fontSizeRatio']*height/scale,
        'top': (top+by*height)/scale, 'left': (left+bx*(right-left))/scale,
        'right': right/scale, 'bottom': bottom/scale,
        'lineHeight': result['lineHeight'], 'color': result['color'], 'weight': result['weight'],
        'align': result['align'], 'oldText': re.sub(r'~~|\*\*', '', result['text']),
        'rows': len(result['text'].split('\n')),
    }


def price_box(image, rect, scale, name_right, name_top, font_size):
    """Page-unit box of the old red price badge to the right of the name block, or None.

    The badge starts level with the name block (its small `$` rises about half a line above it), so
    the search begins one line above the name. Red rows are split at gaps of 5% of the box and the
    first run at least a text line tall and wide is the badge, skipping stray packaging pixels
    above and the next row's packaging below.
    """
    import numpy as np
    x, y, w, h = rect
    top = name_top-font_size*1.2
    crop, (x0, y0, x1, y1) = _crop(image, (x, top, w, y+h-top), scale, pad=0)
    pixels = np.asarray(crop).astype(int)
    start = max(0, int(name_right*scale)-x0)
    saturated = pixels[:, start:].max(axis=2)-pixels[:, start:].min(axis=2) > 90
    rows = np.flatnonzero(saturated.sum(axis=1) >= 3)
    gap, line = max(3, int(pixels.shape[0]*.05)), font_size*scale
    # Runs of red rows; stray red pixels from packaging above are far smaller than a badge.
    runs, start_row = [], None
    for index, r in enumerate(rows):
        if start_row is None:
            start_row = r
        if index+1 == len(rows) or rows[index+1]-r > gap:
            runs.append((start_row, r));start_row = None
    for first, last in runs:
        columns = np.flatnonzero(saturated[first:last+1].any(axis=0))
        if last-first+1 >= line*.8 and columns[-1]-columns[0]+1 >= line:
            return [(x0+start+columns[0])/scale, (y0+first)/scale, (columns[-1]-columns[0]+1)/scale, (last-first+1)/scale]
    return None


def _mode_color(pixels):
    """Most common colour (quantised), e.g. the panel behind the products."""
    import numpy as np
    flat = pixels.reshape(-1, 3).astype(int)
    codes = (flat//8) @ np.array([1024, 32, 1])
    values, counts = np.unique(codes, return_counts=True)
    return np.median(flat[codes == values[counts.argmax()]], axis=0)


def _row_badges(image, scale, y0, y1):
    """Price badges in one row band, left to right, in page units, plus the panel edges and colour.

    Every badge carries large red digits: glyph-like red shapes (thin strokes, upright, touching
    digits up to twice as wide as tall) of the band's largest digit height, on one baseline.
    Packaging, 「新」 tags and filled strips do not look like that. Each badge then grows from its
    digits to the `$`, 「平均每件」 and the strip around them. Returns None without badges.
    """
    import numpy as np
    crop = image.crop((0, int(y0*scale), image.width, int(y1*scale)))
    k = max(1, crop.height/160)
    small = crop.resize((max(1, int(crop.width/k)), max(1, int(crop.height/k))))
    a = np.asarray(small).astype(int)
    paper = _mode_color(a)
    panel = np.flatnonzero((np.abs(a-paper).max(axis=2) < 24).mean(axis=0) > .3)
    red = (a.max(axis=2)-a.min(axis=2) > 90) & (a[..., 0] > 150)
    components = _components(red)
    glyphs = [c for c in components if c[3]-c[1] >= a.shape[0]*.12 and .15 <= (c[2]-c[0])/(c[3]-c[1]) <= 2
              and .2 <= c[4]/((c[2]-c[0])*(c[3]-c[1])) <= .8]
    if not glyphs or not len(panel):
        return None
    tallest = max(g[3]-g[1] for g in glyphs)
    groups = []
    for g in sorted(g for g in glyphs if g[3]-g[1] >= tallest*.55):
        if groups:
            last = groups[-1]
            height = min(last[3]-last[1], g[3]-g[1])
            if g[0]-last[2] < .6*height and min(last[3], g[3])-max(last[1], g[1]) >= .5*height:
                groups[-1] = [min(last[0], g[0]), min(last[1], g[1]), max(last[2], g[2]), max(last[3], g[3])]
                continue
        groups.append(list(g[:4]))
    bottoms = sorted(g[3] for g in groups)
    baseline = bottoms[len(bottoms)//2]
    badges = []
    for g in groups:
        height = g[3]-g[1]
        if abs(g[3]-baseline) > .35*height:
            continue
        box = list(g)
        for x0, cy0, x1, cy1, _ in components:
            if x0 >= g[0]-1.1*height and x1 <= g[2]+.7*height and cy0 >= g[1]-.6*height and cy1 <= g[3]+height:
                box = [min(box[0], x0), min(box[1], cy0), max(box[2], x1), max(box[3], cy1)]
        if badges and box[0] < badges[-1][2]:          # `29` and `.9` found separately: one badge
            last = badges[-1]
            badges[-1] = [min(last[0], box[0]), min(last[1], box[1]), max(last[2], box[2]), max(last[3], box[3])]
        else:
            badges.append(box)
    s = k/scale
    return {'left': int(panel[0])*s, 'right': (int(panel[-1])+1)*s, 'paper': paper,
            'badges': [[b[0]*s, y0+b[1]*s, (b[2]-b[0])*s, (b[3]-b[1])*s] for b in badges]}


def badge_grid(image, scale, rebuilt):
    """Product cells derived from price badges: one badge per product, at the right of its cell.

    The rebuild's image grouping fails when photo heights vary within a row (merged or
    overlapping cells), but its text rows are reliable. In each text row the badges give the
    product count; a cell ends just after its badge and the next starts there, so cells tile the
    row between the panel edges. Returns None when a row has no badges (then keep the rebuild).
    """
    page_width, page_height = rebuilt['pageWidth'], rebuilt['pageHeight']
    bands = []
    for top, bottom in sorted({(p['textBox'][1], p['textBox'][1]+p['textBox'][3]) for p in rebuilt['products']}):
        if bands and top < bands[-1][1]:
            bands[-1][1] = max(bands[-1][1], bottom)
        else:
            bands.append([top, bottom])
    if not bands:
        return None
    previous = min(p['box'][1] for p in rebuilt['products'])
    lowest = max(p['box'][1]+p['box'][3] for p in rebuilt['products'])
    cells = []
    for index, (text_top, text_bottom) in enumerate(bands):
        # Badges rise above the text (the small `$`); some rows place text lower than the rebuild says.
        row = _row_badges(image, scale, max(previous, text_top-page_height*.04), text_top+page_height*.075)
        if row is None or not row['badges']:
            return None
        badges = row['badges']
        bottom = max(text_bottom, max(b[1]+b[3] for b in badges))+page_height*.012
        if index == len(bands)-1:
            bottom = max(bottom, min(lowest, bottom+page_height*.03))
        text = min(text_top, min(b[1] for b in badges))-page_height*.005
        # Rows are usually divided evenly; keep that when every badge fits its even cell, otherwise
        # end each cell just after its badge.
        step = (row['right']-row['left'])/len(badges)
        even = [row['left']+step*i for i in range(len(badges)+1)]
        if all(even[i]-step*.05 <= b[0] and b[0]+b[2] <= even[i+1]+step*.05 for i, b in enumerate(badges)):
            edges = even
        else:
            edges = [row['left']]+[b[0]+b[2]+page_width*.01 for b in badges[:-1]]+[row['right']]
        paper = '#%02x%02x%02x' % tuple(int(v) for v in row['paper'])
        for x0, x1, badge in zip(edges, edges[1:], badges):
            cells.append({'box': [x0, previous, x1-x0, bottom-previous], 'imageBox': [x0, previous, x1-x0, max(1, text-previous-4)],
                          'textBox': [x0, text, x1-x0, bottom-text], 'badge': badge,
                          'region': {'box': [x0/page_width, previous/page_height, (x1-x0)/page_width, (bottom-previous)/page_height], 'color': paper}})
        previous = bottom
    return cells


def single_product(image, scale, page_width, page_height, photos):
    """A one-product POP page (photo, name block, one large price, e.g. 「一買即換 +$39」).

    The price is the large red digits in the lower half, the photo the embedded product images,
    the name block the dark text left of the photo above the price. Only these three areas are
    masked, so tags, terms and borders stay. Returns a slot or None.
    """
    import numpy as np
    # Red packaging in the photo must not join the price: search on a copy with photos blanked.
    plain = image.copy()
    draw = ImageDraw.Draw(plain)
    for x, y, w, h in photos:
        if w*h >= page_width*page_height*.03:
            draw.rectangle([v*scale for v in (x, y, x+w, y+h)], fill=(255, 255, 255))
    row = _row_badges(plain, scale, page_height*.45, page_height*.97)
    if not row or not row['badges']:
        return None
    price = max(row['badges'], key=lambda b: b[2]*b[3])
    if price[3] < page_height*.05:
        return None
    # A 「+」 at the top-left of the price belongs to the offer wording: keep it, start after it.
    crop = np.asarray(plain.crop([int(v*scale) for v in (price[0], price[1], price[0]+price[2], price[1]+price[3])])).astype(int)
    red = (crop.max(axis=2)-crop.min(axis=2) > 90) & (crop[..., 0] > 150)
    parts = sorted(_components(red), key=lambda c: -(c[3]-c[1]))
    if parts:
        digits = parts[0]
        plus = [c for c in parts[1:] if c[2] < digits[0] and c[3] < digits[1]+.45*(digits[3]-digits[1])]
        rest = [c for c in parts if c not in plus]
        if plus and rest:
            shift = min(c[0] for c in rest)/scale
            price = [price[0]+shift, price[1], price[2]-shift, price[3]]
    photos = [p for p in photos if p[2]*p[3] >= page_width*page_height*.03 and p[1]+p[3] <= price[1]+page_height*.02]
    if not photos:
        return None
    x0, y0 = min(p[0] for p in photos), min(p[1] for p in photos)
    photo = [x0, y0, max(p[0]+p[2] for p in photos)-x0, max(p[1]+p[3] for p in photos)-y0]
    # Name block: dark, unsaturated ink left of mid-page, above the price, outside the photo.
    k = 1000/image.height
    small = np.asarray(image.resize((max(1, int(image.width*k)), 1000))).astype(int)
    dark = (small.max(axis=2) < 110) & (small.max(axis=2)-small.min(axis=2) < 60)
    f = k*scale
    px0, py0, px1, py1 = [int(v*f) for v in (photo[0], photo[1], photo[0]+photo[2], photo[1]+photo[3])]
    dark[py0:py1, px0:px1] = False
    dark[:int(page_height*.12*f)] = False
    dark[int(price[1]*f):] = False
    dark[:, int(page_width*.55*f):] = False
    dark[:, :int(page_width*.03*f)] = False
    blobs = [c for c in _components(dark) if c[4] >= 4]
    if not blobs:
        return None
    tx0, ty0 = min(c[0] for c in blobs), min(c[1] for c in blobs)
    tx1, ty1 = max(c[2] for c in blobs), max(c[3] for c in blobs)
    text = [tx0/f, ty0/f, (tx1-tx0)/f, (ty1-ty0)/f]
    try:
        result = analyze_text_image(image.crop([int(v*scale) for v in (text[0]-4, text[1]-4, text[0]+text[2]+4, text[1]+text[3]+4)]))
        style = {'fontSize': result['fontSizeRatio']*(text[3]+8), 'lineHeight': result['lineHeight'] or 1.3, 'color': result['color'],
                 'weight': result['weight'], 'align': 'left', 'oldText': re.sub(r'~~|\*\*', '', result['text'])}
    except HTTPException:
        # OCR may fail on display type; the ink lines below still give size and spacing.
        style = {'fontSize': float('inf'), 'lineHeight': 1.3, 'color': '#231f20', 'weight': 400, 'align': 'left', 'oldText': ''}
    # Lines measured from the ink itself: a line may run behind the photo, which confuses OCR.
    lines, start = [], None
    profile = dark[ty0:ty1, tx0:tx1].any(axis=1)
    for y, inked in enumerate(list(profile)+[False]):
        if inked and start is None:
            start = y
        elif not inked and start is not None:
            lines.append((start, y))
            start = None
    if len(lines) >= 2:
        heights = sorted(b-a for a, b in lines)
        size = heights[len(heights)//2]/.92/f
        pitch = (lines[-1][0]-lines[0][0])/(len(lines)-1)/f
        # POP type is often condensed (taller than wide); the editor's square CJK font sits between
        # matching the height (too wide) and the width (looks small).
        size = (size+style['fontSize'])/2 if style['fontSize'] < size else size
        style.update(fontSize=size, lineHeight=round(min(2.5, max(1, pitch/size)), 3))
    paper = '#%02x%02x%02x' % tuple(int(v) for v in row['paper'])
    def pad(b, d):  # padded and kept inside the page (a photo may reach the page edge)
        x0, y0 = max(0, b[0]-d), max(0, b[1]-d)
        return [x0, y0, min(page_width, b[0]+b[2]+d)-x0, min(page_height, b[1]+b[3]+d)-y0]
    areas = [pad(photo, page_width*.02), pad(text, page_width*.012), pad(price, page_width*.01)]  # photo: include its shadow
    bx0, by0 = min(a[0] for a in areas), min(a[1] for a in areas)
    box = [bx0, by0, max(a[0]+a[2] for a in areas)-bx0, max(a[1]+a[3] for a in areas)-by0]
    # A longer new price (`$22.9` for `$39`) may use the empty space to the right of the old one.
    room = max(price[2], page_width*.88-price[0])
    return {'id': 1, 'box': box, 'imageBox': photo, 'textBox': text, 'priceBox': price, 'priceRoom': room,
            'priceColor': _ink_color(_crop(image, price, scale, pad=2)[0]),
            # The photo may reach over the text column (the text sits on top), so keep at least 40% of the page.
            'nameStyle': {**style, 'top': text[1], 'left': text[0], 'bottom': price[1], 'right': max(text[0]+text[2], min(photo[0], page_width*.55), page_width*.4)},
            'region': [{'box': [min(1, max(0, a[0]/page_width)), min(1, max(0, a[1]/page_height)), min(1, a[2]/page_width), min(1, a[3]/page_height)],
                        'color': paper} for a in areas]}


def _numbered(image, boxes, max_side=1600, color=(230, 0, 0)):
    """Downscaled copy with numbered boxes so the model can refer to cells by id."""
    copy = image.convert('RGB')
    copy.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
    k = copy.width/image.width
    draw = ImageDraw.Draw(copy)
    for number, (x0, y0, x1, y1) in boxes:
        draw.rectangle((x0*k, y0*k, x1*k, y1*k), outline=color, width=4)
        draw.rectangle((x0*k, y0*k, x0*k+44, y0*k+30), fill=color)
        draw.text((x0*k+8, y0*k+4), str(number), fill=(255, 255, 255), font_size=22)
    output = io.BytesIO()
    copy.save(output, 'JPEG', quality=88)
    return output.getvalue()


SLOT_PROMPT = '''You are checking an automatic layout detector on a retail promotional poster (Hong Kong supermarket, Traditional Chinese).
Red numbered boxes mark regions the detector believes are product offer cells.
For every box id, decide whether it contains exactly ONE promotional product offer: a product photo with its own name text and price.
Headers, logos, people photos, store lists, terms and decorations are NOT product offers. Two offers merged in one box is "merged".
Also count product offers visible on the poster that no box covers.
Reply with JSON only:
{"slots":[{"id":1,"status":"product|not_product|merged","printed_name":"short product name as printed","note":"why, if not product"}],"uncovered_products":0,"notes":""}'''


def check_slots(image, slots, scale):
    boxes = [(s['id'], (s['box'][0]*scale, s['box'][1]*scale, (s['box'][0]+s['box'][2])*scale, (s['box'][1]+s['box'][3])*scale)) for s in slots]
    data = vision_llm.ask_json(SLOT_PROMPT, [vision_llm.image_part(_numbered(image, boxes), 'image/jpeg')])
    verdicts = {}
    for item in data.get('slots', []) if isinstance(data.get('slots'), list) else []:
        try:
            number = int(item.get('id'))
        except (TypeError, ValueError):
            continue
        status = item.get('status') if item.get('status') in ('product', 'not_product', 'merged') else 'product'
        verdicts[number] = {'status': status, 'printedName': str(item.get('printed_name') or '')[:80], 'note': str(item.get('note') or '')[:200]}
    uncovered = data.get('uncovered_products')
    return {'used': True, 'deployment': vision_llm.settings()['deployment'], 'slots': verdicts,
            'uncovered': uncovered if isinstance(uncovered, int) and 0 <= uncovered <= 50 else 0,
            'notes': str(data.get('notes') or '')[:300]}


def analyze_poster(data, page=1, use_ai=True):
    if not data or len(data) > MAX_BYTES or b'%PDF-' not in data[:1024]:
        raise HTTPException(422, '請上傳不超過 30 MB 的有效 PDF')
    if not _render_lock.acquire(timeout=30):
        raise HTTPException(429, '正在處理另一份 PDF，請稍後重試')
    held = True
    try:
        started = time.monotonic()
        # Old names and prices are not needed (the sheet supplies them), so skip that OCR pass.
        rebuilt = reconstruct_pdf(data, page, recognize=lambda crop: [])
        background = Image.open(io.BytesIO(base64.b64decode(rebuilt['background'].split(',', 1)[1]))).convert('RGB')
        scale = background.width/rebuilt['pageWidth']
        slots = []
        grid = badge_grid(background, scale, rebuilt) if rebuilt['products'] else None
        if not grid or len(grid) <= 1:
            # One-product POP pages: one photo, one name block, one large price.
            try:
                with fitz.open(stream=data, filetype='pdf') as doc:
                    photos = [[i['bbox'][0], i['bbox'][1], i['bbox'][2]-i['bbox'][0], i['bbox'][3]-i['bbox'][1]] for i in doc[page-1].get_image_info()]
            except Exception:
                photos = []
            single = single_product(background, scale, rebuilt['pageWidth'], rebuilt['pageHeight'], photos)
            if single:
                return {'version': 1, 'background': rebuilt['background'], 'width': rebuilt['width'], 'height': rebuilt['height'],
                        'pageWidth': rebuilt['pageWidth'], 'pageHeight': rebuilt['pageHeight'], 'layout': 'single', 'slots': [single],
                        'ai': {'used': False, 'available': vision_llm.configured()}, 'warnings': []}
        for index, cell in enumerate(grid or [], 1):
            style = _text_style(background, cell['textBox'], scale)
            badge = cell['badge']
            slots.append({'id': index, 'box': cell['box'], 'imageBox': cell['imageBox'], 'textBox': cell['textBox'],
                          'region': cell['region'], 'nameStyle': style, 'priceBox': badge,
                          'priceColor': _ink_color(_crop(background, badge, scale, pad=2)[0])})
        for index, (product, region) in enumerate(zip(rebuilt['products'], rebuilt['regions']) if not grid else [], 1):
            tx, ty, tw, th = product['textBox']
            style = _text_style(background, product['textBox'], scale)
            name_right, name_top = style.get('right', tx+tw*NAME_SHARE), style.get('top', ty)
            price_rect = (name_right, ty, tx+tw-name_right, th)
            slots.append({'id': index, 'box': product['box'], 'imageBox': product['imageBox'], 'textBox': product['textBox'],
                          'region': region, 'nameStyle': style, 'priceBox': price_box(background, product['textBox'], scale, name_right, name_top, style.get('fontSize', th*.12)),
                          'priceColor': _ink_color(_crop(background, price_rect, scale)[0])})
        # PDF rendering is done; release the lock before the (possibly slow) AI calls so other
        # PDF work is not refused while the vision model answers.
        _render_lock.release()
        held = False
        if not slots:
            # No old product cells: treat the page as a blank background.
            blank = blank_analysis(background, scale, use_ai)
            return {'version': 1, 'background': rebuilt['background'], 'width': rebuilt['width'], 'height': rebuilt['height'],
                    'pageWidth': rebuilt['pageWidth'], 'pageHeight': rebuilt['pageHeight'], **blank}
        warnings = []
        ai = {'used': False, 'available': vision_llm.configured()}
        if use_ai and vision_llm.configured() and slots:
            try:
                ai |= check_slots(background, slots, scale)
            except HTTPException as exc:
                ai['error'] = exc.detail
                warnings.append(f'AI 檢查未完成，已按偵測結果處理：{exc.detail}')
        logger.info('poster auto analysis: %d slots in %.1fs', len(slots), time.monotonic()-started)
        return {'version': 1, 'background': rebuilt['background'], 'width': rebuilt['width'], 'height': rebuilt['height'],
                'pageWidth': rebuilt['pageWidth'], 'pageHeight': rebuilt['pageHeight'], 'slots': slots, 'ai': ai, 'warnings': warnings}
    finally:
        if held:
            _render_lock.release()


# ---- Blank backgrounds: no old products to copy, so find where products go -------------------

def _components(mask, with_seed=False):
    """Bounding boxes and pixel counts of 4-connected regions (mask is small, ~360 px)."""
    from collections import deque
    import numpy as np
    seen = np.zeros(mask.shape, bool)
    height, width = mask.shape
    found = []
    for y0, x0 in zip(*np.nonzero(mask)):
        if seen[y0, x0]:
            continue
        queue, count = deque([(y0, x0)]), 0
        seen[y0, x0] = True
        top, left, bottom, right = y0, x0, y0, x0
        while queue:
            y, x = queue.popleft()
            count += 1
            top, left, bottom, right = min(top, y), min(left, x), max(bottom, y), max(right, x)
            for ny, nx in ((y+1, x), (y-1, x), (y, x+1), (y, x-1)):
                if 0 <= ny < height and 0 <= nx < width and mask[ny, nx] and not seen[ny, nx]:
                    seen[ny, nx] = True
                    queue.append((ny, nx))
        bounds = (int(left), int(top), int(right)+1, int(bottom)+1, count)
        found.append(bounds+(int(x0),int(y0)) if with_seed else bounds)
    return found


def _largest_rectangle(mask):
    """Largest axis-aligned all-True rectangle (histogram method): (area, x0, y0, x1, y1)."""
    import numpy as np
    heights = np.zeros(mask.shape[1], int)
    best = (0, 0, 0, 0, 0)
    for y, row in enumerate(mask):
        heights = np.where(row, heights+1, 0)
        stack = []
        for x in range(len(heights)+1):
            h = heights[x] if x < len(heights) else 0
            start = x
            while stack and stack[-1][1] >= h:
                start, top = stack.pop()
                if top*(x-start) > best[0]:
                    best = (top*(x-start), start, y-top+1, x, y+1)
            stack.append((start, h))
    return best


def blank_layout(image):
    """Where products go on a background without products.

    Several plain rectangles of similar size are boxes printed for products (filled in reading
    order); otherwise the largest plain rectangle is an open product panel. Returns
    {'layout': 'cells'|'panel', 'boxes': [[x, y, w, h], ...] in image pixels, 'colors': [...]} or None.
    """
    import numpy as np
    small = image.convert('RGB')
    small.thumbnail((360, 360), Image.Resampling.BILINEAR)
    k = image.width/small.width
    a = np.asarray(small).astype(int)
    grad = np.zeros(a.shape[:2], int)
    grad[:-1] = np.maximum(grad[:-1], np.abs(a[1:]-a[:-1]).max(axis=2))
    grad[:, :-1] = np.maximum(grad[:, :-1], np.abs(a[:, 1:]-a[:, :-1]).max(axis=2))
    total = a.shape[0]*a.shape[1]
    codes = (a//20).reshape(-1, 3) @ np.array([169, 13, 1])
    values, counts = np.unique(codes, return_counts=True)
    rects, panels = [], []
    for code in values[np.argsort(-counts)][:6]:
        pixels = a.reshape(-1, 3)[codes == code]
        if len(pixels) < total*.02:
            continue
        color = np.median(pixels, axis=0)
        mask = (np.abs(a-color).max(axis=2) < 22) & (grad < 24)
        for x0, y0, x1, y1, count in _components(mask):
            area = (x1-x0)*(y1-y0)
            if area >= total*.008 and count >= area*.85:
                rects.append(((x0, y0, x1-x0, y1-y0), color))
        area, x0, y0, x1, y1 = _largest_rectangle(mask)
        panels.append((area, (x0, y0, x1-x0, y1-y0), color))
    # Boxes of similar size (within 25%) printed for products.
    clusters = []
    for box, color in sorted(rects, key=lambda r: -r[0][2]*r[0][3]):
        for cluster in clusters:
            w, h = cluster[0][0][2:]
            if abs(box[2]-w) <= w*.25 and abs(box[3]-h) <= h*.25:
                cluster.append((box, color))
                break
        else:
            clusters.append([(box, color)])
    cells = max((c for c in clusters if len(c) >= 2), key=lambda c: sum(b[2]*b[3] for b, _ in c), default=None)
    scale = lambda b: [b[0]*k, b[1]*k, b[2]*k, b[3]*k]
    if cells and sum(b[2]*b[3] for b, _ in cells) >= total*.15:
        return {'layout': 'cells', 'boxes': [scale(b) for b, _ in cells], 'colors': [c for _, c in cells]}
    area, box, color = max(panels, key=lambda p: p[0], default=(0, None, None))
    if area >= total*.15:
        x, y, w, h = box
        # Keep a margin inside the panel.
        return {'layout': 'panel', 'boxes': [scale((x+w*.03, y+h*.02, w*.94, h*.96))], 'colors': [color]}
    return None


def _contrast(color):
    """Text and price colours that read on a panel of `color`."""
    r, g, b = [float(v) for v in color]
    if (.299*r+.587*g+.114*b)/255 < .45:
        return '#ffffff', '#ffd200'
    return '#231f20', ('#231f20' if r > 150 and r-g > 60 and r-b > 60 else '#ed1c24')


def template_slot(index, box, color):
    """A product cell laid out like the measured 360HK poster cells (proportions of the cell)."""
    x, y, w, h = box
    text, price = _contrast(color)
    return {'id': index, 'box': [x, y, w, h], 'imageBox': [x+w*.04, y+h*.03, w*.92, h*.66],
            'textBox': [x+w*.04, y+h*.72, w*.92, h*.26], 'region': None, 'priceColor': price,
            'nameStyle': {'fontSize': h*.034, 'top': y+h*.73, 'left': x+w*.06, 'right': x+w*.6, 'bottom': y+h*.98,
                          'lineHeight': 1.4, 'color': text, 'weight': 400, 'align': 'left'},
            'priceBox': [x+w*.62, y+h*.73, w*.34, h*.145]}


ZONE_PROMPT = '''This image is a poster background for a retail promotion (Hong Kong supermarket).
1. Does it already contain product photos with prices? (has_products)
2. Give the largest empty area intended for product photos and prices, avoiding headers, logos, people, slogans and terms, as fractions of the image width and height.
Reply with JSON only: {"has_products":false,"x":0.05,"y":0.2,"w":0.9,"h":0.7}'''


def blank_analysis(image, scale, use_ai=True):
    """Slots for a background without products, in page units (image pixels ÷ scale)."""
    layout, warnings, ai = blank_layout(image), [], {'used': False, 'available': vision_llm.configured()}
    if layout is None:
        if not (use_ai and vision_llm.configured()):
            raise HTTPException(422, '找不到可放商品的空白區域。若這是舊海報，請上傳原始 PDF（圖片無法偵測舊商品格）；否則請改用手動套版。')
        copy = image.convert('RGB')
        copy.thumbnail((1600, 1600))
        output = io.BytesIO()
        copy.save(output, 'JPEG', quality=88)
        data = vision_llm.ask_json(ZONE_PROMPT, [vision_llm.image_part(output.getvalue(), 'image/jpeg')])
        ai |= {'used': True, 'deployment': vision_llm.settings()['deployment']}
        if data.get('has_products'):
            raise HTTPException(422, '這張圖已有商品。請上傳原始 PDF 讓系統偵測舊商品格；若已是 PDF，請改用手動套版。')
        try:
            fx, fy, fw, fh = [min(1., max(0., float(data[key]))) for key in ('x', 'y', 'w', 'h')]
        except (KeyError, TypeError, ValueError) as exc:
            raise HTTPException(502, 'AI 未能指出商品區，請改用手動套版') from exc
        if fw*fh < .1:
            raise HTTPException(422, '空白區域太小，請改用手動套版。')
        import numpy as np
        crop = np.asarray(image.convert('RGB').crop((int(fx*image.width), int(fy*image.height), int((fx+fw)*image.width), int((fy+fh)*image.height))))
        layout = {'layout': 'panel', 'boxes': [[fx*image.width, fy*image.height, fw*image.width, fh*image.height]],
                  'colors': [np.median(crop.reshape(-1, 3), axis=0)]}
        warnings.append('底圖沒有明顯的純色商品區，商品區由 AI 指出，請核對位置。')
    boxes = [[v/scale for v in b] for b in layout['boxes']]
    if layout['layout'] == 'cells':
        order = sorted(range(len(boxes)), key=lambda i: (round((boxes[i][1]+boxes[i][3]/2)/(boxes[i][3]*.5)), boxes[i][0]))
        slots = [template_slot(n, boxes[i], layout['colors'][i]) for n, i in enumerate(order, 1)]
        zone = [min(b[0] for b in boxes), min(b[1] for b in boxes)]
        zone += [max(b[0]+b[2] for b in boxes)-zone[0], max(b[1]+b[3] for b in boxes)-zone[1]]
    else:
        zone = boxes[0]
        # Two reference cells (one per price type) define proportions; the grid fills the zone.
        w = zone[2]/3
        h = min(w/.86, zone[3])
        slots = [template_slot(1, [zone[0], zone[1], w, h], layout['colors'][0]),
                 template_slot(2, [zone[0]+w, zone[1], w, h], layout['colors'][0])]
        slots[1]['priceBox'][3] = h*.245
    return {'blank': True, 'layout': layout['layout'], 'zone': zone, 'slots': slots, 'ai': ai, 'warnings': warnings}


REVIEW_PROMPT = '''You are proof-reading a generated retail promotional poster (Hong Kong supermarket, Traditional Chinese) before printing.
Blue numbered boxes mark product cells. EXPECTED below is the approved data for each cell; it is the source of truth.
For each cell compare what is printed with EXPECTED: product name, specification, the main price, the bundle line such as "$36/2件", and the struck-through original price.
Also report visual problems: text cut off or overflowing, text overlapping the product photo or another cell, missing or wrong product photo (photo clearly not matching the name), leftover old text or old prices.
Design elements of the poster template that are not part of EXPECTED are intentional and are not issues: e.g. a "+" before the price on buy-one-redeem (一買即換) posters, tags such as 新 or 一買即換, terms, logos and decorations.
Do not invent problems; if a cell is fine, return ok true with no issues. Write issues in Traditional Chinese.
EXPECTED:
{expected}
Reply with JSON only:
{{"slots":[{{"id":1,"ok":true,"issues":["..."]}}],"general":["poster-wide issues"]}}'''


def review_poster(payload):
    if not vision_llm.configured():
        raise HTTPException(503, '尚未設定 AI 視覺模型，無法 AI 校對')
    try:
        image_url = payload['image']
        if not re.match(r'^data:image/(png|jpeg);base64,', image_url):
            raise ValueError
        image = Image.open(io.BytesIO(base64.b64decode(image_url.split(',', 1)[1])))
        if image.width*image.height > 50_000_000:
            raise ValueError
        image = image.convert('RGB')
        slots = payload['slots'][:40]
        boxes, expected = [], []
        for slot in slots:
            number = int(slot['id'])
            x, y, w, h = [float(v) for v in slot['box']]
            boxes.append((number, (x*image.width, y*image.height, (x+w)*image.width, (y+h)*image.height)))
            expected.append({'id': number, **{k: str(v)[:120] for k, v in (slot.get('expected') or {}).items()}})
    except Exception as exc:
        raise HTTPException(422, '校對資料格式錯誤') from exc
    data = vision_llm.ask_json(REVIEW_PROMPT.format(expected=json.dumps(expected, ensure_ascii=False, indent=1)),
                               [vision_llm.image_part(_numbered(image, boxes, 2000, (0, 90, 220)), 'image/jpeg')])
    known = {n for n, _ in boxes}
    results = []
    for item in data.get('slots', []) if isinstance(data.get('slots'), list) else []:
        try:
            number = int(item.get('id'))
        except (TypeError, ValueError):
            continue
        if number in known:
            issues = [str(i)[:200] for i in item.get('issues', []) if str(i).strip()][:6] if isinstance(item.get('issues'), list) else []
            results.append({'id': number, 'ok': bool(item.get('ok')) and not issues, 'issues': issues})
    general = [str(i)[:200] for i in data.get('general', []) if str(i).strip()][:6] if isinstance(data.get('general'), list) else []
    return {'deployment': vision_llm.settings()['deployment'], 'slots': results, 'general': general}


def find_price_badges(image):
    """Price badges anywhere on a page image, in image pixels: [[x, y, w, h], ...].

    A badge is a group of large red digits with a red `$` close to its left (packaging digits
    such as 「3效」 or 「12件」 have no `$`).
    """
    import numpy as np
    k = max(1, image.height/1600)
    small = np.asarray(image.resize((max(1, int(image.width/k)), max(1, int(image.height/k))))).astype(int)
    red = (small.max(axis=2)-small.min(axis=2) > 90) & (small[..., 0] > 150)
    components = _components(red)
    glyphs = sorted(c for c in components if c[3]-c[1] >= small.shape[0]*.012 and .15 <= (c[2]-c[0])/(c[3]-c[1]) <= 2
                    and .2 <= c[4]/((c[2]-c[0])*(c[3]-c[1])) <= .8)
    numbers = []
    for g in glyphs:
        for number in numbers:
            height = min(number[3]-number[1], g[3]-g[1])
            if 0 <= g[0]-number[2] < .6*height and abs(g[3]-number[3]) < .3*height and .55 <= (g[3]-g[1])/(number[3]-number[1]) <= 1.8:
                number[:] = [min(number[0], g[0]), min(number[1], g[1]), max(number[2], g[2]), max(number[3], g[3])]
                break
        else:
            numbers.append(list(g[:4]))
    badges = []
    for x0, y0, x1, y1 in numbers:
        height = y1-y0
        dollar = [c for c in components if .15*height <= c[3]-c[1] <= .75*height and x0-1.4*height <= c[0] and c[2] <= x0+.15*height
                  and y0-.4*height <= c[1] <= y0+.55*height]
        if not dollar:
            continue
        box = [x0, y0, x1, y1]
        for cx0, cy0, cx1, cy1, _ in components:
            if cx0 >= x0-1.4*height and cx1 <= x1+.7*height and cy0 >= y0-.6*height and cy1 <= y1+height:
                box = [min(box[0], cx0), min(box[1], cy0), max(box[2], cx1), max(box[3], cy1)]
        # Overlaps are resolved by the caller after the name-block check: a false candidate from
        # packaging (larger box) must not hide the real badge it overlaps.
        badges.append(box)
    return [[b[0]*k, b[1]*k, (b[2]-b[0])*k, (b[3]-b[1])*k] for b in badges]


def _without_overlaps(boxes):
    """Keep the tighter of overlapping boxes."""
    kept = []
    for b in sorted(boxes, key=lambda b: b[2]*b[3]):
        if not any(b[0] < k[0]+k[2] and k[0] < b[0]+b[2] and b[1] < k[1]+k[3] and k[1] < b[1]+b[3] for k in kept):
            kept.append(b)
    return kept


def _text_lines(pixels, paper):
    """(dark ratio, other non-background ratio, line count) of a region: a product name block is
    a few lines of small dark text on the plain background."""
    import numpy as np
    if pixels.size == 0:
        return 0, 1, 0
    pixels = pixels.astype(int)
    dark = (pixels.max(axis=2) < 110) & (pixels.max(axis=2)-pixels.min(axis=2) < 60)
    busy = (np.abs(pixels-paper).max(axis=2) > 40) & ~dark
    edges = np.diff(np.concatenate([[0], dark.any(axis=1).astype(int), [0]]))
    return dark.mean(), busy.mean(), int((edges == 1).sum())


def has_name_block(pixels, paper, busy_limit=.25):
    dark, busy, lines = _text_lines(pixels, paper)
    # A name block has 3–8 lines; compression noise in a photo reads as many tiny "lines".
    return dark >= .01 and busy <= busy_limit and 3 <= lines <= 8


def first_row_photo_bounds(image, left, right, text_top, estimated_top, pitch, paper):
    """Extend a too-short first row to the actual product silhouettes.

    Price-row spacing cannot locate the top of a taller first row. Inspect
    components above its text instead, excluding the page header touching the
    crop's top and short red promotional labels.
    """
    import numpy as np
    margin = (right-left)*.12
    x0, x1 = max(0, int(left-margin)), min(image.width, int(right+margin))
    if x1 <= x0 or text_top <= 0:
        return estimated_top, []
    top = max(0, int(text_top - max(pitch * 1.8, image.height * .45)))
    crop = image.crop((x0, top, x1, int(text_top)))
    scale = min(1, 300 / max(crop.size))
    small = np.asarray(crop.resize((max(1, round(crop.width*scale)), max(1, round(crop.height*scale))))).astype(int)
    background = np.array(paper, dtype=int)
    busy = np.abs(small-background).max(axis=2) > 38
    candidates = []
    patches = []
    for a, b, c, d, count, seed_x, seed_y in _components(busy, with_seed=True):
        w, h = (c-a)/scale, (d-b)/scale
        if b <= 1 or a <= 1 or c >= small.shape[1]-1 or w < (x1-x0)*.12 or h < pitch*.09 or count/scale**2 < (x1-x0)*pitch*.015:
            continue
        pixels = small[b:d,a:c]
        red = (pixels[:,:,0] > 170) & (pixels[:,:,1] < 100) & (pixels[:,:,2] < 110)
        if h < pitch*.35 and red.mean() > .35:
            continue
        # Ignore isolated header lettering: the first-row product photo is
        # sizeable and extends well into the inferred product band.
        if top+d/scale < estimated_top and h < pitch*.18:
            continue
        padding = max(3,image.height*.004)
        y = max(0,top+b/scale-padding)
        candidates.append(y)
        if y < estimated_top:
            # Follow the upper silhouette in short horizontal bands. A single
            # bounding rectangle can cover a nearby logo corner above a rotated
            # coffee box; crop overlap also catches photos crossing cell edges.
            from PIL import ImageDraw
            component = Image.fromarray((busy*255).astype('uint8')).copy()
            ImageDraw.floodfill(component,(seed_x,seed_y),127)
            member = np.asarray(component) == 127
            end = min(d,int((estimated_top-top)*scale)+2)
            band_size = max(1, int(np.ceil(max(1,end-b)/8)))
            for start in range(b,end,band_size):
                stop = min(end,start+band_size)
                yy, xx = np.nonzero(member[start:stop])
                if not len(xx):
                    continue
                px = max(0,x0+int(xx.min())/scale-padding)
                py = max(0,top+(start+int(yy.min()))/scale-padding)
                right_edge = min(image.width,x0+(int(xx.max())+1)/scale+padding)
                bottom_edge = top+(start+int(yy.max())+1)/scale+padding
                patches.append([px,py,right_edge-px,bottom_edge-py])
    return max(0, min([estimated_top]+candidates)), patches


def image_poster(image):
    """Old-poster analysis from a page image alone (page units = pixels): grid or one-product POP."""
    import numpy as np
    width, height = image.size
    found = find_price_badges(image)
    if not found:
        return None
    a = np.asarray(image).astype(int)
    paper = _mode_color(a[::8, ::8])
    # Grid posters: a price badge has its product's name block right beside it, on the left.
    # Titles, slogans and packaging digits do not.
    badges = _without_overlaps([b for b in found if has_name_block(a[int(b[1]):int(b[1]+b[3]), int(max(0, b[0]-2.2*b[2])):int(b[0])], paper)])
    if len(badges) < 2:
        # A grid has several badges; one stray match (e.g. digits on the packaging) is not a grid.
        # A one-product POP: one large price in the lower half with the name block above it.
        big = [b for b in found if b[3] >= height*.05 and b[1] > height*.5
               # The name column above the price; the photo may overlap it a little (busier).
               and has_name_block(a[int(max(0, b[1]-height*.45)):int(b[1]), int(max(0, b[0]-width*.1)):int(min(width, b[0]+width*.25))], paper, .45)]
        badges = [max(big, key=lambda b: b[2]*b[3])] if big else []
    if not badges:
        return None
    if len(badges) == 1 and badges[0][3] >= height*.05:
        # One large price: a one-product POP. The photo is the largest non-background area inside
        # the panel; the frame around the panel is cut away first, or a photo touching it would
        # merge with it.
        k = max(1, height/800)
        small = np.asarray(image.resize((max(1, int(width/k)), max(1, int(height/k))))).astype(int)
        paper = _mode_color(small)
        plain = np.abs(small-paper).max(axis=2) <= 40
        columns, lines = np.flatnonzero(plain.mean(axis=0) > .3), np.flatnonzero(plain.mean(axis=1) > .3)
        if not len(columns) or not len(lines):
            return None
        inset = max(2, int(small.shape[1]*.01))
        busy = ~plain
        busy[:, :columns[0]+inset] = busy[:, columns[-1]-inset+1:] = False
        busy[:lines[0]+inset] = False
        px, py, pw, ph = [int(v/k) for v in badges[0]]
        busy[py:py+ph+1, px:px+pw+1] = False      # the price itself, not the photo beside it
        busy[py+ph+1:] = False                      # terms below the price
        areas = [c for c in _components(busy) if (c[2]-c[0])*(c[3]-c[1]) >= small.size/3*.03]
        if not areas:
            return None
        x0, y0, x1, y1, _ = max(areas, key=lambda c: (c[2]-c[0])*(c[3]-c[1]))
        single = single_product(image, 1, width, height, [[x0*k, y0*k, (x1-x0)*k, (y1-y0)*k]])
        return {'layout': 'single', 'slots': [single]} if single else None
    # Rows: badges whose tops align.
    rows = []
    for badge in sorted(badges, key=lambda b: b[1]):
        row = next((r for r in rows if abs(r[0][1]-badge[1]) < .6*r[0][3]), None)
        (row.append(badge) if row else rows.append([badge]))
    rows = [sorted(r) for r in rows]
    bottoms = [max(b[1]+b[3] for b in r)+height*.012 for r in rows]
    pitch = sorted(b-a for a, b in zip(bottoms, bottoms[1:]))
    pitch = pitch[len(pitch)//2] if pitch else height*.25
    previous = max(0, bottoms[0]-pitch)
    slots = []
    for row_index, (row, bottom) in enumerate(zip(rows, bottoms)):
        top_badge = min(b[1] for b in row)
        band = _row_badges(image, 1, max(previous, top_badge-height*.02), bottom)
        left, right = (band['left'], band['right']) if band else (min(b[0] for b in row)-width*.2, width*.97)
        paper = '#%02x%02x%02x' % tuple(int(v) for v in (band['paper'] if band else _mode_color(np.asarray(image.crop((0, int(previous), width, int(bottom)))))))
        step = (right-left)/len(row)
        even = [left+step*i for i in range(len(row)+1)]
        if all(even[i]-step*.05 <= b[0] and b[0]+b[2] <= even[i+1]+step*.05 for i, b in enumerate(row)):
            edges = even
        else:
            edges = [left]+[b[0]+b[2]+width*.01 for b in row[:-1]]+[right]
        text = top_badge-height*.005
        for x0, x1, badge in zip(edges, edges[1:], row):
            photo_top, patches = previous, []
            if row_index == 0:
                rgb_paper = tuple(int(paper[i:i+2],16) for i in (1,3,5))
                photo_top, patches = first_row_photo_bounds(image,x0,x1,text,previous,pitch,rgb_paper)
            box = [x0, photo_top, x1-x0, bottom-photo_top]
            text_box = [x0, text, x1-x0, bottom-text]
            slots.append({'id': len(slots)+1, 'box': box, 'imageBox': [x0, photo_top, x1-x0, max(1, text-photo_top-4)], 'textBox': text_box,
                          'region': ([{'box': [px/width,py/height,pw/width,ph/height], 'color':paper} for px,py,pw,ph in patches]+[{'box': [x0/width, previous/height, (x1-x0)/width, (bottom-previous)/height], 'color': paper}]) if patches else {'box':[x0/width,previous/height,(x1-x0)/width,(bottom-previous)/height],'color':paper},
                          'nameStyle': _text_style(image, text_box, 1), 'priceBox': badge,
                          'priceColor': _ink_color(_crop(image, badge, 1, pad=2)[0])})
        previous = bottom
    return {'layout': 'grid', 'slots': slots}


def analyze_image(data, use_ai=True):
    """A PNG/JPEG/WebP upload is a blank background (old posters are analysed as PDF)."""
    try:
        image = Image.open(io.BytesIO(data))
        kind = image.format
    except Exception as exc:
        raise HTTPException(422, '底圖無法讀取，請使用 PNG、JPG 或 WebP') from exc
    if kind not in ('PNG', 'JPEG', 'WEBP'):
        raise HTTPException(415, '底圖請使用 PNG、JPG 或 WebP')
    # Check the header size before decoding, so an oversized image cannot exhaust memory.
    if image.width*image.height > 50_000_000 or min(image.size) < 200:
        raise HTTPException(422, '底圖尺寸過大或過小')
    try:
        image.load()
    except Exception as exc:
        raise HTTPException(422, '底圖無法讀取，請使用 PNG、JPG 或 WebP') from exc
    mime = {'PNG': 'image/png', 'JPEG': 'image/jpeg', 'WEBP': 'image/webp'}[kind]
    rgb = image.convert('RGB')
    # An image may be an old poster (price badges present) or a blank background.
    old = image_poster(rgb)
    if old:
        ai = {'used': False, 'available': vision_llm.configured()}
        warnings = []
        if use_ai and vision_llm.configured() and old['layout'] == 'grid':
            try:
                ai |= check_slots(rgb, old['slots'], 1)
            except HTTPException as exc:
                warnings.append(f'AI 檢查未完成，已按偵測結果處理：{exc.detail}')
        return {'version': 1, 'background': f'data:{mime};base64,'+base64.b64encode(data).decode(), 'width': image.width, 'height': image.height,
                'pageWidth': image.width, 'pageHeight': image.height, **old, 'ai': ai, 'warnings': warnings}
    blank = blank_analysis(rgb, 1, use_ai)
    return {'version': 1, 'background': f'data:{mime};base64,'+base64.b64encode(data).decode(), 'width': image.width, 'height': image.height,
            'pageWidth': image.width, 'pageHeight': image.height, **blank}


@router.get('/api/poster-auto/status')
async def auto_status():
    return vision_llm.status()


@router.post('/api/poster-auto/analyze')
async def auto_analyze(request: Request, page: int = 1, ai: int = 1):
    return await run_in_threadpool(analyze_poster, await read_pdf(request), page, bool(ai))


@router.post('/api/poster-auto/analyze-image')
async def auto_analyze_image(request: Request, ai: int = 1):
    data = bytearray()
    async for chunk in request.stream():
        if len(data)+len(chunk) > 12*1024*1024:
            raise HTTPException(413, '底圖不得超過 12 MB')
        data.extend(chunk)
    return await run_in_threadpool(analyze_image, bytes(data), bool(ai))


@router.post('/api/poster-auto/review')
async def auto_review(request: Request):
    data = bytearray()
    async for chunk in request.stream():
        if len(data)+len(chunk) > 16*1024*1024:
            raise HTTPException(413, '校對圖片過大')
        data.extend(chunk)
    try:
        payload = json.loads(data)
    except ValueError as exc:
        raise HTTPException(422, '校對資料格式錯誤') from exc
    return await run_in_threadpool(review_poster, payload)
