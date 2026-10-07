# Qiaomu Music Player (Spotify)

用自然语言控制 Spotify 播放音乐的 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) Skill。

对 AI 说"来点爵士"、"适合下雨天的音乐"、"播放 Bohemian Rhapsody"，它就帮你搜、帮你放。

内置 5,947 个音乐风格数据库，AI 能根据你的描述精准匹配风格并推荐曲目。

> 纯 Python 标准库实现，零依赖，不需要 MCP Server。支持 Claude Code、Cursor、Codex 等 37+ AI 编程工具。

## 快速安装

```bash
# 方式一：npx 一键安装（推荐）
npx qiaomu-music-player-spotify

# 方式二：Vercel Skills CLI
npx skills add joeseesun/qiaomu-music-player-spotify

# 方式三：手动安装
git clone https://github.com/joeseesun/qiaomu-music-player-spotify.git ~/.claude/skills/qiaomu-music-player-spotify
```

安装后还需要配置 Spotify 凭证，详见下方 [安装教程](#安装教程保姆级)。

## Features

- **完整播放控制**：搜索、播放、暂停、下一首、音量、队列、随机、循环
- **批量播放**：一次播多首，自动排队
- **5,947 个音乐风格**：RateYourMusic 层级数据库（49 大类 > 737 子类 > 5,161 细分类）
- **30+ 风格快捷播放**：说"听 Jazz"直接放，无需搜索
- **场景/心情推荐**：模糊描述（"写代码的背景音乐"）→ AI 匹配风格 → 推荐具体曲目
- **Token 自动刷新**：OAuth 2.0 授权一次，之后自动续期
- **零依赖**：纯 Python 标准库，不需要 pip install 任何东西

---

## 安装教程（保姆级）

### Step 1: 准备 Spotify 账号

你需要一个 Spotify **Premium 账号**（免费账号部分功能受限）。

> 国内没有 Spotify 服务，推荐在淘宝搜"Spotify 会员"，大约 **150 元/年**，店家会帮你充值到你的 Spotify 账号上。如果没有账号，去 [spotify.com](https://www.spotify.com/) 先注册一个。

注册/登录后，下载安装 [Spotify 桌面客户端](https://www.spotify.com/sg-zh/download/other/)（选择你的操作系统），安装后登录并保持打开（播放音乐需要一个活跃设备）。

### Step 2: 创建 Spotify Developer App

这一步是为了获取 API 凭证，让脚本能控制你的 Spotify。

1. 打开 [Spotify Developer Dashboard](https://developer.spotify.com/dashboard)
2. 用你的 Spotify 账号登录
3. 点击 **Create App**
4. 填写表单：
   - **App name**: 随便填，比如 `My Music Player`
   - **App description**: 随便填，比如 `Personal music player`
   - **Redirect URIs**: 填入 `http://127.0.0.1:8888/callback`，然后点 **Add**
   - **APIs used**: 勾选 **Web API**
5. 勾选同意条款，点 **Save**
6. 进入刚创建的 App，点 **Settings**
7. 你会看到：
   - **Client ID** — 直接显示，复制保存
   - **Client Secret** — 点 "View client secret" 后显示，复制保存

### Step 3: 下载本项目

```bash
# 方式一：作为 Claude Code Skill 安装（推荐）
git clone https://github.com/joeseesun/qiaomu-music-player-spotify.git ~/.claude/skills/qiaomu-music-player-spotify

# 方式二：下载到任意位置
git clone https://github.com/joeseesun/qiaomu-music-player-spotify.git
cd qiaomu-music-player-spotify
```

### Step 4: 配置环境变量

把 Step 2 拿到的 Client ID 和 Client Secret 写入你的 shell 配置文件。

**macOS / Linux (zsh)**:
```bash
echo 'export SPOTIFY_CLIENT_ID="你的Client_ID"' >> ~/.zshrc
echo 'export SPOTIFY_CLIENT_SECRET="你的Client_Secret"' >> ~/.zshrc
source ~/.zshrc
```

**macOS / Linux (bash)**:
```bash
echo 'export SPOTIFY_CLIENT_ID="你的Client_ID"' >> ~/.bashrc
echo 'export SPOTIFY_CLIENT_SECRET="你的Client_Secret"' >> ~/.bashrc
source ~/.bashrc
```

验证环境变量是否生效：
```bash
echo $SPOTIFY_CLIENT_ID
# 应该输出你的 Client ID
```

### Step 5: 一键授权

确保你的 Spotify 桌面客户端已打开，然后运行：

```bash
python3 auth_setup.py
```

浏览器会自动打开 Spotify 授权页面，点 **Agree** 同意授权。授权成功后你会看到：

```
✅ 授权完成！
   refresh_token 已保存到: .spotify_tokens.json
```

这个 token 文件会自动刷新，以后不需要再授权了。

### Step 6: 验证安装

```bash
# 查看可用设备
python3 spotify.py devices

# 搜索一首歌试试
python3 spotify.py search "Yesterday Beatles" track 1
```

如果能看到你的设备列表和搜索结果（JSON 格式），说明安装成功。

### Step 7（可选）: 设置默认设备

运行 `python3 spotify.py devices` 后，复制你常用设备的 `id`，写入环境变量：

```bash
echo 'export SPOTIFY_DEVICE_ID="你的设备ID"' >> ~/.zshrc
source ~/.zshrc
```

设置后播放命令会自动发送到这个设备，不用每次指定。

---

## 使用方式

### 作为 Claude Code Skill（推荐）

安装到 `~/.claude/skills/qiaomu-music-player-spotify/` 后，直接对 Claude 说自然语言：

```
你: 来点爵士
AI: 🎷 正在播放 Jazz Vibes 播放列表...

你: 适合写代码的音乐
AI: 💻 根据风格库匹配，推荐这几个方向：
    1. Lo-fi Hip Hop — 低保真节拍，专注伴侣
    2. Post-Rock — Mogwai《Young Team》
    3. Ambient — Brian Eno《Music for Airports》
    想听哪个？

你: 播放 Bohemian Rhapsody
AI: 🎵 正在播放 Queen — Bohemian Rhapsody

你: 来5首经典摇滚
AI: [自动搜索5首 → 批量播放]

你: Shoegaze 是什么风格？
AI: 🎵 Shoegaze — 以空灵人声和失真吉他墙为特征...
```

### 作为命令行工具

```bash
# 搜索
python3 spotify.py search "Radiohead" track 5
python3 spotify.py search "OK Computer" album 1

# 播放
python3 spotify.py play <track_id>
python3 spotify.py play spotify:playlist:37i9dQZF1DXbITWG1ZJKYt

# 控制
python3 spotify.py pause
python3 spotify.py resume
python3 spotify.py next
python3 spotify.py prev
python3 spotify.py volume 60

# 队列
python3 spotify.py queue <track_id>
python3 spotify.py show-queue
python3 spotify.py batch-play <id1> <id2> <id3>

# 信息
python3 spotify.py now
python3 spotify.py recent
python3 spotify.py playlists
python3 spotify.py devices

# 模式
python3 spotify.py shuffle on
python3 spotify.py repeat track
```

所有输出均为 JSON 格式，方便 AI 或脚本解析。

## 命令速查

| 命令 | 参数 | 说明 |
|------|------|------|
| `search` | `<关键词> [类型] [数量]` | 搜索（类型: track/artist/album/playlist，默认 track） |
| `play` | `<URI 或 track_id>` | 播放曲目/专辑/播放列表 |
| `pause` | | 暂停 |
| `resume` | | 继续播放 |
| `next` | | 下一首 |
| `prev` | | 上一首 |
| `queue` | `<URI 或 track_id>` | 加入播放队列 |
| `now` | | 当前播放信息 |
| `show-queue` | `[数量]` | 查看播放队列 |
| `volume` | `<0-100>` | 设置音量 |
| `devices` | | 列出可用设备 |
| `recent` | `[数量]` | 最近播放记录 |
| `playlists` | `[数量]` | 我的播放列表 |
| `batch-play` | `<id1> <id2> ...` | 批量播放（播第一首 + 其余排队） |
| `shuffle` | `<on\|off>` | 随机播放 |
| `repeat` | `<track\|context\|off>` | 循环模式 |

## 风格数据库

`references/` 目录包含 5,947 个音乐风格的层级数据库：

```
references/
├── _index.json          # 49 个主分类概览（13KB）
├── _meta.json           # 元数据
├── main/                # 49 个文件，每个主分类的子分类
└── detailed/            # 578 个文件，细分风格详情
```

- **5,947 个风格**，3 个层级：主分类 (49) > 子分类 (737) > 细分类 (5,161)
- 每个风格包含：名称、描述、RateYourMusic 链接、层级关系

数据来源：[RateYourMusic](https://rateyourmusic.com/genres/)，仅供学习和个人使用。详见 [references/DATA_SOURCE.md](references/DATA_SOURCE.md)。

## 常见问题

**Q: 播放时报 "No active device" 怎么办？**
A: 确保 Spotify 桌面客户端已打开，并设置了 `SPOTIFY_DEVICE_ID` 环境变量。运行 `python3 spotify.py devices` 查看设备 ID。

**Q: 授权后报 401 错误？**
A: Token 可能过期了，脚本会自动刷新。如果持续报错，删除 `.spotify_tokens.json` 后重新运行 `python3 auth_setup.py`。

**Q: 免费账号能用吗？**
A: 部分功能可用（搜索、查看信息），但播放控制需要 Premium 账号。

**Q: 需要安装 Python 依赖吗？**
A: 不需要。脚本只用 Python 标准库，Python 3.7+ 即可运行。

## 文件结构

```
.
├── spotify.py            # Spotify API 客户端（所有播放命令）
├── auth_setup.py         # 一次性 OAuth 授权脚本
├── SKILL.md              # Claude Code Skill 定义文件
├── .env.example          # 环境变量模板
├── .spotify_tokens.json  # OAuth tokens（自动生成，已 gitignore）
└── references/           # 风格数据库（5,947 个风格）
    ├── _index.json
    ├── _meta.json
    ├── main/             # 49 个主分类文件
    └── detailed/         # 578 个细分文件
```

## License

[MIT](LICENSE)

## 关注作者

如果这个项目对你有帮助，欢迎关注我获取更多技术分享：

- **X (Twitter)**: [@vista8](https://x.com/vista8)
- **微信公众号「向阳乔木推荐看」**:

<p align="center">
  <img src="https://github.com/joeseesun/terminal-boost/raw/main/assets/wechat-qr.jpg?raw=true" alt="向阳乔木推荐看公众号二维码" width="300">
</p>
