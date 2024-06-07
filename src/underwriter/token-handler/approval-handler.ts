import { TokensConfig } from "src/config/config.types";
import { TokenAddress } from "./token-handler";
import { WalletInterface } from "src/wallet/wallet.interface";
import { JsonRpcProvider, MaxUint256, TransactionRequest } from "ethers";
import pino from "pino";
import { Token__factory } from "src/contracts";
import { tryErrorToString } from "src/common/utils";

export interface ApprovalDescription {
    interfaceAddress: string;
    assetAddress: string;
    oldSetAllowance: bigint;
    newSetAllowance: bigint;
    requiredAllowance: bigint;
}

export class ApprovalHandler {

    private requiredAllowances = new Map<TokenAddress, bigint>();
    private setAllowances = new Map<TokenAddress, bigint>();

    constructor(
        private readonly chainId: string,
        private readonly tokensConfig: TokensConfig,
        private readonly interfaceAddress: string,
        private readonly walletPublicKey: string,
        private readonly wallet: WalletInterface,
        private readonly provider: JsonRpcProvider,
        private readonly logger: pino.Logger
    ) {
    }


    // Allowance setting helpers
    // ********************************************************************************************

    private async queryCurrentAllowance(
        assetAddress: string,
    ): Promise<bigint | undefined> {
        const tokenContract = Token__factory.connect(
            assetAddress,
            this.provider
        );

        try {
            return tokenContract.allowance(this.walletPublicKey, this.interfaceAddress);
        } catch {
            return undefined;
        }
    }

    private async initializeSetAllowance(assetAddress: string): Promise<bigint> {

        const setAllowance = await this.queryCurrentAllowance(assetAddress) ?? 0n;
        this.setAllowances.set(assetAddress, setAllowance);

        if (setAllowance != 0n) {
            this.logger.info(
                { allowance: setAllowance, asset: assetAddress, interface: this.interfaceAddress },
                'Existing allowance for interface contract found.'
            );
        }

        return setAllowance;
    }

    async setRequiredAllowances(): Promise<void> {

        // ! This function works by iterating over the 'this.requiredAllowances' keys, and
        // ! comparing them with the 'this.setAllowances' entries. The *required* map must thus
        // !  **always** contain all the keys that compose the *set* map, otherwise the *set*
        // ! allowances map may not be iterated through fully: i.e. once an allowance is not
        // ! anymore required it must be set to 0 rather than get removed from the map.

        const approvalPromises: Promise<void>[] = [];

        for (const [assetAddress, requiredAllowance] of this.requiredAllowances) {

            const setAllowance = this.setAllowances.get(assetAddress)
                ?? await this.initializeSetAllowance(assetAddress);

            const tokenConfig = this.tokensConfig[assetAddress];
            if (tokenConfig == undefined) {
                this.logger.error(
                    { assetAddress },
                    'Unable to set the token allowance. Token not supported.'
                );
                continue;
            }

            const assetAllowanceBuffer = tokenConfig.allowanceBuffer;

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
                this.logger.debug(
                    {
                        interfaceAddress: this.interfaceAddress,
                        assetAddress,
                        oldSetAllowance: setAllowance,
                        newSetAllowance
                    },
                    `Setting token allowance for interface contract.`
                );
                try {
                    const approvalPromise = this.setAllowance(
                        assetAddress,
                        setAllowance,
                        newSetAllowance,
                        requiredAllowance,
                    );
                    approvalPromises.push(approvalPromise);

                } catch {
                    // TODO is this required?
                }

            }
        }

        await Promise.allSettled(approvalPromises);
    }

    private async setAllowance(
        assetAddress: string,
        oldSetAllowance: bigint,
        newSetAllowance: bigint,
        requiredAllowance: bigint
    ): Promise<void> {
        const tokenContract = Token__factory.connect(assetAddress);
        const txData = tokenContract.interface.encodeFunctionData("approve", [
            this.interfaceAddress,
            newSetAllowance,
        ])
        const txRequest: TransactionRequest = {
            to: assetAddress,
            data: txData,
            //TODO set gas limit?
        }
        const approvalDescription: ApprovalDescription = {
            interfaceAddress: this.interfaceAddress,
            assetAddress,
            oldSetAllowance,
            newSetAllowance,
            requiredAllowance,
        }

        // Increase immediately the 'set' asset allowance. This is technically not correct
        // until the 'approve' transaction confirms, but is done to prevent further approve
        // transactions for the same allowance requirement to be issued.
        this.setAllowances.set(assetAddress, newSetAllowance);

        const result = await this.wallet.submitTransaction(
            this.chainId,
            txRequest,
            approvalDescription,
            {
                retryOnNonceConfirmationError: false    // If the tx fails to submit, do not retry as the tx order will not be maintained
            }
        );

        const logDescription = {
            interface: this.interfaceAddress,
            asset: assetAddress,
            oldSetAllowance,
            newSetAllowance,
            requiredAllowance,
            txHash: result.txReceipt?.hash,
            submissionError: tryErrorToString(result.submissionError),
            confirmationError: tryErrorToString(result.confirmationError),
        }

        if (result.submissionError || result.confirmationError) {
            //TODO do anything else if approve tx fails?
            this.logger.error(logDescription, 'Error on approval transaction.');

            // Since the approval has not been successful, decrease the 'set' allowance register.
            this.registerSetAllowanceDecrease(
                assetAddress,
                newSetAllowance - oldSetAllowance   // If old > new it effectively means 'increasing' the 'setAllowance'.
            );
        } else {
            this.logger.debug(logDescription, 'Approval transaction success');
        }

    }


    // Allowance registration helpers
    // ********************************************************************************************

    registerRequiredAllowanceChange(assetAddress: string, amount: bigint): void {

        const _assetAddress = assetAddress.toLowerCase();

        const currentAllowance = this.requiredAllowances.get(_assetAddress) ?? 0n;
        const newAllowance = currentAllowance + amount;
        if (newAllowance < 0n) {
            // NOTE: This should never happen
            this.logger.warn("Error on 'required' allowances change calculation: negative allowance result.");
            this.requiredAllowances.set(_assetAddress, 0n);
        } else {
            this.requiredAllowances.set(_assetAddress, newAllowance);
        }
    }

    registerRequiredAllowanceIncrease(assetAddress: string, amount: bigint): void {
        this.registerRequiredAllowanceChange(assetAddress, amount);
    }

    registerRequiredAllowanceDecrease(assetAddress: string, amount: bigint): void {
        this.registerRequiredAllowanceChange(assetAddress, -amount);
    }


    registerSetAllowanceChange(assetAddress: string, amount: bigint): void {

        const _assetAddress = assetAddress.toLowerCase();

        const currentAllowance = this.setAllowances.get(_assetAddress) ?? 0n;
        const newAllowance = currentAllowance + amount;
        if (newAllowance < 0n) {
            // NOTE: This should never happen
            this.logger.warn("Error on 'set' allowances change calculation: negative allowance result.");
            this.setAllowances.set(_assetAddress, 0n);
        } else {
            this.setAllowances.set(_assetAddress, newAllowance);
        }
    }

    registerSetAllowanceIncrease(assetAddress: string, amount: bigint): void {
        this.registerSetAllowanceChange(assetAddress, amount);
    }

    registerSetAllowanceDecrease(assetAddress: string, amount: bigint): void {
        this.registerSetAllowanceChange(assetAddress, -amount);
    }


    registerAllowanceUse(assetAddress: string, amount: bigint): void {
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

        this.registerRequiredAllowanceDecrease(assetAddress, amount);
        this.registerSetAllowanceDecrease(assetAddress, amount);
    }
}