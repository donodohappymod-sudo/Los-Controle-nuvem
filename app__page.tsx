import {redirect} from 'next/navigation'; import {currentUser} from '@/lib/security';
export default async function Page(){redirect((await currentUser())?'/dashboard':'/login');}
