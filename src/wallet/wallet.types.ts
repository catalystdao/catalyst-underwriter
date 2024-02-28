import { TransactionRequest, TransactionReceipt, TransactionResponse } from "ethers";
import { MessagePort } from "worker_threads";



// Port Channels Types
// ************************************************************************************************
export interface WalletGetPortMessage {
    messageId: number;
}

export interface WalletGetPortResponse {
    messageId: number;
    port: MessagePort;
}

//TODO add 'priority'
export interface WalletTransactionRequestMessage<T = any> {
    messageId: number;
    txRequest: TransactionRequest;
    metadata: T;
    options?: WalletTransactionOptions;
}

export interface WalletTransactionRequestResponse<T = any> {
    messageId: number;
    txRequest: TransactionRequest;
    metadata: T;
    tx?: TransactionResponse;
    txReceipt?: TransactionReceipt;
    submissionError?: any;
    confirmationError?: any;
}



// Processing Types
// ************************************************************************************************
export interface WalletTransactionOptions {
    retryOnNonceConfirmationError?: boolean;    // Default: true, NOTE: this will cause the transaction to be executed out of order
    deadline?: number;                          // Default: undefined (i.e. no deadline)
}

export interface WalletTransactionRequest<T = any> {
    portId: number;
    messageId: number;
    txRequest: TransactionRequest;
    metadata: T;
    options: WalletTransactionOptions;
    requeueCount: number;
    submissionError?: any;
}

export interface PendingTransaction<T = any> extends WalletTransactionRequest<T> {
    tx: TransactionResponse;
    txReplacement?: TransactionResponse;
    confirmationError?: any;
}

export interface ConfirmedTransaction<T = any> extends WalletTransactionRequest<T> {
    tx: TransactionResponse;
    txReceipt: TransactionReceipt;
}



// Configuration Types
// ************************************************************************************************

export interface GasFeeOverrides {
    gasPrice?: bigint;
    maxFeePerGas?: bigint;
    maxPriorityFeePerGas?: bigint;
}

export interface GasFeeConfig {
    gasPriceAdjustmentFactor?: number;
    maxAllowedGasPrice?: number | string;
    maxFeePerGas?: number | string;
    maxPriorityFeeAdjustmentFactor?: number;
    maxAllowedPriorityFeePerGas?: number | string;
    priorityAdjustmentFactor?: number;
}

export interface BalanceConfig {
    lowBalanceWarning: bigint | undefined;
    balanceUpdateInterval: number;
}