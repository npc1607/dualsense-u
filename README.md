# dualsense-u

dualsense-c 的图形客户端（规划中）。

## 文档

- **产品需求文档（PRD）** → [`docs/prd/dualsense-c-gui-prd.md`](docs/prd/dualsense-c-gui-prd.md)
  - 11 节正文 + 附录：背景与问题、目标/非目标、用户画像、30 项功能（P0/P1/P2 × M1–M6）、后端前置契约（STATE1 / CMD1）、非功能需求、验收标准、风险与开放决策。
  - §十一 UI 设计与线框图：10 屏信息架构、设计令牌、15 个组件规格、交互与 14 类边界状态、屏幕↔功能 ID 映射。
- **UI 线框图资产** → [`docs/prd/assets/dualsense-c-gui/`](docs/prd/assets/dualsense-c-gui/)
  - 7 张图（全局 IA / 输入面板 / 扳机曲线编辑器 / 规则 Inspector / 信号总线 / 输出可视化 / Dashboard 高保真稿），每张提供 `.png`、`.svg` 与可编辑的 `.excalidraw` 源文件。
  - `_build_gui_diagrams.js` 为唯一生成器，确定性可重跑：`node docs/prd/assets/dualsense-c-gui/_build_gui_diagrams.js`（依赖 `rsvg-convert`）。

> 上游驱动框架：[`dualsense-c`](https://github.com/npc1607/dualsense-c)（纯 Go，`source → signal.Set → rules.Engine → sink` 四层解耦）。
