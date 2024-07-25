import { Block, JsonRpcProvider, Log, LogDescription } from "ethers";
import pino from "pino";
import { workerData, MessagePort } from 'worker_threads';
import { ListenerWorkerData } from "./listener.service";
import { CatalystChainInterface__factory } from "src/contracts";
import { CatalystChainInterfaceInterface, ExpireUnderwriteEvent, FulfillUnderwriteEvent, SwapUnderwrittenEvent } from "src/contracts/CatalystChainInterface";
import { calcAssetSwapIdentifier, tryErrorToString, wait } from "src/common/utils";
import { Store } from "src/store/store.lib";
import { MessageContext, SOURCE_TO_DESTINATION, parsePayload } from "src/common/decode.payload";
import { SwapState, SwapStatus, UnderwriteState, UnderwriteStatus } from "src/store/store.types";
import { MonitorInterface, MonitorStatus } from "src/monitor/monitor.interface";
import { ASSET_SWAP, CatalystContext, catalystParse } from "src/common/decode.catalyst";
import { EndpointConfig } from "src/config/config.types";
import WebSocket from "ws";
import { STATUS_LOG_INTERVAL } from "src/logger/logger.service";


//TODO the TransactionDescription and the AMBMessage types should be imported from the relayer repo!
interface TransactionDescription {
    transactionHash: string;
    blockHash: string;
    blockNumber: number;
}

interface AMBMessage<T = any> extends TransactionDescription {
    messageIdentifier: string;

    amb: string;
    fromChainId: string;
    toChainId: string;
    fromIncentivesAddress: string;
    toIncentivesAddress?: string;    

    incentivesPayload: string;
    recoveryContext?: string;
    additionalData?: T;

    transactionBlockNumber?: number;    // The block number as seen by the transaction.

    priority?: boolean;
};

interface CatalystSwapAMBMessageData {
    ambMessageMetadata: AMBMessage,
    incentivesMessage: SOURCE_TO_DESTINATION,
    assetSwapPayload: ASSET_SWAP,
    originEndpoint: EndpointConfig
}

class ListenerWorker {
    private readonly store: Store;
    private readonly logger: pino.Logger;

    private readonly config: ListenerWorkerData;

    private readonly provider: JsonRpcProvider;

    private readonly chainId: string;
    private readonly chainName: string;

    private readonly chainInterfaceEventsInterface: CatalystChainInterfaceInterface;
    private readonly addresses: string[];
    private readonly topics: string[][];

    private readonly blockQuerier: BlockQuerier;
    private readonly catalystSwapMessagesQueue: CatalystSwapAMBMessageData[] = [];

    private currentStatus: MonitorStatus | null = null;

    private fromBlock: number = 0;


    constructor() {
        this.config = workerData as ListenerWorkerData;

        this.chainId = this.config.chainId;
        this.chainName = this.config.chainName;

        this.addresses = this.getAllAddresses(this.config.endpointConfigs);

        this.store = new Store();
        this.logger = this.initializeLogger(this.chainId);
        this.provider = this.initializeProvider(this.config.rpc);

        const contractTypes = this.initializeContractTypes();
        this.chainInterfaceEventsInterface = contractTypes.chainInterfaceInterface;
        this.topics = contractTypes.topics;

        this.blockQuerier = this.initializeBlockQuerier(
            this.provider,
            this.config.retryInterval,
        );

        this.startListeningToMonitor(this.config.monitorPort);
        this.startListeningToRelayer();

        this.initiateIntervalStatusLog();
    }



    // Initialization helpers
    // ********************************************************************************************

    private initializeLogger(chainId: string): pino.Logger {
        return pino(this.config.loggerOptions).child({
            worker: 'listener',
            chain: chainId,
        });
    }

    private initializeProvider(rpc: string): JsonRpcProvider {
        return new JsonRpcProvider(
            rpc,
            undefined,
            { staticNetwork: true }
        )
    }

    private getAllAddresses(endpointConfigs: EndpointConfig[]): string[] {
        const allInterfaceAddresses = endpointConfigs.map((config) => config.interfaceAddress);

        return [
            ...new Set(allInterfaceAddresses)   // Filter out duplicates
        ]
    }

    private initializeContractTypes(): {
        chainInterfaceInterface: CatalystChainInterfaceInterface,
        topics: string[][]
    } {

        const chainInterfaceInterface = CatalystChainInterface__factory.createInterface();
        const topics = [
            [
                chainInterfaceInterface.getEvent('SwapUnderwritten').topicHash,
                chainInterfaceInterface.getEvent('FulfillUnderwrite').topicHash,
                chainInterfaceInterface.getEvent('ExpireUnderwrite').topicHash
            ]
        ];

        return {
            chainInterfaceInterface,
            topics
        }
    }

    private initializeBlockQuerier(
        provider: JsonRpcProvider,
        queryRetryInterval: number
    ): BlockQuerier {
        return new BlockQuerier(
            provider,
            this.logger,
            queryRetryInterval
        );
    }

    private startListeningToMonitor(port: MessagePort): MonitorInterface {
        const monitor = new MonitorInterface(port);

        monitor.addListener((status) => {
            this.currentStatus = status;
        });

        return monitor;
    }

    private startListeningToRelayer(): void {
        this.logger.info(`Start listening to the relayer for new AMB messages.`);

        const wsUrl = `http://${process.env['RELAYER_HOST']}:${process.env['RELAYER_PORT']}/`;
        const ws = new WebSocket(wsUrl);

        ws.on("open", () => {
            // Subscribe to new AMB messages
            ws.send(
                JSON.stringify({ event: "ambMessage" }),
                (error) => {
                    if (error != null) {
                        this.logger.error("Failed to subscribe to 'ambMessage' events.");
                    }
                }
            );
        });

        ws.on("error", (error) => {
            this.logger.warn(
                {
                    wsUrl,
                    error: tryErrorToString(error)
                },
                'Error on websocket connection.'
            );
        });

        ws.on("close", (exitCode) => {
            this.logger.warn(
                {
                    wsUrl,
                    exitCode,
                    retryInterval: this.config.retryInterval
                },
                'Websocket connection with relayer closed. Will attempt reconnection.'
            );

            setTimeout(() => this.startListeningToRelayer(), this.config.retryInterval);
        });

        ws.on("message", (data) => {
            const parsedMessage = JSON.parse(data.toString());

            if (parsedMessage.event == "ambMessage") {
                const ambMessage: AMBMessage = parsedMessage.data;
                if (ambMessage == undefined) {
                    this.logger.warn(
                        { parsedMessage },
                        "No data present on 'ambMessage' event."
                    )
                }
                if (ambMessage.fromChainId != this.chainId) return;

                this.logger.info(
                    { messageIdentifier: ambMessage.messageIdentifier },
                    "AMB message received.",
                );

                try {
                    void this.processAMBMessage(ambMessage);
                } catch {
                    this.logger.warn(
                        { ambMessage },
                        "Failed to process the AMB message.",
                    )
                }
            } else {
                this.logger.warn(
                    { message: data },
                    "Unknown message type received on websocket connection.",
                )
            }
        });
    }



    // Main handler
    // ********************************************************************************************
    async run(): Promise<void> {
        this.logger.info(
            { addresses: this.addresses },
            `Listener worker started.`
        );

        this.fromBlock = await this.getStartingBlock();

        while (true) {
            try {
                let toBlock = this.currentStatus?.blockNumber;
                if (!toBlock || this.fromBlock > toBlock) {
                    await wait(this.config.processingInterval);
                    continue;
                }

                const blocksToProcess = toBlock - this.fromBlock;
                if (this.config.maxBlocks != null && blocksToProcess > this.config.maxBlocks) {
                    toBlock = this.fromBlock + this.config.maxBlocks;
                }

                this.logger.debug(
                    {
                        fromBlock: this.fromBlock,
                        toBlock,
                    },
                    `Scanning underwrites.`,
                );
                await this.queryAndProcessEvents(this.fromBlock, toBlock);

                this.fromBlock = toBlock + 1;
            }
            catch (error) {
                this.logger.error(error, `Failed on listener.worker`);
                //TODO add delay
            }

            await this.processCatalystSwapMessagesQueue();

            await wait(this.config.processingInterval);
        }
    }

    private async getStartingBlock(): Promise<number> {
        let fromBlock: number | null = null;
        while (fromBlock == null) {

            // Do not initialize 'fromBlock' whilst 'currentStatus' is null, even if
            // 'startingBlock' is specified.
            if (this.currentStatus == null) {
                await wait(this.config.processingInterval);
                continue;
            }

            if (this.config.startingBlock == null) {
                fromBlock = this.currentStatus.blockNumber;
                break;
            }

            if (this.config.startingBlock < 0) {
                fromBlock = this.currentStatus.blockNumber + this.config.startingBlock;
                if (fromBlock < 0) {
                    throw new Error(`Invalid 'startingBlock': negative offset is larger than the current block number.`)
                }
            } else {
                fromBlock = this.config.startingBlock;
            }
        }

        return fromBlock;
    }

    private async queryAndProcessEvents(
        fromBlock: number,
        toBlock: number
    ): Promise<void> {

        const logs = await this.queryLogs(fromBlock, toBlock);

        for (const log of logs) {
            try {
                await this.handleInterfaceEvent(log);
            } catch (error) {
                this.logger.error(
                    { log, error: tryErrorToString(error) },
                    `Failed to process event on listener worker.`
                );
            }
        }
    }

    private async queryLogs(
        fromBlock: number,
        toBlock: number
    ): Promise<Log[]> {
        const filter = {
            address: this.addresses,
            topics: this.topics,
            fromBlock,
            toBlock
        };

        let logs: Log[] | undefined;
        let i = 0;
        while (logs == undefined) {
            try {
                logs = await this.provider.getLogs(filter);
            } catch (error) {
                i++;
                this.logger.warn(
                    { ...filter, error: tryErrorToString(error), try: i },
                    `Failed to 'getLogs' on listener. Worker blocked until successful query.`
                );
                await wait(this.config.retryInterval);
            }
        }

        return logs;
    }

    // Event handlers
    // ********************************************************************************************

    private async handleInterfaceEvent(log: Log): Promise<void> {
        const parsedLog = this.chainInterfaceEventsInterface.parseLog({
            topics: Object.assign([], log.topics),
            data: log.data,
        });

        if (parsedLog == null) {
            this.logger.error(
                { topics: log.topics, data: log.data },
                `Failed to parse Catalyst chain interface contract event.`,
            );
            return;
        }

        switch (parsedLog.name) {
            case 'SwapUnderwritten':
                await this.handleSwapUnderwrittenEvent(log, parsedLog);
                break;

            case 'FulfillUnderwrite':
                await this.handleFulfillUnderwriteEvent(log, parsedLog);
                break;

            case 'ExpireUnderwrite':
                await this.handleExpireUnderwriteEvent(log, parsedLog);
                break;

            default:
                this.logger.warn(
                    { name: parsedLog.name, topic: parsedLog.topic },
                    `Event with unknown name/topic received.`,
                );
        }

    }


    private async handleSwapUnderwrittenEvent(
        log: Log,
        parsedLog: LogDescription
    ): Promise<void> {

        const interfaceAddress = log.address;
        const event = parsedLog.args as unknown as SwapUnderwrittenEvent.OutputObject;

        const underwriteId = event.identifier;

        this.logger.info(
            { interfaceAddress: log.address, txHash: log.transactionHash, underwriteId },
            `SwapUnderwritten event captured.`
        );

        const blockData = await this.blockQuerier.getBlock(log.blockNumber);
        if (blockData == undefined) {
            this.logger.warn(
                { blockNumber: log.blockNumber },
                `Unable to query block data: dropping SwapUnderwritten event.`
            );
            return;
        }

        const underwriteState: UnderwriteState = {
            toChainId: this.chainId,
            toInterface: interfaceAddress,
            status: UnderwriteStatus.Underwritten,
            underwriteId,
            swapUnderwrittenEvent: {
                txHash: log.transactionHash,
                blockHash: log.blockHash,
                blockNumber: log.blockNumber,   // ! This 'blockNumber' may not be able to be compared with the 'expiry' block number (on chains like Arbitrum a custom 'resolver' has to be used.)
                blockTimestamp: blockData.timestamp,
                underwriter: event.underwriter,
                expiry: Number(event.expiry),
                targetVault: event.targetVault,
                toAsset: event.toAsset,
                units: event.U,
                toAccount: event.toAccount,
                outAmount: event.outAmount,
            },
        }

        await this.store.saveActiveUnderwriteState(underwriteState);
    };


    private async handleFulfillUnderwriteEvent(
        log: Log,
        parsedLog: LogDescription
    ): Promise<void> {

        const interfaceAddress = log.address;
        const event = parsedLog.args as unknown as FulfillUnderwriteEvent.OutputObject;

        const underwriteId = event.identifier;

        this.logger.info(
            { interfaceAddress: log.address, txHash: log.transactionHash, underwriteId },
            `FulfillUnderwrite event captured.`
        );

        const underwriteState: UnderwriteState = {
            toChainId: this.chainId,
            toInterface: interfaceAddress,
            status: UnderwriteStatus.Underwritten,
            underwriteId,
            fulfillUnderwriteEvent: {
                txHash: log.transactionHash,
                blockHash: log.blockHash,
                blockNumber: log.blockNumber,
            }
        }

        await this.store.saveActiveUnderwriteState(underwriteState);
    };


    private async handleExpireUnderwriteEvent(
        log: Log,
        parsedLog: LogDescription
    ): Promise<void> {

        const interfaceAddress = log.address;
        const event = parsedLog.args as unknown as ExpireUnderwriteEvent.OutputObject;

        const underwriteId = event.identifier;

        this.logger.info(
            { interfaceAddress: log.address, txHash: log.transactionHash, underwriteId },
            `ExpireUnderwrite event captured.`
        );

        const underwriteState: UnderwriteState = {
            toChainId: this.chainId,
            toInterface: interfaceAddress,
            status: UnderwriteStatus.Underwritten,
            underwriteId,
            expireUnderwriteEvent: {
                txHash: log.transactionHash,
                blockHash: log.blockHash,
                blockNumber: log.blockNumber,
                expirer: event.expirer,
                reward: event.reward,

            }
        }

        await this.store.saveActiveUnderwriteState(underwriteState);
    };



    // Websocket handlers
    // ********************************************************************************************

    private async processAMBMessage(
        ambMessage: AMBMessage,
    ): Promise<void> {

        const giPayload = parsePayload(ambMessage.incentivesPayload);
        if (giPayload.context != MessageContext.CTX_SOURCE_TO_DESTINATION) return;

        // Verify the sending Catalyst interface and GI escrow are trusted
        const sourceApplication = giPayload.sourceApplicationAddress;   // ! NOTE: this address cannot be trusted until the source escrow implementation is verified

        // NOTE: the 'interfaceAddress' fields within the 'endpointConfigs' array are unique (verified on config service)
        const endpointConfig = this.config.endpointConfigs.find((endpointConfig) => {
            return endpointConfig.interfaceAddress == sourceApplication.toLowerCase();
        });

        if (endpointConfig == undefined) {
            this.logger.info(
                { sourceApplication },
                "Skipping AMB message: source application is not a configured endpoint."
            );
            return;
        }

        // ! Verify the sending escrow matches the expected one for the found interface address
        if (endpointConfig.incentivesAddress != ambMessage.fromIncentivesAddress.toLowerCase()) {
            this.logger.info(
                { sourceApplication },
                "Skipping AMB message: source escrow (incentives address) does not match the configured endpoint (possible malicious AMB payload)."
            );
            return;
        }

        const catalystPayload = catalystParse(giPayload.message);
        if (catalystPayload.context != CatalystContext.ASSET_SWAP) return;

        if (
            ambMessage.blockNumber == undefined
            || ambMessage.transactionBlockNumber == undefined
            || ambMessage.blockHash == undefined
        ) {
            // NOTE: this may happen for AMBs which are 'recovered' by the relayer (i.e. old AMBs).
            this.logger.info(
                { messageIdentifier: giPayload.messageIdentifier },
                "Unable to process AMB message. Block number/hash missing"
            );
            return;
        }

        this.catalystSwapMessagesQueue.push({
            ambMessageMetadata: ambMessage,
            incentivesMessage: giPayload,
            assetSwapPayload: catalystPayload,
            originEndpoint: endpointConfig,
        });

    }

    private async processCatalystSwapMessagesQueue(): Promise<void> {

        const currentBlockNumber = this.currentStatus?.blockNumber;
        if (currentBlockNumber == undefined) {
            return;
        }

        // Only process swaps whose block numbers are within the underwriter's delayed block
        // number value (the relayer may run ahead of the underwriter).
        let i;
        for (i = 0; i < this.catalystSwapMessagesQueue.length; i++) {
            const swapData = this.catalystSwapMessagesQueue[i]!;

            if (swapData.ambMessageMetadata.blockNumber > currentBlockNumber) {
                return;
            }

            await this.processCatalystSwap(
                swapData.ambMessageMetadata,
                swapData.incentivesMessage,
                swapData.assetSwapPayload,
                swapData.originEndpoint
            );
        }

        this.catalystSwapMessagesQueue.splice(0, i);
    }

    private async processCatalystSwap(
        ambMessageMetadata: AMBMessage,
        incentivesMessage: SOURCE_TO_DESTINATION,
        assetSwapPayload: ASSET_SWAP,
        originEndpoint: EndpointConfig
    ) {
        // ! Verify the block did not reorg
        const blockNumber = ambMessageMetadata.blockNumber;
        const blockHash = ambMessageMetadata.blockHash;
        const latestBlockData = await this.blockQuerier.getBlock(blockNumber);
        if (
            !latestBlockData ||
            latestBlockData.hash?.toLowerCase() !== blockHash.toLowerCase()
        ) {
            this.logger.info(
                {
                    blockNumber,
                    blockHash,
                    ambMessageMetadata
                },
                `Dropping swap data: block hash does not match (possible block reorg).`
            )
            return;
        }

        const fromVault = assetSwapPayload.fromVault;

        const swapId = calcAssetSwapIdentifier(
            assetSwapPayload.toAccount,
            assetSwapPayload.units,
            assetSwapPayload.fromAmount,
            assetSwapPayload.fromAsset,
            ambMessageMetadata.transactionBlockNumber!
        );

        const fromChannelId = originEndpoint.channelsOnDestination[ambMessageMetadata.toChainId];
        if (fromChannelId == undefined) {
            this.logger.info(
                {
                    txHash: ambMessageMetadata.transactionHash,
                    sourceVault: fromVault,
                    swapId,
                    fromInterfaceAddress: incentivesMessage.sourceApplicationAddress,
                    fromIncentivesAddress: ambMessageMetadata.fromIncentivesAddress,
                    toChainId: ambMessageMetadata.toChainId
                },
                `'fromChannelId' for the given swap not found. Skipping.`
            );
            return;
        }

        const swapState: SwapState = {
            fromChainId: this.chainId,
            fromVault: assetSwapPayload.fromVault,
            swapId,
            status: SwapStatus.Pending,
            ambMessageSendAssetDetails: {
                txHash: ambMessageMetadata.transactionHash,
                blockHash: ambMessageMetadata.blockHash,
                blockNumber: ambMessageMetadata.blockNumber,
                transactionBlockNumber: ambMessageMetadata.transactionBlockNumber!,

                amb: ambMessageMetadata.amb,
                toChainId: ambMessageMetadata.toChainId,
                messageIdentifier: ambMessageMetadata.messageIdentifier,

                toIncentivesAddress: "", // TODO: is this wanted/needed?
                toApplication: incentivesMessage.toApplication,
                deadline: incentivesMessage.deadline,
                maxGasDelivery: incentivesMessage.maxGasLimit,

                fromChannelId,

                fromVault: assetSwapPayload.fromVault,
                toVault: assetSwapPayload.toVault,
                toAccount: assetSwapPayload.toAccount,
                units: assetSwapPayload.units,
                toAssetIndex: BigInt(assetSwapPayload.toAssetIndex),
                minOut: assetSwapPayload.minOut,
                swapAmount: assetSwapPayload.fromAmount,
                fromAsset: assetSwapPayload.fromAsset,
                blockNumberMod: BigInt(assetSwapPayload.blockNumber),   // This should be the same as `ambMessageMetadata.transactionBlockNumber % 2**32`
                underwriteIncentiveX16: BigInt(assetSwapPayload.underwritingIncentive),
                calldata: assetSwapPayload.cdata,

                blockTimestamp: latestBlockData.timestamp,  // ! TODO is this wrong for arbitrum?
            },
        }

        await this.store.saveSwapState(swapState);
    }



    // Misc Helpers
    // ********************************************************************************************

    private initiateIntervalStatusLog(): void {
        const logStatus = () => {
            this.logger.info(
                {
                    latestBlock: this.currentStatus?.blockNumber,
                    currentBlock: this.fromBlock,
                },
                'Listener status.'
            );
        };
        setInterval(logStatus, STATUS_LOG_INTERVAL);
    }
}


// Simple class to cache a limited number of blockNumber->Block mappings. New entries override
// the oldest entries.
class BlockQuerier {

    private blocksCache: [number, Block][];   // Tuples of type [blockNumber, Block]
    private nextEntryIndex = 0;

    constructor(
        private readonly provider: JsonRpcProvider,
        private readonly logger: pino.Logger,
        private readonly queryRetryInterval = 2000,
        private readonly cacheSize = 100,
    ) {
        this.blocksCache = new Array(this.cacheSize);
    }


    private getCachedBlock(blockNumber: number): Block | null {
        return this.blocksCache.find((entry) => blockNumber === entry?.[0])?.[1] ?? null;
    }

    private cacheBlock(blockNumber: number, block: Block): void {
        this.blocksCache[this.nextEntryIndex] = [blockNumber, block];
        this.nextEntryIndex = (this.nextEntryIndex + 1) % this.cacheSize;
    }


    async getBlock(blockNumber: number): Promise<Block | null> {
        const cachedBlock = this.getCachedBlock(blockNumber);

        if (cachedBlock != null) {
            return cachedBlock;
        }

        const queriedBlock = await this.queryBlock(blockNumber);
        if (queriedBlock != null) {
            this.cacheBlock(blockNumber, queriedBlock);
        }

        return queriedBlock;
    }

    private async queryBlock(blockNumber: number): Promise<Block | null> {
        let i = 0;
        let block: Block | null | undefined;
        while (block === undefined) {
            try {
                block = await this.provider.getBlock(blockNumber);
            } catch {
                i++;
                this.logger.warn(
                    { blockNumber, try: i },
                    'Failed to query block data. Worker locked until successful update.',
                );
                await wait(this.queryRetryInterval);
                // Continue trying
            }
        }

        return block;
    }

}

void new ListenerWorker().run();
