import { FeeData, Wallet } from "ethers";
import pino from "pino";
import { HandleOrderResult, ProcessingQueue } from "./processing-queue";
import { UnderwriteOrder, GasFeeConfig, EvalOrder, GasFeeOverrides } from "../underwriter.types";
import { PoolConfig } from "src/config/config.service";
import { CatalystChainInterface__factory } from "src/contracts";


export class UnderwriteQueue extends ProcessingQueue<UnderwriteOrder, null> {

    private feeData: FeeData | undefined;

    private transactionNonce = 0;

    constructor(
        readonly pools: PoolConfig[],
        readonly retryInterval: number,
        readonly maxTries: number,
        readonly transactionTimeout: number,
        readonly gasFeeConfig: GasFeeConfig,
        private readonly signer: Wallet,
        private readonly logger: pino.Logger
    ) {
        super(retryInterval, maxTries);
    }

    async init(): Promise<void> {
        await this.updateTransactionCount();
        await this.updateFeeData();
    }

    protected async onProcessOrders(): Promise<void> {
        if (this.ordersQueue.length > 0) await this.updateFeeData();
    }

    protected async handleOrder(order: UnderwriteOrder, _retryCount: number): Promise<HandleOrderResult<null> | null> {

        const interfaceContract = CatalystChainInterface__factory.connect(order.interfaceAddress, this.signer);

        const underwriteTx = await interfaceContract.underwrite(    //TODO use underwriteAndCheckConnection
            order.toVault,
            order.toAsset,
            order.units,
            order.minOut,
            order.toAccount,
            order.underwriteIncentiveX16,
            order.calldata,
            {
                nonce: this.transactionNonce,
                gasLimit: order.gasLimit
            }
        );

        this.transactionNonce++;

        this.logger.info(
            {
                order: {
                    fromChainId: order.fromChainId,
                    fromVault: order.fromVault,
                    swapIdentifier: order.swapIdentifier,
                    toVault: order.toVault
                }
            },
            `Submitted underwrite (hash: ${underwriteTx?.hash} on block ${underwriteTx?.blockHash})`, //TODO id
        );

        const timingOutTxPromise: Promise<null> = Promise.race([
            underwriteTx.wait(),
            new Promise((_resolve, reject) =>
                setTimeout(() => reject("Underwrite tx TIMEOUT"), this.transactionTimeout)
            ),
        ]).then(() => null);
        
        return { result: timingOutTxPromise }
    }

    protected async handleFailedOrder(order: UnderwriteOrder, retryCount: number, error: any): Promise<boolean> {

        //TODO improve error filtering?
        if (error.code === 'CALL_EXCEPTION') {
            this.logger.info(
                `Error on underwrite submission ${'TODO'}: CALL_EXCEPTION. Dropping message. (try ${retryCount + 1})`,   //TODO id
            );
            return false;   // Do not retry eval
        }

        if (
            error.code === 'NONCE_EXPIRED' ||
            error.code === 'REPLACEMENT_UNDERPRICED' ||
            error.error?.message.includes('invalid sequence')
        ) {
            await this.updateTransactionCount();
        }

        this.logger.warn(
            error,
            `Error on underwrite submission ${'TODO'} (try ${retryCount + 1})`,  //TODO id
        );

        return true;
    }

    protected async onOrderCompletion(
        order: EvalOrder,
        success: boolean,
        _result: UnderwriteOrder | null,
        retryCount: number
    ): Promise<void> {
        if (success) {
            this.logger.debug(
                {
                    order: {
                        fromChainId: order.fromChainId,
                        fromVault: order.fromVault,
                        swapIdentifier: order.swapIdentifier,
                        toVault: order.toVault
                    }
                },
                `Successful underwrite of swap ${order.swapIdentifier} (swap txHash ${order.txHash}). (try ${retryCount + 1})`,
            );

        } else {
            this.logger.error(
                `Unsuccessful underwrite of swap ${order.swapIdentifier} (swap txHash ${order.txHash}).  (try ${retryCount + 1})`,
            );
        }
    }


    private async updateTransactionCount(): Promise<void> {
        let i = 1;
        while (true) {
            try {
                this.transactionNonce =
                    await this.signer.getNonce('pending'); //TODO 'pending' may not be supported
                break;
            } catch (error) {
                // Continue trying indefinitely. If the transaction count is incorrect, no transaction will go through.
                this.logger.error(error, `Failed to update nonce for chain (try ${i}).`);
                await new Promise((r) => setTimeout(r, this.retryInterval));
            }

            i++;
        }
    }

    private async updateFeeData(): Promise<void> {
        try {
            this.feeData = await this.signer.provider!.getFeeData();    //TODO handle null possibility
        } catch {
            // Continue with stale fee data.
        }
    }

    private getFeeDataForTransaction(): GasFeeOverrides {
        const queriedFeeData = this.feeData;
        if (queriedFeeData == undefined) {
            return {};
        }

        const queriedMaxPriorityFeePerGas = queriedFeeData.maxPriorityFeePerGas;
        if (queriedMaxPriorityFeePerGas != null) {
            // Set fee data for an EIP 1559 transactions
            const maxFeePerGas = this.gasFeeConfig.maxFeePerGas;

            // Adjust the 'maxPriorityFeePerGas' by the adjustment factor
            let maxPriorityFeePerGas;
            if (this.gasFeeConfig.maxPriorityFeeAdjustmentFactor != undefined) {
                maxPriorityFeePerGas = BigInt(Math.floor(
                    Number(queriedMaxPriorityFeePerGas) *
                    this.gasFeeConfig.maxPriorityFeeAdjustmentFactor,
                ));
            }

            // Apply the max allowed 'maxPriorityFeePerGas'
            if (
                maxPriorityFeePerGas != undefined &&
                this.gasFeeConfig.maxAllowedPriorityFeePerGas != undefined &&
                this.gasFeeConfig.maxAllowedPriorityFeePerGas < maxPriorityFeePerGas
            ) {
                maxPriorityFeePerGas = this.gasFeeConfig.maxAllowedPriorityFeePerGas;
            }

            return {
                maxFeePerGas,
                maxPriorityFeePerGas,
            };
        } else {
            // Set traditional gasPrice
            const queriedGasPrice = queriedFeeData.gasPrice;
            if (queriedGasPrice == null) return {};

            // Adjust the 'gasPrice' by the adjustment factor
            let gasPrice;
            if (this.gasFeeConfig.gasPriceAdjustmentFactor != undefined) {
                gasPrice = BigInt(Math.floor(
                    Number(queriedGasPrice) *
                    this.gasFeeConfig.gasPriceAdjustmentFactor,
                ));
            }

            // Apply the max allowed 'gasPrice'
            if (
                gasPrice != undefined &&
                this.gasFeeConfig.maxAllowedGasPrice != undefined &&
                this.gasFeeConfig.maxAllowedGasPrice < gasPrice
            ) {
                gasPrice = this.gasFeeConfig.maxAllowedGasPrice;
            }

            return {
                gasPrice,
            };
        }
    }
}