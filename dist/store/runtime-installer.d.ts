import type { MemoryLogger } from '../types.js';
/** 钉死的 transformers.js 版本(精确版本,升级插件时在此变更并重装运行时)。 */
export declare const PINNED_TRANSFORMERS_VERSION = "4.2.0";
import type { RuntimeProgress } from '../contract.js';
export type { RuntimeProgress } from '../contract.js';
/** 子进程抽象(测试注入缝):注册输出行回调 + 终止 + 终态。 */
export interface SpawnedProcess {
    onStdout(cb: (line: string) => void): void;
    onStderr(cb: (line: string) => void): void;
    kill(): void;
    /** 终态 Promise:退出码(null = 被信号杀死)。 */
    exited: Promise<number | null>;
}
export type SpawnImpl = (command: string, args: string[], cwd: string) => SpawnedProcess;
/**
 * 包管理器候选:探测链的一员。cmd+argsPrefix 决定实际 spawn 形态——
 * PATH 上的 npm/pnpm 是可执行名;桌面端兜底是「宿主 node.exe 直跑 pnpm.cjs」
 * (argsPrefix=[pnpm.cjs]),不依赖 PATH。
 */
export interface PackageManagerCandidate {
    /** 实际 spawn 的可执行名或绝对路径。 */
    cmd: string;
    /** 前置参数(宿主 pnpm 走 node.exe 时为 [pnpm.cjs])。 */
    argsPrefix: string[];
    /** 是否 pnpm 语义(决定命令词 add/install 与 --node-linker=hoisted)。 */
    pnpmLike: boolean;
    /** 展示名(进度尾行/日志/报错文案)。 */
    label: string;
}
/** 包管理器探测注入缝(单测注入;默认走真实 spawn 逐候选探活)。 */
export type PmProbe = () => Promise<PackageManagerCandidate | null>;
export declare class RuntimeInstaller {
    readonly runtimeDir: string;
    private readonly target;
    private readonly logger?;
    private readonly spawnImpl;
    /** 随包 lockfile 路径(测试可注入;默认取 dist 根下构建期拷入的资产)。 */
    private readonly lockfileSource;
    private readonly pmProbe;
    /** 探测结果缓存(undefined=未探过,null=探过全缺)。 */
    private pm;
    private progress;
    private child;
    private current;
    /** 安装超时(npm 卡死不罕见:registry 停滞即永挂,applyBusy 会被锁死)。每次 spawn 独立计时。 */
    private static INSTALL_TIMEOUT_MS;
    constructor(dataDir: string, targetVersion: string, opts?: {
        logger?: MemoryLogger;
        spawnImpl?: SpawnImpl;
        lockfileSource?: string;
        pmProbe?: PmProbe;
    });
    /** 包内模块名(与钉死版本一起构成安装目标)。 */
    static packageName: string;
    /** 进度快照。 */
    getProgress(): RuntimeProgress;
    private pkgJsonPath;
    /** 已就位版本(读 package.json;未安装返回 null)。 */
    installedVersion(): Promise<string | null>;
    /** 是否就绪(版本精确匹配目标 + sharp 平台原生件就位;marker 只做记录与自愈,不短路存在性检查)。 */
    isReady(): Promise<boolean>;
    /**
     * 当前平台的 sharp 原生件候选路径(测试注入缝与单测共用,platform/arch 可参入驱动多平台形态):
     * 绑定 .node 在 @img/sharp-<os>-<arch>/lib/。libvips 位置分平台:
     * - win32:sharp 不发 @img/sharp-libvips-win32-*,libvips DLL 与 binding 同目录(sharp-win32-<arch>/lib/);
     * - 其余(darwin/linux):独立 @img/sharp-libvips-<os>-<arch>/lib/。
     * linux 有 glibc/musl 双候选;libvips 库文件名含版本串(仅 win 的 libvips-42.dll 稳定),
     * 故统一按 lib 目录内存在 libvips* 文件判定,不钉文件名。
     */
    sharpNativeCandidates(platform?: NodeJS.Platform, arch?: string): Array<{
        binding: string;
        libvipsDir: string;
    }>;
    /** 任一候选同时具备绑定 .node 与 libvips 库文件 → true(ENOENT/读取失败均计缺失)。 */
    private sharpNativePresent;
    /** ready marker 路径(runtimeDir 下,随重装/版本漂移自然被版本轴隔开)。 */
    private markerPath;
    /** 落盘就绪标记(写失败仅 warn,不影响 isReady 返回值——最坏回到每次跑判据)。 */
    private writeMarker;
    /** 判据失败时清掉过期 marker,保持"marker 存在⇔最近一次完整判据通过"不变式。 */
    private clearMarker;
    /** 构造探测候选链:PATH npm → PATH pnpm → 宿主自带 pnpm(node.exe 直跑 pnpm.cjs)。 */
    private buildPmCandidates;
    /** 默认探测:逐候选跑 `--version` 取首个退出码 0 者;全缺返回 null。 */
    private probePackageManager;
    /** 探活一次 `<cmd> [prefix] --version`(8s 超时兼启动失败→非 0)。 */
    private runVersion;
    /** 宿主 pnpm 候选:node.exe 与 pnpm.cjs 均就位才返回(桌面端无 npm 时的兜底)。 */
    private hostPnpmCandidate;
    /**
     * 定位宿主依赖目录(DSH Runtime 发 node/pnpm/python 那一层):
     * env 覆盖 → execPath 上溯(宿主自调起时即其目录系) → 默认安装根启发式
     * (%LOCALAPPDATA% 用户装 / %ProgramFiles% 机器装)。
     */
    private hostDepsDir;
    /**
     * 确保运行时就位:版本匹配直接就绪;否则安装(忙时并 await 同一次任务)。
     * 返回是否就绪(失败/取消返回 false 并在 progress.error 说明原因)。
     */
    ensure(): Promise<boolean>;
    /**
     * 取消安装(kill 子进程;node_modules 残留无害,npm 幂等重装)。
     * 间隙兼容:ci 退出到回退 install 起跑之间 child 为 null——此时也置取消态,
     * runInstall 起跑前复查即不再起新进程(否则回退的安装器会跑到自然结束且无法再取消)。
     */
    cancel(): boolean;
    private pushLine;
    /** 跑一次包管理器子进程(采集尾行 + 超时 kill),返回退出码(null = 被杀死/启动失败)。 */
    private runInstall;
    /** 取包管理器(首次 ensure 探一次即缓存;后续切源/重启不重复探活)。 */
    private resolvePm;
    /** 无可用包管理器时给一条可直接复制的手工安装命令(优先用发现的宿主 pnpm，命令与自动安装分支同式)。 */
    private manualInstallHint;
    /** 取消态判定。独立方法而非内联比较:cancel() 在 await 期间跨方法置位
     *  phase,TS 的属性流分析不跟踪这种突变,内联比较会被窄化误报"无重叠"。 */
    private wasCancelled;
    private installOnce;
}
