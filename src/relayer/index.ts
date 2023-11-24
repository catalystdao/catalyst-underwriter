import axios from 'axios';
import { join } from 'path';
import { AMB } from './interfaces/amb.interface';

const baseEndpoint = process.env.RELAYER_ENDPOINT!;

export const getAMBByID = async (id: string): Promise<AMB | undefined> => {
  try {
    const res = await axios.get<AMB>(join(baseEndpoint, '/amb/:id'));

    return res.data;
  } catch (error) {
    console.error(`Failed to get amb ${id} from the relayer`);
  }
};

export const prioritise = async (id: string) => {
  try {
    await axios.post(join(baseEndpoint, '/prioritise/:id'));
  } catch (error) {
    console.error(`Failed to prioritise bounty ${id}`);
  }
};
