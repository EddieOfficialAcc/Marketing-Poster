"""Conservative retail PDF reconstruction. OCR offers always require human review."""
import base64
import csv
import io
import os
import re
import subprocess
import tempfile
import time
from pathlib import Path

import fitz
from fastapi import HTTPException
from PIL import Image, ImageDraw


def data_url(data):
    return 'data:image/png;base64,' + base64.b64encode(data).decode('ascii')


def png(image):
    stream = io.BytesIO()
    image.save(stream, 'PNG')
    return stream.getvalue()


def image_candidates(page):
    w, h = page.rect.width, page.rect.height
    candidates, seen = [], set()
    components={i.get('xref'):i.get('colorspace') for i in page.get_image_info(xrefs=True)}
    for image in page.get_images(full=True):
        xref, mask, iw, ih, _, colorspace = image[:6]
        # Indexed / grey images in Illustrator exports are often shadow masks.
        if (colorspace not in ('DeviceRGB', 'DeviceCMYK') and not (colorspace=='ICCBased' and components.get(xref) in (3,4))) or iw * ih > 30_000_000:
            continue
        for rect in page.get_image_rects(xref):
            key = (xref, tuple(round(v, 2) for v in rect))
            if key in seen:
                continue
            seen.add(key)
            if not (rect.x0 >= 0 and rect.y0 >= h*.12 and rect.x1 <= w and rect.y1 <= h*.94):
                continue
            if rect.width < w*.025 or rect.height < h*.035 or rect.get_area() > w*h*.20:
                continue
            candidates.append({'xref': xref, 'mask': mask, 'rect': rect})
    if len(candidates) > 60:
        raise HTTPException(422, 'PDF 圖片過多，請將單張海報另存一頁再導入')
    return candidates


def group_products(candidates, width, height):
    rows = []
    for item in sorted(candidates, key=lambda a: a['rect'].y1):
        row = next((r for r in rows if abs(item['rect'].y1-r[0]['rect'].y1) < height*.055), None)
        if row is None:
            rows.append([item])
        else:
            row.append(item)
    result = []
    for row_index, row in enumerate(rows):
        groups = []
        for item in sorted(row, key=lambda a: a['rect'].x0):
            if groups and groups[-1]['rect'].x1-item['rect'].x0 > min(groups[-1]['rect'].width,item['rect'].width)*.025:
                groups[-1]['items'].append(item)
                groups[-1]['rect'] |= item['rect']
            else:
                groups.append({'items': [item], 'rect': fitz.Rect(item['rect'])})
        row_text_y = max(i['rect'].y1 for i in row) + 5
        next_y = min(i['rect'].y0 for i in rows[row_index+1]) if row_index+1 < len(rows) else height*.94-18
        bottom = min(row_text_y+height*.085, next_y+18)
        if bottom <= row_text_y+12:
            continue
        for index, group in enumerate(groups):
            left = width*(.03+.94*index/len(groups))
            right = width*(.03+.94*(index+1)/len(groups))
            group['textRect'] = fitz.Rect(left, row_text_y, right, bottom)
            group['row'] = row_index
            rect = group['rect']
            group['rect'] = fitz.Rect(max(0,min(left, rect.x0-3)), max(0,rect.y0-3), min(width,max(right, rect.x1+3)), min(height,bottom))
            result.append(group)
    if len(result) > 20:
        raise HTTPException(422, '識別到超過 20 組圖片，請拆分頁面或使用手動框選')
    return result


CJK = r'\u3400-\u9fff\uff01-\uff5e'


def tidy_ocr_text(text):
    """Normalize price ranges (`29.9 – 33` → `29.9-33`); spacing itself comes from glyph gaps."""
    return re.sub(r'(?<=\d)\s*[-–—~]\s*(?=\$?\d)', '-', text)


def join_words(words, height):
    """Join OCR words, keeping a space only where the printed gap is wider than letter spacing.

    Tesseract emits every CJK glyph as its own word and guesses spaces poorly (`90 克`), while
    some real spaces are narrow (`4件裝 /`). Chinese never takes spaces between glyphs or next to a
    count; elsewhere
    a gap over about 30% of a CJK glyph width is a printed space.
    """
    is_cjk=lambda t: bool(re.fullmatch(rf'[{CJK}]+', t))
    widths=sorted(w['w']/len(w['text']) for w in words if is_cjk(w['text']))
    em=widths[len(widths)//2] if widths else height*.8
    text, previous = '', None
    for word in sorted(words, key=lambda w: w['x']):
        pair=previous['text'][-1]+word['text'][0] if previous else ''
        # No space inside Chinese text or between Chinese and a count (`飯4件`, `3件裝`).
        if previous is not None and not re.fullmatch(rf'[{CJK}][{CJK}0-9]|[0-9][{CJK}]', pair):
            text += ' ' if word['x']-(previous['x']+previous['w']) > em*.3 else ''
        text += word['text'];previous = word
    return text


def ocr_lines(image, timeout=15, psm='6'):
    """Return line text/confidence/normalized boxes from Tesseract TSV."""
    with tempfile.TemporaryDirectory(prefix='poster-ocr-') as folder:
        path = Path(folder)/'crop.png'
        image.save(path)
        try:
            result = subprocess.run(['tesseract', str(path), 'stdout', '-l', 'chi_tra+eng', '--psm', psm, 'tsv'],
                                    capture_output=True, timeout=timeout, env={**os.environ, 'OMP_THREAD_LIMIT': '2'})
        except FileNotFoundError as exc:
            raise HTTPException(503, '尚未安裝文字識別元件，請重新構建後端 Docker') from exc
        except subprocess.TimeoutExpired as exc:
            raise HTTPException(422, '文字識別超時，請裁切或簡化這份 PDF 後重試') from exc
        if result.returncode:
            raise HTTPException(503, '文字識別失敗，請確認後端已安裝繁體中文與英文 OCR 語言包')
        lines = {}
        for word in csv.DictReader(io.StringIO(result.stdout.decode('utf-8', 'replace')), delimiter='\t'):
            text = (word.get('text') or '').strip()
            if not text or word.get('level') != '5':
                continue
            key = (word['block_num'], word['par_num'], word['line_num'])
            row = lines.setdefault(key, {'words': [], 'confidence': [], 'rect': None})
            x, y, w, h = [int(word[k]) for k in ('left', 'top', 'width', 'height')]
            r = fitz.Rect(x, y, x+w, y+h)
            row['rect'] = r if row['rect'] is None else row['rect'] | r
            row['words'].append({'text': text, 'x': x, 'w': w})
            row.setdefault('word_boxes', []).append({'text': text, 'confidence': float(word['conf'])/100, 'box': [x/image.width, y/image.height, w/image.width, h/image.height]})
            row['confidence'].append(float(word['conf'])/100)
        output = []
        for row in lines.values():
            r = row['rect']
            text = tidy_ocr_text(join_words(row['words'], r.height))
            output.append({'text': text, 'confidence': min(row['confidence']),
                           'box': [r.x0/image.width, r.y0/image.height, r.width/image.width, r.height/image.height],
                           'words': row['word_boxes']})
        return output


def parse_offer(left_lines, right_lines):
    """Never infer a bundle total by multiplying an ambiguous unit price."""
    left = [r['text'].strip() for r in left_lines if r['text'].strip()]
    right = '\n'.join(r['text'] for r in right_lines)
    normalized = right.translate(str.maketrans({'＄': '$', '／': '/', '．': '.', '，': '.'}))
    compact = re.sub(r'\s+', '', normalized)
    bundle = re.search(r'\$?(\d{1,5}(?:\.\d{1,2})?)/(\d{1,2})[件包罐樽袋]?', compact)
    price, quantity = '', 1
    if bundle and int(bundle[2]) > 0:
        price, quantity = bundle[1], int(bundle[2])
    elif not re.search(r'[/每平均]', compact):
        numbers = re.findall(r'\d+(?:\.\d{1,2})?', compact)
        if len(numbers) == 1:
            price = numbers[0]
    name, specs, original = [], [], ''
    for line in left:
        original_match = re.search(r'[$＄]\s*(\d+(?:\.\d{1,2})?)', line)
        if original_match:
            original = original_match[1]
            line = line[:original_match.start()].strip()
        if not line:
            continue
        if re.search(r'\d\s*(?:kg|g|ml|l|克|公斤|毫升|升|件|包|罐|樽|袋|支)', line, re.I):
            specs.append(line)
        else:
            name.append(line)
    if price and (float(price)<=0 or float(price)>9999999):price=''
    if original and float(original)<=0:original=''
    return {'name': '\n'.join(name)[:100], 'spec': ' '.join(specs)[:100], 'price': price,
            'quantity': quantity, 'originalPrice': original}


def page_text_lines(page):
    """Every native text line with its characters, extracted once per page.

    Clipped get_text calls re-parse the whole page each time (about 3 s apiece on a vector-heavy
    poster), so reconstruct_pdf reads the page once and clips characters itself.
    """
    lines = []
    for block in page.get_text('rawdict')['blocks']:
        for line in block.get('lines', []):
            lines.append([(char['c'], fitz.Rect(char['bbox'])) for span in line['spans'] for char in span['chars']])
    return lines


def native_lines(page, rect, lines=None):
    rows = []
    for line in page_text_lines(page) if lines is None else lines:
        # Same rule as a clipped get_text: keep characters whose centre lies inside the rectangle.
        chars = [(c, r) for c, r in line if rect.contains(fitz.Point((r.x0+r.x1)/2, (r.y0+r.y1)/2))]
        text = ''.join(c for c, _ in chars).strip()
        if text:
            r = fitz.Rect(chars[0][1])
            for _, box in chars[1:]:
                r |= box
            rows.append({'text': text, 'confidence': 1, 'box': [(r.x0-rect.x0)/rect.width,
                (r.y0-rect.y0)/rect.height, r.width/rect.width, r.height/rect.height]})
    return rows


def reconstruct_pdf(data, page_number=1, recognize=ocr_lines):
    started = time.monotonic()
    try:
        doc = fitz.open(stream=data, filetype='pdf')
    except Exception as exc:
        raise HTTPException(422, '無法讀取 PDF') from exc
    with doc:
        if doc.needs_pass or not 1 <= page_number <= len(doc):
            raise HTTPException(422, 'PDF 有密碼或頁碼無效')
        page = doc[page_number-1]
        if page.rotation:
            raise HTTPException(422, '此頁含旋轉座標，請先將頁面旋轉另存後再自動重建')
        w, h = page.rect.width, page.rect.height
        if not .4 <= w/h <= 2.5:
            raise HTTPException(422, 'PDF 頁面比例不適合目前海報畫布')
        scale = 4000/max(w, h)
        rendered = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
        original = Image.frombytes('RGB', (rendered.width, rendered.height), rendered.samples)
        candidates=image_candidates(page)
        text_lines=page_text_lines(page)
        groups = group_products(candidates, w, h)
        products, regions, cache = [], [], {}
        for index, group in enumerate(groups):
            if time.monotonic()-started > 180:
                raise HTTPException(422, '重建超時，請將較少商品另存為一頁')
            rect, text = group['rect'], group['textRect']
            middle = text.x0+text.width*.53
            text_parts = [fitz.Rect(text.x0, text.y0, middle, text.y1), fitz.Rect(middle, text.y0, text.x1, text.y1)]
            recognized = []
            for r in text_parts:
                lines = native_lines(page, r, text_lines)
                if not lines:
                    pix = page.get_pixmap(matrix=fitz.Matrix(3, 3), clip=r, alpha=False)
                    crop = Image.frombytes('RGB', (pix.width, pix.height), pix.samples)
                    draw=ImageDraw.Draw(crop)
                    for candidate in candidates:
                        overlap=candidate['rect'] & r
                        if not overlap.is_empty:
                            draw.rectangle(((overlap.x0-r.x0)*3,(overlap.y0-r.y0)*3,(overlap.x1-r.x0)*3,(overlap.y1-r.y0)*3),fill='white')
                    lines = recognize(crop)
                recognized.append(lines)
            offer = parse_offer(*recognized)
            offer['name'] = offer['name'] or f'待核對商品 {index+1}'
            if len(group['items'])>6:raise HTTPException(422, '商品分組過於複雜，請使用手動框選')
            items = []
            for entry in group['items']:
                xref = entry['xref']
                if xref not in cache:
                    pix = fitz.Pixmap(doc, xref)
                    if pix.colorspace and pix.colorspace.n != 3:
                        pix = fitz.Pixmap(fitz.csRGB, pix)
                    if entry['mask']:
                        pix = fitz.Pixmap(pix, fitz.Pixmap(doc, entry['mask']))
                    img = Image.frombytes('RGBA' if pix.alpha else 'RGB', (pix.width, pix.height), pix.samples)
                    img.thumbnail((1800, 1800), Image.Resampling.LANCZOS)
                    cache[xref] = data_url(png(img))
                r = entry['rect']
                items.append({'imageUrl': cache[xref], 'box': [r.x0, r.y0, r.width, r.height]})
            raw = {'nameAndSpec': recognized[0], 'offer': recognized[1]}
            products.append({**offer, 'box': [rect.x0, rect.y0, rect.width, rect.height],
                             'imageBox': [rect.x0, rect.y0, rect.width, text.y0-rect.y0-4],
                             'textBox': [text.x0, text.y0, text.width, text.height], 'images': items, 'ocr': raw})
            # Sample empty beige around each cell; only the detected cell is cleared.
            sample = original.crop((max(0,int(rect.x0*scale)), max(0,int(rect.y0*scale)-5),
                                    max(1,int(rect.x0*scale)+5), max(1,int(rect.y0*scale))))
            color = tuple(sample.resize((1,1)).getpixel((0,0)))
            mask_top=rect.y0 if group['row']==0 else max(h*.16,rect.y0-h*.055)
            regions.append({'box': [rect.x0/w, mask_top/h, rect.width/w, (rect.y1-mask_top)/h],
                            'color': '#%02x%02x%02x' % color})
        return {'version': 1, 'width': rendered.width, 'height': rendered.height,
                'pageWidth': w, 'pageHeight': h, 'background': data_url(png(original)),
                'products': products, 'regions': regions,
                'warnings': ['自動識別的名稱、規格、價格及分組必須逐項核對；商品區用取樣底色清理，促銷角標可能需重設。未識別的品牌及活動文字仍在底圖中。'] +
                            ([] if groups else ['未找到可獨立提取的商品圖，可能是掃描或整頁合成 PDF，請使用手動框選。'])}


def _pixel_box(image, box, pad=0):
    x, y, w, h = box
    return (max(0, int(x*image.width)-pad), max(0, int(y*image.height)-pad),
            min(image.width, max(int(x*image.width)+1, round((x+w)*image.width)+pad)),
            min(image.height, max(int(y*image.height)+1, round((y+h)*image.height)+pad)))


def _dominant(pixels):
    import numpy as np
    keys = np.minimum(10, pixels//24)
    codes = keys[:, 0]*121+keys[:, 1]*11+keys[:, 2]
    chosen = pixels[codes == np.bincount(codes).argmax()]
    return tuple(int(v) for v in np.median(chosen, axis=0))


def _row_style(pixels, paper, ring):
    """Ink color and stroke width of one OCR row; `ring` is the pixels just outside its glyph box."""
    import numpy as np
    background = paper
    if len(ring) and (np.abs(ring.astype(int)-paper).max(axis=1) > 55).mean() > .8:
        # Text printed on a filled badge: the fill around the glyphs becomes the local paper color.
        background = np.array(_dominant(ring))
    ink = np.abs(pixels.astype(int)-background).max(axis=2) > 55
    if not ink.any():
        return None
    padded = np.pad(ink, 1)
    edges = sum(int((padded[1:-1, 1:-1] & ~np.roll(padded, shift, axis)[1:-1, 1:-1]).sum())
                for axis in (0, 1) for shift in (1, -1))
    return {'ink': ink, 'color': _dominant(pixels[ink]), 'background': tuple(int(v) for v in background),
            'stroke': 2*int(ink.sum())/max(1, edges)}


def _weight(stroke, em):
    """Editor font weight for a stroke width (pixels) at a font size `em` (pixels).

    Calibrated on PingFang TC renders and checked against a printed 360HK poster, whose regular
    黑體 strokes measure about 0.087 em: thresholds lean toward the lighter weight, which looked
    closer than Medium beside the original.
    """
    ratio = stroke/max(1, em)
    return 300 if ratio < .058 else 400 if ratio < .092 else 500 if ratio < .105 else 600 if ratio < .118 else 700


def _strike(ink):
    """Find a strike-through in a word's ink: a long thin horizontal run in the middle band.

    Returns (rows, start, end) with start/end as fractions of the word's inked width, or None.
    The line may cover only part of the word (`$28` with only `28` struck).
    """
    import numpy as np
    columns=np.flatnonzero(ink.any(axis=0));rows_inked=np.flatnonzero(ink.any(axis=1))
    if len(columns) < 6 or len(rows_inked) < 6:
        return None
    word=ink[rows_inked[0]:rows_inked[-1]+1, columns[0]:columns[-1]+1];h, w=word.shape
    best=None
    for y in range(int(h*.3), max(int(h*.3)+1, int(h*.75))):
        line=np.concatenate([[0], word[y].astype(int), [0]]);edges=np.flatnonzero(np.diff(line))
        for start, end in zip(edges[::2], edges[1::2]):
            # A digit's own bar (4, +) is at most about half the line height wide.
            if end-start >= max(.45*w, .8*h) and (best is None or end-start > best[2]-best[1]):
                best=(y, start, end)
    if best is None:
        return None
    y, start, end=best
    rows=[r for r in range(max(0, y-3), min(h, y+4)) if word[r, start:end].mean() >= .85]
    if len(rows) > max(2, h*.2):
        return None  # a thick bar is part of a glyph, not a strike line
    return [r+rows_inked[0] for r in rows], start/w, end/w


def _mark_strike(value, start, end):
    """Wrap the struck characters of `value` in ~~ using their share of the word width."""
    n=len(value);a=min(n-1, max(0, round(start*n)));b=max(a+1, min(n, round(end*n)))
    return value[:a]+'~~'+value[a:b]+'~~'+value[b:]


def _price_offer(rows, image=None):
    """Total and quantity of a price badge such as `$18 平均每件 $36/2件`; None when not a price.

    With `image`, a missing bundle line is retried on enlarged single-ink layers: price badges mix
    small red text with white text on a red strip, which plain OCR usually drops.
    """
    texts=[r['text'].replace('~~', '') for r in rows]
    offer=parse_offer([], [{'text': t} for t in texts])
    if image is not None and offer['quantity'] == 1:
        import numpy as np
        scale=max(1, min(4, 600//max(image.width, image.height)))
        pixels=np.asarray(image.resize((image.width*scale, image.height*scale), Image.LANCZOS)).astype(int)
        layers=(pixels.max(axis=2)-pixels.min(axis=2) > 80,  # colored (red) ink
                pixels.min(axis=2) > 235,                       # white ink on a colored strip
                pixels.max(axis=2) < 100)                       # dark ink
        extra=[]
        for layer in layers:
            if layer.mean() < .003:
                continue
            extra+=[r['text'] for r in ocr_lines(Image.fromarray(np.where(layer, 0, 255).astype('uint8')).convert('RGB'))]
        # Tesseract reads a small superscript `$` as `s`/`S`.
        extra=[re.sub(r'(?<![A-Za-z$])[sS](?=\d)', '$', t) for t in extra]
        retry=parse_offer([], [{'text': t} for t in texts+extra])
        if retry['quantity'] > 1:
            offer=retry
    return {'price': offer['price'], 'quantity': offer['quantity']} if offer['price'] else None


def _vote(candidates):
    """Pick the reading most scales agree on; prefer readings that keep CJK and balanced brackets.

    Tesseract confidence alone is unreliable on small poster text (`10058` for `100克` scores
    0.81), and CJK lines are often misread as short Latin junk (`鱈魚絲` → `Sth`).
    """
    pool=[c for c in candidates if c['text'].strip()]
    if not pool:
        return None
    cjk=lambda t: len(re.findall(rf'[{CJK}]', t))
    most=max(cjk(c['text']) for c in pool)
    scores={}
    for c in pool:
        key=c['text'].replace(' ', '')
        scores[key]=scores.get(key, 0)+max(.05, c['confidence'])
    def score(key):
        value=scores[key]*(1+1.5*cjk(key)/most if most else 1)
        # Unbalanced brackets (`10(克`) and runs of one- or two-letter capitals (`RS RE AS A`)
        # are typical misreadings of small CJK glyphs.
        value*=.3**(abs(key.count('(')-key.count(')'))+abs(key.count('（')-key.count('）')))
        tokens=re.findall(r'[A-Za-z]+', next(c['text'] for c in pool if c['text'].replace(' ', '') == key))
        if len(tokens) >= 2 and sum(len(t) <= 2 for t in tokens) >= len(tokens)/2:
            value*=.3
        return value
    best=max(scores, key=score)
    same=[c for c in pool if c['text'].replace(' ', '') == best]
    return max(same, key=lambda c: (bool(c.get('words')), c['confidence']))


def _read_lines(image):
    """OCR the block at several sizes plus each line on its own, then vote line by line."""
    width, height=image.size
    readings=[]
    for scale in (1, 2, 3):
        if max(width, height)*scale > 3200:
            break
        sized=image if scale == 1 else image.resize((width*scale, height*scale), Image.LANCZOS)
        readings+=ocr_lines(sized)
    groups=[]
    for row in sorted(readings, key=lambda r: r['box'][1]+r['box'][3]/2):
        middle=row['box'][1]+row['box'][3]/2
        group=next((g for g in groups if abs(g['middle']-middle) < min(g['height'], row['box'][3])/2), None)
        if group:
            group['rows'].append(row)
        else:
            groups.append({'middle': middle, 'height': row['box'][3], 'rows': [row]})
    lines=[]
    for group in groups:
        rows=group['rows']
        # A line seen once with low confidence is usually noise from a neighbouring graphic.
        if len(rows) == 1 and rows[0]['confidence'] < .5:
            continue
        x0, y0, x1, y1=(sorted(v)[len(v)//2] for v in zip(*[(r['box'][0], r['box'][1], r['box'][0]+r['box'][2], r['box'][1]+r['box'][3]) for r in rows]))
        left, top=max(0, int(x0*width)-8), max(0, int(y0*height)-6)
        crop=image.crop((left, top, min(width, int(x1*width)+8), min(height, int(y1*height)+6)))
        candidates=list(rows)
        for target in (32, 48, 64):
            scale=target/max(1, (y1-y0)*height)
            found=ocr_lines(crop.resize((max(1, round(crop.width*scale)), max(1, round(crop.height*scale))), Image.LANCZOS), psm='7')
            if found:
                candidates.append({'text': ' '.join(r['text'] for r in found), 'confidence': min(r['confidence'] for r in found), 'box': [x0, y0, x1-x0, y1-y0], 'words': []})
        best=_vote(candidates)
        if best:
            # Word boxes (needed for strike-through detection) come from a block reading of this line.
            words=best.get('words') or max(rows, key=lambda r: r['confidence']).get('words', [])
            lines.append({'text': best['text'], 'confidence': best['confidence'], 'box': [x0, y0, x1-x0, y1-y0], 'words': words})
    return lines


def analyze_text_image(image, price=False):
    """Recognize selected raster text and estimate its visible ink style."""
    import numpy as np
    import statistics
    if image.width*image.height>25_000_000 or image.width<8 or image.height<8:
        raise HTTPException(413, '文字區域像素過大或過小，請重新框選')
    image=image.convert('RGB')
    rows=_read_lines(image)
    if not rows:
        raise HTTPException(422, '這個區域沒有識別到文字，請縮小框選範圍或直接輸入')
    pixels=np.asarray(image)
    border=np.concatenate([pixels[0], pixels[-1], pixels[:, 0], pixels[:, -1]])
    paper=np.median(border, axis=0).astype(int)
    styled=[]
    for row in rows:
        x0, y0, x1, y1=_pixel_box(image, row['box'])
        ox0, oy0, ox1, oy1=_pixel_box(image, row['box'], 3)
        outer=np.ones((oy1-oy0, ox1-ox0), bool);outer[y0-oy0:y1-oy0, x0-ox0:x1-ox0]=False
        style=_row_style(pixels[y0:y1, x0:x1], paper, pixels[oy0:oy1, ox0:ox1][outer])
        if not style:
            continue
        text=row['text']
        for word in row.get('words', []):
            wx0, wy0, wx1, wy1=_pixel_box(image, word['box'], 2)
            ink=np.abs(pixels[wy0:wy1, wx0:wx1].astype(int)-np.array(style['background'])).max(axis=2) > 55
            # Only prices are struck through; CJK strokes would otherwise look like strike lines.
            if not re.search(r'\d', word['text']) or not (found_strike:=_strike(ink)):
                continue
            # The voted line text may read the price differently from this word's own box (`$44` vs
            # `$14`): take the price token whose place in the line is nearest the word.
            tokens=[m for m in re.finditer(r'[$＄)sS]?\d[\d.,\-–=]*', text) if '~~' not in text[max(0, m.start()-2):m.end()+2]]
            if not tokens:
                continue
            middle=(word['box'][0]+word['box'][2]/2-row['box'][0])/max(1e-6, row['box'][2])
            token=min(tokens, key=lambda m: abs((m.start()+m.end())/2/len(text)-middle))
            strike, start, end=found_strike
            # The line through the digits misleads OCR ($14 → $55): erase it (and its anti-aliased
            # edges) and read the word again on its own.
            clean=pixels[wy0:wy1, wx0:wx1].copy()
            for r in range(max(0, min(strike)-1), min(clean.shape[0], max(strike)+2)):
                clean[r][ink[r]]=style['background']
            border=12
            canvas=Image.new('RGB', (clean.shape[1]+2*border, clean.shape[0]+2*border), style['background'])
            canvas.paste(Image.fromarray(clean.astype('uint8')), (border, border))
            price=lambda t: re.sub(r'^[)sS]', '$', tidy_ocr_text(t.replace(' ', '')))  # small `$` read as `s` or `)`
            readings=[{'text': price(word['text']), 'confidence': word.get('confidence', .5)}, {'text': price(token[0]), 'confidence': row['confidence']}]
            for scale in (2, 3, 4):
                found=ocr_lines(canvas.resize((canvas.width*scale, canvas.height*scale), Image.LANCZOS), psm='7')
                if found:
                    readings.append({'text': price(''.join(r['text'] for r in found)), 'confidence': min(r['confidence'] for r in found)})
            readings=[r for r in readings if re.fullmatch(r'[$＄]?\d[\d.,\-]*', r['text'])]
            value=_vote(readings)['text'] if readings else word['text']
            text=text[:token.start()]+_mark_strike(value, start, end)+text[token.end():]
        # Tesseract row boxes are often taller than the glyphs; trim them to the inked pixel rows.
        inked=np.flatnonzero(style['ink'].any(axis=1));top, bottom=y0+int(inked[0]), y0+int(inked[-1])+1
        box=[row['box'][0], top/image.height, row['box'][2], (bottom-top)/image.height]
        columns=np.flatnonzero(style['ink'].any(axis=0))
        styled.append({**row, 'text': text, 'style': style, 'box': box, 'height': bottom-top, 'ink_width': int(columns[-1]-columns[0]+1)})
    if not styled:
        raise HTTPException(422, '這個區域沒有識別到文字，請縮小框選範圍或直接輸入')
    x0=min(r['box'][0] for r in styled);y0=min(r['box'][1] for r in styled)
    x1=max(r['box'][0]+r['box'][2] for r in styled);y1=max(r['box'][1]+r['box'][3] for r in styled)
    bounds=[x0,y0,x1-x0,y1-y0]
    heights=[r['box'][3] for r in styled];height=statistics.median(heights)
    main=max(styled, key=lambda r: r['box'][2]*r['box'][3])
    color=main['style']['color']
    # Rows with very different sizes or colors cannot be reproduced by one text layer.
    mixed=(max(heights)/max(1e-6, min(heights)) > 1.5
           or any(max(abs(a-b) for a, b in zip(r['style']['color'], color)) > 60 for r in styled))
    badge=any(r['style']['background'] != tuple(int(v) for v in paper) for r in styled)
    if len(styled) > 1:
        lefts=[r['box'][0] for r in styled];rights=[r['box'][0]+r['box'][2] for r in styled]
        centers=[(a+b)/2 for a, b in zip(lefts, rights)]
        spread={'left': max(lefts)-min(lefts), 'center': max(centers)-min(centers), 'right': max(rights)-min(rights)}
        align=min(spread, key=lambda k: spread[k]-(.01 if k == 'left' else 0))
        tops=sorted(r['box'][1] for r in styled)
        pitch=(tops[-1]-tops[0])/(len(tops)-1)
    else:
        margin_left, margin_right=x0, 1-(x0+bounds[2])
        align='center' if margin_left > .12 and abs(margin_left-margin_right) < .06 else 'left'
        pitch=None
    # CJK glyphs are exactly one em wide, which measures the font size far better than ink height
    # (that varies by typeface: the poster's 黑體 is taller than PingFang). Pure-CJK rows only.
    ems=[r['ink_width']/(len(plain)-.1) for r in styled
         if len(plain:=re.sub(r'[~*\s]', '', r['text'])) >= 2 and re.fullmatch(rf'[{CJK}]+', plain)]
    if not ems:
        # Mixed rows (`提拉米蘇朱古力 (各款)`): measure runs of consecutive CJK words instead.
        for r in styled:
            run=[]
            for w in sorted(r.get('words', []), key=lambda w: w['box'][0])+[None]:
                if w and re.fullmatch(rf'[{CJK}]+', w['text']):
                    run.append(w);continue
                count=sum(len(x['text']) for x in run)
                if count >= 2:
                    ems.append((run[-1]['box'][0]+run[-1]['box'][2]-run[0]['box'][0])*image.width/(count-.1))
                run=[]
    em=statistics.median(ems) if ems else height*image.height/.92
    font_ratio=em/image.height
    # One layer has one base weight; a row clearly heavier than the majority (e.g. a bold brand
    # line above regular product text) is marked **bold** for the editor.
    weights=[_weight(r['style']['stroke'], em) for r in styled]
    base=min(set(weights), key=lambda w: (-weights.count(w), w))
    strokes=statistics.median(r['style']['stroke'] for r in styled)
    for r in styled:
        if len(styled) > 1 and r['style']['stroke'] >= strokes*1.3:
            r['text']=f"**{r['text']}**"
    return {'text':'\n'.join(r['text'] for r in styled),'confidence':min(r['confidence'] for r in styled),
            'box':bounds,'color':'#%02x%02x%02x'%color,'fontSizeRatio':font_ratio,'align':align,
            'weight':base,
            'lineHeight':round(min(2.5, max(1, pitch/font_ratio)), 3) if pitch else None,
            'mixed':bool(mixed),'badge':bool(badge),'offer':_price_offer(styled, image if price else None)}