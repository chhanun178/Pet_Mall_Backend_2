import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  UnauthorizedException,
  type OnModuleInit,
} from '@nestjs/common';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import jwt from 'jsonwebtoken';
import { AuthRepository, type OtpPurpose, type StoredUser } from './auth.repository.js';
import type {
  AccessTokenPayload,
  RefreshTokenPayload,
  SafeUser,
} from './auth.types.js';
import type {
  ForgotPasswordDto,
  LoginDto,
  ProvisionVendorDto,
  RegisterCustomerDto,
  ResendOtpDto,
  ResetPasswordDto,
  VerifyOtpDto,
} from './dto/auth.dto.js';
import { OtpMailerService } from './otp-mailer.service.js';

const OTP_EXPIRY_MS = 10 * 60 * 1000;
const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;

@Injectable()
export class AuthService implements OnModuleInit {
  private getAccessSecret(): string {
    const secret = process.env.JWT_ACCESS_SECRET?.trim();
    if (secret && !secret.includes('replace-with-')) {
      return secret;
    }
    if (process.env.NODE_ENV === 'production') {
      throw new Error('JWT_ACCESS_SECRET must be configured in production');
    }
    return 'dev-pet-mall-access-secret-change-me';
  }

  private getRefreshSecret(): string {
    const secret = process.env.JWT_REFRESH_SECRET?.trim();
    if (secret && !secret.includes('replace-with-')) {
      return secret;
    }
    if (process.env.NODE_ENV === 'production') {
      throw new Error('JWT_REFRESH_SECRET must be configured in production');
    }
    return 'dev-pet-mall-refresh-secret-change-me';
  }

  private readonly refreshDays = Number(process.env.JWT_REFRESH_EXPIRES_DAYS || 7);

  private readonly googleClientId = process.env.GOOGLE_CLIENT_ID?.trim() || '';
  private readonly googleClientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim() || '';
  private readonly googleCallbackUrl =
    process.env.GOOGLE_CALLBACK_URL?.trim() ||
    'http://localhost:4000/api/v1/auth/google/callback';

  constructor(
    private readonly repo: AuthRepository,
    private readonly otpMailer: OtpMailerService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.getAccessSecret();
    this.getRefreshSecret();
    await this.seedDemoAccounts();
  }

  private getGoogleClient(): OAuth2Client {
    return new OAuth2Client(
      this.googleClientId,
      this.googleClientSecret,
      this.googleCallbackUrl,
    );
  }

  isGoogleOAuthConfigured(): boolean {
    return Boolean(
      this.googleClientId &&
        this.googleClientSecret &&
        !this.googleClientId.includes('your-google-client-id'),
    );
  }

  getGoogleAuthUrl(state: string): string {
    return this.getGoogleClient().generateAuthUrl({
      access_type: 'online',
      scope: ['openid', 'email', 'profile'],
      state,
      prompt: 'select_account',
    });
  }

  private async seedDemoAccounts(): Promise<void> {
    const custHash = bcrypt.hashSync('PetLover2026!', 10);
    const vendHash = bcrypt.hashSync('VendorPass2026!', 10);
    const adminHash = bcrypt.hashSync('AdminPass2026!', 10);

    const demoUsers: StoredUser[] = [
      {
        id: crypto.randomUUID(),
        email: 'customer@petmall.com',
        role: 'CUSTOMER',
        authProvider: 'LOCAL',
        isEmailVerified: true,
        isActive: true,
        passwordHash: custHash,
        customerProfile: { fullName: 'Alex Rivera', loyaltyPoints: 240 },
      },
      {
        id: crypto.randomUUID(),
        email: 'partner@happypaws.shop',
        role: 'VENDOR',
        authProvider: 'LOCAL',
        isEmailVerified: true,
        isActive: true,
        passwordHash: vendHash,
        vendorProfile: {
          ownerName: 'Jamie Chen',
          storeName: 'Happy Paws Boutique',
          storeSlug: 'happy-paws-boutique',
          businessCategory: 'PET_FOOD',
          taxOrLicenseId: 'BUS-2026-88412',
          vendorStatus: 'ACTIVE',
        },
      },
      {
        id: crypto.randomUUID(),
        email: 'admin@petmall.com',
        role: 'ADMIN',
        authProvider: 'LOCAL',
        isEmailVerified: true,
        isActive: true,
        passwordHash: adminHash,
      },
    ];

    for (const u of demoUsers) {
      const existing = await this.repo.findUserByEmail(u.email);
      if (!existing) {
        await this.repo.createUser(u);
      }
    }
  }

  private toSafeUser(user: StoredUser): SafeUser {
    const {
      passwordHash: _pw,
      authProvider: _provider,
      googleId: _gid,
      isActive: _active,
      ...safe
    } = user;
    return safe;
  }

  private sha256(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  private hashesEqual(a: string, b: string): boolean {
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  }

  private async issueAndSendOtp(
    user: StoredUser,
    purpose: OtpPurpose,
  ): Promise<void> {
    const code = crypto.randomInt(100000, 1000000).toString();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + OTP_EXPIRY_MS);

    await this.repo.createEmailOtp({
      id: crypto.randomUUID(),
      userId: user.id,
      email: user.email,
      codeHash: this.sha256(code),
      purpose,
      attempts: 0,
      expiresAt,
      consumedAt: null,
      createdAt: now,
    });

    if (purpose === 'PASSWORD_RESET') {
      await this.otpMailer.sendPasswordResetOtp(user.email, code);
    } else {
      await this.otpMailer.sendVerificationOtp(user.email, code);
    }
  }

  private async validateOtpRecord(
    email: string,
    otp: string,
    purpose: OtpPurpose,
  ) {
    const otpRecord = await this.repo.findLatestActiveOtp(email, purpose);
    if (!otpRecord) {
      throw new BadRequestException(
        'No active verification code found. Please request a new OTP.',
      );
    }

    if (otpRecord.expiresAt < new Date()) {
      throw new BadRequestException('Verification code expired. Please request a new OTP.');
    }

    if (otpRecord.attempts >= OTP_MAX_ATTEMPTS) {
      throw new BadRequestException(
        'Too many incorrect OTP attempts. Please request a new verification code.',
      );
    }

    const candidateHash = this.sha256(otp.trim());
    if (!this.hashesEqual(candidateHash, otpRecord.codeHash)) {
      const attempts = await this.repo.incrementOtpAttempts(otpRecord.id);
      const remaining = Math.max(0, OTP_MAX_ATTEMPTS - attempts);
      throw new BadRequestException(
        remaining > 0
          ? `Invalid OTP code. ${remaining} attempt(s) remaining.`
          : 'Too many incorrect OTP attempts. Please request a new verification code.',
      );
    }

    return otpRecord;
  }

  private async issueTokens(
    user: StoredUser,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const accessPayload: AccessTokenPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      vendorStatus: user.vendorProfile?.vendorStatus,
    };

    const accessToken = jwt.sign(accessPayload, this.getAccessSecret(), {
      expiresIn: '15m',
      algorithm: 'HS256',
    });

    const refreshPayload: RefreshTokenPayload = {
      sub: user.id,
      jti: crypto.randomUUID(),
    };

    const refreshToken = jwt.sign(refreshPayload, this.getRefreshSecret(), {
      expiresIn: `${this.refreshDays}d`,
      algorithm: 'HS256',
    });

    const expiresAt = new Date(Date.now() + this.refreshDays * 24 * 60 * 60 * 1000);
    const tokenHash = this.sha256(refreshToken);

    await this.repo.saveRefreshSession({
      tokenHash,
      userId: user.id,
      isRevoked: false,
      expiresAt,
    });

    return { accessToken, refreshToken };
  }

  async registerCustomer(dto: RegisterCustomerDto) {
    const email = dto.email.toLowerCase().trim();
    if (await this.repo.findUserByEmail(email)) {
      throw new ConflictException('An account with this email already exists');
    }

    const passwordHash = await bcrypt.hash(dto.password, 12);
    const user: StoredUser = {
      id: crypto.randomUUID(),
      email,
      phone: dto.phone,
      role: 'CUSTOMER',
      authProvider: 'LOCAL',
      isEmailVerified: false,
      isActive: true,
      passwordHash,
      customerProfile: {
        fullName: dto.fullName.trim(),
        loyaltyPoints: 50,
      },
    };

    await this.repo.createUser(user);
    await this.issueAndSendOtp(user, 'EMAIL_VERIFICATION');

    return {
      requiresOtpVerification: true,
      email: user.email,
      message: 'Verification code sent to your email. Please enter the 6-digit OTP.',
    };
  }

  async verifyCustomerOtp(dto: VerifyOtpDto) {
    const email = dto.email.toLowerCase().trim();
    const user = await this.repo.findUserByEmail(email);

    if (!user || user.role !== 'CUSTOMER' || !user.isActive) {
      throw new BadRequestException('Invalid verification request');
    }

    if (user.isEmailVerified) {
      const tokens = await this.issueTokens(user);
      return { user: this.toSafeUser(user), ...tokens };
    }

    const otpRecord = await this.validateOtpRecord(email, dto.otp, 'EMAIL_VERIFICATION');

    await this.repo.consumeOtpAndVerifyEmail(otpRecord.id, user.id);
    const verifiedUser = (await this.repo.findUserById(user.id)) ?? {
      ...user,
      isEmailVerified: true,
    };

    const tokens = await this.issueTokens(verifiedUser);
    return { user: this.toSafeUser(verifiedUser), ...tokens };
  }

  async resendCustomerOtp(dto: ResendOtpDto): Promise<{ message: string }> {
    const email = dto.email.toLowerCase().trim();
    const user = await this.repo.findUserByEmail(email);

    if (!user || user.role !== 'CUSTOMER' || !user.isActive || user.isEmailVerified) {
      return {
        message: 'If this email needs verification, a new 6-digit code has been sent.',
      };
    }

    const latest = await this.repo.findLatestActiveOtp(email, 'EMAIL_VERIFICATION');
    if (latest) {
      const elapsed = Date.now() - latest.createdAt.getTime();
      if (elapsed < OTP_RESEND_COOLDOWN_MS) {
        const waitSeconds = Math.ceil((OTP_RESEND_COOLDOWN_MS - elapsed) / 1000);
        throw new HttpException(
          `Please wait ${waitSeconds}s before requesting a new verification code.`,
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }

    await this.issueAndSendOtp(user, 'EMAIL_VERIFICATION');
    return {
      message: 'A new 6-digit verification code has been sent to your email.',
    };
  }

  async requestPasswordReset(dto: ForgotPasswordDto): Promise<{ message: string }> {
    const genericResponse = {
      message:
        'If an account with that email exists, a 6-digit password reset code has been sent.',
    };

    const email = dto.email.toLowerCase().trim();
    const user = await this.repo.findUserByEmail(email);
    if (!user || !user.isActive) {
      return genericResponse;
    }

    const latest = await this.repo.findLatestActiveOtp(email, 'PASSWORD_RESET');
    if (latest) {
      const elapsed = Date.now() - latest.createdAt.getTime();
      if (elapsed < OTP_RESEND_COOLDOWN_MS) {
        const waitSeconds = Math.ceil((OTP_RESEND_COOLDOWN_MS - elapsed) / 1000);
        throw new HttpException(
          `Please wait ${waitSeconds}s before requesting another reset code.`,
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }

    await this.issueAndSendOtp(user, 'PASSWORD_RESET');
    return genericResponse;
  }

  async resetPasswordWithOtp(dto: ResetPasswordDto): Promise<{ message: string }> {
    const email = dto.email.toLowerCase().trim();
    const user = await this.repo.findUserByEmail(email);

    if (!user || !user.isActive) {
      throw new BadRequestException(
        'No active verification code found. Please request a new OTP.',
      );
    }

    const otpRecord = await this.validateOtpRecord(email, dto.otp, 'PASSWORD_RESET');
    const newHash = await bcrypt.hash(dto.newPassword, 12);

    await this.repo.consumeOtpAndResetPassword(otpRecord.id, user.id, newHash);

    return {
      message: 'Password updated successfully. Please sign in with your new password.',
    };
  }

  async provisionVendorByAdmin(dto: ProvisionVendorDto): Promise<SafeUser> {
    const email = dto.email.toLowerCase().trim();
    if (await this.repo.findUserByEmail(email)) {
      throw new ConflictException('An account with this business email already exists');
    }

    const slugBase = dto.storeName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');

    const passwordHash = await bcrypt.hash(dto.password, 12);
    const user: StoredUser = {
      id: crypto.randomUUID(),
      email,
      phone: dto.phone,
      role: 'VENDOR',
      authProvider: 'LOCAL',
      isEmailVerified: true,
      isActive: true,
      passwordHash,
      vendorProfile: {
        ownerName: dto.ownerName.trim(),
        storeName: dto.storeName.trim(),
        storeSlug: `${slugBase}-${Math.floor(1000 + Math.random() * 9000)}`,
        businessCategory: dto.businessCategory,
        taxOrLicenseId: dto.taxOrLicenseId.trim(),
        vendorStatus: 'ACTIVE',
      },
    };

    await this.repo.createUser(user);
    return this.toSafeUser(user);
  }

  async login(dto: LoginDto) {
    const email = dto.email.toLowerCase().trim();
    const user = await this.repo.findUserByEmail(email);
    if (!user || !user.isActive) {
      throw new UnauthorizedException('Invalid email or password');
    }

    if (!user.passwordHash) {
      throw new UnauthorizedException(
        'This account uses Google Sign-In. Please click Continue with Google.',
      );
    }

    const valid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!valid) {
      throw new UnauthorizedException('Invalid email or password');
    }

    if (dto.expectedRole && user.role !== dto.expectedRole) {
      throw new ForbiddenException(
        `This account is registered as ${user.role}. Please use the ${user.role} tab.`,
      );
    }

    if (user.role === 'CUSTOMER' && !user.isEmailVerified) {
      const latest = await this.repo.findLatestActiveOtp(email, 'EMAIL_VERIFICATION');
      const shouldSendFresh =
        !latest ||
        latest.expiresAt < new Date() ||
        Date.now() - latest.createdAt.getTime() >= OTP_RESEND_COOLDOWN_MS;
      if (shouldSendFresh) {
        await this.issueAndSendOtp(user, 'EMAIL_VERIFICATION');
      }

      throw new ForbiddenException({
        message: 'Please verify your email with the 6-digit OTP code before signing in.',
        requiresOtpVerification: true,
        email: user.email,
      });
    }

    if (user.role === 'VENDOR' && user.vendorProfile?.vendorStatus === 'SUSPENDED') {
      throw new ForbiddenException('Vendor account is suspended. Contact Pet Mall Admin.');
    }

    const tokens = await this.issueTokens(user);
    return { user: this.toSafeUser(user), ...tokens };
  }

  async authenticateWithGoogleCode(code: string) {
    if (!this.isGoogleOAuthConfigured()) {
      throw new UnauthorizedException('Google OAuth is not configured');
    }

    const client = this.getGoogleClient();
    const { tokens } = await client.getToken(code);
    if (!tokens.id_token) {
      throw new UnauthorizedException('Missing Google ID token');
    }

    const ticket = await client.verifyIdToken({
      idToken: tokens.id_token,
      audience: this.googleClientId,
    });
    const payload = ticket.getPayload();

    if (!payload?.email || !payload.email_verified || !payload.sub) {
      throw new UnauthorizedException('Google account email is not verified');
    }

    const email = payload.email.toLowerCase().trim();
    let user = await this.repo.findUserByEmail(email);

    if (user) {
      if (user.role !== 'CUSTOMER') {
        throw new ForbiddenException(
          'Google Sign-In is for Customers only. Vendor Partners must use email and password.',
        );
      }
      if (!user.isActive) {
        throw new UnauthorizedException('User account inactive');
      }
      if (!user.googleId) {
        await this.repo.linkGoogleAccount(user.id, payload.sub);
        user = (await this.repo.findUserById(user.id)) ?? user;
      }
    } else {
      user = {
        id: crypto.randomUUID(),
        email,
        role: 'CUSTOMER',
        authProvider: 'GOOGLE',
        googleId: payload.sub,
        isEmailVerified: true,
        isActive: true,
        passwordHash: null,
        customerProfile: {
          fullName: payload.name?.trim() || email.split('@')[0] || 'Pet Mall Customer',
          loyaltyPoints: 50,
          avatarUrl: payload.picture,
        },
      };
      await this.repo.createUser(user);
    }

    const sessionTokens = await this.issueTokens(user);
    return { user: this.toSafeUser(user), ...sessionTokens };
  }

  async refreshSession(rawRefreshToken?: string) {
    if (!rawRefreshToken) {
      throw new UnauthorizedException('Missing refresh token');
    }

    let payload: RefreshTokenPayload;
    try {
      payload = jwt.verify(rawRefreshToken, this.getRefreshSecret(), {
        algorithms: ['HS256'],
      }) as RefreshTokenPayload;
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    const oldHash = this.sha256(rawRefreshToken);
    const session = await this.repo.findRefreshSession(oldHash);
    if (!session) {
      throw new UnauthorizedException('Refresh session expired or revoked');
    }
    if (session.isRevoked) {
      await this.repo.revokeAllUserRefreshSessions(session.userId);
      throw new UnauthorizedException('Refresh session expired or revoked');
    }
    if (session.expiresAt < new Date()) {
      throw new UnauthorizedException('Refresh session expired or revoked');
    }

    await this.repo.revokeRefreshSession(oldHash);

    const user = await this.repo.findUserById(payload.sub);
    if (!user || !user.isActive) {
      throw new UnauthorizedException('User account inactive');
    }

    const tokens = await this.issueTokens(user);
    return { user: this.toSafeUser(user), ...tokens };
  }

  async logout(rawRefreshToken?: string): Promise<void> {
    if (!rawRefreshToken) return;
    await this.repo.revokeRefreshSession(this.sha256(rawRefreshToken));
  }

  async getCurrentUser(userId: string): Promise<SafeUser> {
    const user = await this.repo.findUserById(userId);
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return this.toSafeUser(user);
  }
}
