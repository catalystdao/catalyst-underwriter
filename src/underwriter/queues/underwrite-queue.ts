import { Wallet } from "ethers";
import pino from "pino";
import { HandleOrderResult, ProcessingQueue } from "./processing-queue";
import { UnderwriteOrder, UnderwriteOrderResult } from "../underwriter.types";
import { PoolConfig } from "src/config/config.service";
import { CatalystChainInterface__factory, Token__factory } from "src/contracts";
import { TransactionHelper } from "../transaction-helper";

//TODO handle stuck approval tx

export class UnderwriteQueue extends ProcessingQueue<UnderwriteOrder, UnderwriteOrderResult> {

    private requiredUnderwritingAllowances = new Map<string, Map<string, bigint>>();  // Maps interface => asset => allowance
    private setUnderwritingAllowances = new Map<string, Map<string, bigint>>();  // Maps interface => asset => allowance

    constructor(
        readonly pools: PoolConfig[],
        readonly retryInterval: number,
        readonly maxTries: number,
        private readonly transactionHelper: TransactionHelper,
        private readonly signer: Wallet,
        private readonly logger: pino.Logger
    ) {
        super(retryInterval, maxTries);
    }

    async init(): Promise<void> {
    }

    protected async onOrderInit(order: UnderwriteOrder): Promise<void> {

        this.registerRequiredAllowanceIncrease(order.interfaceAddress, order.toAsset, order.toAssetAllowance);
    }

    protected async onProcessOrders(): Promise<void> {
        await this.transactionHelper.updateFeeData();
        await this.setAllowances();
    }

    protected async handleOrder(
        order: UnderwriteOrder,
        _retryCount: number
    ): Promise<HandleOrderResult<UnderwriteOrderResult> | null> {

        const interfaceContract = CatalystChainInterface__factory.connect(order.interfaceAddress, this.signer);

        const tx = await interfaceContract.underwrite(    //TODO use underwriteAndCheckConnection
            order.toVault,
            order.toAsset,
            order.units,
            order.minOut,
            order.toAccount,
            order.underwriteIncentiveX16,
            order.calldata,
            {
                nonce: this.transactionHelper.getTransactionNonce(),
                gasLimit: order.gasLimit,
                ...this.transactionHelper.getFeeDataForTransaction()
            }
        );

        this.transactionHelper.increaseTransactionNonce();

        return { result: { tx, ...order } };
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
            error.error?.message.includes('invalid sequence') //TODO is this dangerous? (any contract may include that error)
        ) {
            await this.transactionHelper.updateTransactionNonce();
        }

        this.logger.warn(errorDescription, `Error on underwrite submission.`);

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
            underwriteTxHash: result?.tx.hash,
            try: retryCount + 1
        };

        if (success) {
            if (result != null) {
                this.registerAllowanceUse(
                    order.interfaceAddress,
                    order.toAsset,
                    order.toAssetAllowance
                );
                this.logger.debug(
                    orderDescription,
                    `Successful underwrite processing: underwrite submitted.`,
                );
            } else {
                this.registerRequiredAllowanceDecrease(
                    order.interfaceAddress,
                    order.toAsset,
                    order.toAssetAllowance
                );
                this.logger.debug(
                    orderDescription,
                    `Successful underwrite processing: underwrite not submitted.`,
                );
            }
        } else {
            this.registerRequiredAllowanceDecrease(
                order.interfaceAddress,
                order.toAsset,
                order.toAssetAllowance
            )
            this.logger.error(
                orderDescription,
                `Unsuccessful underwrite processing.`,
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
                                nonce: this.transactionHelper.getTransactionNonce(),
                                ...this.transactionHelper.getFeeDataForTransaction(),
                            }
                        );

                        this.transactionHelper.increaseTransactionNonce();

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
}