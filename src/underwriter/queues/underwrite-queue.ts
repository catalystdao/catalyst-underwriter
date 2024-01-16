import { FeeData, Wallet } from "ethers";
import pino from "pino";
import { HandleOrderResult, ProcessingQueue } from "./processing-queue";
import { UnderwriteOrder, GasFeeConfig, GasFeeOverrides, UnderwriteOrderResult } from "../underwriter.types";
import { PoolConfig } from "src/config/config.service";
import { CatalystChainInterface__factory, Token__factory } from "src/contracts";


export class UnderwriteQueue extends ProcessingQueue<UnderwriteOrder, UnderwriteOrderResult> {

    private feeData: FeeData | undefined;

    private transactionNonce = 0;

    private requiredUnderwritingAllowances = new Map<string, Map<string, bigint>>();  // Maps interface => asset => allowance
    private setUnderwritingAllowances = new Map<string, Map<string, bigint>>();  // Maps interface => asset => allowance

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
        await this.updateTransactionNonce();
        await this.updateFeeData();
    }

    protected async onOrderInit(order: UnderwriteOrder): Promise<void> {

        this.registerRequiredAllowanceIncrease(order.interfaceAddress, order.toAsset, order.toAssetAllowance);
    }

    protected async onProcessOrders(): Promise<void> {
        await this.updateFeeData();
        await this.setAllowances();
    }

    protected async handleOrder(order: UnderwriteOrder, retryCount: number): Promise<HandleOrderResult<UnderwriteOrderResult> | null> {

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

        //TODO add underwriteId to log? (note that this depends on the AMB implementation)
        const orderDescription = {
            fromVault: order.fromVault,
            fromChainId: order.fromChainId,
            swapTxHash: order.swapTxHash,
            swapId: order.swapIdentifier,
            underwriteTxHash: underwriteTx?.hash,
            try: retryCount + 1
        };

        this.logger.info(
            orderDescription,
            `Submitted underwrite.`,
        );

        const timingOutTxPromise: Promise<UnderwriteOrderResult> = Promise.race([

            underwriteTx.wait().then((receipt) => {
                if (receipt == null) {
                    throw new Error("Underwrite tx TIMEOUT");
                }
                return { underwriteTxHash: receipt.hash, ...order }
            }),

            new Promise<never>((_resolve, reject) =>
                setTimeout(() => reject("Underwrite tx TIMEOUT"), this.transactionTimeout)
            ),
        ]);
        
        return { result: timingOutTxPromise }
    }

    protected async handleFailedOrder(order: UnderwriteOrder, retryCount: number, error: any): Promise<boolean> {

        //TODO add underwriteId to log? (note that this depends on the AMB implementation)
        const errorDescription = {
            fromVault: order.fromVault,
            fromChainId: order.fromChainId,
            swapTxHash: order.swapTxHash,
            swapId: order.swapIdentifier,
            error,
            try: retryCount + 1
        };

        //TODO Improve error filtering?
        //TODO  - If invalid allowance => should retry
        //TODO  - If 'recentlyUnderwritten' => should not retry
        if (error.code === 'CALL_EXCEPTION') {
            this.logger.info(
                errorDescription,
                `Error on underwrite submission: CALL_EXCEPTION.`,
            );
            return false;   // Do not retry eval
        }

        if (
            error.code === 'NONCE_EXPIRED' ||
            error.code === 'REPLACEMENT_UNDERPRICED' ||
            error.error?.message.includes('invalid sequence')
        ) {
            await this.updateTransactionNonce();
        }

        this.logger.warn(
            errorDescription,
            `Error on underwrite submission ${'TODO'} (try ${retryCount + 1})`,  //TODO id
        );

        return true;
    }

    protected async onOrderCompletion(
        order: UnderwriteOrder,
        success: boolean,
        result: UnderwriteOrderResult | null,
        retryCount: number
    ): Promise<void> {

        //TODO add underwriteId to log? (note that this depends on the AMB implementation)
        const orderDescription = {
            fromVault: order.fromVault,
            fromChainId: order.fromChainId,
            swapTxHash: order.swapTxHash,
            swapId: order.swapIdentifier,
            underwriteTxHash: result?.underwriteTxHash,
            try: retryCount + 1
        };

        if (success) {
            this.registerAllowanceUse(
                order.interfaceAddress,
                order.toAsset,
                order.toAssetAllowance
            );
            this.logger.debug(
                orderDescription,
                `Successful underwrite of swap.`,
            );

        } else {
            this.registerRequiredAllowanceDecrease(
                order.interfaceAddress,
                order.toAsset,
                order.toAssetAllowance
            )
            this.logger.error(
                orderDescription,
                `Unsuccessful underwrite of swap.`,
            );
        }
    }


    private registerRequiredAllowanceIncrease(interfaceAddress: string, assetAddress: string, amount: bigint): void {

        const _interfaceAddress = interfaceAddress.toLowerCase();
        const _assetAddress = assetAddress.toLowerCase();

        let interfaceAllowances = this.requiredUnderwritingAllowances.get(_interfaceAddress);
        if (interfaceAllowances == undefined) {
            interfaceAllowances = new Map<string, bigint>();
            this.requiredUnderwritingAllowances.set(_interfaceAddress, interfaceAllowances)
        }

        const currentAllowance = interfaceAllowances.get(_assetAddress) ?? 0n;
        const newAllowance = currentAllowance + amount;
        interfaceAllowances.set(_assetAddress, newAllowance);
    }


    private registerRequiredAllowanceDecrease(interfaceAddress: string, assetAddress: string, amount: bigint): void {

        const _interfaceAddress = interfaceAddress.toLowerCase();
        const _assetAddress = assetAddress.toLowerCase();

        let interfaceAllowances = this.requiredUnderwritingAllowances.get(_interfaceAddress);
        if (interfaceAllowances == undefined) {
            interfaceAllowances = new Map<string, bigint>();
            this.requiredUnderwritingAllowances.set(_interfaceAddress, interfaceAllowances)
        }

        const currentAllowance = interfaceAllowances.get(_assetAddress) ?? 0n;
        const newAllowance = currentAllowance - amount;
        if (newAllowance < 0n) {
            // NOTE: This should never happen
            this.logger.warn("Error on 'required' allowances decrease calculation: negative allowance result.");
            interfaceAllowances.set(_assetAddress, 0n);
        } else {
            interfaceAllowances.set(_assetAddress, newAllowance);
        }
    }


    private registerSetAllowanceDecrease(interfaceAddress: string, assetAddress: string, amount: bigint): void {

        const _interfaceAddress = interfaceAddress.toLowerCase();
        const _assetAddress = assetAddress.toLowerCase();

        let interfaceAllowances = this.setUnderwritingAllowances.get(_interfaceAddress);
        if (interfaceAllowances == undefined) {
            interfaceAllowances = new Map<string, bigint>();
            this.setUnderwritingAllowances.set(_interfaceAddress, interfaceAllowances)
        }

        const currentAllowance = interfaceAllowances.get(_assetAddress) ?? 0n;
        const newAllowance = currentAllowance - amount;
        if (newAllowance < 0n) {
            // NOTE: This should never happen
            this.logger.warn("Error on 'set' allowances decrease calculation: negative allowance result.");
            interfaceAllowances.set(_assetAddress, 0n);
        } else {
            interfaceAllowances.set(_assetAddress, newAllowance);
        }
    }

    private registerAllowanceUse(interfaceAddress: string, assetAddress: string, amount: bigint): void {
        // Decrease the registered 'required' **and** the 'set' allowances so that on the next
        // `setAllowances` call the allowance for the asset in question is **not** updated. This is
        // desired for when an 'underwrite' order is successful.
        // ! NOTE: the allowance set for an underwrite is in most cases not the exact token amount
        // ! that is used for the underwrite. This is because the exact token amount required for 
        // ! the underwrite is unknown until the underwrite is performed. As a result, by using
        // ! this method whenever an underwrite succeeds, a (smallish) allowance will be left for
        // ! the token of the underwrite, as the allowances are overestimated to make sure that the
        // ! transactions go through. This ‘hanging’ allowance will be left until another
        // ! underwrite order for the same token is processed on another undewrite batch.

        this.registerRequiredAllowanceDecrease(interfaceAddress, assetAddress, amount);
        this.registerSetAllowanceDecrease(interfaceAddress, assetAddress, amount);
    }


    private async setAllowances(): Promise<void> {

        // ! This function works by iterating over the 'this.requiredUnderwritingAllowances' keys
        // ! (the **required** allowances), and comparing them with the
        // ! 'this.setUnderwritingAllowances' entries (the *set* allowances). The *required* map 
        // ! must thus **always** contain all the keys that compose the *set* map, otherwise the 
        // ! *set* allowances map may not be iterated through fully: i.e. once an allowance is not
        // ! anymore required it must be set to 0 rather than get removed from the map.

        for (const [interfaceAddress, requiredAssetAllowances] of this.requiredUnderwritingAllowances) {

            let setAssetAllowances = this.setUnderwritingAllowances.get(interfaceAddress);
            if (setAssetAllowances == undefined) {
                setAssetAllowances = new Map<string, bigint>();
                this.setUnderwritingAllowances.set(interfaceAddress, setAssetAllowances);
            }

            for (const [assetAddress, requiredAllowance] of requiredAssetAllowances) {

                const setAllowance = setAssetAllowances.get(assetAddress) ?? 0n;

                if (requiredAllowance != setAllowance) {

                    try {
                        this.logger.debug(
                            {
                                interfaceAddress,
                                assetAddress,
                                requiredAllowance
                            },
                            `Setting token allowance for interface contract.`
                        );
                        const tokenContract = Token__factory.connect(
                            assetAddress,
                            this.signer
                        );
                        const approveTx = await tokenContract.approve(
                            interfaceAddress,
                            requiredAllowance,   //TODO set gas limit?
                            {
                                nonce: this.transactionNonce
                            }
                        );

                        this.transactionNonce++;

                        await approveTx.wait(); //TODO this should not block the loop, but rather all txs should be awaited for at the end of the loop (with a timeout)

                        setAssetAllowances.set(assetAddress, requiredAllowance);

                    } catch {
                        // TODO implement retry? If this 'approve' call fails, any orders that are executed
                        // on the batch that follows this call that require the approvals may fail (if the allowance
                        // is being increased.)
                    }

                }
            }

        }

    }


    private async updateTransactionNonce(): Promise<void> {
        let i = 1;
        while (true) {
            try {
                this.transactionNonce =
                    await this.signer.getNonce('pending'); //TODO 'pending' may not be supported
                break;
            } catch (error) {
                // Continue trying indefinitely. If the transaction count is incorrect, no transaction will go through.
                this.logger.error(
                    { error, try: i },
                    `Failed to update nonce for chain.`
                );
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