#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成《地铁车型完整清单》工作簿（44 款车型 + 城市分布 + 解锁规则）。"""

try:
    import openpyxl
except ImportError:
    import subprocess, sys
    subprocess.check_call([sys.executable, "-m", "pip", "install", "--quiet", "openpyxl>=3.1.0"])
    import openpyxl

from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.formatting.rule import FormulaRule
from openpyxl.utils import get_column_letter


def xl_color(css_hex: str) -> str:
    value = css_hex.removeprefix("#").upper()
    if len(value) != 6:
        raise ValueError(f"Expected #RRGGBB, got: {css_hex}")
    return "FF" + value


XL_PRIMARY = xl_color("#4472C4")     # 表头底色
XL_DARK = xl_color("#2F5597")        # 标题底色
XL_LIGHT = xl_color("#D9E2F3")       # 浅底 / 说明区
XL_BAND = xl_color("#F2F5FB")        # 数据行交替浅底
XL_BORDER = xl_color("#BFBFBF")
XL_GREEN_FILL = xl_color("#C6EFCE")
XL_GREEN_TEXT = xl_color("#006100")
XL_RED_FILL = xl_color("#FFC7CE")
XL_RED_TEXT = xl_color("#9C0006")
XL_GREY_TEXT = xl_color("#7F7F7F")

thin_side = Side(style="thin", color=XL_BORDER)
BOX = Border(left=thin_side, right=thin_side, top=thin_side, bottom=thin_side)
BOTTOM = Border(bottom=thin_side)

# ---------------------------------------------------------------- 数据
# (车型名称, 代号, 适用范围, 开放年, 停售年, 每节单价, 每节定员, 最长编组, 最高速度, 运营系数, 寿命, 说明)
ROWS = [
    # 通用车型
    ("早期木质电动车", "gen-early", "通用", 1900, 1938, 110, 170, 6, 50, 1.05, 35, "木质车身、通风顶，车厢小、运营费用高"),
    ("战后钢制通勤车", "gen-classic", "通用", 1936, 1974, 170, 220, 6, 70, 1.03, 32, "全钢车身、整车涂装"),
    ("不锈钢 B 型车", "gen-steel", "通用", 1968, 2015, 300, 250, 8, 80, 1.00, 30, "车宽 2.8 m 的标准地铁车"),
    ("大运量 A 型车", "gen-a", "通用", 1985, 9999, 420, 310, 8, 80, 0.96, 30, "车宽 3 m、每节 5 对车门的大运量车"),
    ("D 型无人列车", "gen-d160", "通用", 2005, 9999, 620, 500, 8, 160, 0.75, 35,
     "固定 8 节编组、每节 500 人的全自动无人列车，只能在 160 km/h 高速轨道上运行；运营成本为基准的 0.75 倍"),
    ("节能变频车", "gen-eco", "通用", 2008, 9999, 460, 300, 8, 100, 0.85, 30, "永磁电机与再生制动，运营费用低"),
    ("全自动无人驾驶车", "gen-auto", "通用", 2025, 9999, 540, 320, 8, 120, 0.75, 30, "无人驾驶、贯通客室，运营费用最低"),
    # 广州
    ("广州地铁 A1 型（西门子）", "gz-a1", "广州", 1995, 2004, 560, 310, 6, 80, 0.97, 30, "1 号线引进车，白色车身配线路色带"),
    ("广州地铁直线电机 L4 型", "gz-l4", "广州", 2005, 2016, 420, 240, 6, 90, 0.93, 30, "4、5 号线直线电机车，爬坡与过弯能力强"),
    ("广州地铁 A 型（国产 8 节）", "gz-a8", "广州", 2010, 9999, 400, 310, 8, 80, 0.88, 30, "国产化 A 型车，可编 8 节"),
    # 上海
    ("上海地铁 AC01 型（德国制造）", "sh-ac01", "上海", 1993, 1999, 600, 310, 8, 80, 0.98, 30, "1 号线首批引进车"),
    ("上海地铁 A 型（国产化）", "sh-a", "上海", 2003, 9999, 420, 310, 8, 80, 0.90, 30, "国产化后的大运量车"),
    ("上海地铁 16 号线快车型", "sh-16", "上海", 2013, 9999, 480, 300, 8, 120, 0.90, 30, "最高 120 km/h 的郊区快线车"),
    # 北京
    ("北京地铁 DK 系列（长春客车厂）", "bj-dk", "北京", 1969, 2000, 200, 240, 6, 80, 1.00, 30, "1 号线、环线的早期国产车"),
    ("北京地铁 SFM04 型", "bj-sfm04", "北京", 2002, 2008, 340, 250, 6, 80, 0.96, 30, "13 号线、八通线的不锈钢车"),
    ("北京地铁 B 型（4 号线等）", "bj-b", "北京", 2008, 9999, 360, 250, 8, 80, 0.90, 30, "奥运前后新线的车型"),
    ("北京地铁 A 型（6 号线、14 号线）", "bj-a", "北京", 2012, 9999, 420, 310, 8, 80, 0.88, 30, "大运量干线车"),
    # 杭州
    ("杭州地铁 B 型（1 号线）", "hz-b1", "杭州", 2010, 9999, 380, 250, 6, 80, 0.92, 30, "杭州首批地铁车"),
    ("杭州地铁 A 型", "hz-a", "杭州", 2017, 9999, 420, 310, 8, 80, 0.86, 30, "后期线路的大运量车"),
    # 武汉
    ("武汉轨道交通 1 号线 B 型", "wh-b1", "武汉", 2003, 2014, 360, 250, 6, 80, 0.98, 30, "高架轻轨线的首批车辆"),
    ("武汉地铁 A 型", "wh-a", "武汉", 2012, 9999, 410, 310, 8, 80, 0.88, 30, "大运量线路车型"),
    # 香港
    ("港铁 M-Train（都城嘉慕）", "hk-m", "中国香港", 1977, 1995, 520, 330, 8, 80, 1.00, 40, "修正早期系统的不锈钢车，红色色带"),
    ("港铁 K-Stock（现代 Rotem）", "hk-k", "中国香港", 2001, 2012, 560, 330, 8, 80, 0.93, 30, "将军澳线与东涌线的新车"),
    ("港铁 Q-Train（中车长客）", "hk-q", "中国香港", 2020, 9999, 520, 330, 8, 80, 0.84, 30, "更新换代的新列车"),
    # 台北
    ("台北捷运 C301 型（川崎重工）", "tp-c301", "中国台北", 1994, 2004, 560, 290, 6, 80, 0.98, 30, "高运量系统首批车辆"),
    ("台北捷运 C371 型", "tp-c371", "中国台北", 2004, 2013, 520, 290, 6, 80, 0.92, 30, "新庄线、芦洲线等的车辆"),
    ("台北捷运 C381 型", "tp-c381", "中国台北", 2012, 9999, 500, 290, 6, 80, 0.86, 30, "信义线、松山线的新车"),
    # 巴黎
    ("巴黎地铁 M1 木质车", "pa-m1", "巴黎", 1900, 1910, 100, 160, 6, 40, 1.05, 30, "1900 年开通时的木质车厢"),
    ("巴黎地铁 Sprague-Thomson", "pa-st", "巴黎", 1908, 1937, 120, 180, 6, 70, 1.00, 50, "全钢车身，墨绿涂装，服役半个多世纪"),
    ("巴黎地铁 MP 59（胶轮）", "pa-mp59", "巴黎", 1956, 1966, 220, 210, 6, 80, 0.98, 30, "胶轮车，加速快、噪声小"),
    ("巴黎地铁 MF 67", "pa-mf67", "巴黎", 1967, 1978, 220, 220, 6, 80, 0.97, 30, "钢轮车的大规模更新"),
    ("巴黎地铁 MF 77", "pa-mf77", "巴黎", 1978, 1990, 260, 230, 6, 80, 0.95, 30, "白色车身，7、8、13 号线"),
    ("巴黎地铁 MP 89（胶轮）", "pa-mp89", "巴黎", 1995, 2007, 320, 230, 6, 80, 0.90, 30, "贯通客室的胶轮车，14 号线无人驾驶"),
    ("巴黎地铁 MF 01", "pa-mf01", "巴黎", 2008, 2018, 340, 240, 6, 80, 0.86, 30, "钢轮线路的新一代车"),
    ("巴黎地铁 MP 14", "pa-mp14", "巴黎", 2019, 9999, 380, 240, 8, 80, 0.78, 30, "全自动运行的胶轮车"),
    # 东京
    ("东京地下铁道 1000 形", "tk-1000", "东京", 1927, 1938, 120, 170, 6, 50, 1.00, 40, "银座线开通时的黄色车"),
    ("营团 300 形（丸之内线）", "tk-300", "东京", 1953, 1962, 200, 210, 6, 80, 1.00, 30, "红色车身配白带"),
    ("营团 2000 形（银座线）", "tk-2000", "东京", 1958, 1968, 190, 200, 6, 80, 1.00, 30, "银座线的黄色车"),
    ("营团 5000 系（不锈钢）", "tk-5000", "东京", 1964, 1981, 260, 250, 8, 80, 0.97, 30, "东西线等的不锈钢车"),
    ("营团 01 系", "tk-01", "东京", 1983, 1997, 300, 220, 6, 80, 0.94, 30, "银座线的新一代车"),
    ("营团 05 系", "tk-05", "东京", 1988, 2004, 320, 250, 8, 80, 0.92, 30, "东西线的铝合金车"),
    ("东京地铁 10000 系", "tk-10000", "东京", 2006, 2016, 380, 250, 8, 80, 0.88, 30, "有乐町线、副都心线"),
    ("东京地铁 1000 系（复古涂装）", "tk-n1000", "东京", 2012, 2017, 360, 220, 6, 80, 0.86, 30, "银座线的复古黄色新车"),
    ("东京地铁 13000 系", "tk-13000", "东京", 2016, 9999, 400, 250, 8, 80, 0.84, 30, "日比谷线的新车"),
]

MAP_TITLE = {
    "广州": "广州 · 2000", "上海": "上海 · 1990", "北京": "北京 · 1990",
    "杭州": "杭州 · 2000", "武汉": "武汉 · 2000", "中国香港": "香港 · 1970",
    "中国台北": "台北 · 1990", "巴黎": "巴黎 · 1900", "东京": "东京 · 1950",
}
CITY_ORDER = ["通用", "广州", "上海", "北京", "杭州", "武汉", "中国香港", "中国台北", "巴黎", "东京"]


def unlock_text(mid, scope, y0, y1):
    if mid == "gen-d160":
        return "2005 年起；需本局已有 160 km/h 线路（车辆段购车同样要求）；固定 8 节编组"
    if mid == "gen-auto":
        return "2025 年起；上市后其余普通车型停售，仅本车型与 D 型车可买"
    if scope == "通用":
        base = "%d 年起（通用车型，所有地图可买）" % y0
    else:
        base = "%d 年起，且当前地图为「%s」" % (y0, MAP_TITLE[scope])
    if y1 < 9999:
        base += "；%d 年起停售" % (y1 + 1)
    else:
        base += "；2025 年起停售（无人驾驶时代）"
    return base


def after_2025(mid):
    if mid == "gen-auto":
        return "在售（唯一主力）"
    if mid == "gen-d160":
        return "在售（160 专用）"
    return "停售"


HEADERS = ["序号", "车型名称", "代号", "适用范围", "开放年份", "停售年份", "2025 年后",
           "解锁条件", "每节单价\n（万元）", "最长编组\n（节）", "整列基准价\n（万元）",
           "每节定员\n（人）", "整列定员\n（人）", "最高速度\n（km/h）", "运营成本\n系数",
           "设计寿命\n（年）", "备注"]
WIDTHS = [6, 30, 12, 10, 9, 9, 14, 46, 11, 9, 12, 9, 10, 10, 9, 9, 46]

wb = Workbook()
wb.properties.title = "地铁车型完整清单"

# ======================================================== Sheet1 车型清单
ws = wb.active
ws.title = "车型清单"
LAST_COL = len(HEADERS)
last_letter = get_column_letter(LAST_COL)
HDR = 3
FIRST = HDR + 1
LAST = FIRST + len(ROWS) - 1

ws.merge_cells("A1:%s1" % last_letter)
t = ws["A1"]
t.value = "地铁车型完整清单 · 共 %d 款" % len(ROWS)
t.font = Font(size=16, bold=True, color="FFFFFFFF")
t.fill = PatternFill("solid", fgColor=XL_DARK)
t.alignment = Alignment(horizontal="left", vertical="center", indent=1)
ws.row_dimensions[1].height = 30

ws.merge_cells("A2:%s2" % last_letter)
n = ws["A2"]
n.value = ("数据源：js/fleet.js 的 MODELS 表（游戏 v3.7）。解锁只看「年份 + 城市」；"
          "2025 年全自动无人驾驶车上市后，除它与 160 专用的 D 型车外全部停售。"
          "单价为 1990 年基准价（万元/节），实付还要乘本城造价系数、当年造价指数与难度系数。")
n.font = Font(size=10, color="FF1A1A1A")
n.fill = PatternFill("solid", fgColor=XL_LIGHT)
n.alignment = Alignment(horizontal="left", vertical="center", wrap_text=True, indent=1)
ws.row_dimensions[2].height = 34

for c, name in enumerate(HEADERS, start=1):
    cell = ws.cell(row=HDR, column=c, value=name)
    cell.font = Font(bold=True, color="FFFFFFFF", size=10)
    cell.fill = PatternFill("solid", fgColor=XL_PRIMARY)
    cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
    cell.border = BOX
ws.row_dimensions[HDR].height = 32

for i, row in enumerate(ROWS):
    r = FIRST + i
    name, mid, scope, y0, y1, price, cap, cars, kmh, ops, life, desc = row
    values = [
        i + 1, name, mid, scope, y0, y1, after_2025(mid),
        unlock_text(mid, scope, y0, y1),
        price, cars, "=I%d*J%d" % (r, r), cap, "=L%d*J%d" % (r, r), kmh, ops, life, desc,
    ]
    for c, v in enumerate(values, start=1):
        cell = ws.cell(row=r, column=c, value=v)
        cell.border = BOTTOM
        cell.font = Font(size=10)
        if c in (1, 4, 5, 6, 7, 10, 12, 14, 15, 16):
            cell.alignment = Alignment(horizontal="center", vertical="center")
        elif c in (2, 3):
            cell.alignment = Alignment(horizontal="left", vertical="center")
        elif c in (8, 17):
            cell.alignment = Alignment(horizontal="left", vertical="center", wrap_text=True)
        else:
            cell.alignment = Alignment(horizontal="right", vertical="center")
        if c in (9, 11):
            cell.number_format = "#,##0"
        elif c in (5, 6, 10, 12, 14, 16):
            cell.number_format = "0"
        elif c in (13,):
            cell.number_format = "#,##0"
        elif c in (15,):
            cell.number_format = "0.00"
        if i % 2 == 1 and c not in (1,):
            cell.fill = PatternFill("solid", fgColor=XL_BAND)

# 2025 后状态：在售绿、停售红字
ws.conditional_formatting.add(
    "G%d:G%d" % (FIRST, LAST),
    FormulaRule(formula=['LEFT($G%d,2)="在售"' % FIRST],
                fill=PatternFill("solid", bgColor=XL_GREEN_FILL),
                font=Font(color=XL_GREEN_TEXT, bold=True), stopIfTrue=False))
ws.conditional_formatting.add(
    "G%d:G%d" % (FIRST, LAST),
    FormulaRule(formula=['$G%d="停售"' % FIRST],
                fill=PatternFill("solid", bgColor=XL_RED_FILL),
                font=Font(color=XL_RED_TEXT), stopIfTrue=False))

for c, w in enumerate(WIDTHS, start=1):
    ws.column_dimensions[get_column_letter(c)].width = w
ws.freeze_panes = "B%d" % FIRST
ws.auto_filter.ref = "A%d:%s%d" % (HDR, last_letter, LAST)
ws.sheet_view.zoomScale = 100

# ======================================================== Sheet2 城市分布
ws2 = wb.create_sheet("城市分布")
ws2.merge_cells("A1:F1")
c = ws2["A1"]
c.value = "车型数量与在售情况分布"
c.font = Font(size=14, bold=True, color="FFFFFFFF")
c.fill = PatternFill("solid", fgColor=XL_DARK)
c.alignment = Alignment(horizontal="left", vertical="center", indent=1)
ws2.row_dimensions[1].height = 28

ws2.merge_cells("A2:F2")
c = ws2["A2"]
c.value = "下表全部由「车型清单」自动统计；「2025 后可买」统计的是 2025 年无人驾驶时代仍能购买的车型。"
c.font = Font(size=10, color="FF1A1A1A")
c.fill = PatternFill("solid", fgColor=XL_LIGHT)
c.alignment = Alignment(horizontal="left", vertical="center", wrap_text=True, indent=1)
ws2.row_dimensions[2].height = 28

h2 = ["适用范围", "车型数", "占比", "2025 后可买", "平均每节单价\n（万元）", "备注"]
for i, name in enumerate(h2, start=1):
    cell = ws2.cell(row=3, column=i, value=name)
    cell.font = Font(bold=True, color="FFFFFFFF", size=10)
    cell.fill = PatternFill("solid", fgColor=XL_PRIMARY)
    cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
    cell.border = BOX
ws2.row_dimensions[3].height = 32

S_FIRST = 4
S_LAST = S_FIRST + len(CITY_ORDER) - 1
TOTAL_ROW = S_LAST + 1
NOTE2 = {
    "通用": "各图通用，含 160 专用 D 型车",
    "广州": "广州 · 2000 图",
    "上海": "上海 · 1990 图",
    "北京": "北京 · 1990 图",
    "杭州": "杭州 · 2000 图",
    "武汉": "武汉 · 2000 图",
    "中国香港": "香港 · 1970 图",
    "中国台北": "台北 · 1990 图",
    "巴黎": "巴黎 · 1900 图",
    "东京": "东京 · 1950 图",
}
for i, city in enumerate(CITY_ORDER):
    r = S_FIRST + i
    ws2.cell(row=r, column=1, value=city)
    ws2.cell(row=r, column=2, value='=COUNTIF(车型清单!$D$%d:$D$%d,$A%d)' % (FIRST, LAST, r))
    ws2.cell(row=r, column=3, value='=IF($B$%d=0,"",B%d/$B$%d)' % (TOTAL_ROW, r, TOTAL_ROW))
    ws2.cell(row=r, column=4,
             value='=COUNTIFS(车型清单!$D$%d:$D$%d,$A%d,车型清单!$G$%d:$G$%d,"在售*")'
                   % (FIRST, LAST, r, FIRST, LAST))
    ws2.cell(row=r, column=5,
             value='=IF($B%d=0,"",SUMPRODUCT((车型清单!$D$%d:$D$%d=$A%d)*车型清单!$I$%d:$I$%d)/$B%d)'
                   % (r, FIRST, LAST, r, FIRST, LAST, r))
    ws2.cell(row=r, column=6, value=NOTE2[city])
    for cc in range(1, 7):
        cell = ws2.cell(row=r, column=cc)
        cell.font = Font(size=10)
        cell.border = BOTTOM
        cell.alignment = Alignment(horizontal="center" if cc in (2, 3, 4, 5) else "left",
                                   vertical="center")
    ws2.cell(row=r, column=3).number_format = "0.0%"
    ws2.cell(row=r, column=5).number_format = "#,##0"

ws2.cell(row=TOTAL_ROW, column=1, value="合计")
ws2.cell(row=TOTAL_ROW, column=2, value="=SUM(B%d:B%d)" % (S_FIRST, S_LAST))
ws2.cell(row=TOTAL_ROW, column=3, value='=IF($B$%d=0,"",$B$%d/$B$%d)' % (TOTAL_ROW, TOTAL_ROW, TOTAL_ROW))
ws2.cell(row=TOTAL_ROW, column=4, value="=SUM(D%d:D%d)" % (S_FIRST, S_LAST))
ws2.cell(row=TOTAL_ROW, column=5,
         value='=IF($B$%d=0,"",SUMPRODUCT(车型清单!$I$%d:$I$%d)/$B$%d)'
               % (TOTAL_ROW, FIRST, LAST, TOTAL_ROW))
ws2.cell(row=TOTAL_ROW, column=6, value="共 9 张真实城市图 + 通用车型")
for cc in range(1, 7):
    cell = ws2.cell(row=TOTAL_ROW, column=cc)
    cell.font = Font(size=10, bold=True)
    cell.fill = PatternFill("solid", fgColor=XL_LIGHT)
    cell.border = Border(top=thin_side, bottom=thin_side, left=thin_side, right=thin_side)
    cell.alignment = Alignment(horizontal="center" if cc != 6 else "left", vertical="center")
ws2.cell(row=TOTAL_ROW, column=3).number_format = "0.0%"
ws2.cell(row=TOTAL_ROW, column=5).number_format = "#,##0"

for col, w in zip("ABCDEF", [12, 10, 9, 12, 14, 30]):
    ws2.column_dimensions[col].width = w
ws2.freeze_panes = "A4"
ws2.auto_filter.ref = "A3:F%d" % S_LAST

# ======================================================== Sheet3 解锁规则
ws3 = wb.create_sheet("解锁规则")
ws3.merge_cells("A1:D1")
c = ws3["A1"]
c.value = "车型解锁规则与待确认事项"
c.font = Font(size=14, bold=True, color="FFFFFFFF")
c.fill = PatternFill("solid", fgColor=XL_DARK)
c.alignment = Alignment(horizontal="left", vertical="center", indent=1)
ws3.row_dimensions[1].height = 28

ws3.merge_cells("A2:D2")
c = ws3["A2"]
c.value = ("本作没有车型等级、研发、任务、活动或付费解锁——买到即用。"
          "真正决定「能不能买」的只有：年份窗口、所属城市、2025 无人驾驶时代、线路适配与站台编组。")
c.font = Font(size=10, color="FF1A1A1A")
c.fill = PatternFill("solid", fgColor=XL_LIGHT)
c.alignment = Alignment(horizontal="left", vertical="center", wrap_text=True, indent=1)
ws3.row_dimensions[2].height = 30

for i, name in enumerate(["类型", "项目", "规则说明", "对玩家的影响 / 建议"], start=1):
    cell = ws3.cell(row=3, column=i, value=name)
    cell.font = Font(bold=True, color="FFFFFFFF", size=10)
    cell.fill = PatternFill("solid", fgColor=XL_PRIMARY)
    cell.alignment = Alignment(horizontal="center", vertical="center")
    cell.border = BOX
ws3.row_dimensions[3].height = 24

RULES = [
    ("解锁条件", "年份窗口",
     "每款车都有固定开放年与停售年；配置里的 9999 表示「不限年份」，购车时按当前游戏年份判断。",
     "早于开放年、晚于停售年都买不到。同一时代通常只有 1–3 款在售，跨代要及时换车。"),
    ("解锁条件", "所属城市",
     "7 款通用车型所有地图可买；37 款城市专属车型只在该城市地图出售。",
     "例：广州专属 3 款只出现在「广州 · 2000」；巴黎专属 8 款最多，东京 9 款最多。"),
    ("解锁条件", "2025 无人驾驶时代",
     "全自动无人驾驶车 2025 年上市后，除它和 160 专用的 D 型无人列车外，其余车型一律停售。",
     "配置写 9999 的车型实际最多卖到 2024 年；已买的车仍可继续运营，只是不能再买。"),
    ("解锁条件", "160 轨道专用（D 型车）",
     "D 型无人列车只能跑 160 km/h 线路；车辆段购车也要求本局已有 160 线路。"
     "160 轨道 2005 年解锁，且沿线站台需大型及以上。",
     "没有 160 线路时，购车列表根本不显示 D 型车；固定 8 节，无法改小。"),
    ("运行限制", "线路速度适配",
     "线路运行速度 >80 km/h 时，只能选最高速度不低于该速度的车型；≤80 km/h 不限。",
     "120 km/h 线路只有上海 16 号线快车、全自动无人驾驶车可用；160 km/h 只有 D 型车。"),
    ("运行限制", "编组与站台",
     "编组不能超过车型最长编组，也不能超过沿线最短站台可容纳的节数；"
     "6 节需中型及以上站台，8 节需大型及以上站台。",
     "买 8 节车前先确认全线站台够大，否则列车只能减编或无法上线。"),
    ("资源消耗", "购车资金",
     "实付 = 每节单价 × 节数 × 本城造价系数 × 当年造价指数 × 难度「列车购买费」系数（0.1–3 倍）。"
     "表中单价为 1990 年基准价。",
     "同一款车在不同城市、不同年份、不同难度下价格不同；表中价格只用于横向比较。"),
    ("资源消耗", "维护与折旧",
     "运营成本系数 × 车公里数计入运营费；超过设计寿命后运营成本再 ×1.25；"
     "卖出按买价 75% 起直线折旧，最低 8%。",
     "老龄车不是不能跑，而是越跑越贵；表内「设计寿命」列可用来规划换车。"),
    ("资源消耗", "无其他门槛",
     "游戏内没有车型等级、研发点、任务奖励、活动限定、抽卡或内购付费解锁。",
     "所谓「解锁」只有年份 + 城市 + 上述适配规则；不存在漏做的任务导致车型锁死。"),
    ("待确认", "经典图与教程图缺城市专属车",
     "「广州 · 佛山 1990」地图 id 为 gz1990，「青湾」教程图为 tutorial，"
     "城市专属车型按 id 精确匹配，因此这两张图只能买 7 款通用车型。",
     "是否为设计意图待确认。若要修，应给这两张图加车型别名映射（如 gz1990 → gz），属代码改动。"),
    ("待确认", "活动 / 付费字段",
     "游戏为纯单机离线，无运营活动、无内购，故清单里没有「活动」「付费」两列。",
     "若后续加入 DLC 或活动限定车，需要补这两列；当前统一视为「不适用」。"),
]

RULE_FIRST = 4
for i, (kind, item, desc, effect) in enumerate(RULES):
    r = RULE_FIRST + i
    ws3.cell(row=r, column=1, value=kind)
    ws3.cell(row=r, column=2, value=item)
    ws3.cell(row=r, column=3, value=desc)
    ws3.cell(row=r, column=4, value=effect)
    for cc in range(1, 5):
        cell = ws3.cell(row=r, column=cc)
        cell.font = Font(size=10)
        cell.border = BOTTOM
        cell.alignment = Alignment(horizontal="center" if cc == 1 else "left",
                                   vertical="top", wrap_text=True)
    if kind == "待确认":
        ws3.cell(row=r, column=1).fill = PatternFill("solid", fgColor=XL_RED_FILL)
        ws3.cell(row=r, column=1).font = Font(size=10, bold=True, color=XL_RED_TEXT)
    else:
        ws3.cell(row=r, column=1).fill = PatternFill("solid", fgColor=XL_LIGHT)

for col, w in zip("ABCD", [12, 24, 66, 56]):
    ws3.column_dimensions[col].width = w
ws3.freeze_panes = "A4"
ws3.auto_filter.ref = "A3:D%d" % (RULE_FIRST + len(RULES) - 1)

OUT = r"D:/迅雷下载/city-and-metro-main/city-and-metro-main/地铁车型完整清单.xlsx"
wb.save(OUT)
print("saved", OUT, "rows", len(ROWS))
