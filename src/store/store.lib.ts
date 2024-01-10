import { Redis } from 'ioredis';
import { SwapStatus, SwapDescription } from './store.types';
import { SendAssetEvent } from 'src/contracts/CatalystVaultCommon';


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

// Below is a list of general todos on this library.
// TODO: add chainId to the index.
// TODO: Carify storage types: Move Bounty type here?
// TODO: Fix cases where bounty doesn't exist.

export class Store {
    readonly redis: Redis;
    // When a redis connection is used to listen for subscriptions, it cannot be
    // used for anything except to modify the subscription set which is being listened
    // to. As a result, we need a dedicated connection if we ever decide to listen to
    // subscriptions.
    redisSubscriptions: Redis | undefined;

    readonly host: string | undefined;

    static readonly underwritePrefix: string = 'underwrite';

    static readonly onSendAssetChannel: string = 'onSendAsset';

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

    async scan(callback: (key: string) => void) {
        const stream = this.redis.scanStream({
            match: `${Store.underwritePrefix}:*`,
        });

        stream.on('data', (keys) => {
            for (const key of keys) {
                callback(key);
            }
        });
    }

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
            Store.combineString(Store.underwritePrefix, channel),
            JSON.stringify(payload),
        );
    }

    async on(channel: string, callback: (payload: { [key: string]: any }) => void) {
        const redisSubscriptions = this.getOrOpenSubscription();
        // Subscribe to the channel so that we get messages.
        const channelWithprefix = Store.combineString(
            Store.underwritePrefix,
            channel,
        );
        await redisSubscriptions.subscribe(channelWithprefix);
        // Set the callback when we receive messages function.
        redisSubscriptions.on('message', (redis_channel, redis_message) => {
            if (redis_channel === channelWithprefix)
                callback(JSON.parse(redis_message));
        });
    }

    // ----- Bounties ------

    async getSwapStatus(
        fromChainId: string,
        fromVault: string,
        txHash: string
    ): Promise<SwapStatus | null> {
        const query = await this.redis.get(
            Store.combineString(
                Store.underwritePrefix,
                fromChainId.toLowerCase(),
                fromVault.toLowerCase(),
                txHash.toLowerCase(),
            ),
        );

        if (query == null) {
            return null;
        }

        const swapStatus = JSON.parse(query);

        if (swapStatus) {
            swapStatus.toAssetIndex = BigInt(swapStatus.toAssetIndex)
            swapStatus.fromAmount = BigInt(swapStatus.fromAmount)
            swapStatus.minOut = BigInt(swapStatus.minOut)
            swapStatus.units = BigInt(swapStatus.units)
            swapStatus.fee = BigInt(swapStatus.fee)
            swapStatus.underwriteIncentiveX16 = BigInt(swapStatus.underwriteIncentiveX16)
        }

        return swapStatus as SwapStatus;
    }


    //TODO allow to set if it already exists (as with the relayer)?
    //TODO what if the 'SendAsset' event is observed after the swap complete event?
    async registerSendAsset(
        fromChainId: string,
        fromVault: string,
        txHash: string,
        toChainId: string,
        swapIdentifier: string,
        sendAssetEvent: SendAssetEvent.OutputObject,
        eventBlockHeight: number,
        eventBlockHash: string
    ) {

        const swapStatus: SwapStatus = {
            fromChainId,
            fromVault,
            txHash,
            toChainId,
            swapIdentifier,
            channelId: sendAssetEvent.channelId,
            toVault: sendAssetEvent.toVault,
            toAccount: sendAssetEvent.toAccount,
            fromAsset: sendAssetEvent.fromAsset,
            toAssetIndex: sendAssetEvent.toAssetIndex,
            fromAmount: sendAssetEvent.fromAmount,
            minOut: sendAssetEvent.minOut,
            units: sendAssetEvent.units,
            fee: sendAssetEvent.fee,
            underwriteIncentiveX16: sendAssetEvent.underwriteIncentiveX16,
            eventBlockHeight,
            eventBlockHash,
            observedTimestamp: Math.floor(Date.now() / 1000),
            swapComplete: false,
            underwritten: false,
            expired: false
        };

        const key = Store.combineString(
            Store.underwritePrefix,
            fromChainId.toLowerCase(),
            fromVault.toLowerCase(),
            txHash.toLowerCase(),
        );

        const swapStatusDescription: SwapDescription = {
            fromChainId,
            fromVault,
            txHash,
            toChainId
        }

        await this.set(key, JSON.stringify(swapStatus));

        await this.postMessage(Store.onSendAssetChannel, swapStatusDescription);
    }

}
