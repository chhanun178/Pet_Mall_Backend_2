import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { and, asc, count, desc, eq, gt, ilike, lte, or } from 'drizzle-orm';
import { DrizzleService } from '../database/drizzle.service.js';
import { products, users, vendorProfiles } from '../database/schema.js';
import type {
  ProductDto,
  ProductQueryDto,
  UpdateProductDto,
} from './product.dto.js';
import {
  type ProductImage,
  ProductStorageService,
} from './product-storage.service.js';

type Database = NonNullable<DrizzleService['db']>;
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type ProductRow = typeof products.$inferSelect;

@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);

  constructor(
    private readonly drizzle: DrizzleService,
    private readonly storage: ProductStorageService,
  ) {}

  async list(
    vendorId: string,
    { search, category, type, stock, sort, page, pageSize }: ProductQueryDto,
  ) {
    const pattern = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
    const stockCondition = {
      all: undefined,
      in_stock: gt(products.stock, 5),
      low_stock: and(gt(products.stock, 0), lte(products.stock, 5)),
      out_of_stock: eq(products.stock, 0),
    }[stock];
    const order = {
      newest: [],
      price_asc: [asc(products.priceCents)],
      price_desc: [desc(products.priceCents)],
      stock: [desc(products.stock)],
    }[sort];
    const vendor = eq(products.vendorId, vendorId);
    const where = and(
      vendor,
      type ? eq(products.type, type) : undefined,
      category === undefined ? undefined : eq(products.category, category),
      search
        ? or(
            ilike(products.name, pattern),
            ilike(products.subtitle, pattern),
            ilike(products.description, pattern),
          )
        : undefined,
      stockCondition,
    );

    return this.db.transaction(
      async (tx) => {
        await this.requireActiveVendor(tx, vendorId);
        const [totals] = await tx
          .select({ total: count() })
          .from(products)
          .where(where);
        const total = totals.total;
        const currentPage = Math.min(
          page,
          Math.max(1, Math.ceil(total / pageSize)),
        );
        const rows = await tx
          .select()
          .from(products)
          .where(where)
          .orderBy(...order, desc(products.createdAt), desc(products.id))
          .limit(pageSize)
          .offset((currentPage - 1) * pageSize);
        const categories = await tx
          .selectDistinct({ category: products.category })
          .from(products)
          .where(vendor)
          .orderBy(asc(products.category));

        return {
          items: rows.map((row) => this.toProduct(row)),
          categories: categories.map((row) => row.category),
          total,
          page: currentPage,
          pageSize,
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  async get(vendorId: string, id: string) {
    const db = this.db;
    await this.requireActiveVendor(db, vendorId);
    return this.toProduct(await this.findOwned(db, vendorId, id));
  }

  async create(vendorId: string, body: ProductDto, image?: ProductImage) {
    let uploaded: string | undefined;
    try {
      const row = await this.write(vendorId, async (tx) => {
        uploaded = image && (await this.storage.upload(vendorId, image));
        const [created] = await tx
          .insert(products)
          .values({ ...body, vendorId, imagePath: uploaded })
          .returning();
        return created;
      });
      return this.toProduct(row);
    } catch (error) {
      await this.removeIfUnused(vendorId, uploaded);
      throw error;
    }
  }

  async update(
    vendorId: string,
    id: string,
    body: UpdateProductDto,
    image?: ProductImage,
  ) {
    const { removeImage, ...fields } = body;
    if (removeImage && image) {
      throw new BadRequestException(
        'Choose either to remove or replace the image.',
      );
    }

    let uploaded: string | undefined;
    try {
      const { row, previousImage } = await this.write(vendorId, async (tx) => {
        const current = await this.findOwned(tx, vendorId, id);
        uploaded = image && (await this.storage.upload(vendorId, image));
        const imagePath = removeImage ? null : (uploaded ?? current.imagePath);
        const [row] = await tx
          .update(products)
          .set({ ...fields, imagePath, updatedAt: new Date() })
          .where(this.owned(vendorId, id))
          .returning();
        return {
          row,
          previousImage:
            current.imagePath === imagePath ? null : current.imagePath,
        };
      });
      await this.removeIfUnused(vendorId, previousImage);
      return this.toProduct(row);
    } catch (error) {
      await this.removeIfUnused(vendorId, uploaded);
      throw error;
    }
  }

  async setStatus(vendorId: string, id: string, isActive: boolean) {
    const row = await this.write(vendorId, async (tx) => {
      const [updated] = await tx
        .update(products)
        .set({ isActive, updatedAt: new Date() })
        .where(this.owned(vendorId, id))
        .returning();
      if (!updated) throw new NotFoundException('Inventory item not found.');
      return updated;
    });
    return this.toProduct(row);
  }

  async duplicate(vendorId: string, id: string) {
    const copy = await this.write(vendorId, async (tx) => {
      const {
        name,
        description,
        subtitle,
        type,
        category,
        petType,
        priceCents,
        costCents,
        stock,
        imagePath,
      } = await this.findOwned(tx, vendorId, id);
      const [created] = await tx
        .insert(products)
        .values({
          vendorId,
          name: `${[...name].slice(0, 153).join('').trimEnd()} (Copy)`,
          description,
          subtitle,
          type,
          category,
          petType,
          priceCents,
          costCents,
          stock,
          imagePath,
          isActive: false,
        })
        .returning();
      return created;
    });
    return this.toProduct(copy);
  }

  async delete(vendorId: string, id: string): Promise<void> {
    const imagePath = await this.write(vendorId, async (tx) => {
      const [deleted] = await tx
        .delete(products)
        .where(this.owned(vendorId, id))
        .returning({ imagePath: products.imagePath });
      if (!deleted) throw new NotFoundException('Inventory item not found.');
      return deleted.imagePath;
    });
    await this.removeIfUnused(vendorId, imagePath);
  }

  private get db(): Database {
    if (!this.drizzle.db) {
      throw new ServiceUnavailableException(
        'Inventory requires a configured database.',
      );
    }
    return this.drizzle.db;
  }

  private async requireActiveVendor(
    db: Database | Transaction,
    vendorId: string,
    lock = false,
  ) {
    const query = db
      .select({ id: vendorProfiles.userId })
      .from(vendorProfiles)
      .innerJoin(users, eq(users.id, vendorProfiles.userId))
      .where(
        and(
          eq(vendorProfiles.userId, vendorId),
          eq(vendorProfiles.vendorStatus, 'ACTIVE'),
          eq(users.isActive, true),
          eq(users.role, 'VENDOR'),
        ),
      );

    const [vendor] = await (lock
      ? query.for('update', { of: vendorProfiles })
      : query);
    if (!vendor)
      throw new ForbiddenException('An active vendor account is required.');
  }

  private write<T>(
    vendorId: string,
    operation: (tx: Transaction) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(async (tx) => {
      // Serialize changes to a vendor's image references across edits, copies, and deletes.
      await this.requireActiveVendor(tx, vendorId, true);
      return operation(tx);
    });
  }

  private owned(vendorId: string, id: string) {
    return and(eq(products.vendorId, vendorId), eq(products.id, id));
  }

  private async findOwned(
    db: Database | Transaction,
    vendorId: string,
    id: string,
  ) {
    const [row] = await db
      .select()
      .from(products)
      .where(this.owned(vendorId, id));
    if (!row) throw new NotFoundException('Inventory item not found.');
    return row;
  }

  private toProduct({ vendorId: _vendorId, imagePath, ...row }: ProductRow) {
    return {
      ...row,
      imageUrl: imagePath ? this.storage.publicUrl(imagePath) : null,
    };
  }

  private async removeIfUnused(
    vendorId: string,
    path: string | null | undefined,
  ) {
    if (!path) return;
    try {
      // New writes can only reference a fresh upload or an image on an existing row.
      const [reference] = await this.db
        .select({ id: products.id })
        .from(products)
        .where(
          and(eq(products.vendorId, vendorId), eq(products.imagePath, path)),
        )
        .limit(1);
      if (!reference) await this.storage.remove(path);
    } catch {
      this.logger.warn(
        'Could not clean up an unused inventory image in Supabase Storage.',
      );
    }
  }
}
