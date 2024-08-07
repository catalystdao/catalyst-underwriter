
export interface GlobalConfig {
    port: number;
    privateKey: Promise<string>;
    logLevel?: string;
    monitor: MonitorGlobalConfig;
    listener: ListenerGlobalConfig;
    underwriter: UnderwriterGlobalConfig;
    expirer: ExpirerGlobalConfig;
    wallet: WalletGlobalConfig;
}


export type PrivateKeyConfig = string | {
  loader: string;
}


export interface MonitorGlobalConfig {
    blockDelay?: number;
    retryInterval?: number;
}

export interface MonitorConfig extends MonitorGlobalConfig {
}


export interface ListenerGlobalConfig {
    retryInterval?: number;
    processingInterval?: number;
    maxBlocks?: number;
    startingBlock?: number; //TODO should this be here? (i.e. it shouldn't be in 'global')
}

export interface ListenerConfig extends ListenerGlobalConfig {}


export interface RelayDeliveryCosts {
    gasUsage: bigint;
    gasObserved?: bigint;
    fee?: bigint;
    value?: bigint;
}


export interface UnderwriterGlobalConfig {
    enabled?: boolean;
    retryInterval?: number;
    processingInterval?: number;
    maxTries?: number;
    maxPendingTransactions?: number;
    minRelayDeadlineDuration?: bigint;
    underwriteDelay?: number;
    maxUnderwriteDelay?: number;
    maxSubmissionDelay?: number;
    underwritingCollateral?: number;
    allowanceBuffer?: number;
    maxUnderwriteAllowed?: number;
    minUnderwriteReward?: number;
    relativeMinUnderwriteReward?: number;
    profitabilityFactor?: number;
    lowTokenBalanceWarning?: bigint;
    tokenBalanceUpdateInterval?: number;
    relayDeliveryCosts?: RelayDeliveryCosts;
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
    minUnderwriteDuration?: number;
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
    resolver: string | null;
    tokens: TokensConfig,
    monitor: MonitorConfig;
    listener: ListenerConfig;
    underwriter: UnderwriterConfig;
    expirer: ExpirerConfig;
    wallet: WalletConfig;
}


export interface TokenConfig {
    tokenId: string;
    allowanceBuffer?: bigint;
    maxUnderwriteAllowed?: number;
    minUnderwriteReward?: number;
    relativeMinUnderwriteReward?: number;
    profitabilityFactor?: number;
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
    relayDeliveryCosts?: RelayDeliveryCosts;
}

export interface VaultTemplateConfig {
    name: string;
    address: string;
}