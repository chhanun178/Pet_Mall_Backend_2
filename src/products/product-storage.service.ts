import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';

const BUCKET = 'product-images';
export const PRODUCT_IMAGE_LIMIT = 5 * 1024 * 1024;

export interface ProductImage {
  buffer: Buffer;
  mimetype: string;
}

@Injectable()
export class ProductStorageService {
  private readonly memoryImages = new Map<string, string>();

  private get configuredUrl(): string | null {
    const url = process.env.SUPABASE_URL?.trim().replace(/\/+$/, '');
    if (!url || url.includes('[project-ref]')) return null;
    return url;
  }

  private get configuredKey(): string | null {
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
    return key || null;
  }

  private get isConfigured(): boolean {
    return Boolean(this.configuredUrl && this.configuredKey);
  }

  private get baseUrl() {
    const url = this.configuredUrl;
    if (!url)
      throw new ServiceUnavailableException(
        'Product image storage is not configured.',
      );
    return `${url}/storage/v1/object`;
  }

  publicUrl(path: string): string {
    if (
      path.startsWith('http://') ||
      path.startsWith('https://') ||
      path.startsWith('data:')
    ) {
      return path;
    }
    const localDataUrl = this.memoryImages.get(path);
    if (localDataUrl) return localDataUrl;
    if (!this.configuredUrl) return path;
    return `${this.baseUrl}/public/${BUCKET}/${path}`;
  }

  async upload(
    vendorId: string,
    { buffer, mimetype }: ProductImage,
  ): Promise<string> {
    const extension = this.imageExtension(buffer, mimetype);
    const path = `${vendorId}/${randomUUID()}.${extension}`;
    if (!this.isConfigured) {
      this.memoryImages.set(
        path,
        `data:${mimetype};base64,${buffer.toString('base64')}`,
      );
      return path;
    }
    await this.request(`${this.baseUrl}/${BUCKET}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': mimetype, 'Cache-Control': 'max-age=3600' },
      body: new Uint8Array(buffer),
    });
    return path;
  }

  async remove(path: string): Promise<void> {
    if (this.memoryImages.delete(path) || !this.isConfigured) {
      return;
    }
    await this.request(`${this.baseUrl}/${BUCKET}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes: [path] }),
    });
  }

  private imageExtension(buffer: Buffer, mimetype: string): string {
    if (buffer.length > 0 && buffer.length <= PRODUCT_IMAGE_LIMIT) {
      if (
        mimetype === 'image/jpeg' &&
        buffer.subarray(0, 3).toString('hex') === 'ffd8ff'
      ) {
        return 'jpg';
      }
      if (
        mimetype === 'image/png' &&
        buffer.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
      ) {
        return 'png';
      }
      if (
        mimetype === 'image/webp' &&
        buffer.toString('ascii', 0, 4) === 'RIFF' &&
        buffer.toString('ascii', 8, 12) === 'WEBP'
      ) {
        return 'webp';
      }
    }

    throw new BadRequestException(
      'Upload a valid JPEG, PNG, or WebP image up to 5 MB.',
    );
  }

  private async request(url: string, options: RequestInit): Promise<void> {
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
    if (!key)
      throw new ServiceUnavailableException(
        'Product image storage is not configured.',
      );

    const headers = new Headers(options.headers);
    headers.set('apikey', key);
    if (key.startsWith('eyJ')) headers.set('Authorization', `Bearer ${key}`);

    let response: Response;
    try {
      response = await fetch(url, {
        ...options,
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new ServiceUnavailableException(
        'Product image storage is unavailable. Try again.',
      );
    }

    void response.body?.cancel().catch(() => undefined);
    if (!response.ok) {
      throw new ServiceUnavailableException(
        'Product image storage is unavailable. Try again.',
      );
    }
  }
}
