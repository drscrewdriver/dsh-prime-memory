import type { MemoryLogger } from '../types.js';
export interface SecretStoreConfig {
    dataDir: string;
    /** 平台缝(测试注入;缺省 process.platform)。 */
    platform?: NodeJS.Platform;
    /** PowerShell 执行缝(测试注入;缺省 spawn powershell.exe,stdin 送脚本)。 */
    runPowerShell?: (script: string, env: Record<string, string>) => Promise<{
        code: number;
        stdout: string;
        stderr: string;
    }>;
    logger?: MemoryLogger;
}
export interface SecretStore {
    /** 读密钥;不存在/解密失败 → undefined(调用方按"未配置"处理)。 */
    get(ref: string): Promise<string | undefined>;
    set(ref: string, value: string): Promise<void>;
    delete(ref: string): Promise<void>;
    /** 已配置的键名(值不回显;面板只显示键名)。 */
    list(): Promise<string[]>;
    readonly backend: 'dpapi' | 'file';
}
export declare function createSecretStore(cfg: SecretStoreConfig): SecretStore;
/** `secret://ref` 形态的配置值 → { 源, ref };非该形态返回 undefined(兼容明文 apiKey)。 */
export declare function parseSecretRef(raw: string): {
    ref: string;
} | undefined;
