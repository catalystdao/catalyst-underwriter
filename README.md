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
- `global`: Defines the global underwriter configuration.
    - The `privateKey` of the account that will submit the underwrite transactions on all chains must be defined at this point. 
    - Default configuration for the `monitor`, `listener`, `underwriter`, `expirer` and `wallet` can also be specified at this point.
- `ambs`: The AMBs configuration.
- `chains`: Defines the configuration for each of the chains to be supported by the Underwriter.
    - This includes the `chainId` and the `rpc` to be used for the chain.
    - Each chain may override the global services configurations (those defined under the `global` configuration), and `amb` configurations.
- `endpoints`: The Catalyst endpoints of which swaps to underwrite.
    - For each vault, the `factoryAddress`, `interfaceAddress`, `incentivesAddress` and `vaultTemplates`, must be specified, together with the swap channel mappings (`channelsOnDestination`).

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
pnpm install
```
- **NOTE**: The `devDependencies` are required to build the project. If running on a production machine where `NODE_ENV=production`, use `pnpm install --prod=false` 

Make sure that a Generalised Relayer implementation is running, and verify that the port of the active Redis database is correctly set on the `.env` configuration file.

Build and start the Underwriter with:
```bash
pnpm start
```

For further insight into the requirements for running the Underwriter see the `docker-compose.yaml` file.

## Underwriter Structure

The Underwriter is devided into 5 main services: `Monitor`, `Listener`, `Underwriter`, `Expirer` and `Wallet`. These services work together to get the Catalyst swap events and submit their corresponding underwrites on the destination chain. The services are run in parallel and communicate using Redis. Wherever it makes sense, chains are allocated seperate workers to ensure a chain fault doesn't propagate and impact the performance on other chains.

### Monitor

The Monitor service keeps track of the latest block information for each supported chain by subscribing to the Relayer's Monitor service via a websocket connection. This way the Underwriter can be kept in sync with the Relayer.

### Listener

The Listener service is responsible for fetching the information of the Catalyst swaps/underwrites, in specific:
- Catalyst Chain Interface events:
    - `SwapUnderwritten`: Signals that a swap has been underwritten.
    - `FulfillUnderwrite`: Signals that a swap has arrived, an active underwrite exists for the swap, and the underwrite logic has completed.
    - `ExpireUnderwrite`: Signals that an underwrite has been expired.
- AMB messages:
    - The Underwriter listens at the AMB messages processed by the Relayer, and filters any relevant message that may involve an underwritable swap. These are then further processed and stored, to be later handled by the Underwriter service.

The information gathered with these events is sent to the common Redis database for later use by the other services.

### Underwriter

The Underwriter service gets recently executed swap information from Redis. For every new swap, the underwriter:
1. Verifies that the swap was executed by a supported set of contracts (token, vault, interface, factory).
2. Estimates the token amount required for underwriting.
3. Simulates the transaction to get a gas estimate and evaluates the underwriting profitability taking into account the message relaying costs.
4. Performs the underwrite if the evaluation is successful using the [`underwriteAndCheckConnection`](https://github.com/catalystdao/catalyst/blob/27b4d0a2bca177aff00def8cd745623bfbf7cb6b/evm/src/CatalystChainInterface.sol#L646) method of the CatalystChainInterface contract via the Wallet service.
5. Confirms that the underwrite transaction is mined.

To make the Underwriter as resilitent as possible to RPC failures/connection errors, each evaluation, underwrite and confirmation step is tried up to `maxTries` times with a `retryInterval` delay between tries (these default to `3` and `2000` ms, but can be modified on the Underwriter config).

The Underwriter additionally limits the maximum number of transactions within the 'submission' pipeline (i.e. transactions that have been started to be processed and are not completed), and will not accept any further underwrite orders once reached.

### Expirer
The expirer objective is to resolve any expired underwrites. For underwrites made by this underwriter, the expiry is executed at a configurable `expireBlocksMargin` interval *before* the expiry deadline. Everytime an underwrite is captured by the `listener` service, an `expire` order is scheduled by the expirer. If the underwrite is fulfilled, the `expire` order is discarded, otherwise it is executed at the effective expiry time.

### Wallet

The Wallet service is used to submit transactions requested by the other services of the Underwriter (the Underwriter and the Expirer at the time of writing). For every transaction request:
1. The transaction fee values are dynamically determined according to the following configuration:
    #### EIP-1559 transactions
    - The `maxFeePerGas` configuration sets the transaction `maxFeePerGas` property. This defines the maximum fee to be paid per gas for a transaction (including both the base fee and the miner fee). If not set, no `maxFeePerGas` is set on the transaction.
    - The `maxPriorityFeeAdjustmentFactor` determines the amount by which to modify the queried recommended `maxPriorityFee` from the rpc. If not set, no `maxPriorityFee` is set on the transaction.
    - The `maxAllowedPriorityFeePerGas` sets the maximum value that `maxPriorityFee` may be set to (after applying the `maxPriorityFeeAdjustmentFactor`).

    #### Legacy transaction
    - The `gasPriceAdjustmentFactor` determines the amount by which to modify the queried recommended `gasPrice` from the rpc. If not set, no `gasPrice` is set on the transaction.
    - The `maxAllowedGasPrice` sets the maximum value that `gasPrice` may be set to (after applying the `gasPriceAdjustmentFactor`).

    > ⚠️ If the above gas configurations are not specified, the transactions will be submitted using the `ethers`/rpc defaults.
2. The transaction is submitted.
3. The transaction confirmation is awaited.
4. If the transaction fails to be mined after a configurable time interval, the transaction is repriced.
    - If a transaction does not mine in time (`maxTries * (confirmationTimeout + retryInterval)` approximately), the Wallet will attempt to reprice the transaction by resubmitting the transaction with higher gas price values. The gas prices are adjusted according to the `priorityAdjustmentFactor` configuration. If not set, it defaults to `1.1` (i.e +10%).
5. If the transaction still fails to be mined, the wallet will attempt at cancelling the transaction.
    > ⚠️ If the Wallet fails to cancel a transaction, the Submitter pipeline will stall and no further orders will be processed until the stuck transaction is resolved.


## Further features

### Resolvers
To take into consideration the different behaviours and characteristics of different chains, a custom *Resolver* can be specified for each chain. At the time of writing, the Resolvers can:
- Map the rpc block number to the one observed by the transactions itself (for chains like Arbitrum).
- Estimate gas parameters for transactions, including estimating the gas usage as observed by the transactions (for chains like Arbitrum) and additional L1 fees (for op-stack chains).

> ℹ️ Resolvers have to be specified on the configuration file for each desired chain. See `src/resolvers` for the available resolvers.

### Low balance warning
The Underwriter keeps an estimate of the Underwriter account gas/tokens balance for each chain. A warning is emitted to the logs if the gas/tokens balance falls below a configurable threshold (`lowGasBalanceWarning`/`lowTokenBalanceWarning` in Wei).

### The `Store` library
The distinct services of the Underwriter communicate with each other using a Redis database. To abstract the Redis implementation away, a helper library, `store.lib.ts`, is provided. 

### Underwriting disabling
Underwriting may be enabled and disabled dynamically by sending a `POST` request to the `enableUnderwriting`/`disableUnderwriting` endpoints of the underwriter. An optional JSON encoded payload may be specified to select the `chainIds` to enable/disable.
> ℹ️ Underwriting disabling is useful when it is desired to take down the underwriter, as it allows the underwriter to continue to run throughout a 'take-down' period to handle any required expiries.

## Development

### Typechain Types
The Underwriter uses `ethers` types for the contracts that it interacts with (e.g. the Catalyst Vault Common contract). These types are generated with the `typechain` package using the contract *abis* (under the `abis/` folder) upon installation of the `npm` packages. If the contract *abis* change the types must be regenerated (see the `postinstall` script on `package.json`).