# Catalyst Underwriter

The Catalyst Underwriter is designed to accelerate swaps speed by taking on the settlement risk of the transaction.
The underwriting service relies on the [Generalised Relayer](https://github.com/catalystdao/GeneralisedRelayer) which is a reference implementation of a relayer that understands [Generalised Incentives](https://github.com/catalystdao/GeneralisedIncentives).

## Dependencies
The Catalyst Underwriter relies on having a running instance of the [Generalised Relayer](https://github.com/catalystdao/GeneralisedRelayer).
> ℹ️ The running Generalised Relayer does not need to relay swaps. Rather it is only used to gather the AMB message relaying information.

Aside from the npm packages specified within `package.json`, the Underwriter relies on Redis for data management. This dependency however is also required by the Generalised Relayer, so no extra work is required to run the Underwriter.

## Underwriter Configuration

The Underwriter configuration is split into 2 distinct files.
> ⚠️ The Underwriter will not run without the following configuration files.

### 1. Main configuration `.yaml` file
Most of the Underwriter configuration is specified within a `.yaml` file located at the project's root directory. The configuration file must be named using the `config.{$NODE_ENV}.yaml` format according to the environment variable `NODE_ENV` of the runtime (e.g. on a production machine where `NODE_ENV=production`, the configuration file must be named `config.production.yaml`).

> The `NODE_ENV` variable should ideally be set on the shell configuration file (i.e. `.bashrc` or equivalent), but may also be set by prepending it to the launch command, e.g. `NODE_ENV=production docker compose up`. For more information see the [Node documentation](https://nodejs.org/en/learn/getting-started/nodejs-the-difference-between-development-and-production).

The `.yaml` configuration file is divided into the following sections:
- `underwriter`: Defines the global underwriter configuration. (TODO rename)
    - The `privateKey` of the account that will submit the underwrite transactions on all chains must be defined at this point. 
    - Default configuration for the `underwriter` can also be specified at this point.
- `ambs`: The AMBs configuration. (TODO the AMB configuration placement is inconsistent with the Relayer)
- `chains`: Defines the configuration for each of the chains to be supported by the relayer.
    - This includes the `chainId` and the `rpc` to be used for the chain.
    - Each chain may override the global `underwriter` configuration (those defined under the global `underwriter` configuration), and `amb` configurations.
- `pools`: The Catalyst pools of which swaps to underwrite.
    - For each vault, the `vaultAddress` and `interfaceAddress` must be specified, and also the mapping between the vault's `bytes32` channel ids to the destination `chainId`s (for all the vault's channel ids).

> ℹ️ For a full reference of the configuration file, see `config.example.yaml`.

### 2. Environment variables `.env` file
Hosts and ports specific configuration is set on a `.env` file within the project's root directory.
> ℹ️ See `.env.example` for the required environment variables.

## Running the underwriter
### Option A: Using Docker
The simplest way to run the Underwriter is via `docker compose` (refer to the [Docker documentation](https://docs.docker.com/) for installation instructions). Run the Underwriter with:

```bash
docker compose up [-d]
```
The `-d` option detaches the process to the background.

> ⚠️ With the default configuration, to use Docker for the Underwriter, the Relayer must also be running with Docker. The Underwriter `docker-compose.yaml` configuration attaches to the *default* network on which the Relayer resides on to allow communication with it, but this configuration may need to be adjusted on some machines. Use the `docker network` command for more information on the available networks, or refer to the [Docker documentation](https://docs.docker.com/network/).

### Option B: Manual Operation
Install the required dependencies with:

```bash
yarn install
```
- **NOTE**: The `devDependencies` are required to build the project. If running on a production machine where `NODE_ENV=production`, use `yarn install --prod=false` 

Make sure that a Generalised Relayer implementation is running, and verify that the port of the active Redis database is correctly set on the `.env` configuration file.

Build and start the Underwriter with:
```bash
yarn start
```

For further insight into the requirements for running the Underwriter see the `docker-compose.yaml` file.

## Underwriter Structure

The Underwriter is devided into 2 main services: `Listener` and `Submitter`. These services work together to get the Catalyst swap events and submit their corresponding underwrites on the destination chain. The services are run in parallel and communicate using Redis. Wherever it makes sense, chains are allocated seperate workers to ensure a chain fault doesn't propagate and impact the performance on other chains.

> 🏗️ The Underwriter is still on a very early development stage. Further services will be added as development progresses.

### Listener

The Listener service is responsible for fetching the on-chain events of the Catalyst swaps/underwrites, in specific:
- Catalyst Vault events:
    - `SendAsset`: Signals that a swap has been executed.
- Catalyst Chain Interface events:
    - `SwapUnderwritten`: Signals that a swap has been underwritten.
    - `FulfillUnderwrite`: Signals that a swap has arrived, an active underwrite exists for the swap, and the underwrite logic has completed.
    - `ExpireUnderwrite`: Signals that an underwrite has been expired.

The information gathered with these events is sent to the common Redis database for later use by the other services.

### Underwriter

The Underwriter service gets recently executed swap information from Redis. For every new swap, the underwriter:
1. Gets the full corresponding AMB message from the Relayer.
2. Estimates the token amount required for underwriting.
3. Simulates the transaction to get a gas estimate. (TODO)
4. Performs the underwrite if the evaluation is successful using the [`underwriteAndCheckConnection`](https://github.com/catalystdao/catalyst/blob/27b4d0a2bca177aff00def8cd745623bfbf7cb6b/evm/src/CatalystChainInterface.sol#L646) method of the CatalystChainInterface contract. (TODO - currently using `underwrite` instead of `underwriteAndCheckConnection`)
5. Confirms that the underwrite transaction is mined.

To make the Underwriter as resilitent as possible to RPC failures/connection errors, each evaluation, underwrite and confirmation step is tried up to `maxTries` times with a `retryInterval` delay between tries (these default to `3` and `2000` ms, but can be modified on the Underwriter config).

The Underwriter additionally limits the maximum number of transactions within the 'submission' pipeline (i.e. transactions that have been started to be processed and are not completed), and will not accept any further underwrite orders once reached (TODO add a deadline to underwrite execution). If a submitted transactions fails to commit within the number of specified tries and timeout, the Underwriter will attempt to cancel the transaction.
> ⚠️ If the Underwriter fails to cancel a transaction, the Underwriter pipeline will stall and no further orders will be processed until the stuck transaction is resolved.

## Further features

### Automatic transaction pricing
The Underwriter has the ability to automatically set the relay transactions gas pricing.
#### EIP-1559 transactions
- The `maxFeePerGas` configuration sets the transaction `maxFeePerGas` property. This defines the maximum fee to be paid per gas for a transaction (including both the base fee and the miner fee). If not set, no `maxFeePerGas` is set on the transaction.
- The `maxPriorityFeeAdjustmentFactor` determines the amount by which to modify the queried recommended `maxPriorityFee` from the rpc. If not set, no `maxPriorityFee` is set on the transaction.
- The `maxAllowedPriorityFeePerGas` sets the maximum value that `maxPriorityFee` may be set to (after applying the `maxPriorityFeeAdjustmentFactor`).

#### Legacy transaction
- The `gasPriceAdjustmentFactor` determines the amount by which to modify the queried recommended `gasPrice` from the rpc. If not set, no `gasPrice` is set on the transaction.
- The `maxAllowedGasPrice` sets the maximum value that `gasPrice` may be set to (after applying the `gasPriceAdjustmentFactor`).

> ⚠️ If the above gas configuration is not specified, the transactions will be submitted using the `ethers`/rpc defaults.

#### Transaction repricing
If a transaction does not mine in time (`maxTries * (confirmationTimeout + retryInterval)` approximately), the Underwriter will attempt to reprice the transaction by resubmitting the transaction with higher gas price values. The gas prices are adjusted according to the `priorityAdjustmentFactor` configuration. If not set, it defaults to `1.1` (i.e +10%).

### Low balance warning
TODO
<!-- The Underwriter keeps an estimate of the Underwriter account gas balance for each chain. A warning is emitted to the logs if the gas balance falls below a configurable threshold `lowBalanceWarning` (in Wei). -->

### The `Store` library
The distinct services of the Underwriter communicate with each other using a Redis database. To abstract the Redis implementation away, a helper library, `store.lib.ts`, is provided. 

## Development

### Typechain Types
The Underwriter uses `ethers` types for the contracts that it interacts with (e.g. the Catalyst Vault Common contract). These types are generated with the `typechain` package using the contract *abis* (under the `abis/` folder) upon installation of the `npm` packages. If the contract *abis* change the types must be regenerated (see the `postinstall` script on `package.json`).