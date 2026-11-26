# Pet Mall — Team Setup Guide (Frontend, Backend & Supabase PostgreSQL)

This guide explains how our team connects **Nuxt 4 (`Pet_Mall_Web_2`)**, **NestJS 12 + Drizzle ORM (`Pet_Mall_Backend_2`)**, and **Supabase (Hosted PostgreSQL)** when separate teammates work on Frontend, Backend, and Database.

---

## 1. System Architecture (Read This First)

```text
[ Nuxt 4 Frontend ]   ─── HTTP + Cookies ───▶   [ NestJS 12 Backend ]   ─── Drizzle ORM ───▶   [ Supabase PostgreSQL ]
 localhost:3000                                  localhost:4000                                 (Hosted DB Only)
```

- **Supabase is ONLY our hosted PostgreSQL database.**
- We do **NOT** use Supabase Auth, Supabase client SDK (`@supabase/supabase-js`) in the browser, `SUPABASE_PUBLISHABLE_KEY`, or `SUPABASE_JWKS_URL`.
- **NestJS handles all authentication:** passwords (`bcryptjs`), JWT access tokens (`15m`), rotating `HttpOnly` refresh cookies (`pm_refresh_token`), and role checks (`CUSTOMER`, `VENDOR`, `ADMIN`).
- **Drizzle ORM** (`src/database/schema.ts`, `src/database/drizzle.service.ts`) handles all PostgreSQL queries and schema migrations.

---

## 2. Golden Team Rules for `.env` & Git

1. **NEVER commit `.env` to Git.** Both repositories ignore `.env` via `.gitignore`.
2. **ONLY commit `.env.example`** (with dummy placeholders, never real passwords or keys).
3. **Never share `.env` files inside source code or frontend builds.** Database passwords (`DATABASE_URL`) and JWT secrets stay **only** in `Pet_Mall_Backend_2/.env`.
4. Send real team `.env` secrets to teammates privately (e.g., encrypted password manager or private team channel), never in GitHub issues or PRs.

---

## 3. Database Teammate Guide (Supabase + Drizzle ORM)

### A. Get the `DATABASE_URL` from Supabase
1. Open your team's project in **Supabase Dashboard**.
2. Click **Connect** (top bar) → select **ORM** or **Connection string** → copy the **Transaction Pooler** URI (recommended for teams/IPv4, port `6543`) or Direct URI:
   ```text
   postgresql://postgres.<project-ref>:<DB_PASSWORD>@aws-0-<region>.pooler.supabase.com:6543/postgres
   ```
   > **Tip:** `src/database/drizzle.service.ts` already sets `prepare: false` and `ssl: 'require'`, which is required for Supabase's PgBouncer Transaction Pooler (`:6543`).
   > If your database password contains special characters (`@`, `#`, `/`, `:`, `%`), URL-encode them before putting them in `DATABASE_URL`.

### B. Edit & Push Database Tables (`src/database/schema.ts`)
All shared database tables live in **`src/database/schema.ts`**:
- Existing Auth tables:
  - `users` (`id`, `email`, `phone`, `password_hash`, `role`, `is_email_verified`, `is_active`, `created_at`, `updated_at`)
  - `customer_profiles` (`user_id`, `full_name`, `loyalty_points`, `created_at`)
  - `vendor_profiles` (`user_id`, `owner_name`, `store_name`, `store_slug`, `business_category`, `tax_or_license_id`, `vendor_status`, `created_at`)
  - `refresh_sessions` (`token_hash`, `user_id`, `is_revoked`, `expires_at`, `created_at`)

When adding new tables (e.g., `products`, `orders`, `cart_items`):
1. Define the table + relations in `src/database/schema.ts` and add it to the exported `schema` object.
2. Push changes to Supabase from `Pet_Mall_Backend_2`:
   ```powershell
   cd "Pet_Mall_Backend_2"
   npm run db:push
   ```
3. To generate versioned SQL migration files inside `supabase/migrations/` for your team PRs:
   ```powershell
   npm run db:generate
   ```
4. To visually inspect/edit rows in your browser:
   ```powershell
   npm run db:studio
   ```

---

## 4. Backend Teammate Guide (`Pet_Mall_Backend_2`)

### A. Create `Pet_Mall_Backend_2/.env`
Copy `.env.example` to `.env` in `Pet_Mall_Backend_2/`:

```env
PORT=4000
NODE_ENV=development
FRONTEND_URL=http://localhost:3000

# Generate random 48+ byte hex strings for local/prod JWT signing
JWT_ACCESS_SECRET=replace-with-your-random-access-secret
JWT_REFRESH_SECRET=replace-with-your-random-refresh-secret
JWT_REFRESH_EXPIRES_DAYS=7

# Supabase PostgreSQL connection string (used by Drizzle ORM)
DATABASE_URL=postgresql://postgres.<project-ref>:<DB_PASSWORD>@aws-0-<region>.pooler.supabase.com:6543/postgres

# Google OAuth 2.0 (Customers Only — optional until Google Client ID is created)
GOOGLE_CLIENT_ID=your-google-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-google-client-secret
GOOGLE_CALLBACK_URL=http://localhost:4000/api/v1/auth/google/callback

# Email OTP Delivery (Optional in dev — prints 6-digit OTP to terminal if empty)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_FROM=Pet Mall <no-reply@petmall.com>
```

> **Generate quick random JWT secrets in Node:**
> ```powershell
> node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
> ```

### B. Install & Run Backend
```powershell
cd "Pet_Mall_Backend_2"
npm install
npm run db:push      # Only needed once on a fresh DB or after schema changes
npm run start:dev    # Runs on http://localhost:4000
```

Expected startup log when connected to Supabase:
```text
[DrizzleService] Drizzle ORM connected to PostgreSQL (Supabase)
```
> **Offline / Test Mode:** If `DATABASE_URL` is omitted or still contains `[YOUR-PASSWORD]` (for example during `npm run test` or `npm run test:e2e`), `DrizzleService` automatically falls back to in-memory storage so unit and e2e tests run without hitting your live Supabase DB.

### C. Using Drizzle in New Backend Modules
`DrizzleModule` is `@Global()` in `src/app.module.ts`. Any teammate creating `ProductsService` or `OrdersService` simply injects `DrizzleService`:

```ts
import { Injectable } from '@nestjs/common';
import { DrizzleService } from '../database/drizzle.service.js';
import { users } from '../database/schema.js';

@Injectable()
export class ExampleService {
  constructor(private readonly drizzle: DrizzleService) {}

  async listUsers() {
    return this.drizzle.db!.select().from(users);
  }
}
```
*(Remember: this repo uses `"type": "module"` ESM, so relative imports must end with `.js`.)*

### D. Verify Before Opening a PR
```powershell
npm run build
npm run lint
npm run test
npm run test:e2e
```

---

## 5. Frontend Teammate Guide (`Pet_Mall_Web_2`)

### A. Create `Pet_Mall_Web_2/.env`
Create `.env` in `Pet_Mall_Web_2/` (do **NOT** put any `DATABASE_URL` or backend secret here):

```env
NUXT_PUBLIC_API_BASE=http://localhost:4000
NUXT_TELEMETRY_DISABLED=1
```

### B. Install & Run Frontend
```powershell
cd "Pet_Mall_Web_2"
npm install
npm run dev          # Runs on http://localhost:3000
```

### C. Auth Pages & Role Design Rules
- **Customer Portal (Mobile, Tablet & Desktop responsive):**
  - Login: `/auth/login` (or `/login`)
  - Register: `/auth/register` (or `/register`)
  - Profile: `/profile`
- **Vendor Partner Portal (Desktop-Only UI `>= 1024px`, Login-Only):**
  - Login: `/auth/login` → **Vendor Partner** tab (public vendor registration is intentionally disabled; accounts are provisioned by Pet Mall Admin via `POST /api/v1/auth/admin/vendors`).
  - Dashboard: `/`, `/products`, `/orders`, `/sales`, `/analytics`
  - On screens narrower than `1024px`, Vendor login and Vendor dashboard routes show `VendorDesktopNotice.vue`.

### D. Using Auth in Nuxt Components & Pages
Import `useAuth` explicitly (required because it lives in `app/composables/auth/`):

```ts
import { useAuth } from '~/composables/auth/useAuth'

const { user, isAuthenticated, isVendor, isCustomer, authorizedFetch, logout } = useAuth()
```

- **Protect any page:**
  - Any logged-in user: `definePageMeta({ middleware: ['auth'] })`
  - Customers only: `definePageMeta({ middleware: ['customer-only'] })`
  - Vendors only: `definePageMeta({ middleware: ['vendor-only'] })`
  - Guests only (redirect if signed in): `definePageMeta({ middleware: ['guest'] })`
- **Call protected backend APIs (auto-attaches Bearer token & refreshes on `401`):**
  ```ts
  const data = await authorizedFetch('/api/v1/auth/vendor/dashboard-summary')
  ```

---

## 6. Seeded Demo Accounts (Created Automatically on Startup)

When the backend starts against a fresh database, `AuthService.onModuleInit()` seeds these demo accounts if they do not exist yet:

| Role | Email | Password | Notes |
| :--- | :--- | :--- | :--- |
| **Customer** | `customer@petmall.com` | `PetLover2026!` | Login via Customer tab |
| **Vendor Partner** | `partner@happypaws.shop` | `VendorPass2026!` | Desktop UI only (`Happy Paws Boutique`) |
| **Admin** | `admin@petmall.com` | `AdminPass2026!` | Used to call `POST /api/v1/auth/admin/vendors` |

---

## 7. Quick Troubleshooting

| Error | Cause | Fix |
| :--- | :--- | :--- |
| `PostgresError: relation "users" does not exist` | Supabase tables haven't been pushed yet | Run `npm run db:push` inside `Pet_Mall_Backend_2` |
| `EADDRINUSE: address already in use :::4000` (or `3000`) | Server is already running in another terminal | Close the other terminal or reuse the running server |
| Nuxt asks `Are you interested in participating?` | First-run telemetry prompt | Set `NUXT_TELEMETRY_DISABLED=1` in `Pet_Mall_Web_2/.env` or select **No** |
| `403 Forbidden` on login (`This account is registered as ...`) | Logging in on the wrong role tab | Use **Customer** tab for customers and **Vendor Partner** tab for vendors |
| `401 Unauthorized` / cookie not persisted | Origin mismatch in CORS | Ensure `FRONTEND_URL` in Backend `.env` matches your browser origin (`http://localhost:3000`) |
