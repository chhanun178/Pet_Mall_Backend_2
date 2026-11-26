import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { OtpMailerService } from '../src/auth/otp-mailer.service.js';

describe('Pet Mall Auth (e2e)', () => {
  let app: INestApplication;
  const sentOtps = new Map<string, string>();
  const sentResetOtps = new Map<string, string>();

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(OtpMailerService)
      .useValue({
        sendVerificationOtp: async (email: string, otp: string) => {
          sentOtps.set(email.toLowerCase(), otp);
        },
        sendPasswordResetOtp: async (email: string, otp: string) => {
          sentResetOtps.set(email.toLowerCase(), otp);
        },
      })
      .compile();

    app = moduleFixture.createNestApplication();
    app.use(cookieParser());
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
    await app.close();
  });

  it('requires Customer OTP verification on registration before issuing tokens and /me', async () => {
    const email = 'taylor.pet@example.com';

    const regRes = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        fullName: 'Taylor Swift',
        email,
        phone: '+15551234567',
        password: 'Password123',
      })
      .expect(201);

    expect(regRes.body.requiresOtpVerification).toBe(true);
    expect(regRes.body.accessToken).toBeUndefined();

    const issuedOtp = sentOtps.get(email);
    expect(issuedOtp).toMatch(/^\d{6}$/);

    // Unverified login must be blocked with requiresOtpVerification
    const unverifiedLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({
        email,
        password: 'Password123',
        expectedRole: 'CUSTOMER',
      })
      .expect(403);

    expect(unverifiedLogin.body.requiresOtpVerification).toBe(true);

    // Resend within cooldown must return 429
    await request(app.getHttpServer())
      .post('/api/v1/auth/resend-otp')
      .send({ email })
      .expect(429);

    // Wrong OTP must fail with remaining attempts
    await request(app.getHttpServer())
      .post('/api/v1/auth/verify-otp')
      .send({ email, otp: '000000' === issuedOtp ? '111111' : '000000' })
      .expect(400);

    // Valid OTP verifies email and issues tokens + refresh cookie
    const verifyRes = await request(app.getHttpServer())
      .post('/api/v1/auth/verify-otp')
      .send({ email, otp: issuedOtp })
      .expect(200);

    expect(verifyRes.body.accessToken).toBeDefined();
    expect(verifyRes.body.user.role).toBe('CUSTOMER');
    expect(verifyRes.body.user.isEmailVerified).toBe(true);
    expect(verifyRes.headers['set-cookie']).toBeDefined();

    const meRes = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${verifyRes.body.accessToken}`)
      .expect(200);

    expect(meRes.body.user.email).toBe(email);
  });

  it('rejects public Vendor registration route (404)', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/register/vendor')
      .send({ email: 'fake@vendor.com' })
      .expect(404);
  });

  it('allows seeded Vendor Partner to log in and access vendor summary, and blocks Customer', async () => {
    const vendLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({
        email: 'partner@happypaws.shop',
        password: 'VendorPass2026!',
        expectedRole: 'VENDOR',
      })
      .expect(200);

    expect(vendLogin.body.user.role).toBe('VENDOR');

    const summary = await request(app.getHttpServer())
      .get('/api/v1/auth/vendor/dashboard-summary')
      .set('Authorization', `Bearer ${vendLogin.body.accessToken}`)
      .expect(200);

    expect(summary.body.storeName).toBe('Happy Paws Boutique');

    const custLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({
        email: 'customer@petmall.com',
        password: 'PetLover2026!',
        expectedRole: 'CUSTOMER',
      })
      .expect(200);

    await request(app.getHttpServer())
      .get('/api/v1/auth/vendor/dashboard-summary')
      .set('Authorization', `Bearer ${custLogin.body.accessToken}`)
      .expect(403);
  });

  it('rotates refresh token cookie on /refresh and clears on /logout', async () => {
    const loginRes = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({
        email: 'customer@petmall.com',
        password: 'PetLover2026!',
      })
      .expect(200);

    const cookies = loginRes.headers['set-cookie'];
    const refreshRes = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', cookies)
      .expect(200);

    expect(refreshRes.body.accessToken).toBeDefined();
    expect(refreshRes.body.user.email).toBe('customer@petmall.com');

    await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Cookie', refreshRes.headers['set-cookie'])
      .expect(200);
  });

  it('enforces expectedRole on login and allows Admin vendor provisioning', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({
        email: 'customer@petmall.com',
        password: 'PetLover2026!',
        expectedRole: 'VENDOR',
      })
      .expect(403);

    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({
        email: 'partner@happypaws.shop',
        password: 'VendorPass2026!',
        expectedRole: 'CUSTOMER',
      })
      .expect(403);

    const adminLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({
        email: 'admin@petmall.com',
        password: 'AdminPass2026!',
        expectedRole: 'ADMIN',
      })
      .expect(200);

    const provisionRes = await request(app.getHttpServer())
      .post('/api/v1/auth/admin/vendors')
      .set('Authorization', `Bearer ${adminLogin.body.accessToken}`)
      .send({
        ownerName: 'Sora Takahashi',
        email: 'sora@velvetpaws.shop',
        phone: '+15559876543',
        password: 'VendorSecret2026!',
        storeName: 'Velvet Paws Atelier',
        businessCategory: 'GROOMING',
        taxOrLicenseId: 'BUS-2026-99102',
      })
      .expect(201);

    expect(provisionRes.body.user.role).toBe('VENDOR');
    expect(provisionRes.body.user.vendorProfile.storeName).toBe('Velvet Paws Atelier');

    const newVendorLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({
        email: 'sora@velvetpaws.shop',
        password: 'VendorSecret2026!',
        expectedRole: 'VENDOR',
      })
      .expect(200);

    expect(newVendorLogin.body.user.vendorProfile.storeName).toBe('Velvet Paws Atelier');
  });

  it('guards Google OAuth routes when unconfigured or missing CSRF state', async () => {
    const googleStart = await request(app.getHttpServer())
      .get('/api/v1/auth/google')
      .expect(302);

    expect(googleStart.headers.location).toContain('/auth/login?error=google_not_configured');

    const invalidCallback = await request(app.getHttpServer())
      .get('/api/v1/auth/google/callback?code=fake&state=wrong')
      .expect(302);

    expect(invalidCallback.headers.location).toContain('/auth/login?error=google_state_invalid');
  });

  it('rejects invalid, duplicate (case-insensitive), and mass-assignment registrations', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ fullName: '   ', email: 'ws@example.com', password: 'Password123' })
      .expect(400);

    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        fullName: 'Long Pw User',
        email: 'longpw@example.com',
        password: 'A1' + 'x'.repeat(71),
      })
      .expect(400);

    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        fullName: 'Hacker',
        email: 'hacker@example.com',
        password: 'Password123',
        role: 'ADMIN',
      })
      .expect(400);

    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        fullName: 'Duplicate Case',
        email: 'Taylor.Pet@Example.COM',
        password: 'Password123',
      })
      .expect(409);
  });

  it('rejects tampered/alg:none JWTs, revokes reused refresh tokens, and rate-limits login brute force', async () => {
    await request(app.getHttpServer()).get('/api/v1/auth/me').expect(401);

    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', 'Bearer tampered.jwt.value')
      .expect(401);

    const noneHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const nonePayload = Buffer.from(JSON.stringify({ sub: '123', role: 'ADMIN' })).toString('base64url');
    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${noneHeader}.${nonePayload}.`)
      .expect(401);

    const loginRes = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'customer@petmall.com', password: 'PetLover2026!' })
      .expect(200);

    expect(loginRes.body.user.passwordHash).toBeUndefined();
    const initialCookie = loginRes.headers['set-cookie'];

    const rotatedRes = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', initialCookie)
      .expect(200);

    // Reusing an already-rotated refresh token must fail AND revoke the rotated session
    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', initialCookie)
      .expect(401);

    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', rotatedRes.headers['set-cookie'])
      .expect(401);

    // 10 invalid attempts for a target email succeed with 401; 11th triggers 429
    for (let i = 0; i < 10; i++) {
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'bruteforce.target@example.com', password: 'WrongPassword1!' })
        .expect(401);
    }

    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'bruteforce.target@example.com', password: 'WrongPassword1!' })
      .expect(429);
  });

  it('resets password via email OTP without leaking account existence and revokes active sessions', async () => {
    const missingRes = await request(app.getHttpServer())
      .post('/api/v1/auth/forgot-password')
      .send({ email: 'nobody@example.com' })
      .expect(200);

    expect(missingRes.body.message).toContain('If an account with that email exists');

    // Use the verified Taylor account created earlier
    const loginBefore = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'taylor.pet@example.com', password: 'Password123' })
      .expect(200);

    const activeCookie = loginBefore.headers['set-cookie'];

    const forgotRes = await request(app.getHttpServer())
      .post('/api/v1/auth/forgot-password')
      .send({ email: 'Taylor.Pet@Example.com' })
      .expect(200);

    expect(forgotRes.body.message).toBe(missingRes.body.message);

    const resetOtp = sentResetOtps.get('taylor.pet@example.com');
    expect(resetOtp).toMatch(/^\d{6}$/);

    // Wrong OTP rejected
    await request(app.getHttpServer())
      .post('/api/v1/auth/reset-password')
      .send({
        email: 'taylor.pet@example.com',
        otp: resetOtp === '000000' ? '111111' : '000000',
        newPassword: 'NewPassword456',
      })
      .expect(400);

    // Valid OTP resets password and revokes existing refresh sessions
    await request(app.getHttpServer())
      .post('/api/v1/auth/reset-password')
      .send({
        email: 'taylor.pet@example.com',
        otp: resetOtp,
        newPassword: 'NewPassword456',
      })
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', activeCookie)
      .expect(401);

    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'taylor.pet@example.com', password: 'Password123' })
      .expect(401);

    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'taylor.pet@example.com', password: 'NewPassword456' })
      .expect(200);
  });
});
