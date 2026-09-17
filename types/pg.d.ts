declare module 'pg' {
  export class Pool {
    constructor(config?: any);
    query<T = any>(text: string, params?: any[]): Promise<{ rows: T[]; rowCount: number | null }>;
    connect(): Promise<PoolClient>;
  }
  export interface PoolClient {
    query<T = any>(text: string, params?: any[]): Promise<{ rows: T[]; rowCount: number | null }>;
    release(): void;
  }
}
