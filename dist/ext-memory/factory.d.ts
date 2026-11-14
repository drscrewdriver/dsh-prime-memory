/**
 * typeId → 驱动构造器的集中表(计划 T1.1-T1.9 的门面)。
 * 装配层(assembly.ts)只认这张表;新增驱动 = 加一行 + drivers/ 下补实现,
 * 不动 lane/registry/配置面(模板化判据:参考实现每包一份 descriptor 的分工,
 * 我们收成一个文件里的一个键——Phase 1 的合理规模)。
 */
import type { ExtDriverFactory, ExtDriverType } from './types.js';
export declare const DRIVER_FACTORIES: Readonly<Record<ExtDriverType, ExtDriverFactory>>;
