import {redirect} from 'next/navigation'; import {currentUser} from '@/lib/security'; import AppShell from '@/components/AppShell';
export default async function Layout({children}:{children:React.ReactNode}){const u=await currentUser();if(!u)redirect('/login');return <AppShell email={u.email}>{children}</AppShell>}
