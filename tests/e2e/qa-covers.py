# -*- coding: utf-8 -*-
"""生成 2:3 测试封面（带边线与文字），用于核对书架封面的显示比例。
输出到临时目录，不写进项目产物。"""
import os
import sys
from PIL import Image, ImageDraw, ImageFont

OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.environ.get('TEMP', '.'), 'jiuge-cover-fixtures')
os.makedirs(OUT, exist_ok=True)

SPECS = [
    ('cover-a.png', (58, 74, 108), '程序员\n修炼之道', 'The Pragmatic\nProgrammer'),
    ('cover-b.png', (232, 196, 84), '小强\n升职记', 'JOB HOPPING'),
    ('cover-c.png', (36, 44, 40), '股票\n大作手\n回忆录', 'REMINISCENCES'),
]

def font(size):
    for name in ('msyhbd.ttc', 'msyh.ttc', 'simhei.ttf'):
        p = os.path.join(os.environ.get('WINDIR', r'C:\Windows'), 'Fonts', name)
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                pass
    return ImageFont.load_default()

for name, rgb, zh, en in SPECS:
    w, h = 300, 450  # 严格的 2:3
    bg = tuple(max(0, min(255, c)) for c in rgb)
    im = Image.new('RGB', (w, h), bg)
    d = ImageDraw.Draw(im)
    # 四周留 2px 边框，用来一眼看出有没有被裁掉
    d.rectangle([0, 0, w - 1, h - 1], outline=(250, 250, 250), width=3)
    d.rectangle([12, 12, w - 13, h - 13], outline=(255, 255, 255), width=1)
    y = 90
    for line in zh.split('\n'):
        d.text((30, y), line, font=font(40), fill=(250, 250, 250))
        y += 56
    y = h - 120
    for line in en.split('\n'):
        d.text((30, y), line, font=font(18), fill=(235, 235, 235))
        y += 24
    d.text((30, h - 40), '九格 · 比例测试', font=font(14), fill=(210, 210, 210))
    p = os.path.join(OUT, name)
    im.save(p, 'PNG')
    print(p)
