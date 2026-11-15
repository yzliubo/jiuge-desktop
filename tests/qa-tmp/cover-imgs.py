# -*- coding: utf-8 -*-
"""封面抽取探针用的图片：一张大到超过旧 500KB 上限、一张小图。"""
import os
import random
import sys
from PIL import Image

OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.environ.get('TEMP', '.'), 'jiuge-cover-fixtures')
os.makedirs(OUT, exist_ok=True)

# 900x1350 噪声 PNG：压缩后通常 2.5–4MB，正好落在「旧上限 500KB 抽不到、新上限 4MB 能抽到」的区间
random.seed(7)
big = Image.new('RGB', (900, 1350))
px = big.load()
for y in range(0, 1350, 2):
    for x in range(0, 900, 2):
        c = (random.randrange(256), random.randrange(256), random.randrange(256))
        px[x, y] = c
        px[x + 1, y] = c
        px[x, y + 1] = c
        px[x + 1, y + 1] = c
big.save(os.path.join(OUT, 'cover-big.png'), 'PNG')

small = Image.new('RGB', (300, 450), (40, 80, 120))
small.save(os.path.join(OUT, 'cover-small.png'), 'PNG')

for n in ('cover-big.png', 'cover-small.png'):
    p = os.path.join(OUT, n)
    print(n, os.path.getsize(p))
