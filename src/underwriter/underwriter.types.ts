import { TransactionReceipt, TransactionResponse } from "ethers";
import { VaultTemplateConfig } from "src/config/config.types";

export interface UnderwriterTokenConfig {
    tokenId: string;
    allowanceBuffer?: bigint;
    maxUnderwriteAllowed?: bigint;
    minUnderwriteReward: number;
    relativeMinUnderwriteReward: number;
    profitabilityFactor: number;
    lowTokenBalanceWarning?: bigint;
    tokenBalanceUpdateInterval?: number;
}

export interface UnderwriterEndpointConfig {
    name: string;
    amb: string;
    chainId: string;
    factoryAddress: string;
    interfaceAddress: string;
    incentivesAddress: string;
    channelsOnDestination: Record<string, string>;
    vaultTemplates: VaultTemplateConfig[];
    relayDeliveryCosts: UnderwriterRelayDeliveryCostsConfig;
}

export interface UnderwriterRelayDeliveryCostsConfig {
    gasUsage: bigint;
    gasObserved: bigint;
    fee: bigint;
    value: bigint;
}

export interface DiscoverOrder {
    // ! These are unsafe until the DiscoverQueue validates the order

    // Swap description
    fromChainId: string;
    fromVault: string;
    swapIdentifier: string;

    // Swap Parameters
    toVault: string;
    toAccount: string;
    units: bigint;
    toAssetIndex: bigint;
    minOut: bigint;
    underwriteIncentiveX16: bigint;
    calldata: string;

    swapTxHash: string;
    swapBlockNumber: number;    // This is the *observed* block number (not necessarily the *transaction* block number)
    swapBlockTimestamp: number;

    // AMB/Incentive Parameters
    amb: string;
    sourceIdentifier: string;
    toIncentivesAddress: string;
    interfaceAddress: string;
    messageIdentifier: string;
    deadline: bigint;
    maxGasDelivery: bigint;

    submissionDeadline: number;
}

export interface EvalOrder extends DiscoverOrder {
    toAsset: string;
    relayDeliveryCosts: UnderwriterRelayDeliveryCostsConfig;
}

export interface UnderwriteOrder extends EvalOrder {
    maxGasLimit: bigint;
    gasPrice: bigint;
    gasLimit?: bigint;
    toAssetAllowance: bigint;
}

export interface UnderwriteOrderResult extends UnderwriteOrder {
    tx: TransactionResponse;
    txReceipt: TransactionReceipt;
}

export interface PendingApproval {
    isApproval: boolean;
    interface: string;
    asset: string;
    setAllowance: bigint;
    requiredAllowance: bigint;
}


export interface NewOrder<OrderType> {
    order: OrderType;
    processAt: number;
}
