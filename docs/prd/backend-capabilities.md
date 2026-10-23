# dualsense-c 后端能力与 UI 接入协议规范 (Backend Capabilities & IPC Specification)

> **版本**: 1.1.0  
> **适用版本**: `dualsense-c` @ `feat/ui-backend`（含 `bbfba7e`、`cda3c2f` 与本轮 `RuleID` 补丁），`dualsense-u`  
> **服务端口**: `127.0.0.1:9997` (STATE1 / SIG1 / SPK1 / CMD1 多路复用), `127.0.0.1:9998` (FFB1), `127.0.0.1:9999` (Radio UDP)

---

## 〇、版本与分支门槛（先读这一节）

`STATE1`、`CMD1` 与 `signals.subscribe` **尚未合入 `main`**。如果 GUI 按 `main` 构建，会出现「TCP 能连上 9997，但收不到 STATE1 帧、CMD1 返回 `unknown method`」的静默失败。集成前请用下面的命令自查：

```bash
cd dualsense-c
git merge-base --is-ancestor bbfba7e HEAD && echo "STATE1/CMD1 OK"
git merge-base --is-ancestor cda3c2f HEAD && echo "subscription isolation OK"
```

| 能力 | 最低分支 / 提交 | 说明 |
|---|---|---|
| `SIG1` 125Hz 原始遥测（9997） | `main`（`1970e2b` 起） | 老 `ds5bridge.exe` / `ds5radio` 兼容路径；只含原始值 |
| `FFB1`（9998） | `main` | 由 `ds5vpad` 提供，`ds5d` 通过 `source: ffb` 消费 |
| `internal/aim`（曲线 / One Euro / 陀螺 / 反后坐力） | `main`（`f08394e`） | **仅在 `ds5vpad` 生效**；`ds5d` 不消费 `aim` 配置，也不写 STATE1 的 aim 字段 |
| `STATE1`（`STT1`） | `feat/ui-backend` / `bbfba7e` | `main` 不含 `internal/vpad/ipc/state.go` |
| `CMD1`（`health`、`state.subscribe`、`profile.reload`、`effect.preview`、`rules.simulate`、`rate.set`、`hid.claim/release`） | `feat/ui-backend` / `bbfba7e` | `main` 不含 `internal/vpad/ipc/cmd.go` |
| `signals.subscribe` + STATE1/SIG1 订阅隔离 | `feat/ui-backend` / `cda3c2f` | 该提交前，STATE1 与 SIG1 会串流到同一客户端 |
| 稳定 `rule_id`（`md5(rule.name)` 前 2 字节） | `feat/ui-backend` / `190426a` | 更早的提交用切片下标，`profile.reload` 后 id 会跳到别的规则上 |
| 规则名唯一性校验（重复非空规则名加载失败） | `feat/ui-backend` / `a18d2aa` | `profile.Validate()` 拒绝同名非空规则，避免共享 `rule_id` 与 reload 计时槽 |
| 严格 `profile.apply`（局部合并 + 逐键 applied/ignored） | `feat/ui-backend` / `82cf0af` | `signal.Shaper` 已补 json tag；非法 JSON 返回 `ok:false`；未知信号与越界值进 `ignored` |

> 结论：GUI 的构建与连接检查必须固定到 `feat/ui-backend` 分支（或包含上述提交的 tag），不要以 `main` 作为兼容基线。

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
3. **状态保留热重载**：无论是修改整形曲线还是切换 Profile 规则，旧状态计时器（Hold、Cooldown、Until）按**规则名**平滑继承，避免重载瞬间出现手感闪断或信号假 Stale。
4. **同一连接上 CMD1 响应与订阅帧交织**：一旦客户端发送订阅命令，后续字节流里既有 CMD1 响应也有 STATE1/SIG1 帧，客户端必须先读 4 字节 Magic 再决定解析方式（`0x31444D43` = CMD1 响应，`0x31545453` = STATE1，`0x31474953` = SIG1，`0x31505343` = SPK1）。

---

## 二、`STATE1` (0x31545453) 状态遥测流规范

`STATE1` 是为 `dualsense-u` 打造的高密度全量状态流。默认以 30Hz 推送，支持通过 `CMD1` 的 `state.subscribe` 协商至 60Hz（服务端全局 ticker，非每客户端独立频率）。

### 2.1 帧布局总览 (Little-Endian)
- **Header 头部**：20 字节
- **Signal 信号段**：`SignalCount` 个标准信号 × 11 字节（当前 `SignalCount = len(signal.Standard) = 80`，即 880 字节）
- **Rule 规则段**：`RuleCount` 个编译规则 × 13 字节（数量随活跃 Profile 变化，内置 Profile 为 4..24 条）
- **Summary 输出摘要**：40 字节
- **单帧尺寸**：`20 + 80×11 + N×13 + 40` 字节；N=64 时为 1772 字节（≈1.73 KiB），可变长，客户端必须按头部计数解析，不能假设固定长度

> 注意：STATE1 的规则段**不含规则名和 target**（13 字节里只有 id/state/priority/时间戳）。`rule_id → name/target` 的映射只能来自 Profile YAML 或 `rules.simulate` 返回的 `RuleTelemetry` JSON。

### 2.2 头部定义 (Header, 20 Bytes)
| 偏移 (Offset) | 类型 (Type) | 字段名 (Field) | 说明 (Description) |
|---|---|---|---|
| 0..3 | uint32 | Magic | 固定为 `0x31545453` ("STT1") |
| 4..5 | uint16 | Version | 协议版本，当前固定为 `1` |
| 6..7 | uint16 | Flags | 当前 `ds5d` 恒写 `0`；客户端必须忽略未知位（不要把它当快照帧判断依据） |
| 8..11 | uint32 | Seq | 单调递增的帧序列号 |
| 12..15 | uint32 | TickMS | 守护进程自启动起的毫秒时间戳（uint32，约 49.7 天回绕） |
| 16..17 | uint16 | SignalCount | 信号条目数，当前恒为 80（`signal.Standard` 长度） |
| 18..19 | uint16 | RuleCount | 规则条目数（活跃 Profile 编译后的规则数） |

### 2.3 信号段定义 (Signals, 11 Bytes per item)
条目按 `signal.Standard` 词表索引从小到大顺序排列（当前 `id 0..79`，**APPEND ONLY**）。Profile 的 `signals:` 扩展名**不会**出现在 STATE1 中——`signal.Set.Telemetry()` 只遍历标准词表。

| 偏移 (Offset) | 类型 (Type) | 字段名 (Field) | 说明 (Description) |
|---|---|---|---|
| 0 | uint8 | ID | 信号词表 ID (`0..79`) |
| 1..4 | float32 | Shaped | 经死区、Gamma 与 SlewRate 整形后的值（规则实际输入） |
| 5..8 | float32 | Raw | 数据源直接提供的物理原始值 |
| 9..10 | uint16 | AgeMS | 距最近一次更新的毫秒数。**`0xFFFF` 表示 absent**（从未收到，或年龄已达/超过 65535ms 被截断） |

#### 2.3.1 新鲜度（freshness）如何推导

STATE1 帧里**没有 fresh 位，也没有 `signal_ttl` 字段**。`age_ms` 是唯一的事实值，fresh 完全由客户端推导：

```go
const absent = 0xFFFF
fresh := ageMS != absent && ageMS <= ttlMS
```

- `ttl_ms` 是**客户端自定义参数**，默认 **400ms**（`profile.DefaultSignalTTL`）。
- 服务端规则引擎使用同一个 TTL 语义，但它的值是 Profile 的 `safety.signal_ttl`，缺省/为 0 时回退 400ms。GUI 若要与规则引擎显示一致，应读取当前 Profile 的 `safety.signal_ttl`；读不到时用 400ms。
- `ttl_ms` 不会出现在 STATE1 里，`state.subscribe` / `health` 也不返回它。这是「客户端参数」，不是协议字段。
- 解码库里的 `SignalTelemetry.Fresh`（Go 实现）**只表示 `age_ms != 0xFFFF`**，不要直接拿它当 TTL freshness 使用。

三种状态判定：

| 状态 | 判定条件 | 建议显示 | 规则引擎实际行为 |
|---|---|---|---|
| **fresh** | `age_ms != 0xFFFF && age_ms <= ttl_ms` | 正常颜色 + 剩余 TTL 倒计时 | 值参与表达式，`has(name)` 为 1 |
| **stale** | `age_ms != 0xFFFF && age_ms > ttl_ms` | 变红/灰，可保留最后值并显示超时 | `Set.Snapshot` 丢弃过期值：表达式里该信号为 0，`has(name)` 为 0 |
| **absent** | `age_ms == 0xFFFF` | `absent` / 未提供（不要显示为 0） | 同 stale：无值，`has(name)` 为 0 |

### 2.4 规则段定义 (Rules, 13 Bytes per item)

| 偏移 (Offset) | 类型 (Type) | 字段名 (Field) | 说明 (Description) |
|---|---|---|---|
| 0..1 | uint16 | RuleID | **稳定 id**：`uint16(md5(rule.name) 前 2 字节, Little-Endian)`，跨 `profile.reload` 不变（见 2.4.1） |
| 2 | uint8 | State | 决策状态（数值 0..5，当前实际只会出现 0/1/2/4/5）：<br>`0`: FALSE (未命中)<br>`1`: TRUE (命中执行中)<br>`2`: HOLD (延迟保持中)<br>`3`: STALE (保留值，当前引擎不会写入)<br>`4`: COOLDOWN (冷却静默中)<br>`5`: ERROR (表达式求值异常) |
| 3..4 | int16 | Priority | 抢占优先级；条目顺序按 priority 升序 |
| 5..8 | uint32 | LastFireMS | 距上一次触发的毫秒数；从未触发为 0 |
| 9..12 | uint32 | UntilMS | 剩余 HOLD 保持时间（毫秒）；非 HOLD 状态为 0。它不是冷却倒计时 |

#### 2.4.1 `RuleID` 语义（稳定 id）

```go
func StableRuleID(name string) uint16 {
    sum := md5.Sum([]byte(name))
    return binary.LittleEndian.Uint16(sum[0:2])
}
```

- 同名必定同 id（进程重启、`profile.reload`、规则按 priority 重排都不影响）。
- 帧内**顺序仍按 priority 升序**；`RuleID` 与数组下标无关，客户端必须用 `rule_id` 作为 key（选中态、历史曲线、录像索引），**不要用数组下标**。
- 16-bit 空间对 <64 条规则足够：生日近似碰撞概率约 `64²/(2×65536) ≈ 3%`，且名字集合固定，不会每次运行随机变化；本仓库内置 Profile 实测为 110 条规则 / 91 个不同规则名、**0 碰撞**（有回归测试）。规则数量继续增长后，客户端仍应按 id 去重而不是假设唯一性。
- 同一 Profile 内非空规则名必须唯一：`profile.Validate()` 在 `LoadFile` / `Builtin` / `Dir` / `profile.reload` 时强制校验。重复时返回
  `profile X: duplicate rule name "foo" (rules[3] and rules[7])` 并拒绝加载，因此不会再出现两条命名规则共享同一个 `rule_id` 的情况。
- 匿名规则（`name` 为空）仍允许多条存在，其 label 回退为 `rules[i]`。历史 `far-far-west.yaml` 的重复名已在此前修复。

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
| 19..20 | uint16 | RateHz | `ds5d -rate` 当前值 (Hz) |
| 21..24 | uint32 | TickJitterUS | 最近输出周期抖动值 (微秒) |
| 25..28 | uint32 | HIDErrors | 物理 HID 报告写入失败计数 |
| 29..30 | uint16 | Subscribers | 当前连接到 IPC 的客户端总数（含 SIG1 订阅者，不只是 STATE1 订阅者） |
| 31 | uint8 | AimMismatch | 当前 `ds5d` **恒为 0**（未实现 aim 一致性检测）；客户端应容忍 0/1，但不要依赖它 |
| 32..39 | [8]uint8 | Reserved | 预留字节，写 0，客户端忽略 |

---

## 三、`CMD1` (0x31444D43) 双向控制面协议

客户端向 `127.0.0.1:9997` 发送带有长度前缀的 JSON 报文，服务端同步返回处理结果。

### 3.1 报文结构
- **Magic**：4 字节 `0x31444D43` ("CMD1", Little-Endian)
- **Length**：4 字节 uint32 载荷长度（上限 1 MiB，超限断开）
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

> 订阅之后，同一 TCP 连接会同时收到 CMD1 响应和 STATE1/SIG1 帧；按 4 字节 Magic 分流是唯一正确的读法。

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
- `subscribers` 是全部 IPC 客户端数；`jitter_us` 是最近一次 tick 的绝对抖动。

#### 2. `state.subscribe`
把**当前连接**切换为 STATE1 状态流订阅，并协商服务端 STATE1 推送频率。
- **请求参数**：`{"rate": 30}` 或 `{"rate": 60}`；省略 `rate` 或传入其他值时保持当前频率，不报错
- **返回结果**：`{"subscribed": true}`
- **副作用**：置位该连接的 state 订阅、清除其 signals 订阅，并丢弃已排队的旧帧；`rate` 作用于 `ds5d` 的**全局** STATE1 ticker（默认 30Hz），不是每客户端独立频率；不会立即推送一帧
- **幂等**：是（重复调用只是重复置位/清位与重设同一个 ticker）

#### 3. `signals.subscribe`
把当前连接切换为 **SIG1 原始遥测流**订阅（125Hz 路径），**不是 `state.subscribe` 的别名**。
- **请求参数**：无（`rate` 不被解析；SIG1 的节奏由数据源帧驱动，典型 125Hz，不做频率协商）
- **返回结果**：`{"subscribed": true}`
- **与 `state.subscribe` 的区别**：

  | | `state.subscribe` | `signals.subscribe` |
  |---|---|---|
  | 帧类型 | STATE1 (`0x31545453`) | SIG1 (`0x31474953`) |
  | 内容 | shaped + raw + age + 规则状态 + 输出摘要 | 仅 `id → raw float32`，无 shaped/age/fresh/规则/摘要 |
  | 频率 | 全局 ticker，默认 30Hz，可协商 60Hz | 跟随数据源帧，典型 125Hz |
  | 首帧 | 无（等下一次 tick） | 无（等下一帧源数据） |
  | 互斥 | 置位 state、清除 signals | 置位 signals、清除 state |

- **副作用**：清除该连接的 STATE1 订阅并丢弃已排队帧；两种订阅在同一连接上互斥，切换即可（不需要断开重连）
- **幂等**：是（重复调用返回同样的 `{"subscribed": true}`）
- **兼容行为**：连接建立后 20ms 内没有发送任何 CMD1 命令的客户端（老 `ds5radio` / FFB 监听器）会被自动视为 `signals.subscribe`；显式发过任意 CMD1 的客户端不会被自动订阅

#### 4. `profile.reload`
从磁盘重新装载当前活跃的 Profile 文件，校验无误后无损应用。
- **请求参数**：无
- **返回结果**：`{"reloaded": true}`
- **失败**：`ok=false` + 编译/校验错误信息，旧 Profile 保持运行
- **生效范围**：整形曲线（`set.SetShapers`）与规则（`engine.Reload`）；规则计时状态按**规则名**继承；`rule_id` 由名字派生，因此跨 reload 稳定

#### 5. `profile.apply`
动态局部打补丁，当前只支持 `shape`（信号整形曲线），用于 GUI 曲线编辑器拖拽时的免落盘实时试听。

- **请求参数**：
  ```json
  {
    "shape": {
      "throttle": { "deadzone": 0.05, "gamma": 1.2, "slew_up": 10.0, "slew_down": 20.0 }
    }
  }
  ```
- **返回结果**：
  ```json
  {
    "applied": ["throttle", "l2"],
    "ignored": ["nope", "r2"],
    "reasons": {
      "nope": "unknown signal",
      "r2": "gamma must be > 0"
    }
  }
  ```
- **合并语义**：
  - 只覆盖请求 `shape` 中出现的信号，其余信号的 shaping 完全保留。
  - 对出现的信号做字段级合并：只覆盖请求中显式出现的字段（`deadzone` / `gamma` / `slew_up` / `slew_down`），未出现字段保留当前运行时值。
  - 补丁仅作用于运行时 `signal.Set`，不写磁盘、不修改 `rules`、不触发 `engine.Reload`。
  - `profile.reload` 会重新读取 YAML 并整体替换运行时 shaper，因此补丁在 reload 后丢弃。
- **JSON / YAML 字段名**：`signal.Shaper` 已补 json tag，统一使用 `deadzone` / `gamma` / `slew_up` / `slew_down`；`slew_up` / `slew_down` 不再被静默忽略。
- **校验与回报**：
  - 非法 JSON、空 body、缺少 `shape` 或 `shape` 为空 -> `ok:false` + error，不应用任何补丁。
  - 未知信号（不在 `signal.Standard` 且不在 profile 的 `signals` 扩展中）-> 进入 `ignored`，原因为 `unknown signal`。
  - 数值越界 -> 对应信号进入 `ignored` 并附原因：`deadzone` 必须在 `[0,1]`，`gamma` 必须 `> 0`，`slew_up` / `slew_down` 必须 `>= 0`；单个信号内多个字段越界时只回报第一个原因（固定顺序 `deadzone → gamma → slew_up → slew_down`）。
  - 一个请求中合法与非法信号混合时，合法信号照常 `applied`，非法信号逐条 `ignored`。
  - `applied` / `ignored` 均排序，`reasons` 只包含被忽略的信号。
- 单条规则的 `params` / `when` / `priority` 热补丁尚未实现；需要实时试扳机力学时用 `effect.preview`，需要改规则时改 YAML 后调用 `profile.reload`。

#### 6. `effect.preview`
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
- `target`：`l2` / `r2` / `both`；`mode`：`hid.ParseMode` 接受的效果名；`params` 值为**字符串**，按 `hid.ParamIndex` 映射（也接受 `p0..p9`）
- `ttl_ms` 缺省/≤0 时为 1000ms
- **返回结果**：`{"preview": true}`；未知 mode 返回 `ok=false`
- **注意**：只影响 `ds5d` 的输出帧，不修改 Profile，也不持久化

#### 7. `rules.simulate`
离线安全试算（在隔离的克隆引擎中执行，输入一组假设信号，输出预期帧与规则决策，**不写硬件，不影响物理控制器**）。
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
- **返回结果**：`{"frame": {...hid.Frame...}, "rules": [{"rule_id": ..., "name": ..., "target": ..., "priority": ..., "state": ..., "last_fire_ms": ..., "until_ms": ...}]}`
- 这是客户端获取 `rule_id → name/target` 映射的推荐方式（STATE1 帧不含名字）

#### 8. `rate.set`
调整输出刷新率。
- **请求参数**：`{"hz": 250}`
- **返回结果**：`{"rate_set": true}`；参数非法/缺失时静默忽略，仍返回成功
- **注意**：修改的是 `ds5d` 的 `-rate` 值；`health.rate_hz` 与 STATE1 `summary.RateHz` 会在下一次读取时反映新值

#### 9. `hid.claim` / `hid.release`
声明或交还硬件操作权（当前仅返回成功占位，不实际改变 HID 所有权）。
- **请求参数**：无
- **返回结果**：`{"claimed": true}`

---

## 四、FPS 辅助瞄准与体感增强流水线 (`internal/aim`)

> 该能力位于 `main`（`f08394e`），由 **`ds5vpad`** 消费；`ds5d` 不运行 aim 流水线，因此 STATE1 里没有曲线/滤波/反后坐力字段，`summary.AimMismatch` 当前恒为 0。

针对单机 FPS 以及体感瞄准体验，完整实现了四阶级联数学流水线：

```
[原始摇杆 RX, RY] ──> [1. 响应曲线] ──> [2. One Euro 滤波] ──> [3. 陀螺仪角度投影] ──> [4. 自适应压枪] ──> [限幅输出]
```

### 4.1 数学模块详解
1. **响应曲线 (`CurveProcessor`)**：
   - 径向硬件死区截断：$r = \sqrt{x^2 + y^2}$，若 $r \le r_{dead}$ 输出 $(0, 0)$，否则归一化至 $[0, 1]$。
   - 支持曲线类型（`curve.type`）：
     - `linear`：线性传动。
     - `power`：幂律曲线 $r_{curved} = r_{norm}^\gamma$。
     - `sigmoid`：双归一化 S 型曲线，保证 $S(0) = 0$ 且 $S(1) = 1$，微操更柔，中段加速。
     - `dual_zone`：双区折线，分界点 `mid_point` 内部线性缓动，外部大角度转向。
   - 边缘加速 (`outer_boost`)：在推到底部 $r_{norm} \ge 0.95$ 时，平滑倍增至指定加速比。
2. **手抖自适应滤波 (`OneEuroFilter`)**：
   - `filter.type` 可选 `none` / `ema` / `one_euro`。
   - 采用 Géry Casiez 1€ 滤波算法：
     $$dx = \frac{x - x_{prev}}{dt}, \quad \hat{dx} = \alpha_d \cdot dx + (1 - \alpha_d)\hat{dx}_{prev}$$
     $$f_c = \text{min\_cutoff} + \beta \cdot |\hat{dx}|, \quad \hat{x} = \alpha_x \cdot x + (1 - \alpha_x)\hat{x}_{prev}$$
   - 低速微动时自动降低截止频率抑制生理颤抖；高速甩枪时动态跃升截止频率实现零延迟跟随。
3. **陀螺仪体感融合 (`GyroMapper`)**：
   - 依据握持姿态自然手倾角（默认 $35^\circ$）投影：
     $$\text{yaw}_{eff} = \text{yaw} \cdot \cos\theta - \text{roll} \cdot \sin\theta$$
   - 结合 DPS 静态噪声门限过滤环境传感器漂移。
   - 触发联动 (`gyro.trigger`)：`l2_hold`（举镜瞄准开启）、`touch`（轻触触控板开启）、`always`（全时开启）。
4. **后坐力反冲抑制 (`AntiRecoil`)**：
   - 当开火深度达到触发条件时触发（`anti_recoil.trigger`，如 `r2_full`；该字符串当前不做枚举校验）。
   - 爆发衰减与稳态保持：
     $$F(t) = F_{burst} \cdot e^{-\lambda t} + F_{sustain}$$
   - 叠提高斯随机扰动 $\sigma$ 防止弹道机械死板。

### 4.2 接入与配置规范
在 Profile 声明中直接配置 `aim:` 或 `aim_assist:`（`aim` 优先，两者等价）：
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
字段与 `internal/profile.AimConfig` 一一对应；`start_delay` 是 Go duration 字符串。

---

## 五、CLI 命令扩展与排障

`ds5ctl` 与 `ds5d` 协同的单所有权模式：
1. **健康状况查询**：
   ```bash
   ds5ctl health
   ds5ctl health -json        # 直接透传 health 的 JSON
   ```
2. **Profile 查询与预编译（JSON 格式供 UI 解析）**：
   ```bash
   ds5ctl profiles            # 内置列表
   ds5ctl profiles -dir ./profiles -json
   ds5ctl check -profile profiles/fps-aim.yaml -json
   ds5ctl check -profile fps -profiles ./profiles -json
   ```
   `check -json` 返回 `{"ok":true,"name":...,"rules":N,"source":"..."}`；编译失败时进程非 0 退出并把错误写到 stderr。
3. **单所有权硬件测试**：
   ```bash
   # 若 ds5d 正在运行，自动通过 CMD1（effect.preview）调度，不再报 device busy：
   ds5ctl bench -trigger r2 -each 2s
   # watch 在 ds5d 活跃时发送 state.subscribe 并解析 STATE1：
   ds5ctl watch
   ```

---

## 六、复核命令

```bash
# 后端能力是否存在
cd dualsense-c
git merge-base --is-ancestor bbfba7e HEAD && echo "STATE1/CMD1 OK"
git merge-base --is-ancestor cda3c2f HEAD && echo "signals.subscribe OK"
git log --oneline -1 -- internal/rules/stable_id.go   # 稳定 rule_id

# 帧布局与稳定 id 的自动化断言
go test ./internal/vpad/ipc/ -run StateFrame -v
go test ./internal/rules/ -run 'StableRuleID|TelemetryRuleIDs' -v

# 词表长度（当前 80，不是 76）
sed -n '/^var Standard = /,/^}/p' internal/signal/names.go | grep -o '"[a-z0-9_]*"' | wc -l   # -> 80
```
