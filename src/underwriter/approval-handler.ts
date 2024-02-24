import pino from "pino";
import { UnderwriteOrder } from "./underwriter.types";
import { Token__factory } from "src/contracts";
import { TransactionResult, WalletInterface } from "src/wallet/wallet.interface";
import { JsonRpcProvider, MaxUint256, TransactionRequest } from "ethers";
import { WalletTransactionOptions } from "src/wallet/wallet.types";
import { TokenConfig } from "src/config/config.service";

interface ApprovalDescription {
    interfaceAddress: string;
    assetAddress: string;
    oldSetAllowance: bigint;
    newSetAllowance: bigint;
    requiredAllowance: bigint;
}

export class ApprovalHandler {

    private requiredUnderwritingAllowances = new Map<string, Map<string, bigint>>();  // Maps interface => asset => allowance
    private setUnderwritingAllowances = new Map<string, Map<string, bigint>>();  // Maps interface => asset => allowance

    constructor(
        readonly retryInterval: number,
        readonly tokens: Record<string, TokenConfig>,
        private readonly walletPublicKey: string,
        private readonly wallet: WalletInterface,
        private readonly provider: JsonRpcProvider,
        private readonly logger: pino.Logger
    ) {
    }

    async updateAllowances(...newOrders: UnderwriteOrder[]): Promise<void> {
        for (const order of newOrders) {
            this.registerRequiredAllowanceIncrease(order.interfaceAddress, order.toAsset, order.toAssetAllowance);
        }

        await this.setAllowances();
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


    registerRequiredAllowanceDecrease(interfaceAddress: string, assetAddress: string, amount: bigint): void {

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


    registerSetAllowanceDecrease(interfaceAddress: string, assetAddress: string, amount: bigint): void {

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

    registerAllowanceUse(interfaceAddress: string, assetAddress: string, amount: bigint): void {
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

        const approvalPromises: Promise<void>[] = [];
        for (const [interfaceAddress, requiredAssetAllowances] of this.requiredUnderwritingAllowances) {

            let setAssetAllowances = this.setUnderwritingAllowances.get(interfaceAddress);
            if (setAssetAllowances == undefined) {
                setAssetAllowances = new Map<string, bigint>();
                this.setUnderwritingAllowances.set(interfaceAddress, setAssetAllowances);
            }

            for (const [assetAddress, requiredAllowance] of requiredAssetAllowances) {

                let setAllowance = setAssetAllowances.get(assetAddress);
                if (setAllowance == undefined) {
                    setAllowance = await this.queryCurrentAllowance(assetAddress, interfaceAddress)
                        ?? 0n;
                    setAssetAllowances.set(assetAddress, setAllowance);

                    if (setAllowance != 0n) {
                        this.logger.info(
                            { allowance: setAllowance, asset: assetAddress, interface: interfaceAddress },
                            'Existing allowance for interface contract found.'
                        );
                    }
                }

                // If 'assetAddress' is not in 'tokens' the following will fail. This should never
                // happen, as the 'eval-queue' already checks that the token in question is
                // supported.
                const assetAllowanceBuffer = this.tokens[assetAddress].allowanceBuffer;

                // Determine if the asset allowance has to be updated according to the following
                // logic:
                //   - If there is no 'assetAllowanceBuffer' for the asset, set an 'unlimited'
                //     approval.
                //   - If there is an 'assetAllowanceBuffer':
                //       - If the 'setAllowance' is less than the 'requiredAllowance' increase the
                //         allowance (inc. buffer).
                //       - If the 'setAllowance' exceeds the 'requiredAllowance' by twice the
                //         buffer amount decrease the set allowance (keeping a buffer). This
                //         'twice' factor is used to avoid triggering many 'allowance change'
                //         transactions when operating at an allowance-changing threshold.
                let newSetAllowance = undefined;
                if (assetAllowanceBuffer == null) {
                    if (setAllowance < MaxUint256 / 2n) {   // Divide by 2 to avoid reissuing the 'approve' tx as the allowance gets used
                        newSetAllowance = MaxUint256;
                    }
                } else if (
                    setAllowance < requiredAllowance ||
                    setAllowance > (requiredAllowance + assetAllowanceBuffer * 2n)
                ) {
                    newSetAllowance = requiredAllowance + assetAllowanceBuffer;
                }

                if (newSetAllowance != undefined) {
                    try {
                        this.logger.debug(
                            {
                                interfaceAddress,
                                assetAddress,
                                oldSetAllowance: setAllowance,
                                newSetAllowance
                            },
                            `Setting token allowance for interface contract.`
                        );
                        const tokenContract = Token__factory.connect(
                            assetAddress
                        );
                        const txData = tokenContract.interface.encodeFunctionData("approve", [
                            interfaceAddress,
                            newSetAllowance,   
                        ])
                        const txRequest: TransactionRequest = {
                            to: assetAddress,
                            data: txData,
                            //TODO set gas limit?
                        }
                        const approvalDescription: ApprovalDescription = {
                            interfaceAddress,
                            assetAddress,
                            oldSetAllowance: setAllowance,
                            newSetAllowance,
                            requiredAllowance,
                        }
                        const walletOptions: WalletTransactionOptions = {
                            retryOnNonceConfirmationError: false    // If the tx fails to submit, do not retry as the tx order will not be maintained
                        }

                        // Increase immediately the 'set' asset allowance. This is technically not correct
                        // until the 'approve' transaction confirms, but is done to prevent further approve
                        // transactions for the same allowance requirement to be issued.
                        setAssetAllowances.set(assetAddress, newSetAllowance);

                        const approvalPromise = this.wallet.submitTransaction(txRequest, approvalDescription, walletOptions)
                            .then(transactionResult => this.onTransactionResult(transactionResult));
                        approvalPromises.push(approvalPromise);

                    } catch {
                        // TODO is this required?
                    }

                }
            }

        }

        await Promise.allSettled(approvalPromises);
    }

    private async queryCurrentAllowance(
        assetAddress: string,
        interfaceAddress: string,
    ): Promise<bigint | undefined> {
        const tokenContract = Token__factory.connect(
            assetAddress,
            this.provider
        );

        try {
            return tokenContract.allowance(this.walletPublicKey, interfaceAddress);
        } catch {
            return undefined;
        }
    }

    private onTransactionResult(result: TransactionResult): void {
        const {
            interfaceAddress,
            assetAddress,
            oldSetAllowance,
            newSetAllowance,
            requiredAllowance
        } = result.metadata as ApprovalDescription;

        const logDescription = {
            interface: interfaceAddress,
            asset: assetAddress,
            oldSetAllowance,
            newSetAllowance,
            requiredAllowance,
            txHash: result.txReceipt?.hash,
            submissionError: result.submissionError,
            confirmationError: result.confirmationError,
        }

        if (result.submissionError || result.confirmationError) {
            //TODO do anything else if approve tx fails?
            this.logger.error(logDescription, 'Error on approval transaction.');
            
            // Since the approval has not been successful, decrease the 'set' allowance register.
            this.registerSetAllowanceDecrease(
                interfaceAddress,
                assetAddress,
                newSetAllowance - oldSetAllowance   // If old > new it effectively means 'increasing' the 'setAllowance'.
            );
        } else {
            this.logger.debug(logDescription, 'Approval transaction success');
        }

    }
    
}