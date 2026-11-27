create table public.products (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references public.vendor_profiles (user_id) on delete cascade,
  name text not null,
  description text not null default '',
  subtitle text not null default '',
  type text not null constraint products_type_check check (type in ('product', 'service')),
  category text not null,
  pet_type text not null default 'all' constraint products_pet_type_check check (pet_type in ('all', 'dogs', 'cats', 'other')),
  price_cents integer not null constraint products_price_check check (price_cents between 1 and 99999999),
  cost_cents integer not null constraint products_cost_check check (cost_cents between 0 and 99999999),
  stock integer not null constraint products_stock_check check (stock between 0 and 1000000),
  is_active boolean not null default true,
  image_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_products_vendor_created on public.products (vendor_id, created_at desc, id desc);
create index idx_products_vendor_category on public.products (vendor_id, category);
create index idx_products_vendor_image on public.products (vendor_id, image_path);

-- Inventory includes private cost data. NestJS accesses it through Drizzle.
alter table public.products enable row level security;
revoke all on public.products from anon, authenticated;

-- Images are marketplace assets. Only the backend can upload or remove them.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('product-images', 'product-images', true, 5242880, array['image/jpeg', 'image/png', 'image/webp']);
