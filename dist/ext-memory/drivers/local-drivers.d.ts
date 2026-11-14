import type { ExternalMemoryDriver, ExtDriverFactoryInput } from '../types.js';
export declare const LOCAL_DRIVER_FACTORIES: Record<'holographic' | 'byterover' | 'mnemon-native', (i: ExtDriverFactoryInput) => ExternalMemoryDriver>;
