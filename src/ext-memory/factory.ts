/**
 * typeId → 驱动构造器的集中表(计划 T1.1-T1.9 的门面)。
 * 装配层(assembly.ts)只认这张表;新增驱动 = 加一行 + drivers/ 下补实现,
 * 不动 lane/registry/配置面(模板化判据:参考实现每包一份 descriptor 的分工,
 * 我们收成一个文件里的一个键——Phase 1 的合理规模)。
 */
import type { ExtDriverFactory, ExtDriverType } from './types.js';
import { EXT_DRIVER_TYPES } from './types.js';
import { HTTP_DRIVER_FACTORIES } from './drivers/http-drivers.js';
import { LOCAL_DRIVER_FACTORIES } from './drivers/local-drivers.js';

export const DRIVER_FACTORIES: Readonly<Record<ExtDriverType, ExtDriverFactory>> = {
  ...HTTP_DRIVER_FACTORIES,
  ...LOCAL_DRIVER_FACTORIES,
};

/** 编译期防漏:两张工厂表并起来必须恰好盖全 EXT_DRIVER_TYPES。 */
const _coverage: string[] = Object.keys(DRIVER_FACTORIES).sort();
void (_coverage.length === EXT_DRIVER_TYPES.length &&
  [...EXT_DRIVER_TYPES].sort().every((t, i) => t === _coverage[i]));
