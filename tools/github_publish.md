# 发布到 GitHub

两件事：**建仓库并上传源码**，以及**把打包好的 zip 发成 Release**（用户从后者下载）。

> **本文所有命令都可以直接复制执行** —— 路径已经写成本机的真实路径：
>
> ```bash
> cd /c/Users/Administrator/WorkBuddy/osu2/taiko-preview-web
> ```
>
> （Git Bash 用 `/c/...` 这种斜杠写法；PowerShell / CMD 用
> `"C:/Users/Administrator/WorkBuddy/osu2/taiko-preview-web"`。两者指向同一个目录。）

---

## 一次性准备

### 1. 确认 git 身份

```bash
git config --global user.name  "你的名字"
git config --global user.email "你的邮箱"
```

检查：
```bash
cd /c/Users/Administrator/WorkBuddy/osu2/taiko-preview-web
git config user.name && git config user.email
```

### 2. 建仓库

**在 GitHub 网页上建**（推荐，最简单）：

1. 打开 https://github.com/new
2. Repository name 填 `osu-taiko-preview`（或你喜欢的名字）
3. 选 **Public**（要想让别人用就得公开）
4. ⚠️ **不要勾** "Add a README file"、"Add .gitignore"、"Choose a license"
   —— 我们本地已经有全套文件了，勾了会冲突
5. 点 **Create repository**

记下仓库地址，比如 `https://github.com/RealizE/osu-taiko-preview`。

---

## 上传源码

在项目目录下执行：

```bash
cd /c/Users/Administrator/WorkBuddy/osu2/taiko-preview-web

# 1. 建仓库并切到 main
git init -b main
git add .
git status              # ★ 先看一眼，确认没有谱面文件混进来

# 2. 提交
git commit -m 'v1.7.0：osu!taiko 谱面预览器'

# 3. 连到GitHub 并推
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
git push -u origin main
```

### ⚠️ 推送前务必确认没有敏感内容

`git status` 里**不该**出现：

|不该进仓库 | 为什么 |
|---|---|
| `test/test_zips/**.osu` | 从 osu! 下载的**真实谱面文件**，属于他人作品的二次分发 |
| `testmap/**`（23000+ 个 .osu） | 同上，而且体积巨大 |
| `osu_tree.json`、`dc.tar.gz` | 第三方数据 |
| `taiko skin/**.png` | 第三方皮肤 |
| `nuget_pkgs/**`、`StarRatingCheck/**` | 官方 C# 的编译产物，体积大且非本项目代码 |
| `*.xlsx`、`*.md` 的中间产物 | 过程文件 |

`.gitignore` 已经把这些挡住了。**如果 `git status` 里还有它们，
说明之前已经 `git add` 过了**，执行：

```bash
git reset                    # 清掉暂存区，重新来
git add .                    # 重新按 .gitignore 规则添加
git status                   # 再确认一次
```

### 体积自查

GitHub 单文件上限 100MB，仓库建议 < 1GB。推送前看一眼：

```bash
# 看看将要提交多大
git count-objects -vH
# 或者挑出最大的几个文件
git ls-files -s | awk '{print $4}' | xargs -I{} du -h {} 2>/dev/null | sort -h | tail -10
```

---

## 发 Release（用户实际下载的地方）

### 方式A：命令行（需要装 [GitHub CLI](https://cli.github.com)）

本机**目前没装 gh**。要装的话：

```bash
winget install GitHub.cli      # Windows
# 或见 https://cli.github.com
gh auth login                  # 浏览器里授权一次
```

之后：

```bash
cd /c/Users/Administrator/WorkBuddy/osu2/taiko-preview-web

# 生成发布目录 + 打 zip
bash tools/release_prep.sh
cd release
git archive --format=zip --prefix=osu-taiko-preview/ -o ../dist/osu-taiko-preview-1.7.0.zip osu-taiko-preview
cd ..

# 创建 tag + Release
gh release create v1.7.0 \
  --title "v1.7.0" \
  --notes-file CHANGELOG.md \
  dist/osu-taiko-preview-1.7.0.zip
```

### 方式 B：网页（不用装任何东西，推荐第一次用这个）

1. 先在本地把 zip 打好：
   ```bash
   cd /c/Users/Administrator/WorkBuddy/osu2/taiko-preview-web
   bash tools/release_prep.sh
   ```
   然后把 `release/` 整个目录用 zip 软件压成 `osu-taiko-preview-1.7.0.zip`。

2. 打开仓库 → 右侧 **Releases** → 点 **Create a new release**
3. 选tag：输入 `v1.7.0`，首次会自动创建
4. Title 填 `v1.7.0`
5. 描述：从 `CHANGELOG.md` 里复制「1.7.0」那一节
6. 拖入刚打好的 zip
7. 勾 **Set as the latest release**
8. 点 **Publish release**

---

## 之后每次更新

```bash
cd /c/Users/Administrator/WorkBuddy/osu2/taiko-preview-web

# 1. 改代码 / 提PR
git add .
git commit -m 'v1.7.1：修xxx'
git push

# 2. 升版本号（manifest.json 里的 version）
#    ★ 记得同步 CHANGELOG.md 与 content.js 里的 proto 号

# 3. 生成发布包
bash tools/release_prep.sh

# 4. 发 Release（同上面方式 A 或 B）
```

---

## 建议的仓库设置

推完后在仓库 **Settings** 里调几项，能省很多麻烦：

| 设置项 | 建议值 | 为什么 |
|---|---|---|
| About → Description | 填一句话简介 | 搜索结果里会显示 |
| About → Topics | `osu`, `osu-taiko`, `chrome-extension`, `browser-extension` | 被搜到的概率高很多 |
| About → Homepage | 留空 | |
| Settings → General → Issues | 开着 | 别人才有地方反馈 |
| 分支保护 `main` | 随意 | 只有你一个人开发的话不必 |

---

## ⚠️ 上架 Chrome Web Store（可选但值得）

相比「让用户手动解压 + 开开发者模式」，上架商店体验好得多：

1. 打开 <https://chrome.google.com/webstore/devconsole>（需Google 账号，一次性 $5开发者注册费）
2. 「添加新项目」→ 上传 `release/osu-taiko-preview/` 里的 zip
3. 填写商店页信息与截图
4. 提交审核（通常几天）

注意：商店审核会检查：

- 隐私政策页面（**即使不收集数据也需要写**）
- 权限用途说明（当前只申请了 `storage`，好过）
- 不能有误导性描述

---

## 一句话总结给用户的话

README-user.md 里已经写了：

> 下载 zip → 解压 → 打开 `chrome://extensions` → 开开发者模式 →
> 「加载已解压的扩展程序」→ 选解压出来的目录 → 完事。

没有 Node.js、没有 npm install、没有 Python、不用起服务。
唯一的前置需求是**一个 Chromium 系浏览器**。