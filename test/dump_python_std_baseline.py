"""
从 Python 参考实现导出 **std（Mode 0）转换谱** 的基准值，供 JS 对拍。

背景：扩展现在支持显示 osu!（std）谱，但显示的是「转成taiko 之后」的视角。
这条链路必须与官方 TaikoBeatmapConverter 一致，否则读谱画面上的
连打时长 / 短滑条拆点 / 滚动速度都会错。

对拍内容（每张 std 谱 × 若干 mod）：
  · 转换后的物件统计（Hit / DrumRoll / Swell 数量）
  · 前若干个物件的 startTime / type / duration（验证拆点与时长公式）
  · Star Rating 及四项 skill 难度、monoStaminaFactor、consistencyFactor
  · ScrollSpeed 控制点（std 的 SV 来自「滑条速度变化」后处理）

用法:
    python test/dump_python_std_baseline.py
输出:
    test/python_std_baseline.json
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(os.path.dirname(ROOT), 'taiko_diffcalc'))

import osu_parser
import convert
import diffcalc as D

MODS = ['None', 'EZ', 'HR', 'DT', 'HT', 'HR+DT', 'DT+HD+FL']
#: 逐物件比对的抽样数量：转换后物件常有上万条，比前N 个足以覆盖
#: 「circle 判定 / 短滑条拆点 / 连打时长」三类分支。
SAMPLE = 400


def main():
    zip_dir = os.path.join(HERE, 'std_zips')
    if not os.path.isdir(zip_dir):
        print(f'找不到样本目录: {zip_dir}')
        return
    out = {}

    for fn in sorted(os.listdir(zip_dir)):
        if not fn.endswith('.osu'):
            continue
        path = os.path.join(zip_dir, fn)
        with open(path, 'r', encoding='utf-8', errors='replace') as fp:
            f = osu_parser.parse_osu_text(fp.read())
        if f.mode != 0:
            print(f'  跳过（非 std）: {fn[:50]} Mode={f.mode}')
            continue

        # is_taiko_native=False -> 走 shouldConvertSliderToHits 的非原生分支
        objs, ci0, gsv, mc = convert.convert(f, False)

        kinds = {'Hit': 0, 'DrumRoll': 0, 'Swell': 0}
        for o in objs:
            kinds[type(o).__name__] = kinds.get(type(o).__name__, 0) + 1

        # ---- 物件抽样（顺序敏感：转换器末尾按 startTime 排序）----
        sample = []
        for o in objs[:SAMPLE]:
            sample.append({
                't': float(o.start_time),
                # Hit 的 type：0=Don(Centre) 1=Kat(Rim)；DrumRoll/Swell 为 null
                'type': (int(o.type) if type(o).__name__ == 'Hit' else None),
                'dur': float(getattr(o, 'duration', 0.0)),
            })

        # ---- ScrollSpeed 控制点 ----
        # std 的 SV 来自转换器后处理：只有滑条携带 SliderVelocityMultiplier，
        # 与上一生效值不同才在该滑条起始时间插入控制点。
        scroll = []
        last = 1.0
        for o in f.hit_objects:
            if o.type != 'slider':
                continue
            sv = convert._sv_at(f, o.start_time)
            if abs(sv - last) > 1e-9:
                scroll.append([o.start_time, sv])
                last = sv

        mods = {}
        for m in MODS:
            ci, sm, rate, hid, fl, classic, easy = D.apply_mod(ci0, gsv, m)
            r = D.calculate_difficulty(objs, ci, sm, rate, False, True)
            mods[m] = {
                'sr': r['star_rating'],
                'rhythm': r['rhythm_difficulty'],
                'reading': r['reading_difficulty'],
                'colour': r['colour_difficulty'],
                'stamina': r['stamina_difficulty'],
                'msf': r['mono_stamina_factor'],
                'cf': r['consistency_factor'],
                'top_strains': r['stamina_top_strains'],
                'od': ci['overall_difficulty'],
                'rate': rate,
            }

        key = f'{fn}::{f.Version}'
        out[key] = {
            'version': f.Version,
            'title': f.Title,
            'beatmapVersion': f.beatmap_version,
            'maxCombo': mc,
            'kinds': kinds,
            'total': len(objs),
            'sample': sample,
            'scroll': scroll,
            'mods': mods,
        }
        print(f'  {f.Version[:36]:38s} 物件={len(objs):6d} '
              f'(Hit {kinds["Hit"]} / Roll {kinds["DrumRoll"]} / Swell {kinds["Swell"]}) '
              f'SV点={len(scroll):3d} SR={mods["None"]["sr"]:.6f}')

    dest = os.path.join(HERE, 'python_std_baseline.json')
    with open(dest, 'w', encoding='utf-8') as fp:
        json.dump(out, fp, ensure_ascii=False, indent=1)
    print(f'\n已写出 {len(out)} 张 std 谱 × {len(MODS)} 个 mod -> {dest}')


if __name__ == '__main__':
    main()
