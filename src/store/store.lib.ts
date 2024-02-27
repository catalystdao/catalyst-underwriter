import { Redis } from 'ioredis';
import { SwapState, SwapDescription, SwapStatus, UnderwriteState, UnderwriteStatus, ActiveUnderwriteDescription, CompletedUnderwriteDescription, ExpectedUnderwriteDescription } from './store.types';

// Monkey patch BigInt. https://github.com/GoogleChromeLabs/jsbi/issues/30#issuecomment-1006086291
(BigInt.prototype as any).toJSON = function () {
    return this.toString();
};

const DEFAULT_REDIS_PORT = 6379;
const REDIS_PORT = process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : DEFAULT_REDIS_PORT;
const DB_INDEX = 5; //TODO make customizable via config

//---------- STORE LAYOUT ----------//
// The redis store is used for 2 things:
// 1. Storing underwriting information.
// 2. pub/sub for communication between workers.

// ! TODO VERY IMPORTANT: the following key is susceptible to clashes, as 2 swaps may share the same swapId due to a block reorg or block height % 2^32 (very unlikely) 
// For the storage, asset swaps are stored against their:
//   - fromChainId,
//   - fromVault,
//   - txHash

//TODO
// For pub/sub, below are a list of the channels being used:
// 'submit-<chainid>': { messageIdentifier, destinationChain, message, messageCtx, priority? }
// 'amb': { messageIdentifier, destinationChain, payload }
// 'key': { key, action}

export class Store {
    readonly redis: Redis;
    // When a redis connection is used to listen for subscriptions, it cannot be
    // used for anything except to modify the subscription set which is being listened
    // to. As a result, we need a dedicated connection if we ever decide to listen to
    // subscriptions.
    redisSubscriptions: Redis | undefined;

    readonly host: string | undefined;

    static readonly swapPrefix: string = 'swap';
    static readonly expectedUnderwriteToSwapDescriptionPrefix: string = 'expectedUnderwriteToSwap';
    static readonly completedUnderwriteToSwapDescriptionPrefix: string = 'completedUnderwriteToSwap';
    static readonly activeUnderwritePrefix: string = 'activeUnderwrite';
    static readonly completedUnderwritePrefix: string = 'completedUnderwrite';

    static readonly underwriterChannelPrefix: string = 'underwriter'; 
    static readonly onSendAssetChannel: string = 'onSendAsset';
    static readonly onSwapUnderwrittenChannel: string = 'onSwapUnderwritten';
    static readonly onSwapUnderwriteCompleteChannel: string = 'onSwapUnderwriteComplete';

    constructor() {
        this.host = process.env.USE_DOCKER ? 'redis' : undefined;
        this.redis = new Redis(REDIS_PORT, {
            db: DB_INDEX,
            host: this.host,
        });
    }

    async quit(): Promise<void> {
        await this.redis.quit();
    }

    // ----- Translation -----

    async get(key: string) {
        return this.redis.get(key);
    }

    async set(key: string, value: string) {
        // We want to notify a potential subscribed that there has been a change to this key.
        // Lets set the key first.
        await this.redis.set(key, value);
        // Then post that message.
        await this.postMessage('key', { key, action: 'set' });
    }

    async del(key: string) {
        await this.redis.del(key);
        await this.postMessage('key', { key, action: 'del' });
    }

    // ----- Subscriptions ------

    /**
     * @notice Use this function to get a redis connection for any subscriptions.
     * This is because when a SUBSCRIBE calls goes out to redis, the connection can
     * only be used to modify the subscriptions or receive them. As a result, any
     * redis.get or redis.set or redis.del does not work.
     */
    getOrOpenSubscription(): Redis {
        if (!this.redisSubscriptions) {
            this.redisSubscriptions = new Redis(REDIS_PORT, {
                db: DB_INDEX,
                host: this.host,
            }); 
        }
        return this.redisSubscriptions;
    }

    static getChannel(channel: string, describer: string): string {
        return Store.combineString(channel, describer);
    }

    static combineString(...vals: string[]) {
        return vals.join(':');
    }

    async postMessage(channel: string, payload: { [key: string]: any }) {
        return this.redis.publish(
            Store.combineString(Store.underwriterChannelPrefix, channel),
            JSON.stringify(payload),
        );
    }

    async on(channel: string, callback: (payload: { [key: string]: any }) => void) {
        const redisSubscriptions = this.getOrOpenSubscription();
        // Subscribe to the channel so that we get messages.
        const channelWithprefix = Store.combineString(
            Store.underwriterChannelPrefix,
            channel,
        );
        await redisSubscriptions.subscribe(channelWithprefix);
        // Set the callback when we receive messages function.
        redisSubscriptions.on('message', (redis_channel, redis_message) => {
            if (redis_channel === channelWithprefix)
                callback(JSON.parse(redis_message));
        });
    }


    // ----- Swaps ------

    static getSwapStateKey(
        fromChainId: string,
        fromVault: string,
        swapId: string
    ): string {
        return Store.combineString(
            Store.swapPrefix,
            fromChainId.toLowerCase(),
            fromVault.toLowerCase(),
            swapId.toLowerCase(),
        );
    }

    async getSwapState(
        fromChainId: string,
        fromVault: string,
        swapId: string
    ): Promise<SwapState | null> {
        const key = Store.getSwapStateKey(
            fromChainId,
            fromVault,
            swapId
        );
        return this.getSwapStateByKey(key);
    }

    async getSwapStateByKey(key: string): Promise<SwapState | null> {
        const query = await this.redis.get(key);

        if (query == null) {
            return null;
        }

        const swapState = JSON.parse(query);
        swapState.swapAmount = BigInt(swapState.swapAmount);
        swapState.units = BigInt(swapState.units);

        if (swapState.sendAssetEvent) {
            const event = swapState.sendAssetEvent;
            event.toAssetIndex = BigInt(event.toAssetIndex);
            event.fromAmount = BigInt(event.fromAmount);
            event.fee = BigInt(event.fee);
            event.minOut = BigInt(event.minOut);
            event.underwriteIncentiveX16 = BigInt(event.underwriteIncentiveX16);
        }
        
        if (swapState.receiveAssetEvent) {
            const event = swapState.receiveAssetEvent;
            event.toAmount = BigInt(event.toAmount);
            
        }

        return swapState as SwapState;
    }

    async saveSwapState(state: SwapState): Promise<void> {

        const key = Store.getSwapStateKey(
            state.fromChainId,
            state.fromVault,
            state.swapId,
        );
        
        const currentState = await this.getSwapStateByKey(key);
        const overridingState = currentState != null;
        const newState = overridingState ? currentState : state;

        if (overridingState) {
            //TODO contrast the saved 'common' state with the incoming data? (e.g. fromVault, fromAsset, etc...)
            newState.sendAssetEvent = state.sendAssetEvent
                ?? currentState.sendAssetEvent;
            newState.receiveAssetEvent = state.receiveAssetEvent
                ?? currentState.receiveAssetEvent;
        }

        // Update the swap 'status'
        if (newState.receiveAssetEvent) {
            newState.status = SwapStatus.Completed;
        } else {
            newState.status = SwapStatus.Pending;
        }

        await this.set(key, JSON.stringify(newState));

        if (state.sendAssetEvent) {
            const swapDescription: SwapDescription = {
                poolId: state.poolId,
                fromChainId: state.fromChainId,
                toChainId: state.toChainId,
                fromVault: state.fromVault,
                swapId: state.swapId,
            }
            await this.postMessage(Store.onSendAssetChannel, swapDescription);
        }
    }

    async saveAdditionalSwapData(
        fromChainId: string,
        fromVault: string,
        swapId: string,
        toAsset: string,
        calldata: string
    ): Promise<void> {

        const key = Store.getSwapStateKey(
            fromChainId,
            fromVault,
            swapId,
        );
        
        const state = await this.getSwapStateByKey(key);

        if (state == null) {
            throw new Error(`Unable to store additional swap data: swap state not found (fromChainId: ${fromChainId}, fromVault: ${fromVault}, swapId: ${swapId}.`);
        }

        state.toAsset = toAsset;
        state.calldata = calldata;

        await this.set(key, JSON.stringify(state));
    }

    async getSwapStateByExpectedUnderwrite(
        toChainId: string,
        toInterface: string,
        underwriteId: string,
    ): Promise<SwapState | null> {
        const swapDescription = await this.getSwapDescriptionByExpectedUnderwrite(
            toChainId,
            toInterface,
            underwriteId,
        );

        if (swapDescription == null) return null;

        return this.getSwapState(
            swapDescription.fromChainId,
            swapDescription.fromVault,
            swapDescription.swapId,
        );
    }


    // ----- Underwrites ------
    static getSwapDescriptionByExpectedUnderwriteKey(
        toChainId: string,
        toInterface: string,
        underwriteId: string,
    ): string {
        return Store.combineString(
            Store.expectedUnderwriteToSwapDescriptionPrefix,
            toChainId.toLowerCase(),
            toInterface.toLowerCase(),
            underwriteId.toLowerCase(),
        );
    }

    static getSwapDescriptionByCompletedUnderwriteKey(
        toChainId: string,
        toInterface: string,
        underwriteId: string,
        underwriteTxHash: string,
    ): string {
        return Store.combineString(
            Store.completedUnderwriteToSwapDescriptionPrefix,
            toChainId.toLowerCase(),
            toInterface.toLowerCase(),
            underwriteId.toLowerCase(),
            underwriteTxHash.toLowerCase(),
        );
    }

    async getSwapDescriptionByExpectedUnderwrite(
        toChainId: string,
        toInterface: string,
        underwriteId: string,
    ): Promise<SwapDescription | null> {
        const key = Store.getSwapDescriptionByExpectedUnderwriteKey(
            toChainId,
            toInterface,
            underwriteId,
        );
        return this.getSwapDescriptionByKey(key);
    }

    async getSwapDescriptionByCompletedUnderwrite(
        toChainId: string,
        toInterface: string,
        underwriteId: string,
        underwriteTxHash: string,
    ): Promise<SwapDescription | null> {
        const key = Store.getSwapDescriptionByCompletedUnderwriteKey(
            toChainId,
            toInterface,
            underwriteId,
            underwriteTxHash,
        );
        return this.getSwapDescriptionByKey(key);
    }

    async getSwapDescriptionByKey(key: string): Promise<SwapDescription | null> {
        const query = await this.redis.get(key);

        if (query == null) {
            return null;
        }

        const swapDescription = JSON.parse(query);

        //TODO validate data?
        return swapDescription as SwapDescription;
    }

    async saveSwapDescriptionByExpectedUnderwrite(
        underwriteDescription: ExpectedUnderwriteDescription,
        swapDescription: SwapDescription
    ): Promise<void> {
        const key = Store.getSwapDescriptionByExpectedUnderwriteKey(
            underwriteDescription.toChainId,
            underwriteDescription.toInterface,
            underwriteDescription.underwriteId,
        );

        await this.set(key, JSON.stringify(swapDescription));
    }

    async saveSwapDescriptionByCompletedUnderwrite(
        underwriteDescription: CompletedUnderwriteDescription,
        swapDescription: SwapDescription
    ): Promise<void> {
        const key = Store.getSwapDescriptionByCompletedUnderwriteKey(
            underwriteDescription.toChainId,
            underwriteDescription.toInterface,
            underwriteDescription.underwriteId,
            underwriteDescription.underwriteTxHash,
        );

        await this.set(key, JSON.stringify(swapDescription));
    }


    static getActiveUnderwriteStateKey(
        toChainId: string,
        toInterface: string,
        underwriteId: string
    ): string {
        return Store.combineString(
            Store.activeUnderwritePrefix,
            toChainId.toLowerCase(),
            toInterface.toLowerCase(),
            underwriteId.toLowerCase(),
        );
    }

    static getCompletedUnderwriteStateKey(
        toChainId: string,
        toInterface: string,
        underwriteId: string,
        underwriteTxHash: string
    ): string {
        return Store.combineString(
            Store.completedUnderwritePrefix,
            toChainId.toLowerCase(),
            toInterface.toLowerCase(),
            underwriteId.toLowerCase(),
            underwriteTxHash.toLowerCase()
        );
    }

    // Helper for both active and completed underwrites
    async getUnderwriteStateByKey(key: string): Promise<UnderwriteState | null> {
        const query = await this.redis.get(key);

        if (query == null) {
            return null;
        }

        const state = JSON.parse(query);

        if (state.swapUnderwrittenEvent) {
            const event = state.swapUnderwrittenEvent;
            event.units = BigInt(event.units);
            event.outAmount = BigInt(event.outAmount);
        }

        if (state.expireUnderwriteEvent) {
            const event = state.expireUnderwriteEvent;
            event.reward = BigInt(event.reward);
        }

        return state as UnderwriteState;
    }

    async getActiveUnderwriteState(
        toChainId: string,
        toInterface: string,
        underwriteId: string
    ): Promise<UnderwriteState | null> {
        const key = Store.getActiveUnderwriteStateKey(
            toChainId,
            toInterface,
            underwriteId
        );
        return this.getUnderwriteStateByKey(key);
    }

    async getCompletedUnderwriteState(
        toChainId: string,
        toInterface: string,
        underwriteId: string,
        underwriteTxHash: string,
    ): Promise<UnderwriteState | null> {
        const key = Store.getCompletedUnderwriteStateKey(
            toChainId,
            toInterface,
            underwriteId,
            underwriteTxHash
        );
        return this.getUnderwriteStateByKey(key);
    }

    async saveActiveUnderwriteState(state: UnderwriteState): Promise<void> {

        const key = Store.getActiveUnderwriteStateKey(
            state.toChainId,
            state.toInterface,
            state.underwriteId,
        );

        const currentState = await this.getUnderwriteStateByKey(key);
        const overridingState = currentState != null;
        const newState = overridingState ? currentState : state;

        if (overridingState) {
            //TODO contrast the saved 'common' state with the incoming data? (e.g. poolId, etc...)
            newState.swapUnderwrittenEvent = state.swapUnderwrittenEvent
                ?? currentState.swapUnderwrittenEvent;
            newState.fulfillUnderwriteEvent = state.fulfillUnderwriteEvent
                ?? currentState.fulfillUnderwriteEvent;
            newState.expireUnderwriteEvent = state.expireUnderwriteEvent
                ?? currentState.expireUnderwriteEvent;
        }

        // Make sure the resulting 'state' is properly structured. (Events must be added in 
        // chronological order.)
        if (!newState.swapUnderwrittenEvent) {
            throw new Error(`Failed to update active underwrite state: no 'SwapUnderwritten' event registered.`);
        }

        if (newState.fulfillUnderwriteEvent && newState.expireUnderwriteEvent) {
            throw new Error(`Failed to update active underwrite state: both 'FulfillUnderwrite' and 'ExpireUnderwrite' events are regsitered.`);
        }

        // Update the underwrite 'status'
        if (newState.fulfillUnderwriteEvent) {
            newState.status = UnderwriteStatus.Fulfilled;
        } else if (newState.expireUnderwriteEvent) {
            newState.status = UnderwriteStatus.Expired;
        } else {
            newState.status = UnderwriteStatus.Underwritten;
        }

        // If the underwrite is complete, move the state entry from the 'expected' onto the 'complete' set
        if (newState.status >= UnderwriteStatus.Fulfilled) {

            const underwriteDescription: CompletedUnderwriteDescription = {
                poolId: newState.swapUnderwrittenEvent!.poolId,
                toChainId: newState.toChainId,
                toInterface: newState.toInterface,
                underwriter: newState.swapUnderwrittenEvent!.underwriter,
                underwriteId: newState.underwriteId,
                underwriteTxHash: newState.swapUnderwrittenEvent!.txHash
            };

            // Also update the expected-underwrite-to-swap map
            const swapMapKey = Store.getSwapDescriptionByExpectedUnderwriteKey(
                state.toChainId,
                state.toInterface,
                state.underwriteId,
            );
            const swapDescription = await this.getSwapDescriptionByKey(swapMapKey);
            if (swapDescription != null) {
                await this.del(swapMapKey);
                await this.saveSwapDescriptionByCompletedUnderwrite(
                    underwriteDescription,
                    swapDescription
                );
            }

            await this.del(key);
            await this.saveCompletedUnderwriteState(newState);

            await this.postMessage(Store.onSwapUnderwriteCompleteChannel, underwriteDescription);
        } else {
            await this.set(key, JSON.stringify(newState));
        }

        if (state.swapUnderwrittenEvent) {
            const underwriteDescription: ActiveUnderwriteDescription = {
                poolId: state.swapUnderwrittenEvent.poolId,
                toChainId: state.toChainId,
                toInterface: state.toInterface,
                underwriter: state.swapUnderwrittenEvent.underwriter,
                underwriteId: state.underwriteId,
                expiry: state.swapUnderwrittenEvent.expiry,
            }
            await this.postMessage(Store.onSwapUnderwrittenChannel, underwriteDescription);
        }
    }

    async saveCompletedUnderwriteState(state: UnderwriteState): Promise<void> {

        const key = Store.getCompletedUnderwriteStateKey(
            state.toChainId,
            state.toInterface,
            state.underwriteId,
            state.swapUnderwrittenEvent!.txHash
        );
        
        //TODO log warning if key already used? (could happen on some edge cases)
        // const savedState = await this.getUnderwriteStateByKey(key);

        await this.set(key, JSON.stringify(state));
    }

}
