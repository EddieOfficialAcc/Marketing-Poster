"""Read activity worksheets; never evaluate formulas or guess product identity."""
import csv
import io
import re
import zipfile
from datetime import datetime, date
from decimal import Decimal, InvalidOperation
from fastapi import HTTPException
from openpyxl import load_workbook

ALIASES = {
    "price2": "price2", "第二件售價": "price2", "第二件售价": "price2",
    "originalPrice2": "originalPrice2", "第二件原價": "originalPrice2", "第二件原价": "originalPrice2",
    "code3": "code3", "商品編號3": "code3", "code4": "code4", "商品編號4": "code4", "code2": "code2", "Code2": "code2", "商品編號2": "code2", "商品编号2": "code2",
    "code": "sku", "Code": "sku", "CODE": "sku",
    "productid": "productid", "ProductID": "productid", "ProductId": "productid", "product_id": "productid", "Item_ID": "productid", "商品ID": "productid",
    "原價": "originalPrice", "原价": "originalPrice", "原價上限": "originalPriceMax", "原价上限": "originalPriceMax",
    "原價刪除線": "originalStrike", "原价删除线": "originalStrike", "平均價取整": "averageRounding", "平均价取整": "averageRounding",
    "促銷角標": "badge", "促销角标": "badge",

    "活动名称": "campaign", "活動名稱": "campaign",
    "商品名称": "name", "商品名稱": "name",
    "商品编号": "sku", "商品編號": "sku", "SKU": "sku", "条码": "sku", "條碼": "sku",
    "规格": "spec", "規格": "spec", "包装规格": "spec", "包裝規格": "spec",
    "优惠总价": "price", "優惠總價": "price", "活动价": "price", "活動價": "price",
    "优惠件数": "quantity", "優惠件數": "quantity",
    "开始日期": "start", "開始日期": "start", "结束日期": "end", "結束日期": "end",
    "适用门店": "stores", "適用門店": "stores",
}
REQUIRED = {"campaign", "name", "price", "quantity", "start", "end", "stores"}


def text(value):
    return "" if value is None else str(value).strip()


def day(value):
    if isinstance(value, (date, datetime)):
        return value.strftime("%Y-%m-%d")
    try:
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", text(value)):
            raise ValueError()
        return datetime.strptime(text(value), "%Y-%m-%d").strftime("%Y-%m-%d")
    except ValueError as exc:
        raise ValueError("日期須為有效的 YYYY-MM-DD 格式，例如 2026-11-01") from exc


def parse_rows(rows, row_numbers=None, max_rows=12):
    if not rows:
        raise HTTPException(422, "表格沒有資料")
    headers = [ALIASES.get(text(v), text(v)) for v in rows[0]]
    present = [h for h in headers if h in set(ALIASES.values())]
    if len(set(present)) != len(present):
        raise HTTPException(422, "存在重複欄位，請保留唯一的商品編號、名稱及價格欄")
    missing = REQUIRED - set(headers)
    if "productid" in headers or "sku" in headers:
        missing.discard("name")
    if missing:
        raise HTTPException(422, "缺少欄位：" + "、".join(sorted(missing)))
    records, errors, campaigns = [], [], set()
    for index, row in enumerate(rows[1:], 1):
        row_number = row_numbers[index] if row_numbers else index + 1
        if not any(text(v) for v in row):
            continue
        if len(records) >= max_rows:
            raise HTTPException(422, f"目前單張海報最多匯入 {max_rows} 件商品，請拆分活動表；系統不會截斷或丟棄其餘商品")
        raw = dict(zip(headers, row))
        if any(isinstance(v, str) and v.startswith("=") for v in row):
            errors.append(f"第 {row_number} 行包含公式，請貼上數值後匯入")
            continue
        try:
            record = {k: text(raw.get(k)) for k in ("campaign", "name", "spec", "stores")}
            productid = text(raw.get("productid"))
            if productid:
                value = Decimal(productid)
                if not value.is_finite() or value != value.to_integral_value() or not 1 <= value <= 2147483647:
                    raise ValueError("productid 必須為正整數 Item_ID")
                record["productid"] = str(int(value))
            if not record["name"] and not productid and not text(raw.get("sku")):
                raise ValueError("請填寫商品名稱或 code")
            if any(not record[k] for k in ("campaign", "stores")):
                raise ValueError("活動名稱、商品名稱及門店不可空白")
            if any(len(v) > 100 for v in record.values()):
                raise ValueError("文字欄位不可超過 100 字")
            sku = raw.get("sku")
            if sku is not None and not isinstance(sku, str):
                raise ValueError("商品編號／條碼必須設為文字格式，避免前導零遺失")
            record["sku"] = text(sku)
            if record["sku"] and any(text(h) in {"code", "Code", "CODE", "商品编号", "商品編號", "SKU"} for h in rows[0]):
                record["code"] = record["sku"]
            for number in (2, 3, 4):
                key = f"code{number}"
                value = raw.get(key)
                if text(value):
                    if not isinstance(value, str) or len(value.strip()) > 80:
                        raise ValueError(f"{key} 請填文字商品編號，最多 80 字")
                    if not record.get("code"):
                        raise ValueError(f"填寫 {key} 時，第一件商品也須填 code")
                    record[key] = value.strip()
            if (record.get('code3') or record.get('code4')) and text(raw.get('price2')):
                raise ValueError('三至四件商品請使用共用優惠；獨立售價只支援兩件')
            price_text = text(raw.get("price"))
            if not re.fullmatch(r"\d{1,7}(\.\d{1,2})?", price_text) or Decimal(price_text) <= 0:
                raise ValueError("優惠總價需大於零且最多兩位小數，不接受貨幣符號或平均價推算")
            record["price"] = price_text
            quantity = Decimal(text(raw.get("quantity")))
            if not quantity.is_finite() or quantity != quantity.to_integral_value() or not 1 <= quantity <= 99:
                raise ValueError("優惠件數需為 1–99 的整數")
            record["quantity"] = int(quantity)
            for key in ("price2", "originalPrice2"):
                value = text(raw.get(key))
                if value:
                    if not re.fullmatch(r"\d{1,7}(\.\d{1,2})?", value) or Decimal(value) <= 0:
                        raise ValueError("第二件售價／原價須為正數，最多兩位小數")
                    record[key] = value
            if record.get("price2") and (not record.get("code2") or record["quantity"] != 1):
                raise ValueError("第二件獨立售價須填 code2，優惠件數填 1（兩件各自售價，不是組合優惠）")
            if record.get("originalPrice2") and not record.get("price2"):
                raise ValueError("第二件原價須配合第二件獨立售價")
            for key in ("originalPrice", "originalPriceMax"):
                value=text(raw.get(key))
                if value and (not re.fullmatch(r"\d{1,7}(\.\d{1,2})?", value) or Decimal(value)<=0):
                    raise ValueError("原價須為正數且最多兩位小數")
                if value:record[key]=value
            if record.get("originalPriceMax") and (not record.get("originalPrice") or Decimal(record["originalPriceMax"])<Decimal(record["originalPrice"])):
                raise ValueError("原價區間上限不可小於下限")
            rounding=text(raw.get("averageRounding"))
            if rounding:
                choices={"整元":"integer","一位小數":"tenth","一位小数":"tenth","兩位小數":"cent","两位小数":"cent","integer":"integer","tenth":"tenth","cent":"cent"}
                if rounding not in choices:raise ValueError("平均價取整須為整元、一位小數或兩位小數")
                record["averageRounding"]=choices[rounding]
            strike=text(raw.get("originalStrike")).lower()
            if strike:
                if strike not in ("是","否","true","false","1","0"):raise ValueError("原價刪除線須填是或否")
                record["originalStrike"]=strike in ("是","true","1")
            badge=text(raw.get("badge"))
            if badge:
                if badge not in ("新","熱賣","精選"):raise ValueError("促銷角標須填新、熱賣或精選")
                record["badge"]=badge

            record["start"], record["end"] = day(raw.get("start")), day(raw.get("end"))
            if record["start"] > record["end"]:
                raise ValueError("結束日期早於開始日期")
            record["row"] = row_number
            campaigns.add(tuple(record[k] for k in ("campaign", "start", "end", "stores")))
            records.append(record)
        except (ValueError, InvalidOperation) as exc:
            errors.append(f"第 {row_number} 行：{exc}")
    if len(campaigns) > 1:
        errors.append("同一張海報的活動名稱、日期及門店必須一致；請拆分不同活動或門店版本")
    if not records and not errors:
        errors.append("表格沒有商品資料")
    ignored = [h for h in headers if h and h not in set(ALIASES.values())]
    conditional = [h for h in ignored if any(word in h for word in ("会员", "會員", "积分", "積分", "折扣", "限购", "限購", "换购", "換購", "条件", "條件", "促销类型", "促銷類型"))]
    if conditional:
        errors.append("表格包含尚未支援的促銷條件：" + "、".join(conditional) + "；不能忽略這些條件生成一般價格海報")
    return {"rows": records, "errors": errors, "warnings": ["尚不支援的欄位（不會套用）：" + "、".join(ignored)] if ignored else []}



def content_rows(iterator):
    """Ignore styling-only cells while preserving original worksheet row numbers."""
    rows, numbers = [], []
    for number, values in enumerate(iterator, 1):
        if number > 10000:
            raise HTTPException(422, "表格超出 10,000 行掃描上限，請移除過多空白行或格式")
        row = list(values)
        while row and not text(row[-1]):
            row.pop()
        if not row:
            continue
        if len(rows) >= 200 or len(row) > 40:
            raise HTTPException(422, "表格有效內容超出 200 行或 40 欄的讀取上限")
        rows.append(row)
        numbers.append(number)
    return rows, numbers


def parse_campaign(data, kind, max_rows=12):
    if not data:
        raise HTTPException(422, "活動表不可為空")
    if len(data) > 5 * 1024 * 1024:
        raise HTTPException(413, "活動表不可超過 5 MB")
    if kind == "csv":
        try:
            reader = csv.reader(io.StringIO(data.decode("utf-8-sig")))
            rows, numbers = content_rows(reader)
        except UnicodeDecodeError as exc:
            raise HTTPException(422, "CSV 請使用 UTF-8 編碼") from exc
        return parse_rows(rows, numbers, max_rows)
    if kind != "xlsx":
        raise HTTPException(415, "支援 .xlsx 或 UTF-8 .csv；舊版 .xls 請先另存為 .xlsx")
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            if sum(info.file_size for info in archive.infolist()) > 40 * 1024 * 1024:
                raise HTTPException(413, "Excel 解壓後內容過大")
        workbook = load_workbook(io.BytesIO(data), read_only=True, data_only=False, keep_links=False)
        try:
            sheets = [s for s in workbook if s.sheet_state == "visible"]
            sheet = next((s for s in sheets if s.title in {"活动商品", "活動商品"}), None)
            if sheet is None:
                if len(sheets) != 1:
                    raise HTTPException(422, "請將要匯入的工作表命名為「活動商品」，避免讀取錯誤工作表")
                sheet = sheets[0]
            # Exporters may omit or under-report dimensions. Read actual XML rows,
            # bounded to one row beyond the limit; never trust the cached range.
            sheet.reset_dimensions()
            rows, numbers = content_rows(sheet.iter_rows(values_only=True))
            return parse_rows(rows, numbers, max_rows)
        finally:
            workbook.close()
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(422, "Excel 讀取失敗，請確認檔案完整且未加密") from exc
