import type { User } from '@/lib/api/types';
import { getItem, removeItem, setItem } from '@/lib/storage';

const USER_KEY = 'user';

export const getUser = () => getItem<User>(USER_KEY);
export const removeUser = () => removeItem(USER_KEY);
export const setUser = (value: User) => setItem<User>(USER_KEY, value);
