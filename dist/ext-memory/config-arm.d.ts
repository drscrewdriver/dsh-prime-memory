export interface ArmResult {
    nonce: string;
    expiresAt: number;
}
/** 签发一次性令牌:先扫掉过期项,超限则挤掉最早签发的。 */
export declare function arm(now?: number): ArmResult;
/** 消费校验:在场且未过期才通过,且**一次即销**(重放必失败)。 */
export declare function consume(nonce: unknown, now?: number): boolean;
/** 当前未消费令牌数(测试与诊断用)。 */
export declare function pendingCount(): number;
export declare function resetForTest(): void;
