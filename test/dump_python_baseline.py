"""
从 Python 实现导出基准值，供 JS 对拍（test/difficulty_parity.mjs）

用法:
    python test/dump_python_baseline.py

输出:
    test/python_baseline.json
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
import ppcalc as P


MODS = ['None', 'EZ', 'HD', 'HR', 'DT', 'NC', 'HT', 'FL', 'CL', 'NF',
        'HR+DT', 'DT+HD+FL']


def load_osu_any(path):
    """test_zips 里是裸 .osu（不是 .osz）—— 直接按文本解析。"""
    if path.lower().endswith('.osz'):
        import zipfile
        with zipfile.ZipFile(path) as z:
            name = [n for n in z.namelist() if n.endswith('.osu')][0]
            text = z.read(name).decode('utf-8', errors='replace')
    else:
        with open(path, 'r', encoding='utf-8', errors='replace') as fp:
            text = fp.read()
    return osu_parser.parse_osu_text(text)


def main():
    zip_dir = os.path.join(HERE, 'test_zips')
    out = {}

    for fn in sorted(os.listdir(zip_dir)):
        if not fn.endswith('.osu'):
            continue
        path = os.path.join(zip_dir, fn)
        f = load_osu_any(path)
        if f.mode != 1:
            print(f'  跳过（非 taiko）: {fn[:50]}')
            continue
        objs, ci0, gsv, mc = convert.convert(f, not (f.mode != 1))
        mods = {}
        for m in MODS:
            ci, sm, rate, hid, fl, classic, easy = D.apply_mod(ci0, gsv, m)
            r = D.calculate_difficulty(objs, ci, sm, rate, False, f.mode != 1)
            disp = D.get_adjusted_display_difficulty(f.OverallDifficulty, f.HPDrainRate, m)
            sc = r['skills']['skill_contributions']
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
                # ---- 显示难度（GetAdjustedDisplayDifficulty）----
                'hp': disp['hp'],
                'display_od': disp['displayOd'],
                'display_od_lazer': disp['displayOdLazer'],
                'great_window': disp['greatWindow'],
                'great_window_floor': disp['greatWindowFloor'],
                'ok_window': disp['okWindow'],
                'miss_window': disp['missWindow'],
                'scroll_speed': disp['scrollSpeed'],
                # ---- 四 skill 贡献占比 ----
                'energy': sc['energy'],
                'loo': sc['loo'],
                'loo_sum': sc['looSum'],
                'solo': sc['soloSr'],
            }
        key = f'{fn}::{f.Version}'
        out[key] = {'version': f.Version, 'title': f.Title, 'mods': mods}
        print(f'  {f.Version[:40]:42s} SR={mods["None"]["sr"]:.9f}')

    # PP 基准：取第一个难度，用 great 比例 0.98 + 若干 miss
    pp_cases = []
    first_key = next((k for k in out if k != '__pp__'), None)
    if first_key:
        fn = first_key.split('::')[0]
        path = os.path.join(zip_dir, fn)
        f = load_osu_any(path)
        objs, ci0, gsv, mc = convert.convert(f, True)
        total = sum(1 for o in objs if getattr(o, 'is_hit', False))
        for label, mod, acc, miss in [
            ('SS 100%', 'None', 1.00, 0),
            ('acc98', 'None', 0.98, 0),
            ('acc95', 'None', 0.95, 0),
            ('acc90', 'None', 0.90, 0),
            ('acc95+5miss', 'None', 0.95, 5),
            ('DT acc98', 'DT', 0.98, 0),
            ('HD acc98', 'HD', 0.98, 0),
            ('HR+DT acc98', 'HR+DT', 0.98, 0),
            ('FL+HD acc98', 'FL+HD', 0.98, 0),
            ('DT+HD+FL acc98', 'DT+HD+FL', 0.98, 0),
        ]:
            ci, sm, rate, hid, fl, classic, easy = D.apply_mod(ci0, gsv, mod)
            r = D.calculate_difficulty(objs, ci, sm, rate, False, False)
            usable = total - miss
            great = int(round(usable * acc))
            rest = usable - great
            ok = int(round(rest * 0.7))
            meh = rest - ok
            gwin = P.great_window(ci['overall_difficulty']) / rate
            eur = P.compute_deviation_upper_bound(total, great / total, gwin) * 10
            d = P.calculate_pp(r['star_rating'], r['rhythm_difficulty'],
                              r['mono_stamina_factor'], r['consistency_factor'],
                              total, ci['overall_difficulty'], rate,
                              great, ok, meh, miss,
                              hidden=hid, flashlight=fl, is_classic=classic, easy=easy)
            accpp = P.add_hdfl_bonus(d['accuracy'], total, hid, fl, False)
            pp_cases.append(dict(
                file=fn, mod=mod, label=label,
                great=great, ok=ok, meh=meh, miss=miss,
                eur=eur, diff_pp=d['difficulty'], acc_pp=accpp,
                total_pp=d['difficulty'] + accpp,
                sr=r['star_rating'], od=ci['overall_difficulty'],
            ))
    out['__pp__'] = pp_cases

    dest = os.path.join(HERE, 'python_baseline.json')
    with open(dest, 'w', encoding='utf-8') as fp:
        json.dump(out, fp, ensure_ascii=False, indent=1)
    print(f'\n已写出 {len(out) - 1} 个难度 × {len(MODS)} 个 mod + '
          f'{len(pp_cases)} 个 PP 用例')
    print(f'  -> {dest}')


if __name__ == '__main__':
    main()
