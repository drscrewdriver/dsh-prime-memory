import type { ExternalMemoryDriver, ExtDriverFactoryInput } from '../types.js';
export declare const HTTP_DRIVER_FACTORIES: Record<'mem0' | 'hindsight' | 'openviking' | 'honcho' | 'retaindb' | 'supermemory', (i: ExtDriverFactoryInput) => ExternalMemoryDriver>;
