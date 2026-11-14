import { EXT_DRIVER_TYPES } from './types.js';
import { HTTP_DRIVER_FACTORIES } from './drivers/http-drivers.js';
import { LOCAL_DRIVER_FACTORIES } from './drivers/local-drivers.js';
export const DRIVER_FACTORIES = {
    ...HTTP_DRIVER_FACTORIES,
    ...LOCAL_DRIVER_FACTORIES,
};
/** 编译期防漏:两张工厂表并起来必须恰好盖全 EXT_DRIVER_TYPES。 */
const _coverage = Object.keys(DRIVER_FACTORIES).sort();
void (_coverage.length === EXT_DRIVER_TYPES.length &&
    [...EXT_DRIVER_TYPES].sort().every((t, i) => t === _coverage[i]));
