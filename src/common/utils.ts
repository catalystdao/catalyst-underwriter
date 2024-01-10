
export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function decodeBytes65Address(addressBytes65: string): string {
    let workingAddress = addressBytes65;
    if (addressBytes65.slice(0, 2) === "0x") workingAddress = addressBytes65.slice(2);

    const length = parseInt(workingAddress.slice(0, 2), 16);

    const totalLength = 2 + 64*2;
    const startingPoint = totalLength - length*2;
    return "0x" + workingAddress.slice(startingPoint);
}