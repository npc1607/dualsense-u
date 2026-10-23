# dualsense-u

dualsense-c 的图形客户端（规划中）。

## Linux 开发准备

UI 后端目前只存在于 `feat/ui-backend` 分支，**`main` 还没有 STATE1/CMD1**。按 `main` 构建会出现「TCP 能连上 9997，却收不到状态帧 / CMD1 返回 unknown method」的静默失败，因此第一步必须切分支：

```bash
git clone https://github.com/npc1607/dualsense-c.git
cd dualsense-c
git checkout feat/ui-backend
```

> 该分支至少包含 `bbfba7e`（STATE1/CMD1）、`7c18f83`（health `device`）、`f0c86a0`（STALE）、`a67dde7`（`-strict-profile`）。分支门槛与提交清单以 [`backend-capabilities.md` §〇](docs/prd/backend-capabilities.md) 为准。

### 系统依赖

| 用途 | Ubuntu / Debian | Fedora | Arch |
|---|---|---|---|
| MyGo native 路径：GTK3 + libGL/Mesa | `libgtk-3-dev libgl1-mesa-dev` | `gtk3-devel mesa-libGL-devel` | `gtk3 mesa` |
| web 路径：WebKitGTK 4.1 | `libwebkit2gtk-4.1-dev` | `webkit2gtk4.1-devel` | `webkit2gtk-4.1` |
| 仅重建图表资产：`rsvg-convert` | `librsvg2-bin` | `librsvg2-tools` | `librsvg` |

另需 Go 1.24+。`rsvg-convert` 只在重新生成 `docs/prd/assets/**` 的 SVG/PNG 时需要，日常开发/冒烟不必安装。

### 冒烟（无手柄）

`fps` 内置 profile 的 `source` 是 `trigger`（需要真实手柄）。没有手柄时用 `-source sim` 覆盖数据源；`-dry-run` 下 health 的 `device.connected` 应为 `false`。以下命令均在 `dualsense-c` 的 checkout 内执行（不是本仓库）：

```bash
# 编译检查 + 生成 bin/ds5d / bin/ds5ctl
go build ./...
make build

# 终端 A：dry-run 守护进程（sim 源，无手柄）
./bin/ds5d -dry-run -profile fps -source sim

# 终端 B：最小 STATE1 收帧（ds5ctl 会先发 state.subscribe）
./bin/ds5ctl watch

# 或自动校验 SignalCount / health.device / STALE 规则
go run ./tools/ipcsmoke -want-stale=false
```

如需验证 `state=3 STALE`，写一个 `when` 引用 `speed`（sim 源永不上报 `speed`）的临时 profile，再运行 `go run ./tools/ipcsmoke`（默认要求至少一条 STALE）。

> Profile 默认严格解码：未知顶层/rule 键会启动失败。迁移存量 YAML 时先看错误行号，切勿用 `-strict-profile=false` 长期绕过；细节见 [`backend-capabilities.md` §3.3](docs/prd/backend-capabilities.md)。

集成契约（STATE1 字节布局、CMD1 方法、health 字段、规则六态）统一以 [`docs/prd/backend-capabilities.md`](docs/prd/backend-capabilities.md) 为准。

## 文档

- **产品需求文档（PRD）** → [`docs/prd/dualsense-c-gui-prd.md`](docs/prd/dualsense-c-gui-prd.md)
  - 11 节正文 + 附录：背景与问题、目标/非目标、用户画像、30 项功能（P0/P1/P2 × M1–M6）、后端前置契约（STATE1 / CMD1）、非功能需求、验收标准、风险与开放决策。
  - §十一 UI 设计与线框图：10 屏信息架构、设计令牌、15 个组件规格、交互与 14 类边界状态、屏幕↔功能 ID 映射。
- **UI 线框图资产** → [`docs/prd/assets/dualsense-c-gui/`](docs/prd/assets/dualsense-c-gui/)
  - 7 张图（全局 IA / 输入面板 / 扳机曲线编辑器 / 规则 Inspector / 信号总线 / 输出可视化 / Dashboard 高保真稿），每张提供 `.png`、`.svg` 与可编辑的 `.excalidraw` 源文件。
  - `_build_gui_diagrams.js` 为唯一生成器，确定性可重跑：`node docs/prd/assets/dualsense-c-gui/_build_gui_diagrams.js`（依赖 `rsvg-convert`）。

> 上游驱动框架：[`dualsense-c`](https://github.com/npc1607/dualsense-c)（纯 Go，`source → signal.Set → rules.Engine → sink` 四层解耦）。
