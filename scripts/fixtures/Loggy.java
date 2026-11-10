import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStreamWriter;
import java.io.PrintWriter;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.HashMap;
import java.util.Map;

/**
 * Loggy —— Java 进程管理器测试夹具（单文件，JDK 11+，本阶段不编译，见同目录 README.md）。
 *
 * 行为由参数或系统属性控制（--key=value 程序参数优先，其次 -Dloggy.key=value，最后默认值）：
 *   mode          plain（默认）| gbk | sleep
 *                   plain  = 周期输出 UTF-8 日志（首行纯 ASCII banner + 后续中文，
 *                            覆盖"GBK 程序首行 ASCII banner 不误锁编码"判定场景）
 *                   gbk    = 中文按 GBK 输出（OutputStreamWriter 显式指定编码，
 *                            不依赖 file.encoding —— JDK18+ 默认 UTF-8 且运行时改不可靠）
 *                   sleep  = 先静默 sleep-seconds 秒再输出（长时间无输出，
 *                            验证 STARTING→RUNNING 的 5s 兜底判定）
 *   interval      周期日志间隔毫秒，默认 1000
 *   sleep-seconds sleep 模式静默时长秒，默认 60
 *   children      启动时派生 N 个长循环子进程，默认 0（验证 taskkill /T 进程树终止；
 *                   Windows 无 sleep 命令，用 `ping -n <大数> 127.0.0.1` 每秒一响应近似）
 *   log           日志文件路径；设置后模拟 logback：行写入该文件（恒 UTF-8）
 *   rotate        每写入 N 行将 log 文件 rename 为 <log>.1（覆盖旧 .1）并重建继续写
 *                   （logback rename 式轮转，默认 0 = 不轮转）
 *   duration      总运行秒数，默认 -1 = 一直运行直到被杀
 *   exit-after    运行 N 秒后 System.exit(exit-code)（默认 -1 = 不主动退出；
 *                   与 duration 互不冲突：exit-after 先到则以指定码退出）
 *   exit-code     exit-after 触发时的退出码，默认 3（非零 = ABNORMAL_EXIT 验证，A5）
 *
 * 日志行格式：yyyy-MM-dd HH:mm:ss.SSS [LEVEL] message
 * 级别分布：约 7 成 INFO、2 成 WARN、1 成 ERROR；每 50 行输出一段带多行堆栈的 ERROR
 * （首行有时间戳、at 续行无时间戳，验证检索时间窗/上下文对堆栈续行的归属）。
 */
public class Loggy {

  private static final DateTimeFormatter TS = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss.SSS");

  public static void main(String[] args) throws Exception {
    Map<String, String> opts = parseArgs(args);
    String mode = opt(opts, "mode", "plain");
    long intervalMs = Long.parseLong(opt(opts, "interval", "1000"));
    long sleepSec = Long.parseLong(opt(opts, "sleep-seconds", "60"));
    int children = Integer.parseInt(opt(opts, "children", "0"));
    String logPath = opt(opts, "log", "");
    int rotateEvery = Integer.parseInt(opt(opts, "rotate", "0"));
    long durationSec = Long.parseLong(opt(opts, "duration", "-1"));
    long exitAfterSec = Long.parseLong(opt(opts, "exit-after", "-1"));
    int exitCode = Integer.parseInt(opt(opts, "exit-code", "3"));

    boolean gbk = "gbk".equalsIgnoreCase(mode);
    boolean sleepMode = "sleep".equalsIgnoreCase(mode);
    Charset charset = gbk ? Charset.forName("GBK") : StandardCharsets.UTF_8;

    // 显式包装原始 stdout 指定编码：System.setProperty("file.encoding") 对已创建的
    // System.out PrintStream 不生效，且 JDK18+ file.encoding 默认 UTF-8，不可靠。
    PrintWriter console = new PrintWriter(
        new OutputStreamWriter(new FileOutputStream(FileDescriptor.out), charset), true);

    if (sleepMode) {
      // sleep 模式：先静默（此期间无任何输出，验证 STARTING→RUNNING 兜底），再进入正常输出
      Thread.sleep(sleepSec * 1000L);
    }

    long pid = ProcessHandle.current().pid();
    // 首行纯 ASCII banner：GBK/UTF-8 下字节完全一致，编码自动判定不得据此锁定
    console.println("Loggy v1.0 starting: mode=" + mode + ", pid=" + pid
        + ", charset=" + charset.name());

    if (children > 0) {
      spawnChildren(console, children);
    }

    PrintWriter file = logPath.isEmpty() ? null : openFile(Paths.get(logPath));
    int fileLines = 0;
    long seq = 0;
    long endAt = durationSec < 0 ? Long.MAX_VALUE
        : System.currentTimeMillis() + durationSec * 1000L;
    long exitAt = exitAfterSec < 0 ? Long.MAX_VALUE
        : System.currentTimeMillis() + exitAfterSec * 1000L;

    while (System.currentTimeMillis() < endAt) {
      if (System.currentTimeMillis() >= exitAt) {
        console.println(stamp() + " [ERROR] Loggy exiting abnormally with code " + exitCode);
        console.flush();
        if (file != null) {
          file.close();
        }
        System.exit(exitCode); // 非零退出码：驱动 ABNORMAL_EXIT 状态验证（A5）
      }
      String line = stamp() + " [" + level(seq) + "] " + message(seq);
      console.println(line);
      if (file != null) {
        file.println(line);
        file.flush();
        fileLines++;
        if (rotateEvery > 0 && fileLines >= rotateEvery) {
          rotate(Paths.get(logPath), file);
          file = openFile(Paths.get(logPath));
          fileLines = 0;
          console.println(stamp() + " [INFO] log rotated to " + logPath + ".1 ("
              + rotateEvery + " lines)");
        }
      }
      if (seq % 50 == 49) {
        printFakeStackTrace(console, file);
      }
      seq++;
      Thread.sleep(intervalMs);
    }

    console.println(stamp() + " [INFO] Loggy finished after " + seq + " lines");
    if (file != null) {
      file.close();
    }
    console.flush();
  }

  /**
   * 派生 N 个长循环子进程（存活至 68 年量级）：父进程被 taskkill /PID x /T /F 杀树时应一并终止。
   * Windows 无 sleep 命令，用 `ping -n 2147483647 127.0.0.1`（每秒一个响应）近似；
   * 非 Windows 用 sleep。子进程输出全部丢弃，避免污染本进程 stdout 日志流。
   */
  private static void spawnChildren(PrintWriter console, int n) {
    boolean windows = System.getProperty("os.name", "").toLowerCase().contains("win");
    for (int i = 1; i <= n; i++) {
      try {
        ProcessBuilder pb = windows
            ? new ProcessBuilder("ping", "-n", "2147483647", "127.0.0.1")
            : new ProcessBuilder("sleep", "2147483647");
        pb.redirectOutput(ProcessBuilder.Redirect.DISCARD);
        pb.redirectError(ProcessBuilder.Redirect.DISCARD);
        Process child = pb.start(); // 不 waitFor：子进程独立长循环
        console.println(stamp() + " [INFO] child #" + i + " spawned, pid=" + child.pid());
      } catch (IOException e) {
        console.println(stamp() + " [ERROR] child #" + i + " spawn failed: " + e);
      }
    }
  }

  /** 打开日志文件（父目录不存在则创建）；轮转后重建同名新文件从 0 写。文件恒为 UTF-8。 */
  private static PrintWriter openFile(Path path) throws IOException {
    Path parent = path.toAbsolutePath().getParent();
    if (parent != null) {
      Files.createDirectories(parent);
    }
    return new PrintWriter(Files.newBufferedWriter(path, StandardCharsets.UTF_8,
        StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING,
        StandardOpenOption.WRITE));
  }

  /** logback 式轮转：关闭当前文件，rename 为 <log>.1（覆盖旧 .1）；调用方随后重建同名文件继续写。 */
  private static void rotate(Path logFile, PrintWriter old) throws IOException {
    old.close();
    Files.move(logFile, logFile.resolveSibling(logFile.getFileName() + ".1"),
        StandardCopyOption.REPLACE_EXISTING);
  }

  private static String stamp() {
    return LocalDateTime.now().format(TS);
  }

  private static String level(long seq) {
    int m = (int) (seq % 10);
    if (m == 3) {
      return "WARN";
    }
    if (m == 7) {
      return "ERROR";
    }
    return "INFO";
  }

  private static String message(long seq) {
    int m = (int) (seq % 10);
    if (m == 3) {
      return "缓冲区使用率 " + (60 + seq % 30) + "%, 接近阈值";
    }
    if (m == 7) {
      return "调用下游服务超时: order-service no reply (seq=" + seq + ")";
    }
    return "服务运行正常, 已处理 " + seq * 100 + " 个请求";
  }

  /** 输出一段带堆栈的 ERROR：首行有时间戳，at 续行无时间戳——验证检索时间窗/上下文对堆栈续行的归属。 */
  private static void printFakeStackTrace(PrintWriter console, PrintWriter file) {
    StringBuilder sb = new StringBuilder();
    sb.append(stamp()).append(" [ERROR] 模拟业务异常: 订单结算失败 (order-10086)\n");
    sb.append("java.lang.RuntimeException: 余额不足\n");
    sb.append("    at com.demo.order.SettlementService.settle(SettlementService.java:88)\n");
    sb.append("    at com.demo.order.OrderController.submit(OrderController.java:45)\n");
    sb.append("    at java.base/java.lang.Thread.run(Thread.java:833)\n");
    String block = sb.toString();
    console.print(block);
    console.flush();
    if (file != null) {
      file.print(block);
      file.flush();
    }
  }

  /** 解析 --key=value（或 --flag 布尔简写）程序参数。 */
  private static Map<String, String> parseArgs(String[] args) {
    Map<String, String> m = new HashMap<>();
    for (String a : args) {
      if (a.startsWith("--")) {
        int eq = a.indexOf('=');
        if (eq > 2) {
          m.put(a.substring(2, eq), a.substring(eq + 1));
        } else if (eq < 0 && a.length() > 2) {
          m.put(a.substring(2), "true");
        }
      }
    }
    return m;
  }

  /** 优先级：程序参数 --key=value > 系统属性 -Dloggy.key > 默认值。 */
  private static String opt(Map<String, String> opts, String key, String def) {
    String v = opts.get(key);
    if (v == null) {
      v = System.getProperty("loggy." + key);
    }
    return v != null ? v : def;
  }
}
