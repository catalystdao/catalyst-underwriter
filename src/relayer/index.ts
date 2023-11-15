import axios from 'axios';
import { join } from 'path';

const baseEndpoint = process.env.RELAYER_ENDPOINT!;

export const getBountyByID = async (id: string) => {
  try {
    const res = await axios.get(join(baseEndpoint, '/bounty/:id'));
  } catch (error) {
    console.error(`Failed to get bounty ${id} from the relayer`);
  }
};

export const getAllBounties = async () => {
  try {
    const res = await axios.get(join(baseEndpoint, '/bounties'));
  } catch (error) {
    console.error(`Failed to get all bounties from the relayer`);
  }
};

export const prioritise = async (id: string) => {
  try {
    const res = await axios.post(join(baseEndpoint, '/prioritise/:id'));
  } catch (error) {
    console.error(`Failed to prioritise bounty ${id}`);
  }
};
