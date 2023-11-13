# Catalyst Underwriter

The Catalyst Underwriter is designed to accelerate swaps speed by taking on the settlement risk of the transaction.
The underwriting service relies on the the [Generalised Relayer](https://github.com/catalystdao/GeneralisedRelayer) which is a reference implementation of a relayer that understands [Generalised Incentives](https://github.com/catalystdao/GeneralisedIncentives).

# Running the underwriter

There are 2 different ways to run the underwriter.

## Docker

The simplest way to run the underwriter is with Docker compose.

```bash
docker compose up
```

## Running locally

The underwriter can also be run locally. This is the easiest solution for development. Install the packages:

```bash
yarn install
```

## Run with yarn

Then the app can be run:

```bash
yarn start
```
