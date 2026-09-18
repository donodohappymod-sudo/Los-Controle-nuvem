import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/security';
import AppShell from '@/components/AppShell';

export const dynamic = 'force-dynamic';

export default async function Layout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  if (!user) redirect('/login');
  return <AppShell email={user.email}>{children}</AppShell>;
}
