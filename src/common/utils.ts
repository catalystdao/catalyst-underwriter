export const wait = (ms: number) => new Promise((res) => setTimeout(res, ms));

export const add0X = (address: string): string => `0x${address}`;

export const convertHexToDecimal = (hex: string) => BigInt(hex).toString();

export const decodeVaultOrAccount = (encodedAddress: string) => {
  return add0X(encodedAddress.substring(92));
};
