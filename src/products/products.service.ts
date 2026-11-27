import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { and, asc, count, desc, eq, gt, ilike, lte, or } from 'drizzle-orm';
import { AuthRepository } from '../auth/auth.repository.js';
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

const DEMO_PRODUCTS: Array<
  Omit<ProductRow, 'id' | 'vendorId' | 'createdAt' | 'updatedAt'>
> = [
  {
    name: 'Botanical Paw Protection Balm',
    description:
      'Cold-pressed calendula and raw shea butter balm formulated to shield and repair dry paw pads.',
    subtitle: '1 variant',
    type: 'product',
    category: 'Balms',
    petType: 'dogs',
    priceCents: 2200,
    costCents: 450,
    stock: 35,
    isActive: true,
    imagePath:
      'https://images.unsplash.com/photo-1544816155-12df9643f363?w=200&auto=format&fit=crop&q=80',
  },
  {
    name: 'Chamomile & Oat Soothing Paw Balm (60ml)',
    description:
      'Gentle colloidal oatmeal and Roman chamomile salve for seasonal allergy relief.',
    subtitle: '3 size options',
    type: 'product',
    category: 'Balms',
    petType: 'all',
    priceCents: 1600,
    costCents: 420,
    stock: 45,
    isActive: true,
    imagePath:
      'https://images.unsplash.com/photo-1608248597359-2ffb91a9f02c?w=200&auto=format&fit=crop&q=80',
  },
  {
    name: 'Organic Lavender Calming Dropper (30ml)',
    description:
      'Alcohol-free valerian root and organic lavender flower extract for thunderstorm and travel anxiety.',
    subtitle: '2 flavor variants',
    type: 'product',
    category: 'Supplements',
    petType: 'all',
    priceCents: 2400,
    costCents: 768,
    stock: 18,
    isActive: true,
    imagePath:
      'https://images.unsplash.com/photo-1556228720-195a672e8a03?w=200&auto=format&fit=crop&q=80',
  },
  {
    name: 'Probiotic Skin & Coat Chewables (90ct)',
    description:
      'Daily wild Alaskan salmon oil and multi-strain probiotic soft chews for lustrous coat health.',
    subtitle: '1 variant',
    type: 'product',
    category: 'Supplements',
    petType: 'dogs',
    priceCents: 3250,
    costCents: 1218,
    stock: 62,
    isActive: true,
    imagePath:
      'https://images.unsplash.com/photo-1584308666744-24d5c474f2ae?w=200&auto=format&fit=crop&q=80',
  },
  {
    name: 'Herbal Ear Rinse & Botanical Dropper',
    description:
      'Witch hazel, mullein flower, and organic aloe vera ear cleanser for routine hygiene.',
    subtitle: '2 size options',
    type: 'product',
    category: 'Grooming',
    petType: 'all',
    priceCents: 1800,
    costCents: 540,
    stock: 4,
    isActive: true,
    imagePath:
      'https://images.unsplash.com/photo-1576201836106-db1758fd1c97?w=200&auto=format&fit=crop&q=80',
  },
  {
    name: 'Holistic Canine Acupressure Consultation',
    description:
      'One-on-one meridian bodywork and custom botanical wellness routine with a certified practitioner.',
    subtitle: '60 min private session',
    type: 'service',
    category: 'Wellness',
    petType: 'dogs',
    priceCents: 6500,
    costCents: 325,
    stock: 8,
    isActive: true,
    imagePath: null,
  },
];

@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);
  private readonly memoryProducts = new Map<string, ProductRow>();
  private readonly seededVendors = new Set<string>();

  constructor(
    private readonly drizzle: DrizzleService,
    private readonly storage: ProductStorageService,
    private readonly authRepo: AuthRepository,
  ) {}

  private get isMemoryMode(): boolean {
    return !this.drizzle.isEnabled || !this.drizzle.db;
  }

  async list(
    vendorId: string,
    { search, category, type, stock, sort, page, pageSize }: ProductQueryDto,
  ) {
    if (this.isMemoryMode) {
      await this.requireActiveVendorInMemory(vendorId);
      const vendorRows = [...this.memoryProducts.values()].filter(
        (row) => row.vendorId === vendorId,
      );
      const categories = [
        ...new Set(vendorRows.map((row) => row.category)),
      ].sort((a, b) => a.localeCompare(b));

      const queryText = search.toLowerCase();
      const filtered = vendorRows.filter((row) => {
        if (type && row.type !== type) return false;
        if (category !== undefined && row.category !== category) return false;
        if (
          queryText &&
          !row.name.toLowerCase().includes(queryText) &&
          !row.subtitle.toLowerCase().includes(queryText) &&
          !row.description.toLowerCase().includes(queryText)
        ) {
          return false;
        }
        if (stock === 'in_stock' && !(row.stock > 5)) return false;
        if (stock === 'low_stock' && !(row.stock > 0 && row.stock <= 5))
          return false;
        if (stock === 'out_of_stock' && row.stock !== 0) return false;
        return true;
      });

      filtered.sort((a, b) => {
        if (sort === 'price_asc' && a.priceCents !== b.priceCents)
          return a.priceCents - b.priceCents;
        if (sort === 'price_desc' && a.priceCents !== b.priceCents)
          return b.priceCents - a.priceCents;
        if (sort === 'stock' && a.stock !== b.stock) return b.stock - a.stock;
        const timeDiff = b.createdAt.getTime() - a.createdAt.getTime();
        if (timeDiff !== 0) return timeDiff;
        return b.id.localeCompare(a.id);
      });

      const total = filtered.length;
      const currentPage = Math.min(
        page,
        Math.max(1, Math.ceil(total / pageSize)),
      );
      const rows = filtered.slice(
        (currentPage - 1) * pageSize,
        currentPage * pageSize,
      );

      return {
        items: rows.map((row) => this.toProduct(row)),
        categories,
        total,
        page: currentPage,
        pageSize,
      };
    }

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
    if (this.isMemoryMode) {
      await this.requireActiveVendorInMemory(vendorId);
      return this.toProduct(this.findOwnedInMemory(vendorId, id));
    }
    const db = this.db;
    await this.requireActiveVendor(db, vendorId);
    return this.toProduct(await this.findOwned(db, vendorId, id));
  }

  async create(vendorId: string, body: ProductDto, image?: ProductImage) {
    if (this.isMemoryMode) {
      await this.requireActiveVendorInMemory(vendorId);
      const uploaded = image && (await this.storage.upload(vendorId, image));
      const now = new Date();
      const created: ProductRow = {
        id: randomUUID(),
        vendorId,
        name: body.name,
        description: body.description ?? '',
        subtitle: body.subtitle ?? '',
        type: body.type,
        category: body.category,
        petType: body.petType ?? 'all',
        priceCents: body.priceCents,
        costCents: body.costCents,
        stock: body.stock,
        isActive: true,
        imagePath: uploaded ?? null,
        createdAt: now,
        updatedAt: now,
      };
      this.memoryProducts.set(created.id, created);
      return this.toProduct(created);
    }

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

    if (this.isMemoryMode) {
      await this.requireActiveVendorInMemory(vendorId);
      const current = this.findOwnedInMemory(vendorId, id);
      const uploaded = image && (await this.storage.upload(vendorId, image));
      const imagePath = removeImage ? null : (uploaded ?? current.imagePath);
      const previousImage =
        current.imagePath === imagePath ? null : current.imagePath;
      const updated: ProductRow = {
        ...current,
        ...fields,
        imagePath,
        updatedAt: new Date(),
      };
      this.memoryProducts.set(id, updated);
      await this.removeIfUnused(vendorId, previousImage);
      return this.toProduct(updated);
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
    if (this.isMemoryMode) {
      await this.requireActiveVendorInMemory(vendorId);
      const current = this.findOwnedInMemory(vendorId, id);
      const updated: ProductRow = {
        ...current,
        isActive,
        updatedAt: new Date(),
      };
      this.memoryProducts.set(id, updated);
      return this.toProduct(updated);
    }

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
    if (this.isMemoryMode) {
      await this.requireActiveVendorInMemory(vendorId);
      const current = this.findOwnedInMemory(vendorId, id);
      const now = new Date();
      const copy: ProductRow = {
        ...current,
        id: randomUUID(),
        name: `${[...current.name].slice(0, 153).join('').trimEnd()} (Copy)`,
        isActive: false,
        createdAt: now,
        updatedAt: now,
      };
      this.memoryProducts.set(copy.id, copy);
      return this.toProduct(copy);
    }

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
    if (this.isMemoryMode) {
      await this.requireActiveVendorInMemory(vendorId);
      const current = this.findOwnedInMemory(vendorId, id);
      this.memoryProducts.delete(id);
      await this.removeIfUnused(vendorId, current.imagePath);
      return;
    }

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

  private async requireActiveVendorInMemory(vendorId: string) {
    const user = await this.authRepo.findUserById(vendorId);
    if (
      !user ||
      !user.isActive ||
      user.role !== 'VENDOR' ||
      user.vendorProfile?.vendorStatus !== 'ACTIVE'
    ) {
      throw new ForbiddenException('An active vendor account is required.');
    }

    if (
      user.email === 'partner@happypaws.shop' &&
      !this.seededVendors.has(vendorId)
    ) {
      this.seededVendors.add(vendorId);
      const baseTime = Date.now() - DEMO_PRODUCTS.length * 60_000;
      DEMO_PRODUCTS.forEach((item, index) => {
        const timestamp = new Date(baseTime + index * 60_000);
        const row: ProductRow = {
          ...item,
          id: randomUUID(),
          vendorId,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        this.memoryProducts.set(row.id, row);
      });
    }
  }

  private findOwnedInMemory(vendorId: string, id: string): ProductRow {
    const row = this.memoryProducts.get(id);
    if (!row || row.vendorId !== vendorId) {
      throw new NotFoundException('Inventory item not found.');
    }
    return row;
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
    if (this.isMemoryMode) {
      const stillUsed = [...this.memoryProducts.values()].some(
        (row) => row.vendorId === vendorId && row.imagePath === path,
      );
      if (!stillUsed) await this.storage.remove(path);
      return;
    }
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
