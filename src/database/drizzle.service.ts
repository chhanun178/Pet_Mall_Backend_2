import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import { schema } from './schema.js';

@Injectable()
export class DrizzleService implements OnModuleDestroy {
  private readonly logger = new Logger(DrizzleService.name);
  private readonly sqlClient: Sql | null;
  readonly db: PostgresJsDatabase<typeof schema> | null;
  readonly isEnabled: boolean;

  constructor() {
    const databaseUrl = process.env.DATABASE_URL?.trim();
    const validUrl = Boolean(
      databaseUrl &&
        (databaseUrl.startsWith('postgres://') || databaseUrl.startsWith('postgresql://')) &&
        !databaseUrl.includes('[YOUR-PASSWORD]'),
    );

    if (validUrl && databaseUrl) {
      // prepare: false is required for Supabase PgBouncer Transaction Pooler compatibility
      this.sqlClient = postgres(databaseUrl, {
        prepare: false,
        ssl: databaseUrl.includes('localhost') ? undefined : 'require',
      });
      this.db = drizzle(this.sqlClient, { schema });
      this.isEnabled = true;
      this.logger.log('Drizzle ORM connected to PostgreSQL (Supabase)');
    } else {
      this.sqlClient = null;
      this.db = null;
      this.isEnabled = false;
      this.logger.log(
        'Drizzle ORM running in in-memory fallback mode (set DATABASE_URL to connect to PostgreSQL)',
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.sqlClient) {
      await this.sqlClient.end({ timeout: 5 });
    }
  }
}
