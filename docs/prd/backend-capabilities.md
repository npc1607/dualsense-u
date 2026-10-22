# dualsense-c 后端能力与 UI 接入协议规范 (Backend Capabilities & IPC Specification)

> **版本**: 1.0.0 (Frozen Contract)  
> **适用版本**: `dualsense-c` (分支 `feat/ui-backend` / `main`), `dualsense-u`  
> **服务端口**: `127.0.0.1:9997` (多路复用), `127.0.0.1:9998` (FFB1), `127.0.0.1:9999` (Radio UDP)

---

## 一、架构总览与端口多路复用

为了保证 GUI 客户端与既有生态工具（`ds5bridge.exe`、`ds5radio`、`ds5ctl`）在单台机器上零冲突共存，`dualsense-c` 守护进程（`ds5d`）在回环端口 `127.0.0.1:9997` 上实现了**按帧头 Magic 字段分流的单端口四协议多路复用**：

```
                ┌────────────────────────────────────────────────────────┐
                │             127.0.0.1:9997 (TCP 回环监听)              │
                └──────────────────────────┬─────────────────────────────┘
                                           │ 按 4 字节 Magic 分流
      ┌──────────────────┬─────────────────┴───────────────┬──────────────────┐
      ▼                  ▼                                 ▼                  ▼
0x31474953 (SIG1)  0x31505343 (SPK1)                0x31545453 (STT1)  0x31444D43 (CMD1)
125Hz 原始遥测      语音伴生事件广播                    全量状态遥测流      JSON-RPC 控制面
(老 bridge 兼容)    (Radio / 文本播报)                  (GUI 状态仪表板)    (调参/热重载/模拟)
```

### 核心设计原则
1. **单进程 HID 独占所有权**：`ds5d` 是系统底层 `/dev/hidraw*`（或 Windows HID 设备）的**唯一**持有者。GUI 客户端、`ds5ctl bench`、`ds5ctl watch` 一律经由 IPC 请求数据与动作，绝不抢占物理设备。
2. **125Hz 热路径零阻塞隔离**：遥测广播走独立客户端队列，当 GUI 渲染卡顿或消费变慢时，采用**满队即丢（Drop on Full）**策略，保障手柄出帧线程绝对无锁、无系统阻塞。
3. **状态保留热重载**：无论是修改整形曲线还是切换 Profile 规则，旧状态计时器（Hold、Cooldown、Until）按名称平滑继承，避免重载瞬间出现手感闪断或信号假 Stale。

---

## 二、`STATE1` (0x31545453) 状态遥测流规范

`STATE1` 是为 `dualsense-u` 打造的高密度全量状态流。默认以 30Hz 推送，支持通过 `CMD1` 协商至 60Hz。

### 2.1 帧布局总览 (Little-Endian)
- **Header 头部**：20 字节
- **Signal 信号段**：76 个标准信号 × 11 字节 = 836 字节
- **Rule 规则段**：N 个编译规则 × 13 字节（64 条规则约 832 字节）
- **Summary 输出摘要**：40 字节
- **单帧尺寸**：约 1.73 KB（严格限制在 ≤ 2 KB 硬指标内，单次 TCP 包直达，零分片）

### 2.2 头部定义 (Header, 20 Bytes)
| 偏移 (Offset) | 类型 (Type) | 字段名 (Field) | 说明 (Description) |
|---|---|---|---|
| 0..3 | uint32 | Magic | 固定为 `0x31545453` ("STT1") |
| 4..5 | uint16 | Version | 协议版本，当前固定为 `1` |
| 6..7 | uint16 | Flags | 标志位，Bit 0: 快照帧 (Snapshot) |
| 8..11 | uint32 | Seq | 单调递增的帧序列号 |
| 12..15 | uint32 | TickMS | 守护进程自启动起的毫秒时间戳 |
| 16..17 | uint16 | SignalCount | 包含的信号数量（当前为 76） |
| 18..19 | uint16 | RuleCount | 包含的规则数量 |

### 2.3 信号段定义 (Signals, 11 Bytes per item)
条目按 `signal.Standard` 词表索引从小到大顺序排列（`id 0..75`）：

| 偏移 (Offset) | 类型 (Type) | 字段名 (Field) | 说明 (Description) |
|---|---|---|---|
| 0 | uint8 | ID | 信号词表 ID (`0..75`) |
| 1..4 | float32 | Shaped | 经死区、Gamma 与 SlewRate 整形后的值（规则实际输入） |
| 5..8 | float32 | Raw | 数据源直接提供的物理原始值 |
| 9..10 | uint16 | AgeMS | 信号新鲜度年龄（毫秒）。若无输入或离线则为 `0xFFFF` |

### 2.4 规则段定义 (Rules, 13 Bytes per item)
每个规则条目对应 Profile 中编译并参与决策的规则项：

| 偏移 (Offset) | 类型 (Type) | 字段名 (Field) | 说明 (Description) |
|---|---|---|---|
| 0..1 | uint16 | RuleID | 规则在当前规则表中的编译序号 |
| 2 | uint8 | State | 决策三态与状态：<br>`0`: FALSE (未命中)<br>`1`: TRUE (命中执行中)<br>`2`: HOLD (延迟保持中)<br>`3`: STALE (依赖信号过期)<br>`4`: COOLDOWN (冷却静默中)<br>`5`: ERROR (表达式求值异常) |
| 3..4 | int16 | Priority | 抢占优先级 |
| 5..8 | uint32 | LastFireMS | 距上一次触发击发过去的毫秒数 |
| 9..12 | uint32 | UntilMS | 剩余保持或冷却倒计时（毫秒） |

### 2.5 输出摘要段定义 (Summary, 40 Bytes)
反映手柄当前真实的物理输出报告状态：

| 偏移 (Offset) | 类型 (Type) | 字段名 (Field) | 说明 (Description) |
|---|---|---|---|
| 0 | uint8 | L2Mode | L2 自适应扳机模式编号 (0x00..0x26) |
| 1..4 | [4]uint8 | L2Params | L2 扳机前 4 个控制参数 |
| 5 | uint8 | R2Mode | R2 自适应扳机模式编号 (0x00..0x26) |
| 6..9 | [4]uint8 | R2Params | R2 扳机前 4 个控制参数 |
| 10 | uint8 | RumbleLeft | 左侧大震动马达力度 (`0..255`) |
| 11 | uint8 | RumbleRight | 右侧轻震动马达力度 (`0..255`) |
| 12..14 | [3]uint8 | Lightbar | RGB 灯条颜色值 (`0..255`) |
| 15 | uint8 | PlayerLEDs | 玩家指示灯状态位 (`0x04` = Player 1) |
| 16 | uint8 | MuteLED | 麦克风静音橙色指示灯 (`0` 或 `1`) |
| 17 | uint8 | HapticLeft | 左声道音圈触觉振幅 (`0..255`) |
| 18 | uint8 | HapticRight | 右声道音圈触觉振幅 (`0..255`) |
| 19..20 | uint16 | RateHz | 当前守护进程实际驱动采样率 (Hz) |
| 21..24 | uint32 | TickJitterUS | 最近输出周期抖动值 (微秒) |
| 25..28 | uint32 | HIDErrors | 物理 HID 报告写入失败计数 |
| 29..30 | uint16 | Subscribers | 当前连接到 IPC 的客户端数量 |
| 31 | uint8 | AimMismatch | 辅助瞄准配置版本一致性告警标志 (0=一致, 1=失配) |
| 32..39 | [8]uint8 | Reserved | 预留字节 |

---

## 三、`CMD1` (0x31444D43) 双向控制面协议

客户端向 `127.0.0.1:9997` 发送带有长度前缀的 JSON 报文，服务端同步返回处理结果。

### 3.1 报文结构
- **Magic**：4 字节 `0x31444D43` ("CMD1", Little-Endian)
- **Length**：4 字节 uint32 载荷长度
- **Payload**：Length 长度的 UTF-8 JSON 字符串

**请求格式**：
```json
{
  "id": "req-101",
  "method": "profile.reload",
  "params": {}
}
```

**响应格式**：
```json
{
  "id": "req-101",
  "ok": true,
  "result": { ... },
  "error": ""
}
```

### 3.2 支持的方法清单

#### 1. `health`
查询守护进程基础运行状况。
- **请求参数**：无
- **返回结果**：
  ```json
  {
    "uptime_s": 142.5,
    "subscribers": 1,
    "rate_hz": 125,
    "profile": "fps-aim",
    "source": "trigger",
    "jitter_us": 14
  }
  ```

#### 2. `state.subscribe`
协商遥测流推送帧率。
- **请求参数**：`{"rate": 30}` 或 `{"rate": 60}`
- **返回结果**：`{"subscribed": true}`

#### 3. `profile.reload`
从磁盘重新装载当前活跃的 Profile 文件，校验无误后无损应用。
- **请求参数**：无
- **返回结果**：`{"reloaded": true}` (若失败则 `ok=false` 并附带编译错误信息，旧 Profile 保持运行)

#### 4. `profile.apply`
动态局部打补丁（用于图形化曲线编辑器拖拽时的免落盘实时试听）。
- **请求参数**：
  ```json
  {
    "shape": {
      "throttle": { "deadzone": 0.05, "gamma": 1.2, "slew_up": 10.0, "slew_down": 20.0 }
    }
  }
  ```
- **返回结果**：`{"applied": true}`

#### 5. `effect.preview`
临时下发硬件扳机力学测试（带 TTL 自动释放，超时后无缝交还规则引擎）。
- **请求参数**：
  ```json
  {
    "target": "r2",
    "mode": "weapon",
    "params": { "start": "0", "amp_a": "60", "amp_b": "140", "freq": "8" },
    "ttl_ms": 1500
  }
  ```
- **返回结果**：`{"preview": true}`

#### 6. `rules.simulate`
离线安全试算（在隔离沙箱克隆引擎中执行，输入一组假设信号，输出预期帧与规则决策三态，**不写硬件，不影响物理控制器**）。
- **请求参数**：
  ```json
  {
    "signals": {
      "l2": 0.8,
      "r2": 0.95,
      "speed": 85.0
    }
  }
  ```
- **返回结果**：包含模拟生成的 `hid.Frame` 详细字段与每个 `RuleTelemetry` 条目。

#### 7. `rate.set`
调整输出刷新率。
- **请求参数**：`{"hz": 250}`
- **返回结果**：`{"rate_set": true}`

#### 8. `hid.claim` / `hid.release`
声明或交还硬件操作权。
- **返回结果**：`{"claimed": true}`

---

## 四、FPS 辅助瞄准与体感增强流水线 (`internal/aim`)

针对单机 FPS 以及体感瞄准体验，完整实现了四阶级联数学流水线：

```
[原始摇杆 RX, RY] ──> [1. 响应曲线] ──> [2. One Euro 滤波] ──> [3. 陀螺仪角度投影] ──> [4. 自适应压枪] ──> [限幅输出]
```

### 4.1 数学模块详解
1. **响应曲线 (`CurveProcessor`)**：
   - 径向硬件死区截断：$r = \sqrt{x^2 + y^2}$，若 $r \le r_{dead}$ 输出 $(0, 0)$，否则归一化至 $[0, 1]$。
   - 支持曲线类型：
     - `linear`：线性传动。
     - `power`：幂律曲线 $r_{curved} = r_{norm}^\gamma$。
     - `sigmoid`：双归一化 S 型曲线，保证 $S(0) = 0$ 且 $S(1) = 1$，微操更柔，中段加速。
     - `dual_zone`：双区折线，分界点 $r_{split}$ 内部线性缓动，外部大角度转向。
   - 边缘加速 (`outer_boost`)：在推到底部 $r_{norm} \ge 0.95$ 时，平滑倍增至指定加速比。
2. **手抖自适应滤波 (`OneEuroFilter`)**：
   - 采用 Géry Casiez 1€ 滤波算法：
     $$dx = \frac{x - x_{prev}}{dt}, \quad \hat{dx} = \alpha_d \cdot dx + (1 - \alpha_d)\hat{dx}_{prev}$$
     $$f_c = \text{min\_cutoff} + \beta \cdot |\hat{dx}|, \quad \hat{x} = \alpha_x \cdot x + (1 - \alpha_x)\hat{x}_{prev}$$
   - 低速微动时自动降低截止频率抑制生理颤抖；高速甩枪时动态跃升截止频率实现零延迟跟随。
3. **陀螺仪体感融合 (`GyroMapper`)**：
   - 依据握持姿态自然手倾角（默认 $35^\circ$）投影：
     $$\text{yaw}_{eff} = \text{yaw} \cdot \cos\theta - \text{roll} \cdot \sin\theta$$
   - 结合 DPS 静态噪声门限过滤环境传感器漂移。
   - 触发联动：支持 `l2_hold`（举镜瞄准开启）、`touch`（轻触触控板开启）、`always`（全时开启）。
4. **后坐力反冲抑制 (`AntiRecoil`)**：
   - 当 R2 开火深度达到击发阈值时触发。
   - 爆发衰减与稳态保持：
     $$F(t) = F_{burst} \cdot e^{-\lambda t} + F_{sustain}$$
   - 叠提高斯随机扰动 $\sigma$ 防止弹道机械死板。

### 4.2 接入与配置规范
在 Profile 声明中直接配置 `aim:` 或 `aim_assist:`：
```yaml
aim:
  curve:
    type: sigmoid
    exponent: 6.5
    mid_point: 0.52
    inner_deadzone: 0.04
    outer_boost: 1.5
  filter:
    type: one_euro
    min_cutoff: 0.85
    beta: 0.045
    d_cutoff: 1.0
  gyro:
    enabled: true
    trigger: l2_hold
    trigger_threshold: 0.15
    natural_angle_deg: 35
    deadzone_dps: 0.4
    sens_yaw: 1.85
    sens_pitch: 1.35
    invert_pitch: false
  anti_recoil:
    enabled: true
    trigger: r2_full
    start_delay: 60ms
    burst_force: 420
    burst_decay: 0.015
    sustain_force: 180
    jitter_noise: 25
```

---

## 五、CLI 命令扩展与排障

`ds5ctl` 现已全面升级为与 `ds5d` 协同的单所有权模式：
1. **健康状况查询**：
   ```bash
   ds5ctl health
   ds5ctl health -json
   ```
2. **Profile 列表查询（JSON 格式供 UI 解析）**：
   ```bash
   ds5ctl profiles -json
   ds5ctl check -profile profiles/fps-aim.yaml -json
   ```
3. **单所有权硬件测试**：
   ```bash
   # 若 ds5d 正在运行，自动通过 CMD1 调度，不再报 device busy：
   ds5ctl bench -trigger r2 -each 2s
   ds5ctl watch
   ```
