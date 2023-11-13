import { StaticJsonRpcProvider } from '@ethersproject/providers';
import { Wallet } from 'ethers';
import { CatalystVaultEvents__factory } from '../contracts';
import { Chain } from './interfaces/chain.interface';

export class EvmChain {
  readonly provider: StaticJsonRpcProvider;
  readonly signer: Wallet;
  readonly chain: Chain;

  constructor(chain: Chain) {
    this.chain = chain;

    this.provider = new StaticJsonRpcProvider(this.chain.rpc);

    if (!process.env.PRIVATE_KEY)
      throw new Error('Underwriter private key is missing from env');

    const wallet = new Wallet(process.env.PRIVATE_KEY);
    this.signer = wallet.connect(this.provider);
  }

  /**
   * Used to track bounty events
   * @param address IMessageEscrowEvents address for the appropriate chain
   * @returns Contract caller (Read only)
   */
  getCatalystVaultEventContract(address: string) {
    return CatalystVaultEvents__factory.connect(address, this.provider);
  }

  /**
   * Gets the current block
   * @returns Block number
   */
  async getCurrentBlock(): Promise<number> {
    return this.provider.getBlockNumber();
  }
}
