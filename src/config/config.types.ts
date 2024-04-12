
export interface GlobalConfig {
    port: number;
    privateKey: string;
    logLevel?: string;
    blockDelay?: number;
    monitor: MonitorGlobalConfig;
    listener: ListenerGlobalConfig;
    underwriter: UnderwriterGlobalConfig;
    expirer: ExpirerGlobalConfig;
    wallet: WalletGlobalConfig;
}


export interface MonitorGlobalConfig {
    interval?: number;
}

export interface MonitorConfig extends MonitorGlobalConfig {}


export interface ListenerGlobalConfig {
    retryInterval?: number;
    processingInterval?: number;
    maxBlocks?: number;
    startingBlock?: number; //TODO should this be here? (i.e. it shouldn't be in 'global')
}

export interface ListenerConfig extends ListenerGlobalConfig {}


export interface UnderwriterGlobalConfig {
    enabled?: boolean;
    retryInterval?: number;
    processingInterval?: number;
    maxTries?: number;
    maxPendingTransactions?: number;
    underwriteBlocksMargin?: number;
    minRelayDeadlineDuration?: bigint;
    underwriteDelay?: number;
    maxSubmissionDelay?: number;
    maxUnderwriteAllowed?: bigint;
    minUnderwriteReward?: bigint;
    lowTokenBalanceWarning?: bigint;
    tokenBalanceUpdateInterval?: number;
}

export interface UnderwriterConfig extends UnderwriterGlobalConfig {
    minMaxGasDelivery: bigint;
}


export interface ExpirerGlobalConfig {
    enabled?: boolean;
    retryInterval?: number;
    processingInterval?: number;
    maxTries?: number;
    maxPendingTransactions?: number;
    expireBlocksMargin?: number;
}

export interface ExpirerConfig extends ExpirerGlobalConfig {}


export interface WalletGlobalConfig {
    retryInterval?: number;
    processingInterval?: number;
    maxTries?: number;
    maxPendingTransactions?: number;
    confirmations?: number;
    confirmationTimeout?: number;
    lowGasBalanceWarning?: bigint;
    gasBalanceUpdateInterval?: number;
    maxFeePerGas?: bigint;
    maxAllowedPriorityFeePerGas?: bigint;
    maxPriorityFeeAdjustmentFactor?: number;
    maxAllowedGasPrice?: bigint;
    gasPriceAdjustmentFactor?: number;
    priorityAdjustmentFactor?: number;
}

export interface WalletConfig extends WalletGlobalConfig {
    rpc?: string;
}


export interface AMBConfig {
    name: string;
    relayPrioritisation: boolean;
    globalProperties: Record<string, any>;
}


export interface ChainConfig {
    chainId: string;
    name: string;
    rpc: string;
    blockDelay?: number;
    tokens: TokensConfig,
    monitor: MonitorConfig;
    listener: ListenerConfig;
    underwriter: UnderwriterConfig;
    expirer: ExpirerConfig;
    wallet: WalletConfig;
}


export interface TokenConfig {
    allowanceBuffer?: bigint;
    maxUnderwriteAllowed?: bigint;
    minUnderwriteReward?: bigint;
    lowTokenBalanceWarning?: bigint;
    tokenBalanceUpdateInterval?: number;
}

export type TokensConfig = Record<string, TokenConfig>;


export interface EndpointConfig {
    name: string;
    amb: string;
    chainId: string;
    factoryAddress: string;
    interfaceAddress: string;
    incentivesAddress: string;
    channelsOnDestination: Record<string, string>;
    vaultTemplates: VaultTemplateConfig[];
}

export interface VaultTemplateConfig {
    name: string;
    address: string;
}