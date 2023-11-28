import { AMBType } from '../enums/AMBType.enum';

export interface AMB {
  messageIdentifier: string;
  destinationChain: string;
  payload: string;
  ambType: AMBType;
}
