# 测试夹具（Loggy）

单文件 Java 程序（JDK 11+），用于验证进程管理器各阶段行为（周期日志 / GBK 编码 / 派生子进程 / logback 式轮转 / 启动静默）。**工具本身不做编译构建**——夹具一次性手工预编译。

## 编译（S0 阶段不执行；S3 进程管理联调前完成一次）

```bash
cd scripts/fixtures
javac -encoding UTF-8 Loggy.java
jar --create --file=loggy.jar --main-class=Loggy Loggy.class
```

- 源码含中文，必须带 `-encoding UTF-8`。
- 产物 `Loggy.class` 与 `loggy.jar` 留在本目录（已被 .gitignore 忽略，本地保留即可）。
- 纳管示例：项目表单 jar 路径填 `...\java-process-manager\scripts\fixtures\loggy.jar`。
- JDK 11+ 也可单文件源码直接运行：`java Loggy.java --mode=gbk`（联调仍建议用 jar 形态）。

## 参数（两种写法，程序参数优先于系统属性）

| 参数 | 默认 | 说明 |
|---|---|---|
| `--mode` | `plain` | `plain` UTF-8 周期日志（首行 ASCII banner + 后续中文）；`gbk` 中文按 GBK 输出；`sleep` 先静默再输出 |
| `--interval` | `1000` | 周期日志间隔毫秒 |
| `--sleep-seconds` | `60` | `sleep` 模式静默时长秒（验证 STARTING→RUNNING 无输出兜底判定） |
| `--children` | `0` | 派生 N 个长循环子进程（Windows 用 `ping -n` 近似 sleep），日志打印子进程 PID，验证 `taskkill /T` 进程树终止 |
| `--log` | 无 | 日志文件路径；设置后行同步写入该文件（恒 UTF-8，父目录自动创建） |
| `--rotate` | `0` | 每写入 N 行把 log 文件 rename 为 `.1`（覆盖旧 `.1`）并重建继续写——logback rename 式轮转 |
| `--duration` | `-1` | 总运行秒数；`-1` = 一直运行直到被杀 |
| `--exit-after` | `-1` | 运行 N 秒后 `System.exit(exit-code)`；`-1` = 不主动退出（S3 异常退出码夹具，A5） |
| `--exit-code` | `3` | `exit-after` 触发时的退出码（非零 → 工具应显示 ABNORMAL_EXIT + 退出码） |

系统属性等价形式：`-Dloggy.mode=gbk`（填到项目"JVM 参数"）；程序参数 `--mode=gbk`（填到"程序参数"）。

## 场景示例

```bash
# 周期日志（UTF-8，首行 ASCII banner + 后续中文，每 50 行一段无时间戳堆栈）
java -jar loggy.jar

# GBK 中文输出（验证 stdout 编码检测锁定 GBK）
java -jar loggy.jar --mode=gbk

# 启动静默 60s（验证无输出时 STARTING 满配额秒数兜底转 RUNNING）
java -jar loggy.jar --mode=sleep --sleep-seconds=60

# 派生 2 个子进程（停止后 tasklist 核对进程树全灭）
java -jar loggy.jar --children=2

# 5 秒后以退出码 3 退出（验证 ABNORMAL_EXIT 状态 + 退出码展示，A5）
java -jar loggy.jar --exit-after=5 --exit-code=3

# logback 式轮转（tail 跟随 rename 滚动不丢跟）
java -jar loggy.jar --log=app.log --rotate=200

# 组合：GBK + 子进程 + 文件轮转 + 500ms 高频
java -jar loggy.jar --mode=gbk --children=2 --log=app.log --rotate=200 --interval=500
```

## 日志格式

```
yyyy-MM-dd HH:mm:ss.SSS [LEVEL] message
```

- 级别分布约 INFO 7 成 / WARN 2 成 / ERROR 1 成；每 50 行一段带堆栈的 ERROR（`at ...` 续行无时间戳）。
- 控制台编码随 `--mode`（plain=UTF-8 / gbk=GBK）；日志文件恒为 UTF-8。
