"""为 dan_bridge_parity.mjs 生成 Python 基线。

用法（在工作区根或 taiko-preview-web 下均可）：
    python test/dan_bridge_py_baseline.py

产物：test/dan_bridge_baseline.json
结构：{文件名: {mod: {dan,grade,keytype,...} | null}}

★ 为什么要独立脚本、而不是在 Node 里 spawn Python：
  Windows 上 Node 的 `execFileSync` 调本机Python 会偶发EBUSY
  （Python 启动器要重写自己的 .pyc / 做环境探测）。
  实测只有从 bash 直接调是稳定的，所以拆成「先跑这个脚本、
  再跑 mjs 对拍」两步。
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, ROOT)

from dan_rank.evaluate import evaluate_text          # noqa: E402

ZIP_ROOT = os.path.join(HERE, 'test_zips')
MODS = ['', 'DT', 'HT', 'EZ', 'HR', 'CL', 'HDDT', 'HRHT', 'FL']
# 只保留本插件能渲染的模式：原生 taiko（Mode 1）。
# std 会走转谱路径，Python 侧没有对应实现，不参与对拍。

def main():
    if not os.path.isdir(ZIP_ROOT):
        print('（无 test_zips，跳过）')
        return 0
    out = {}
    for fn in sorted(os.listdir(ZIP_ROOT)):
        if not fn.endswith('.osu'):
            continue
        txt = open(os.path.join(ZIP_ROOT, fn), encoding='utf-8',
                   errors='replace').read()
        # 快速判模式，跳过非 taiko
        mode = None
        for line in txt.splitlines():
            if line.startswith('Mode:'):
                mode = int(line.split(':')[1].strip())
                break
        if mode != 1:
            continue
        per = {}
        for m in MODS:
            r = evaluate_text(txt, mods=m)
            per[m] = r[0] if r else None
        out[fn] = per
    dst = os.path.join(HERE, 'dan_bridge_baseline.json')
    with open(dst, 'w', encoding='utf-8') as fp:
        json.dump(out, fp, ensure_ascii=False)
    print('已生成基线 %s（%d 张谱 × %d mod）'
          % (dst, len(out), len(MODS)))
    return 0


if __name__ == '__main__':
    sys.exit(main())