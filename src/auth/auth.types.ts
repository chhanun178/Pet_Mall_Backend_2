export type Role = 'CUSTOMER' | 'VENDOR' | 'ADMIN';
export type VendorStatus = 'ACTIVE' | 'SUSPENDED';
export type BusinessCategory = 'PET_FOOD' | 'ACCESSORIES' | 'GROOMING' | 'VET_CLINIC';

export interface CustomerProfile {
  fullName: string;
  loyaltyPoints: number;
  avatarUrl?: string;
}

export interface VendorProfile {
  ownerName: string;
  storeName: string;
  storeSlug: string;
  businessCategory: BusinessCategory;
  taxOrLicenseId: string;
  vendorStatus: VendorStatus;
}

export interface SafeUser {
  id: string;
  email: string;
  phone?: string;
  role: Role;
  isEmailVerified: boolean;
  customerProfile?: CustomerProfile;
  vendorProfile?: VendorProfile;
}

export interface AccessTokenPayload {
  sub: string;
  email: string;
  role: Role;
  vendorStatus?: VendorStatus;
}

export interface RefreshTokenPayload {
  sub: string;
  jti: string;
}
