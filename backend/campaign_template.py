"""Downloadable example matching the existing campaign importer exactly."""
from io import BytesIO
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.comments import Comment

HEADERS = ['活動名稱','商品名稱','code','規格','優惠總價','優惠件數','開始日期','結束日期','適用門店','原價','原價上限','原價刪除線','平均價取整','促銷角標','code2','price2','originalPrice2','code3','code4']

def template_bytes():
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = '活動商品'
    sheet.append(HEADERS)
    sheet.append(['示例活動（請修改）','','BD-101643','',33,2,'2026-11-01','2026-11-07','指定門店（請修改）',20,'','是','一位小數',''])
    widths = [28,30,22,22,18,18,20,20,30,18,18,18,18,18,22,20,20,22,22]
    for col, width in enumerate(widths, 1):
        letter = sheet.cell(1,col).column_letter
        sheet.column_dimensions[letter].width = width
        cell = sheet.cell(1,col)
        cell.fill = PatternFill('solid', fgColor='296B47')
        cell.font = Font(name='Microsoft JhengHei', bold=True, color='FFFFFF', size=11)
        cell.alignment = Alignment(vertical='center', wrap_text=True)
        for row in range(2,14):
            cell = sheet.cell(row,col)
            cell.font = Font(name='Microsoft JhengHei', size=11, color='234B72')
            cell.fill = PatternFill('solid', fgColor='FFF5DF')
            cell.alignment = Alignment(vertical='center', wrap_text=True)
            cell.number_format = '0.00' if col == 5 else '0' if col == 6 else '@'
    sheet['A2'].comment = Comment('此行僅為填寫示例。請替換為真實活動及商品資料後再上傳。','優品360')
    sheet['C1'].comment = Comment('填 POS item.code，例如 BD-101643，並非數字 productid。自動查詢名稱及商品圖片，名稱可留空。示例價格不代表真實售價。','優品360')
    sheet['E1'].comment = Comment('填寫優惠總價（HK$），最多兩位小數。例如 2 件合計 $33，此欄填 33，優惠件數填 2。','優品360')
    sheet['G1'].comment = Comment('日期格式 YYYY-MM-DD。所有商品行須使用相同活動、日期及適用門店。最多 12 行商品；公式請先貼上數值。','優品360')
    sheet['J1'].comment = Comment('以下五欄為選填，使用至優價商品排版時顯示。原價上限僅用於價格區間。','優品360')
    sheet['M1'].comment = Comment('填整元、一位小數或兩位小數。僅控制平均每件顯示，不改動優惠總價。','優品360')
    sheet.freeze_panes = 'A2'
    sheet.auto_filter.ref = 'A1:S13'
    sheet['P1'].comment = Comment('第二件獨立售價：對應 code2。兩件各自售價時填寫，優惠件數填 1；留空表示共用優惠。', 'User')
    sheet['Q1'].comment = Comment('第二件原價：對應 code2，配合 price2 使用。', 'User')
    sheet['O1'].comment = Comment('選填第二件商品的 item.code。同一行兩件商品的圖片會放在同一格；名稱、規格、總價與件數仍使用這一行，請按實際優惠填寫。','User')
    for col in ('R1','S1'):
        sheet[col].comment = Comment('同一格的第三／第四件商品 code；共用本行優惠資料，圖片張數不代表優惠件數。', 'User')
    sheet.row_dimensions[1].height = 32
    for row in range(2,14):
        sheet.row_dimensions[row].height = 32
    sheet.sheet_view.showGridLines = False
    output = BytesIO()
    workbook.save(output)
    return output.getvalue()
