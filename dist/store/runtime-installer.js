/**
 * 运行时安装器:本地嵌入的推理运行时(@huggingface/transformers,纯库、二进制随
 * npm 包分发、零 postinstall)在用户首次开启本地嵌入时才安装——插件 npm 包本体
 * 不带重依赖,不用本地嵌入的用户零成本。
 *
 * - 安装位置:数据目录 runtime/(自带 package.json 锚定,防 npm 向上层目录逃逸安装);
 * - 包管理器探测(Windows DSH Desktop 不带 npm,硬编码必败):npm 在 PATH 走原链——
 *   探测 win32 `where npm` / posix `command -v npm`;npm 在位时 ci --ignore-scripts
 *   --no-audit --no-fund,钉死精确版本 + 随包 lockfile
 *   (resources/runtime-package-lock.json,构建期拷入 dist/)锁定完整传递依赖树——
 *   纯 install 只锁直接依赖,传递依赖按 semver 浮动解析,registry 端后续发布/投毒
 *   会随安装时间漂移;lockfile 把树冻结在作者侧。ci 失败(锁与 package.json 漂移等)
 *   自动回退 npm install 精确版本(可用性优先,树不再受锁);
 *   npm 缺席回退宿主自带 pnpm(node.exe 直跑 pnpm.cjs,install --node-linker=hoisted
 *   铺 npm 扁平形状——@img 判据与 sharp 原生加载都按该形状拼路径;随包锁是 npm 格式,
 *   pnpm 不认,故 pnpm 分支不跑 ci 只 install);双缺失 0 安装子进程直接报手工命令;
 * - 进度(用户硬性要求:不能傻等):npm 非交互模式无百分比 API,采用不确定进度——
 *   已耗时 + 子进程 stdout/stderr 尾行实时流出 + 可 kill;
 * - 幂等:已装版本 == 目标版本直接就绪;版本漂移(插件升级换了钉死版本)重装覆盖。
 */
import { spawn } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';
/** 钉死的 transformers.js 版本(精确版本,升级插件时在此变更并重装运行时)。 */
export const PINNED_TRANSFORMERS_VERSION = '4.2.0';
export class RuntimeInstaller {
    runtimeDir;
    target;
    logger;
    spawnImpl;
    /** 随包 lockfile 路径(测试可注入;默认取 dist 根下构建期拷入的资产)。 */
    lockfileSource;
    pmProbe;
    /** 探测结果缓存(undefined=未探过,null=探过全缺)。 */
    pm;
    progress;
    child = null;
    current = null;
    /** 安装超时(npm 卡死不罕见:registry 停滞即永挂,applyBusy 会被锁死)。每次 spawn 独立计时。 */
    static INSTALL_TIMEOUT_MS = 10 * 60_000;
    constructor(dataDir, targetVersion, opts) {
        this.runtimeDir = path.join(dataDir, 'runtime');
        this.target = targetVersion;
        this.logger = opts?.logger;
        this.lockfileSource =
            opts?.lockfileSource ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'runtime-package-lock.json');
        this.pmProbe = opts?.pmProbe ?? (() => this.probePackageManager());
        this.spawnImpl =
            opts?.spawnImpl ??
                ((command, args, cwd) => {
                    // 仅裸命令名(npm/pnpm,实为 .cmd shim)在 win 走 shell;绝对路径 node.exe 直起,
                    // 免得 shell:true 下带空格的安装路径("DeepSeek Harness")被 cmd 拆断。
                    const useShell = process.platform === 'win32' && !/[\\/]/.test(command) && !command.toLowerCase().endsWith('.exe');
                    const child = spawn(command, args, {
                        cwd,
                        shell: useShell,
                        windowsHide: true,
                    });
                    // shell 走的是 cmd.exe,中文 stderr 是 GBK;直起的 node/pnpm.cjs 输出为 UTF-8。
                    // 构造失败(ICU 无 gbk 的定制运行时)回退旧行为 String(d),不因解码面把安装弄炸。
                    let decoder = null;
                    if (useShell) {
                        try {
                            decoder = new TextDecoder('gbk');
                        }
                        catch {
                            decoder = null;
                        }
                    }
                    const toText = (d) => (decoder ? decoder.decode(d, { stream: true }) : String(d));
                    const spawned = {
                        onStdout(cb) {
                            child.stdout?.on('data', (d) => toText(d).split(/\r?\n/).forEach((l) => l && cb(l)));
                        },
                        onStderr(cb) {
                            child.stderr?.on('data', (d) => toText(d).split(/\r?\n/).forEach((l) => l && cb(l)));
                        },
                        // Windows shell:true 下 child 只是 cmd.exe,npm/node 孙进程不随 child.kill()
                        // 终止(超时与取消都会"表面停止")——taskkill /T 按进程树杀;非 shell 直起进程裸 kill 即够。
                        kill: () => {
                            if (useShell && child.pid !== undefined) {
                                const tk = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
                                tk.on('error', () => child.kill());
                            }
                            else {
                                child.kill();
                            }
                        },
                        // 'error'(如 ENOENT:PATH 无 npm)只发 error 不发 close——不监听会永挂
                        exited: new Promise((resolve) => {
                            child.on('close', (code) => resolve(code));
                            child.on('error', () => resolve(null));
                        }),
                    };
                    return spawned;
                });
        this.progress = {
            phase: 'idle',
            targetVersion: targetVersion,
            installedVersion: null,
            startedAt: 0,
            elapsedMs: 0,
            lastLines: [],
        };
    }
    /** 包内模块名(与钉死版本一起构成安装目标)。 */
    static packageName = '@huggingface/transformers';
    /** 进度快照。 */
    getProgress() {
        const elapsed = this.progress.phase === 'installing' ? Date.now() - this.progress.startedAt : this.progress.elapsedMs;
        return { ...this.progress, lastLines: [...this.progress.lastLines], elapsedMs: elapsed };
    }
    pkgJsonPath() {
        return path.join(this.runtimeDir, 'node_modules', RuntimeInstaller.packageName, 'package.json');
    }
    /** 已就位版本(读 package.json;未安装返回 null)。 */
    async installedVersion() {
        try {
            const raw = await fs.readFile(this.pkgJsonPath(), 'utf8');
            const pkg = JSON.parse(raw);
            return typeof pkg.version === 'string' ? pkg.version : null;
        }
        catch {
            return null;
        }
    }
    /** 是否就绪(版本精确匹配目标 + sharp 平台原生件就位;marker 只做记录与自愈,不短路存在性检查)。 */
    async isReady() {
        if ((await this.installedVersion()) !== this.target)
            return false;
        // fix #11 辅助检测:--ignore-scripts 安装半坏(平台原生包缺失/被剪)时,
        // transformers 顶层 require('sharp') 必炸——判存在性,缺失报未就绪触发重装。
        // marker 不参与判定:存在性检查永远跑,判据修复后每轮仅几次 fs 调用,短路收益≈0
        // 且会掩盖后续版本的半装状态(重装风暴的根因是判据错,不是缺 marker 短路机制)。
        if (!(await this.sharpNativePresent())) {
            await this.clearMarker();
            this.logger?.warn('[memory] 运行时 sharp 平台原生件缺失(半装状态),isReady=false 触发重装');
            return false;
        }
        // 自愈补写:老用户已装好但无 marker/内容陈旧的首轮补写,不影响返回值。
        await this.writeMarker();
        return true;
    }
    /**
     * 当前平台的 sharp 原生件候选路径(测试注入缝与单测共用,platform/arch 可参入驱动多平台形态):
     * 绑定 .node 在 @img/sharp-<os>-<arch>/lib/。libvips 位置分平台:
     * - win32:sharp 不发 @img/sharp-libvips-win32-*,libvips DLL 与 binding 同目录(sharp-win32-<arch>/lib/);
     * - 其余(darwin/linux):独立 @img/sharp-libvips-<os>-<arch>/lib/。
     * linux 有 glibc/musl 双候选;libvips 库文件名含版本串(仅 win 的 libvips-42.dll 稳定),
     * 故统一按 lib 目录内存在 libvips* 文件判定,不钉文件名。
     */
    sharpNativeCandidates(platform = process.platform, arch = process.arch) {
        const osKeys = platform === 'linux' ? ['linux', 'linuxmusl'] : platform === 'darwin' ? ['darwin'] : ['win32'];
        const img = path.join(this.runtimeDir, 'node_modules', '@img');
        const isWin = platform === 'win32';
        return osKeys.map((k) => {
            const pkgDir = path.join(img, `sharp-${k}-${arch}`);
            return {
                binding: path.join(pkgDir, 'lib', `sharp-${k}-${arch}.node`),
                libvipsDir: isWin ? path.join(pkgDir, 'lib') : path.join(img, `sharp-libvips-${k}-${arch}`, 'lib'),
            };
        });
    }
    /** 任一候选同时具备绑定 .node 与 libvips 库文件 → true(ENOENT/读取失败均计缺失)。 */
    async sharpNativePresent() {
        for (const c of this.sharpNativeCandidates()) {
            try {
                await fs.access(c.binding);
                const files = await fs.readdir(c.libvipsDir);
                if (files.some((f) => f.startsWith('libvips')))
                    return true;
            }
            catch {
                /* 本候选不命中,试下一个 */
            }
        }
        return false;
    }
    /** ready marker 路径(runtimeDir 下,随重装/版本漂移自然被版本轴隔开)。 */
    markerPath() {
        return path.join(this.runtimeDir, '.ready-marker.json');
    }
    /** 落盘就绪标记(写失败仅 warn,不影响 isReady 返回值——最坏回到每次跑判据)。 */
    async writeMarker() {
        const m = { target: this.target, platform: process.platform, arch: process.arch, at: Date.now() };
        try {
            await fs.writeFile(this.markerPath(), JSON.stringify(m));
        }
        catch (e) {
            this.logger?.warn(`[memory] ready marker 写入失败(忽略): ${String(e)}`);
        }
    }
    /** 判据失败时清掉过期 marker,保持"marker 存在⇔最近一次完整判据通过"不变式。 */
    async clearMarker() {
        try {
            await fs.rm(this.markerPath(), { force: true });
        }
        catch {
            /* 删失败忽略:marker 不参与判定,残留无行为影响 */
        }
    }
    /** 构造探测候选链:PATH npm → PATH pnpm → 宿主自带 pnpm(node.exe 直跑 pnpm.cjs)。 */
    buildPmCandidates() {
        const list = [
            { cmd: 'npm', argsPrefix: [], pnpmLike: false, label: 'npm' },
            { cmd: 'pnpm', argsPrefix: [], pnpmLike: true, label: 'pnpm' },
        ];
        const host = this.hostPnpmCandidate();
        if (host)
            list.push(host);
        return list;
    }
    /** 默认探测:逐候选跑 `--version` 取首个退出码 0 者;全缺返回 null。 */
    async probePackageManager() {
        for (const c of this.buildPmCandidates()) {
            const code = await this.runVersion(c);
            if (code === 0)
                return c;
        }
        return null;
    }
    /** 探活一次 `<cmd> [prefix] --version`(8s 超时兼启动失败→非 0)。 */
    runVersion(pm) {
        return new Promise((resolve) => {
            let settled = false;
            const done = (v) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                resolve(v);
            };
            const timer = setTimeout(() => {
                try {
                    child.kill();
                }
                catch {
                    /* noop */
                }
                done(null);
            }, 8000);
            const child = this.spawnImpl(pm.cmd, [...pm.argsPrefix, '--version'], this.runtimeDir);
            child.exited.then((code) => done(code));
        });
    }
    /** 宿主 pnpm 候选:node.exe 与 pnpm.cjs 均就位才返回(桌面端无 npm 时的兜底)。 */
    hostPnpmCandidate() {
        const deps = this.hostDepsDir();
        if (!deps)
            return null;
        const nodeExe = path.join(deps, 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node');
        const pnpmCjs = path.join(deps, 'pnpm', 'bin', 'pnpm.cjs');
        if (!existsSync(nodeExe) || !existsSync(pnpmCjs))
            return null;
        return { cmd: nodeExe, argsPrefix: [pnpmCjs], pnpmLike: true, label: 'pnpm(宿主)' };
    }
    /**
     * 定位宿主依赖目录(DSH Runtime 发 node/pnpm/python 那一层):
     * env 覆盖 → execPath 上溯(宿主自调起时即其目录系) → 默认安装根启发式
     * (%LOCALAPPDATA% 用户装 / %ProgramFiles% 机器装)。
     */
    hostDepsDir() {
        const rel = path.join('resources', 'runtime', 'primary-runtime', 'dependencies');
        const roots = [];
        const envRoot = process.env.DSH_RUNTIME_DIR;
        if (envRoot)
            roots.push(envRoot);
        let dir = path.dirname(process.execPath);
        for (let i = 0; i < 6; i++) {
            roots.push(dir);
            const parent = path.dirname(dir);
            if (parent === dir)
                break;
            dir = parent;
        }
        const la = process.env.LOCALAPPDATA;
        if (la)
            roots.push(path.join(la, 'Programs', 'DeepSeek Harness'));
        const pf = process.env.ProgramFiles;
        if (pf)
            roots.push(path.join(pf, 'DeepSeek Harness'));
        for (const r of roots) {
            const deps = path.join(r, rel);
            if (existsSync(path.join(deps, 'pnpm', 'bin', 'pnpm.cjs')))
                return deps;
        }
        return null;
    }
    /**
     * 确保运行时就位:版本匹配直接就绪;否则安装(忙时并 await 同一次任务)。
     * 返回是否就绪(失败/取消返回 false 并在 progress.error 说明原因)。
     */
    async ensure() {
        if (await this.isReady()) {
            this.progress.phase = 'ready';
            this.progress.installedVersion = this.target;
            return true;
        }
        if (this.current)
            return this.current;
        this.current = this.installOnce();
        try {
            return await this.current;
        }
        finally {
            this.current = null;
        }
    }
    /**
     * 取消安装(kill 子进程;node_modules 残留无害,npm 幂等重装)。
     * 间隙兼容:ci 退出到回退 install 起跑之间 child 为 null——此时也置取消态,
     * runInstall 起跑前复查即不再起新进程(否则回退的安装器会跑到自然结束且无法再取消)。
     */
    cancel() {
        if (this.progress.phase !== 'installing')
            return false;
        this.progress.phase = 'cancelled';
        this.child?.kill();
        return true;
    }
    pushLine(line) {
        const lines = this.progress.lastLines;
        lines.push(line.length > 300 ? line.slice(0, 300) + '…' : line);
        if (lines.length > 5)
            lines.splice(0, lines.length - 5);
    }
    /** 跑一次包管理器子进程(采集尾行 + 超时 kill),返回退出码(null = 被杀死/启动失败)。 */
    async runInstall(pm, args) {
        // 起跑前复查取消:cancel() 在上一进程退出与本进程 spawn 之间的间隙置位时,不再起新进程
        if (this.progress.phase === 'cancelled')
            return null;
        const child = this.spawnImpl(pm.cmd, [...pm.argsPrefix, ...args], this.runtimeDir);
        this.child = child;
        child.onStdout((l) => this.pushLine(l));
        child.onStderr((l) => this.pushLine(l));
        const timeout = setTimeout(() => {
            this.pushLine('安装超时(10 分钟),终止子进程');
            child.kill();
        }, RuntimeInstaller.INSTALL_TIMEOUT_MS);
        const code = await child.exited;
        clearTimeout(timeout);
        this.child = null;
        return code;
    }
    /** 取包管理器(首次 ensure 探一次即缓存;后续切源/重启不重复探活)。 */
    async resolvePm() {
        if (this.pm !== undefined)
            return this.pm;
        this.pm = await this.pmProbe();
        return this.pm;
    }
    /** 无可用包管理器时给一条可直接复制的手工安装命令(优先用发现的宿主 pnpm，命令与自动安装分支同式)。 */
    manualInstallHint() {
        const flags = 'install --node-linker=hoisted --ignore-scripts --config.confirmModulesPurge=false';
        const host = this.hostPnpmCandidate();
        if (host) {
            return `"${host.cmd}" "${host.argsPrefix[0]}" ${flags} --dir "${this.runtimeDir}"`;
        }
        return `在 ${this.runtimeDir} 执行: pnpm ${flags}`;
    }
    /** 取消态判定。独立方法而非内联比较:cancel() 在 await 期间跨方法置位
     *  phase,TS 的属性流分析不跟踪这种突变,内联比较会被窄化误报"无重叠"。 */
    wasCancelled() {
        return this.progress.phase === 'cancelled';
    }
    async installOnce() {
        // 锚定 package.json(带精确依赖):没有它包管理器会向上层目录找最近的 package.json 安装(逃逸事故);
        // npm ci 还要求它与 lockfile 根条目一致——每次安装都写规范化形状,覆盖历史遗留/被改写的副本。
        await fs.mkdir(this.runtimeDir, { recursive: true });
        const manifest = {
            name: 'dsh-memory-runtime',
            private: true,
            dependencies: { [RuntimeInstaller.packageName]: this.target },
        };
        await fs.writeFile(path.join(this.runtimeDir, 'package.json'), JSON.stringify(manifest, null, 2));
        // 先定位可用的包管理器:桌面端可能没有 npm,必须在起子进程前决定命令与参数形态。
        const pm = await this.resolvePm();
        this.progress = {
            phase: 'installing',
            targetVersion: this.target,
            installedVersion: await this.installedVersion(),
            startedAt: Date.now(),
            elapsedMs: 0,
            lastLines: [],
        };
        // 全缺:不白跑 spawn,直接给可复制的手工安装命令(桌面端最典型的就是这条路径)。
        if (!pm) {
            const hint = this.manualInstallHint();
            this.progress.phase = 'error';
            this.progress.elapsedMs = 0;
            this.progress.error = `未找到包管理器(npm/pnpm):请手工执行后重新启用 → ${hint}`;
            this.pushLine(this.progress.error);
            this.logger?.warn(`[memory] 运行时安装失败: ${this.progress.error}`);
            return false;
        }
        this.pushLine(`包管理器探测: ${pm.label}(${pm.cmd})`);
        this.logger?.info(`[memory] 运行时安装开始: ${RuntimeInstaller.packageName}@${this.target} → ${this.runtimeDir}(包管理器:${pm.label})`);
        let code;
        if (!pm.pnpmLike) {
            // npm: 首选 ci + 随包 lockfile(传递依赖树冻结在作者侧);lockfile 资产缺失或 ci 失败
            // (锁与锚定版本漂移等)回退 npm install 精确版本——可用性优先。
            code = null;
            let usedCi = false;
            try {
                const lock = await fs.readFile(this.lockfileSource, 'utf8');
                await fs.writeFile(path.join(this.runtimeDir, 'package-lock.json'), lock);
                this.pushLine('npm ci(随包 lockfile 锁定依赖树,@' + this.target + ',--ignore-scripts)');
                usedCi = true;
                code = await this.runInstall(pm, ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel', 'notice']);
            }
            catch {
                /* 无随包 lockfile,直接走 install 回退 */
            }
            // ci 阶段被取消(退出码 null)不得落入回退分支——那是"ci 失败"语义,会让
            // 取消后再白跑一次最长 10 分钟的 install
            if (this.wasCancelled()) {
                this.progress.elapsedMs = Date.now() - this.progress.startedAt;
                this.logger?.warn('[memory] 运行时安装已取消(残留无害,重装幂等)');
                return false;
            }
            if (!usedCi || code !== 0) {
                if (usedCi) {
                    this.pushLine('npm ci 失败(lockfile 与钉死版本漂移?),回退 npm install');
                    this.logger?.warn('[memory] 运行时 npm ci 失败,回退 npm install(传递依赖不再受随包 lockfile 锁定)');
                }
                this.pushLine(`npm install ${RuntimeInstaller.packageName}@${this.target}(--ignore-scripts)`);
                code = await this.runInstall(pm, [
                    'install',
                    '--ignore-scripts',
                    '--no-audit',
                    '--no-fund',
                    '--loglevel',
                    'notice',
                    `${RuntimeInstaller.packageName}@${this.target}`,
                ]);
            }
        }
        else {
            // pnpm(含宿主): 只 install 不 ci(随包锁是 npm 格式，pnpm 吃 pnpm-lock.yaml，硬套会装不上)。
            // --node-linker=hoisted 必带:默认 isolated 符号链接树下 node_modules/@img 顶层判据路径
            // 不存在、原生件加载也不稳;锚定 package.json 已声明精确依赖，install 即按锁安装。
            // --config.confirmModulesPurge=false:目录里已有 npm 形状 node_modules 时 pnpm 会要求
            // 确认 purge，非交互下必须预否(宿主 pnpm 11.x 实测)。
            this.pushLine(`${pm.label} install(${RuntimeInstaller.packageName}@${this.target} --ignore-scripts --node-linker=hoisted)`);
            code = await this.runInstall(pm, [
                'install',
                '--node-linker=hoisted',
                '--ignore-scripts',
                '--config.confirmModulesPurge=false',
            ]);
        }
        this.progress.elapsedMs = Date.now() - this.progress.startedAt;
        const version = await this.installedVersion();
        this.progress.installedVersion = version;
        if (this.wasCancelled()) {
            this.logger?.warn('[memory] 运行时安装已取消(残留无害,重装幂等)');
            return false;
        }
        if (code === 0 && version === this.target) {
            this.progress.phase = 'ready';
            // 不在此写 ready marker:installOnce 只验版本不验 sharp 原生件,这里写 marker 会与
            // isReady 的"marker 存在⇔完整判据通过"不变式相悖;统一由 isReady() 全判据后落盘。
            this.logger?.info(`[memory] 运行时安装完成: v${version}`);
            return true;
        }
        this.progress.phase = 'error';
        this.progress.error = `${pm.label} 退出码 ${code ?? '被杀死'}${version ? `(就位版本 ${version})` : '(模块未就位)'}`;
        this.logger?.warn(`[memory] 运行时安装失败: ${this.progress.error}`);
        return false;
    }
}
