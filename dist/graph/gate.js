export function graphFeatureOn(cfg, live) {
    if (cfg.graph?.enabled === true)
        return true;
    try {
        return live?.get()?.graphEnabled === true;
    }
    catch {
        // live 读取失败：不能把已开的部署开关抬下来，也不能把功能卡死 → 按未开处理（零行为变化）。
        return false;
    }
}
