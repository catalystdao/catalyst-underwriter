import { getChainByID } from '../../chains/chains';
import { ChainID } from '../../chains/enums/chainid.enum';
import { Chain } from '../../chains/interfaces/chain.interface';
import { add0X, convertHexToDecimal } from '../../common/utils';

/**
 * This function decodes the payload given from wormhole to get
 * @param payload Wormhole vaa payload (expected to start with 0x)
 * @returns The destinationIdentifier and messageIdentifier of the payload
 */
export const getWormholeInfo = (payload: string) => {
  const destinationIdentifier = payload.substring(0, 66); //2 for 0x and 64 for the 32 bit address
  const messageIdentifier = add0X(payload.substring(68, 132)); //(Ignoring bit gap 66-68) 64 for the 32bit address
  const destinationChain = getChainByWormholeID(destinationIdentifier);

  return {
    messageIdentifier,
    destinationChain,
  };
};

/**
 * Recieves the destinationIdentifier coming from the wormhole amb and finds the matching chain
 * @param destinationIdentifier The destinationIdentifier recieved from the contract (hex)
 * @returns The matching chain from the CHAINS collection
 */
export const getChainByWormholeID = (destinationIdentifier: string): Chain => {
  const wormholeChainID = Number(convertHexToDecimal(destinationIdentifier));

  switch (wormholeChainID) {
    case 10002:
      return getChainByID(ChainID.Sepolia);

    case 5:
      return getChainByID(ChainID.Mumbai);

    case 30:
      return getChainByID(ChainID.BaseGoerli);

    case 4:
      return getChainByID(ChainID.BSC);
  }

  throw new Error(
    `No chain was found matching wormhole chain id: ${wormholeChainID}`,
  );
};
