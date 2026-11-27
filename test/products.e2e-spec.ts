import { randomUUID } from 'node:crypto';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { DrizzleService } from '../src/database/drizzle.service.js';
import { users, vendorProfiles } from '../src/database/schema.js';

const databaseUrl = process.env.PRODUCTS_TEST_DATABASE_URL;
const root = '/api/v1/vendor/products';
const bucket =
  'https://inventory-storage.test/storage/v1/object/product-images';
const image = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
  'base64',
);
const listing = {
  name: 'Paw Balm 100%',
  description: 'Unscented balm',
  subtitle: '60 ml',
  type: 'product',
  category: 'Balms',
  petType: 'dogs',
  priceCents: 1600,
  costCents: 420,
  stock: 4,
};

describe.skipIf(!databaseUrl)('Vendor Inventory (PostgreSQL e2e)', () => {
  let app: INestApplication;
  const vendorIds: string[] = [];
  const stored = new Set<string>();
  let failUpload = false;

  beforeAll(async () => {
    vi.stubEnv('DATABASE_URL', databaseUrl);
    vi.stubEnv('SUPABASE_URL', 'https://inventory-storage.test');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'sb_secret_inventory_test');
    const fetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (!url.startsWith(bucket)) return fetch(input, init);
      expect(new Headers(init?.headers).get('apikey')).toBe(
        'sb_secret_inventory_test',
      );
      if (init?.method === 'POST') {
        if (failUpload) return new Response(null, { status: 503 });
        expect(new Headers(init.headers).get('content-type')).toBe('image/png');
        stored.add(url.slice(bucket.length + 1));
      } else if (init?.method === 'DELETE') {
        const { prefixes } = JSON.parse(String(init.body)) as {
          prefixes: string[];
        };
        for (const path of prefixes) stored.delete(path);
      }
      return new Response(null, { status: 200 });
    });

    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    try {
      if (app) {
        const db = app.get(DrizzleService).db;
        for (const id of vendorIds)
          await db?.delete(users).where(eq(users.id, id));
        await app.close();
      }
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    }
  });

  async function login(email: string, password: string, expectedRole: string) {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password, expectedRole })
      .expect(200);
    return `Bearer ${response.body.accessToken}`;
  }

  async function vendor(admin: string) {
    const email = `inventory-${randomUUID()}@petmall.test`;
    const password = 'InventoryTest2026!';
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/admin/vendors')
      .set('Authorization', admin)
      .send({
        ownerName: 'Inventory Test',
        email,
        phone: '+15550100123',
        password,
        storeName: email.split('@')[0],
        businessCategory: 'PET_FOOD',
        taxOrLicenseId: 'INV-TEST',
      })
      .expect(201);
    const id: string = response.body.user.id;
    vendorIds.push(id);
    return { id, auth: await login(email, password, 'VENDOR') };
  }

  it('validates requests and scopes CRUD, uploads, filters, and duplication to the active vendor', async () => {
    const http = request(app.getHttpServer());
    const admin = await login('admin@petmall.com', 'AdminPass2026!', 'ADMIN');
    const owner = await vendor(admin);
    const other = await vendor(admin);
    await http.get(root).expect(401);
    await http.get(root).set('Authorization', admin).expect(403);
    await http
      .get(root)
      .query({ page: '1.5' })
      .set('Authorization', owner.auth)
      .expect(400);
    await http
      .post(root)
      .set('Authorization', owner.auth)
      .send({ ...listing, vendorId: other.id })
      .expect(400);
    await http
      .post(root)
      .set('Authorization', owner.auth)
      .send({ ...listing, priceCents: 0 })
      .expect(400);

    function upload(body: typeof listing, buffer: Buffer, id?: string) {
      const call = (id ? http.put(`${root}/${id}`) : http.post(root)).set(
        'Authorization',
        owner.auth,
      );
      for (const [key, value] of Object.entries(body))
        call.field(key, String(value));
      return call.attach('image', buffer, {
        filename: 'pet.png',
        contentType: 'image/png',
      });
    }

    await upload(listing, Buffer.from('invalid image')).expect(400);
    expect(stored.size).toBe(0);
    const created = await upload(listing, image).expect(201);
    const id: string = created.body.id;
    const url: string = created.body.imageUrl;
    expect(url).toContain(`/product-images/${owner.id}/`);
    expect(stored.size).toBe(1);
    expect(created.body).toMatchObject({ ...listing, isActive: true });

    await http
      .get(`${root}/${id}`)
      .set('Authorization', other.auth)
      .expect(404);
    await http
      .put(`${root}/${id}`)
      .set('Authorization', other.auth)
      .send(listing)
      .expect(404);
    await http
      .patch(`${root}/${id}/status`)
      .set('Authorization', other.auth)
      .send({ isActive: false })
      .expect(404);
    await http
      .post(`${root}/${id}/duplicate`)
      .set('Authorization', other.auth)
      .expect(404);
    await http
      .delete(`${root}/${id}`)
      .set('Authorization', other.auth)
      .expect(404);
    const empty = await http
      .get(root)
      .set('Authorization', other.auth)
      .expect(200);
    expect(empty.body).toMatchObject({ items: [], total: 0, categories: [] });

    const service = {
      ...listing,
      name: 'Grooming',
      category: 'Grooming',
      type: 'service',
      priceCents: 2900,
      stock: 0,
    };
    await http
      .post(root)
      .set('Authorization', owner.auth)
      .send(service)
      .expect(201);
    const byPrice = await http
      .get(root)
      .set('Authorization', owner.auth)
      .query({ page: 2, pageSize: 1, sort: 'price_desc' })
      .expect(200);
    expect(byPrice.body).toMatchObject({
      items: [{ id }],
      page: 2,
      total: 2,
      categories: ['Balms', 'Grooming'],
    });
    const filtered = await http
      .get(root)
      .set('Authorization', owner.auth)
      .query({ search: 'BALM 100%', category: 'Balms', stock: 'low_stock' })
      .expect(200);
    expect(filtered.body).toMatchObject({ items: [{ id }], total: 1 });
    const literal = await http
      .get(root)
      .set('Authorization', owner.auth)
      .query({ search: '_' })
      .expect(200);
    expect(literal.body.total).toBe(0);
    const services = await http
      .get(root)
      .set('Authorization', owner.auth)
      .query({ type: 'service', stock: 'out_of_stock' })
      .expect(200);
    expect(services.body).toMatchObject({
      items: [{ name: 'Grooming' }],
      total: 1,
    });

    failUpload = true;
    await upload({ ...listing, name: 'Failed replacement' }, image, id).expect(
      503,
    );
    failUpload = false;
    const unchanged = await http
      .get(`${root}/${id}`)
      .set('Authorization', owner.auth)
      .expect(200);
    expect(unchanged.body).toMatchObject({ name: listing.name, imageUrl: url });

    await http
      .put(`${root}/${id}`)
      .set('Authorization', owner.auth)
      .send({ ...listing, priceCents: 1900, stock: 19 })
      .expect(200);
    await http
      .patch(`${root}/${id}/status`)
      .set('Authorization', owner.auth)
      .send({ isActive: false })
      .expect(200);
    const copy = await http
      .post(`${root}/${id}/duplicate`)
      .set('Authorization', owner.auth)
      .expect(201);
    expect(copy.body).toMatchObject({
      name: `${listing.name} (Copy)`,
      priceCents: 1900,
      stock: 19,
      isActive: false,
      imageUrl: url,
    });
    expect(copy.body.id).not.toBe(id);

    await http
      .delete(`${root}/${id}`)
      .set('Authorization', owner.auth)
      .expect(204);
    expect(stored.size).toBe(1);
    const removedImage = await http
      .put(`${root}/${copy.body.id}`)
      .set('Authorization', owner.auth)
      .send({ ...listing, removeImage: true })
      .expect(200);
    expect(removedImage.body.imageUrl).toBeNull();
    expect(stored.size).toBe(0);
    await http
      .delete(`${root}/${copy.body.id}`)
      .set('Authorization', owner.auth)
      .expect(204);

    await app
      .get(DrizzleService)
      .db?.update(vendorProfiles)
      .set({ vendorStatus: 'SUSPENDED' })
      .where(eq(vendorProfiles.userId, owner.id));
    await http.get(root).set('Authorization', owner.auth).expect(403);
  });
});
